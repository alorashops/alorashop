/**
 * Billing / subscription helpers (S12-6) — PURE and dependency-free.
 *
 * Imports NOTHING so the exact logic the Billing page uses is unit-tested in
 * plain Node by `scripts/verify_billing_ui_wiring.mjs`. This mirrors
 * `src/lib/payout.ts` (itself dependency-free) and `src/lib/referral.ts`.
 *
 * STATE (migration 029/038): `public.shops.subscription_status` is
 * NULL (not started) | trialing | active | past_due | canceled. The B3 rule is
 * BANNER-ONLY: a `trialing` / `past_due` shop gets a friendly notice, and the
 * POS keeps working fully — nothing here ever blocks a read or a write.
 */

/** Mirrors the `public.shops.subscription_status` CHECK (migrations 029/038). */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/** The status may be NULL — the shop has not started a subscription yet. */
export type MaybeSubscriptionStatus = SubscriptionStatus | null;

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled'
};

/** A status label that also covers the NULL ("not started") case. */
export function subscriptionStatusLabel(status: MaybeSubscriptionStatus | undefined): string {
  if (!status) return 'Not started';
  return SUBSCRIPTION_STATUS_LABELS[status] ?? status;
}

export interface BillingBanner {
  kind: 'trial' | 'past_due';
  tone: 'info' | 'warn';
  title: string;
  message: string;
}

/**
 * The banner the page shows for a status, or NULL when none is warranted.
 *
 * B3 (locked): `trialing` and `past_due` are NOTICES ONLY. The POS is never
 * gated — no read-only mode, no sync block. `active` / NULL / `canceled` show
 * nothing here (the status card still shows the raw state).
 */
export function billingBanner(status: MaybeSubscriptionStatus | undefined): BillingBanner | null {
  if (status === 'trialing') {
    return {
      kind: 'trial',
      tone: 'info',
      title: 'You are on the free trial',
      message: 'Everything works normally. Pay any time to continue after the trial ends.'
    };
  }
  if (status === 'past_due') {
    return {
      kind: 'past_due',
      tone: 'warn',
      title: 'Your subscription is past due',
      message: 'Your shop keeps working — nothing is locked. Pay to reactivate auto-renew.'
    };
  }
  return null;
}

/** True once a charge should visibly confirm (webhook not yet applied). */
export function isSettledActive(status: MaybeSubscriptionStatus | undefined): boolean {
  return status === 'active';
}

/** Format a MASKED card for display (B8). Never the PAN, never the token. */
export function formatCard(brand: string | null | undefined, last4: string | null | undefined): string | null {
  const digits = (last4 ?? '').trim();
  if (!/^[0-9]{4}$/.test(digits)) return null;
  const name = (brand ?? '').trim();
  return name ? `${name} •••• ${digits}` : `•••• ${digits}`;
}

/** The `billing.state()` fields the sidebar badge derives from. */
export interface BillingAttentionInput {
  status: MaybeSubscriptionStatus | undefined;
  days_left: number | null | undefined;
  auto_renew?: boolean | null;
  card_brand?: string | null;
  card_last4?: string | null;
  grace_days?: number | null;
}

/**
 * True when the shop GENUINELY needs a member to act — drives the Billing
 * sidebar badge (S12-7: B7 in-app, kept deliberately small — no table/migration).
 *
 * The Billing page ALREADY shows the trial/past-due banner + the days-left
 * countdown, so this helper adds NO new information — its only job is the
 * off-page PULL (a badge on the nav item) for a member who is not on that page.
 * It is therefore deliberately CONSERVATIVE, so the badge stays a real signal:
 *
 *   * `past_due` -> always true. The automatic renewal has stopped and never
 *     retries (traps.md TRAP-1), so a member must pay.
 *   * `trialing` -> true once the trial is inside the grace-days window.
 *   * `active`   -> true once the period is inside the window AND the shop will
 *     NOT self-heal (auto-renew off, or no saved card). An auto-renew-ON shop
 *     WITH a card needs NO member action — S12-4 charges it — so we show NO
 *     badge and never nudge a member toward a double charge (TRAP-2b residual).
 *   * anything else / no state / no server grace -> false (no guess, no literal).
 *
 * The window size is the SERVER's `grace_days` (billing.config), never a client
 * literal, so a config change moves the badge with the real grace period (B3).
 */
export function billingNeedsAttention(s: BillingAttentionInput | null | undefined): boolean {
  if (!s) return false;
  const status = s.status ?? null;

  // Past due (beyond the grace window) always needs a member to pay: the
  // automatic renewal has stopped and never retries (traps.md TRAP-1).
  if (status === 'past_due') return true;

  // Only the two live states can become "due soon".
  if (status !== 'trialing' && status !== 'active') return false;

  // The window comes from the server config; with no valid grace we do NOT guess.
  const grace = typeof s.grace_days === 'number' && s.grace_days >= 0 ? s.grace_days : null;
  if (grace === null) return false;

  const days = typeof s.days_left === 'number' ? s.days_left : null;
  if (days === null || days > grace) return false; // not yet inside the notice window

  // An active shop that WILL be auto-charged needs no member action.
  const selfHeals =
    status === 'active' && s.auto_renew === true && formatCard(s.card_brand, s.card_last4) !== null;
  return !selfHeals;
}

/**
 * Translate a raw server / function error into something a shop member can act
 * on. Matching on substrings is deliberate (same approach as `payout.ts`): the
 * exact `RAISE EXCEPTION` text lives in SQL and in the Edge Function, and we
 * surface the server's own words for anything we do not specifically recognise
 * — never a generic "something went wrong" that hides the reason.
 */
export function friendlyBillingError(raw: string): string {
  const m = (raw ?? '').toLowerCase();
  if (m.includes('no shop') || m.includes('no shop for caller')) {
    return 'Your account is not linked to a shop yet — create or join a shop first.';
  }
  if (m.includes('unauthenticated') || m.includes('authentication required')) {
    return 'Your session expired — please sign in again.';
  }
  if (m.includes('paystack_unavailable') || m.includes('could not reach')) {
    return 'Could not reach Paystack. Please try again.';
  }
  if (m.includes('not_configured')) {
    return 'Payments are not configured yet. Ask your administrator to set the Paystack keys.';
  }
  if (m.includes('initialize_rejected') || m.includes('invalid_intent')) {
    return 'Paystack refused to start the payment. Please try again or contact support.';
  }
  if (m.includes('billing.config is empty')) {
    return 'Subscription pricing is not set up yet. Ask your administrator.';
  }
  return raw;
}
