/**
 * The minimum interval between two GoHighLevel refreshes (Milestone 4 part 3, item 10).
 *
 * The same Private Integration token that serves these reads serves the client's live lead
 * flow, and GoHighLevel allows 100 requests per 10 seconds on it. A refresh is a dozen
 * requests for today's pipeline and grows with it; two people holding the button down could
 * rate-limit the account and stall real leads. So a run may not start until this long after
 * the previous run ENDED — whatever that run's outcome was, because hammering a GoHighLevel
 * that is refusing us is exactly the case to prevent.
 *
 * Shared by the endpoint (which enforces it — a disabled button is not a limit) and the
 * browser (which disables the button and counts down so the refusal is never a surprise),
 * the way memory/access.ts is imported by both. Pure; the clock is a parameter.
 */

export const SYNC_COOLDOWN_MS = 60_000;

export interface CooldownRun {
  readonly started_at: string;
  /** Null while the run is in progress, or if it never finished. */
  readonly finished_at: string | null;
}

function parse(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Milliseconds until a new run may start, 0 when it may start now. A run that is still
 * `running` has no end yet, so it counts from its start — the database's own one-running-slot
 * rule refuses the overlap regardless, and a run that stalled long ago has aged out of the
 * window and will be retired as stale by the next start.
 */
export function cooldownRemainingMs(
  lastRun: CooldownRun | null,
  nowMs: number,
  cooldownMs: number = SYNC_COOLDOWN_MS,
): number {
  if (lastRun === null) return 0;
  const ended = parse(lastRun.finished_at) ?? parse(lastRun.started_at);
  if (ended === null) return 0;
  return Math.max(0, ended + cooldownMs - nowMs);
}

/** "The pipeline was refreshed 20 seconds ago. You can refresh again in 40 seconds." */
export function describeCooldown(
  remainingMs: number,
  cooldownMs: number = SYNC_COOLDOWN_MS,
): {
  readonly message: string;
  readonly retryAfterSeconds: number;
} {
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1_000));
  const agoSeconds = Math.max(0, Math.floor((cooldownMs - remainingMs) / 1_000));
  const ago = agoSeconds < 5 ? 'just now' : `${String(agoSeconds)} seconds ago`;
  return {
    message: `The pipeline was refreshed ${ago}. You can refresh again in ${String(retryAfterSeconds)} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    retryAfterSeconds,
  };
}
