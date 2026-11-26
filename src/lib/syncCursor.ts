/**
 * Delta-pull cursor math — the pure, dependency-free core of `pullDelta`.
 *
 * WHY this is not `max(applied.updatedAt)`:
 * `updated_at` is the delta watermark. Advancing ONE device-wide cursor to the
 * newest value we happened to apply has two skip traps:
 *
 *  1. CLOCK SKEW — `updated_at` is (historically) the writing device's own
 *     `Date.now()`. If that clock is ahead, its row pushes every other device's
 *     cursor into the future; rows written afterwards by correct-clock devices
 *     are then below the cursor and never pulled again. A slow clock is the
 *     mirror image: a NEW row stamped in the past sits below a cursor that has
 *     already moved past it and is invisible forever. An append-only
 *     `stock_ledger` row skipped once is never re-pushed, so the derived stock
 *     silently diverges per device.
 *
 *  2. MID-PULL RACE — even with perfect clocks, a row written to a table whose
 *     query already ran this cycle, with a timestamp below another table's
 *     newer max, is skipped permanently (same reason).
 *
 * FIX: cap the cursor at a SERVER "boundary" sampled BEFORE the pull starts.
 * With `updated_at` server-assigned (migration 42 trigger), any row written
 * after the boundary has a strictly newer stamp and is always picked up next
 * cycle, while any row written before the boundary was necessarily visible to
 * this pull's queries (they all run after the boundary). No row can be skipped.
 *
 * A row we could NOT apply (malformed / unknown entity) must stay strictly
 * above the new cursor so the next pull retries it — hence the cap is lowered
 * to `(that row's updatedAt - 1)`.
 *
 * The watermark is MONOTONIC: it never moves backwards.
 */

export interface TickedRow {
  updatedAt: number;
}

/**
 * The next device cursor. `boundary` is the server time (epoch ms) sampled at
 * the start of the pull; `unapplied` are the pulled rows that were deliberately
 * NOT written (malformed / unknown type) and must be re-pulled next cycle.
 */
export function advanceCursor(
  current: number,
  boundary: number,
  unapplied: TickedRow[] = []
): number {
  let next = Number.isFinite(boundary) ? boundary : current;
  for (const row of unapplied) {
    const t = Number(row?.updatedAt);
    // Strictly below the row so `gt(updated_at, cursor)` fetches it again.
    if (Number.isFinite(t)) next = Math.min(next, t - 1);
  }
  return Math.max(current, next);
}

/**
 * The legacy cursor rule (newest applied value) — kept ONLY so the verifier can
 * demonstrate the skip it causes. Production MUST use {@link advanceCursor}.
 */
export function legacyAdvanceCursor(current: number, applied: TickedRow[]): number {
  return applied.reduce((m, c) => Math.max(m, c.updatedAt), current);
}
