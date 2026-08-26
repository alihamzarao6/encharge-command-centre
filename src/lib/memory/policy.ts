/**
 * Chunking policy (Stage 3 part 1) — pure. Decides WHICH message ranges of a conversation
 * get summarised now; nothing here touches a database or a model.
 *
 * Vocabulary. A conversation's messages have 1-based ORDINALS in (created_at, id) order —
 * every row counts, including future tool rows, so an ordinal never moves once assigned.
 * A chunk covers a half-open range [lo, hi) of ordinals; chunks tile the conversation from
 * ordinal 1 with no gaps and no overlap (the database refuses overlap — migration
 * 20260826010000). "Next ordinal" is the first ordinal no chunk covers.
 *
 * Two rules (decided 26 Aug, MEMORY.md):
 *
 *  1. SIZE — every complete window of `chunkMessages` uncovered messages becomes one
 *     chunk. Fires after a turn is saved. Constant cost per N messages (one Haiku call and
 *     one Voyage call per window), never re-summarises, never summarises mid-episode: the
 *     live end of the conversation is still in the verbatim history window (part 6 keeps
 *     the last 20 messages), so nothing is lost by waiting for the window to fill.
 *
 *  2. IDLE — an uncovered tail of at least `minTailMessages` whose newest SETTLED message
 *     is older than `idleHours` is a closed episode and becomes one (smaller) chunk. Fires
 *     on the next turn in that conversation or from the sweep. Without it a five-message
 *     conversation would never become memory; with it, nothing said is lost after a day.
 *     "Settled" excludes the `freshMessages` just appended by the turn that triggered the
 *     check — they are minutes old by definition and must not make the tail look live.
 *
 * `force` (the CLI flush) is the idle rule with a zero idle window and nothing fresh: the
 * whole uncovered tail, now, provided it is at least `minTailMessages` long.
 *
 * `maxChunksPerTrigger` bounds the money one turn can trigger: a 200-message backlog
 * (the conversations that exist before this part deploys) is caught up over several turns
 * or by the sweep, not in one burst.
 */
import { ValidationError, err, ok, type Result } from '../errors.js';
import type { MemoryPolicyConfig } from './config.js';

/** Half-open, 1-based: lo <= ordinal < hi. */
export interface MessageRange {
  readonly lo: number;
  readonly hi: number;
}

export interface PlanInput {
  /** Rows in the conversation, every role. */
  readonly messageCount: number;
  /** First ordinal no chunk covers; 1 when the conversation has no chunks. */
  readonly nextOrdinal: number;
  /** Messages at the end that the triggering turn just wrote; excluded from the idle rule. */
  readonly freshMessages: number;
  /** created_at of the newest settled uncovered message, when there is one. */
  readonly newestSettledAt: Date | null;
  readonly now: Date;
  /** The CLI flush: whole tail, now. */
  readonly force?: boolean;
}

export function planChunks(policy: MemoryPolicyConfig, input: PlanInput): readonly MessageRange[] {
  const plans: MessageRange[] = [];
  let lo = Math.max(1, input.nextOrdinal);
  const settledEnd = input.messageCount - Math.max(0, input.freshMessages); // last settled ordinal

  // Rule 1 — size.
  while (
    input.messageCount - lo + 1 >= policy.chunkMessages &&
    plans.length < policy.maxChunksPerTrigger
  ) {
    plans.push({ lo, hi: lo + policy.chunkMessages });
    lo += policy.chunkMessages;
  }

  // Rule 2 — idle (or force).
  const tail = settledEnd - lo + 1;
  if (tail >= policy.minTailMessages && plans.length < policy.maxChunksPerTrigger) {
    const staleBefore = new Date(input.now.getTime() - policy.idleHours * 3_600_000);
    const stale =
      input.force === true ||
      (input.newestSettledAt !== null && input.newestSettledAt.getTime() <= staleBefore.getTime());
    if (stale) {
      plans.push({ lo, hi: settledEnd + 1 });
    }
  }
  return plans;
}

/** Highest `hi` among existing chunks, or 1 — the first ordinal no chunk covers. */
export function nextUncoveredOrdinal(ranges: readonly MessageRange[]): number {
  let next = 1;
  for (const range of ranges) {
    if (range.hi > next) next = range.hi;
  }
  return next;
}

/** Postgres canonical form of an int4range, which is always `[lo,hi)`. */
export function formatInt4Range(range: MessageRange): string {
  return `[${range.lo},${range.hi})`;
}

const RANGE = /^([[(])\s*(-?\d+)?\s*,\s*(-?\d+)?\s*([\])])$/;

/**
 * Parse the text form PostgREST returns for an int4range. Postgres canonicalises discrete
 * ranges to `[lo,hi)`, but the parser accepts the inclusive/exclusive variants anyway so a
 * hand-written fixture cannot silently read as a different range.
 */
export function parseInt4Range(text: string): Result<MessageRange, ValidationError> {
  const trimmed = text.trim();
  if (trimmed === 'empty') {
    return err(new ValidationError('int4range is empty', [{ path: '', message: trimmed }]));
  }
  const match = RANGE.exec(trimmed);
  const loText = match?.[2];
  const hiText = match?.[3];
  if (match === null || loText === undefined || hiText === undefined) {
    return err(
      new ValidationError('int4range is unbounded or malformed', [{ path: '', message: trimmed }]),
    );
  }
  const lo = Number(loText) + (match[1] === '(' ? 1 : 0);
  const hi = Number(hiText) + (match[4] === ']' ? 1 : 0);
  if (!(Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo >= 1 && hi > lo)) {
    return err(
      new ValidationError('int4range bounds are not a valid message range', [
        { path: '', message: trimmed },
      ]),
    );
  }
  return ok({ lo, hi });
}
