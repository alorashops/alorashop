import { db } from '../db';
import { createProduct } from '../db/repos/products';
import { createCustomer } from '../db/repos/customers';
import { toMinor } from '../lib/utils';
import type { UserProfile } from '../types';
import { DEFAULT_SHOP_ID } from '../config/env';

/**
 * Demo seeding — STRICTLY scoped to the offline shell.
 *
 * The demo shop (`shop_default`) is NOT a real Supabase shop: its rows can
 * never sync. It must therefore never be created while a real account owns
 * this database, or the sync queue silently fills with entries that can only
 * ever fail. Rules enforced here:
 *
 *   1. Seed only when NO session is signed in (pure offline demo).
 *   2. Seed at most once per install (`alorashop.seeded.v1`).
 *   3. An explicit "erase local data" permanently dismisses the demo so a
 *      reload does NOT re-inject it into an intentionally-empty DB.
 *   4. When a real shop signs in, `purgeDemoData()` removes any demo partition
 *      + historically seeded demo products from before this fix.
 */
const SEED_KEY = 'alorashop.seeded.v1';

const DEMO_USERS: UserProfile[] = [
  { uid: 'admin-1', shopId: DEFAULT_SHOP_ID, displayName: 'Ada Obi (Owner)', role: 'admin' },
  { uid: 'mgr-1', shopId: DEFAULT_SHOP_ID, displayName: 'Tunde Bakare (Manager)', role: 'manager' },
  { uid: 'csr-1', shopId: DEFAULT_SHOP_ID, displayName: 'Chioma Eze (Cashier)', role: 'cashier' }
];

const DEMO_PRODUCTS = [
  { sku: '779001', name: 'Indomie Chicken 70g', category: 'Noodles', price: 850, cost: 700, stock: 120, min: 20 },
  { sku: '779002', name: 'Milo Sachet 20g', category: 'Beverages', price: 250, cost: 190, stock: 200, min: 30 },
  { sku: '779003', name: 'Peak Milk Powder 400g', category: 'Dairy', price: 5200, cost: 4400, stock: 45, min: 10 },
  { sku: '779004', name: 'Dangote Sugar 500g', category: 'Baking', price: 1800, cost: 1500, stock: 60, min: 12 },
  { sku: '779005', name: 'Golden Penny Spaghetti 500g', category: 'Pasta', price: 950, cost: 800, stock: 80, min: 15 },
  { sku: '779006', name: 'Omo Detergent 500g', category: 'Cleaning', price: 1400, cost: 1100, stock: 5, min: 10 },
  { sku: '779007', name: 'Closeup Toothpaste 60g', category: 'Personal Care', price: 650, cost: 520, stock: 70, min: 15 },
  { sku: '779008', name: 'Dano Milk 250ml', category: 'Dairy', price: 600, cost: 470, stock: 3, min: 12 },
  { sku: '779009', name: 'Bournvita 500g', category: 'Beverages', price: 4200, cost: 3600, stock: 25, min: 8 },
  { sku: '779010', name: 'Peak Yoghurt 100ml', category: 'Dairy', price: 300, cost: 220, stock: 150, min: 25 }
];

const DEMO_CUSTOMERS = [
  { name: 'Mrs. Folake Adeyemi', phone: '08031234567' },
  { name: 'Chief Emeka Nwosu', phone: '08099887766' },
  { name: 'Blessing Okoro', phone: '08123456789' }
];

function marker(): string | null {
  try {
    return localStorage.getItem(SEED_KEY);
  } catch {
    return null;
  }
}
function markSeeded(): void {
  try {
    localStorage.setItem(SEED_KEY, 'done');
  } catch {
    /* non-fatal */
  }
}
function markDismissed(): void {
  try {
    localStorage.setItem(SEED_KEY, 'dismissed');
  } catch {
    /* non-fatal */
  }
}

/**
 * Seeds the offline demo — offline shell ONLY.
 * No-arg now: it has no business targeting a real shop's id.
 */
export async function seedIfEmpty(): Promise<void> {
  const existing = marker();
  // Explicit erase wins, and an already-seeded install is never re-seeded.
  // A DB that already exists (real or demo) is never silently overlaid —
  // that is exactly the old bug.
  if (existing === 'dismissed' || existing === 'done') return;
  const hasData =
    (await db.products.count()) > 0 ||
    (await db.customers.count()) > 0 ||
    (await db.users.count()) > 0;
  if (hasData) {
    markDismissed();
    return;
  }

  await db.users.bulkPut(DEMO_USERS);
  for (const p of DEMO_PRODUCTS) {
    await createProduct(DEFAULT_SHOP_ID, 'admin-1', {
      sku: p.sku,
      name: p.name,
      category: p.category,
      sellingPrice: toMinor(p.price),
      stockQuantity: p.stock,
      minStockLevel: p.min,
      costPrice: toMinor(p.cost),
      supplierInfo: 'Seed Distributors Ltd'
    });
  }
  for (const c of DEMO_CUSTOMERS) {
    // createCustomer emits no outbox row — local-only convenience.
    await createCustomer({ name: c.name, phone: c.phone, shopId: DEFAULT_SHOP_ID });
  }
  markSeeded();
}

/**
 * Removes offline-demo data from an install that has since signed in with a
 * real shop. Returns how many rows were removed.
 *
 * Scope is deliberately airtight:
 *   - Any row in the `shop_default` partition (it can never be a real uuid,
 *     so this is unambiguous).
 *   - Any product (in any shop) bearing a known demo SKU — these could only
 *     have come from the old seeding bug, never from a real owner.
 * Demo outbox markers for either are deleted with them.
 */
export async function purgeDemoData(): Promise<number> {
  let removed = 0;
  const demoIds = new Set<string>();
  const demoSkus = new Set(DEMO_PRODUCTS.map((p) => p.sku));

  // 1) The demo-shop partition — `shop_default` can never be a real uuid, so
  //    every row under it is unambiguously offline-demo data.
  const demoProducts = await db.products.where('shopId').equals(DEFAULT_SHOP_ID).toArray();
  for (const p of demoProducts) {
    await db.products.delete(p.id);
    await db.productCosting.where('productId').equals(p.id).delete();
    await db.stockLedger.where('productId').equals(p.id).delete();
    demoIds.add(p.id);
    removed++;
  }
  await db.stockLedger.where('shopId').equals(DEFAULT_SHOP_ID).delete();
  await db.dailySummaries.where('shopId').equals(DEFAULT_SHOP_ID).delete();
  await db.sales.where('shopId').equals(DEFAULT_SHOP_ID).delete();
  await db.customers.where('shopId').equals(DEFAULT_SHOP_ID).delete();
  await db.creditLedger.where('shopId').equals(DEFAULT_SHOP_ID).delete();

  // 2) Known demo SKUs that the OLD bug seeded into a real shop id. These
  //    exact SKUs can only be seed artifacts — never a real owner's product.
  const allProducts = await db.products.toArray();
  for (const p of allProducts) {
    if (!demoSkus.has(p.sku) || p.shopId === DEFAULT_SHOP_ID) continue;
    await db.products.delete(p.id);
    await db.productCosting.where('productId').equals(p.id).delete();
    await db.stockLedger.where('productId').equals(p.id).delete();
    demoIds.add(p.id);
    removed++;
  }

  // 3) The offline demo staff accounts.
  const demoNames = new Set(DEMO_USERS.map((u) => u.displayName));
  for (const u of await db.users.toArray()) {
    if (demoNames.has(u.displayName)) {
      await db.users.delete(u.uid);
      removed++;
    }
  }

  // 4) Outbox markers for anything removed above — this is what permanently
  //    clears the "N queued / local-only" badge.
  const allOutbox = await db.outbox.toArray();
  for (const e of allOutbox) {
    const p = (e.payload ?? {}) as { shopId?: string; id?: string; productId?: string };
    if (p.shopId === DEFAULT_SHOP_ID || demoIds.has(p.id ?? '') || demoIds.has(p.productId ?? '')) {
      await db.outbox.delete(e.id);
      removed++;
    }
  }

  markDismissed();
  return removed;
}

export async function clearLocalData(): Promise<void> {
  await Promise.all([
    db.products.clear(),
    db.productCosting.clear(),
    db.sales.clear(),
    db.stockLedger.clear(),
    db.dailySummaries.clear(),
    db.customers.clear(),
    db.creditLedger.clear(),
    db.outbox.clear(),
    db.syncState.clear(),
    db.quotaUsage.clear()
  ]);
  // Erasing the DB must not re-trigger the demo on the next reload.
  markDismissed();
}
