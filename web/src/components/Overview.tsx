/**
 * The screen the app opens on (Milestone 4 part 2): the client's numbers, read from the
 * Milestone 4 part 1 mirror of GoHighLevel under RLS as the signed-in person. Every figure
 * is a row (web/src/lib/overviewView.ts says which); nothing here is live from GoHighLevel,
 * and the screen says so — "Updated 12 minutes ago", louder the older it gets — because a
 * synced copy believed to be current is how a week-old number gets acted on.
 *
 * The one write is Refresh: a POST to our crm endpoint, which reads GoHighLevel on the
 * server and rewrites the mirror; this screen then re-reads it. While a run is in progress
 * the screen keeps its numbers and polls the run row until the run finishes, so a refresh
 * started here, from the command line, or from a colleague's screen all end the same way.
 *
 * States, each deliberately distinct (Part C): never synced reads as "not set up yet", never
 * as zero leads; a stage with nothing in it is a zero on the list; a failed or partial last
 * run is a sentence above the numbers; a read that failed is a retry, not a blank; a 401 is
 * the login screen, never an empty dashboard that looks like data loss.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { callCrm, type CrmOutcome } from '../lib/crmApi.js';
import { webConfig } from '../lib/env.js';
import {
  ARRIVALS_SHOWN,
  OVERVIEW_OPPORTUNITY_LIMIT,
  buildOverview,
  formatCount,
  type OverviewInput,
  type OverviewView,
} from '../lib/overviewView.js';
import { supabase } from '../lib/supabase.js';

interface Props {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
}

type Banner = { readonly tone: 'ok' | 'warn'; readonly text: string } | null;

/** How often the run row is re-read while a refresh is in progress. */
const POLL_MS = 4_000;
/** How often "x minutes ago" is recomputed while the screen is open. */
const TICK_MS = 60_000;

/**
 * Every read on this screen, together. A 401 from PostgREST means the session is gone —
 * supabase-js will have tried to refresh it already — and the right answer is the login
 * screen with the message, not a dashboard of zeros.
 */
async function readOverview(): Promise<
  { kind: 'ok'; input: OverviewInput } | { kind: 'unauthenticated' } | { kind: 'error' }
> {
  const [pipelines, stages, opportunities, runs] = await Promise.all([
    supabase.from('ghl_pipelines').select('ghl_id, name, last_changed_at').limit(20),
    supabase
      .from('ghl_stages')
      .select('ghl_id, pipeline_ghl_id, name, position, removed_at')
      .limit(500),
    supabase
      .from('ghl_opportunities')
      .select(
        'ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, ghl_created_at, removed_at',
      )
      .is('removed_at', null)
      .eq('status', 'open')
      .limit(OVERVIEW_OPPORTUNITY_LIMIT),
    supabase
      .from('ghl_sync_runs')
      .select(
        'id, pipeline_ghl_id, status, started_at, applied_at, finished_at, error_code, contacts_failed, contacts_missing, contacts_rejected, opportunities_rejected',
      )
      .order('started_at', { ascending: false })
      .limit(5),
  ]);
  const answers = [pipelines, stages, opportunities, runs];
  if (answers.some((a) => a.status === 401)) return { kind: 'unauthenticated' };
  if (
    pipelines.error !== null ||
    stages.error !== null ||
    opportunities.error !== null ||
    runs.error !== null
  ) {
    return { kind: 'error' };
  }

  // The contacts behind the arrivals only: the screen names five people, not the pipeline.
  const newest = [...opportunities.data]
    .sort((a, b) => (b.ghl_created_at ?? '').localeCompare(a.ghl_created_at ?? ''))
    .slice(0, ARRIVALS_SHOWN)
    .map((o) => o.contact_ghl_id)
    .filter((id): id is string => id !== null);
  const contacts =
    newest.length === 0
      ? { data: [], error: null, status: 200 }
      : await supabase
          .from('ghl_contacts')
          .select('ghl_id, full_name, first_name, last_name, removed_at')
          .in('ghl_id', newest)
          .limit(ARRIVALS_SHOWN);
  if (contacts.status === 401) return { kind: 'unauthenticated' };
  if (contacts.error !== null) return { kind: 'error' };

  return {
    kind: 'ok',
    input: {
      pipelines: pipelines.data,
      stages: stages.data,
      opportunities: opportunities.data,
      contacts: contacts.data,
      runs: runs.data,
      opportunityLimit: OVERVIEW_OPPORTUNITY_LIMIT,
    },
  };
}

function refreshBanner(outcome: CrmOutcome): Banner {
  if (outcome.kind === 'ok') {
    const { reply } = outcome;
    if (reply.status === 'partial') {
      return {
        tone: 'warn',
        text: `Refreshed, but ${formatCount(reply.contactsUnread)} contact${reply.contactsUnread === 1 ? '' : 's'} could not be read from GoHighLevel. Their leads are counted; their names may be out of date.`,
      };
    }
    return {
      tone: 'ok',
      text: `Refreshed from GoHighLevel: ${formatCount(reply.opportunitiesFetched)} open lead${reply.opportunitiesFetched === 1 ? '' : 's'} read.`,
    };
  }
  return { tone: 'warn', text: outcome.message };
}

function FreshnessLine({ view }: { readonly view: OverviewView }): ReactElement | null {
  if (view.freshness.kind === 'never') return null;
  const { tone, label, at } = view.freshness;
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

function Skeleton(): ReactElement {
  return (
    <div className="overview__body" aria-busy="true" aria-live="polite">
      <p className="sr-only">Loading your pipeline…</p>
      <div className="tiles">
        <div className="card tile tile--skeleton" />
        <div className="card tile tile--skeleton" />
      </div>
      <div className="card overview__stages overview__stages--skeleton" />
      <div className="card overview__arrivals overview__arrivals--skeleton" />
    </div>
  );
}

export function Overview({ session, onSessionExpired }: Props): ReactElement {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [view, setView] = useState<OverviewView | null>(null);
  const [input, setInput] = useState<OverviewInput | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<OverviewView | null> => {
    const read = await readOverview();
    if (!alive.current) return null;
    if (read.kind === 'unauthenticated') {
      await onSessionExpired();
      return null;
    }
    if (read.kind === 'error') {
      // Whatever was on screen stays: a failed re-read must not blank a dashboard that was
      // fine a second ago. Only a first read with nothing to show is the error state.
      setState((current) => (current === 'ready' ? current : 'error'));
      setBanner({
        tone: 'warn',
        text: "Couldn't read your pipeline. Check your connection and retry.",
      });
      return null;
    }
    const at = Date.now();
    const built = buildOverview(read.input, at);
    setInput(read.input);
    setView(built);
    setNow(at);
    setState('ready');
    return built;
  }, [onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  // "12 minutes ago" is only true for a minute; the input is unchanged, the clock is not.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (input !== null) setView(buildOverview(input, now));
  }, [input, now]);

  // Coming back to the tab re-reads: a refresh from elsewhere lands without a tap here.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // While a run is in progress the run row is polled until it is not.
  const running = view?.sync.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setBanner(null);
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token ?? session.access_token;
    const outcome = await callCrm(
      { crmUrl: webConfig.crmUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
      accessToken,
      { action: 'sync' },
    );
    if (!alive.current) return;
    setRefreshing(false);
    if (outcome.kind === 'error' && outcome.failure === 'unauthenticated') {
      await onSessionExpired();
      return;
    }
    setBanner(refreshBanner(outcome));
    // Whatever the answer, the run row now says what happened; read it back.
    await load();
  }, [load, onSessionExpired, refreshing, session.access_token]);

  const refreshButton = (
    <button
      className="button button--primary button--small overview__refresh"
      type="button"
      disabled={refreshing || running}
      aria-busy={refreshing || running}
      onClick={() => {
        void refresh();
      }}
    >
      {refreshing ? 'Refreshing…' : running ? 'Refresh running…' : 'Refresh'}
    </button>
  );

  return (
    <section className="overview" aria-labelledby="overview-title">
      <div className="overview__bar">
        <div className="overview__heading">
          <h1 id="overview-title" className="overview__title">
            Overview
          </h1>
          {/* Always one line tall, so the pipeline's name landing does not push the tiles down. */}
          <p className="overview__pipeline muted" title={view?.pipelineName ?? undefined}>
            {view?.pipelineName ?? ' '}
          </p>
        </div>
        <div className="overview__fresh">
          {view !== null && <FreshnessLine view={view} />}
          {view?.kind === 'ready' && refreshButton}
        </div>
      </div>

      {banner !== null && (
        <p className={banner.tone === 'ok' ? 'mem__banner' : 'notice mem__banner'} role="status">
          {banner.text}
        </p>
      )}

      {view !== null && view.sync.running && (
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
      {view !== null && view.sync.stuck && (
        <p className="notice overview__notice" role="status">
          A refresh started {view.sync.lastRun === null ? 'earlier' : 'a while ago'} and did not
          finish. Refresh again.
        </p>
      )}
      {view !== null && view.kind === 'ready' && view.sync.lastFailed && (
        <p className="overview__alert" role="alert">
          <strong>The last refresh failed</strong>
          {view.sync.lastRun?.errorCode != null && ` (${view.sync.lastRun.errorCode})`}, so these
          numbers may be behind GoHighLevel.{' '}
          {view.sync.lastRun?.errorCode === 'UNAUTHENTICATED'
            ? 'GoHighLevel rejected our access key — it needs replacing on the server.'
            : 'Try again; if it keeps failing, the run needs looking at.'}
        </p>
      )}
      {view !== null && view.kind === 'ready' && view.sync.lastPartial && (
        <p className="notice overview__notice" role="status">
          The last refresh could not read {formatCount(view.sync.contactsUnread)} contact
          {view.sync.contactsUnread === 1 ? '' : 's'} from GoHighLevel. Their leads are counted;
          their names may be missing or out of date below.
        </p>
      )}
      {view !== null && view.capped && (
        <p className="notice overview__notice" role="status">
          Only the first {formatCount(OVERVIEW_OPPORTUNITY_LIMIT)} open leads were read, so the
          counts may be short.
        </p>
      )}

      {state === 'loading' && <Skeleton />}

      {state === 'error' && view === null && (
        <div className="card overview__empty" role="alert">
          <h2 className="overview__empty-title">Couldn&rsquo;t load your pipeline</h2>
          <p>The numbers could not be read just now. Nothing is lost — try again.</p>
          <button
            className="button button--primary"
            type="button"
            onClick={() => {
              setState('loading');
              setBanner(null);
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {view !== null && view.kind === 'not-set-up' && (
        <div className="card overview__empty">
          <h2 className="overview__empty-title">Not set up yet</h2>
          <p>
            Nothing has been read from GoHighLevel yet, so there are no numbers to show. This is not
            an empty pipeline — it has simply not been read. Press Refresh to read the Finance
            Pipeline for the first time.
          </p>
          {view.sync.lastFailed && (
            <p className="error" role="alert">
              The first refresh failed
              {view.sync.lastRun?.errorCode != null && ` (${view.sync.lastRun.errorCode})`}.
              {view.sync.lastRun?.errorCode === 'UNAUTHENTICATED'
                ? ' GoHighLevel rejected our access key — it needs replacing on the server.'
                : ' Try again; if it keeps failing, the run needs looking at.'}
            </p>
          )}
          <div className="mem__row">{refreshButton}</div>
        </div>
      )}

      {view !== null && view.kind === 'ready' && (
        <div className="overview__body">
          <div className="tiles">
            <div className="card tile">
              <p className="tile__label">Open leads</p>
              <p className="tile__value">{formatCount(view.openTotal)}</p>
              <p className="tile__hint muted">in the pipeline right now</p>
            </div>
            <div className="card tile">
              <p className="tile__label">New this week</p>
              <p className="tile__value">{formatCount(view.newThisWeek)}</p>
              <p className="tile__hint muted">arrived in the last 7 days</p>
            </div>
          </div>

          <section className="card overview__stages" aria-labelledby="stages-title">
            <h2 id="stages-title" className="overview__subtitle">
              By stage
            </h2>
            {view.openTotal === 0 && (
              <p className="muted overview__hint">No open leads in the pipeline right now.</p>
            )}
            <ol className="stages">
              {view.stages.map((stage) => {
                const share = view.openTotal === 0 ? 0 : (stage.count / view.openTotal) * 100;
                return (
                  <li
                    key={stage.stageId}
                    className={`stages__row${stage.kind === 'stage' ? '' : ' stages__row--odd'}`}
                  >
                    <span className="stages__name" title={stage.name}>
                      {stage.name}
                      {stage.kind === 'unknown-stage' && (
                        <span className="sr-only"> — stage id {stage.stageId}</span>
                      )}
                    </span>
                    <span className="stages__bar" aria-hidden="true">
                      <span className="stages__fill" style={{ width: `${String(share)}%` }} />
                    </span>
                    <span className="stages__count">
                      {formatCount(stage.count)}
                      <span className="sr-only"> lead{stage.count === 1 ? '' : 's'}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>

          <section className="card overview__arrivals" aria-labelledby="arrivals-title">
            <h2 id="arrivals-title" className="overview__subtitle">
              Most recent
            </h2>
            {view.arrivals.length === 0 ? (
              <p className="muted overview__hint">No leads to show yet.</p>
            ) : (
              <ol className="arrivals">
                {view.arrivals.map((arrival) => (
                  <li key={arrival.opportunityId} className="arrivals__row">
                    <span className="arrivals__name" title={arrival.name}>
                      {arrival.name}
                    </span>
                    <span className="arrivals__meta muted">
                      <span className="arrivals__stage" title={arrival.stageName}>
                        {arrival.stageName}
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span className="arrivals__when">{arrival.when}</span>
                      {!arrival.contactKnown && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span className="arrivals__flag">contact details not synced</span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
