/**
 * Environment / runtime config.
 *
 * Supabase credentials are injected at build time via .env / .env.local.
 * The app is 100% functional offline against the local PGlite database even
 * when these are empty — cloud sync simply stays dormant (no-op) until
 * configured.
 */
export const PAYSTACK_PUBLIC_KEY = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY ?? '';

/**
 * Email Paystack uses as the payment contact on a POS charge when the customer
 * has no email on file (the customer model only carries name/phone). Paystack
 * requires a valid email on every inline transaction. Override via
 * `VITE_PAYSTACK_BUSINESS_EMAIL`.
 */
export const PAYSTACK_BUSINESS_EMAIL = import.meta.env.VITE_PAYSTACK_BUSINESS_EMAIL ?? 'pos@alorashop.app';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/** Shop identity used in offline / demo mode. Replace via Settings once real auth is wired. */
export const DEFAULT_SHOP_ID = 'shop_default';
export const DEFAULT_SHOP_NAME = 'Alora Shop';

/**
 * Daily caps for the local sync-guardrail (a soft estimate of cloud traffic,
 * tracked per-device as a mirror — NOT a live meter from any provider).
 * Values keep the original Firebase Spark free-tier budgets from the pre-migration
 * era; they're conservative ceilings that still make sense for Supabase reads/writes.
 */
export const DAILY_SYNC_LIMITS = {
  reads: 50_000,
  writes: 20_000,
  deletes: 20_000
};
