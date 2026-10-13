/**
 * Billing (S12-6) — the shop-facing subscription surface via the `billing`-schema
 * RPCs (migrations 039/040) and the `paystack-subscribe` Edge Function (S12-3).
 *
 * ONLINE-ONLY by design (BILLING.md B5): this module must NOT import PGlite or
 * Dexie. The Billing page is a code-split chunk excluded from the service-worker
 * precache, so it is fetched from the network on demand and is simply unavailable
 * offline (the page shows a friendly "needs a connection" state).
 *
 * Every call is scoped server-side to `auth.uid()`: the SHOP and the AMOUNT are
 * derived on the server (`.rpc('state')` / `create_intent` / the Edge Function),
 * so the client can never name a shop or a price. Any member may pay (B4) — the
 * page is deliberately NOT admin-gated.
 */
import { getSupabase } from './supabase';
import type { SubscriptionStatus } from '../lib/billing';

export type { SubscriptionStatus };

/** One row from `billing.state()` — the caller's shop snapshot. */
export interface BillingState {
  shop_id: string;
  status: SubscriptionStatus | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  next_due_at: string | null;
  days_left: number | null;
  auto_renew: boolean;
  card_brand: string | null;
  card_last4: string | null;
  price_minor: number;
  currency: string;
  period_days: number;
  grace_days: number;
}

/** One row from `billing.payment_history(p_limit)` (newest first). */
export interface BillingPayment {
  reference: string;
  amount_minor: number;
  currency: string;
  period_end: string;
  paid_at: string;
}

/** The `paystack-subscribe` success payload. */
export interface StartPaymentResult {
  reference: string;
  amount_minor: number;
  currency: string;
  access_code: string;
  authorization_url: string;
}

/**
 * Raised when a billing call or Edge Function fails. `transient` is TRUE when a
 * RETRY can help (network / relay failure, or any 5xx) — the Pay flow surfaces
 * it so a member can simply try again (the server mints a FRESH reference each
 * attempt, so a retry is never deduped against an abandoned one).
 */
export class BillingFunctionError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    opts: { transient?: boolean; status?: number | null } = {}
  ) {
    super(message);
    this.name = 'BillingFunctionError';
    this.code = code;
    this.transient = opts.transient ?? false;
    this.status = opts.status ?? null;
  }
}

/**
 * Invoke the `paystack-subscribe` Edge Function and normalise its outcome.
 *
 * - A non-2xx response: `error.context` is the RAW (unread) `Response`, so we
 *   read its JSON to recover the function's own `{ error, message }` — we never
 *   reduce a Paystack reason to "non-2xx". A missing status (network/relay) or
 *   a 5xx is TRANSIENT.
 * - A 2xx with `{ ok: false }`: a PERMANENT "no" (e.g. `initialize_rejected`) —
 *   retrying would only repeat it, so `transient` is false.
 */
async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const sb = await getSupabase();
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let payload: { error?: string; message?: string } | null = null;
    let status: number | null = null;
    const ctx = (error as { context?: unknown }).context as Response | undefined;
    if (ctx && typeof ctx.status === 'number') {
      status = ctx.status;
      if (typeof ctx.json === 'function') {
        try {
          payload = (await ctx.json()) as { error?: string; message?: string };
        } catch {
          /* not JSON (relay/network) — fall through to the generic message */
        }
      }
    }
    const transient = status === null || status >= 500;
    throw new BillingFunctionError(
      payload?.error ?? 'function_failed',
      payload?.message ?? error.message,
      { transient, status }
    );
  }
  const out = data as { ok?: boolean; error?: string; message?: string } | null;
  if (out && out.ok === false) {
    throw new BillingFunctionError(
      out.error ?? 'rejected',
      out.message ?? 'The request was rejected.',
      { transient: false, status: 200 }
    );
  }
  return data as T;
}

/**
 * The caller's shop billing snapshot (one row), or NULL when the shop has no
 * billing row yet. The shop is derived from `auth.uid()` server-side.
 */
export async function getBillingState(): Promise<BillingState | null> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('billing').rpc('state');
  if (error) throw error;
  return (data as BillingState[] | null)?.[0] ?? null;
}

/** The caller's shop charge history (server clamps the limit to 1..100). */
export async function getPaymentHistory(limit = 50): Promise<BillingPayment[]> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('billing').rpc('payment_history', { p_limit: limit });
  if (error) throw error;
  return (data as BillingPayment[] | null) ?? [];
}

/**
 * Start a subscription payment. The Edge Function mints OUR `alora-sub-*`
 * intent from `auth.uid()` (the shop + price are NEVER client-supplied) and
 * returns an `access_code` for the client to resume the charge.
 *
 * `autoRenew` is the B9 tri-state: OMIT it to leave the shop's stored setting
 * unchanged; pass `true`/`false` to state the opt-in on this intent.
 */
export async function startSubscriptionPayment(autoRenew?: boolean): Promise<StartPaymentResult> {
  const body = autoRenew === undefined ? {} : { autoRenew };
  const out = await invokeFunction<StartPaymentResult & { ok?: boolean }>('paystack-subscribe', body);
  if (!out.access_code || !out.reference) {
    throw new BillingFunctionError('invalid_intent', 'The payment could not be started.', {
      transient: false,
      status: 200
    });
  }
  return out;
}
