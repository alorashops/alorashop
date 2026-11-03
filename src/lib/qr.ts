/**
 * QR payload + label text — PURE, dependency-free, and Node-loadable.
 *
 * `scripts/verify_qr_scan_wiring.mjs` imports this file directly (the same way
 * `verify_qr_sku_uniqueness.mjs` imports `src/lib/sku.ts`), so it must NEVER import the
 * db, React, or anything browser-only. It deliberately has ZERO imports.
 *
 * LOCKED DECISION `D1` (see `STEPS.md` §9): the QR payload is the RAW SKU — nothing else.
 * Not a URL, not a product id, not a price. A QR is just a container for a short string;
 * the scanner hands this exact string back and `findProductByBarcode()` already resolves it
 * (`sku` first, then `id`). Because NO price is inside, editing a price can never invalidate
 * a printed label, and every device renders the identical code from the SKU it already syncs.
 */

/** Upper bound for the product name printed on a small label (keeps it to ~2 lines). */
export const QR_LABEL_NAME_MAX = 40;

/**
 * The exact string a QR encodes for a product: the **trimmed SKU**.
 *
 * The parameter is structural (`{ sku }`) rather than `Pick<Product, 'sku' | 'id'>` so this
 * file stays import-free; it is still assignable from a `Product`. It reads ONLY `sku`:
 * `id`, `sellingPrice`, timestamps and every other field must never leak into the payload,
 * because the printed label has to stay valid for its whole life on a shelf.
 */
export function buildQrPayload(product: { sku: string }): string {
  return product.sku.trim();
}

/**
 * The human-readable product name printed above the QR. Truncated so a long name cannot
 * push the code off a fixed-size label. The SKU under the QR is the real identifier, so
 * truncation here loses nothing a scanner needs.
 */
export function qrLabelTitle(product: { name: string }): string {
  const name = product.name.trim();
  return name.length > QR_LABEL_NAME_MAX
    ? `${name.slice(0, QR_LABEL_NAME_MAX - 1).trimEnd()}…`
    : name;
}

/**
 * Label geometry — TWO switchable sizes (`STEPS.md` S2.4). Keeping the numbers HERE (pure,
 * import-free, Node-loadable) means the on-screen preview, the print sheet and the guard all
 * read ONE source of truth, so a dimension can never drift between what is shown and printed.
 */
export type QrLabelSize = 'small' | 'large';

export interface QrLabelGeometry {
  /** Label width in mm. */
  widthMm: number;
  /** Label height in mm. */
  heightMm: number;
  /** Rendered QR edge in px (~96dpi). A constant, so the preview and paper match. */
  qrPx: number;
}

export const QR_LABEL_SIZES: Record<QrLabelSize, QrLabelGeometry> = {
  small: { widthMm: 38, heightMm: 21, qrPx: 52 },
  large: { widthMm: 50, heightMm: 30, qrPx: 76 }
};

export const DEFAULT_QR_LABEL_SIZE: QrLabelSize = 'small';

/** Geometry for a size, falling back to the default for an unknown value. */
export function qrLabelSize(size: QrLabelSize | undefined): QrLabelGeometry {
  return QR_LABEL_SIZES[size ?? DEFAULT_QR_LABEL_SIZE] ?? QR_LABEL_SIZES[DEFAULT_QR_LABEL_SIZE];
}

/** Human label for the size picker, e.g. `38×21 mm`. */
export function qrLabelSizeLabel(size: QrLabelSize): string {
  const g = qrLabelSize(size);
  return `${g.widthMm}×${g.heightMm} mm`;
}

/**
 * Is a decoded camera string shaped like one of OUR payloads (a SKU)?
 *
 * The camera sees EVERY QR in the room — an advert, a WiFi join code, a URL. Those must be
 * IGNORED (with a toast), never looked up: a lookup of a 200-char URL is a wasted scan and a
 * confusing "No product for code …". A SKU is short, has no whitespace and no URL scheme.
 *
 * (A scheme-less bare domain like `example.com` is a known, accepted edge case — such a QR is
 * rare, and it simply resolves to "No product for code example.com", which is still correct.)
 */
export function isPlausibleScanPayload(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 64) return false;
  if (/\s/.test(s)) return false;
  if (s.includes('://') || s.includes('/') || s.includes(':')) return false;
  return true;
}
