/**
 * The refresh cooldown (Milestone 4 part 3, item 10), pure half: how long until a run may
 * start, measured from the end of the last one, and the sentence that says so.
 */
import { describe, expect, it } from 'vitest';

import {
  SYNC_COOLDOWN_MS,
  cooldownRemainingMs,
  describeCooldown,
} from '../../../src/lib/crm/cooldown.js';

const NOW = Date.parse('2026-09-14T02:00:00Z');
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe('cooldownRemainingMs', () => {
  it('no run ever → no wait', () => {
    expect(cooldownRemainingMs(null, NOW)).toBe(0);
  });

  it('counts from when the last run FINISHED, whatever its outcome', () => {
    const run = { started_at: at(90_000), finished_at: at(20_000) };
    expect(cooldownRemainingMs(run, NOW)).toBe(SYNC_COOLDOWN_MS - 20_000);
  });

  it('is exactly zero at the end of the window and stays zero after it', () => {
    expect(
      cooldownRemainingMs({ started_at: at(70_000), finished_at: at(SYNC_COOLDOWN_MS) }, NOW),
    ).toBe(0);
    expect(
      cooldownRemainingMs({ started_at: at(2 * 3_600_000), finished_at: at(3_600_000) }, NOW),
    ).toBe(0);
  });

  it('a run with no end yet counts from its start (the running slot refuses the overlap anyway)', () => {
    expect(cooldownRemainingMs({ started_at: at(10_000), finished_at: null }, NOW)).toBe(50_000);
    // Stalled long ago: aged out; the next start retires it as stale.
    expect(cooldownRemainingMs({ started_at: at(20 * 60_000), finished_at: null }, NOW)).toBe(0);
  });

  it('a shorter window can be asked for, and a garbage date never throws', () => {
    expect(cooldownRemainingMs({ started_at: at(4_000), finished_at: at(3_000) }, NOW, 5_000)).toBe(
      2_000,
    );
    expect(cooldownRemainingMs({ started_at: 'not a date', finished_at: null }, NOW)).toBe(0);
    expect(cooldownRemainingMs({ started_at: at(1_000), finished_at: 'nope' }, NOW)).toBe(59_000);
  });
});

describe('describeCooldown', () => {
  it('says how long ago and how long to wait, in whole seconds, rounding the wait up', () => {
    expect(describeCooldown(40_200)).toEqual({
      message: 'The pipeline was refreshed 19 seconds ago. You can refresh again in 41 seconds.',
      retryAfterSeconds: 41,
    });
  });

  it('"just now" inside the first seconds; never "0 seconds"; the singular second', () => {
    expect(describeCooldown(59_500).message).toMatch(
      /refreshed just now\. You can refresh again in 60 seconds/,
    );
    expect(describeCooldown(400)).toEqual({
      message: 'The pipeline was refreshed 59 seconds ago. You can refresh again in 1 second.',
      retryAfterSeconds: 1,
    });
  });
});
