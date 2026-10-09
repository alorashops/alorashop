import { lazy, Suspense, Component, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { useAuthStore, shopIdOf } from './stores/authStore';
import { useSyncStore } from './stores/syncStore';
import { useInventoryStore } from './stores/inventoryStore';
import { useShopStore } from './stores/shopStore';

import { seedIfEmpty, purgeDemoData } from './services/seedService';
import { startSyncLoop } from './services/syncService';
import { subscribeLowStock } from './stores/inventoryStore';
import { Toasts, ConfirmDialog } from './components/overlays';
import { EmptyState } from './components/ui';
import { getMyUnreadCount } from './services/affiliate';
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

  // No session, or session without a shop yet -> auth/create-shop flow.
  if (!user || !user.shopId) return <Navigate to="/login" replace />;

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}`}>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className="sidebar">
        <div className="brand" title={shopName}>
          <span className="logo">{shopName.trim().charAt(0).toUpperCase() || 'A'}</span>
          <span className="brand-name">{shopName}</span>
        </div>
        <nav className="nav" onClick={handleNavClick}>
          <NavBadge path="/pos" label="Checkout" icon="🛒" />
          <NavBadge path="/inventory" label="Inventory" icon="📦" badge={lowStock} />
          <NavBadge path="/sales" label="Sales" icon="🧾" />
          <NavBadge path="/customers" label="Customers" icon="👥" />
          <NavBadge path="/analytics" label="Analytics" icon="📊" />
          <NavBadge path="/affiliate" label="Affiliate" icon="💸" badge={affiliateUnread} />
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
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/pos" replace />} />
          </Routes>
        </main>
      </div>
      {/* Post-login install nudge — only when signed in and not already
          installed as a PWA. Non-blocking: data loading continues behind it. */}
      <InstallPromptPopup />
    </div>
  );
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const initialize = useAuthStore((s) => s.initialize);
  const refresh = useSyncStore((s) => s.refresh);
  const inventoryRefresh = useInventoryStore((s) => s.refresh);

  useEffect(() => {
    let stopSync: (() => void) | undefined;
    let stopLowStock: (() => void) | undefined;

    void (async () => {
      // Local-first bootstrap: restore the real Supabase session first.
      // Demo data and a real shop are MUTUALLY EXCLUSIVE:
      //  - Real session  -> purge any offline-demo leftovers (old bug), never seed.
      //  - No session    -> seed the offline demo shell (once), never a real shop.
      await initialize();
      if (import.meta.env.DEV) {
        const who = useAuthStore.getState().user;
        if (who?.shopId) {
          await purgeDemoData();
        } else if (!who) {
          await seedIfEmpty();
        }
      }
      await Promise.all([refresh(), inventoryRefresh()]);
      stopSync = startSyncLoop();
      stopLowStock = subscribeLowStock(() => void inventoryRefresh());
      setBooted(true);
    })();

    return () => {
      stopSync?.();
      stopLowStock?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!booted) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 40, fontWeight: 800, color: 'var(--primary)' }}>AloraShop</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 8 }}>Loading local database…</div>
        </div>
      </div>
    );
  }

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