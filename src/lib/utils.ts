/** Shared helpers — money, ids, dates, paging. */

/**
 * Builds an RFC-4122 v4 UUID from `crypto.getRandomValues` — the one Web
 * Crypto primitive that (unlike `crypto.randomUUID`) is available in
 * NON-secure contexts too, so plain-HTTP LAN deployments keep working.
 */
function uuidV4FromGetRandomValues(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Crypto-only id generator (P11, SECURITY_PLAN.md).
 *
 * `uid()` is the single source of every local primary key — sales, products,
 * customers, stock ledger and outbox entries — and those ids are pushed to the
 * cloud mirror AS the row id (`buildCloudRows`). The old fallback
 * (`id_${Date.now()}_${Math.random()...}`) was BOTH non-cryptographic AND not a
 * UUID, so on any device without `crypto.randomUUID` it would mint guessable
 * primary keys in a shape the cloud contract does not accept.
 *
 * Order:
 *   1. `crypto.randomUUID()`    — secure contexts (fast path, real UUID).
 *   2. `crypto.getRandomValues` — universal; still a real v4 UUID.
 *   3. otherwise THROW (fail-CLOSED). A predictable id / idempotency seed is
 *      worse than a loud failure; `Math.random` is never used as a fallback.
 */
export const uid = (): string => {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues === 'function') return uuidV4FromGetRandomValues();
  }
  throw new Error('Secure id generation unavailable: Web Crypto (crypto.getRandomValues) is missing.');
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when shopId is a real Supabase shop uuid — the only shop that can sync. */
export function isCloudShopId(shopId?: string | null): boolean {
  return typeof shopId === 'string' && UUID_RE.test(shopId);
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function yesterdayKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return todayKey(d);
}

/** Minor-units money: store pesewas as integers, format as Cedis. */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

/** Parse a user-typed money string (e.g. "12.50" or "GH₵ 12.50") into minor units. */
export function parseMoneyInput(str: string): number {
  const n = parseFloat(str.replace(/[^\d.]/g, ''));
  if (Number.isNaN(n)) return 0;
  return toMinor(n);
}

export function fromMinor(minor: number): number {
  return minor / 100;
}

export function fmtMoney(minor: number): string {
  return `GH₵${(minor / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtMoneyCompact(minor: number): string {
  const major = minor / 100;
  if (major >= 1_000_000) return `GH₵${(major / 1_000_000).toFixed(2)}M`;
  if (major >= 1_000) return `GH₵${(major / 1_000).toFixed(1)}k`;
  return `GH₵${major.toLocaleString('en-GH', { minimumFractionDigits: 2 })}`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GH', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString('en-GH', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GH', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function pct(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 100);
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout>;
  const wrapped = (...args: Parameters<T>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  return wrapped as T;
}

/**
 * Password policy (P10a, SECURITY_PLAN.md): at least 8 characters AND one
 * letter, one digit and one symbol (a non-alphanumeric, non-whitespace
 * character). The SERVER enforces the same rule inside the staff RPCs
 * (migration 25); this is the client-side mirror so the two never drift.
 *
 * NOTE: this governs NEW / CHANGED passwords only (signup + the admin staff
 * RPCs). It must NOT gate LOGIN, or existing accounts whose stored password is
 * shorter would be locked out.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters and include a letter, a number, and a symbol.';
const PASSWORD_LETTER_RE = /[A-Za-z]/;
const PASSWORD_DIGIT_RE = /[0-9]/;
// Symbol = non-alphanumeric AND non-whitespace. The whitespace set is the ASCII
// one (space \t \n \v \f \r) to match Postgres [:space:] in the server check
// EXACTLY -- JS \s additionally matches Unicode spaces, which would make the
// client stricter than the server for e.g. a non-breaking space.
const PASSWORD_SYMBOL_RE = /[^A-Za-z0-9 \t\n\v\f\r]/;

/** True when `pw` satisfies the P10a policy (mirror of the server check). */
export function isStrongPassword(pw: string): boolean {
  return (
    typeof pw === 'string' &&
    pw.length >= PASSWORD_MIN_LENGTH &&
    PASSWORD_LETTER_RE.test(pw) &&
    PASSWORD_DIGIT_RE.test(pw) &&
    PASSWORD_SYMBOL_RE.test(pw)
  );
}