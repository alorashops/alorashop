import { uid } from './utils';

/**
 * Idempotency keys guarantee a sale / ledger entry can never be double-submitted.
 * The key is generated once when the transaction first lands in IndexedDB and
 * reused for every outbox retry — the cloud layer upserts by this key.
 */
export function newIdempotencyKey(entity: 'SALE' | 'LEDGER' | 'RESTOCK' | 'VOID' | 'SUMMARY'): string {
  return `${entity.toLowerCase()}_${Date.now().toString(36)}_${uid().slice(0, 8)}`;
}

export function isRetryableError(_err: unknown): boolean {
  // Network-ish errors are retryable; validation errors are not.
  const msg = String(_err instanceof Error ? _err.message : _err).toLowerCase();
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
