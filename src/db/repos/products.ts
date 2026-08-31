import { db } from '../db';
import { uid } from '../../lib/utils';
import { enqueueStockLedger } from './outbox';
import { applyWeightedAverageCost } from './summary';
import type { Product, ProductCosting } from '../../types';

/**
 * Products + restricted costing subcollection.
 * Costing stays in a separate Dexie table so the UI layer can simply refuse to
 * mount that data for cashiers — mirroring the Firestore document split.
 */

export async function getAllProducts(shopId: string): Promise<Product[]> {
  return db.products
    .where('shopId')
    .equals(shopId)
    .filter((p) => !p.archived)
    .toArray();
}

export async function findProductByBarcode(shopId: string, raw: string): Promise<Product | undefined> {
  const code = raw.trim();
  if (!code) return undefined;
  const bySku = await db.products.where('sku').equals(code).first();
  if (bySku && bySku.shopId === shopId && !bySku.archived) return bySku;
  const byId = await db.products.where('id').equals(code).first();
  if (byId && byId.shopId === shopId && !byId.archived) return byId;
  return undefined;
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
  const product: Product = {
    id: uid(),
    sku: input.sku.trim() || uid(),
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
        // secondary gap). Dexie nests this within the active transaction, so the
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