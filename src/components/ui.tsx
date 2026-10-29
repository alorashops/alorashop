import type { ReactNode } from 'react';

export function Modal({ open, title, sub, onClose, children }: {
  open: boolean;
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {sub && <div className="modal-sub">{sub}</div>}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ icon = '🗂️', title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 34, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {hint && <div style={{ fontSize: 13, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function MethodTag({ method }: { method: string }) {
  const cls =
    method === 'CASH' ? 'green' : method === 'CREDIT' ? 'amber' : method === 'CARD' ? 'indigo' : 'slate';
  return <span className={`tag ${cls}`}>{method}</span>;
}

export function StatusTag({ status }: { status: string }) {
  const cls = status === 'PAID' ? 'green' : status === 'PENDING_VERIFICATION' ? 'amber' : 'red';
  return <span className={`tag ${cls}`}>{status.replace(/_/g, ' ')}</span>;
}

/* ---------- loading skeletons (S14) ----------
   Purely presentational shimmer placeholders shown ONLY while a screen's data
   is still arriving (initial load) — a manual refresh keeps the rows already on
   screen and uses the button spinner instead, so nothing ever blinks.

   Accessibility: the shimmer BARS are aria-hidden (an empty bar carries no
   meaning), while the WRAPPING container carries role="status" + a label so a
   screen reader hears "Loading…" once instead of a wall of empty cells. */

/** One shimmering placeholder bar. Width/height accept any CSS length (numbers = px). */
export function Skeleton({
  width = '100%',
  height = 12,
  radius = 6,
  className = ''
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
}) {
  return (
    <span
      className={`skeleton skeleton-shimmer${className ? ` ${className}` : ''}`}
      style={{ display: 'block', width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** A stack of text-line placeholders; the last line is shorter, like real prose. */
export function SkeletonText({
  lines = 3,
  height = 12,
  gap = 8,
  className = ''
}: {
  lines?: number;
  height?: number | string;
  gap?: number;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap }}
      role="status"
      aria-label="Loading…"
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={height} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

/** A generic shimmering card block — page-level placeholder. */
export function SkeletonCard({ lines = 3, className = 'card' }: { lines?: number; className?: string }) {
  return (
    <div className={className} role="status" aria-label="Loading…">
      <SkeletonText lines={lines} />
    </div>
  );
}

/** Table-body placeholder — a real <table className="table"> shell with shimmer cells. */
export function SkeletonTable({
  rows = 6,
  cols = 5,
  header = true
}: {
  rows?: number;
  cols?: number;
  header?: boolean;
}) {
  // Rotating widths keep the placeholder looking like real, ragged data rather
  // than a suspiciously uniform grid.
  const widths = ['70%', '55%', '40%', '80%', '50%', '65%'];
  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }} role="status" aria-label="Loading…">
      <table className="table">
        {header && (
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c}>
                  <Skeleton width="60%" height={10} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c}>
                  <Skeleton width={widths[(r + c) % widths.length]} height={12} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Grid of product-tile placeholders — mirrors `.product-grid > .product-tile`.
 *  Used by POS, whose catalogue is tiles (a table skeleton would look wrong). */
export function SkeletonTiles({ count = 8, className = 'product-grid' }: { count?: number; className?: string }) {
  return (
    <div className={className} role="status" aria-label="Loading…">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="product-tile" aria-hidden="true">
          <Skeleton width="70%" height={12} />
          <div style={{ marginTop: 10 }}>
            <Skeleton width="42%" height={14} />
          </div>
          <div style={{ marginTop: 8 }}>
            <Skeleton width="55%" height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Grid of stat-card placeholders — mirrors `.grid.cols-4 > .card.stat`. */
export function SkeletonStats({ count = 4, className = 'grid cols-4' }: { count?: number; className?: string }) {
  return (
    <div className={className} role="status" aria-label="Loading…">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card stat">
          <Skeleton width={70} height={10} />
          <div style={{ marginTop: 10 }}>
            <Skeleton width={110} height={22} />
          </div>
          <div style={{ marginTop: 8 }}>
            <Skeleton width="55%" height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}
