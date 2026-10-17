/**
 * The drift guard: the export REPLACES every file in the client's repository, so a change made
 * there directly (a hotfix, an edit on GitHub, another developer) would be silently undone by the
 * next export. Before syncing, every tree the client side holds — what is on GitHub, the clone's
 * HEAD, the clone's working files — must be one this tool wrote or one a person has accepted
 * after porting it here. Pure: git trees in, a verdict out; the git calls live in export.ts.
 *
 * Trees, not commits, are compared: the person commits the export themselves, so the commit is
 * not ours to know, but its tree is exactly the tree the export left in the working directory.
 */

export type KnownSource = 'export' | 'accepted' | 'bootstrap';

export interface KnownTree {
  readonly tree: string;
  readonly source: KnownSource;
  readonly at: string;
  /** This repository's HEAD when the tree was written or accepted. */
  readonly head: string;
}

export interface GuardState {
  readonly version: 1;
  readonly known: readonly KnownTree[];
}

/** A commit on the client side, newest first, as `git log --format='%H %T %an %s'` gives it. */
export interface ClientCommit {
  readonly sha: string;
  readonly tree: string;
  readonly author: string;
  readonly subject: string;
}

export interface ClientSide {
  readonly remoteTree: string;
  readonly headTree: string;
  readonly workTree: string;
  /** Commits reachable from the remote and from HEAD, newest first, de-duplicated. */
  readonly commits: readonly ClientCommit[];
}

export type Verdict =
  | { readonly kind: 'clean' }
  | { readonly kind: 'bootstrap'; readonly tree: string }
  | {
      readonly kind: 'drift';
      /** Which of the three places holds something unknown. */
      readonly where: readonly ('github' | 'clone HEAD' | 'clone files')[];
      /** Commits newer than the last commit whose tree is known — the ones to port. */
      readonly foreign: readonly ClientCommit[];
      /** The newest commit whose tree is known: the base to diff the foreign work against. */
      readonly base: string | null;
    };

const KEEP = 100;

export const EMPTY_STATE: GuardState = { version: 1, known: [] };

export function parseState(raw: string | null): GuardState {
  if (raw === null) return EMPTY_STATE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('client-export state is not JSON; refusing to guess what was exported');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { known?: unknown }).known)
  ) {
    throw new Error('client-export state has an unknown shape; refusing to guess');
  }
  const known = (value as { known: unknown[] }).known.filter(
    (k): k is KnownTree =>
      typeof k === 'object' &&
      k !== null &&
      typeof (k as KnownTree).tree === 'string' &&
      /^[0-9a-f]{40}$/.test((k as KnownTree).tree),
  );
  return { version: 1, known };
}

export function remember(
  state: GuardState,
  trees: readonly string[],
  source: KnownSource,
  head: string,
  at: Date,
): GuardState {
  const have = new Set(state.known.map((k) => k.tree));
  const added = [...new Set(trees)]
    .filter((tree) => !have.has(tree))
    .map((tree) => ({ tree, source, head, at: at.toISOString() }));
  return { version: 1, known: [...state.known, ...added].slice(-KEEP) };
}

export function assess(state: GuardState, side: ClientSide): Verdict {
  const known = new Set(state.known.map((k) => k.tree));
  if (known.size === 0) {
    // First run of the guard: nothing was recorded, so what is on GitHub is the baseline —
    // adopted only when the clone agrees with it, so local edits are never adopted, and used
    // to report a disagreement against (rather than calling all of GitHub's history foreign).
    if (side.headTree === side.remoteTree && side.workTree === side.remoteTree) {
      return { kind: 'bootstrap', tree: side.remoteTree };
    }
    known.add(side.remoteTree);
  }
  const where: ('github' | 'clone HEAD' | 'clone files')[] = [];
  if (!known.has(side.remoteTree)) where.push('github');
  if (!known.has(side.headTree)) where.push('clone HEAD');
  if (!known.has(side.workTree)) where.push('clone files');
  if (where.length === 0) return { kind: 'clean' };

  const foreign: ClientCommit[] = [];
  let base: string | null = null;
  for (const commit of side.commits) {
    if (known.has(commit.tree)) {
      base = commit.sha;
      break;
    }
    foreign.push(commit);
  }
  return { kind: 'drift', where, foreign, base };
}
