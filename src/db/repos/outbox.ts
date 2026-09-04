
import { db } from '../db';
import { isCloudShopId, uid } from '../../lib/utils';
import type { OutboxEntry, OutboxStatus, DailySummary, StockLedgerEntry, Sale } from '../../types';

const DEVICE_KEY = 'alorashop_device_id';

/**
 * Stable per-install device id. Each device owns its own sync cursor row, so a
 * fast-clock device can never mask a slow-clock device's watermark. Stored in
 * localStorage so it survives reloads but is unique per browser/PWA install.
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'device_shared'; // storage unavailable — single fallback identity
  }
}

/** Outbox — the durability backbone. Never blocks a sale. */

/**
 * Entries that should be auto-retried by the background worker: PENDING only.
 * Permanent failures (non-retryable) are left alone until an explicit retry.
 */
export async function getQueuedOutbox(limit = 60): Promise<OutboxEntry[]> {
  return db.outbox
    .where('status')
    .equals('PENDING')
    .toArray()
    .then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit));
}

/** Everything the worker may act on when forced (manual "retry failed"). */
export async function getPendingOutbox(limit = 60): Promise<OutboxEntry[]> {
  return db.outbox
    .where('status')
    .anyOf('PENDING', 'FAILED')
    .toArray()
    .then((rows) => rows.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit));
}

/** Raw snapshot for honest badge counts (PENDING + FAILED, with payloads). */
export async function getOutboxSnapshot(): Promise<OutboxEntry[]> {
  return db.outbox.where('status').anyOf('PENDING', 'FAILED').toArray();
}

export async function markOutboxStatus(id: string, status: OutboxStatus, error?: string): Promise<void> {
  const entry = await db.outbox.get(id);
  if (!entry) return;
  await db.outbox.put({
    ...entry,
    status,
    retryCount: status === 'FAILED' ? entry.retryCount + 1 : entry.retryCount,
    lastAttemptAt: Date.now(),
    error
  });
}

export async function removeOutboxEntry(id: string): Promise<void> {
  await db.outbox.delete(id);
}

export async function outboxCount(): Promise<number> {
  return db.outbox.where('status').anyOf('PENDING', 'FAILED').count();
}

/**
 * Honest breakdown for the status pill.
 *
 * - `pending`  — PENDING entries that CAN sync (payload carries a real cloud
 *                shop uuid). This is the true "queued to sync" number.
 * - `failed`   — FAILED entries that can sync but are stuck (validation,
 *                permissions, type errors). Shown separately from queued.
 * - `localOnly`— entries whose payload belongs to no real cloud shop (the
 *                offline demo shop `shop_default`). They can NEVER sync and
 *                are excluded from "queued" so the badge stops lying.
 */
export async function outboxBreakdown(): Promise<{ pending: number; failed: number; localOnly: number }> {
  const all = await getOutboxSnapshot();
  let pending = 0;
  let failed = 0;
  let localOnly = 0;
  for (const e of all) {
    const shopId = (e.payload as { shopId?: unknown } | null)?.shopId;
    if (!isCloudShopId(typeof shopId === 'string' ? shopId : null)) {
      localOnly++;
    } else if (e.status === 'PENDING') {
      pending++;
    } else {
      failed++;
    }
  }
  return { pending, failed, localOnly };
}

/**
 * Removes outbox entries that belong to no real cloud shop (offline demo).
 * Explicit user action — local data rows are untouched, only the pending-sync
 * marker for entries that could never be pushed is deleted.
 */
export async function purgeLocalOnlyOutbox(): Promise<number> {
  const all = await getOutboxSnapshot();
  let n = 0;
  for (const e of all) {
    const shopId = (e.payload as { shopId?: unknown } | null)?.shopId;
    if (!isCloudShopId(typeof shopId === 'string' ? shopId : null)) {
      await db.outbox.delete(e.id);
      n++;
    }
  }
  return n;
}

export async function getSyncCursor(): Promise<number> {
  const state = await db.syncState.get(getDeviceId());
  return state?.lastSyncCursor ?? 0;
}

export async function setSyncCursor(cursor: number): Promise<void> {
  await db.syncState.put({ id: getDeviceId(), lastSyncCursor: cursor, lastSyncedAt: Date.now() });
}

/** After a successful flush we flip local rows to synced. */
export async function markSaleSynced(saleId: string, outboxId: string): Promise<void> {
  await db.transaction('rw', db.sales, db.outbox, async () => {
    const sale = await db.sales.get(saleId);
    if (sale) await db.sales.put({ ...sale, syncedToCloud: true, outboxId });
    await db.outbox.delete(outboxId);
  });
}

/**
 * Enqueue a daily-summary doc to the cloud mirror.
 *
 * Daily summaries are the ONLY thing a fresh device pulls to bootstrap
 * dashboards/analytics without scanning raw sales — but no code path was
 * enqueuing them, so `daily_summaries` never reached the cloud and every
 * fresh-install dashboard came up empty. (Finding 2.) Call this after every
 * local summary write (sale increment, void reversal, profit backfill).
 *
 * Demo shop (non-uuid) has no cloud account — skip like every other entity.
 */
export async function enqueueDailySummary(summary: DailySummary): Promise<void> {
  if (!summary || !isCloudShopId(summary.shopId)) return;
  // Replace any still-queued DAILY_SUMMARY entry for this (shop, date) —
  // the outbox must never hold two rows whose payloads map to the same cloud
  // `id`. enqueueSale already dedupes; this one did NOT, so every offline
  // Analytics Refresh (autoBackfillProfit → enqueueDailySummary) appended yet
  // another PENDING row with the same summary.id — and a single flush batch
  // could then contain both `id`s in one upsert chunk, which Postgres rejects
  // wholesale ("ON CONFLICT DO UPDATE command cannot affect row a second
  // time") → the whole batch failed → "multiple sync errors". A fresh summary
  // supersedes any still-queued copy for the day.
  const pending = await db.outbox
    .where('status')
    .equals('PENDING')
    .and((e) => e.entityType === 'DAILY_SUMMARY')
    .toArray();
  for (const e of pending) {
    const p = (e.payload ?? {}) as { id?: unknown };
    if (p.id === summary.id) {
      await db.outbox.delete(e.id);
    }
  }
  await db.outbox.add({
    id: uid(),
    idempotencyKey: `daily_summary_${summary.id}`,
    entityType: 'DAILY_SUMMARY',
    payload: summary,
    status: 'PENDING',
    retryCount: 0,
    createdAt: Date.now()
  });
}

/**
 * Enqueue (or re-enqueue) a sale to the cloud mirror.
 *
 * SALE rows are keyed on the sale id and upserted ON CONFLICT (id), so a
 * re-enqueue of the SAME sale simply updates the cloud row. This is the
 * propagation path for a manager profit backfill: the originally-flushed row
 * carried no profit (cashiers push selling-price snapshots only), so after
 * attaching costPriceAtSale/profit locally we re-enqueue the enriched row with
 * a NEWER `updatedAt`; `supabaseSync` stamps the cloud `updated_at` with that,
 * which advances the watermark past every device's cursor so their delta pull
 * re-delivers the row and the profit converges. (Problem #3.)
 *
 * If a PENDING entry for this sale is still queued (the sale never flushed), it
 * is REPLACED rather than duplicated — a stale profit-less payload must never
 * overwrite the enriched row after the fact.
 *
 * Demo shop (non-uuid) has no cloud account — skip like every other entity.
 */
export async function enqueueSale(sale: Sale): Promise<void> {
  if (!sale || !isCloudShopId(sale.shopId)) return;
  // Replace any still-queued SALE entry for this id (dedupe, never twice).
  const pending = await db.outbox.where('status').equals('PENDING').toArray();
  for (const e of pending) {
    const p = (e.payload ?? {}) as { id?: unknown };
    if (e.entityType === 'SALE' && p.id === sale.id) {
      await db.outbox.delete(e.id);
    }
  }
  await db.outbox.add({
    id: uid(),
    idempotencyKey: `sale_update_${sale.id}_${Date.now()}`,
    entityType: 'SALE',
    payload: sale,
    status: 'PENDING',
    retryCount: 0,
    createdAt: Date.now()
  });
}

/**
 * Enqueue a stock-ledger movement to the cloud mirror.
 *
 * Stock-ledger is append-only (the only source a fresh device can rebuild the
 * audit trail from) — but only explicit restocks were being enqueued, so SALE
 * and VOID movements (and a product's opening RESTOCK row) never reached the
 * cloud. (Finding 3.) Call this after every local ledger write.
 *
 * Demo shop (non-uuid) has no cloud account — skip like every other entity.
 */
export async function enqueueStockLedger(entry: StockLedgerEntry): Promise<void> {
  if (!entry || !isCloudShopId(entry.shopId)) return;
  await db.outbox.add({
    id: uid(),
    idempotencyKey: `stock_ledger_${entry.id}`,
    entityType: 'RESTOCK', // all stock_ledger rows sync through this entity
    payload: entry,
    status: 'PENDING',
    retryCount: 0,
    createdAt: Date.now()
  });
}

/** Local quota guardrail counter — warns before hitting Spark caps. */
export async function bumpQuota(kind: 'reads' | 'writes' | 'deletes', n = 1): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const row = (await db.quotaUsage.get(date)) ?? { date, reads: 0, writes: 0, deletes: 0 };
  row[kind] += n;
  await db.quotaUsage.put(row);
}

export async function getTodayQuota() {
  const date = new Date().toISOString().slice(0, 10);
  const row = (await db.quotaUsage.get(date)) ?? { date, reads: 0, writes: 0, deletes: 0 };
  return row;
}