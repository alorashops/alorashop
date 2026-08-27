import { useEffect, useState, useCallback } from 'react';

/**
 * PWA install surface — the app's own install path, not Chrome's banner.
 *
 * Chrome removed the automatic install banner in Android v108+, so we can't
 * rely on the browser showing anything. Instead:
 *
 *  - Chrome exposes `beforeinstallprompt` → we capture it and offer a real
 *    "Install now" button that opens the native install dialog.
 *  - Chrome does NOT fire the event (first visit, prior dismissal, or the
 *    banner removal) → we still show our own button; tapping it launches the
 *    Android system WebAPK install flow directly via an intent:// deep-link
 *    to the browser's install handler (no reliance on the banner).
 *  - iOS → no programmatic install exists; we show Share → "Add to Home
 *    Screen" steps.
 *  - Already installed (standalone) → never nag.
 *
 * IMPORTANT: `beforeinstallprompt` fires only ONCE per page load, and it can
 * fire before React hydrates on a slow phone. So the listener is attached at
 * MODULE LOAD (synchronously, the instant this module is imported), not inside
 * useEffect — otherwise the single-shot event is missed and the Install button
 * never appears.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface InstallPromptState {
  canInstall: boolean;   // deferred beforeinstallprompt available
  isIos: boolean;        // iOS — use "Add to Home Screen" instructions
  isStandalone: boolean; // already running as an installed PWA
  isAndroid: boolean;    // Android — may need the intent:// fallback
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function computeState(): InstallPromptState {
  const ua = navigator.userAgent;
  return {
    canInstall: !!deferredPrompt,
    isIos: /iPad|iPhone|iPod/.test(ua),
    isStandalone: window.matchMedia('(display-mode: standalone)').matches,
    isAndroid: /Android/i.test(ua)
  };
}

function notify(): void {
  listeners.forEach((l) => l());
}

// --- Attached synchronously at module load so the single-shot event isn't
//     missed while React is still bootstrapping. ---
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

/**
 * Android fallback: when `beforeinstallprompt` never fired, launch the
 * system's WebAPK install flow directly via an intent:// deep-link into the
 * browser's PWA install handler. Works regardless of the (removed) banner.
 * The `S.browser_fallback_url` takes the user to the site if the intent
 * can't be resolved.
 */
export function launchAndroidInstall(): void {
  const url = window.location.origin;
  // Android Chrome's install activity package/class; this is the stable,
  // documented intent for triggering WebAPK installs programmatically.
  const intent =
    `intent://install#Intent;scheme=alorashop;package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(url)};end`;
  window.location.href = intent;
}

export function useInstallPrompt() {
  const [state, setState] = useState<InstallPromptState>(computeState);

  useEffect(() => {
    const update = () => setState(computeState());
    listeners.add(update);
    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener?.('change', update);
    update(); // pick up anything captured before this component mounted
    return () => {
      listeners.delete(update);
      media.removeEventListener?.('change', update);
    };
  }, []);

  /**
   * Call from a user gesture (a button click). Uses the captured
   * beforeinstallprompt if present; on Android falls back to the system
   * intent so the user still gets a real install flow.
   */
  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredPrompt = null;
        notify();
        return true;
      }
      return false;
    }
    // No event captured — on Android, launch the system install flow directly.
    if (state.isAndroid) {
      launchAndroidInstall();
      return false; // we can't observe the result; leave the dialog open
    }
    return false;
  }, [state.isAndroid]);

  return { state, promptInstall };
}