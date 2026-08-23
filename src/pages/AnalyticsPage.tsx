import { useEffect, useState } from 'react';
import { useAuthStore, shopIdOf, canSeeCosting } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { getSummariesRange, getTopSellingRange, backfillProfits, getStockValue } from '../db/repos/summary';
import { fmtMoneyCompact, todayKey, pct } from '../lib/utils';
import { EmptyState } from '../components/ui';
import type { DailySummary } from '../types';

/** YYYY-MM-DD for a day offset from today (negative = past). */
function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function AnalyticsPage() {
  const user = useAuthStore((s) => s.user);
  const toast = useUiStore();
  const seeProfit = canSeeCosting(user?.role);
  const [fromDate, setFromDate] = useState(() => offsetDate(-6));
  const [toDate, setToDate] = useState(() => todayKey());
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [topSelling, setTopSelling] = useState<DailySummary['topSelling']>([]);
  const [stockValue, setStockValue] = useState<{ count: number; value: number }>({ count: 0, value: 0 });
  const [backfilling, setBackfilling] = useState(false);

  const load = async (from = fromDate, to = toDate) => {
    const [sum, top, sv] = await Promise.all([
      getSummariesRange(shopIdOf(), from, to),
      getTopSellingRange(shopIdOf(), from, to, 8),
      getStockValue(shopIdOf())
    ]);
    setSummaries(sum);
    setTopSelling(top);
    setStockValue(sv);
  };

  useEffect(() => {
    if (fromDate > toDate) setToDate(fromDate);
    else void load(fromDate, toDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate]);

  const doBackfill = async () => {
    setBackfilling(true);
    try {
      const profit = await backfillProfits(shopIdOf());
      toast.push('success', `Profit backfill complete — ${fmtMoneyCompact(profit)}`);
      void load();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBackfilling(false);
    }
  };

  /* ---------- range aggregates ---------- */
  const dayCount = summaries.length;
  const revenue = summaries.reduce((s, d) => s + d.totalRevenue, 0);
  const profit = summaries.reduce((s, d) => s + d.totalProfit, 0);
  const salesCount = summaries.reduce((s, d) => s + d.salesCount, 0);
  const revenueByDay = summaries;
  const byMethod: Record<string, number> = {};
  for (const d of summaries) {
    for (const [m, v] of Object.entries(d.totalsByMethod)) byMethod[m] = (byMethod[m] ?? 0) + v;
  }

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-sub">
            Dashboards read pre-aggregated dailySummary documents — never raw sale scans. Pick a date range.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => void load()}>↻ Refresh</button>
          {seeProfit && (
            <button className="btn btn-primary" onClick={() => void doBackfill()} disabled={backfilling}>
              {backfilling ? 'Backfilling…' : 'Run profit backfill'}
            </button>
          )}
        </div>
      </div>

      {/* Adjustable date range — native date fields (browser shows dd/mm/yyyy). */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>From</span>
        <input type="date" className="input" value={fromDate} max={toDate} onChange={(e) => setFromDate(e.target.value)} style={{ width: 170 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>To</span>
        <input type="date" className="input" value={toDate} min={fromDate} onChange={(e) => setToDate(e.target.value)} style={{ width: 170 }} />
        <button className="btn btn-secondary btn-sm" onClick={() => { setFromDate(todayKey()); setToDate(todayKey()); }}>Today</button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setFromDate(offsetDate(-6)); setToDate(todayKey()); }}>Last 7 days</button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setFromDate(offsetDate(-29)); setToDate(todayKey()); }}>Last 30 days</button>
        <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{dayCount} day{dayCount === 1 ? '' : 's'}</span>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="label">Sales</div>
          <div className="value">{salesCount}</div>
          <div className="sub">in range · {dayCount} day{dayCount === 1 ? '' : 's'}</div>
        </div>
        <div className="card stat">
          <div className="label">Revenue</div>
          <div className="value">{fmtMoneyCompact(revenue)}</div>
          <div className="sub">
            {Object.keys(byMethod).length
              ? Object.entries(byMethod).map(([m, v]) => `${m}: ${fmtMoneyCompact(v)}`).join(' · ')
              : 'No sales in range'}
          </div>
        </div>
        {seeProfit && (
          <div className="card stat">
            <div className="label">Profit</div>
            <div className="value" style={{ color: 'var(--success)' }}>{fmtMoneyCompact(profit)}</div>
            <div className="sub">Manager backfill required</div>
          </div>
        )}
        <div className="card stat">
          <div className="label">Stock on hand</div>
          <div className="value">{stockValue.count.toLocaleString()}</div>
          <div className="sub">{seeProfit ? `${fmtMoneyCompact(stockValue.value)} value (WAC)` : 'units'}</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 12 }}>Revenue — {fromDate} to {toDate}</div>
          {revenueByDay.length === 0 ? (
            <EmptyState icon="📊" title="No data yet" />
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 160 }}>
              {revenueByDay.map((s) => {
                const max = Math.max(...revenueByDay.map((r) => r.totalRevenue), 1);
                const h = Math.max(8, Math.round((s.totalRevenue / max) * 140));
                return (
                  <div key={s.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtMoneyCompact(s.totalRevenue)}</div>
                    <div
                      title={s.date}
                      style={{
                        width: '100%',
                        height: h,
                        background: 'linear-gradient(180deg, #6366f1, #4f46e5)',
                        borderRadius: '6px 6px 0 0',
                        minWidth: 22
                      }}
                    />
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.date.slice(5)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 12 }}>Top selling products</div>
          {topSelling.length === 0 ? (
            <EmptyState icon="🏆" title="No data yet" />
          ) : (
            topSelling.map((t, i) => {
              const maxQty = Math.max(...topSelling.map((x) => x.qty), 1);
              return (
                <div key={t.productId} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                    <span style={{ fontWeight: 700 }}>
                      {i + 1}. {t.productName}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{t.qty} units</span>
                  </div>
                  <div style={{ background: 'var(--surface-2)', borderRadius: 6, height: 8 }}>
                    <div
                      style={{
                        width: `${pct(t.qty, maxQty)}%`,
                        height: 8,
                        borderRadius: 6,
                        background: 'var(--primary-2)'
                      }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {seeProfit && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <strong>Profit backfill (manager/admin only)</strong>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            Cashiers write sales with selling-price snapshots only. A manager device computes cost of goods and writes
            profit locally — profit fields never travel through a cashier device.
          </p>
        </div>
      )}
    </div>
  );
}