import { db } from '../db';
import { uid } from '../../lib/utils';
import { enqueueStockLedger } from './outbox';
import { applyWeightedAverageCost } from './summary';
import { isValidSku, nextSkuFrom, normalizeSku, duplicateSkuMessage, MISSING_SKU_MESSAGE } from '../../lib/sku';
import type { Product, ProductCosting } from '../../types';

/**
 * Products + restricted costing subcollection.
 * Costing stays in a separate PGlite table so the UI layer can simply refuse to
 * mount that data for cashiers — the server mirrors this with role-gated product_costing policies (migration 03).
 */

export async function getAllProducts(shopId: string): Promise<Product[]> {
  return db.products
    .where('shopId')
    .equals(shopId)
    .filter((p) => !p.archived)
    .toArray();
}

/**
 * Resolve a scanned / typed code to a product in THIS shop.
 *
 * Match order: exact `sku` → exact `id` → case-insensitive `sku`.
 *
 * Two fixes over the previous version, both silent-bug shaped (see STEPS.md §7):
 *  1. The candidate is now chosen **shop-scoped**. The old code asked the table-wide
 *     `sku` index for `.first()` and only THEN checked `shopId`, so a same-SKU row
 *     belonging to another shop could shadow this shop's real product and answer
 *     "No product for code …" for an item we actually do have.
 *  2. The case-insensitive pass exists because `isSkuTaken` enforces uniqueness
 *     case-insensitively — without it, typing `abc-1` would fail to find a product
 *     stored as `ABC-1` while still blocking that SKU from being created. QR scans hit
 *     the exact path (the label carries the stored string); this only serves typing.
 */
export async function findProductByBarcode(shopId: string, raw: string): Promise<Product | undefined> {
  const code = raw.trim();
  if (!code) return undefined;

  const live = (p: Product | undefined): p is Product =>
    !!p && p.shopId === shopId && !p.archived;

  const bySku = (await db.products.where('sku').equals(code).toArray()).find(live);
  if (bySku) return bySku;

  const byId = await db.products.where('id').equals(code).first();
  if (live(byId)) return byId;

  const wanted = normalizeSku(code);
  const shopProducts = await db.products.where('shopId').equals(shopId).toArray();
  return shopProducts.find((p) => !p.archived && normalizeSku(p.sku) === wanted);
}

/**
 * Is this SKU already in use by a LIVE product of this shop?
 *
 * Archived products do NOT hold a SKU — archiving frees the code for reuse (the only
 * cost is a stale shelf label, which is why `nextSkuFrom` still steps over archived
 * numbers when *suggesting* one). Comparison is case-insensitive via `normalizeSku`.
 */
export async function isSkuTaken(shopId: string, sku: string, exceptProductId?: string): Promise<boolean> {
  const wanted = normalizeSku(sku);
  if (!wanted) return false;
  const rows = await db.products.where('shopId').equals(shopId).toArray();
  return rows.some((p) => !p.archived && p.id !== exceptProductId && normalizeSku(p.sku) === wanted);
}

/**
 * The next free short numeric SKU for a shop — the default the New Product form opens
 * with, so a product created through the UI never falls back to a 36-char UUID (which
 * would be a dense, unreadable QR label: STEPS.md S1.2).
 */
export async function suggestNextSku(shopId: string): Promise<string> {
  const rows = await db.products.where('shopId').equals(shopId).toArray();
  return nextSkuFrom(rows.map((p) => p.sku));
}

export async function getProductCosting(productId: string): Promise<ProductCosting | undefined> {
  return db.productCosting.where('productId').equals(productId).first();
}

export async function getLowStock(shopId: string): Promise<Product[]> {
  return db.products
    .where('shopId')
    .equals(shopId)
    .filter((p) => !p.archived && p.stockQuantity <= p.minStockLevel)
    .toArray();
}

export interface NewProductInput {
  /** Required, unique per shop (case-insensitive) — this is what a QR label encodes. */
  sku: string;
  name: string;
  description?: string;
  category: string;
  sellingPrice: number; // minor units
  stockQuantity: number;
  minStockLevel: number;
  costPrice?: number; // minor units — manager/admin only field
  supplierInfo?: string;
}

export async function createProduct(shopId: string, actorId: string, input: NewProductInput): Promise<Product> {
  const now = Date.now();
  const sku = input.sku.trim();
  // STEPS.md S1.2 — a blank SKU used to be auto-filled with `uid()`, which silently
  // produced a 36-char UUID. That UUID is what the QR label would encode (a dense,
  // unscannable pattern with no readable digits under it) and it is unusable as a
  // shelf-visible code. Refuse instead of inventing one; the New Product form
  // pre-fills a short suggestion, so a human only sees this if they clear the field.
  if (!isValidSku(sku)) throw new Error(MISSING_SKU_MESSAGE);

  const product: Product = {
    id: uid(),
    sku,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    category: input.category.trim() || 'General',
    sellingPrice: Math.max(0, input.sellingPrice),
    stockQuantity: Math.max(0, input.stockQuantity),
    minStockLevel: Math.max(0, input.minStockLevel),
    shopId,
    updatedAt: now
  };

  await db.transaction('rw', db.products, db.productCosting, db.stockLedger, db.outbox, async () => {
    // STEPS.md S1.1 — SKU uniqueness per shop, INSIDE the transaction so two racing
    // creates cannot both pass the check. Case-insensitive (`normalizeSku`); archived
    // products do not hold their SKU. This is a correctness guard, not tidiness: the
    // SKU is the QR payload, and a duplicate would make a scan sell the wrong product
    // at the right price with a perfectly plausible receipt.
    if (await isSkuTaken(shopId, sku)) throw new Error(duplicateSkuMessage(sku));
    await db.products.add(product);
    if (input.costPrice !== undefined) {
      const costing: ProductCosting = {
        productId: product.id,
        costPrice: input.costPrice,
        weightedAverageCost: input.costPrice,
        supplierInfo: input.supplierInfo,
        shopId,
        updatedAt: now
      };
      await db.productCosting.put(costing);
      // Costing must reach the cloud too — it lives in its OWN mirror table
      // (product_costing, migration 0003) so cost/supplier never leak into the
      // products doc that cashiers can read. Without this row, a fresh device
      // pulls products with no costing and shows cost = 0 forever.
      await db.outbox.add({
        id: uid(),
        idempotencyKey: `product_costing_${product.id}`,
        entityType: 'PRODUCT_COSTING',
        payload: costing,
        status: 'PENDING',
        retryCount: 0,
        createdAt: now
      });
    }
    if (input.stockQuantity > 0) {
      const ledgerEntry = {
        id: uid(),
        productId: product.id,
        type: 'RESTOCK' as const,
        quantityDelta: input.stockQuantity,
        referenceId: product.id,
        actorId,
        shopId,
        createdAt: now
      };
      await db.stockLedger.add(ledgerEntry);
      // Opening RESTOCK row must reach the cloud too — previously only the
      // PRODUCT row synced, so this product's stock origin was missing from
      // every other device's audit trail (Finding 3).
      await enqueueStockLedger(ledgerEntry);
    }
    await db.outbox.add({
      id: uid(),
      idempotencyKey: `product_${product.id}`,
      entityType: 'PRODUCT',
      payload: product,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now
    });
  });
  return product;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  category?: string;
  sellingPrice?: number;
  minStockLevel?: number;
  costPrice?: number;
  supplierInfo?: string;
}

/** Manager edits — last-write-wins via updatedAt. Stock changes go through restock(), never here. */
export async function updateProduct(productId: string, input: UpdateProductInput): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.products, db.productCosting, db.outbox, async () => {
    const existing = await db.products.get(productId);
    if (!existing) return;
    const next: Product = {
      ...existing,
      name: input.name?.trim() || existing.name,
      description: input.description !== undefined ? (input.description?.trim() || undefined) : existing.description,
      category: input.category?.trim() || existing.category,
      sellingPrice: input.sellingPrice !== undefined ? Math.max(0, input.sellingPrice) : existing.sellingPrice,
      minStockLevel: input.minStockLevel !== undefined ? Math.max(0, input.minStockLevel) : existing.minStockLevel,
      updatedAt: now
    };
    await db.products.put(next);
    if (input.costPrice !== undefined) {
      const costing = (await db.productCosting.where('productId').equals(productId).first()) ?? {
        productId,
        costPrice: input.costPrice,
        weightedAverageCost: input.costPrice,
        supplierInfo: input.supplierInfo,
        shopId: existing.shopId,
        updatedAt: now
      };
      costing.costPrice = input.costPrice;
      costing.supplierInfo = input.supplierInfo ?? costing.supplierInfo;
      // Tenant key: legacy local rows predate the shopId field — backfill it
      // now from the product so the row can map onto the cloud mirror.
      costing.shopId = costing.shopId ?? existing.shopId;
      if (costing.weightedAverageCost == null) costing.weightedAverageCost = input.costPrice;
      costing.updatedAt = now;
      await db.productCosting.put(costing);
      await db.outbox.add({
        id: uid(),
        idempotencyKey: `product_costing_${productId}`,
        entityType: 'PRODUCT_COSTING',
        payload: costing,
        status: 'PENDING',
        retryCount: 0,
        createdAt: now
      });
    }
    await db.outbox.add({
      id: uid(),
      idempotencyKey: `product_${productId}`,
      entityType: 'PRODUCT',
      payload: next,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now
    });
  });
}

export async function restockProduct(
  shopId: string,
  productId: string,
  quantity: number,
  actorId: string,
  note?: string,
  /** Optional purchase unit cost (minor units). When provided, the weighted
      average cost (WAC) is updated — see below for why that matters. */
  unitCost?: number
): Promise<void> {
  const now = Date.now();
  const qty = Math.round(quantity);
  if (qty <= 0) throw new Error('Restock quantity must be positive');
  const restockId = uid();

  await db.transaction('rw', db.products, db.productCosting, db.stockLedger, db.outbox, async () => {
    const product = await db.products.get(productId);
    if (!product) throw new Error('Product not found');
    const next: Product = { ...product, stockQuantity: product.stockQuantity + qty, updatedAt: now };
    await db.products.put(next);
    await db.stockLedger.add({
      id: restockId,
      productId,
      type: 'RESTOCK',
      quantityDelta: qty,
      referenceId: restockId,
      actorId,
      shopId,
      createdAt: now
    });
    await db.outbox.add({
          id: uid(),
          idempotencyKey: `restock_${restockId}`,
                  entityType: 'RESTOCK',
                  // Must carry `type` — the cloud row round-trips into a local
                  // StockLedgerEntry on other devices via db.stockLedger.put(payload);
                  // omitting it (as it was) silently stored a ledger entry with
                  // `type: undefined` on every device except the one that restocked.
                  payload: { id: restockId, productId, type: 'RESTOCK', quantityDelta: qty, referenceId: restockId, actorId, shopId, createdAt: now, note },
          status: 'PENDING',
          retryCount: 0,
          createdAt: now
        });
        // Weighted-average cost update — the restock modal has ALWAYS promised this,
        // but applyWeightedAverageCost() was dead code: restockProduct() never called
        // it, so WAC silently trailed reality after every restock. The stale cost
        // then fed stock value (getStockValue, WAC-based) and profit backfill on
        // every device. Wire it when a purchase unit cost is supplied (Finding 1
        // secondary gap). PGlite nests this within the active transaction, so the
        // costing write commits atomically with the restock.
        if (typeof unitCost === 'number' && unitCost > 0) {
          await applyWeightedAverageCost(productId, qty, unitCost);
          const costing = await db.productCosting.where('productId').equals(productId).first();
          if (costing) {
            await db.outbox.add({
              id: uid(),
              idempotencyKey: `product_costing_${productId}`,
              entityType: 'PRODUCT_COSTING',
              // Tenant key: legacy rows predate shopId — backfill from the caller.
              payload: { ...costing, shopId: costing.shopId ?? shopId, updatedAt: now },
              status: 'PENDING',
              retryCount: 0,
              createdAt: now
            });
          }
        }
        // Coalesce product doc flush too (stock change must reach the cloud).
        await db.outbox.add({
          id: uid(),
          idempotencyKey: `product_${productId}`,
          entityType: 'PRODUCT',
          payload: next,
          status: 'PENDING',
          retryCount: 0,
          createdAt: now
        });
      });
    }

/**
 * Delete = archive, always.
 *
 * The local device NEVER hard-deletes a product. Every delete becomes a soft
 * archive (hidden from checkout + inventory, still resolves history) AND is
 * always enqueued to the cloud mirror, so other/fresh devices converge on
 * `archived: true` too.
 *
 * (Finding from production: products with no history were hard-deleted locally
 * with NO outbox row — the append-only cloud mirror never learned about it,
 * so "erase local data" + re-pull resurrected them as ACTIVE. Always-archive
 * closes that hole for every delete, history or not. A future retention purge
 * can prune old archives safely because archivedAt is now stamped.)
 */
export async function deleteProduct(productId: string): Promise<{ archived: boolean }> {
  const product = await db.products.get(productId);
  if (!product) return { archived: true }; // idempotent — nothing to delete
  if (product.archived) return { archived: true }; // already archived

  const now = Date.now();
  const next: Product = { ...product, archived: true, archivedAt: now, updatedAt: now };
  await db.transaction('rw', db.products, db.outbox, async () => {
    await db.products.put(next);
    // Always enqueue (even for no-history drafts) — the cloud must know, or a
    // fresh device (or erase + re-pull on this one) resurrects it as sellable.
    await db.outbox.add({
      id: uid(),
      idempotencyKey: `product_${productId}_archive`,
      entityType: 'PRODUCT',
      payload: next,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now
    });
  });
  return { archived: true };
}