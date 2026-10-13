import { PAYSTACK_PUBLIC_KEY, PAYSTACK_BUSINESS_EMAIL } from '../config/env';
import { uid } from '../lib/utils';

/**
 * Paystack Inline checkout — the real payment leg for CARD/PAYSTACK at the POS,
 * and the completion leg for the shop-facing subscription charge (S12-6).
 *
 * P9 (SECURITY_PLAN.md): CARD/PAYSTACK used to record a "trust-based" PAID split
 * with no money actually collected. This service makes Paystack charge the
 * customer BEFORE a sale can be marked PAID.
 *
 * S12-6 — ONE SDK, Inline v2. The POS previously loaded the LEGACY Inline v1
 * build, which exposed a different (static) API and assigned the SAME global
 * `window.PaystackPop` — so loading BOTH generations would silently clobber the
 * POS checkout (or vice-versa). We therefore use v2 ONLY:
 *   - POS charge       -> `new PaystackPop().newTransaction({...})`
 *   - Subscription pay -> `new PaystackPop().resumeTransaction(accessCode, {...})`
 * One loader, one global, no collision. See traps.md TRAP-5.
 *
 * API contract (Paystack Inline v2 `inline.js`):
 *   new PaystackPop()
 *     .newTransaction({ key, email, amount, currency, reference, metadata,
 *                       onSuccess(res), onCancel(), onError(err), onLoad(info) })
 *     .resumeTransaction(accessCode, { onSuccess, onCancel, onError, onLoad })
 *     - `newTransaction` opens the checkout form directly (v1 needed a separate open call).
 *     - `amount` is in PESEWAS (integer; 100 = GH₵1.00) — our money model already.
 *     - `onSuccess(res)`: fires only after a real charge; `res.reference` is the
 *       Paystack transaction reference.
 *     - `onCancel()`: fires when the customer closes the form without a charge.
 *
 * Security note: the authoritative re-check (`transaction.verify`) needs the
 * SECRET key, so it must run SERVER-side (the `verify-payment` function / the
 * subscription webhook) — never here. The client treats Paystack's own `onSuccess`
 * as the collection proof and embeds the reference. Any sale that does NOT reach
 * success is saved PENDING_VERIFICATION (excluded from revenue by migration 13).
 * Likewise the subscription webhook is the ONLY thing that marks a shop paid.
 */

// Inline v2 — the ONLY generation we load (see the header note).
const INLINE_SCRIPT_SRC = 'https://js.paystack.co/v2/inline.js';

// -------- Paystack Inline v2 global (declared locally; there is no types pkg) --
interface PaystackCallbackResponse {
  id?: number;
  reference?: string;
  message?: string;
}
interface PaystackErrorResponse {
  message?: string;
}
interface PaystackLoadInfo {
  id?: number;
  accessCode?: string;
  customer?: Record<string, unknown>;
}
/** The three normalised callbacks `openWith` hands to the caller. */
interface SettleCallbacks {
  onSuccess: (response: PaystackCallbackResponse) => void;
  onCancel: () => void;
  onError: (error: PaystackErrorResponse) => void;
}
interface PaystackNewTransactionOptions extends SettleCallbacks {
  key: string;
  email: string;
  amount: number; // pesewas
  currency?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
  onLoad?: (info: PaystackLoadInfo) => void;
}
interface PaystackTransactionInstance {
  getStatus?: () => { status?: string | null; response?: unknown; errors?: unknown };
}
interface PaystackPopInstance {
  newTransaction: (options: PaystackNewTransactionOptions) => PaystackTransactionInstance | undefined;
  resumeTransaction: (
    accessCode: string,
    callbacks?: SettleCallbacks & { onLoad?: (info: PaystackLoadInfo) => void }
  ) => PaystackTransactionInstance | undefined;
  cancelTransaction?: (idOrTransaction: string | PaystackTransactionInstance) => void;
  isLoaded?: () => boolean;
}
/** The v2 `PaystackPop` global is a CONSTRUCTOR (`new PaystackPop()`). */
interface PaystackPopConstructor {
  new (): PaystackPopInstance;
}

declare global {
  interface Window {
    PaystackPop?: PaystackPopConstructor;
  }
}

export type PaystackChargeResult =
  | { status: 'success'; reference: string }
  | { status: 'closed'; message?: string }
  | { status: 'error'; message: string };
let loadPromise: Promise<PaystackPopConstructor> | null = null;

/** Injects the Paystack Inline v2 script exactly once and resolves with the
    `PaystackPop` constructor. Throws if the script cannot load (offline / blocked). */
async function loadPaystack(): Promise<PaystackPopConstructor> {
  if (window.PaystackPop) return window.PaystackPop;
  if (!loadPromise) {
    loadPromise = new Promise<PaystackPopConstructor>((resolve, reject) => {
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

// A single in-flight popup guard shared by BOTH the POS charge and the
// subscription resume, so two Paystack windows can never be open at once.
let openPromise: Promise<PaystackChargeResult> | null = null;

/**
 * Load the SDK, create one `PaystackPop` instance, and hand the caller the three
 * normalised callbacks (`onSuccess`/`onCancel`/`onError`) already wired to a
 * timeout safety net. Any load or callback failure resolves to a
 * `PaystackChargeResult` — the caller is never left hanging.
 */
function openWith(
  open: (instance: PaystackPopInstance, cb: SettleCallbacks) => void
): Promise<PaystackChargeResult> {
  return loadPaystack().then(
    (PaystackPop) =>
      new Promise<PaystackChargeResult>((resolve) => {
        let settled = false;
        const settle = (r: PaystackChargeResult) => {
          if (settled) return;
          settled = true;
          openPromise = null;
          resolve(r);
        };
        // Safety net: never leave the caller hanging if no callback fires.
        const timeout = setTimeout(
          () => settle({ status: 'closed', message: 'Payment window timed out — no charge was made.' }),
          10 * 60 * 1000
        );
        const cb: SettleCallbacks = {
          onSuccess: (res) => {
            clearTimeout(timeout);
            if (res && typeof res.reference === 'string' && res.reference) settle({ status: 'success', reference: res.reference });
            else settle({ status: 'closed', message: res?.message });
          },
          onCancel: () => {
            clearTimeout(timeout);
            settle({ status: 'closed' });
          },
          onError: (err) => {
            clearTimeout(timeout);
            settle({ status: 'error', message: err?.message ?? 'Paystack rejected the charge.' });
          }
        };
        try {
          const instance = new PaystackPop();
          open(instance, cb);
        } catch (err) {
          clearTimeout(timeout);
          settle({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }),
    (err) => {
      // LOAD failure: clear the in-flight guard so a retry is not blocked forever
      // (settle() is never reached on this path).
      openPromise = null;
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  );
}

/**
 * Charge a CARD/PAYSTACK payment via a real Paystack Inline v2 checkout.
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
  // A unique `reference` also stops v2 from auto-resuming an ABANDONED txn that
  // happened to share params (v2 only auto-resumes on identical params).
  const ref = `POS${Date.now().toString(36).toUpperCase()}${uid().slice(0, 8).toUpperCase()}`;
  openPromise = openWith((instance, cb) => {
    instance.newTransaction({
      key: PAYSTACK_PUBLIC_KEY,
      email: PAYSTACK_BUSINESS_EMAIL,
      amount: amountPesewas,
      currency: 'GHS',
      reference: ref,
      metadata: { custom_fields: [{ display_name: 'POS Sale', variable_name: 'pos_sale', value: ref }] },
      onSuccess: cb.onSuccess,
      onCancel: cb.onCancel,
      onError: cb.onError
    });
  });
  return openPromise;
}

/**
 * Resume a server-initialised subscription charge (S12-6 / B5). The
 * `paystack-subscribe` Edge Function returns an `access_code`; this opens the
 * Paystack checkout for it. NO `key`/`amount` is sent — the access code carries
 * them and the server derived them from `auth.uid()`.
 *
 * IMPORTANT: a `success` here only means the CARD was charged. The shop is
 * advanced to `active` by the PAYSTACK WEBHOOK alone — callers must never mark
 * the shop paid; they poll `billing.state()` and let the webhook win.
 */
export async function resumePaystackCharge(accessCode: string): Promise<PaystackChargeResult> {
  const code = (accessCode ?? '').trim();
  if (!code) {
    return { status: 'error', message: 'Missing Paystack access code.' };
  }
  if (openPromise) {
    return { status: 'closed', message: 'A payment window is already open.' };
  }
  openPromise = openWith((instance, cb) => {
    if (typeof instance.resumeTransaction !== 'function') {
      cb.onError({ message: 'This Paystack library build cannot resume the payment. Please refresh and try again.' });
      return;
    }
    instance.resumeTransaction(code, {
      onSuccess: cb.onSuccess,
      onCancel: cb.onCancel,
      onError: cb.onError
    });
  });
  return openPromise;
}