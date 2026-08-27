import { useEffect, useState } from 'react';
import { useAuthStore, canManageStaff, canAddManager } from '../stores/authStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';
import { useShopStore, MAX_SHOP_NAME } from '../stores/shopStore';
import { db } from '../db';
import { clearLocalData } from '../services/seedService';
import { flushOutbox } from '../services/syncService';
import { purgeLocalOnlyOutbox } from '../db/repos/outbox';
import { addStaff, sendStaffInvite } from '../services/supabase';
import { Modal } from '../components/ui';
import { isSupabaseConfigured } from '../config/env';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import type { UserProfile, Role } from '../types';

const ROLE_MATRIX: Array<[string, string, boolean, boolean, boolean]> = [
  ['Scan items, sell, split payment', 'Checkout', true, true, true],
  ['Print / resend / digital receipts', 'Receipts', true, true, true],
  ['View own sales (today only)', 'Own sales', true, true, true],
  ['See cost prices / profit margins', 'Costing', false, true, true],
  ['Manage inventory, restock, damage logs', 'Inventory', false, true, true],
  ['Approve voids & returns', 'Voids', false, true, true],
  ['Shop-wide analytics & reports', 'Analytics', false, true, true],
  ['Add staff accounts (cashiers; admins add managers too)', 'Staff', false, true, true],
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
  // Staff card shows for both admin & manager (manager adds cashiers only).
  const canManage = canManageStaff(user?.role);
  const isAdmin = canAddManager(user?.role);
  const [staff, setStaff] = useState<UserProfile[]>([]);
  const [exporting, setExporting] = useState(false);
  // Add-staff modal
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [staffEmail, setStaffEmail] = useState('');
  const [staffName, setStaffName] = useState('');
  const [staffRole, setStaffRole] = useState<Role>('cashier');
  const [addingStaff, setAddingStaff] = useState(false);
  const { state: installState, promptInstall } = useInstallPrompt();

  // Shop name — admin can edit; everyone sees it on the sidebar + receipts.
  const shopName = useShopStore((s) => s.name);
  const refreshShopName = useShopStore((s) => s.refresh);
  const updateShopName = useShopStore((s) => s.updateName);
  const canRename = user?.role === 'admin';
  const [nameDraft, setNameDraft] = useState(shopName);
  const [savingName, setSavingName] = useState(false);

  // Keep the draft in sync when the authoritative name changes (initial load,
  // account switch, or another device's rename pulled on refresh).
  useEffect(() => { setNameDraft(shopName); }, [shopName]);
  useEffect(() => { void refreshShopName(); }, [refreshShopName]);

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      toast.push('warn', 'Shop name cannot be empty.');
      return;
    }
    if (trimmed.length > MAX_SHOP_NAME) {
      toast.push('warn', `Keep it under ${MAX_SHOP_NAME} characters.`);
      return;
    }
    setSavingName(true);
    try {
      const synced = await updateShopName(trimmed);
      toast.push(synced ? 'success' : 'info', synced ? 'Shop name updated.' : 'Saved on this device — the cloud will confirm when it reconnects.');
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setSavingName(false);
    }
  };

  const loadStaff = () => {
    void db.users.toArray().then(setStaff);
  };

  useEffect(() => {
    loadStaff();
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

  /**
   * Creates the staff account on the cloud (SECURITY DEFINER add_staff RPC),
   * sends them an invite email to set their OWN password, then mirrors the new
   * profile row locally so the list updates immediately. Role guardrails run
   * on the server — this UI only offers valid options.
   */
  const handleAddStaff = async () => {
    if (!isSupabaseConfigured) {
      toast.push('error', 'Cloud not configured — staff invites need a connected Supabase project (.env).');
      return;
    }
    if (!staffEmail.trim() || !staffName.trim()) {
      toast.push('warn', 'Please fill in the name and email.');
      return;
    }
    setAddingStaff(true);
    try {
      // Creates the account (unconfirmed, no usable password).
      const uid = await addStaff(staffEmail, staffName, staffRole);
      // Sends the invite email with a recovery link → staff set their own password.
      await sendStaffInvite(staffEmail);
      await db.users.put({ uid, shopId: user?.shopId ?? '', displayName: staffName.trim(), role: staffRole });
      toast.push('success', `Invite sent — ${staffName.trim()} will set their own password.`);
      setStaffModalOpen(false);
      setStaffEmail('');
      setStaffName('');
      setStaffRole('cashier');
      loadStaff();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : String(err));
    } finally {
      setAddingStaff(false);
    }
  };

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Shop settings, roles, quota guardrails and data controls.</p>

      <div className="grid" style={{ marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 10 }}>Shop</div>
          {canRename ? (
            <div className="field">
              <label>Shop name</label>
              <input
                className="input"
                value={nameDraft}
                maxLength={MAX_SHOP_NAME}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="e.g. Mensah Provision Store"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {nameDraft.length}/{MAX_SHOP_NAME} — used on the sidebar and receipts.
                </span>
                <button className="btn btn-sm btn-primary" onClick={() => void saveName()} disabled={savingName || nameDraft.trim() === shopName}>
                  {savingName ? 'Saving…' : 'Save name'}
                </button>
              </div>
            </div>
          ) : (
            <div className="field">
              <label>Shop name</label>
              <input className="input" value={shopName} readOnly />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Only the shop admin can change the name.
              </span>
            </div>
          )}
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

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 800, marginBottom: 10 }}>Install app</div>
        {installState.isStandalone ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            ✅ AloraShop is installed on this device — no action needed.
          </p>
        ) : installState.isIos ? (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              iOS doesn't offer an install button in the browser. To add AloraShop to your home screen:
            </p>
            <ol style={{ margin: '6px 0 0 18px', paddingLeft: 4 }}>
              <li>Tap the <strong>Share</strong> button in the browser.</li>
              <li>Choose <strong>Add to Home Screen</strong>.</li>
              <li>Tap <strong>Add</strong> in the top-right.</li>
            </ol>
            <p style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
              It will then open full-screen like a native app, with the AloraShop icon.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <p style={{ margin: 0, fontSize: 13 }}>Install AloraShop to open it full-screen like a native app.</p>
            <button className="btn btn-primary" onClick={() => void promptInstall()}>
              📲 Install AloraShop
            </button>
          </div>
        )}
      </div>

      {canManage && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 800 }}>
              Staff accounts {isAdmin ? '(admin)' : '(manager)'}
            </span>
            <button className="btn btn-sm btn-primary" onClick={() => setStaffModalOpen(true)}>
              + Add staff
            </button>
          </div>
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
            {isAdmin
              ? 'Admins can add managers and cashiers. Roles enforce via Supabase RLS + auth claims, never the client.'
              : 'Managers can add cashiers. Adding another manager requires an admin.'}
          </p>
        </div>
      )}

      {/* Add staff modal */}
      <Modal open={staffModalOpen} title="Add staff member" onClose={() => setStaffModalOpen(false)}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label>Full name</label>
            <input className="input" value={staffName} onChange={(e) => setStaffName(e.target.value)} placeholder="e.g. Kofi Mensah" autoFocus />
          </div>
          <div className="field">
            <label>Email (must be unique — they'll log in with this)</label>
            <input className="input" type="email" value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            An invite email will be sent to this address with a secure link to set their own password. No password is shared through this device.
          </p>
          {isAdmin && (
            <div className="field">
              <label>Role</label>
              <select className="select" value={staffRole} onChange={(e) => setStaffRole(e.target.value as Role)}>
                <option value="cashier">Cashier</option>
                <option value="manager">Manager</option>
              </select>
            </div>
          )}
          {!isAdmin && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              As a manager you can add cashiers only. {user?.displayName} is the manager; the owner (admin) can add managers.
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setStaffModalOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void handleAddStaff()} disabled={addingStaff}>
              {addingStaff ? 'Adding…' : 'Add staff'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}