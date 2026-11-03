/**
 * SKU rules — PURE, dependency-free, and Node-loadable.
 *
 * `scripts/verify_qr_sku_uniqueness.mjs` imports this file directly (the same way
 * `verify_lazy_retry.mjs` imports `lazyRetry.ts`), so it must NEVER import the db,
 * React, or anything browser-only.
 *
 * WHY this file exists: a printed QR label encodes the SKU (see `STEPS.md` §1), so the
 * SKU is the one identifier a human can read off a label AND a scanner can resolve. Two
 * LIVE products sharing a SKU therefore means a scan silently sells the WRONG item at the
 * RIGHT price — the receipt, the stock ledger and the analytics all look correct. These
 * are the exact rules `createProduct` enforces.
 */

/** The single normalisation used for every SKU comparison (trim + case-fold). */
export function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase();
}

/** A SKU must be non-blank — a label with no code under the QR has no fallback. */
export function isValidSku(sku: string): boolean {
  return sku.trim().length > 0;
}

/** Lowest number a shop's own generated series may use (keeps codes short + QR-sparse). */
export const SKU_NUMBER_FLOOR = 100001;

/**
 * Suggest the next short numeric SKU for a shop, derived ONLY from the SKUs already
 * present — no counter, no stored sequence, so nothing can drift.
 *
 * Live AND archived SKUs both count: an archived product's number may be reused as far
 * as the uniqueness rule cares, but the paper label is still on a shelf, so the
 * suggestion deliberately steps over it rather than handing out a number that is already
 * printed. A shop with none of its own numeric SKUs starts at `SKU_NUMBER_FLOOR`
 * (below the 6-digit demo series, far from any real 13-digit EAN).
 */
export function nextSkuFrom(existingSkus: readonly string[]): string {
  let max = 0;
  for (const raw of existingSkus) {
    const s = raw.trim();
    if (!/^\d{1,9}$/.test(s)) continue;
    const n = Number(s);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(Math.max(max + 1, SKU_NUMBER_FLOOR));
}

/** Message for a create/edit that collides with a live SKU in the same shop. */
export function duplicateSkuMessage(sku: string): string {
  return (
    `SKU ${sku.trim()} is already used by another product in this shop — pick a different one. ` +
    `Two products with the same SKU would make a QR scan sell the wrong item.`
  );
}

/** Message for a create attempted with no SKU at all. */
export const MISSING_SKU_MESSAGE = 'Enter a SKU — it is the code the printed QR label encodes.';
