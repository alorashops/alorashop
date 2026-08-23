/** Shared helpers — money, ids, dates, paging. */

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when shopId is a real Supabase shop uuid — the only shop that can sync. */
export function isCloudShopId(shopId?: string | null): boolean {
  return typeof shopId === 'string' && UUID_RE.test(shopId);
}

/** Sequential receipt number per shop per day: SHOP-YYYYMMDD-0001 */
export function makeReceiptNumber(shopId: string, date = new Date()): string {
  const ymd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('');
  const seq = Math.floor(Math.random() * 9000) + 1000; // overwritten by counter for true sequence
  return `${shopId.slice(0, 6).toUpperCase()}-${ymd}-${seq}`;
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