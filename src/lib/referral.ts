/**
 * S3b — referral capture on the signup funnel.
 *
 * A referral link is `https://<pos>/?ref=ALORA-XXXXXX` (AFFILIATE.md A3). The code
 * has to survive the whole signup journey (land → sign up → name your shop), and
 * because the app uses a HashRouter a reload mid-flow would drop a query string.
 * So we capture it ONCE on first load and persist it until the shop is created.
 *
 * The format mirror is LOAD-BEARING: this is the SAME regex as the server CHECK in
 * migrations 026/028, so the client never sends a code the DB would reject as
 * malformed. A well-formed but UNKNOWN code is handled at create time (fallback).
 */

/** Identical to the CHECK in migrations 026 (`profiles.referral_code`) / 028. */
export const REFERRAL_CODE_RE = /^ALORA-[0-9A-HJKMNP-TV-Z]{6}$/;

const STORAGE_KEY = 'alorashop.referral.v1';

/** Uppercase + trim a raw code and return it ONLY if it matches the server format. */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

/** Read `ref` from the location: the real query string first, then a `?…` in the hash. */
function readRefFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const fromSearch = new URLSearchParams(window.location.search).get('ref');
  if (fromSearch) return fromSearch;
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  return q === -1 ? null : new URLSearchParams(hash.slice(q + 1)).get('ref');
}

/**
 * Capture `?ref=CODE` on first load and persist the VALIDATED code. Idempotent
 * and non-fatal: an absent/invalid code leaves any previously captured one intact
 * and returns it. Returns the effective captured code (or null).
 */
export function captureReferralFromUrl(): string | null {
  const code = normalizeReferralCode(readRefFromLocation());
  if (!code) return getCapturedReferral();
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* storage unavailable — non-fatal */
  }
  return code;
}

/** The validated, persisted referral code, or null when none was captured. */
export function getCapturedReferral(): string | null {
  try {
    return normalizeReferralCode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Drop the persisted code (called once a shop has been created). */
export function clearCapturedReferral(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

/**
 * True when an error is a referral-code REJECTION (malformed / unknown /
 * self-referral). Those are the only failures we may safely ignore: migration 028
 * validates the code BEFORE it creates the shop, so nothing was written when this
 * is true — the caller can retry with the legacy path.
 */
export function isReferralRejection(err: unknown): boolean {
  const m = String(err instanceof Error ? err.message : err).toLowerCase();
  return m.includes('referral code') || m.includes('self-referral');
}