import { db, isOnline } from '../db';
import { getQueuedOutbox, getPendingOutbox, markOutboxStatus, removeOutboxEntry, setSyncCursor, getSyncCursor, bumpQuota, markSaleSynced} from '../db/repos/outbox';
import { isRetryableError } from '../lib/idempotency';
import { isSupabaseConfigured } from '../config/env';
import { useSyncStore } from '../stores/syncStore';
import { buildCloudRows, upsertCloudRows, pullCloudChanges, type PulledChange } from './supabaseSync';

/**
 * Background sync worker.
 *
 * - Flushes the IndexedDB outbox to Supabase in BATCHED upserts (many rows per
 *   request). Rows keep their local `id` and are upserted ON CONFLICT (id), so
 *   retries reuse the same row and can never double-submit.
 * - Delta-pulls only rows newer than the device cursor (epoch ms — matches the
 *   cloud `updated_at` bigint column exactly).
 * - Never blocks or slows checkout: if offline, entries simply stay queued.
 */
let running = false;

export async function flushOutbox(force = false): Promise<number> {
  if (running && !force) return 0;
  if (!isSupabaseConfigured) {
    // Supabase not configured: keep the outbox durable but mark nothing synced.
    // The app remains fully functional offline (local DB is the source of truth).
    await useSyncStore.getState().refresh();
    return 0;
  }
  if (!(await isOnline())) {
    useSyncStore.getState().setOnline(false);
    return 0;
  }
  useSyncStore.getState().setOnline(true);

  running = true;
  useSyncStore.getState().setSyncing(true);
  // Hoisted so the catch can mark exactly the entries we attempted.
  let pending: Awaited<ReturnType<typeof getQueuedOutbox>> = [];
  try {
    // force = manual retry also picks up FAILED entries; background ticks only
    // auto-retry PENDING ones so a permanent error stops thrashing the cloud.
    pending = force ? await getPendingOutbox(60) : await getQueuedOutbox(60);
    if (pending.length === 0) {
      useSyncStore.getState().markSynced();
      return 0;
    }

    // Map pending entries to cloud rows. Rows that belong to the offline demo
    // shop (non-uuid shopId) are skipped — there is no cloud account for them.
    const rows = buildCloudRows(pending);
    if (rows.length === 0) {
      // Nothing writable (e.g. all demo data) — keep the queue honest.
      await useSyncStore.getState().refresh();
      return 0;
    }

    // Idempotent upsert keyed on the local id — retries can't double-submit.
    await upsertCloudRows(rows);
    await bumpQuota('writes', rows.length);

    // Post-flush bookkeeping — only the entries we actually wrote.
    for (const row of rows) {
      if (row.entityType === 'SALE') {
        await markSaleSynced(row.id, row.entryId);
      } else {
        await removeOutboxEntry(row.entryId);
      }
    }

    // Push must NOT advance the delta watermark. A push says nothing about what
    // has been pulled/applied, and stamping the cursor with the local clock
    // would let a fast-clock device jump the watermark past rows another
    // device (slow clock) had not pulled yet. The cursor advances only from
    // applied pulls (see pullDelta).
    await useSyncStore.getState().refresh();
    return pending.length;
  } catch (err) {
    // The error is REAL — surface it instead of silently retrying forever.
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = isRetryableError(msg);
    // Only mark the entries we actually attempted, not a fresh fetch.
    for (const entry of pending) {
      if (retryable) {
        // Network-ish blip — keep PENDING so the next tick retries.
        await markOutboxStatus(entry.id, 'PENDING', msg);
      } else {
        // Permanent failure (validation / permissions / type) — stop auto-retry.
        await markOutboxStatus(entry.id, 'FAILED', msg);
      }
    }
    useSyncStore.getState().markSyncError(msg);
    await useSyncStore.getState().refresh();
    return 0;
  } finally {
    running = false;
    useSyncStore.getState().setSyncing(false);
  }
}

/** Delta sync: pull only rows changed since the device cursor. */
export async function pullDelta(): Promise<void> {
  if (!isSupabaseConfigured || !(await isOnline())) return;
  const cursor = await getSyncCursor();
  const changes = await pullCloudChanges(cursor);
  const applied = await applyCloudChanges(changes);
  // Cursor = the newest cloud updated_at we ACTUALLY applied in this pull,
  // never the local wall clock. Rows we could not apply (missing id / unknown
  // type) stay above the cursor so the next pull retries them instead of
  // silently skipping them. Monotonic: never moves backwards.
  const newest = applied.reduce((m, c) => Math.max(m, c.updatedAt), cursor);
  await setSyncCursor(newest);
  await bumpQuota('reads', Math.max(1, changes.length));
  await useSyncStore.getState().refresh();
}

/** Apply cloud rows locally; returns only the changes that were actually written. */
async function applyCloudChanges(changes: PulledChange[]): Promise<PulledChange[]> {
  const applied: PulledChange[] = [];
  for (const change of changes) {
    const payload = change.payload as Record<string, unknown> & { id?: string };
    if (!payload?.id) continue; // malformed row — leave above cursor for retry
    switch (change.entityType) {
      case 'PRODUCT':
        await db.products.put(payload as never);
        break;
      case 'SALE':
      case 'VOID':
        await db.sales.put(payload as never);
        break;
      case 'RESTOCK':
        await db.stockLedger.put(payload as never);
        break;
      case 'DAILY_SUMMARY':
        await db.dailySummaries.put(payload as never);
        break;
      case 'CUSTOMER':
        await db.customers.put(payload as never);
        break;
      case 'CREDIT_LEDGER':
        await db.creditLedger.put(payload as never);
        break;
      default:
        continue; // unknown entity — leave above cursor for retry
    }
    applied.push(change);
  }
  return applied;
}

let syncTimer: ReturnType<typeof setInterval> | undefined;

/** Start the background sync loop (browser reload-safe; outbox is durable). */
export function startSyncLoop(intervalMs = 15_000): () => void {
  void flushOutbox();
  void pullDelta();
  syncTimer = setInterval(() => {
    void flushOutbox().catch(() => undefined);
    void pullDelta().catch(() => undefined);
  }, intervalMs);
  const onOnlineHandler = () => {
    useSyncStore.getState().setOnline(true);
    void flushOutbox().catch(() => undefined);
    void pullDelta().catch(() => undefined);
  };
  window.addEventListener('online', onOnlineHandler);
  window.addEventListener('offline', () => useSyncStore.getState().setOnline(false));
  return () => {
    if (syncTimer) clearInterval(syncTimer);
    window.removeEventListener('online', onOnlineHandler);
  };
}