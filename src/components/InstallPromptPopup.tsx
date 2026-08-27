import { useEffect, useState } from 'react';
import { Modal } from './ui';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

const DISMISS_KEY = 'alorashop.install.dismissed.v1';
/** "Not now" snoozes the popup for this long before it asks again. */
const REASK_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function dismissedRecently(): boolean {
  try {
    const ts = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Number.isFinite(ts) && ts > 0 && Date.now() - ts < REASK_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * Post-login install nudge. ALWAYS shows our own Install button after a
 * successful login/signup (so users don't need to hunt through Chrome's
 * menu). The button:
 *  - fires Chrome's native dialog when the PWA install event is available,
 *  - on Android falls back to the system WebAPK install flow via an intent://
 *    deep-link when Chrome no longer exposes the event (v108+),
 *  - on iOS shows Share → "Add to Home Screen" steps (no programmatic install).
 *  - already installed (standalone) → never shown.
 *  - "Not now" → snoozes for 7 days. Non-blocking: data loads behind it.
 */
export function InstallPromptPopup() {
  const { state, promptInstall } = useInstallPrompt();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.isStandalone) return;   // already installed — never nag
    if (dismissedRecently()) return;
    // Small delay so the shell/data loads first and the popup doesn't fight
    // the login transition for attention.
    const t = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(t);
  }, [state.isStandalone]);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* storage unavailable — non-fatal */
    }
    setOpen(false);
  };

  const install = async () => {
    setBusy(true);
    try {
      // Returns true only when Chrome's own dialog completed the install.
      // On Android-without-event, the intent launches the system flow and we
      // can't observe the result — keep the popup open in that case.
      if (await promptInstall()) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title="Install AloraShop" onClose={dismiss}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/alora-icon.svg" alt="" style={{ width: 52, height: 52, borderRadius: 12 }} />
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            Add AloraShop to your home screen — it opens full-screen like a native app and keeps working offline.
          </p>
        </div>

        {state.isIos ? (
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
            <li>Tap the <strong>Share</strong> button in your browser.</li>
            <li>Choose <strong>Add to Home Screen</strong>.</li>
            <li>Tap <strong>Add</strong> in the top-right corner.</li>
          </ol>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            Tap <strong>Install now</strong> — it will open your device's install dialog so you can add it to your home screen.
          </p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={dismiss}>Not now</button>
          {!state.isIos && (
            <button className="btn btn-primary" onClick={() => void install()} disabled={busy}>
              {busy ? 'Opening…' : '📲 Install now'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}