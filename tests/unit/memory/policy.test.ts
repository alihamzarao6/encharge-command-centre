/**
 * Chunking policy (src/lib/memory/policy.ts) — the Part A trigger decision as arithmetic.
 */
import { describe, expect, it } from 'vitest';

import { POLICY_DEFAULTS } from '../../../src/lib/memory/config.js';
import {
  formatInt4Range,
  nextUncoveredOrdinal,
  parseInt4Range,
  planChunks,
} from '../../../src/lib/memory/policy.js';

const NOW = new Date('2026-08-26T10:00:00Z');
const YESTERDAY = new Date('2026-08-25T09:00:00Z'); // 25 h ago: idle
const RECENT = new Date('2026-08-26T09:30:00Z'); // 30 min ago: live

describe('planChunks — size rule', () => {
  it('does nothing below the window', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 9,
        nextOrdinal: 1,
        freshMessages: 2,
        newestSettledAt: RECENT,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('exactly one window → exactly one chunk with the right range', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 10,
        nextOrdinal: 1,
        freshMessages: 2,
        newestSettledAt: RECENT,
        now: NOW,
      }),
    ).toEqual([{ lo: 1, hi: 11 }]);
  });

  it('tiles from the previous chunk, never re-covering', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 24,
        nextOrdinal: 11,
        freshMessages: 2,
        newestSettledAt: RECENT,
        now: NOW,
      }),
    ).toEqual([{ lo: 11, hi: 21 }]);
  });

  it('caps a backlog at maxChunksPerTrigger', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 200,
        nextOrdinal: 1,
        freshMessages: 2,
        newestSettledAt: YESTERDAY,
        now: NOW,
      }),
    ).toEqual([
      { lo: 1, hi: 11 },
      { lo: 11, hi: 21 },
      { lo: 21, hi: 31 },
    ]);
  });
});

describe('planChunks — idle rule', () => {
  it('a live short tail is left alone (the fresh turn never makes it look idle)', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 6,
        nextOrdinal: 1,
        freshMessages: 2,
        newestSettledAt: RECENT,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('a settled tail older than idleHours becomes one chunk, excluding the fresh turn', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 6,
        nextOrdinal: 1,
        freshMessages: 2,
        newestSettledAt: YESTERDAY,
        now: NOW,
      }),
    ).toEqual([{ lo: 1, hi: 5 }]);
  });

  it('a settled tail below minTailMessages is not memory', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 3,
        nextOrdinal: 1,
        freshMessages: 2,
        newestSettledAt: YESTERDAY,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('size and idle compose: full windows first, then the stale remainder', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 14,
        nextOrdinal: 1,
        freshMessages: 0,
        newestSettledAt: YESTERDAY,
        now: NOW,
      }),
    ).toEqual([
      { lo: 1, hi: 11 },
      { lo: 11, hi: 15 },
    ]);
  });

  it('idle boundary is inclusive at exactly idleHours', () => {
    const exactly = new Date(NOW.getTime() - POLICY_DEFAULTS.idleHours * 3_600_000);
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 4,
        nextOrdinal: 1,
        freshMessages: 0,
        newestSettledAt: exactly,
        now: NOW,
      }),
    ).toEqual([{ lo: 1, hi: 5 }]);
  });

  it('force summarises the whole tail now, whatever its age', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 4,
        nextOrdinal: 1,
        freshMessages: 0,
        newestSettledAt: RECENT,
        now: NOW,
        force: true,
      }),
    ).toEqual([{ lo: 1, hi: 5 }]);
  });

  it('nothing uncovered → nothing planned', () => {
    expect(
      planChunks(POLICY_DEFAULTS, {
        messageCount: 10,
        nextOrdinal: 11,
        freshMessages: 0,
        newestSettledAt: null,
        now: NOW,
        force: true,
      }),
    ).toEqual([]);
  });
});

describe('ranges', () => {
  it('nextUncoveredOrdinal is the highest upper bound, or 1', () => {
    expect(nextUncoveredOrdinal([])).toBe(1);
    expect(
      nextUncoveredOrdinal([
        { lo: 11, hi: 21 },
        { lo: 1, hi: 11 },
      ]),
    ).toBe(21);
  });

  it('formats the Postgres canonical form', () => {
    expect(formatInt4Range({ lo: 1, hi: 11 })).toBe('[1,11)');
  });

  it('parses canonical and non-canonical text forms to the same range', () => {
    expect(parseInt4Range('[1,11)')).toEqual({ ok: true, value: { lo: 1, hi: 11 } });
    expect(parseInt4Range('[1,10]')).toEqual({ ok: true, value: { lo: 1, hi: 11 } });
    expect(parseInt4Range('(0,11)')).toEqual({ ok: true, value: { lo: 1, hi: 11 } });
  });

  it('refuses empty, unbounded and inverted ranges', () => {
    for (const bad of ['empty', '[,11)', '[1,)', '[11,1)', '[0,5)', 'nonsense', '[1,1)']) {
      const result = parseInt4Range(bad);
      expect(result.ok, bad).toBe(false);
    }
  });
});
