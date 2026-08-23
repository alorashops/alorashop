import { useEffect, useState } from 'react';
import { useAuthStore, shopIdOf, canManageInventory } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { getSalesPage, voidSale } from '../db/repos/sales';
import { digitalReceipt, shareReceipt } from '../services/printService';
import { fmtMoney, fmtDateTime } from '../lib/utils';
import { EmptyState, MethodTag, StatusTag } from '../components/ui';
import type { Sale } from '../types';

const PAGE_SIZE = 25;

export default function SalesPage() {
  const user = useAuthStore((s) => s.user);
  const toast = useUiStore();
  const [sales, setSales] = useState<Sale[]>([]);
  const [cursor, setCursor] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const canVoid = canManageInventory(user?.role); // manager/admin approve voids

  const load = async (nextCursor?: number) => {
    setLoading(true);
    const rows = await getSalesPage(shopIdOf(), nextCursor, PAGE_SIZE);
    if (nextCursor === undefined) {
      setSales(rows);
    } else {
      setSales((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...rows.filter((r) => !seen.has(r.id))];
      });
    }
    setCursor(rows.length > 0 ? rows[rows.length - 1].createdAt : nextCursor);
    setHasMore(rows.length === PAGE_SIZE);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doVoid = (sale: Sale) => {
    if (sale.voidedBy) {
      toast.push('warn', 'Already voided');
      return;
    }
    toast.ask(
      'Approve void?',
      `Receipt ${sale.receiptNumber} — ${fmtMoney(sale.totalAmount)}. A reversal document is created; the original is never edited.`,
      async () => {
        try {
          await voidSale(sale.id, user?.uid ?? 'mgr-1', 'Manager void approval');
          toast.push('success', `Sale ${sale.receiptNumber} voided (reversal posted)`);
          void load();
        } catch (err) {
          toast.push('error', err instanceof Error ? err.message : String(err));
        }
      }
    );
  };

  return (
    <div className="page">
      <h1 className="page-title">Sales History</h1>
      <p className="page-sub">
        Paginated, cursor-based local reads. Financial records are append-only — voids create reversals, never edits.
      </p>

      <button className="btn btn-secondary" onClick={() => void load()} style={{ marginBottom: 14 }} disabled={loading}>
        {loading ? 'Loading…' : '↻ Refresh'}
      </button>

      {sales.length === 0 && !loading ? (
        <div className="card"><EmptyState icon="🧾" title="No sales yet" hint="Complete a sale on the Checkout page — it lands here instantly." /></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Time</th>
                <th>Cashier</th>
                <th className="num">Items</th>
                <th className="num">Total</th>
                <th>Method</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} style={s.voidedBy ? { opacity: 0.55 } : undefined}>
                  <td className="mono">{s.receiptNumber}</td>
                  <td>{fmtDateTime(s.createdAt)}</td>
                  <td>{s.cashierName ?? s.cashierId}</td>
                  <td className="num">{s.items.reduce((n, i) => n + i.quantity, 0)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtMoney(s.totalAmount)}
                    {s.voidedBy && <span className="tag red" style={{ marginLeft: 8 }}>VOIDED</span>}
                  </td>
                  <td><MethodTag method={s.paymentMethod} /></td>
                  <td><StatusTag status={s.paymentStatus} /></td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm btn-secondary" onClick={() => toast.openReceipt(s.id)}>Receipt</button>
                      <button className="btn btn-sm btn-secondary" onClick={() => digitalReceipt(s)}>WhatsApp</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => shareReceipt(s)}>Share</button>
                      {canVoid && !s.voidedBy && (
                        <button className="btn btn-sm btn-danger" onClick={() => doVoid(s)}>Void</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <button className="btn btn-secondary btn-block" onClick={() => void load(cursor)} style={{ marginTop: 12 }}>
          Load more
        </button>
      )}
    </div>
  );
}