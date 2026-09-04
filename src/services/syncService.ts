import { db, isOnline } from '../db';
import {
  getQueuedOutbox,
  getPendingOutbox,
  markOutboxStatus,
  removeOutboxEntry,
  setSyncCursor,
  getSyncCursor,
  bumpQuota,
  markSaleSynced
} from '../db/repos/outbox';
import { isRetryableError, errorMessage } from '../lib/idempotency';
import { isSupabaseConfigured } from '../config/env';
import { useSyncStore } from '../stores/syncStore';
import { useInventoryStore } from '../stores/inventoryStore';
import { useAuthStore, shopIdOf, canSeeCosting } from '../stores/authStore';
import { todayKey, isCloudShopId } from '../lib/utils';
import { autoBackfillProfit } from '../db/repos/summary';
import { buildCloudRows, upsertCloudRows, collapseDuplicates, pullCloudChanges, type PulledChange, type CloudRow } from './supabaseSync';

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
/** Pull re-entrancy guard: a single large drain now spans many paged requests
    (could exceed the 15s tick), so an overlapping pull must be skipped rather
    than started — it would double quota reads and cause redundant refreshes.
    Mirrors the `running` guard on flushOutbox. */
let pullRunning = false;

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
  // Batch 4: per-attempt attribution. Hoisted so the catch can distinguish
  // "wrote some rows, then failed" from "failed before writing" and never
  // mark a row FAILED that actually reached the cloud.
  let uniqRows: CloudRow[] = [];
  let mergedEntries: string[] = [];
  /** True once every uniqRow was accepted by the cloud — a later failure (if
      any) happened in LOCAL bookkeeping, so no row is a cloud failure. */
  let upsertDone = false;
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

    // Batch 3: never let ONE statement contain duplicate cloud `id`s. Pre-fix
    // offline refreshes left duplicate DAILY_SUMMARY/SALE rows in the outbox;
    // without collapse, a chunk containing both id-s of the same logical row
    // fails wholesale ("ON CONFLICT DO UPDATE command cannot affect row a
    // second time") → up to 100 entries all marked FAILED at once. Keep the
    // newest row per (table, id); remember the superseded outbox entries so
    // bookkeeping still clears them.
    const collapsed = collapseDuplicates(rows);
    uniqRows = collapsed.unique;
    mergedEntries = collapsed.merged;

    // Idempotent upsert keyed on the local id — retries can't double-submit.
    // Returns only the rows the cloud accepted (all on success; on a partial
    // failure the catch finishes bookkeeping for the accepted slice).
    const written = await upsertCloudRows(uniqRows);
    upsertDone = true;
    await bumpQuota('writes', written.length);

    // Post-flush bookkeeping — only the entries we actually wrote.
    for (const row of written) {
      if (row.entityType === 'SALE') {
        await markSaleSynced(row.id, row.entryId);
      } else {
        await removeOutboxEntry(row.entryId);
      }
    }
    // Superseded duplicates were never written — just clear them from the
    // outbox (their payload was the same logical row, already covered).
    for (const entryId of mergedEntries) {
      await removeOutboxEntry(entryId);
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
    // errorMessage(): Supabase throws plain objects (PostgrestError), not
    // Error instances — `String(err)` destroyed the real reason as
    // "[object Object]" and isRetryableError() saw garbage. Resolve the true
    // message first, then classify and persist it.
    const msg = errorMessage(err);
    const retryable = isRetryableError(err);

    // Batch 4: attribute per-attempt, never whole-batch. A single failing
    // chunk must not condemn the unrelated rows. Three distinct cases:
    //  1. Upsert failed partway -> `err.written` lists the rows the cloud DID
    //     accept. Finish their bookkeeping (they are synced, not failed) and
    //     classify ONLY the attempted-but-unwritten remainder.
    //  2. Failed before any writable row formed (buildCloudRows threw on a
    //     malformed VOID payload) -> uniqRows is empty. Classify the fetched
    //     cloud-shop entries by retryability; skip localOnly/demo ones (they
    //     can never sync — not cloud failures).
    //  3. Failed AFTER the upsert (a local bookkeeping step threw) -> every
    //     uniqRow already reached the cloud. Mark NOTHING FAILED leaving them
    //     PENDING so the next tick re-flushes idempotently and finishes
    //     cleanup. Marking them FAILED here would be a lie.
    if (!upsertDone) {
      const writtenIds = new Set(
        ((err as { written?: CloudRow[] | undefined }).written ?? []).map((r) => r.entryId)
      );
      // Finish bookkeeping for rows that DID land on the cloud.
      for (const row of uniqRows) {
        if (writtenIds.has(row.entryId)) {
          if (row.entityType === 'SALE') {
            await markSaleSynced(row.id, row.entryId);
          } else {
            await removeOutboxEntry(row.entryId);
          }
        }
      }
      const toClassify: Array<{ id: string }> =
        uniqRows.length === 0
          ? pending.filter((e) => {
              const shopId = (e.payload as { shopId?: unknown } | null)?.shopId;
              return isCloudShopId(typeof shopId === 'string' ? shopId : null);
            })
          : uniqRows.filter((r) => !writtenIds.has(r.entryId));
      for (const entry of toClassify) {
        if (retryable) {
          // Network-ish blip — keep PENDING so the next tick retries.
          await markOutboxStatus(entry.id, 'PENDING', msg);
        } else {
          // Permanent failure (validation / permissions / type) — stop auto-retry.
          await markOutboxStatus(entry.id, 'FAILED', msg);
        }
      }
    }
    // Superseded (merged) duplicates are cleared even on failure. The kept
    // (newest) row for the logical id is still in the outbox — never removed
    // on failure — so the duplicate copy must go, or the next PENDING-only
    // fetch would push the OLDER snapshot alone and overwrite the newest one.
    for (const entryId of mergedEntries) {
      await removeOutboxEntry(entryId);
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
  if (pullRunning) return; // already draining — skip the overlap
  if (!isSupabaseConfigured || !(await isOnline())) return;
  pullRunning = true; // set before the first await so overlapping ticks bail
  try {
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
    // Pull applied real rows -> refresh the UI-facing stores so newly synced
    // products appear IMMEDIATELY (POS grid + inventory list) instead of only
    // after the 30s low-stock tick. Placement is deliberate:
    //  - AFTER cursor stamping, so a UI refresh hiccup can never lose the
    //    watermark (monotonic progress is preserved).
    //  - Gated on applied.length > 0, so a quiet 15s tick with nothing new
    //    doesn't restart the products read every time.
    //  - Wrapped in try/catch, so a transient UI refresh failure cannot abort
    //    the pull (it retries store-side on the next tick or page mount).
    if (applied.length > 0) {
      try {
        await useInventoryStore.getState().refresh();
      } catch {
        // Cursor already advanced — non-fatal for the pull itself.
      }
      // AUTO-PROFIT (Problem #4): when a pull delivered a SALE/VOID row, sales
      // may just have arrived from cashier devices (profit-less, the common
      // 80%). A device with cost access (manager/admin) gap-fills profit onto
      // them so cashier sales show profit everywhere WITHOUT the manual button.
      //
      // Why this is safe at-scale and never a "global every-15s":
      //  - Gated on canSeeCosting -> cashier devices NEVER enter this block.
      //  - It only runs when a sale-related row was actually applied, not on
      //    product-only pulls or quiet ticks.
      //  - Internally idempotent (backfillSalesWindow skips already-enriched
      //    sales): after the first run the steady state is a read-only scan
      //    that writes/enqueues NOTHING, so cost-access devices at steady
      //    state are no-ops too.
      // Best-effort: a failure here must never abort or fail the pull — the
      // payload is already applied and the cursor already advanced; the next
      // pull/load retries the gap-fill.
      if (
        canSeeCosting(useAuthStore.getState().user?.role) &&
        applied.some((c) => c.entityType === 'SALE' || c.entityType === 'VOID')
      ) {
        try {
          // Recent 7-day window — covers the default Analytics range so the
          // numbers a manager sees with zero clicks are already enriched.
          const to = todayKey();
          const from = todayKey(new Date(Date.now() - 6 * 86_400_000));
          await autoBackfillProfit(shopIdOf(), from, to);
        } catch {
          // non-fatal — retried on the next pull/load
        }
      }
    }
    // A successful pull proves the cloud is reachable — clear any previously
    // surfaced pull error so a transient failure doesn't stick forever.
    useSyncStore.getState().clearError();
    await useSyncStore.getState().refresh();
  } catch (err) {
    // The pull FAILED (network / auth / RLS / quota) — surface it via the same
    // error slot push errors use (shown in Settings). Previously these were
    // swallowed by the caller's `.catch(() => undefined)`, so a failed pull
    // looked identical to a shop with no data. Recovery stays automatic:
    // we only record the message; the next 15s tick retries the pull and a
    // successful pull clears the error. (Fix #2.) errorMessage() so a
    // plain-object (PostgrestError) failure surfaces its real reason instead
    // of "[object Object]".
    const msg = errorMessage(err);
    useSyncStore.getState().markSyncError(msg);
    await useSyncStore.getState().refresh();
  } finally {
    pullRunning = false; // always reset — an error must not strand the guard
  }
}

/** Apply cloud rows locally; returns only the changes that were actually written. */
async function applyCloudChanges(changes: PulledChange[]): Promise<PulledChange[]> {
  const applied: PulledChange[] = [];

  // Strip sync-accounting metadata that must never be part of a canonical
  // local domain doc. buildCloudRows() injects `__idempotency_key` into the
  // cloud `data`, and VOID docs carry a `__void_of` wrapper — if these leak
  // back into local rows (or re-push), the stored document drifts away from the
  // real Sales/Product shape and every subsequent mirror pollutes itself.
  // (Finding 4.)
  const clean = (raw: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('__')) continue; // drop idempotency key + void wrapper
      out[k] = v;
    }
    return out;
  };

  // Newest version stamp carried by a canonical doc. Mirrors rowUpdatedAt()
  // in db.ts but omits lastAttemptAt (no outbox payload carries it): summaries
  // stamp with lastUpdatedAt, products/customers/costing with updatedAt, and
  // the rest with createdAt.
  const versionOf = (doc: Record<string, unknown>): number => {
    for (const k of ['updatedAt', 'lastUpdatedAt', 'createdAt']) {
      const v = doc[k];
      if (typeof v === 'number') return v;
    }
    return 0;
  };

  /** A pulled doc may never silently erase a newer local copy. Returns true
      when the row was fully handled (applied OR deliberately kept local), so
      the pull cursor still advances past it instead of re-pulling forever. */
  const keepLocalIfNotOlder = async (
    getLocal: (key: string) => Promise<unknown>,
    key: string,
    payload: Record<string, unknown>
  ): Promise<boolean> => {
    let local: unknown;
    try {
      local = await getLocal(key);
    } catch {
      local = undefined;
    }
    if (local === undefined || local === null) return false; // nothing local — apply the cloud row
    const localV = versionOf(local as Record<string, unknown>);
    const pulledV = versionOf(payload);
    if (localV > pulledV) return true; // local is genuinely newer — keep it
    if (localV === pulledV) {
      // Same stamp: the cloud copy is interchangeable EXCEPT it can never
      // carry this device's local-only enrichment (profit backfill). See the
      // SALE case for the merge. For pure doc tables an equal-stamp cloud row
      // is a byte-identical no-op — skip the write.
      return true;
    }
    return false; // cloud row is newer — apply it
  };

  for (const change of changes) {
    const raw = change.payload as Record<string, unknown> & { id?: string; productId?: string };
    // Costing docs are keyed by `productId`, everything else by `id`.
    if (!raw?.id && !raw?.productId) continue; // malformed row — leave above cursor for retry

    const payload = clean(raw);
    // VOID folds its `__void_of` marker into the canonical SALE `voidedBy`
    // reference (the local row already uses `voidedBy` for that link).
    if (change.entityType === 'VOID') {
      const vo = (raw.__void_of ?? {}) as { originalId?: unknown };
      if (vo?.originalId) payload.voidedBy = String(vo.originalId);
    }

    switch (change.entityType) {
      case 'PRODUCT': {
        const key = String(payload.id);
        if (await keepLocalIfNotOlder((k) => db.products.get(k), key, payload)) break;
        await db.products.put(payload as never);
        break;
      }
      case 'PRODUCT_COSTING': {
        const key = String(payload.productId);
        if (await keepLocalIfNotOlder((k) => db.productCosting.get(k), key, payload)) break;
        await db.productCosting.put(payload as never);
        break;
      }
      case 'SALE':
      case 'VOID': {
        const key = String(payload.id);
        const local = await db.sales.get(key).catch(() => undefined);
        if (local) {
          const localV = versionOf(local as unknown as Record<string, unknown>);
          const pulledV = versionOf(payload);
          if (localV > pulledV) break; // local (freshly backfilled/edited) wins
          if (localV === pulledV) {
            // Same stamp — the cloud copy is the same sale, but it was pushed
            // from a device that never ran a manager backfill, so it carries
            // NO profit. A plain put() would strip the profit THIS device
            // already computed locally (the "some devices show only profit,
            // some don't" bug). Fold the local-only enrichment back in, then
            // write the merged row so the cloud copy never destructively
            // overwrites it.
            if (local.profit !== undefined && payload.profit === undefined) {
              payload.profit = local.profit;
            }
            if (Array.isArray(payload.items) && local.items.length > 0) {
              const localCosts = new Map<string, number>();
              for (const it of local.items) {
                if (typeof it.costPriceAtSale === 'number') localCosts.set(it.productId, it.costPriceAtSale);
              }
              if (localCosts.size > 0) {
                for (const it of payload.items as Array<Record<string, unknown>>) {
                  const productId = it.productId;
                  if (typeof productId === 'string' && localCosts.has(productId) && it.costPriceAtSale === undefined) {
                    it.costPriceAtSale = localCosts.get(productId);
                  }
                }
              }
            }
          }
        }
        await db.sales.put(payload as never);
        break;
      }
      case 'RESTOCK':
        // Append-only movements with unique ids — a plain idempotent put.
        await db.stockLedger.put(payload as never);
        break;
      case 'DAILY_SUMMARY': {
        const key = String(payload.id);
        if (await keepLocalIfNotOlder((k) => db.dailySummaries.get(k), key, payload)) break;
        await db.dailySummaries.put(payload as never);
        break;
      }
      case 'CUSTOMER': {
        const key = String(payload.id);
        if (await keepLocalIfNotOlder((k) => db.customers.get(k), key, payload)) break;
        await db.customers.put(payload as never);
        break;
      }
      case 'CREDIT_LEDGER':
        // Append-only movements with unique ids — a plain idempotent put.
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