/**
 * What every mirror screen says about the data it shows (Milestone 4 part 3, carried over
 * from the overview so the leads screen says exactly the same things): the freshness line,
 * the Refresh control with its cooldown, and the sentences for a run in progress, a stuck
 * run, a failed or partial last run and a capped read. A client reading a list of leads must
 * know if it is a day old, in the same words the overview uses.
 *
 * Colour is never the only carrier: freshness has a word for screen readers, a dot for the
 * eye and the age in words; every state is a sentence.
 */
import type { ReactElement, ReactNode } from 'react';

import { formatCount, type Freshness, type SyncState } from '../lib/overviewView.js';

export function FreshnessLine({
  freshness,
}: {
  readonly freshness: Freshness;
}): ReactElement | null {
  if (freshness.kind === 'never') return null;
  const { tone, label, at } = freshness;
  const word = tone === 'fresh' ? 'Current' : tone === 'stale' ? 'Ageing' : 'Old';
  return (
    <p className={`fresh fresh--${tone}`} role="status" title={at}>
      <span className="fresh__dot" aria-hidden="true" />
      <span className="sr-only">{word}: </span>
      {label}
      {tone === 'old' && <span className="fresh__nudge"> — refresh before you rely on these</span>}
    </p>
  );
}

interface RefreshProps {
  readonly refreshing: boolean;
  readonly running: boolean;
  /** Milliseconds before the server would accept another refresh; 0 = now. */
  readonly cooldownMs: number;
  readonly onRefresh: () => void;
  readonly className?: string;
}

/**
 * Disabled while a run is in progress and while the cooldown counts down — with the count
 * beside it, so a disabled button is never a mystery. The server enforces the same window;
 * the button only stops the person asking for something that would be refused.
 */
export function RefreshControl({
  refreshing,
  running,
  cooldownMs,
  onRefresh,
  className = '',
}: RefreshProps): ReactElement {
  const cooling = !refreshing && !running && cooldownMs > 0;
  const seconds = Math.ceil(cooldownMs / 1_000);
  return (
    <>
      <button
        className={`button button--primary button--small overview__refresh ${className}`.trim()}
        type="button"
        disabled={refreshing || running || cooling}
        aria-busy={refreshing || running}
        onClick={onRefresh}
      >
        {refreshing ? 'Refreshing…' : running ? 'Refresh running…' : 'Refresh'}
      </button>
      {cooling && (
        <span className="fresh__cooldown" role="status">
          Next refresh in {seconds} s
        </span>
      )}
    </>
  );
}

interface NoticesProps {
  readonly sync: SyncState;
  readonly ready: boolean;
  readonly capped: boolean;
  readonly limit: number;
  /** "open leads" — what the capped read was of. */
  readonly cappedNoun: string;
}

export function SyncNotices({
  sync,
  ready,
  capped,
  limit,
  cappedNoun,
}: NoticesProps): ReactElement {
  return (
    <>
      {sync.running && (
        <p className="overview__running" role="status" aria-live="polite">
          <span className="dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          Refreshing from GoHighLevel… the numbers below are from the last refresh until it
          finishes.
        </p>
      )}
      {sync.stuck && (
        <p className="notice overview__notice" role="status">
          A refresh started {sync.lastRun === null ? 'earlier' : 'a while ago'} and did not finish.
          Refresh again.
        </p>
      )}
      {ready && sync.lastFailed && (
        <p className="overview__alert" role="alert">
          <strong>The last refresh failed</strong>
          {sync.lastRun?.errorCode != null && ` (${sync.lastRun.errorCode})`}, so these numbers may
          be behind GoHighLevel.{' '}
          {sync.lastRun?.errorCode === 'UNAUTHENTICATED'
            ? 'GoHighLevel rejected our access key — it needs replacing on the server.'
            : 'Try again; if it keeps failing, the run needs looking at.'}
        </p>
      )}
      {ready && sync.lastPartial && (
        <p className="notice overview__notice" role="status">
          The last refresh could not read {formatCount(sync.contactsUnread)} contact
          {sync.contactsUnread === 1 ? '' : 's'} from GoHighLevel. Their leads are counted; their
          names may be missing or out of date below.
        </p>
      )}
      {capped && (
        <p className="notice overview__notice" role="status">
          Only the first {formatCount(limit)} {cappedNoun} were read, so the counts may be short.
        </p>
      )}
    </>
  );
}

interface NotSetUpProps {
  readonly sync: SyncState;
  readonly children: ReactNode;
  readonly refresh: ReactNode;
}

/** No sync has ever written rows: "not set up yet", never zero leads, never broken. */
export function NotSetUp({ sync, children, refresh }: NotSetUpProps): ReactElement {
  return (
    <div className="card overview__empty">
      <h2 className="overview__empty-title">Not set up yet</h2>
      {children}
      {sync.lastFailed && (
        <p className="error" role="alert">
          The first refresh failed
          {sync.lastRun?.errorCode != null && ` (${sync.lastRun.errorCode})`}.
          {sync.lastRun?.errorCode === 'UNAUTHENTICATED'
            ? ' GoHighLevel rejected our access key — it needs replacing on the server.'
            : ' Try again; if it keeps failing, the run needs looking at.'}
        </p>
      )}
      <div className="mem__row">{refresh}</div>
    </div>
  );
}
