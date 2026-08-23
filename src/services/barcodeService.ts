import { useCartStore } from '../stores/cartStore';
import { useUiStore } from '../stores/uiStore';
import type { Product } from '../types';

/**
 * Global hardware scanner interception.
 *
 * USB/Bluetooth barcode scanners act as keyboard wedges: they emit a fast
 * character buffer terminated by ENTER. We capture that burst on `window`
 * (no input focus required), debounce the buffer, and resolve it against
 * products in IndexedDB instantly — zero network, zero focus management.
 */
interface BarcodeService {
  start: (onScan: (code: string) => void) => () => void;
  stop: () => void;
}

const WINDOW_MS = 80; // typical wedge inter-key gap
const TERMINATORS = ['Enter', 'Tab'];

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
    const now = Date.now();
    if (now - lastKeyTime > 200 && buffer.length > 0) {
      // New burst — discard stale partial buffer (a human typing).
      buffer = '';
    }
    lastKeyTime = now;

    if (TERMINATORS.includes(e.key)) {
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

/**
 * Convenience: attach a scan handler that looks up the product and adds it to
 * the cart, with a low-stock guard and instant toast feedback.
 */
export function attachProductScanHandler(lookup: (code: string) => Promise<Product | undefined>): () => void {
  return barcodeService.start(async (code) => {
    const product = await lookup(code);
    const cart = useCartStore.getState();
    const toast = useUiStore.getState();
    if (!product) {
      toast.push('warn', `No product for code ${code}`);
      return;
    }
    if (product.stockQuantity <= 0) {
      toast.push('error', `${product.name} is out of stock`);
      return;
    }
    cart.add({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unitPrice: product.sellingPrice,
      quantity: 1,
      stockAvailable: product.stockQuantity
    });
  });
}