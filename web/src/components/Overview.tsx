/**
 * The screen the app opens on (Milestone 4 part 2): the client's numbers, read from the
 * Milestone 4 part 1 mirror of GoHighLevel under RLS as the signed-in person. Every figure
 * is a row (web/src/lib/overviewView.ts says which); nothing here is live from GoHighLevel,
 * and the screen says so — "Updated 12 minutes ago", louder the older it gets — because a
 * synced copy believed to be current is how a week-old number gets acted on.
 *
 * The one write is Refresh: a POST to our crm endpoint, which reads GoHighLevel on the
 * server and rewrites the mirror; this screen then re-reads it. Since part 3 the read, the
 * polling, the refresh and its cooldown live in useMirror.ts and the sentences in
 * SyncStatus.tsx, shared with the leads screen, so a refresh from either behaves the same.
 *
 * States, each deliberately distinct (Part C): never synced reads as "not set up yet", never
 * as zero leads; a stage with nothing in it is a zero on the list; a failed or partial last
 * run is a sentence above the numbers; a read that failed is a retry, not a blank; a 401 is
 * the login screen, never an empty dashboard that looks like data loss.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, type ReactElement } from 'react';

import {
  ARRIVALS_SHOWN,
  OVERVIEW_OPPORTUNITY_LIMIT,
  buildOverview,
  formatCount,
  type OverviewInput,
} from '../lib/overviewView.js';
import { supabase } from '../lib/supabase.js';
import { FreshnessLine, NotSetUp, RefreshControl, SyncNotices } from './SyncStatus.js';
import { useMirror, type MirrorRead } from './useMirror.js';

/** A plain space collapses to nothing; the line must keep its height before the name lands. */
const NBSP = ' ';

interface Props {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
}

/**
 * Every read on this screen, together. A 401 from PostgREST means the session is gone —
 * supabase-js will have tried to refresh it already — and the right answer is the login
 * screen with the message, not a dashboard of zeros.
 */
async function readOverview(): Promise<MirrorRead<OverviewInput>> {
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
  const build = useCallback((input: OverviewInput, now: number) => buildOverview(input, now), []);
  const mirror = useMirror({
    session,
    onSessionExpired,
    read: readOverview,
    build,
    readFailedMessage: "Couldn't read your pipeline. Check your connection and retry.",
  });
  const { state, view, banner } = mirror;

  const refreshControl = (
    <RefreshControl
      refreshing={mirror.refreshing}
      running={mirror.running}
      cooldownMs={mirror.cooldownMs}
      onRefresh={mirror.refresh}
    />
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
            {view?.pipelineName ?? NBSP}
          </p>
        </div>
        <div className="overview__fresh">
          {view !== null && <FreshnessLine freshness={view.freshness} />}
          {view?.kind === 'ready' && refreshControl}
        </div>
      </div>

      {banner !== null && (
        <p className={banner.tone === 'ok' ? 'mem__banner' : 'notice mem__banner'} role="status">
          {banner.text}
        </p>
      )}

      {view !== null && (
        <SyncNotices
          sync={view.sync}
          ready={view.kind === 'ready'}
          capped={view.capped}
          limit={OVERVIEW_OPPORTUNITY_LIMIT}
          cappedNoun="open leads"
        />
      )}

      {state === 'loading' && <Skeleton />}

      {state === 'error' && view === null && (
        <div className="card overview__empty" role="alert">
          <h2 className="overview__empty-title">Couldn&rsquo;t load your pipeline</h2>
          <p>The numbers could not be read just now. Nothing is lost — try again.</p>
          <button className="button button--primary" type="button" onClick={mirror.retry}>
            Try again
          </button>
        </div>
      )}

      {view !== null && view.kind === 'not-set-up' && (
        <NotSetUp sync={view.sync} refresh={refreshControl}>
          <p>
            Nothing has been read from GoHighLevel yet, so there are no numbers to show. This is not
            an empty pipeline — it has simply not been read. Press Refresh to read the Finance
            Pipeline for the first time.
          </p>
        </NotSetUp>
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
