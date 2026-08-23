import { PGlite, type Transaction as PGliteTransaction } from '@electric-sql/pglite';
import type {
  Product, ProductCosting, Sale, StockLedgerEntry, DailySummary,
  Customer, CreditLedgerEntry, UserProfile, OutboxEntry, SyncState, QuotaUsage
} from '../types';

/**
 * AloraShop local database — PGlite (embedded Postgres in the browser).
 *
 * Single source of truth for the cashier — every read during a sale hits these
 * tables and never the network. The prior IndexedDB/Dexie backing store is
 * replaced by PGlite (Postgres running in WASM, persisted to the browser's
 * IndexedDB filesystem). Rows are stored as JSONB documents so the app keeps
 * using the same camelCase objects it always has.
 *
 * Every table carries:
 *   - id          (text PRIMARY KEY — the same key the row uses in-app)
 *   - shop_id     (text, for shaped Electric sync scoping)
 *   - updated_at  (bigint, newest row timestamp — delta-sync key per table)
 *   - data        (jsonb — the full camelCase row document)
 */

const TABLE_KEYS: Record<string, string> = {
  products: 'id',
  productCosting: 'productId',
  sales: 'id',
  stockLedger: 'id',
  dailySummaries: 'id',
  customers: 'id',
  creditLedger: 'id',
  users: 'uid',
  outbox: 'id',
  syncState: 'id',
  quotaUsage: 'date'
};

/** A uniform row of the DB (JSONB docs). */
type DbRow = Record<string, any>;

/** Maps each stored table to its row type (mirrors the old typed Dexie surface). */
type RowMap = {
  products: Product;
  productCosting: ProductCosting;
  sales: Sale;
  stockLedger: StockLedgerEntry;
  dailySummaries: DailySummary;
  customers: Customer;
  creditLedger: CreditLedgerEntry;
  users: UserProfile;
  outbox: OutboxEntry;
  syncState: SyncState;
  quotaUsage: QuotaUsage;
};

/** Shape of the exported `db` — every table + the atomic transaction helper. */
type AloraDb = { [K in keyof RowMap]: Table<RowMap[K]> } & {
  transaction(...args: any[]): Promise<any>;
};

let pglite: PGlite | null = null;
let schemaReady = false;
let activeTx: PGliteTransaction | null = null;

/** Lazily open embedded Postgres and create tables once. */
async function conn(): Promise<PGlite> {
  if (!pglite) {
    pglite = new PGlite('idb://alorashop');
    await pglite.waitReady;
  }
  if (!schemaReady) {
    for (const name of Object.keys(TABLE_KEYS)) {
      await pglite.exec(
        `CREATE TABLE IF NOT EXISTS ${name} (` +
          `id TEXT PRIMARY KEY, shop_id TEXT, updated_at BIGINT, data JSONB);`
      );
    }
    schemaReady = true;
  }
  return pglite;
}

/** Active transaction when present, else the base connection. */
function handle(): PGlite | PGliteTransaction {
  return activeTx ?? pglite!;
}

/** Newest timestamp on a row — feeds the `updated_at` column for delta sync. */
function rowUpdatedAt(row: Record<string, unknown>): number {
  for (const key of ['updatedAt', 'lastUpdatedAt', 'createdAt', 'lastAttemptAt']) {
    const v = row[key];
    if (typeof v === 'number') return v;
  }
  return Date.now();
}

/** JSONB may come back as an object or a JSON string — normalize to an object. */
function parseRow(v: unknown): any {
  if (typeof v === 'string') return JSON.parse(v);
  return v;
}

function quoteKey(key: string): string {
  return `'${key.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function pkCondition(pk: string): string {
  return `data->>${quoteKey(pk)} = $1`;
}

class Query<Row extends DbRow = DbRow> {
  constructor(
    private readonly table: Table<Row>,
    private readonly column: string,
    private readonly op: '=' | 'IN',
    private readonly value: any,
    private readonly filters: Array<(row: Row) => boolean> = []
  ) {}

  and(pred: (row: Row) => boolean): Query<Row> {
    return new Query(this.table, this.column, this.op, this.value, [...this.filters, pred]);
  }

  filter(pred: (row: Row) => boolean): Query<Row> {
    return this.and(pred);
  }

  private async rows(): Promise<Row[]> {
    await conn();
    const key = `data->>${quoteKey(this.column)}`;
    let out: Row[];
    if (this.op === 'IN') {
      const values = Array.isArray(this.value) ? this.value : [this.value];
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const res = await handle().query<DbRow>(
        `SELECT data FROM ${this.table.name} WHERE ${key} IN (${placeholders})`,
        values.map((v) => String(v))
      );
      out = res.rows.map((r) => parseRow(r.data) as Row);
    } else {
      const res = await handle().query<DbRow>(
        `SELECT data FROM ${this.table.name} WHERE ${key} = $1`,
        [String(this.value)]
      );
      out = res.rows.map((r) => parseRow(r.data) as Row);
    }
    for (const pred of this.filters) out = out.filter(pred);
    return out;
  }

  async toArray(): Promise<Row[]> {
    return this.rows();
  }

  async first(): Promise<Row | undefined> {
    return (await this.rows())[0];
  }

  async count(): Promise<number> {
    return (await this.rows()).length;
  }

  async delete(): Promise<void> {
    for (const row of await this.rows()) {
      await this.table.delete(row[this.table.pk]);
    }
  }
}

class WhereClause<Row extends DbRow = DbRow> {
  constructor(private readonly table: Table<Row>, readonly column: string) {}

  equals(value: any): Query<Row> {
    return new Query(this.table, this.column, '=', value);
  }

  anyOf(...values: any[]): Query<Row> {
    return new Query(this.table, this.column, 'IN', values);
  }
}

class Table<Row extends DbRow> {
  constructor(readonly name: string, readonly pk: keyof Row & string) {}

  async get(key: string): Promise<Row | undefined> {
    await conn();
    const res = await handle().query<DbRow>(
      `SELECT data FROM ${this.name} WHERE ${pkCondition(this.pk)}`,
      [String(key)]
    );
    return res.rows[0] ? (parseRow(res.rows[0].data) as Row) : undefined;
  }

  async put(value: Row): Promise<void> {
    await conn();
    await handle().query(
      `INSERT INTO ${this.name} (id, shop_id, updated_at, data) ` +
        `VALUES ($1, $2, $3, $4) ` +
        `ON CONFLICT (id) DO UPDATE SET ` +
        `shop_id = excluded.shop_id, updated_at = excluded.updated_at, data = excluded.data`,
      [String((value as DbRow)[this.pk]), (value as DbRow).shopId ?? null, rowUpdatedAt(value as DbRow), value]
    );
  }

  async add(value: Row): Promise<void> {
    await conn();
    await handle().query(
      `INSERT INTO ${this.name} (id, shop_id, updated_at, data) VALUES ($1, $2, $3, $4)`,
      [String((value as DbRow)[this.pk]), (value as DbRow).shopId ?? null, rowUpdatedAt(value as DbRow), value]
    );
  }

  async delete(key: string): Promise<void> {
    await conn();
    await handle().query(`DELETE FROM ${this.name} WHERE id = $1`, [String(key)]);
  }

  async clear(): Promise<void> {
    await conn();
    await handle().query(`DELETE FROM ${this.name}`, []);
  }

  async count(): Promise<number> {
    await conn();
    return (await handle().query(`SELECT id FROM ${this.name}`, [])).rows.length;
  }

  async toArray(): Promise<Row[]> {
    await conn();
    const res = await handle().query<DbRow>(`SELECT data FROM ${this.name}`, []);
    return res.rows.map((r) => parseRow(r.data) as Row);
  }

  async bulkPut(values: Row[]): Promise<void> {
    for (const v of values) await this.put(v);
  }

  where(column: string): WhereClause<Row> {
    return new WhereClause(this, column);
  }
}

function makeTables(): AloraDb {
  const out: Record<string, Table<any>> = {};
  for (const name of Object.keys(TABLE_KEYS)) out[name] = new Table<any>(name, TABLE_KEYS[name]);
  return out as unknown as AloraDb;
}

/** Public handle mirroring the old Dexie `db` surface (signatures unchanged). */
export const db: AloraDb = {
  ...makeTables(),

  /**
   * Atomic multi-write. Mirrors the old Dexie `transaction('rw', [...], cb)`
   * shape — the mode + table list are accepted (and ignored) for compatibility;
   * everything inside the callback shares one Postgres transaction so a failure
   * rolls the whole group back.
   */
  async transaction(...args: any[]): Promise<any> {
    const cb = args[args.length - 1] as () => Promise<any>;
    await conn();
    if (activeTx) return await cb(); // nested call — reuse the live transaction
    return await pglite!.transaction(async (tx) => {
      activeTx = tx;
      try {
        return await cb();
      } finally {
        activeTx = null;
      }
    });
  }
};

export async function isOnline(): Promise<boolean> {
  return typeof navigator !== 'undefined' && navigator.onLine;
}

export function onOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}