import { useEffect, useState, useCallback } from 'react';

/**
 * PWA install surface.
 * - Android/desktop Chrome: fires `beforeinstallprompt`; we stash the deferred
 *   prompt so a button can call `prompt()` later (the user-triggered path the
 *   browser allows, instead of the default auto-banner).
 * - iOS (Safari / Chrome-iOS): NO install prompt exists by design — the only
 *   way onto the home screen is Share → "Add to Home Screen". We detect iOS
 *   and show instructions instead of a dead button.
 * - Standalone: once installed as a PWA we hide the affordance entirely.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface InstallPromptState {
  canInstall: boolean;   // deferred beforeinstallprompt available (Android/desktop Chrome)
  isIos: boolean;        // iOS — use "Add to Home Screen" instructions
  isStandalone: boolean; // already running as an installed PWA
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

function computeState(): InstallPromptState {
  return {
    canInstall: !!deferredPrompt,
    isIos: /iPad|iPhone|iPod/.test(navigator.userAgent),
    isStandalone: window.matchMedia('(display-mode: standalone)').matches
  };
}

export function useInstallPrompt() {
  const [state, setState] = useState<InstallPromptState>(computeState);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      setState(computeState());
    };
    const onAppInstalled = () => {
      deferredPrompt = null;
      setState(computeState());
    };
    // Reflect display-mode changes (installed vs browser tab).
    const media = window.matchMedia('(display-mode: standalone)');
    const onMediaChange = () => setState(computeState());

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    if (media.addEventListener) media.addEventListener('change', onMediaChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      if (media.removeEventListener) media.removeEventListener('change', onMediaChange);
    };
  }, []);

  /** Call from a user gesture (e.g. a button click) to show Chrome's install dialog. */
  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredPrompt = null;
      setState(computeState());
    }
    return outcome === 'accepted';
  }, []);

  return { state, promptInstall };
}