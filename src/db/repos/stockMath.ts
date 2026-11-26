/**
 * Pure stock-derivation math — NO I/O, dependency-free (only `import type`), so
 * `scripts/verify_stock_convergence.ts` can import the REAL rules with a Node
 * type-stripped `.ts` path and exercise them without a browser/PGlite.
 *
 * `stock.ts` wraps these with the database reads/writes.
 *
 * THE CENTRAL RULE (`deriveStockQuantity`): the on-hand number may only be
 * derived from the ledger when the ledger is COMPLETE for that product — i.e.
 * it contains the product's OPENING row. A product with movements but no
 * opening is a legacy/partial row whose baseline is missing from the ledger;
 * summing it yields a too-low (often negative -> clamped 0) number. For those,
 * the snapshot is the only trustworthy baseline:
 *   - a read/repair keeps the snapshot unchanged;
 *   - a local mutation applies that mutation's own delta to the snapshot.
 * This is exactly the `hasOpening` signal that `ledgerStockByProduct` computes.
 */

/** A ledger row as far as the math cares (structural — mirrors StockLedgerEntry). */
export interface LedgerMovement {
  productId: string;
  type: string;
  referenceId: string;
  quantityDelta: number;
}

/** Running totals for one product's ledger rows. */
export interface ProductTotals {
  /** Net Σ quantityDelta (only meaningful as an ABSOLUTE quantity when `hasOpening`). */
  quantity: number;
  /** True once an opening RESTOCK row (referenceId === productId) exists. */
  hasOpening: boolean;
}

/** An opening row is the product's own original stock entry (createProduct). */
export function isOpeningMovement(m: { type: string; referenceId: string }, productId: string): boolean {
  return m.type === 'RESTOCK' && m.referenceId === productId;
}

/** Sum a batch of ledger rows per product (one pass). */
export function reduceLedgerByProduct(rows: LedgerMovement[]): Map<string, ProductTotals> {
  const map = new Map<string, ProductTotals>();
  for (const m of rows) {
    const productId = m?.productId;
    if (!productId) continue;
    const cur = map.get(productId) ?? { quantity: 0, hasOpening: false };
    const d = Number(m?.quantityDelta);
    cur.quantity += Number.isFinite(d) ? d : 0;
    if (isOpeningMovement(m, productId)) cur.hasOpening = true;
    map.set(productId, cur);
  }
  return map;
}

/**
 * The on-hand quantity for one product.
 *
 * @param cached   the product's currently cached `stockQuantity` (the snapshot)
 * @param totals   the product's ledger totals, or undefined when it has none
 * @param delta    when this call accompanies a LOCAL mutation, the signed stock
 *                 change of that movement; omit it on pure reads/repairs.
 *
 * - No ledger rows          -> the snapshot is all we have (zero-stock never
 *                              moved, or legacy) -> keep it.
 * - Opening present         -> the ledger is complete -> trust its sum.
 * - No opening, with delta  -> legacy baseline -> snapshot + this movement.
 * - No opening, no delta    -> legacy baseline -> keep the snapshot untouched
 *                              (never let an opening-less sum destroy it).
 */
export function deriveStockQuantity(
  cached: number,
  totals: ProductTotals | undefined,
  delta?: number
): number {
  const clamp = (n: number) => Math.max(0, Math.trunc(n));
  if (!totals) return clamp(cached);
  if (!totals.hasOpening) {
    return typeof delta === 'number' ? clamp(cached + delta) : clamp(cached);
  }
  return clamp(totals.quantity);
}
