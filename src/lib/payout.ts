/**
 * Payout / withdrawal helpers (S8c) — PURE and dependency-free.
 *
 * Deliberately imports NOTHING but `./utils` (itself dependency-free) so the
 * exact logic the withdraw UI uses is unit-tested in plain Node by
 * `scripts/verify_affiliate_withdraw_wiring.mjs`. This mirrors how
 * `src/lib/referral.ts` mirrors the server's referral-code CHECK.
 *
 * RULES (see HANDOFF.md §10):
 *  - Money is INTEGER PESEWAS everywhere; GH₵ ↔ pesewas conversion happens only
 *    at the UI edge (here).
 *  - The minimum-payout floor is SERVER config (`affiliate.config.min_payout_minor`)
 *    and is NOT readable by the client, so we never hardcode it — the server
 *    rejects below-floor amounts and `friendlyPayoutError` translates that.
 *  - `validateDestination` is a client MIRROR of the server's
 *    `create-recipient/decide.ts::validateRecipientInput`, so a malformed
 *    account number never costs a network round-trip.
 */
// NOTE: the explicit `.ts` extension is deliberate — it lets the Node guard
// (`scripts/verify_affiliate_withdraw_wiring.mjs`) import this module directly
// (Node ESM needs extensions). tsconfig has `allowImportingTsExtensions: true`.
import { parseMoneyInput, uid } from './utils.ts';

/** Payout channel — mirrors `affiliate.payout_recipients.channel`. */
export type PayoutChannel = 'bank' | 'momo';

/** Mirrors the `affiliate.payout_requests.status` CHECK (migration 034). */
export type PayoutStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  pending: 'Pending',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  reversed: 'Reversed',
  cancelled: 'Cancelled'
};

/**
 * Parse a user-typed GH₵ amount into INTEGER PESEWAS (reusing the app's single
 * money parser so the whole POS agrees on rounding). Blank/garbage -> 0.
 */
export function ghsToPesewas(input: string): number {
  return parseMoneyInput(input);
}

/** Format integer pesewas as a plain GH₵ string for an input field (no symbol). */
export function pesewasToGhs(minor: number): string {
  return (minor / 100).toFixed(2);
}

export type WithdrawValidation =
  | { ok: true; amountMinor: number }
  | { ok: false; reason: string };

/**
 * Client-side pre-check for a withdrawal amount. This is UX only — the SERVER
 * (`affiliate.request_payout` + the 035 floor trigger) is authoritative.
 *
 * `minPayoutMinor` is the live floor read from `affiliate.my_payout_limits`
 * (S11a) — it is CONFIG, never a client literal, so when the read fails callers
 * pass 0 and the server's below-floor rejection is surfaced instead.
 */
export function validateWithdrawAmount(
  raw: string,
  availableMinor: number,
  minPayoutMinor = 0
): WithdrawValidation {
  const amountMinor = ghsToPesewas(raw);
  if (amountMinor <= 0) return { ok: false, reason: 'Enter an amount to withdraw.' };
  if (minPayoutMinor > 0 && amountMinor < minPayoutMinor) {
    return { ok: false, reason: `The minimum withdrawal is GH₵${pesewasToGhs(minPayoutMinor)}.` };
  }
  if (amountMinor > availableMinor) {
    return { ok: false, reason: 'That is more than your available balance.' };
  }
  return { ok: true, amountMinor };
}

export interface DestinationInput {
  channel: PayoutChannel;
  accountNumber: string;
  bankCode: string;
  accountName: string;
}

export type DestinationValidation = { ok: true } | { ok: false; reason: string };

/**
 * Client MIRROR of the server's `validateRecipientInput` (create-recipient/
 * decide.ts). Same channel set, same digit-only rule, same 10-digit MoMo length,
 * same 6–20-digit bank length, same 2–100-char name. Kept identical so the two
 * cannot silently drift (asserted by the guard).
 */
export function validateDestination(input: DestinationInput): DestinationValidation {
  const accountNumber = input.accountNumber.trim();
  if (!/^[0-9]+$/.test(accountNumber)) {
    return { ok: false, reason: 'Account number must be digits only.' };
  }
  if (input.channel === 'momo') {
    if (accountNumber.length !== 10) {
      return { ok: false, reason: 'A MoMo number must be exactly 10 digits.' };
    }
  } else if (accountNumber.length < 6 || accountNumber.length > 20) {
    return { ok: false, reason: 'A bank account number must be 6–20 digits.' };
  }
  const bankCode = input.bankCode.trim();
  if (!bankCode) return { ok: false, reason: 'Choose a bank or provider.' };
  if (bankCode.length > 20) return { ok: false, reason: 'That provider code is invalid.' };
  const name = input.accountName.trim();
  if (name.length < 2 || name.length > 100) {
    return { ok: false, reason: 'Enter the account name (2–100 characters).' };
  }
  return { ok: true };
}

/**
 * Validate a transfer OTP (S11c) — digits only, 4–8 long. Mirrors the server's
 * `finalize-transfer/decide.ts::validateOtp` so a malformed OTP costs no call.
 */
export function validateOtp(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const otp = (raw ?? '').trim();
  if (!/^[0-9]{4,8}$/.test(otp)) return { ok: false, reason: 'Enter the 4–8 digit code Paystack sent you.' };
  return { ok: true, value: otp };
}

/** A withdrawal attempt in flight: the idempotency key + what it is FOR. */
export interface WithdrawAttempt {
  key: string;
  amountMinor: number;
  recipientId: string;
}

/**
 * The idempotency key for THIS attempt.
 *
 * REUSE the existing key when the attempt is unchanged (amount AND recipient) —
 * that is a RETRY of the same withdrawal, so a double-tap (or a retry after a
 * transient Paystack failure) collapses to ONE payout on the server (UNIQUE
 * `(referrer, idempotency_key)`). Otherwise mint a FRESH key: a genuinely new
 * withdrawal must never be deduped against an older one.
 */
export function resolveAttemptKey(
  attempt: WithdrawAttempt | null,
  amountMinor: number,
  recipientId: string,
  mint: () => string = uid
): WithdrawAttempt {
  if (attempt && attempt.amountMinor === amountMinor && attempt.recipientId === recipientId) {
    return attempt;
  }
  return { key: mint(), amountMinor, recipientId };
}

/**
 * Translate a raw server error into something an owner can act on. Matching on
 * substrings is deliberate: the exact `RAISE EXCEPTION` text lives in SQL
 * (migrations 034/035) and in the Edge Functions, and we surface the server's
 * own words for anything we do not specifically recognise — never a generic
 * "something went wrong" that hides the reason.
 */
export function friendlyPayoutError(raw: string): string {
  const m = (raw ?? '').toLowerCase();
  if (m.includes('admin only')) return 'Only a shop admin can withdraw.';
  if (m.includes('insufficient') || m.includes('available funds')) {
    return 'That is more than your available balance.';
  }
  if (m.includes('below the configured minimum')) {
    return 'That is below the minimum withdrawal amount.';
  }
  if (m.includes('recipient') && m.includes('not found for this caller')) {
    return 'That payout destination is no longer valid — save it again.';
  }
  if (m.includes('paystack_unavailable') || m.includes('could not reach')) {
    return 'Could not reach Paystack. Please try again.';
  }
  if (m.includes('unauthenticated') || m.includes('authentication required')) {
    return 'Your session expired — please sign in again.';
  }
  if (m.includes('forbidden')) return 'This payout does not belong to you.';
  if (m.includes('recipient_rejected')) return 'Paystack rejected those account details.';
  if (m.includes('no_transfer_code')) return 'This withdrawal has no transfer to complete yet.';
  if (m.includes('otp_rejected')) return 'That code was not accepted — check the OTP and try again.';
  return raw;
}
