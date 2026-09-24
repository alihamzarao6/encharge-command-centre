/**
 * The leads screen (Milestone 4 part 3): every open lead in the Finance Pipeline, as a board
 * (stages as columns, in the pipeline's own order) and as a list he can search and sort. Both
 * views exist at every width and he can switch; what changes is which one opens by default —
 * the board on a desktop, the list on a phone (fixed decision 2). Clicking a lead opens its
 * detail.
 *
 * One read for both views (web/src/lib/leadsView.ts says what is selected), the same hook
 * the overview uses for freshness, polling, Refresh and the cooldown (useMirror.ts), the same
 * sentences (SyncStatus.tsx). Search and the stage filter live here, above both views, so a
 * search typed on the board survives a switch to the list (Part A decision 5); the view
 * choice is remembered between sessions, the search is not.
 *
 * PART 4 — THIS SCREEN WRITES, through the crm endpoint and nowhere else:
 *
 *   - A MOVE (a drop on the board, a pick on a card or in the detail) is optimistic: the
 *     lead is shown in its new stage at once as an OVERRIDE over the mirror's view, the
 *     request goes out with a request id minted for this gesture, and the answer either
 *     confirms (the override stays until the re-read agrees) or drops the override — which
 *     IS the rollback, since the mirror's view was never touched — and says why in words, on
 *     screen and in a live region. One move at a time: a second gesture while one is saving
 *     is refused with a sentence, so a double-drop or double-tap is one move.
 *   - A NOTE writes through to GoHighLevel and is listed under the lead; a failure keeps the
 *     text in the box.
 *   - The detail is its own read (the whole opportunity and contact rows, the field
 *     definitions for labels, the notes, the roster for authors), re-read after every write.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { callCrm, newRequestId, type CrmOutcome } from '../lib/crmApi.js';
import { webConfig } from '../lib/env.js';
import {
  buildLeadDetail,
  type LeadDetailInput,
  type LeadDetailState,
  type StageOption,
} from '../lib/leadDetailView.js';
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
import {
  MOVE_BUSY,
  applyMove,
  describeMoveOutcome,
  stageNameOf,
  type PendingMove,
} from '../lib/moveView.js';
import { formatCount } from '../lib/overviewView.js';
import { leadsPath, type LeadsRoute } from '../lib/routes.js';
import { supabase } from '../lib/supabase.js';
import { Board, type MoveInFlight } from './Board.js';
import { LeadDetail, type NoteDraftState } from './LeadDetail.js';
import { LeadsList } from './LeadsList.js';
import { FreshnessLine, NotSetUp, RefreshControl, SyncNotices } from './SyncStatus.js';
import { useMirror, type MirrorRead } from './useMirror.js';

/** A plain space collapses to nothing; the line must keep its height before the name lands. */
const NBSP = ' ';

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

/** The detail's own reads: whole rows for ONE lead, the labels, the notes, the roster. */
async function readLeadDetail(
  opportunityId: string,
  viewerId: string,
): Promise<MirrorRead<LeadDetailInput>> {
  const opportunity = await supabase
    .from('ghl_opportunities')
    .select(
      'ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, monetary_value, source, assigned_to, ghl_created_at, ghl_updated_at, last_stage_change_at, last_status_change_at, removed_at',
    )
    .eq('ghl_id', opportunityId)
    .limit(1);
  if (opportunity.status === 401) return { kind: 'unauthenticated' };
  if (opportunity.error !== null) return { kind: 'error' };
  const row = opportunity.data[0] ?? null;
  const contactId = row?.contact_ghl_id ?? null;
  const [contact, stages, customFields, fieldMap, notes, roster] = await Promise.all([
    contactId === null
      ? Promise.resolve(null)
      : supabase
          .from('ghl_contacts')
          .select(
            'ghl_id, full_name, first_name, last_name, email, phone, source, dnd, tags, custom_fields, ghl_created_at, ghl_updated_at, removed_at',
          )
          .eq('ghl_id', contactId)
          .limit(1),
    supabase
      .from('ghl_stages')
      .select('ghl_id, pipeline_ghl_id, name, position, removed_at')
      .limit(500),
    supabase
      .from('ghl_custom_fields')
      .select('ghl_id, name, data_type, parent_id, removed_at')
      .limit(500),
    supabase
      .from('ghl_field_map')
      .select('internal_field, ghl_custom_field_id, entity')
      .eq('entity', 'contact')
      .limit(100),
    supabase
      .from('ghl_notes')
      .select(
        'ghl_id, contact_ghl_id, opportunity_ghl_id, author_user_id, body, ghl_date_added, created_at',
      )
      .eq('opportunity_ghl_id', opportunityId)
      .order('ghl_date_added', { ascending: false })
      .limit(200),
    supabase.from('app_users').select('user_id, email').limit(500),
  ]);
  const answers = [contact, stages, customFields, fieldMap, notes, roster];
  if (answers.some((a) => a !== null && a.status === 401)) return { kind: 'unauthenticated' };
  if (answers.some((a) => a !== null && a.error !== null)) return { kind: 'error' };
  return {
    kind: 'ok',
    input: {
      opportunity: row,
      contact: contact?.data?.[0] ?? null,
      stages: stages.data ?? [],
      customFields: customFields.data ?? [],
      fieldMap: fieldMap.data ?? [],
      notes: notes.data ?? [],
      roster: roster.data ?? [],
      viewerId,
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

interface Override {
  readonly opportunityId: string;
  readonly stageId: string;
}

type Notice = { readonly tone: 'ok' | 'warn'; readonly text: string } | null;

export function Leads({ session, route, onNavigate, onSessionExpired }: Props): ReactElement {
  const build = useCallback((input: LeadsInput, now: number) => buildLeads(input, now), []);
  const mirror = useMirror({
    session,
    onSessionExpired,
    read: readLeads,
    build,
    readFailedMessage: "Couldn't read your leads. Check your connection and retry.",
  });
  const { state, banner } = mirror;

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

  // ---- Part 4: moving a lead ----
  const [moving, setMoving] = useState<PendingMove | null>(null);
  const [override, setOverride] = useState<Override | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moveNotice, setMoveNotice] = useState<Notice>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The override is dropped once the mirror itself shows the lead where the override says.
  const mirrorView = mirror.view;
  useEffect(() => {
    if (override === null || mirrorView === null) return;
    const lead = mirrorView.leads.find((l) => l.opportunityId === override.opportunityId);
    if (lead === undefined || lead.stageId === override.stageId) setOverride(null);
  }, [mirrorView, override]);

  const view: LeadsViewData | null = useMemo(() => {
    if (mirrorView === null || override === null) return mirrorView;
    return applyMove(mirrorView, override.opportunityId, override.stageId);
  }, [mirrorView, override]);

  const stageOptions: readonly StageOption[] = useMemo(
    () =>
      (view?.columns ?? [])
        .filter((c) => c.kind === 'stage' && c.number !== null)
        .map((c) => ({ stageId: c.stageId, name: c.name, number: c.number ?? 0 })),
    [view],
  );

  const accessToken = useCallback(async (): Promise<string> => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? session.access_token;
  }, [session.access_token]);

  // ---- Part 4: the detail ----
  const opportunityId = route.kind === 'lead' ? route.opportunityId : null;
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<LeadDetailState | null>(null);
  const loadDetail = useCallback(async (): Promise<void> => {
    if (opportunityId === null) return;
    const answer = await readLeadDetail(opportunityId, session.user.id);
    if (!alive.current) return;
    if (answer.kind === 'unauthenticated') {
      await onSessionExpired();
      return;
    }
    if (answer.kind === 'error') {
      setDetailState((current) => (current === 'ready' ? current : 'error'));
      return;
    }
    setDetail(buildLeadDetail(answer.input, Date.now()));
    setDetailState('ready');
  }, [opportunityId, session.user.id, onSessionExpired]);
  useEffect(() => {
    setDetail(null);
    setDetailState('loading');
    setMoveNotice(null);
    if (opportunityId !== null) void loadDetail();
  }, [opportunityId, loadDetail]);

  const onMove = useCallback(
    (id: string, fromStageId: string, toStageId: string): void => {
      if (moving !== null) {
        setAnnouncement(MOVE_BUSY);
        setMoveNotice({ tone: 'warn', text: MOVE_BUSY });
        return;
      }
      if (view === null) return;
      const lead = view.leads.find((l) => l.opportunityId === id);
      if (lead === undefined || fromStageId === toStageId) return;
      const pending: PendingMove = {
        requestId: newRequestId(),
        opportunityId: id,
        fromStageId,
        toStageId,
        before: lead,
      };
      const to = stageNameOf(view, toStageId);
      setMoving(pending);
      setOverride({ opportunityId: id, stageId: toStageId });
      setMoveNotice(null);
      mirror.setBanner(null);
      setAnnouncement(`Moving ${lead.name} to ${to}…`);
      void (async () => {
        const outcome: CrmOutcome = await callCrm(
          { crmUrl: webConfig.crmUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
          await accessToken(),
          {
            action: 'move',
            requestId: pending.requestId,
            opportunityId: id,
            toStageId,
            fromStageId,
          },
        );
        if (!alive.current) return;
        setMoving(null);
        if (outcome.kind === 'error' && outcome.failure === 'unauthenticated') {
          setOverride(null);
          await onSessionExpired();
          return;
        }
        const message = describeMoveOutcome(view, pending, outcome);
        if (outcome.kind === 'error') setOverride(null);
        setAnnouncement(message.text);
        setMoveNotice({ tone: message.tone, text: message.text });
        mirror.setBanner({ tone: message.tone, text: message.text });
        // The mirror row was updated by the server (or the world changed underneath): read
        // it back so the override can be dropped, and the detail says what the CRM holds.
        await mirror.reload();
        if (message.reread || outcome.kind === 'ok') await loadDetail();
      })();
    },
    [moving, view, mirror, accessToken, onSessionExpired, loadDetail],
  );

  const movingCard: MoveInFlight | null =
    moving === null ? null : { opportunityId: moving.opportunityId, toStageId: moving.toStageId };

  // ---- Part 4: notes ----
  const [note, setNote] = useState<NoteDraftState>({ text: '', saving: false, notice: null });
  useEffect(() => {
    setNote({ text: '', saving: false, notice: null });
  }, [opportunityId]);
  const onNoteSubmit = useCallback((): void => {
    if (opportunityId === null || note.saving) return;
    const text = note.text.trim();
    if (text === '') {
      setNote((n) => ({ ...n, notice: { tone: 'warn', text: 'Write something before saving.' } }));
      return;
    }
    setNote((n) => ({ ...n, saving: true, notice: null }));
    const requestId = newRequestId();
    void (async () => {
      const outcome = await callCrm(
        { crmUrl: webConfig.crmUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
        await accessToken(),
        { action: 'note', requestId, opportunityId, body: text },
      );
      if (!alive.current) return;
      if (outcome.kind === 'error' && outcome.failure === 'unauthenticated') {
        setNote((n) => ({ ...n, saving: false }));
        await onSessionExpired();
        return;
      }
      if (outcome.kind === 'ok' && outcome.reply.action === 'note') {
        const saved = outcome.reply.mirrored
          ? 'Note saved to GoHighLevel.'
          : 'Note saved to GoHighLevel. This screen will show it after the next refresh.';
        setNote({ text: '', saving: false, notice: { tone: 'ok', text: saved } });
        setAnnouncement(saved);
        await loadDetail();
        return;
      }
      const why =
        outcome.kind === 'error' ? outcome.message : 'The note could not be saved. Try again.';
      // The text stays exactly as typed.
      setNote((n) => ({ ...n, saving: false, notice: { tone: 'warn', text: why } }));
      setAnnouncement(why);
      if (outcome.kind === 'error' && outcome.failure === 'refused') await loadDetail();
    })();
  }, [opportunityId, note.saving, note.text, accessToken, onSessionExpired, loadDetail]);

  const switchView = (next: LeadsViewChoice): void => {
    if (next === shown) return;
    saveViewChoice(storage(), next);
    setRemembered(next);
    onNavigate(leadsPath({ kind: 'view', view: next }));
  };
  const openLead = (id: string): void => {
    onNavigate(leadsPath({ kind: 'lead', opportunityId: id }));
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

  const liveRegion = (
    <p className="sr-only" role="status" aria-live="polite" data-testid="leads-live">
      {announcement}
    </p>
  );

  if (route.kind === 'lead' && opportunityId !== null) {
    // The detail shows the override too, so a pick moves the stage line at once.
    const shownDetail: LeadDetailState | null =
      detail?.kind === 'ready' && override !== null && override.opportunityId === opportunityId
        ? {
            ...detail,
            stageId: override.stageId,
            stageName: view === null ? detail.stageName : stageNameOf(view, override.stageId),
            stageKind: 'stage',
          }
        : detail;
    return (
      <>
        {liveRegion}
        <LeadDetail
          opportunityId={opportunityId}
          state={detailState}
          detail={shownDetail}
          onBack={backToLeads}
          onRetry={() => {
            setDetailState('loading');
            void loadDetail();
          }}
          onMove={(from, to) => {
            onMove(opportunityId, from, to);
          }}
          moving={moving?.opportunityId === opportunityId}
          moveNotice={moveNotice}
          note={note}
          onNoteChange={(text) => {
            setNote((n) => ({ ...n, text, notice: n.notice?.tone === 'ok' ? null : n.notice }));
          }}
          onNoteSubmit={onNoteSubmit}
        />
      </>
    );
  }

  return (
    <section className="leads" aria-labelledby="leads-title">
      {liveRegion}
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
        <p
          className={banner.tone === 'ok' ? 'mem__banner' : 'notice mem__banner'}
          role="status"
          data-tone={banner.tone}
        >
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
          stageOptions={stageOptions}
          onMove={onMove}
          moving={movingCard}
          onBusy={() => {
            setAnnouncement(MOVE_BUSY);
            mirror.setBanner({ tone: 'warn', text: MOVE_BUSY });
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
