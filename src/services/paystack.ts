import { PAYSTACK_PUBLIC_KEY, PAYSTACK_BUSINESS_EMAIL } from '../config/env';
import { uid } from '../lib/utils';

/**
 * Paystack Inline checkout — the real payment leg for CARD/PAYSTACK at the POS.
 *
 * P9 (SECURITY_PLAN.md): CARD/PAYSTACK used to record a "trust-based" PAID split
 * with no money actually collected. This service makes Paystack charge the
 * customer BEFORE a sale can be marked PAID.
 *
 * API contract (Paystack Inline / `inline-standalone.js`):
 *   PaystackPop.setup({ key, email, amount, currency, ref, metadata,
 *                       callback(res), onClose() })
 *     - `amount` is in PESEWAS (integer; 100 = GH₵1.00). Our money model is
 *       already minor units (pesewas), so callers pass the value straight through.
 *     - `callback(res)`: `res.status === 'success'` only after a real charge;
 *       `res.reference` is the Paystack transaction reference.
 *     - `onClose()`: fires when the popup closes without a confirmed charge.
 *
 * Security note: the authoritative re-check (`transaction.verify`) needs the
 * SECRET key, so it must run SERVER-side (a webhook) — never here. The client
 * treats Paystack's own `status: 'success'` callback as the collection proof
 * and embeds the reference. Any sale that does NOT reach success is saved
 * PENDING_VERIFICATION (excluded from revenue by migration 13); the P9 backend
 * webhook is the follow-up that re-verifies and promotes PENDING -> PAID.
 */

const INLINE_SCRIPT_SRC = 'https://js.paystack.co/v1/inline-standalone.js';

// -------- Paystack Inline global (declared locally; there is no types pkg) --
interface PaystackCallbackResponse {
  reference?: string;
  trans?: string;
  status?: string | boolean;
  message?: string;
}
interface PaystackSetupOptions {
  key: string;
  email: string;
  amount: number; // pesewas
  currency: string;
  ref?: string;
  label?: string;
  metadata?: Record<string, unknown>;
  callback?: (response: PaystackCallbackResponse) => void;
  onClose?: () => void;
}
interface PaystackPopApi {
  setup: (options: PaystackSetupOptions) => { openIframe?: () => void } | undefined;
}

declare global {
  interface Window {
    PaystackPop?: PaystackPopApi;
  }
}

export type PaystackChargeResult =
  | { status: 'success'; reference: string }
  | { status: 'closed'; message?: string }
  | { status: 'error'; message: string };
let loadPromise: Promise<PaystackPopApi> | null = null;

/** Injects the Paystack Inline script exactly once and resolves with the global
    `PaystackPop` object. Throws if the script cannot load (offline / blocked). */
async function loadPaystack(): Promise<PaystackPopApi> {
  if (window.PaystackPop) return window.PaystackPop;
  if (!loadPromise) {
    loadPromise = new Promise<PaystackPopApi>((resolve, reject) => {
      let script = document.getElementById('paystack-inline') as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement('script');
        script.id = 'paystack-inline';
        script.src = INLINE_SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      const ok = () => {
        script!.removeEventListener('load', ok);
        script!.removeEventListener('error', fail);
        if (window.PaystackPop) resolve(window.PaystackPop);
        else { loadPromise = null; reject(new Error('Paystack loaded but PaystackPop is missing.')); }
      };
      const fail = () => {
        script!.removeEventListener('load', ok);
        script!.removeEventListener('error', fail);
        loadPromise = null;
        reject(new Error('Could not load the Paystack payment library — check your network connection.'));
      };
      if (window.PaystackPop) { resolve(window.PaystackPop); return; }
      script.addEventListener('load', ok);
      script.addEventListener('error', fail);
    });
  }
  return loadPromise;
}

let openPromise: Promise<PaystackChargeResult> | null = null;

/** Opens the Paystack Inline popup for a single charge. Resolves once the
    customer completes (success), closes the popup (closed), or the setup throws
    (error). A generous timeout guarantees the caller is never left hanging. */
async function openInlineCharge(amountPesewas: number, ref: string): Promise<PaystackChargeResult> {
  try {
    const pop = await loadPaystack();
    return new Promise<PaystackChargeResult>((resolve) => {
      let settled = false;
      const settle = (r: PaystackChargeResult) => {
        if (settled) return;
        settled = true;
        openPromise = null;
        resolve(r);
      };
      // Safety net: never let the POS hang if neither callback nor onClose fire.
      const timeout = setTimeout(() => settle({ status: 'closed', message: 'Payment window timed out — no charge was made.' }), 10 * 60 * 1000);
      try {
        const channel = pop.setup({
          key: PAYSTACK_PUBLIC_KEY,
          email: PAYSTACK_BUSINESS_EMAIL,
          amount: amountPesewas,
          currency: 'GHS',
          ref,
          metadata: { custom_fields: [{ display_name: 'POS Sale', variable_name: 'pos_sale', value: ref }] },
          callback: (res) => {
            clearTimeout(timeout);
            if (res && res.status === 'success' && typeof res.reference === 'string' && res.reference) {
              settle({ status: 'success', reference: res.reference });
            } else {
              settle({ status: 'closed', message: res?.message });
            }
          },
          onClose: () => {
            clearTimeout(timeout);
            settle({ status: 'closed' });
          }
        });
        channel?.openIframe?.();
      } catch (err) {
        clearTimeout(timeout);
        settle({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    });
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Charge a CARD/PAYSTACK payment via a real Paystack Inline checkout.
 *
 * Returns `success` (with the Paystack transaction reference) only when Paystack
 * reports a completed charge; otherwise `closed` (customer cancelled / timeout)
 * or `error` (not configured / script failed / Paystack rejected the charge).
 */
export async function chargeCardOrPaystack(amountPesewas: number): Promise<PaystackChargeResult> {
  if (amountPesewas <= 0) {
    return { status: 'closed', message: 'Nothing to charge.' };
  }
  if (!PAYSTACK_PUBLIC_KEY) {
    return { status: 'error', message: 'Paystack is not configured. Set VITE_PAYSTACK_PUBLIC_KEY to accept card payments.' };
  }
  if (openPromise) {
    return { status: 'closed', message: 'A payment window is already open.' };
  }
  // Unique, alphanumeric Paystack reference (letters + digits only, no spaces).
  const ref = `POS${Date.now().toString(36).toUpperCase()}${uid().slice(0, 8).toUpperCase()}`;
  openPromise = openInlineCharge(amountPesewas, ref);
  return openPromise;
}