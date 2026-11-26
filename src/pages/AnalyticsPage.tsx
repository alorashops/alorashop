import { useEffect, useRef, useState } from 'react';
import { useAuthStore, shopIdOf, canSeeCosting } from '../stores/authStore';
import { useUiStore } from '../stores/uiStore';
import { getSummariesRange, getTopSellingRange, backfillProfits, autoBackfillProfit, getStockValue, type TopSellingItem } from '../db/repos/summary';
import { fmtMoneyCompact, todayKey, pct, isCloudShopId } from '../lib/utils';
import { EmptyState, SkeletonCard, SkeletonStats } from '../components/ui';
import ReportPreviewModal from '../components/ReportPreviewModal';
import {
  generateCloudReport,
  downloadReportPdf,
  ReportError,
  type CloudReportResult
} from '../services/report';
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
  const [topSelling, setTopSelling] = useState<TopSellingItem[]>([]);
  const [stockValue, setStockValue] = useState<{ count: number; value: number }>({ count: 0, value: 0 });
  const [backfilling, setBackfilling] = useState(false);
  /** Monotonic load id — a slow OLD load must never overwrite a NEWER one
      (the classic stale-response race when Refresh/date-change fire fast). */
  const loadSeq = useRef(0);
  /** True ONLY until the first read settles — drives the skeletons so a
      date change / refresh keeps the numbers already on screen. */
  const [initialLoading, setInitialLoading] = useState(true);
  /** In-flight indicator for the Refresh button only (never a skeleton). */
  const [loading, setLoading] = useState(false);
  /** Cloud PDF report state. Manager/admin only (server enforces it too). */
  const canReport = canSeeCosting(user?.role) && isCloudShopId(user?.shopId);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportData, setReportData] = useState<CloudReportResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  /** Monotonic report request id — an old slow response must never replace a
      newer report, and a date change must invalidate an in-flight generation. */
  const reportSeq = useRef(0);

  const load = async (from = fromDate, to = toDate) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
    // AUTO-PROFIT (Problem #4): before aggregating, gap-fill profit onto any
    // profit-less sales in the viewed range so cashier sales (the common 80%)
    // show profit with zero clicks. Reads the LIVE role from the store so a
    // role change never leaves a stale `seeProfit` writable closure. Internally
    // gated on canSeeCosting + idempotent, so a cashier device is a no-op and
    // a manager device at steady state is a cheap read-only pass. Best-effort:
    // a failure here must never hide the page — it renders with what exists.
    if (canSeeCosting(useAuthStore.getState().user?.role)) {
      try {
        await autoBackfillProfit(shopIdOf(), from, to);
      } catch {
        // non-fatal — render with currently-known profit
      }
    }
    const [sum, top, sv] = await Promise.all([
      getSummariesRange(shopIdOf(), from, to),
      getTopSellingRange(shopIdOf(), from, to, 8),
      getStockValue(shopIdOf())
    ]);
    if (seq !== loadSeq.current) return; // stale — a newer load superseded us
    setSummaries(sum);
    setTopSelling(top);
    setStockValue(sv);
    } catch (err) {
      // A stale failure belongs to a superseded request — do not toast it.
      if (seq !== loadSeq.current) return;
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq.current) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  };

  useEffect(() => {
    if (fromDate > toDate) setToDate(fromDate);
    else void load(fromDate, toDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromDate, toDate]);

  const doBackfill = async () => {
    setBackfilling(true);
    try {
      // Backfill EVERY day in the selected range so range-level and per-product
      // profit are real — backfilling only today leaves the rest of the range
      // showing GH₵0.
      let profit = 0;
      const start = new Date(`${fromDate}T00:00:00`);
      const end = new Date(`${toDate}T23:59:59.999`);
      const d = new Date(start);
      while (d.getTime() <= end.getTime()) {
        profit += await backfillProfits(shopIdOf(), todayKey(d));
        d.setDate(d.getDate() + 1);
      }
      toast.push('success', `Profit backfill complete — ${fmtMoneyCompact(profit)}`);
      void load();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBackfilling(false);
    }
  };

  /* ---------- cloud PDF report (manager/admin only) ---------- */
  // A date change makes any open/in-flight report stale. Close it and invalidate
  // the request id so a slow old response cannot reopen the old range.
  useEffect(() => {
    reportSeq.current += 1;
    setReportOpen(false);
    setReportData(null);
    setReportLoading(false);
  }, [fromDate, toDate]);

  const openReport = async () => {
    // Re-check the LIVE role at click time, not the render-time closure.
    if (!canSeeCosting(useAuthStore.getState().user?.role)) {
      toast.push('error', 'Only managers and admins can generate reports.');
      return;
    }
    const seq = ++reportSeq.current;
    setReportLoading(true);
    try {
      const result = await generateCloudReport(fromDate, toDate);
      if (seq !== reportSeq.current) return; // dates changed / newer request
      setReportData(result);
      setReportOpen(true);
      if (result.pendingSkipped > 0 || result.failedSkipped > 0) {
        toast.push(
          'warn',
          `${result.pendingSkipped + result.failedSkipped} local record(s) are not in the cloud yet and are excluded from the report.`
        );
      }
    } catch (err) {
      if (seq !== reportSeq.current) return;
      const message =
        err instanceof ReportError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      toast.push('error', message);
    } finally {
      if (seq === reportSeq.current) setReportLoading(false);
    }
  };

  const handleDownloadReport = () => {
    if (!reportData) return;
    if (!canSeeCosting(useAuthStore.getState().user?.role)) {
      toast.push('error', 'Only managers and admins can download reports.');
      return;
    }
    setDownloading(true);
    try {
      downloadReportPdf(reportData.pdfBase64, reportData.fileName);
      toast.push('success', 'Report downloaded');
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
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
            Aggregates are derived from the synced sales ledger, so every device converges on the same numbers. Pick a date range.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {canReport && (
            <button
              className="btn btn-secondary"
              onClick={() => void openReport()}
              disabled={reportLoading}
              title="Generate a PDF from cloud-synced data (manager/admin only; requires internet)"
            >
              {reportLoading ? 'Generating…' : '📄 Report'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
          {seeProfit && (
            <button className="btn btn-primary" onClick={() => void doBackfill()} disabled={backfilling}>
              {backfilling ? 'Recomputing…' : 'Recompute profit'}
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

      {initialLoading ? (
        <SkeletonStats count={seeProfit ? 4 : 3} className="grid cols-4" />
      ) : (
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
            <div className="sub">Auto-computed on manager/admin devices</div>
          </div>
        )}
        <div className="card stat">
          <div className="label">Stock on hand</div>
          <div className="value">{stockValue.count.toLocaleString()}</div>
          <div className="sub">{seeProfit ? `${fmtMoneyCompact(stockValue.value)} value (WAC)` : 'units'}</div>
        </div>
      </div>
      )}

      {/* Top sellers first, each card on its OWN full-width row. On narrow
          (phone) screens a side-by-side layout crushed the revenue bars and
          could hide the top-sellers card entirely — stacked rows keep every
          card visible at any width. */}
      <div className="grid" style={{ marginBottom: 16 }}>
      {initialLoading ? <SkeletonCard lines={6} /> : (<>
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
                    <span style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{t.qty} units</span>
                      {seeProfit && (
                        <span
                          style={{
                            fontWeight: 800,
                            color: t.profit === undefined ? 'var(--text-muted)' : t.profit < 0 ? 'var(--danger)' : 'var(--success)'
                          }}
                          title={t.profit !== undefined ? 'Gross profit after cost computation' : 'Profit appears once a manager device computes cost (automatic)'}
                        >
                          {t.profit === undefined ? '—' : t.profit < 0 ? `−${fmtMoneyCompact(-t.profit)}` : `+${fmtMoneyCompact(t.profit)}`}
                        </span>
                      )}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                    <span>Revenue {fmtMoneyCompact(t.revenue)}</span>
                    {seeProfit && t.profit !== undefined && <span>Profit {fmtMoneyCompact(t.profit)}</span>}
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
      </>)}
      </div>

      {seeProfit && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <strong>Profit & cost (automatic)</strong>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            Sales are written with selling-price snapshots only, by any device. A device with cost access (manager/admin)
            automatically computes profit in the background — locally and, via sync, for every other device — so cashier
            sales show profit with zero clicks. "Recompute profit" force-rebuilds the calculation with current costs.
          </p>
        </div>
      )}

      <ReportPreviewModal
        open={reportOpen && canReport}
        data={reportData}
        onClose={() => setReportOpen(false)}
        onDownload={handleDownloadReport}
        downloading={downloading}
      />
    </div>
  );
}