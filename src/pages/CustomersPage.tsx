import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, shopIdOf } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { useCartStore } from '../stores/cartStore';
import { getCustomers, createCustomer, findByPhone, payCredit, getCreditLedgerDetailed, setAllowCredit } from '../db/repos/customers';
import type { CreditLedgerRow } from '../db/repos/customers';
import { Modal, EmptyState } from '../components/ui';
import { fmtMoney, fmtDateTime, parseMoneyInput } from '../lib/utils';
import type { Customer } from '../types';

export default function CustomersPage() {
  const user = useAuthStore((s) => s.user);
  const toast = useUiStore();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [payFor, setPayFor] = useState<Customer | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [ledgerFor, setLedgerFor] = useState<Customer | null>(null);
  const [ledger, setLedger] = useState<Array<CreditLedgerRow & { running: number }>>([]);

  const load = async () => {
    const rows = await getCustomers(shopIdOf());
    const q = query.trim().toLowerCase();
    setCustomers(q ? rows.filter((c) => c.name.toLowerCase().includes(q) || c.phone.includes(q)) : rows);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const addCustomer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get('name'));
    const phone = String(fd.get('phone'));
    const create = async () => {
      try {
        await createCustomer({ name, phone, shopId: shopIdOf() }, { allowDuplicate: true });
        toast.push('success', 'Customer added');
        setAddOpen(false);
        void load();
      } catch (err) {
        toast.push('error', err instanceof Error ? err.message : String(err));
      }
    };
    // Duplicate-phone guard: two customers with one phone split the tab.
    // Warn and force confirmation instead of silently creating a twin.
    const dup = await findByPhone(shopIdOf(), phone.trim());
    if (dup) {
      toast.ask(
        'Duplicate phone',
        `${phone} already belongs to ${dup.name}. Add "${name}" as a separate customer anyway?`,
        () => void create()
      );
      return;
    }
    await create();
  };

  const doPayCredit = async () => {
    if (!payFor) return;
    const amount = parseMoneyInput(payAmount);
    if (!amount || amount <= 0) {
      toast.push('warn', 'Enter a valid amount');
      return;
    }
    const record = async () => {
      try {
        await payCredit(payFor.id, amount, shopIdOf(), user?.uid ?? 'mgr-1', user?.displayName);
        toast.push('success', `Payment recorded — ${fmtMoney(amount)}`);
        setPayFor(null);
        setPayAmount('');
        void load();
      } catch (err) {
        toast.push('error', err instanceof Error ? err.message : String(err));
      }
    };
    // Overpayment guardrail: never silently drop money. The full amount is
    // recorded and the (ledger-derived) balance goes negative — shop credit
    // owed to the customer. Force an explicit confirmation first.
    const owed = payFor.creditBalance;
    if (amount > owed) {
      toast.ask(
        'Overpayment — confirm',
        `${payFor.name} owes ${fmtMoney(owed)} but you entered ${fmtMoney(amount)}. Recording the full amount gives ${payFor.name} ${fmtMoney(amount - owed)} of shop credit. Continue?`,
        () => void record()
      );
      return;
    }
    await record();
  };

  const openLedger = async (c: Customer) => {
    setLedgerFor(c);
    const rows = await getCreditLedgerDetailed(c.id, 50);
    // Running balance, computed oldest → newest, then flipped back for the
    // newest-first display — each row shows the tab balance AFTER that entry.
    let bal = 0;
    const withRunning = [...rows]
      .reverse()
      .map((e) => {
        if (e.type === 'CHARGE') bal += e.amount;
        else bal -= e.amount; // PAYMENT / REVERSAL reduce the tab
        return { ...e, running: bal };
      })
      .reverse();
    setLedger(withRunning);
  };

  /** "Sell on credit" — jump to Checkout with this customer pre-selected. */
  const sellOnCredit = (c: Customer) => {
    if (c.allowCredit === false) {
      toast.push('warn', `${c.name} is not allowed credit — enable "Allow credit" first.`);
      return;
    }
    useCartStore.getState().startCreditSale(c.id);
    toast.push('info', `${c.name}'s tab selected — finish the sale on Checkout.`);
    navigate('/pos');
  };

  /** Per-customer "Allow credit" guardrail toggle. */
  const toggleCredit = async (c: Customer) => {
    try {
      await setAllowCredit(c.id, c.allowCredit === false);
      toast.push('success', c.allowCredit === false ? `Credit enabled for ${c.name}` : `Credit blocked for ${c.name}`);
      void load();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Customers & Store Credit</h1>
          <p className="page-sub">
            Tabs are append-only: every CHARGE references its sale, every PAYMENT is a separate ledger entry.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>+ New Customer</button>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <input
          className="input"
          placeholder="Search name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>

      {customers.length === 0 ? (
        <div className="card"><EmptyState icon="👥" title="No customers" hint="Add a customer to start store-credit tabs." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th className="num">Credit balance</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 700 }}>{c.name}</td>
                  <td className="mono">{c.phone}</td>
                  <td className="num" style={{ fontWeight: 800, color: c.creditBalance > 0 ? 'var(--warn)' : c.creditBalance < 0 ? 'var(--success)' : 'inherit' }}>
                    {fmtMoney(c.creditBalance)}
                  </td>
                  <td>
                    {c.creditBalance > 0 ? (
                      <span className="tag amber">OWES</span>
                    ) : c.creditBalance < 0 ? (
                      <span className="tag indigo">SHOP OWES</span>
                    ) : (
                      <span className="tag green">CLEAR</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-sm btn-success" onClick={() => sellOnCredit(c)}>Sell on credit</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => setPayFor(c)}>Record payment</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => void openLedger(c)}>History</button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => void toggleCredit(c)}
                        title="Allow this customer to buy on credit"
                      >
                        {c.allowCredit === false ? '⛔ Credit off' : '✓ Credit on'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal */}
      <Modal open={addOpen} title="New Customer" onClose={() => setAddOpen(false)}>
        <form onSubmit={(e) => void addCustomer(e)}>
          <div className="field"><label>Full name</label><input className="input" name="name" required /></div>
          <div className="field"><label>Phone</label><input className="input" name="phone" placeholder="024X XXX XXXX" required /></div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">Add</button>
          </div>
        </form>
      </Modal>

      {/* Pay modal */}
      <Modal open={payFor !== null} title={`Record payment — ${payFor?.name ?? ''}`} onClose={() => setPayFor(null)}>
        <div className="modal-sub">
          Current balance: {payFor ? fmtMoney(payFor.creditBalance) : ''}
        </div>
        <div className="field">
          <label>Amount (GH₵)</label>
          <input className="input" type="number" min={0} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={() => setPayFor(null)}>Cancel</button>
          <button className="btn btn-success" onClick={() => void doPayCredit()}>Record payment</button>
        </div>
      </Modal>

      {/* Ledger modal */}
      <Modal open={ledgerFor !== null} title={`Credit ledger — ${ledgerFor?.name ?? ''}`} onClose={() => setLedgerFor(null)}>
        <div className="modal-sub">
          Append-only · newest first. Current balance: {ledgerFor ? fmtMoney(ledgerFor.creditBalance) : ''}
        </div>
        {ledger.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: 16, textAlign: 'center' }}>No ledger entries yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th className="num">Amount</th>
                <th>Reference</th>
                <th>When</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className={`tag ${e.type === 'CHARGE' ? 'amber' : e.type === 'REVERSAL' ? 'red' : 'green'}`}>{e.type}</span>
                  </td>
                  <td className="num" style={{ color: e.type === 'CHARGE' ? 'var(--warn)' : e.type === 'REVERSAL' ? 'var(--danger)' : 'var(--success)' }}>
                    {e.type === 'CHARGE' ? '+' : '−'}{fmtMoney(e.amount)}
                  </td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {e.receiptNumber ?? e.actorLabel ?? '—'}
                  </td>
                  <td style={{ fontSize: 12 }}>{fmtDateTime(e.createdAt)}</td>
                  <td className="num" style={{ fontWeight: 700, color: e.running > 0 ? 'var(--warn)' : e.running < 0 ? 'var(--success)' : 'inherit' }}>
                    {fmtMoney(e.running)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </div>
  );
}