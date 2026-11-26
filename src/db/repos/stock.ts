import { db } from '../db';
import { reduceLedgerByProduct, deriveStockQuantity, type ProductTotals } from './stockMath';
import type { Product } from '../../types';

/**
 * Stock derivation — the on-hand quantity comes from the APPEND-ONLY ledger,
 * not from whichever product snapshot happened to sync last.
 *
 * WHY: `products.data.stockQuantity` is a last-writer-wins document. Two
 * devices can sell the same product between syncs; each writes its own
 * snapshot and the later `updatedAt` overwrites the earlier one, silently
 * losing a decrement. The same reasoning already made `summary.ts` derive
 * Analytics from raw sales instead of the shared daily-summary doc.
 *
 * The stock ledger is append-only and keyed by movement id, so every device
 * that has the movements computes the SAME quantity regardless of arrival
 * order:
 *
 *     onHand = Σ(quantityDelta)          (opening RESTOCK included)
 *
 * The product document keeps `stockQuantity` as a materialized cache for the
 * POS/Inventory UI and for the cloud mirror. `reconcile*` refreshes that cache
 * after local movements and after pulls (without bumping `updatedAt`, so it
 * neither fabricates a new sync version nor re-pushes anything).
 *
 * Opening stock is written as a RESTOCK whose `referenceId` is the product id
 * (see createProduct), so it is indistinguishable from an ordinary restock for
 * the sum — that is intentional: both add to on-hand.
 *
 * IMPORTANT — the ledger is trusted ONLY when it contains that opening row
 * (`hasOpening`). A product with movements but no opening row is a legacy /
 * partial row whose baseline never synced; summing it would understate stock
 * (often to 0). For those, the snapshot is the authoritative baseline — see
 * `deriveStockQuantity` in stockMath.ts. This is why createProduct now writes an
 * opening row for EVERY product (even a 0 delta).
 */

/** Per-product ledger totals (re-exported from the pure math module). */
export type ProductStock = ProductTotals;

/** Sum the ledger for one shop, grouped by productId. One scan per refresh. */
export async function ledgerStockByProduct(shopId: string): Promise<Map<string, ProductStock>> {
  const rows = await db.stockLedger.where('shopId').equals(shopId).toArray();
  return reduceLedgerByProduct(rows);
}

/**
 * The on-hand quantity for one product from an already-computed ledger map.
 *
 * Delegates to the pure {@link deriveStockQuantity}: the ledger is trusted ONLY
 * when it holds the product's opening row. A product with movements but no
 * opening (legacy/partial) falls back to its cached snapshot — never the
 * opening-less sum, which would zero real stock. (See stockMath.ts.)
 */
export function stockFromLedger(product: Product, ledger: Map<string, ProductStock>): number {
  return deriveStockQuantity(product.stockQuantity, ledger.get(product.id));
}

/**
 * Recompute ONE product's cached `stockQuantity` from its ledger movements.
 * Safe inside a read-write transaction (PGlite reuses the active transaction).
 * Returns the reconciled row (or the unchanged row when already correct).
 */
export async function reconcileProductStock(
  productId: string,
  updatedAt?: number,
  /** The signed stock change of the LOCAL mutation calling this, if any. */
  delta?: number
): Promise<Product | undefined> {
  const product = await db.products.get(productId);
  if (!product) return undefined;
  const rows = await db.stockLedger.where('productId').equals(productId).toArray();
  if (rows.length === 0) return product; // no movements known — keep the snapshot
  // `hasOpening` decides how the number is derived (see stockMath.ts): a
  // complete ledger is trusted in full; a ledger missing its opening row is a
  // legacy baseline, so we apply only this mutation's delta to the snapshot.
  const quantity = deriveStockQuantity(product.stockQuantity, reduceLedgerByProduct(rows).get(productId), delta);
  // Local mutations pass their `now` so the cloud row gets a NEW version and
  // propagates. Pulls/read-repairs pass nothing: the number is derived, not a
  // new edit, and must not fabricate a sync version.
  const bump = typeof updatedAt === 'number' && updatedAt !== product.updatedAt ? updatedAt : undefined;
  if (quantity === product.stockQuantity && bump === undefined) return product;
  const next: Product = {
    ...product,
    stockQuantity: quantity,
    ...(bump !== undefined ? { updatedAt: bump } : {})
  };
  await db.products.put(next);
  return next;
}

/**
 * Recompute every product cache for a shop from the ledger. Called by the
 * inventory read path, so a device that missed a stale snapshot converges the
 * moment its ledger movements are present.
 */
export async function reconcileShopStock(shopId: string): Promise<Product[]> {
  const products = await db.products.where('shopId').equals(shopId).toArray();
  if (products.length === 0) return products;
  const ledger = await ledgerStockByProduct(shopId);
  const out: Product[] = [];
  for (const product of products) {
    const quantity = stockFromLedger(product, ledger);
    if (quantity === product.stockQuantity) {
      out.push(product);
      continue;
    }
    const next: Product = { ...product, stockQuantity: quantity };
    await db.products.put(next);
    out.push(next);
  }
  return out;
}
