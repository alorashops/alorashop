/**
 * AloraShop — local privacy / sign-out safety (safety.md).
 *
 * The POS is offline-first: the shop's data lives in the browser's PGlite
 * (IndexedDB) and — until this module existed — OUTLIVED the session. On a
 * shared / handed-down / stolen device, sales, customers, credit and margins
 * stayed on disk after sign-out. `smartWipeForLogout()` is the "smart wipe":
 * it removes the SENSITIVE tables but KEEPS the catalog (`products`), so the
 * POS still boots and works offline for the next person.
 *
 * Dependency-free by design (only `import type` at the top level) so the exact
 * core (`runSmartWipe`) can be unit-tested in plain Node against real PGlite by
 * `scripts/verify_safety_smart_wipe.ts`. This mirrors the deliberate
 * dependency-free contract of `supabase/functions/verify-payment/decide.ts`.
 * The browser DB and the sync worker are pulled in via dynamic import INSIDE
 * `smartWipeForLogout()`, never at module load (keeps the module Node-loadable
 * and avoids a static import cycle with the auth/sync stores).
 */
import type { OutboxEntry } from '../../types';

export interface SmartWipeResult {
  /** True only when the sensitive tables were actually cleared. */
  wiped: boolean;
  /**
   * Syncable PENDING/FAILED outbox entries that blocked the wipe. > 0 means
   * money data had not reached the cloud, so the local tables were LEFT INTACT.
   */
  pending: number;
}

/**
 * Tables CLEARED on sign-out — the sensitive business data. `products` is
 * deliberately ABSENT so an offline relaunch still lists the catalog.
 *
 * D1 (safety.md): `productCosting` is cleared too — it is margin data
 * (cost / weighted-average cost / supplier) and is re-pulled on the next sync.
 */
export const WIPE_CLEAR_TABLES = [
  'sales',
  'customers',
  'creditLedger',
  'dailySummaries',
  'stockLedger',
  'outbox',
  'quotaUsage',
  'users',
  'productCosting'
] as const;

/** Tables KEPT across a sign-out so the POS still boots offline. */
export const WIPE_KEEP_TABLES = ['products'] as const;

/**
 * Minimal ports so the wipe CORE is testable without the browser DB.
 * `smartWipeForLogout()` supplies the real PGlite-backed implementation.
 */
export interface SmartWipePorts {
  /** Best-effort drain of the outbox before wiping (a no-op when offline). */
  flush: () => Promise<void>;
  /** Syncable entries still PENDING/FAILED after the flush attempt. */
  countUnsynced: () => Promise<number>;
  /** Delete every row of one local table. */
  clearTable: (table: string) => Promise<void>;
  /** Forget the device sync cursor so the next login re-pulls from epoch. */
  resetSyncCursor: () => Promise<void>;
}

/**
 * The smart-wipe core (pure over its ports). Order matters:
 *   1. try to flush the outbox;
 *   2. if ANY syncable money data is still unsynced -> REFUSE (never lose it);
 *   3. otherwise clear the sensitive tables (keeping the catalog);
 *   4. reset the device cursor so the cleared history re-pulls next login.
 */
export async function runSmartWipe(
  ports: SmartWipePorts,
  clearTables: readonly string[] = WIPE_CLEAR_TABLES
): Promise<SmartWipeResult> {
  try {
    await ports.flush();
  } catch {
    /* offline / transient — the pending guard below is the real safety net */
  }
  const pending = await ports.countUnsynced();
  if (pending > 0) return { wiped: false, pending };
  for (const table of clearTables) await ports.clearTable(table);
  await ports.resetSyncCursor();
  return { wiped: true, pending: 0 };
}

/**
 * Mirrors `isCloudShopId()` in `lib/utils` (a real Supabase shop uuid). Inlined
 * to keep this module dependency-free so the Node rehearsal can import it — the
 * same reason `decide.ts` has no imports.
 */
const CLOUD_SHOP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when an outbox entry's payload belongs to a real (syncable) cloud shop.
 *
 * Used by the money-safety guard: only entries that COULD reach the cloud ever
 * block a wipe. Offline-demo entries (`shop_default`, non-uuid) can never sync
 * and must not wedge sign-out forever — clearing them is harmless.
 */
export function isSyncableOutbox(entry: Pick<OutboxEntry, 'payload'> | null | undefined): boolean {
  const shopId = (entry?.payload as { shopId?: unknown } | null | undefined)?.shopId;
  return typeof shopId === 'string' && CLOUD_SHOP_UUID.test(shopId);
}

/**
 * Smart wipe for a real sign-out. Flushes the outbox (needs the live auth
 * token), then wipes IF nothing syncable remains unsynced.
 *
 * The browser DB + sync worker are imported DYNAMICALLY on purpose: this module
 * must stay loadable by the Node rehearsal, and must not create a static import
 * cycle with the auth/sync stores (syncService imports authStore, and
 * authStore calls this on logout).
 */
export async function smartWipeForLogout(): Promise<SmartWipeResult> {
  const [{ db }, { flushOutbox }] = await Promise.all([
    import('../db'),
    import('../../services/syncService')
  ]);

  return runSmartWipe({
    flush: async () => {
      // force=true also retries FAILED entries so a retryable failure can clear
      // before sign-out; a still-unsynced result is caught by countUnsynced.
      await flushOutbox(true);
    },
    countUnsynced: async () => {
      const rows = await db.outbox.where('status').anyOf('PENDING', 'FAILED').toArray();
      return rows.filter(isSyncableOutbox).length;
    },
    clearTable: async (table) => {
      const t = (db as unknown as Record<string, { clear: () => Promise<void> }>)[table];
      if (t) await t.clear();
    },
    resetSyncCursor: async () => {
      // Single device-wide cursor (safety.md F5): deleting it makes the next
      // online login perform a FULL delta pull and rehydrate the cleared rows.
      await db.syncState.clear();
    }
  });
}
