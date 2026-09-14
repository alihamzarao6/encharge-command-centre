/**
 * Turning the Milestone 4 part 1 mirror tables into what the overview shows (part 2). Pure,
 * so every number and every sentence on the screen the client reads first thing in the
 * morning is unit-tested against known rows rather than against whatever is in the database.
 *
 * Every figure here traces to a row: the per-stage counts are live `ghl_opportunities` rows
 * grouped by `stage_ghl_id` (never by name — CLIENT-CONTEXT §3), the total is their sum, the
 * arrivals are the newest of them by GoHighLevel's own `ghl_created_at`, and the freshness is
 * the `applied_at` of the last sync run that actually wrote rows. Nothing is derived that the
 * tables cannot back: no value column (every opportunity carries 0 today, and a screen full
 * of "$0" reads as a fact), no conversion rate, no trend.
 *
 * The data is a synced COPY. The screen therefore always says when it was last refreshed and
 * says it louder the older it gets; and a last run that failed or was partial is a sentence
 * on the screen, because an expired key sat unnoticed on this project once and the client
 * reported it before anyone else did.
 */

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   Type aliases, not interfaces: supabase-js matches a schema structurally against
   Record<string, unknown>, which an interface fails (the same reason as supabase.ts). */
export type GhlPipelineRow = {
  ghl_id: string;
  name: string;
  last_changed_at: string;
};

export type GhlStageRow = {
  ghl_id: string;
  pipeline_ghl_id: string;
  name: string;
  position: number;
  removed_at: string | null;
};

export type GhlOpportunityRow = {
  ghl_id: string;
  pipeline_ghl_id: string;
  stage_ghl_id: string;
  contact_ghl_id: string | null;
  name: string;
  status: string;
  ghl_created_at: string | null;
  removed_at: string | null;
};

export type GhlContactRow = {
  ghl_id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  removed_at: string | null;
};

export type GhlSyncRunRow = {
  id: string;
  pipeline_ghl_id: string;
  status: string;
  started_at: string;
  applied_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  contacts_failed: number | null;
  contacts_missing: number | null;
  contacts_rejected: number | null;
  opportunities_rejected: number | null;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

export interface OverviewInput {
  readonly pipelines: readonly GhlPipelineRow[];
  readonly stages: readonly GhlStageRow[];
  /** Live rows only (`removed_at is null`), read with `opportunityLimit` as the page size. */
  readonly opportunities: readonly GhlOpportunityRow[];
  /** The contacts behind the arrivals — whichever of them the sync managed to read. */
  readonly contacts: readonly GhlContactRow[];
  /** Newest first. */
  readonly runs: readonly GhlSyncRunRow[];
  readonly opportunityLimit: number;
}

export type FreshnessTone = 'fresh' | 'stale' | 'old';

export type Freshness =
  | { readonly kind: 'never' }
  | {
      readonly kind: 'known';
      readonly appliedAt: string;
      readonly ageMs: number;
      readonly tone: FreshnessTone;
      /** "Updated 12 minutes ago", "Last refreshed 3 hours ago". */
      readonly label: string;
      /** The absolute time, Perth, for a tooltip or a second line. */
      readonly at: string;
    };

export interface SyncState {
  /** A run is in progress and started recently enough to still be believed. */
  readonly running: boolean;
  /** A run says `running` but started too long ago to still be one. */
  readonly stuck: boolean;
  readonly lastRun: {
    readonly status: string;
    readonly errorCode: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
  } | null;
  /** The most recent finished run failed: the numbers may be behind. */
  readonly lastFailed: boolean;
  /** The most recent finished run was partial: some contacts could not be read. */
  readonly lastPartial: boolean;
  readonly contactsUnread: number;
}

export type StageCountKind = 'stage' | 'removed-stage' | 'unknown-stage';

export interface StageCount {
  readonly stageId: string;
  readonly name: string;
  readonly count: number;
  readonly kind: StageCountKind;
}

export interface Arrival {
  readonly opportunityId: string;
  readonly name: string;
  readonly stageName: string;
  readonly createdAt: string | null;
  readonly when: string;
  /** False when the sync holds no contact row for it — shown, not hidden. */
  readonly contactKnown: boolean;
}

export interface OverviewView {
  /**
   * not-set-up — no sync has ever written rows: read as "not set up yet", never as zero
   * leads; ready — the numbers are on screen, whatever the freshness says about them.
   */
  readonly kind: 'not-set-up' | 'ready';
  readonly pipelineName: string | null;
  readonly openTotal: number;
  readonly newThisWeek: number;
  readonly stages: readonly StageCount[];
  readonly arrivals: readonly Arrival[];
  readonly freshness: Freshness;
  readonly sync: SyncState;
  /** The opportunity read hit its page size, so the counts may be short. */
  readonly capped: boolean;
}

export const OVERVIEW_OPPORTUNITY_LIMIT = 2_000;
export const ARRIVALS_SHOWN = 5;
/** Past this, "Updated … ago" turns amber; past OLD it turns red and asks for a refresh. */
export const STALE_AFTER_MS = 60 * 60 * 1_000;
export const OLD_AFTER_MS = 24 * 60 * 60 * 1_000;
/** A run still `running` after this is not running; begin_ghl_sync_run retires it the same way. */
export const RUNNING_BELIEVED_FOR_MS = 15 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export const UNKNOWN_STAGE_LABEL = 'Stage not in the pipeline';
export const REMOVED_STAGE_SUFFIX = ' (removed in GoHighLevel)';
export const UNNAMED_LEAD = 'Unnamed lead';

const COUNT = new Intl.NumberFormat('en-AU');
const TIME = new Intl.DateTimeFormat('en-AU', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Australia/Perth',
});
const DAY = new Intl.DateTimeFormat('en-AU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Australia/Perth',
});
const DATE = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Australia/Perth',
});
const FULL = new Intl.DateTimeFormat('en-AU', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Australia/Perth',
});
const PERTH_DAY = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Australia/Perth',
});

/** "12,345" — grouped the Australian way, never abbreviated: a count is a count. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

function parse(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** "just now", "4 minutes ago", "3 hours ago", "2 days ago". Whole units, floor. */
export function formatAgo(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

/** "Today, 9:15 am" · "Yesterday, 4:02 pm" · "Tue 9 Sep" · "9 Aug 2026" — Perth time. */
export function formatArrival(iso: string | null, nowMs: number): string {
  const ms = parse(iso);
  if (ms === null) return 'Date unknown';
  const today = PERTH_DAY.format(nowMs);
  const yesterday = PERTH_DAY.format(nowMs - 24 * 60 * 60 * 1_000);
  const day = PERTH_DAY.format(ms);
  if (day === today) return `Today, ${TIME.format(ms)}`;
  if (day === yesterday) return `Yesterday, ${TIME.format(ms)}`;
  if (nowMs - ms < WEEK_MS && ms <= nowMs) return DAY.format(ms);
  return DATE.format(ms);
}

export function freshnessOf(appliedAt: string | null, nowMs: number): Freshness {
  const ms = parse(appliedAt);
  if (appliedAt === null || ms === null) return { kind: 'never' };
  const ageMs = Math.max(0, nowMs - ms);
  const tone: FreshnessTone =
    ageMs >= OLD_AFTER_MS ? 'old' : ageMs >= STALE_AFTER_MS ? 'stale' : 'fresh';
  const ago = formatAgo(ageMs);
  const label = tone === 'fresh' ? `Updated ${ago}` : `Last refreshed ${ago}`;
  return { kind: 'known', appliedAt, ageMs, tone, label, at: FULL.format(ms) };
}

function contactName(contact: GhlContactRow | undefined): string | null {
  if (contact === undefined) return null;
  const full = contact.full_name?.trim() ?? '';
  if (full !== '') return full;
  const parts = [contact.first_name?.trim() ?? '', contact.last_name?.trim() ?? ''].filter(
    (p) => p !== '',
  );
  return parts.length === 0 ? null : parts.join(' ');
}

export function syncStateOf(runs: readonly GhlSyncRunRow[], nowMs: number): SyncState {
  const latest = runs[0];
  let running = false;
  let stuck = false;
  if (latest?.status === 'running') {
    const started = parse(latest.started_at) ?? nowMs;
    if (nowMs - started < RUNNING_BELIEVED_FOR_MS) running = true;
    else stuck = true;
  }
  const finished = runs.find((r) => r.status !== 'running');
  const lastRun =
    finished === undefined
      ? null
      : {
          status: finished.status,
          errorCode: finished.error_code,
          startedAt: finished.started_at,
          finishedAt: finished.finished_at,
        };
  const contactsUnread =
    finished === undefined
      ? 0
      : (finished.contacts_failed ?? 0) +
        (finished.contacts_missing ?? 0) +
        (finished.contacts_rejected ?? 0);
  return {
    running,
    stuck,
    lastRun,
    lastFailed: finished?.status === 'failed',
    lastPartial: finished?.status === 'partial',
    contactsUnread,
  };
}

/**
 * Which pipeline the screen is about. The sync mirrors the one named by GHL_PIPELINE_ID,
 * which the browser does not know; the last run's pipeline id is the same fact from the
 * database's side, and a lone pipeline row is the fallback for a mirror that has rows but
 * (somehow) no run history.
 */
export function pipelineOf(
  input: Pick<OverviewInput, 'pipelines' | 'runs'>,
): GhlPipelineRow | null {
  const fromRun = input.runs.find((r) => r.applied_at !== null)?.pipeline_ghl_id ?? null;
  if (fromRun !== null) {
    const row = input.pipelines.find((p) => p.ghl_id === fromRun);
    if (row !== undefined) return row;
  }
  return (
    [...input.pipelines].sort((a, b) => b.last_changed_at.localeCompare(a.last_changed_at))[0] ??
    null
  );
}

export function buildOverview(input: OverviewInput, nowMs: number): OverviewView {
  const sync = syncStateOf(input.runs, nowMs);
  const applied = input.runs.find((r) => r.applied_at !== null);
  const freshness = freshnessOf(applied?.applied_at ?? null, nowMs);
  const pipeline = pipelineOf(input);

  if (pipeline === null || freshness.kind === 'never') {
    return {
      kind: 'not-set-up',
      pipelineName: pipeline?.name ?? null,
      openTotal: 0,
      newThisWeek: 0,
      stages: [],
      arrivals: [],
      freshness,
      sync,
      capped: false,
    };
  }

  const stageRows = input.stages
    .filter((s) => s.pipeline_ghl_id === pipeline.ghl_id)
    .sort((a, b) => a.position - b.position || a.ghl_id.localeCompare(b.ghl_id));
  const stagesById = new Map(stageRows.map((s) => [s.ghl_id, s]));
  const open = input.opportunities.filter(
    (o) => o.pipeline_ghl_id === pipeline.ghl_id && o.removed_at === null && o.status === 'open',
  );

  const counts = new Map<string, number>();
  for (const o of open) counts.set(o.stage_ghl_id, (counts.get(o.stage_ghl_id) ?? 0) + 1);

  const stages: StageCount[] = stageRows
    .filter((s) => s.removed_at === null)
    .map((s) => ({
      stageId: s.ghl_id,
      name: s.name,
      count: counts.get(s.ghl_id) ?? 0,
      kind: 'stage',
    }));
  // A stage GoHighLevel removed but still holds leads, and a stage id the pipeline has never
  // listed: both are shown with their count, never folded into a neighbour or dropped.
  for (const [stageId, count] of counts) {
    if (stages.some((s) => s.stageId === stageId)) continue;
    const removed = stagesById.get(stageId);
    stages.push(
      removed !== undefined
        ? { stageId, name: `${removed.name}${REMOVED_STAGE_SUFFIX}`, count, kind: 'removed-stage' }
        : { stageId, name: UNKNOWN_STAGE_LABEL, count, kind: 'unknown-stage' },
    );
  }

  const newThisWeek = open.filter((o) => {
    const ms = parse(o.ghl_created_at);
    return ms !== null && nowMs - ms < WEEK_MS;
  }).length;

  const contactsById = new Map(input.contacts.map((c) => [c.ghl_id, c]));
  const arrivals: Arrival[] = [...open]
    .sort((a, b) => (parse(b.ghl_created_at) ?? -1) - (parse(a.ghl_created_at) ?? -1))
    .slice(0, ARRIVALS_SHOWN)
    .map((o) => {
      const contact = o.contact_ghl_id === null ? undefined : contactsById.get(o.contact_ghl_id);
      const stage = stagesById.get(o.stage_ghl_id);
      const name = contactName(contact) ?? (o.name.trim() === '' ? UNNAMED_LEAD : o.name.trim());
      return {
        opportunityId: o.ghl_id,
        name,
        stageName: stage?.name ?? UNKNOWN_STAGE_LABEL,
        createdAt: o.ghl_created_at,
        when: formatArrival(o.ghl_created_at, nowMs),
        contactKnown: contact !== undefined,
      };
    });

  return {
    kind: 'ready',
    pipelineName: pipeline.name,
    openTotal: open.length,
    newThisWeek,
    stages,
    arrivals,
    freshness,
    sync,
    capped: input.opportunities.length >= input.opportunityLimit,
  };
}
