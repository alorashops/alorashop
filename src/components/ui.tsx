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