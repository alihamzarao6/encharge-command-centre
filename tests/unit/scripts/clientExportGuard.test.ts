import { describe, expect, it } from 'vitest';

import {
  EMPTY_STATE,
  assess,
  parseState,
  remember,
  type ClientCommit,
  type ClientSide,
  type GuardState,
} from '../../../scripts/client-export/guard.js';

const T = (n: number): string => n.toString(16).padStart(40, '0');
const AT = new Date('2026-10-18T00:00:00Z');
const commit = (n: number, tree: string, subject = `c${String(n)}`): ClientCommit => ({
  sha: `s${String(n)}`,
  tree,
  author: 'someone',
  subject,
});
const side = (over: Partial<ClientSide> = {}): ClientSide => ({
  remoteTree: T(1),
  headTree: T(1),
  workTree: T(1),
  commits: [commit(1, T(1))],
  ...over,
});
const knowing = (...trees: string[]): GuardState => remember(EMPTY_STATE, trees, 'export', 'h', AT);

describe('assess', () => {
  it('clean: GitHub, the clone and its files all hold a tree the export wrote', () => {
    expect(assess(knowing(T(1)), side())).toEqual({ kind: 'clean' });
  });

  it('clean: an export synced but not yet committed (files = the newest export, HEAD = older)', () => {
    expect(assess(knowing(T(1), T(2)), side({ workTree: T(2) }))).toEqual({ kind: 'clean' });
  });

  it('DRIFT: a hotfix committed on GitHub — names it, and the base to diff it against', () => {
    const verdict = assess(
      knowing(T(1)),
      side({
        remoteTree: T(9),
        commits: [commit(3, T(9), 'hotfix: rate typo'), commit(2, T(8)), commit(1, T(1))],
      }),
    );
    expect(verdict).toEqual({
      kind: 'drift',
      where: ['github'],
      foreign: [commit(3, T(9), 'hotfix: rate typo'), commit(2, T(8))],
      base: 's1',
    });
  });

  it('DRIFT: a commit made in the clone and not pushed', () => {
    const verdict = assess(knowing(T(1)), side({ headTree: T(5), workTree: T(5) }));
    expect(verdict.kind === 'drift' && verdict.where).toEqual(['clone HEAD', 'clone files']);
  });

  it('DRIFT: files edited in the clone and never committed — the sync would delete them', () => {
    const verdict = assess(knowing(T(1)), side({ workTree: T(6) }));
    expect(verdict.kind === 'drift' && verdict.where).toEqual(['clone files']);
  });

  it('bootstrap only when nothing is recorded AND the clone agrees with GitHub', () => {
    expect(assess(EMPTY_STATE, side())).toEqual({ kind: 'bootstrap', tree: T(1) });
  });

  it('first run with a local edit: refused, and reported against GitHub — not all its history', () => {
    expect(assess(EMPTY_STATE, side({ workTree: T(2) }))).toEqual({
      kind: 'drift',
      where: ['clone files'],
      foreign: [],
      base: 's1',
    });
  });

  it('a drift with no known ancestor has no base (history rewritten on GitHub)', () => {
    const verdict = assess(knowing(T(1)), side({ remoteTree: T(7), commits: [commit(7, T(7))] }));
    expect(verdict.kind === 'drift' && verdict.base).toBeNull();
  });

  it('accepting the remote after porting the fix makes the same side clean', () => {
    const drifted = side({ remoteTree: T(9), headTree: T(9), workTree: T(9) });
    const accepted = remember(knowing(T(1)), [T(9)], 'accepted', 'h2', AT);
    expect(assess(accepted, drifted)).toEqual({ kind: 'clean' });
  });
});

describe('state', () => {
  it('round-trips, and remembers each tree once', () => {
    const state = remember(knowing(T(1)), [T(1), T(2), T(2)], 'export', 'h', AT);
    expect(state.known.map((k) => k.tree)).toEqual([T(1), T(2)]);
    expect(parseState(JSON.stringify(state))).toEqual(state);
  });

  it('keeps the newest hundred', () => {
    let state = EMPTY_STATE;
    for (let i = 1; i <= 120; i += 1) state = remember(state, [T(i)], 'export', 'h', AT);
    expect(state.known).toHaveLength(100);
    expect(state.known[0]?.tree).toBe(T(21));
  });

  it('no file is an empty state; a broken or foreign file is refused, never guessed', () => {
    expect(parseState(null)).toEqual(EMPTY_STATE);
    expect(() => parseState('{')).toThrow(/not JSON/);
    expect(() => parseState('{"version":2,"known":[]}')).toThrow(/unknown shape/);
  });

  it('drops entries that are not tree hashes', () => {
    const raw = JSON.stringify({ version: 1, known: [{ tree: 'nope' }, { tree: T(3) }] });
    expect(parseState(raw).known.map((k) => k.tree)).toEqual([T(3)]);
  });
});
