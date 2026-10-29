import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { captureReferralFromUrl } from './lib/referral';
import { useAuthStore } from './stores/authStore';

// S3b: capture a `?ref=CODE` referral as early as possible and persist it for the
// signup flow — a reload before the shop is named would otherwise drop the query.
captureReferralFromUrl();

// S13: restore the session BEFORE the first render. initialize() reads our OWN
// localStorage identity mirror and sets `booted` synchronously — its first await
// is a best-effort background reconcile — so this costs no network. The first
// paint therefore already knows whether someone is signed in: no flash of the
// login page for a signed-in user, and no "Starting…" flash for anyone.
void useAuthStore.getState().initialize();

// S13: register the PWA service worker OFF the critical path.
//
// This used to be a TOP-LEVEL AWAIT, which made React wait for the
// pwa-register + workbox-window chunks before it could render ANYTHING — the
// literal "it has to download the PWA stuff first" freeze. Registration now
// happens after the page has loaded (i.e. after first paint) and is never
// awaited, so the offline shell can never delay the UI.
//
// It is also what makes the local database fast: the service worker precaches
// the ~17 MB PGlite engine, so registering it early means the database's own
// fetch is served from the cache instead of being downloaded a second time.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const register = () => {
    void import('virtual:pwa-register')
      .then(({ registerSW }) => registerSW({ immediate: true }))
      .catch(() => {
        /* offline shell unavailable — the online app still works */
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
