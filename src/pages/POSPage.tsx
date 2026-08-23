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
  const [creditQuery, setCreditQuery] = useState('');
  const [creditResults, setCreditResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | undefined>();
  /** Two-stage checkout — step 1 picks items full-width, step 2 handles payment full-width. */
  const [stage, setStage] = useState<'items' | 'pay'>('items');

  const subtotal = cartSubtotal(cart.lines);
  const total = cartTotal(cart.lines, cart.discount);
  const tendered = cart.cashTendered;
  const change = changeDue(tendered, total);
  // Store credit is DERIVED — the selected customer's tab covers whatever the
  // other payment methods don't. No stored amount that can go stale mid-cart.
  const otherPayments = cart.payments.filter((p) => !(p.method === 'CREDIT' && p.customerId === cart.customerId));
  const paidSoFar = otherPayments.reduce((s, p) => s + p.amount, 0);
  const amountLeft = Math.max(0, total - paidSoFar);
  const creditCovered = cart.customerId ? amountLeft : 0;
  const remaining = Math.max(0, total - paidSoFar - creditCovered);
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
    if (cart.lines.length === 0) {
      toast.push('warn', 'Cart is empty');
      return;
    }
    if (remaining > 0) {
      toast.push('error', `Unpaid balance of ${fmtMoney(remaining)} — add payment first`);
      return;
    }
    // Reconcile the final split at completion: the selected customer's tab
    // covers whatever other methods didn't (derived live — never stale).
    let payments = otherPayments.filter((p) => p.amount > 0);
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
      setDiscountStr('');
      toast.push('success', `Sale complete — ${sale.receiptNumber}`);
      toast.openReceipt(sale.id);
      void refresh();
    } catch (err) {
      toast.push('error', `Checkout failed: ${err instanceof Error ? err.message : String(err)}`);
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

  /** Removes the most recently added cart line (mistake recovery). */
  const undoLast = () => {
    const last = cart.lines[cart.lines.length - 1];
    if (last) cart.remove(last.productId);
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
              autoFocus
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
                  <button className="qty-btn" onClick={() => cart.setQty(l.productId, l.quantity - 1)}>−</button>
                  <span style={{ width: 28, textAlign: 'center', fontWeight: 700 }}>{l.quantity}</span>
                  <button className="qty-btn" onClick={() => cart.setQty(l.productId, l.quantity + 1)}>+</button>
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
                  onClick={() => cart.setActivePayment(m)}
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
                  placeholder="Cash tendered (GH₵)"
                  value={cashStr}
                  onChange={(e) => applyCash(e.target.value)}
                  inputMode="decimal"
                  style={{ marginBottom: 8 }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                  <span>Tendered</span>
                  <span style={{ fontWeight: 800 }}>{fmtMoney(tendered)}</span>
                  <span>Change</span>
                  <span style={{ fontWeight: 800, color: 'var(--success)' }}>{fmtMoney(change)}</span>
                </div>
              </>
            )}

            {cart.activePayment === 'CARD' && (
              <button
                className="btn btn-secondary btn-block"
                style={{ marginBottom: 8 }}
                disabled={amountLeft <= 0}
                onClick={() => {
                  cart.addPayment({ method: 'CARD', amount: amountLeft });
                  toast.push('info', 'Card payment queued — POS terminal prompt on device.');
                }}
              >
                💳 Pay {fmtMoney(amountLeft)} with card
              </button>
            )}

            {cart.activePayment === 'PAYSTACK' && (
              <button
                className="btn btn-secondary btn-block"
                style={{ marginBottom: 8 }}
                disabled={amountLeft <= 0}
                onClick={() => {
                  cart.addPayment({ method: 'PAYSTACK', amount: amountLeft });
                  toast.push('warn', 'Paystack marked PENDING_VERIFICATION — needs server verification (Spark limitation).');
                }}
              >
                🟢 Pay {fmtMoney(amountLeft)} via Paystack
              </button>
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
                <button
                  className="btn btn-secondary btn-block"
                  disabled={!selectedCustomer}
                  onClick={() => {
                    if (!selectedCustomer) { toast.push('warn', 'Select a customer first'); return; }
                    if (creditCovered <= 0) { toast.push('info', 'Nothing to put on the tab — sale is fully covered.'); return; }
                    toast.push('success', `${fmtMoney(creditCovered)} on ${selectedCustomer.name}'s tab`);
                  }}
                >
                  📒 Put {fmtMoney(creditCovered)} on {selectedCustomer ? selectedCustomer.name : "a customer's"} tab
                </button>
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
              style={{ marginTop: 10 }}
            >
              ✔ Complete Sale — {fmtMoney(total)}
              {remaining > 0 ? ` · due ${fmtMoney(remaining)}` : creditCovered > 0 ? ` · ${fmtMoney(creditCovered)} on tab` : ''}
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