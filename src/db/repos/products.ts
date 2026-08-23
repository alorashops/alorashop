import { db } from '../db';
import { uid } from '../../lib/utils';
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
      await db.productCosting.put({
        productId: product.id,
        costPrice: input.costPrice,
        weightedAverageCost: input.costPrice,
        supplierInfo: input.supplierInfo,
        updatedAt: now
      });
    }
    if (input.stockQuantity > 0) {
      await db.stockLedger.add({
        id: uid(),
        productId: product.id,
        type: 'RESTOCK',
        quantityDelta: input.stockQuantity,
        referenceId: product.id,
        actorId,
        shopId,
        createdAt: now
      });
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
        updatedAt: now
      };
      costing.costPrice = input.costPrice;
      costing.supplierInfo = input.supplierInfo ?? costing.supplierInfo;
      costing.updatedAt = now;
      await db.productCosting.put(costing);
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
  note?: string
): Promise<void> {
  const now = Date.now();
  const qty = Math.round(quantity);
  if (qty <= 0) throw new Error('Restock quantity must be positive');
  const restockId = uid();

  await db.transaction('rw', db.products, db.stockLedger, db.outbox, async () => {
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
 * Smart delete — always safe for the books:
 *  - No financial or stock history → hard delete (frees the row entirely).
 *  - Has history (was restocked, sold, etc.) → soft delete ("archived").
 *    The row is kept so past sales / stock-ledger / daily summaries still
 *    resolve by productId, but it's hidden from checkout and the inventory list.
 */
export async function deleteProduct(productId: string): Promise<{ archived: boolean }> {
  const hasLedger = await db.stockLedger.where('productId').equals(productId).count();
  const product = await db.products.get(productId);

  if (hasLedger > 0) {
    // Has history — keep the row, just hide it. Preserve all references.
    if (product && !product.archived) {
      const now = Date.now();
      const next: Product = { ...product, archived: true, updatedAt: now };
      await db.transaction('rw', db.products, db.outbox, async () => {
        await db.products.put(next);
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
    }
    return { archived: true };
  }

  // No history → it's a draft/typo; permanently remove it.
  await db.transaction('rw', db.products, db.productCosting, async () => {
    await db.products.delete(productId);
    await db.productCosting.where('productId').equals(productId).delete();
  });
  return { archived: false };
}