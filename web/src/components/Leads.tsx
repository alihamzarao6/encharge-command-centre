/**
 * The leads screen (Milestone 4 part 3): every open lead in the Finance Pipeline, as a board
 * (stages as columns, in the pipeline's own order) and as a list he can search and sort. Both
 * views exist at every width and he can switch; what changes is which one opens by default —
 * the board on a desktop, the list on a phone (fixed decision 2). Clicking a lead opens its
 * detail address, which this part fills with an honest placeholder (fixed decision 3).
 *
 * One read for both views (web/src/lib/leadsView.ts says what is selected), the same hook
 * the overview uses for freshness, polling, Refresh and the cooldown (useMirror.ts), the same
 * sentences (SyncStatus.tsx). Search and the stage filter live here, above both views, so a
 * search typed on the board survives a switch to the list (Part A decision 5); the view
 * choice is remembered between sessions, the search is not.
 *
 * NOTHING HERE WRITES. Moving a lead is part 4, together with the write to GoHighLevel that
 * has to accompany it; the board is only built so that adding the drag there is an addition
 * (stable card and column identities, a drop target per column) rather than a rewrite.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  CONTACTS_LIMIT,
  LEADS_OPPORTUNITY_LIMIT,
  buildLeads,
  defaultViewFor,
  describeMatches,
  filterLeads,
  loadViewChoice,
  saveViewChoice,
  sortLeads,
  type LeadFilter,
  type LeadSort,
  type LeadsInput,
  type LeadsView as LeadsViewData,
  type LeadsViewChoice,
} from '../lib/leadsView.js';
import { formatCount } from '../lib/overviewView.js';
import { leadsPath, type LeadsRoute } from '../lib/routes.js';
import { supabase } from '../lib/supabase.js';
import { Board } from './Board.js';
import { LeadDetail } from './LeadDetail.js';
import { LeadsList } from './LeadsList.js';
import { FreshnessLine, NotSetUp, RefreshControl, SyncNotices } from './SyncStatus.js';
import { useMirror, type MirrorRead } from './useMirror.js';

/** A plain space collapses to nothing; the line must keep its height before the name lands. */
const NBSP = ' ';

interface Props {
  readonly session: Session;
  readonly route: LeadsRoute;
  /** Push a new address (a view switch, a lead) — the shell owns the history. */
  readonly onNavigate: (path: string) => void;
  readonly onSessionExpired: () => Promise<void>;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Every read for both views, together — six selects under RLS as the signed-in person. */
async function readLeads(): Promise<MirrorRead<LeadsInput>> {
  const [pipelines, stages, opportunities, contacts, fieldMap, runs] = await Promise.all([
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
      .limit(LEADS_OPPORTUNITY_LIMIT),
    supabase
      .from('ghl_contacts')
      .select('ghl_id, full_name, first_name, last_name, email, phone, custom_fields, removed_at')
      .is('removed_at', null)
      .limit(CONTACTS_LIMIT),
    supabase
      .from('ghl_field_map')
      .select('internal_field, ghl_custom_field_id, entity')
      .eq('entity', 'contact')
      .limit(100),
    supabase
      .from('ghl_sync_runs')
      .select(
        'id, pipeline_ghl_id, status, started_at, applied_at, finished_at, error_code, contacts_failed, contacts_missing, contacts_rejected, opportunities_rejected',
      )
      .order('started_at', { ascending: false })
      .limit(5),
  ]);
  const answers = [pipelines, stages, opportunities, contacts, fieldMap, runs];
  if (answers.some((a) => a.status === 401)) return { kind: 'unauthenticated' };
  if (answers.some((a) => a.error !== null)) return { kind: 'error' };
  return {
    kind: 'ok',
    input: {
      pipelines: pipelines.data ?? [],
      stages: stages.data ?? [],
      opportunities: opportunities.data ?? [],
      contacts: contacts.data ?? [],
      fieldMap: fieldMap.data ?? [],
      runs: runs.data ?? [],
      opportunityLimit: LEADS_OPPORTUNITY_LIMIT,
    },
  };
}

function Skeleton({ view }: { readonly view: LeadsViewChoice }): ReactElement {
  return (
    <div className="leads__body" aria-busy="true" aria-live="polite">
      <p className="sr-only">Loading your leads…</p>
      {view === 'board' ? (
        <div className="board board--skeleton" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="board__col board__col--skeleton" />
          ))}
        </div>
      ) : (
        <div className="card lt--skeleton" aria-hidden="true" />
      )}
    </div>
  );
}

export function Leads({ session, route, onNavigate, onSessionExpired }: Props): ReactElement {
  const build = useCallback((input: LeadsInput, now: number) => buildLeads(input, now), []);
  const mirror = useMirror({
    session,
    onSessionExpired,
    read: readLeads,
    build,
    readFailedMessage: "Couldn't read your leads. Check your connection and retry.",
  });
  const { state, view, banner } = mirror;

  // The remembered view, else the width's default. The address wins when it names one.
  const [remembered, setRemembered] = useState<LeadsViewChoice>(
    () => loadViewChoice(storage()) ?? defaultViewFor(window.innerWidth),
  );
  const shown: LeadsViewChoice = route.kind === 'view' ? route.view : remembered;
  useEffect(() => {
    if (route.kind === 'view' && route.view !== remembered) {
      setRemembered(route.view);
      saveViewChoice(storage(), route.view);
    }
  }, [route, remembered]);

  const [query, setQuery] = useState('');
  const [stageId, setStageId] = useState<string | null>(null);
  const [sort, setSort] = useState<LeadSort>('newest');
  const filter: LeadFilter = useMemo(() => ({ query, stageId }), [query, stageId]);

  const switchView = (next: LeadsViewChoice): void => {
    if (next === shown) return;
    saveViewChoice(storage(), next);
    setRemembered(next);
    onNavigate(leadsPath({ kind: 'view', view: next }));
  };
  const openLead = (opportunityId: string): void => {
    onNavigate(leadsPath({ kind: 'lead', opportunityId }));
  };
  const backToLeads = (): void => {
    onNavigate(leadsPath({ kind: 'view', view: shown }));
  };

  const refreshControl = (
    <RefreshControl
      refreshing={mirror.refreshing}
      running={mirror.running}
      cooldownMs={mirror.cooldownMs}
      onRefresh={mirror.refresh}
    />
  );

  if (route.kind === 'lead') {
    return (
      <LeadDetail
        opportunityId={route.opportunityId}
        state={state}
        view={view}
        onBack={backToLeads}
        onRetry={mirror.retry}
      />
    );
  }

  return (
    <section className="leads" aria-labelledby="leads-title">
      <div className="overview__bar leads__bar">
        <div className="overview__heading">
          <h1 id="leads-title" className="overview__title">
            Leads
          </h1>
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
          limit={LEADS_OPPORTUNITY_LIMIT}
          cappedNoun="open leads"
        />
      )}

      {view?.kind === 'ready' && (
        <Controls
          data={view}
          shown={shown}
          filter={filter}
          sort={sort}
          onQuery={setQuery}
          onStage={setStageId}
          onSort={setSort}
          onView={switchView}
        />
      )}

      {state === 'loading' && <Skeleton view={shown} />}

      {state === 'error' && view === null && (
        <div className="card overview__empty" role="alert">
          <h2 className="overview__empty-title">Couldn&rsquo;t load your leads</h2>
          <p>The leads could not be read just now. Nothing is lost — try again.</p>
          <button className="button button--primary" type="button" onClick={mirror.retry}>
            Try again
          </button>
        </div>
      )}

      {view !== null && view.kind === 'not-set-up' && (
        <NotSetUp sync={view.sync} refresh={refreshControl}>
          <p>
            Nothing has been read from GoHighLevel yet, so there are no leads to show. This is not
            an empty pipeline — it has simply not been read. Press Refresh to read the Finance
            Pipeline for the first time.
          </p>
        </NotSetUp>
      )}

      {view !== null && view.kind === 'ready' && shown === 'board' && (
        <Board
          columns={view.columns}
          filter={filter}
          total={view.leads.length}
          onOpen={openLead}
          onClear={() => {
            setQuery('');
            setStageId(null);
          }}
        />
      )}
      {view !== null && view.kind === 'ready' && shown === 'list' && (
        <LeadsList
          leads={sortLeads(filterLeads(view.leads, filter), sort)}
          total={view.leads.length}
          filter={filter}
          sort={sort}
          onSort={setSort}
          onOpen={openLead}
          onClear={() => {
            setQuery('');
            setStageId(null);
          }}
        />
      )}
    </section>
  );
}

interface ControlsProps {
  readonly data: LeadsViewData;
  readonly shown: LeadsViewChoice;
  readonly filter: LeadFilter;
  readonly sort: LeadSort;
  readonly onQuery: (query: string) => void;
  readonly onStage: (stageId: string | null) => void;
  readonly onSort: (sort: LeadSort) => void;
  readonly onView: (view: LeadsViewChoice) => void;
}

function Controls({
  data,
  shown,
  filter,
  sort,
  onQuery,
  onStage,
  onSort,
  onView,
}: ControlsProps): ReactElement {
  const matching = filterLeads(data.leads, filter).length;
  const summary = describeMatches(matching, data.leads.length, filter);
  return (
    <div className="leads__controls">
      <label className="leads__search">
        <span className="sr-only">Search leads by name, email or phone</span>
        <input
          className="field__input leads__input"
          type="search"
          placeholder="Search name, email or phone"
          autoComplete="off"
          value={filter.query}
          onChange={(event) => {
            onQuery(event.currentTarget.value);
          }}
        />
      </label>
      <label className="leads__select leads__stage">
        <span className="sr-only">Stage</span>
        <select
          className="field__input leads__input"
          value={filter.stageId ?? ''}
          onChange={(event) => {
            onStage(event.currentTarget.value === '' ? null : event.currentTarget.value);
          }}
        >
          <option value="">All stages</option>
          {data.columns.map((c) => (
            <option key={c.stageId} value={c.stageId}>
              {c.name} ({formatCount(c.leads.length)})
            </option>
          ))}
        </select>
      </label>
      {shown === 'list' && (
        <label className="leads__select leads__sort">
          <span className="sr-only">Sort</span>
          <select
            className="field__input leads__input"
            value={sort}
            onChange={(event) => {
              onSort(event.currentTarget.value as LeadSort);
            }}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
            <option value="stage">Stage order</option>
          </select>
        </label>
      )}
      <div className="leads__switch" role="group" aria-label="View">
        <button
          type="button"
          className={`button button--small leads__view${shown === 'board' ? ' leads__view--on' : ''}`}
          aria-pressed={shown === 'board'}
          onClick={() => {
            onView('board');
          }}
        >
          Board
        </button>
        <button
          type="button"
          className={`button button--small leads__view${shown === 'list' ? ' leads__view--on' : ''}`}
          aria-pressed={shown === 'list'}
          onClick={() => {
            onView('list');
          }}
        >
          List
        </button>
      </div>
      <p className="leads__summary muted" role="status">
        {summary ??
          `${formatCount(data.leads.length)} open lead${data.leads.length === 1 ? '' : 's'}`}
      </p>
    </div>
  );
}
