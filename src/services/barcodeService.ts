import { useCartStore } from '../stores/cartStore';
import { useUiStore } from '../stores/uiStore';
import type { Product } from '../types';

/**
 * Global hardware scanner interception.
 *
 * USB/Bluetooth barcode scanners act as keyboard wedges: they emit a fast
 * character buffer terminated by ENTER. We capture that burst on `window`
 * (no input focus required), debounce the buffer, and resolve it against
 * products in the local PGlite database instantly — zero network, zero focus management.
 */
interface BarcodeService {
  start: (onScan: (code: string) => void) => () => void;
  stop: () => void;
}

const WINDOW_MS = 80; // typical wedge inter-key gap
const TERMINATORS = ['Enter', 'Tab'];

/**
 * Is the event target an editable element (input / textarea / select /
 * contenteditable)? The global wedge must ignore typos in any field — a human
 * typing in search, cash or credit-search must never be misinterpreted as a
 * scanner burst (which produced phantom "No product for code …" toasts).
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable === true;
}

function createBarcodeService(): BarcodeService {
  let buffer = '';
  let lastKeyTime = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handler: ((code: string) => void) | undefined;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const code = buffer.trim();
    buffer = '';
    if (code && handler) handler(code);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // A real USB/Bluetooth scanner fires as a wedge on `window`/`document` with
    // NO focused text field — it never targets an editable node. When one of our
    // form fields is focused, this is user typing: back off entirely.
    if (isEditableTarget(e.target)) return;
    const now = Date.now();
    if (now - lastKeyTime > 200 && buffer.length > 0) {
      // New burst — discard stale partial buffer (a human typing).
      buffer = '';
    }
    lastKeyTime = now;

    if (TERMINATORS.includes(e.key)) {
      // B4: only swallow Enter/Tab when it actually TERMINATES a scanner burst. A bare
      // Enter pressed outside any field (e.g. activating a focused-looking button) must
      // not be eaten while the POS is mounted — with an empty buffer there is nothing to
      // flush, so let the key through.
      if (buffer.length === 0) return;
      e.preventDefault();
      flush();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      buffer += e.key;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, WINDOW_MS + 40);
    }
  };

  return {
    start: (cb) => {
      handler = cb;
      window.addEventListener('keydown', onKeyDown, true);
      return () => window.removeEventListener('keydown', onKeyDown, true);
    },
    stop: () => {
      window.removeEventListener('keydown', onKeyDown, true);
      handler = undefined;
      if (timer) clearTimeout(timer);
      buffer = '';
    }
  };
}

export const barcodeService = createBarcodeService();

/** Outcome of an add-to-cart attempt — callers may surface `max-stock`/`out-of-stock`. */
export type AddToCartStatus = 'added' | 'max-stock' | 'out-of-stock';

export interface AddToCartResult {
  status: AddToCartStatus;
  /** Quantity in the cart for this product AFTER the attempt. */
  quantity: number;
  /** The product's available stock (the clamp ceiling). */
  stockAvailable: number;
}

/**
 * THE single "a scanned/tapped product becomes a cart line" function (`STEPS.md` S3.1).
 *
 * The hardware wedge, the camera scanner and the product tile all funnel through here, so
 * there is ONE clamp rule and ONE set of toasts — a scan is only ever a new way to call this.
 *
 * It also fixes **B3**: `cart.add` clamps at `stockAvailable` with no feedback, so the 4th
 * scan of a 3-stock item used to do nothing and say nothing (the cashier only noticed at
 * payment). Now the clamp is announced, and the return value lets a caller add its own
 * confirmation (e.g. the camera path naming the item, `D4`).
 */
export function addProductToCart(product: Product): AddToCartResult {
  const cart = useCartStore.getState();
  const toast = useUiStore.getState();

  if (product.stockQuantity <= 0) {
    toast.push('error', `${product.name} is out of stock`);
    return { status: 'out-of-stock', quantity: 0, stockAvailable: 0 };
  }

  const existing = cart.lines.find((l) => l.productId === product.id);
  const before = existing?.quantity ?? 0;

  // At or past the stock ceiling the add is a no-op — SAY SO instead of silence (B3).
  if (before >= product.stockQuantity) {
    toast.push('warn', `Only ${product.stockQuantity} in stock — ${product.name} is already at the limit`);
    return { status: 'max-stock', quantity: before, stockAvailable: product.stockQuantity };
  }

  cart.add({
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unitPrice: product.sellingPrice,
    quantity: 1,
    stockAvailable: product.stockQuantity
  });
  return { status: 'added', quantity: before + 1, stockAvailable: product.stockQuantity };
}

/**
 * Convenience: attach a scan handler that looks up the product and adds it to
 * the cart through {@link addProductToCart} (same path as the camera + tile).
 */
export function attachProductScanHandler(lookup: (code: string) => Promise<Product | undefined>): () => void {
  return barcodeService.start(async (code) => {
    const product = await lookup(code);
    if (!product) {
      useUiStore.getState().push('warn', `No product for code ${code}`);
      return;
    }
    addProductToCart(product);
  });
}