import { useEffect, useMemo, useState } from 'react';
import { useAuthStore, shopIdOf } from '../stores/authStore';
import { useCartStore, cartSubtotal, cartTotal, changeDue, parseMoneyInput } from '../stores/cartStore';
import { useInventoryStore } from '../stores/inventoryStore';
import { useUiStore } from '../stores/uiStore';
import { findProductByBarcode } from '../db/repos/products';
import { createSale } from '../db/repos/sales';
import { searchCustomers, getCustomerById, isCreditAllowed } from '../db/repos/customers';
import { attachProductScanHandler } from '../services/barcodeService';
import { fmtMoney } from '../lib/utils';
import type { Customer, PaymentMethod, PaymentStatus } from '../types';

export default function POSPage() {
  const user = useAuthStore((s) => s.user);
  const products = useInventoryStore((s) => s.products);
  const refresh = useInventoryStore((s) => s.refresh);
  const cart = useCartStore();
  const toast = useUiStore();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [discountStr, setDiscountStr] = useState('');
  const [cashStr, setCashStr] = useState('');
  /** False while the cash field is showing the empty/full-total default — set
      true the moment the cashier types, so the auto-fill stops overriding. */
  const [cashDirty, setCashDirty] = useState(false);
  /** Mirrors cash: while the credit field shows its auto-filled default the
      moment the cashier types (including a borrowing fee above the remainder)
      the auto-fill stops and the typed value is stored as the CREDIT split. */
  const [creditStr, setCreditStr] = useState('');
  const [creditDirty, setCreditDirty] = useState(false);
  /** True from the moment Complete Sale is accepted until the sale is written
      — blocks double-taps from creating two sales (and double stock deduction). */
  const [submitting, setSubmitting] = useState(false);
  /** Raw quantity text per cart line — kept separate so the caret never jumps
      while typing a number (mirrors the price-field pattern on Inventory). */
  const [qtyTexts, setQtyTexts] = useState<Record<string, string>>({});
  const [creditQuery, setCreditQuery] = useState('');
  const [creditResults, setCreditResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | undefined>();
  /** Two-stage checkout — step 1 picks items full-width, step 2 handles payment full-width. */
  const [stage, setStage] = useState<'items' | 'pay'>('items');

  const subtotal = cartSubtotal(cart.lines);
  const total = cartTotal(cart.lines, cart.discount);
  const tendered = cart.cashTendered;
  const change = changeDue(tendered, total);
  // The CREDIT split is STORED verbatim (like cash), never derived at the last
  // second — so the typed tab amount, including any borrowing fee above the
  // unpaid remainder, is exactly what's written to the ledger and analytics.
  const otherPayments = cart.payments.filter((p) => !(p.method === 'CREDIT' && p.customerId === cart.customerId));
  const paidSoFar = otherPayments.reduce((s, p) => s + p.amount, 0);
  const amountLeft = Math.max(0, total - paidSoFar);
  const storedCredit = cart.customerId
    ? (cart.payments.find((p) => p.method === 'CREDIT' && p.customerId === cart.customerId)?.amount ?? 0)
    : 0;
  // CARD & PAYSTACK are auto-methods: while their tab is active they silently
  // cover the remainder left AFTER any stored credit (so a kept tab split is
  // never double-charged by an auto-method). Only one tab is active at a time.
  const cardCoverage = cart.activePayment === 'CARD' ? Math.max(0, amountLeft - storedCredit) : 0;
  const paystackCoverage = cart.activePayment === 'PAYSTACK' ? Math.max(0, amountLeft - storedCredit) : 0;
  const creditCovered = storedCredit;
  const remaining = Math.max(0, amountLeft - storedCredit - cardCoverage - paystackCoverage);
  const itemCount = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const cartHasItems = cart.lines.some((l) => l.quantity > 0);

  // Global scanner wedge — no input focus needed.
  useEffect(() => {
    const stop = attachProductScanHandler((code) => findProductByBarcode(shopIdOf(), code));
    return stop;
  }, []);

  const categories = useMemo(() => ['All', ...new Set(products.map((p) => p.category))], [products]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (category === 'All' || p.category === category) &&
        (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
    );
  }, [products, query, category]);

  const completeSale = async () => {
    if (submitting) return;
    if (!cartHasItems) {
      toast.push('warn', 'Cart is empty — add items first');
      return;
    }
    if (remaining > 0) {
      toast.push('error', `Unpaid balance of ${fmtMoney(remaining)} — add payment first`);
      return;
    }
    // Reconcile the final split at completion: stored splits are kept verbatim,
    // the active auto-method (CARD/PAYSTACK) covers the leftover remainder, and
    // the stored CREDIT split lands on the customer's tab as typed.
    let payments = otherPayments.filter((p) => p.amount > 0);
    // Active-tab auto-methods materialize here — CARD/PAYSTACK silently charge
    // the remainder (fast sale, no confirmation button).
    if (cardCoverage > 0) {
      payments = [...payments, { method: 'CARD', amount: cardCoverage }];
    }
    if (paystackCoverage > 0) {
      payments = [...payments, { method: 'PAYSTACK', amount: paystackCoverage }];
    }
    if (cart.customerId && creditCovered > 0) {
      payments = [...payments, { method: 'CREDIT', amount: creditCovered, customerId: cart.customerId }];
    }
    if (payments.length === 0) {
      toast.push('error', 'Add a payment method first');
      return;
    }
    const primary: PaymentMethod = payments[0]?.method ?? 'CASH';
    // Payment-status machine — the three states are distinct and each must be
    // produced:
    //  - PAYSTACK split  → PENDING_VERIFICATION (funds not confirmed; needs a
    //    server-side verify — Spark limitation).
    //  - CREDIT split    → CREDIT_OPEN (the tab is a receivable, not collected
    //    money — must never show as PAID).
    //  - otherwise       → PAID.
    // Previously a pure-credit sale was stored as 'PAID', silently reporting
    // collected money for an unpaid tab (CREDIT_OPEN was dead code).
    const status: PaymentStatus = payments.some((p) => p.method === 'PAYSTACK')
      ? 'PENDING_VERIFICATION'
      : payments.some((p) => p.method === 'CREDIT')
        ? 'CREDIT_OPEN'
        : 'PAID';

    setSubmitting(true);
    try {
      const sale = await createSale({
        shopId: shopIdOf(),
        cashierId: user?.uid ?? 'unknown',
        cashierName: user?.displayName,
        items: cart.lines.map((l) => ({
          productId: l.productId,
          productName: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.unitPrice * l.quantity
        })),
        discount: cart.discount,
        payments,
        primaryMethod: primary,
        paymentStatus: status
      });
      cart.setLastSaleId(sale.id);
      cart.clear();
      setStage('items');
      setCashStr('');
      setCashDirty(false);
      setCreditStr('');
      setCreditDirty(false);
      setDiscountStr('');
      setQtyTexts({});
      toast.push('success', `Sale complete — ${sale.receiptNumber}`);
      toast.openReceipt(sale.id);
      void refresh();
    } catch (err) {
      toast.push('error', `Checkout failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const setDiscountFromStr = (v: string) => {
    setDiscountStr(v);
    cart.setDiscount(parseMoneyInput(v));
  };

  /**
   * Custom cash entry auto-applies as the user types — no Apply button needed.
   * A non-zero amount replaces the CASH payment; clearing the field removes it
   * so a stale tender never lingers.
   */
  const applyCash = (v: string) => {
    setCashDirty(true);
    setCashStr(v);
    const amt = parseMoneyInput(v);
    if (amt > 0) {
      cart.setCashTendered(amt);
      cart.addPayment({ method: 'CASH', amount: amt });
    } else {
      cart.setCashTendered(0);
      cart.removePayment('CASH');
    }
  };

  /**
   * Custom credit entry auto-applies as the user types (mirrors cash). The
   * value is stored verbatim as the CREDIT split — fees above the remainder
   * are kept. Clearing the field removes the split so nothing stale lingers.
   */
  const applyCredit = (v: string) => {
    setCreditDirty(true);
    setCreditStr(v);
    const amt = parseMoneyInput(v);
    if (amt > 0 && cart.customerId) {
      cart.addPayment({ method: 'CREDIT', amount: amt, customerId: cart.customerId });
    } else {
      cart.removePayment('CREDIT');
    }
  };

  /**
   * Payment-tab switching. The one subtlety: cash auto-fills with the full
   * total (just like CARD/PAYSTACK), so if the cashier switches to another
   * method WITHOUT typing a custom tender (`!cashDirty`), that default CASH
   * payment must be dropped — otherwise the other method sees `amountLeft: 0`
   * and is disabled. A hand-typed partial tender is kept as a genuine split.
   */
  const switchPayment = (m: PaymentMethod) => {
    const leavingCash = cart.activePayment === 'CASH' && m !== 'CASH';
    if (leavingCash && !cashDirty) {
      cart.setCashTendered(0);
      cart.removePayment('CASH');
      setCashStr('');
    }
    // Same rule for credit: an untouched auto-fill is dropped when switching
    // away, a hand-typed tab amount is kept as a genuine split.
    const leavingCredit = cart.activePayment === 'CREDIT' && m !== 'CREDIT';
    if (leavingCredit && !creditDirty) {
      cart.removePayment('CREDIT');
      setCreditStr('');
    }
    if (m === 'CASH') {
      // Returning to cash begins from a fresh full-total default.
      setCashDirty(false);
      setCashStr('');
      cart.setCashTendered(0);
      cart.removePayment('CASH');
    }
    if (m === 'CREDIT') {
      // Returning to credit begins from a fresh unpaid-remainder default.
      setCreditDirty(false);
      setCreditStr('');
      cart.removePayment('CREDIT');
    }
    cart.setActivePayment(m);
  };

  /**
   * Cash auto-default: while the CASH tab is active and the cashier hasn't
   * typed a custom tender, mirror the total into the field + tender (the same
   * behaviour CARD/PAYSTACK already have). Deliberately keyed on `total` — not
   * `amountLeft` — so the payment it writes can never retrigger the effect.
   */
  useEffect(() => {
    if (cart.activePayment !== 'CASH' || cashDirty) return;
    // Auto-fill covers whatever isn't already on the sale as a KEPT credit
    // split. Keyed on `total - storedCredit` — NOT `amountLeft` — so the CASH
    // split this effect writes can never retrigger it (this effect only ever
    // writes CASH, so `storedCredit` is stable across the write → no loop).
    // Without this a typed credit + cash default double-counted the credit:
    // e.g. 60 kept on tab + cash auto-filled 100 → 160 recorded on a 100 sale.
    const amt = Math.max(0, total - storedCredit);
    setCashStr(amt > 0 ? (amt / 100).toFixed(2) : '');
    cart.setCashTendered(amt);
    if (amt > 0) cart.addPayment({ method: 'CASH', amount: amt });
    else cart.removePayment('CASH');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.activePayment, cashDirty, total, storedCredit]);

  /**
   * Credit auto-default: while the CREDIT tab is active with a customer picked
   * and the cashier hasn't typed a custom tab amount, mirror the unpaid
   * remainder into the field + CREDIT split. Deliberately keyed on `amountLeft`
   * (which excludes CREDIT) so the split it writes can never retrigger it.
   */
  useEffect(() => {
    if (cart.activePayment !== 'CREDIT' || creditDirty || !cart.customerId) return;
    const amt = amountLeft;
    setCreditStr(amt > 0 ? (amt / 100).toFixed(2) : '');
    if (amt > 0) cart.addPayment({ method: 'CREDIT', amount: amt, customerId: cart.customerId });
    else cart.removePayment('CREDIT');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.activePayment, creditDirty, cart.customerId, amountLeft]);

  /** Removes the most recently added cart line (mistake recovery). */
  const undoLast = () => {
    const last = cart.lines[cart.lines.length - 1];
    if (last) {
      cart.remove(last.productId);
      setQtyTexts((t) => {
        const { [last.productId]: _, ...rest } = t;
        return rest;
      });
    }
  };

  /** Stepped quantity change from the − / + buttons. Mirrors `setQty`'s clamp
      to [0, stockAvailable] and keeps the editable text in sync. */
  const bumpQty = (productId: string, delta: number) => {
    const line = cart.lines.find((l) => l.productId === productId);
    if (!line) return;
    const next = Math.max(0, Math.min(line.stockAvailable, line.quantity + delta));
    cart.setQty(productId, next);
    setQtyTexts((t) => ({ ...t, [productId]: String(next) }));
  };

  /** Loads the credit-picker list (top 8 matches by name/phone). */
  const loadCreditResults = async (q: string) => {
    setCreditQuery(q);
    const res = await searchCustomers(shopIdOf(), q);
    setCreditResults(res.slice(0, 8));
  };

  /** Locks a customer in as the check-out's tab payer. */
  const selectCreditCustomer = (c: Customer) => {
    if (!isCreditAllowed(c)) {
      toast.push('warn', `${c.name} is not allowed credit — enable "Allow credit" in Customers.`);
      return;
    }
    // Drop any auto-filled default cash before a credit sale — the tab should
    // cover what the cashier actually tendered, not a pre-filled full total.
    if (cart.activePayment === 'CASH' && !cashDirty) {
      cart.setCashTendered(0);
      cart.removePayment('CASH');
      setCashStr('');
    }
    // Fresh credit default for this customer — clears any prior tab split/state
    // so the auto-fill re-arms for the unpaid remainder of this sale.
    setCreditDirty(false);
    setCreditStr('');
    cart.removePayment('CREDIT');
    cart.setCustomerId(c.id);
    cart.setActivePayment('CREDIT');
    setCreditQuery('');
    setCreditResults([]);
    toast.push('success', `${c.name} selected — the remaining balance goes on their tab`);
  };

  // Credit preselection (jumped here from Customers "Sell on credit"):
  // resolve the customer for the chip and open the CREDIT tab.
  useEffect(() => {
    if (cart.customerId) {
      cart.setActivePayment('CREDIT');
      void getCustomerById(cart.customerId).then((c) => setSelectedCustomer(c ?? undefined));
    } else {
      setSelectedCustomer(undefined);
      setCreditQuery('');
      setCreditResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.customerId]);

  // Preload the picker whenever the CREDIT tab is open and nobody is picked yet.
  useEffect(() => {
    if (cart.activePayment === 'CREDIT' && !selectedCustomer) void loadCreditResults('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.activePayment, selectedCustomer]);

  return (
    <div className="page pos-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <h1 className="page-title">Checkout</h1>
          <p className="page-sub">Scan or tap items — everything runs against the local database. Zero network needed.</p>
        </div>
        <div className="mono" style={{ background: '#eef2ff', color: 'var(--primary)', padding: '6px 12px', borderRadius: 8, fontWeight: 700 }}>
          🔍 Scanner active
        </div>
      </div>

      {stage === 'items' ? (
        <div className="pos-items-stage">
          {/* ------- step 1: products + search (full width) ------- */}
          <div className="pos-products">
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 2, padding: '6px 0' }}>
            <input
              className="input"
              placeholder="Search name or barcode…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <select
              className="select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ width: 120, flexShrink: 0 }}
              title="Filter by category"
            >
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="product-grid">
            {visible.map((p) => {
              const low = p.stockQuantity <= p.minStockLevel;
              return (
                <button
                  key={p.id}
                  className="product-tile"
                  disabled={p.stockQuantity <= 0}
                  onClick={() =>
                    cart.add({
                      productId: p.id,
                      sku: p.sku,
                      name: p.name,
                      unitPrice: p.sellingPrice,
                      quantity: 1,
                      stockAvailable: p.stockQuantity
                    })
                  }
                >
                  <div className="name">{p.name}</div>
                  <div className="price">{fmtMoney(p.sellingPrice)}</div>
                  <div className={`stock ${low ? 'low' : ''}`}>
                    {p.stockQuantity <= 0 ? 'Out of stock' : `${p.stockQuantity} in stock`}
                    {low && p.stockQuantity > 0 ? ' · LOW' : ''}
                  </div>
                </button>
              );
            })}
            {visible.length === 0 && <div style={{ color: 'var(--text-muted)', padding: 30 }}>No products match.</div>}
          </div>
        </div>

        {/* step-1 footer: cart summary + gateway to payment */}
        <div className="cart-bar">
          <div className="cart-bar-left">
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--primary)' }}>{fmtMoney(total)}</span>
            <span style={{ color: 'var(--text-muted)' }}>
              {itemCount} item{itemCount === 1 ? '' : 's'}
              {cart.discount > 0 ? ` · disc ${fmtMoney(cart.discount)}` : ''}
            </span>
            {selectedCustomer && <span className="tag indigo">Tab: {selectedCustomer.name}</span>}
          </div>
          <div className="cart-bar-right">
            {cartHasItems && (
              <button className="btn btn-secondary" onClick={undoLast} title="Remove the last added item">
                ↩ Undo last
              </button>
            )}
            <button
              className="btn btn-primary btn-lg"
              disabled={!cartHasItems}
              onClick={() => setStage('pay')}
            >
              Continue to payment →
            </button>
          </div>
        </div>
        </div>
      ) : (
        <div className="pay-grid">
          <div className="cart-panel">
            <div className="cart-head">
              <strong>Sale items — {cart.lines.length}</strong>
              <button className="btn btn-sm btn-secondary" onClick={() => setStage('items')}>
                ← Add more items
              </button>
            </div>

          <div className="cart-items">
            {cart.lines.length === 0 && (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 30 }}>Cart empty — scan or tap products.</div>
            )}
            {cart.lines.map((l) => (
              <div className="cart-line" key={l.productId}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{l.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtMoney(l.unitPrice)} × {l.quantity}
                  </div>
                </div>
                <div className="qty-ctl">
                  <button className="qty-btn" onClick={() => bumpQty(l.productId, -1)}>−</button>
                  <input
                    className="qty-input"
                    inputMode="numeric"
                    value={qtyTexts[l.productId] ?? String(l.quantity)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setQtyTexts((t) => ({ ...t, [l.productId]: raw }));
                      const n = parseInt(raw, 10);
                      if (!Number.isNaN(n)) cart.setQty(l.productId, n);
                    }}
                    onBlur={() => setQtyTexts((t) => ({ ...t, [l.productId]: String(l.quantity) }))}
                  />
                  <button className="qty-btn" onClick={() => bumpQty(l.productId, +1)}>+</button>
                </div>
                <div style={{ fontWeight: 800, minWidth: 70, textAlign: 'right' }}>{fmtMoney(l.unitPrice * l.quantity)}</div>
              </div>
            ))}
          </div>

          <div className="cart-foot">
            <div className="totals-row">
              <span>Subtotal</span>
              <span>{fmtMoney(subtotal)}</span>
            </div>
            <div className="totals-row">
              <span>Discount</span>
              <span style={{ color: 'var(--danger)' }}>−{fmtMoney(cart.discount)}</span>
            </div>
            <div className="totals-row total">
              <span>Total</span>
              <span>{fmtMoney(total)}</span>
            </div>
          </div>
        </div>

        <div className="cart-panel pay-panel">
          <div className="cart-head">
            <strong>Payment</strong>
          </div>
          <div className="cart-foot" style={{ flex: 1 }}>
            <input
              className="input"
              value={discountStr}
              onChange={(e) => setDiscountFromStr(e.target.value)}
              placeholder="Discount (GH₵)"
              inputMode="decimal"
              style={{ marginTop: 10 }}
            />

            {/* payment method tabs */}
            <div className="pay-methods">
              {(['CASH', 'CARD', 'PAYSTACK', 'CREDIT'] as PaymentMethod[]).map((m) => (
                <button
                  key={m}
                  className={`pay-method ${cart.activePayment === m ? 'active' : ''}`}
                  onClick={() => switchPayment(m)}
                >
                  {m === 'CASH' ? '💵 Cash' : m === 'CARD' ? '💳 Card' : m === 'PAYSTACK' ? '🟢 Paystack' : '📒 Credit'}
                </button>
              ))}
            </div>

            {/* custom cash — auto-applies as the user types */}
            {cart.activePayment === 'CASH' && (
              <>
                <input
                  className="input"
                  placeholder="Cash Payable (GH₵)"
                  value={cashStr}
                  onChange={(e) => applyCash(e.target.value)}
                  inputMode="decimal"
                  style={{ marginBottom: 8 }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                  <span>Payable</span>
                  <span style={{ fontWeight: 800 }}>{fmtMoney(tendered)}</span>
                  <span>Change</span>
                  <span style={{ fontWeight: 800, color: 'var(--success)' }}>{fmtMoney(change)}</span>
                </div>
              </>
            )}

            {cart.activePayment === 'CARD' && (
              <div
                style={{

                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '10px',
                  background: 'var(--surface-2)',
                  marginBottom: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: 'center',
                  color: 'var(--text-muted)'
                }}
              >
                💳 Card {cardCoverage > 0 ? `will charge ${fmtMoney(cardCoverage)} at completion` : 'sale fully covered'}
              </div>
            )}

            {cart.activePayment === 'PAYSTACK' && (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '10px',
                  background: 'var(--surface-2)',
                  marginBottom: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: 'center',
                  color: 'var(--text-muted)'
                }}
              >
                🟢 Paystack {paystackCoverage > 0 ? `will charge ${fmtMoney(paystackCoverage)} at completion` : 'sale fully covered'}
                <div style={{ fontSize: 11, fontWeight: 500, marginTop: 4 }}>
                  Sale is marked PENDING_VERIFICATION — needs server-side verification (Spark limitation).
                </div>
              </div>
            )}

            {cart.activePayment === 'CREDIT' && (
              <div style={{ marginBottom: 8 }}>
                {selectedCustomer ? (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--surface-2)', marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{selectedCustomer.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {selectedCustomer.phone} · balance {fmtMoney(selectedCustomer.creditBalance)}
                        </div>
                      </div>
                      <button
                        className="btn btn-sm btn-ghost"
                        title="Remove this customer from the sale"
                        onClick={() => {
                          cart.clearCustomer();
                          cart.removePayment('CREDIT');
                          setCreditDirty(false);
                          setCreditStr('');
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <input
                      className="input"
                      placeholder="Search customer by name or phone…"
                      value={creditQuery}
                      onChange={(e) => void loadCreditResults(e.target.value)}
                      style={{ marginBottom: 8 }}
                    />
                    {creditResults.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8, maxHeight: 150, overflowY: 'auto' }}>
                        {creditResults.map((c) => {
                          const blocked = !isCreditAllowed(c);
                          return (
                            <button
                              key={c.id}
                              className="btn btn-ghost"
                              disabled={blocked}
                              style={{
                                width: '100%', justifyContent: 'flex-start', textAlign: 'left',
                                borderBottom: '1px solid var(--border)', borderRadius: 0
                              }}
                              onClick={() => selectCreditCustomer(c)}
                            >
                              <span style={{ fontWeight: 700 }}>{c.name}</span>
                              <span style={{ marginLeft: 'auto', fontSize: 12, color: blocked ? 'var(--danger)' : 'var(--text-muted)' }}>
                                {c.phone} · {fmtMoney(c.creditBalance)}{blocked ? ' · ⛔' : ''}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
                {selectedCustomer && (
                  <>
                    <input
                      className="input"
                      placeholder="Tab amount (GH₵) — add any fee"
                      value={creditStr}
                      onChange={(e) => applyCredit(e.target.value)}
                      inputMode="decimal"
                      style={{ marginBottom: 8 }}
                    />
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                      Auto-filled with the unpaid balance — raise it to add the borrowing fee.
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="totals-row" style={{ marginTop: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Paid</span>
              <span>{fmtMoney(paidSoFar)}</span>
            </div>
            {creditCovered > 0 && (
              <div className="totals-row">
                <span style={{ color: 'var(--text-muted)' }}>On {selectedCustomer?.name ?? 'tab'}</span>
                <span style={{ color: 'var(--warn)', fontWeight: 700 }}>{fmtMoney(creditCovered)}</span>
              </div>
            )}
            <div className="totals-row">
              <span style={{ color: 'var(--text-muted)' }}>Remaining</span>
              <span style={{ color: remaining > 0 ? 'var(--danger)' : 'var(--success)', fontWeight: 700 }}>
                {fmtMoney(remaining)}
              </span>
            </div>

            <button
              className={`btn btn-lg btn-block ${remaining === 0 ? 'btn-success' : 'btn-primary'}`}
              onClick={() => void completeSale()}
              disabled={submitting}
              style={{ marginTop: 10 }}
            >
              {submitting
                ? '⏳ Processing…'
                : `✔ Complete Sale — ${fmtMoney(total)}${remaining > 0 ? ` · due ${fmtMoney(remaining)}` : creditCovered > 0 ? ` · ${fmtMoney(creditCovered)} on tab` : ''}`}
            </button>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', margin: '8px 0 0' }}>
              Sale is durable in IndexedDB the instant you tap — cloud sync is backup only.
            </p>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}