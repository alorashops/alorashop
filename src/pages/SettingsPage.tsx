import { useEffect, useState } from 'react';
import { useAuthStore, canManageStaff } from '../stores/authStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { db } from '../db';
import { clearLocalData } from '../services/seedService';
import { flushOutbox } from '../services/syncService';
import { purgeLocalOnlyOutbox } from '../db/repos/outbox';
import { DEFAULT_SHOP_NAME } from '../config/env';
import type { UserProfile } from '../types';

const ROLE_MATRIX: Array<[string, string, boolean, boolean, boolean]> = [
  ['Scan items, sell, split payment', 'Checkout', true, true, true],
  ['Print / resend / digital receipts', 'Receipts', true, true, true],
  ['View own sales (today only)', 'Own sales', true, true, true],
  ['See cost prices / profit margins', 'Costing', false, true, true],
  ['Manage inventory, restock, damage logs', 'Inventory', false, true, true],
  ['Approve voids & returns', 'Voids', false, true, true],
  ['Shop-wide analytics & reports', 'Analytics', false, true, true],
  ['Manage staff accounts & roles', 'Staff', false, false, true],
  ['Shop settings, pricing, data export', 'Settings', false, false, true]
];

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const toast = useUiStore();
  const pending = useSyncStore((s) => s.pending);
  const failed = useSyncStore((s) => s.failed);
  const localOnly = useSyncStore((s) => s.localOnly);
  const lastError = useSyncStore((s) => s.lastError);
  const refreshSync = useSyncStore((s) => s.refresh);
  const isAdmin = canManageStaff(user?.role);
  const [staff, setStaff] = useState<UserProfile[]>([]);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    void db.users.toArray().then(setStaff);
  }, []);

  const exportData = async () => {
    setExporting(true);
    try {
      const data = {
        exportedAt: new Date().toISOString(),
        shop: user?.shopId,
        products: await db.products.toArray(),
        sales: await db.sales.toArray(),
        stockLedger: await db.stockLedger.toArray(),
        summaries: await db.dailySummaries.toArray(),
        customers: await db.customers.toArray()
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `alorashop-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.push('success', 'Local data exported (JSON)');
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const doFlush = async () => {
    try {
      await flushOutbox(true);
      await refreshSync();
      const st = useSyncStore.getState();
      if (st.lastError) {
        toast.push('error', `Sync failed: ${st.lastError}`);
      } else if (st.pending > 0 || st.localOnly > 0) {
        toast.push('info', 'Nothing left to push — items below cannot sync.');
      } else {
        toast.push('success', 'Outbox flushed — everything synced.');
      }
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    }
  };

  const doPurgeLocalOnly = () => {
    toast.ask(
      `Remove ${localOnly} local-only sync item${localOnly === 1 ? '' : 's'}?`,
      'These belong to the offline demo shop and can never reach the cloud. Local data rows are kept — only their pending-sync marker is removed.',
      async () => {
        try {
          const n = await purgeLocalOnlyOutbox();
          await refreshSync();
          toast.push('success', `Removed ${n} local-only outbox ${n === 1 ? 'entry' : 'entries'}.`);
        } catch (err) {
          toast.push('error', err instanceof Error ? err.message : String(err));
        }
      }
    );
  };

  const doClear = () => {
    toast.ask(
      'Erase all local data?',
      'Deletes products, sales, ledger, summaries and outbox from THIS device only. Cloud backups are untouched.',
      async () => {
        try {
          await clearLocalData();
          toast.push('success', 'Local data cleared — reload to re-seed.');
          setTimeout(() => window.location.reload(), 800);
        } catch (err) {
          toast.push('error', err instanceof Error ? err.message : String(err));
        }
      }
    );
  };

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Shop settings, roles, quota guardrails and data controls.</p>

      <div className="grid" style={{ marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Shop</div>
          <div className="field"><label>Shop name</label><input className="input" defaultValue={DEFAULT_SHOP_NAME} /></div>
          <div className="field"><label>Shop ID</label><input className="input" value={user?.shopId ?? ''} readOnly /></div>
          <div className="field"><label>Signed in as</label><input className="input" value={`${user?.displayName} (${user?.role})`} readOnly /></div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Role & access matrix</div>
          <table className="table">
            <thead>
              <tr><th>Capability</th><th>Cashier</th><th>Manager</th><th>Admin</th></tr>
            </thead>
            <tbody>
              {ROLE_MATRIX.map(([cap, short, c, m, a]) => (
                <tr key={short}>
                  <td>{cap}</td>
                  <td>{c ? '✅' : '—'}</td>
                  <td>{m ? '✅' : '—'}</td>
                  <td>{a ? '✅' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Client checks are UX-only. Supabase RLS + server roles are the real gatekeeper.
          </p>
        </div>

        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Sync & data</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => void doFlush()}>Flush outbox now</button>
            <button className="btn btn-secondary" onClick={() => void exportData()} disabled={exporting}>
              {exporting ? 'Exporting…' : 'Export local data (JSON)'}
            </button>
            <button className="btn btn-secondary" onClick={doPurgeLocalOnly} disabled={localOnly === 0}>
              {localOnly > 0 ? `Remove ${localOnly} local-only item${localOnly === 1 ? '' : 's'} (demo)` : 'Clear local-only items'}
            </button>
            <button className="btn btn-danger" onClick={doClear}>Erase local data (this device)</button>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 12, fontSize: 13 }}>
            <span><strong>{pending}</strong> queued</span>
            <span className={failed > 0 ? '' : ''}><strong style={{ color: failed > 0 ? 'var(--danger)' : undefined }}>{failed}</strong> failed</span>
            <span style={{ color: 'var(--text-muted)' }}><strong>{localOnly}</strong> local-only</span>
          </div>
          {lastError && (
            <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
              Last sync error: {lastError}
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            The outbox survives reloads and restarts. A sale is durable the moment it lands in the local DB.
          </p>
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Staff accounts (admin only)</div>
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Shop</th></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.uid}>
                  <td style={{ fontWeight: 700 }}>{s.displayName}</td>
                  <td><span className={`tag ${s.role === 'admin' ? 'indigo' : s.role === 'manager' ? 'amber' : 'slate'}`}>{s.role}</span></td>
                  <td className="mono">{s.shopId}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Production: roles live in auth custom claims (privileged admin path only) — never client-writable.
          </p>
        </div>
      )}
    </div>
  );
}