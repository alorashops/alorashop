import { useUiStore } from '../stores/uiStore';

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const state = useUiStore((s) => s.confirmState);
  const clear = useUiStore((s) => s.clearConfirm);
  if (!state) return null;
  return (
    <div className="modal-backdrop" onClick={clear}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h3>{state.title}</h3>
        <div className="modal-sub">{state.message}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={clear}>Cancel</button>
          <button
            className="btn btn-danger"
            onClick={() => {
              clear();
              state.onConfirm();
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}