import { lazy, Suspense, Component, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { useAuthStore, shopIdOf } from './stores/authStore';
import { useSyncStore } from './stores/syncStore';
import { useInventoryStore } from './stores/inventoryStore';
import { useShopStore } from './stores/shopStore';
import { useUiStore } from './stores/uiStore';
import { getDbStatus, getDbError, subscribeDbStatus, type DbStatus } from './db';

import { seedIfEmpty, purgeDemoData } from './services/seedService';
import { startSyncLoop } from './services/syncService';
import { subscribeLowStock } from './stores/inventoryStore';
import { Toasts, ConfirmDialog } from './components/overlays';
import { EmptyState, Skeleton, SkeletonStats, SkeletonTable } from './components/ui';
import { getMyUnreadCount } from './services/affiliate';
import { getBillingState } from './services/billing';
import { billingNeedsAttention } from './lib/billing';
import { lazyRetry } from './lib/lazyRetry';
import { ReceiptModal } from './components/ReceiptModal';
import { InstallPromptPopup } from './components/InstallPromptPopup';
import LoginPage from './pages/LoginPage';
import POSPage from './pages/POSPage';
import InventoryPage from './pages/InventoryPage';
import SalesPage from './pages/SalesPage';
import AnalyticsPage from './pages/AnalyticsPage';
import CustomersPage from './pages/CustomersPage';
import SettingsPage from './pages/SettingsPage';

// Affiliate (S9) is ONLINE-ONLY and shipped as its OWN lazy chunk, which is
// EXCLUDED from the service-worker precache (vite.config.ts). So the offline
// shell never carries it; offline the lazy import fails and AffiliateBoundary
// renders a friendly "needs a connection" card.
//
// S11b: lazyRetry() turns the POST-DEPLOY case (a stale shell asking for a chunk
// hash that no longer exists) into ONE transparent reload instead of a false
// "needs a connection" card. It is loop-proof (sessionStorage-guarded).
const AffiliatePage = lazy(lazyRetry(() => import('./pages/AffiliatePage')));

// Billing (S12-6) follows the SAME pattern (B5): its own online-only chunk,
// excluded from the precache, with a boundary that degrades to a friendly card.
const BillingPage = lazy(lazyRetry(() => import('./pages/BillingPage')));

/** Catches a failed lazy chunk load (offline) and shows a graceful message. */
class AffiliateBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="card">
          <EmptyState
            icon="🔌"
            title="Affiliate needs a connection"
            hint="This page loads online only. Reconnect, then open Affiliate again."
          />
        </div>
      );
    }
    return this.props.children;
  }
}

/** Billing boundary — mirrors AffiliateBoundary (online-only chunk). */
class BillingBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="card">
          <EmptyState
            icon="🔌"
            title="Billing needs a connection"
            hint="This page loads online only. Reconnect, then open Billing again."
          />
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * S13 — Local-database boot state as React state. The engine is a ~17 MB
 * side-loaded download on a cold device, so the shell can show progress while it
 * arrives — and, crucially, a REAL error card with a retry if it can never
 * start (a failed boot used to leave the app parked on a splash forever, with
 * nothing shown to the user).
 */
function useDbStatus(): { status: DbStatus; error: string | null } {
  const read = () => ({ status: getDbStatus(), error: getDbError() });
  const [state, setState] = useState(read);
  useEffect(() => {
    // Re-read on subscribe as well as on change: a status flip that lands
    // between the initial render and this subscription (React StrictMode
    // remounts the shell) would otherwise strand it on the splash forever.
    setState(read());
    return subscribeDbStatus(() => setState(read()));
  }, []);
  return state;
}

/** Shell-shaped boot placeholder — shown while the local engine starts.
 *
 * S14: this used to be a BLANK full-screen splash, which read as a frozen app.
 * The real sidebar and topbar now render immediately and only the DATA REGION
 * shimmers, so a cold device sees the app shape from its first frame.
 * Same accessibility contract as the other skeletons: the container announces
 * the wait once (role="status"), the shimmer bars are decorative.
 */
function BootSkeleton({ label }: { label: string }) {
  return (
    <div className="page" role="status" aria-label={label}>
      <Skeleton width={220} height={26} />
      <div style={{ marginTop: 10 }}>
        <Skeleton width="58%" height={12} />
      </div>
      <div style={{ marginTop: 18 }}>
        <SkeletonStats count={4} />
      </div>
      <div style={{ marginTop: 18 }}>
        <SkeletonTable rows={6} cols={6} />
      </div>
    </div>
  );
}

/** The local engine could not start — say so and offer a retry (never a hang). */
function BootFailure({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 20 }}>
      <div className="card" style={{ maxWidth: 460, textAlign: 'center' }}>
        <EmptyState
          icon="⚠️"
          title="Your offline data could not start"
          hint={error ?? 'The local database engine failed to load.'}
        />
        <button className="btn" onClick={onRetry} style={{ padding: '12px 18px', fontWeight: 800 }}>
          Try again
        </button>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          The first launch downloads the offline engine once — check your connection, then try again.
        </div>
      </div>
    </div>
  );
}

function NavBadge({ path, label, icon, badge }: { path: string; label: string; icon: string; badge?: number }) {
  return (
    <NavLink to={path} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span>{icon}</span> {label}
      {badge ? <span className="badge">{badge}</span> : null}
    </NavLink>
  );
}

function Shell() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const online = useSyncStore((s) => s.online);
  const pending = useSyncStore((s) => s.pending);
  const failed = useSyncStore((s) => s.failed);
  const localOnly = useSyncStore((s) => s.localOnly);
  const lastError = useSyncStore((s) => s.lastError);
  const lowStock = useInventoryStore((s) => s.lowStock.length);
  const shopName = useShopStore((s) => s.name);

  // S13: local-database boot state. The data screens read PGlite, so the shell
  // waits for the engine — while the AUTH routes never do (see the gate below).
  const db = useDbStatus();
  /** Used by the retry button on the boot-failure card. */
  const syncRefresh = useSyncStore((s) => s.refresh);
  const inventoryRefresh = useInventoryStore((s) => s.refresh);

  // Sidebar drawer — toggleable via the ☰ button in the topbar.
  // Open by default on wide screens; on small screens the sidebar is hidden
  // behind the button (the old CSS just `display:none`'d it with no way back).
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 1000);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1000px)');
    const onChange = () => setSidebarOpen(!mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const handleNavClick = () => {
    if (window.innerWidth <= 1000) setSidebarOpen(false);
  };

  // Keep the sidebar brand in sync with the shop name. Re-fetches whenever
  // the signed-in shop changes (login, create-shop, switch, revalidation) —
  // the cloud name wins when reachable, otherwise the cached/default name.
  const shopId = user?.shopId;
  useEffect(() => {
    if (shopId) void useShopStore.getState().refresh();
  }, [shopId]);

  // Affiliate unread badge (S9). Online-only + non-fatal: a failure just means
  // no badge, never a broken shell. Refreshes when connectivity flips on.
  const [affiliateUnread, setAffiliateUnread] = useState(0);
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void (async () => {
      try {
        const n = await getMyUnreadCount();
        if (!cancelled) setAffiliateUnread(n);
      } catch {
        /* non-fatal — no badge */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online, shopId]);

  // Billing "needs attention" badge (S12-7). DERIVED from billing.state() with the
  // pure `billingNeedsAttention` helper — no new table, no migration, no secret.
  // The Billing page already shows the banner + countdown; this ONLY pulls a
  // member who is not on that page. Online-only + non-fatal: a failure, or a
  // session without a shop, simply means no badge (never a broken shell).
  //
  // SELF-CLEAR: the shell persists across navigation, so a one-shot load would go
  // stale after a member pays. We therefore re-check on tab WAKE (focus /
  // visibilitychange) and on in-app NAVIGATION (hashchange — the router is
  // hash-based), so the badge clears as soon as the paid state is observed.
  const [billingAttention, setBillingAttention] = useState(false);
  useEffect(() => {
    if (!online || !shopId) return;
    let cancelled = false;
    let seq = 0; // last-write-wins: wake + navigation checks can overlap
    const refresh = () => {
      const my = ++seq;
      void (async () => {
        try {
          const s = await getBillingState();
          // Only the LATEST in-flight check may set state, so a slow earlier
          // response can never overwrite a newer one (a silent-bug defence).
          if (!cancelled && my === seq) setBillingAttention(billingNeedsAttention(s));
        } catch {
          /* non-fatal — no badge */
        }
      })();
    };
    refresh(); // initial load (mount / reconnect / shop switch)
    const onWake = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('hashchange', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('hashchange', refresh);
    };
  }, [online, shopId]);

  // No session, or session without a shop yet -> auth/create-shop flow.
  if (!user || !user.shopId) return <Navigate to="/login" replace />;

  // S13: the data screens read the LOCAL database, so they must not mount until
  // its engine is up — otherwise POS would show an empty catalogue ("no items
  // yet") for the seconds the ~17 MB engine takes to arrive, which reads as lost
  // data. The auth routes above never reach this point, so sign-up stays instant.
  // A failed boot shows a retry card instead of hanging silently.
  if (db.status === 'failed') {
    return (
      <BootFailure
        error={db.error}
        onRetry={() => {
          void syncRefresh();
          void inventoryRefresh();
        }}
      />
    );
  }

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}`}>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar">
        <div className="brand" title={shopName}>
          <span className="logo">{shopName.trim().charAt(0).toUpperCase() || 'A'}</span>
          <span className="brand-name">{shopName}</span>
        </div>
        <nav className="nav" onClick={handleNavClick}>
          <NavBadge path="/pos" label="Sell Item" icon="🛒" />
          <NavBadge path="/inventory" label="Add Items" icon="📦" badge={lowStock} />
          <NavBadge path="/sales" label="Sales" icon="🧾" />
          <NavBadge path="/customers" label="Customers" icon="👥" />
          <NavBadge path="/analytics" label="Analytics" icon="📊" />
          <NavBadge path="/affiliate" label="Earn" icon="💸" badge={affiliateUnread} />
          <NavBadge path="/billing" label="Payment" icon="💳" badge={billingAttention ? 1 : 0} />
          <NavBadge path="/settings" label="Settings" icon="⚙️" />
        </nav>
        <div className="foot">
          <div className="user">{user.displayName}</div>
          <div style={{ marginTop: 2 }}>{user.role.toUpperCase()} · {user.shopId}</div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8, color: '#94a3b8' }} onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="topbar">
          <button
            className="menu-btn"
            onClick={() => setSidebarOpen((o) => !o)}
            title={sidebarOpen ? 'Hide menu' : 'Show menu'}
            aria-label="Toggle navigation menu"
          >
            ☰
          </button>
          <span className={`pill ${online ? 'online' : 'offline'}`}>
            {online ? '● Online' : '○ Offline'}
          </span>
          {failed > 0 && (
            <span className="pill quota-critical" title={lastError ?? 'Sync error — see Settings'}>
              {failed} sync error{failed > 1 ? 's' : ''}
            </span>
          )}
          {pending > 0 && <span className="pill pending">{pending} queued to sync</span>}
          {localOnly > 0 && (
            <span className="pill offline" title="Offline/demo shop data — can never reach the cloud. Clear in Settings.">
              {localOnly} local-only
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {new Date().toLocaleDateString('en-GH', { weekday: 'short', day: '2-digit', month: 'short' })}
            </span>
          </div>
        </div>
        <main className="main">
          {db.status !== 'ready' ? (
            <BootSkeleton label="Preparing your offline shop data…" />
          ) : (
          <Routes>
            <Route path="/pos" element={<POSPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/sales" element={<SalesPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route
              path="/affiliate"
              element={
                <AffiliateBoundary>
                  <Suspense fallback={<div className="card">Loading Affiliate…</div>}>
                    <AffiliatePage />
                  </Suspense>
                </AffiliateBoundary>
              }
            />
            <Route
              path="/billing"
              element={
                <BillingBoundary>
                  <Suspense fallback={<div className="card">Loading Billing…</div>}>
                    <BillingPage />
                  </Suspense>
                </BillingBoundary>
              }
            />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/pos" replace />} />
          </Routes>
          )}
        </main>
      </div>
      {/* Post-login install nudge — only when signed in and not already
          installed as a PWA. Non-blocking: data loading continues behind it. */}
      <InstallPromptPopup />
    </div>
  );
}

export default function App() {
  const shopId = useAuthStore((s) => s.user?.shopId);
  const refresh = useSyncStore((s) => s.refresh);
  const inventoryRefresh = useInventoryStore((s) => s.refresh);
  const toast = useUiStore((s) => s.push);
  const isDev = import.meta.env.DEV;

  // S13 — BACKGROUND BOOT (fire-and-forget).
  //
  // This used to gate the WHOLE app — /login and create-shop included — behind
  // `initialize() + refresh() + inventoryRefresh()`, so the FIRST PAINT waited
  // for the ~17 MB PGlite engine to download. The result was a frozen splash and
  // a sign-up page that could not appear until a database it never uses had
  // arrived. Now:
  //   - a brand-new visitor gets the sign-up / create-shop UI immediately and
  //     downloads no engine at all until a shop exists;
  //   - once a shop is known the engine loads in the background, and because the
  //     service worker has already precached it (main.tsx) that fetch is served
  //     from the cache instead of being downloaded a second time;
  //   - a failure is SURFACED (toast here + the Shell's retry card) instead of
  //     silently parking the app on the splash forever.
  //
  // The session itself is restored pre-paint by main.tsx (zero network), so this
  // effect never has to wait on auth.
  //
  // DEV keeps the old offline-demo behaviour — seed when signed out, purge
  // leftovers when signed in — because localhost pays no network cost for it.
  useEffect(() => {
    // PROD: nothing to boot until there is a shop. Demo data and a real shop are
    // MUTUALLY EXCLUSIVE: a real session purges offline-demo leftovers and never
    // seeds; no session seeds the offline demo shell once and never a real shop.
    if (!shopId && !isDev) return;

    let cancelled = false;
    let stopSync: (() => void) | undefined;
    let stopLowStock: (() => void) | undefined;

    void (async () => {
      try {
        if (isDev) {
          if (shopId) await purgeDemoData();
          else await seedIfEmpty();
        }
        await Promise.all([refresh(), inventoryRefresh()]);
        if (cancelled) return;
        stopSync = startSyncLoop();
        stopLowStock = subscribeLowStock(() => void inventoryRefresh());
      } catch (err) {
        // Never swallow it: the Shell also shows a retry card for the same state.
        toast(
          'error',
          `Your offline data could not start${err instanceof Error ? ` — ${err.message}` : ''}`
        );
      }
    })();

    return () => {
      cancelled = true;
      stopSync?.();
      stopLowStock?.();
    };
  }, [shopId, isDev, refresh, inventoryRefresh, toast]);

  return (
    <HashRouter>
      <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/*" element={<Shell />} />
            </Routes>
      <Toasts />
      <ConfirmDialog />
      <ReceiptModal />
    </HashRouter>
  );
}