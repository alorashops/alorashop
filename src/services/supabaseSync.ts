import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseUrl, supabaseAnonKey, isSupabaseConfigured } from '../config/env';
import type { OutboxEntry } from '../types';

/**
 * Supabase data mirror — the cloud side of the offline-first outbox.
 *
 * Design (matches the Supabase migration `0002_domain_tables.sql`):
 *  - One row per local document, keyed by the SAME `id` the device generates.
 *    Upserting on `id` conflict is therefore naturally idempotent — retries
 *    can never double-submit, no separate idempotency table needed.
 *  - `shop_id` is the owning shop's uuid; RLS makes sure a client can only
 *    ever touch its own shop's rows (current_shop_id()).
 *  - `updated_at` is epoch ms, so the delta pull compares against the same
 *    JS cursor the device already uses (fixes the old Firestore mismatch).
 *  - The cloud is an append-only mirror: no delete grants in the migration.
 */

export type CloudEntity =
  | 'SALE'
  | 'VOID'
  | 'PRODUCT'
  | 'PRODUCT_COSTING'
  | 'RESTOCK'
  | 'CUSTOMER'
  | 'CREDIT_LEDGER'
  | 'DAILY_SUMMARY';

/** A pending outbox entry mapped to a row ready for upsert. */
export interface CloudRow {
  /** The outbox entry id — used for bookkeeping after a successful flush. */
  entryId: string;
  entityType: CloudEntity;
  table: string;
  id: string;
  shopId: string; // uuid (text)
  updatedAt: number; // epoch ms
  data: Record<string, unknown>;
}

/** A doc pulled from the cloud, ready to be applied locally. */
export interface PulledChange {
  entityType: CloudEntity;
  payload: Record<string, unknown>;
  /** The cloud-side `updated_at` (epoch ms) — the server watermark of this row. */
  updatedAt: number;
}

export type { CloudEntity as CloudEntityType };

const ENTITY_MAP: Record<CloudEntity, { table: string; data: (p: any) => Record<string, unknown>; ts: (p: any) => number }> = {
  SALE: {
    table: 'sales',
    ts: (p) => p.createdAt,
    data: (p) => p
  },
  VOID: {
    table: 'sales',
    ts: (p) => p.reversal.createdAt,
    data: (p) => ({ ...p.reversal, __void_of: { originalId: p.originalId ?? null, reason: p.reason ?? null } })
  },
  PRODUCT: {
    table: 'products',
    ts: (p) => p.updatedAt,
    data: (p) => p
  },
  PRODUCT_COSTING: {
    table: 'product_costing',
    ts: (p) => p.updatedAt,
    data: (p) => p
  },
  RESTOCK: {
    table: 'stock_ledger',
    ts: (p) => p.createdAt,
    data: (p) => p
  },
  CREDIT_LEDGER: {
    table: 'credit_ledger',
    ts: (p) => p.createdAt,
    data: (p) => p
  },
  CUSTOMER: {
    table: 'customers',
    ts: (p) => p.updatedAt ?? p.createdAt,
    data: (p) => p
  },
  DAILY_SUMMARY: {
    table: 'daily_summaries',
    ts: (p) => p.lastUpdatedAt,
    data: (p) => p
  }
};

const PULL_TABLES: Array<{ table: string; entity: CloudEntity }> = [
  { table: 'products', entity: 'PRODUCT' },
  { table: 'product_costing', entity: 'PRODUCT_COSTING' },
  { table: 'sales', entity: 'SALE' },
  { table: 'stock_ledger', entity: 'RESTOCK' },
  { table: 'daily_summaries', entity: 'DAILY_SUMMARY' },
  { table: 'customers', entity: 'CUSTOMER' },
  { table: 'credit_ledger', entity: 'CREDIT_LEDGER' }
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let client: SupabaseClient | undefined;

function getClient(): SupabaseClient {
  if (!isSupabaseConfigured) throw new Error('Supabase is not configured');
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }
  return client;
}

/**
 * Map pending outbox entries into upsertable cloud rows.
 *
 * Entries whose shop is NOT a real Supabase shop uuid (e.g. the offline demo
 * shop "shop_default") are skipped — there is no cloud account for them, and
 * attempting to write would 22P02-crash the whole batch.
 */
export function buildCloudRows(entries: OutboxEntry[]): CloudRow[] {
  const rows: CloudRow[] = [];
  for (const entry of entries) {
    const map = ENTITY_MAP[entry.entityType as CloudEntity];
    const payload = (entry.payload ?? {}) as Record<string, any>;
    if (!map || !payload.shopId) continue;
    const shopId = String(payload.shopId);
    if (!UUID_RE.test(shopId)) continue;

    const data = map.data(payload);
    // Most entities key their mirror row on `id`; ProductCosting keys on
    // `productId` (migration 0003: id = the local ProductCosting.productId).
    const rowId = data?.id ?? data?.productId;
    if (!rowId) continue;

    rows.push({
      entryId: entry.id,
      entityType: entry.entityType as CloudEntity,
      table: map.table,
      id: String(rowId),
      shopId,
      updatedAt:
        typeof map.ts(payload) === 'number' ? (map.ts(payload) as number) : Date.now(),
      data: { ...data, __idempotency_key: entry.idempotencyKey }
    });
  }
  return rows;
}

/** Upsert cloud rows in per-table batches of 100 (idempotent on `id`). */
export async function upsertCloudRows(rows: CloudRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sb = getClient();
  const grouped = new Map<string, CloudRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.table) ?? [];
    list.push(r);
    grouped.set(r.table, list);
  }
  for (const [table, list] of grouped) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100).map((r) => ({
        id: r.id,
        shop_id: r.shopId,
        updated_at: r.updatedAt,
        data: r.data
      }));
      const { error } = await sb.from(table).upsert(chunk, { onConflict: 'id' });
      if (error) throw error;
    }
  }
}

/**
 * Delta pull — every row in every sync table newer than the cursor.
 *
 * Cursor 0 is a fresh device: there is no watermark yet, so we pull the whole
 * shop (gt 0 = every row) once and let the caller stamp the max applied value.
 */
export async function pullCloudChanges(cursor: number): Promise<PulledChange[]> {
  const sb = getClient();
  const changes: PulledChange[] = [];
  for (const t of PULL_TABLES) {
    const { data, error } = await sb
      .from(t.table)
      .select('data, updated_at')
      .gt('updated_at', cursor)
      .order('updated_at', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      const payload = row?.data;
      // Accept both `id`-keyed docs and productId-keyed costing docs.
      const hasKey =
        payload && typeof payload === 'object' &&
        ((payload as { id?: unknown }).id ?? (payload as { productId?: unknown }).productId) != null;
      if (hasKey) {
        changes.push({
          entityType: t.entity,
          payload: payload as Record<string, unknown>,
          // Supabase may hand back bigint as number or string — coerce to number.
          updatedAt: Number(row?.updated_at ?? 0)
        });
      }
    }
  }
  return changes;
}