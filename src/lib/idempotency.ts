import { uid } from './utils';

/**
 * Extracts a human-readable message from any thrown value without ever
 * degrading to "[object Object]".
 *
 * Supabase errors are plain objects (PostgrestError `{ message, details, hint,
 * code, ... }`) — NOT `Error` subclasses — so `String(err)` yields
 * "[object Object]" and the real failure reason is destroyed before it can be
 * surfaced (Batch 1 / Finding: "[object Object]" in "Last sync error").
 *
 * Order of preference:
 *   1. `Error.message`                           (native / app errors)
 *   2. `[{ message }]` array                     (Supabase `.values()` / 406 shape)
 *   3. `.message`                                (PostgrestError & any object)
 *   4. `.details`                                (more specific than the object itself)
 *   5. JSON string with a `"message"` field      (stringified PostgrestError)
 *   6. JSON string fallback in general, then raw String().
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') {
    try {
      const parsed: unknown = JSON.parse(err);
      const msg = extractMessage(parsed);
      if (msg) return msg;
    } catch {
      /* not JSON — just a string */
    }
    return err;
  }
  const msg = extractMessage(err);
  return msg || String(err) || 'Unknown sync error';
}

function extractMessage(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const m = extractMessage(item);
      if (m) return m;
    }
    return undefined;
  }
  if (typeof value !== 'object') {
    const s = String(value);
    return s ? s : undefined;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.message === 'string' && rec.message) return rec.message;
  if (typeof rec.details === 'string' && rec.details) return rec.details;
  if (typeof rec.hint === 'string' && rec.hint) return rec.hint;
  if (typeof rec.error === 'string' && rec.error) return rec.error;
  return undefined;
}

/**
 * Idempotency keys guarantee a sale / ledger entry can never be double-submitted.
 * The key is generated once when the transaction first lands in PGlite and
 * reused for every outbox retry — the cloud layer upserts by this key.
 *
 * P11b (SECURITY_PLAN.md): the random part is the FULL crypto uuid rendered as
 * 32 hex chars (128 bits). It used to be `uid().slice(0, 8)` — only 8 hex chars
 * (32 bits), which looked safe solely because `uid()` was assumed strong. The
 * key is opaque and unconstrained server-side (stored as
 * `data.__idempotency_key`), so widening it needs no migration.
 */
export function newIdempotencyKey(entity: 'SALE' | 'LEDGER' | 'RESTOCK' | 'VOID' | 'SUMMARY'): string {
  return `${entity.toLowerCase()}_${Date.now().toString(36)}_${uid().replace(/-/g, '')}`;
}

export function isRetryableError(_err: unknown): boolean {
  // Network-ish errors are retryable; validation errors are not. Resolve via
  // the same helper as the surfaced message so the retry decision sees the
  // REAL message (a plain-object error previously String()'d to "[object Object]"
  // and failed every keyword check — misclassifying permanent errors as retryable).
  const msg = errorMessage(_err).toLowerCase();
  return (
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('unavailable') ||
    msg.includes('timeout') ||
    msg.includes('fetch') ||
    msg.includes('quota') ||
    msg.includes('not configured')
  );
}
