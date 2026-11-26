import { Modal, MethodTag } from './ui';
import { fmtDateTime, fmtMoney } from '../lib/utils';
import type { CloudReportResult } from '../services/report';
import type { ReportKpi } from '../types';

function kpiValue(kpi: ReportKpi): string {
  if (kpi.kind === 'money') return fmtMoney(kpi.value);
  if (kpi.kind === 'percent') return `${kpi.value.toFixed(1)}%`;
  return kpi.value.toLocaleString();
}

function EmptyRow({ text }: { text: string }) {
  return <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '6px 0' }}>{text}</div>;
}

export default function ReportPreviewModal({
  open,
  data,
  onClose,
  onDownload,
  downloading
}: {
  open: boolean;
  data: CloudReportResult | null;
  onClose: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  if (!data) return null;
  const report = data.report;

  return (
    <Modal
      open={open}
      wide
      title={report.meta.title}
      sub={`${report.meta.shopName} · ${report.meta.fromDate} to ${report.meta.toDate}`}
      onClose={onClose}
    >
      <div className="report-preview-meta">
        <span>Generated {fmtDateTime(report.meta.generatedAt)}</span>
        <span>By {report.meta.generatedBy} ({report.meta.generatedByRole})</span>
        <span>{report.period.days} day(s) · {report.period.activeDays} active</span>
        <span>Confidential — manager/admin only</span>
      </div>

      {(data.pendingSkipped > 0 || data.failedSkipped > 0) && (
        <div className="report-warning">
          {data.pendingSkipped + data.failedSkipped} local record(s) are not yet in the cloud and are excluded
          from this report.{data.failedSkipped > 0 ? ' Some records are failing to sync — check Settings.' : ''}
        </div>
      )}

      <div className="report-kpis">
        {report.kpis.map((kpi) => (
          <div className="report-kpi" key={kpi.key}>
            <div className="label">{kpi.label}</div>
            <div className="value">{kpiValue(kpi)}</div>
            <div className="detail">
              {kpi.detailMoney !== undefined
                ? `${kpi.detailLabel ?? 'Value'}: ${fmtMoney(kpi.detailMoney)}`
                : kpi.detail ?? ''}
            </div>
          </div>
        ))}
      </div>

      <div className="report-section">
        <h4>Sales by payment method</h4>
        <div className="report-table-wrap">
          <table className="table report-table">
            <thead>
              <tr>
                <th>Method</th>
                <th className="num">Transactions</th>
                <th className="num">Amount</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {report.payments.rows.map((row) => (
                <tr key={row.method}>
                  <td><MethodTag method={row.method} /></td>
                  <td className="num">{row.count}</td>
                  <td className="num">{fmtMoney(row.amount)}</td>
                  <td className="num">{row.sharePct.toFixed(1)}%</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 800 }}>Total</td>
                <td className="num" style={{ fontWeight: 800 }}>{report.payments.totalCount}</td>
                <td className="num" style={{ fontWeight: 800 }}>{fmtMoney(report.payments.totalAmount)}</td>
                <td className="num" style={{ fontWeight: 800 }}>
                  {report.payments.totalAmount > 0 ? '100.0%' : '0.0%'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="report-section">
        <h4>Daily activity</h4>
        {report.daily.rows.length === 0 ? (
          <EmptyRow text={`No sales recorded between ${report.meta.fromDate} and ${report.meta.toDate}.`} />
        ) : (
          <div className="report-table-wrap">
            <table className="table report-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Sales</th>
                  <th className="num">Revenue</th>
                  <th className="num">Profit</th>
                  <th className="num">Discounts</th>
                </tr>
              </thead>
              <tbody>
                {report.daily.rows.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td className="num">{row.sales}</td>
                    <td className="num">{fmtMoney(row.revenue)}</td>
                    <td className="num">{fmtMoney(row.profit)}</td>
                    <td className="num">{fmtMoney(row.discounts)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ fontWeight: 800 }}>Total</td>
                  <td className="num" style={{ fontWeight: 800 }}>{report.daily.totals.sales}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{fmtMoney(report.daily.totals.revenue)}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{fmtMoney(report.daily.totals.profit)}</td>
                  <td className="num" style={{ fontWeight: 800 }}>{fmtMoney(report.daily.totals.discounts)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-section">
        <h4>Top selling products</h4>
        {report.topProducts.rows.length === 0 ? (
          <EmptyRow text="No product sales in this period." />
        ) : (
          <div className="report-table-wrap">
            <table className="table report-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Product</th>
                  <th className="num">Units</th>
                  <th className="num">Revenue</th>
                  <th className="num">Profit</th>
                  <th className="num">Margin</th>
                </tr>
              </thead>
              <tbody>
                {report.topProducts.rows.map((row) => (
                  <tr key={`${row.rank}-${row.name}`}>
                    <td>{row.rank}</td>
                    <td>{row.name}</td>
                    <td className="num">{row.units}</td>
                    <td className="num">{fmtMoney(row.revenue)}</td>
                    <td className="num">{row.profit === null ? '—' : fmtMoney(row.profit)}</td>
                    <td className="num">{row.marginPct === null ? '—' : `${row.marginPct.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-section">
        <h4>Staff activity</h4>
        {report.staff.rows.length === 0 ? (
          <EmptyRow text="No cashier activity in this period." />
        ) : (
          <div className="report-table-wrap">
            <table className="table report-table">
              <thead>
                <tr>
                  <th>Cashier</th>
                  <th className="num">Sales</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {report.staff.rows.map((row, index) => (
                  <tr key={`${row.name}-${index}`}>
                    <td>{row.name}</td>
                    <td className="num">{row.sales}</td>
                    <td className="num">{fmtMoney(row.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
<div className="report-section">
        <h4>Inventory status (current)</h4>
        <div className="report-preview-meta">
          <span>Units on hand: <strong>{report.stock.units.toLocaleString()}</strong></span>
          <span>WAC value: <strong>{fmtMoney(report.stock.value)}</strong></span>
          <span>Low stock: <strong>{report.stock.lowStockCount}</strong></span>
          <span>Products without cost: <strong>{report.stock.productsWithoutCost}</strong></span>
        </div>
        {report.stock.rows.length === 0 ? (
          <EmptyRow text="No products at or below their minimum stock level." />
        ) : (
          <div className="report-table-wrap">
            <table className="table report-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th className="num">On hand</th>
                  <th className="num">Minimum</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {report.stock.rows.map((row) => (
                  <tr key={`${row.sku}-${row.name}`}>
                    <td className="mono">{row.sku}</td>
                    <td>{row.name}</td>
                    <td className="num">{row.onHand}</td>
                    <td className="num">{row.minStockLevel}</td>
                    <td>
                      <span className={`tag ${row.status === 'OUT' ? 'red' : 'amber'}`}>{row.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-section">
        <h4>Customer credit and receivables (current)</h4>
        <div className="report-preview-meta">
          <span>Owed to shop: <strong>{fmtMoney(report.receivables.totalOwed)}</strong></span>
          <span>Shop owes: <strong>{fmtMoney(report.receivables.totalShopOwes)}</strong></span>
          <span>Net: <strong>{fmtMoney(report.receivables.net)}</strong></span>
          <span>Debtors: <strong>{report.receivables.debtorCount}</strong></span>
          <span>New customers: <strong>{report.receivables.newCustomers}</strong></span>
        </div>
        {report.receivables.rows.length === 0 ? (
          <EmptyRow text="No customer currently owes the shop." />
        ) : (
          <div className="report-table-wrap">
            <table className="table report-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone (masked)</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {report.receivables.rows.map((row, index) => (
                  <tr key={`${row.name}-${row.phoneMasked}-${index}`}>
                    <td>{row.name}</td>
                    <td className="mono">{row.phoneMasked}</td>
                    <td className="num">{fmtMoney(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="report-section">
        <h4>Notes and methodology</h4>
        <ul className="report-notes">
          {report.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </div>

      <div className="report-actions">
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={onDownload} disabled={downloading}>
          {downloading ? 'Preparing PDF…' : 'Download PDF'}
        </button>
      </div>
    </Modal>
  );
}