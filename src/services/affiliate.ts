/**
 * Affiliate (S9) — OWNER-ONLY reads via the `affiliate`-schema RPCs (migration 033).
 *
 * ONLINE-ONLY by design (AFFILIATE.md A8): this module must NOT import PGlite or
 * Dexie. The Affiliate page is a code-split chunk excluded from the service-worker
 * precache, so it is fetched from the network on demand and is simply unavailable
 * offline (the page shows a friendly "needs a connection" state).
 *
 * Every call is scoped server-side to `auth.uid()` — the client never passes (and
 * could never pass) a referrer id, so one referrer can never read another's data.
 */
import { getSupabase } from './supabase';
import type { PayoutChannel, PayoutStatus } from '../lib/payout';

export type { PayoutChannel, PayoutStatus };

export interface AffiliateWallet {
  available_minor: number;
  pending_minor: number;
  total_minor: number;
}

export type ReferralStatus = 'pending' | 'active' | 'churned' | 'refunded';

export interface AffiliateReferral {
  store_id: string;
  store_name: string | null;
  status: ReferralStatus;
  source: 'signup' | 'invite';
  referred_at: string;
}

export interface AffiliateNotification {
  id: number;
  kind: 'commission_released';
  amount_minor: number;
  currency: string;
  created_at: string;
  read_at: string | null;
}

/** The caller's derived balances (integer pesewas). */
export async function getMyWallet(): Promise<AffiliateWallet> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_wallet');
  if (error) throw error;
  const row = (data as AffiliateWallet[] | null)?.[0];
  return row ?? { available_minor: 0, pending_minor: 0, total_minor: 0 };
}

/** The shops the caller referred. */
export async function getMyReferrals(): Promise<AffiliateReferral[]> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_referrals');
  if (error) throw error;
  return (data as AffiliateReferral[] | null) ?? [];
}

/** The caller's in-app inbox (server clamps the limit to 1..200). */
export async function getMyNotifications(limit = 50): Promise<AffiliateNotification[]> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_notifications', { p_limit: limit });
  if (error) throw error;
  return (data as AffiliateNotification[] | null) ?? [];
}

/** The caller's unread count (drives the sidebar badge). */
export async function getMyUnreadCount(): Promise<number> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_unread_notifications');
  if (error) throw error;
  return typeof data === 'number' ? data : Number(data ?? 0);
}

/** Mark the given ids (or ALL of the caller's unread when omitted) as read. */
export async function markNotificationsRead(ids?: number[]): Promise<number> {
  const sb = await getSupabase();
  const { data, error } = await sb
    .schema('affiliate')
    .rpc('mark_notifications_read', { p_ids: ids ?? null });
  if (error) throw error;
  return typeof data === 'number' ? data : Number(data ?? 0);
}

/**
 * The caller's own referral code, minting one lazily on first need (S1
 * `public.ensure_referral_code`, granted to `authenticated`).
 */
export async function getMyReferralCode(): Promise<string> {
  const sb = await getSupabase();
  const { data, error } = await sb.rpc('ensure_referral_code');
  if (error) throw error;
  return data as string;
}

/** The shareable signup link for a code (A3: `https://<pos>/?ref=CODE`). */
export function referralLink(code: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?ref=${encodeURIComponent(code)}`;
}

// ===========================================================================
// S8c — withdraw (admin-gated). These call the S8a/S8b server pieces; the
// SERVER is authoritative (admin-only, atomic hold, idempotent). The client
// only shapes the request and reports the outcome.
// ===========================================================================

/**
 * Raised when an affiliate Edge Function fails. `transient` is TRUE when a
 * RETRY can help (network / relay failure, or any 5xx) — the withdraw UI keeps
 * the SAME idempotency key for a transient failure so a retry is ONE payout.
 */
export class AffiliateFunctionError extends Error {
  readonly code: string;
  readonly transient: boolean;
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    opts: { transient?: boolean; status?: number | null } = {}
  ) {
    super(message);
    this.name = 'AffiliateFunctionError';
    this.code = code;
    this.transient = opts.transient ?? false;
    this.status = opts.status ?? null;
  }
}

/**
 * Invoke an affiliate Edge Function and normalise its outcome.
 *
 * - A non-2xx response: `error.context` is the RAW (unread) `Response`, so we
 *   read its JSON to recover the function's own `{ error, message }` — we never
 *   reduce a Paystack reason to "non-2xx". A missing status (network/relay) or
 *   a 5xx is TRANSIENT.
 * - A 2xx with `{ ok: false }`: a PERMANENT "no" (e.g. `recipient_rejected`) —
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
    throw new AffiliateFunctionError(
      payload?.error ?? 'function_failed',
      payload?.message ?? error.message,
      { transient, status }
    );
  }
  const out = data as { ok?: boolean; error?: string; message?: string } | null;
  if (out && out.ok === false) {
    throw new AffiliateFunctionError(
      out.error ?? 'rejected',
      out.message ?? 'The request was rejected.',
      { transient: false, status: 200 }
    );
  }
  return data as T;
}

export interface BankOption {
  code: string;
  name: string;
}

/**
 * The Paystack-driven bank / MoMo-provider list for a channel (S8b
 * `paystack-banks`). Never hardcoded, so provider rebrands cannot drift.
 */
export async function listBanks(channel: PayoutChannel): Promise<BankOption[]> {
  const out = await invokeFunction<{ banks?: BankOption[] }>('paystack-banks', { channel });
  return out.banks ?? [];
}

export interface CreateRecipientInput {
  channel: PayoutChannel;
  accountNumber: string;
  bankCode: string;
  accountName: string;
}

/** The MASKED recipient echoed by `create-recipient` — never the raw number. */
export interface MaskedRecipient {
  id: string | null;
  channel: PayoutChannel;
  bank_name: string | null;
  account_name: string | null;
  account_last4: string;
}

/**
 * Create + persist a MASKED payout destination. The RAW account number is sent
 * to the Edge Function (which forwards it to Paystack) and is NEVER stored or
 * logged; only the last 4 digits come back (AFFILIATE.md A10).
 */
export async function createRecipient(input: CreateRecipientInput): Promise<MaskedRecipient> {
  const out = await invokeFunction<{ recipient: MaskedRecipient }>('create-recipient', {
    channel: input.channel,
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
    accountName: input.accountName
  });
  return out.recipient;
}

/** A masked payout destination owned by the caller (via `my_recipients`). */
export interface PayoutRecipient {
  id: string;
  channel: PayoutChannel;
  bank_name: string | null;
  account_name: string | null;
  account_last4: string;
  is_active: boolean;
  created_at: string;
}

/** The caller's MASKED destinations (at most one active). */
export async function getMyRecipients(): Promise<PayoutRecipient[]> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_recipients');
  if (error) throw error;
  return (data as PayoutRecipient[] | null) ?? [];
}

/** A withdrawal request owned by the caller (via `my_payouts`). */
export interface PayoutRequest {
  id: string;
  amount_minor: number;
  currency: string;
  status: PayoutStatus;
  provider_reference: string | null;
  reason: string | null;
  created_at: string;
  settled_at: string | null;
}

/** The caller's payout requests (server clamps the limit to 1..200). */
export async function getMyPayouts(limit = 50): Promise<PayoutRequest[]> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_payouts', { p_limit: limit });
  if (error) throw error;
  return (data as PayoutRequest[] | null) ?? [];
}

/** The live withdrawal limits from `affiliate.config` (pesewas; 0 = no floor). */
export interface PayoutLimits {
  min_payout_minor: number;
}

/**
 * The live minimum-payout floor (S11a). The floor is server CONFIG, never a
 * client literal, so the UI pre-validates and labels it from this read. A read
 * failure must NOT block the page — callers fall back to 0 (the server still
 * enforces the real floor and its rejection is surfaced).
 */
export async function getMyPayoutLimits(): Promise<PayoutLimits> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('my_payout_limits');
  if (error) throw error;
  const row = (data as PayoutLimits[] | null)?.[0];
  return { min_payout_minor: Number(row?.min_payout_minor ?? 0) };
}

/**
 * Request a withdrawal: HOLDS `available` atomically and returns the payout id.
 * ADMIN-ONLY server-side; idempotent on `(caller, idempotencyKey)`, so reusing
 * the key on a retry returns the SAME payout (never a second deduction).
 */
export async function requestPayout(
  amountMinor: number,
  recipientId: string,
  idempotencyKey: string
): Promise<string> {
  const sb = await getSupabase();
  const { data, error } = await sb.schema('affiliate').rpc('request_payout', {
    p_amount_minor: amountMinor,
    p_recipient_id: recipientId,
    p_idempotency_key: idempotencyKey
  });
  if (error) throw error;
  return data as string;
}

export interface InitiateTransferResult {
  status: PayoutStatus | 'in_progress' | 'otp_required';
  transferCode?: string;
  /** True when Paystack holds the transfer until an OTP is supplied (S11c). */
  otpRequired?: boolean;
}

/**
 * Start the Paystack transfer for a payout (`initiate-transfer`). Claim-first
 * and `reference = <payout id>` server-side, so a duplicate call reconciles
 * instead of paying twice.
 */
export async function initiateTransfer(payoutId: string): Promise<InitiateTransferResult> {
  const out = await invokeFunction<{ status: string; transferCode?: string }>('initiate-transfer', {
    payoutId
  });
  return {
    status: out.status as InitiateTransferResult['status'],
    transferCode: out.transferCode,
    otpRequired: out.status === 'otp_required'
  };
}

/**
 * Complete an OTP-held transfer (`finalize-transfer`, S11c). A wrong OTP throws
 * an `AffiliateFunctionError` with the code `otp_rejected` and moves NO money
 * (the hold stays), so the owner can simply try again.
 */
export async function finalizeTransfer(payoutId: string, otp: string): Promise<InitiateTransferResult> {
  const out = await invokeFunction<{ status: string; transferCode?: string }>('finalize-transfer', {
    payoutId,
    otp
  });
  return { status: out.status as InitiateTransferResult['status'], transferCode: out.transferCode };
}


