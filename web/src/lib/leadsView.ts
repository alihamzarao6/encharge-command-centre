/**
 * Turning the Milestone 4 part 1 mirror into the leads screen (part 3): every lead, arranged
 * by stage for the board and as rows for the list. Pure, so the count in every column and
 * what every card and row says is unit-tested against known rows, never against whatever
 * is in the database.
 *
 * Everything on a card or a row traces to a column from part 1. A lead is a live, open
 * `ghl_opportunities` row; its stage is `stage_ghl_id` matched BY ID against `ghl_stages`
 * (CLIENT-CONTEXT §3 — never by name); its name, phone and email come from the
 * `ghl_contacts` row behind it where the sync has one; the loan balance and interest rate
 * are the form's own answers, read from `custom_fields` under the ids `ghl_field_map` holds
 * for `loan_balance` and `current_interest_rate`. No monetary value anywhere: every
 * opportunity carries 0 today and a column of "$0" would read as a fact about the business.
 *
 * The board is built drag-ready and nothing drags: every card has a stable identity (the
 * opportunity id), every column a stable identity (the stage id), and the within-stage order
 * is one the CRM can hold — newest arrival first — so a later part that moves a card between
 * columns adds an interaction rather than rewriting the shapes here.
 */
import {
  REMOVED_STAGE_SUFFIX,
  UNKNOWN_STAGE_LABEL,
  UNNAMED_LEAD,
  formatArrival,
  freshnessOf,
  pipelineOf,
  syncStateOf,
  type Freshness,
  type GhlOpportunityRow,
  type GhlPipelineRow,
  type GhlStageRow,
  type GhlSyncRunRow,
  type StageCountKind,
  type SyncState,
} from './overviewView.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   Type aliases, not interfaces: supabase-js matches a schema structurally (see supabase.ts). */
/** The contact columns the leads screen selects — the overview's, plus how to reach them. */
export type GhlContactDetailRow = {
  ghl_id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  /** `{ <custom field ghl id>: raw value }` exactly as the sync stored it. */
  custom_fields: Record<string, unknown>;
  removed_at: string | null;
};

/** `ghl_field_map`: the internal name → GoHighLevel custom-field id rows the seed carries. */
export type GhlFieldMapRow = {
  internal_field: string;
  ghl_custom_field_id: string | null;
  entity: string;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

export interface LeadsInput {
  readonly pipelines: readonly GhlPipelineRow[];
  readonly stages: readonly GhlStageRow[];
  /** Live, open rows only, read with `opportunityLimit` as the page size. */
  readonly opportunities: readonly GhlOpportunityRow[];
  /** Live contacts — whichever of them the sync managed to read. */
  readonly contacts: readonly GhlContactDetailRow[];
  readonly fieldMap: readonly GhlFieldMapRow[];
  /** Newest first. */
  readonly runs: readonly GhlSyncRunRow[];
  readonly opportunityLimit: number;
}

export interface Lead {
  /** The GoHighLevel opportunity id — the card's and the row's identity. */
  readonly opportunityId: string;
  readonly name: string;
  /** False when the name is the opportunity's own rather than a contact's. */
  readonly named: boolean;
  readonly stageId: string;
  readonly stageName: string;
  readonly stageKind: StageCountKind;
  /** Pipeline position of the stage; removed and unknown stages sort after the pipeline. */
  readonly stagePosition: number;
  readonly createdAt: string | null;
  readonly createdMs: number | null;
  /** "Today, 9:15 am" · "Tue 9 Sep" · "Date unknown" — Perth. */
  readonly arrived: string;
  readonly contactKnown: boolean;
  readonly email: string | null;
  readonly phone: string | null;
  /** The form's own words ("$500k–$750k"), or null when nothing was captured. */
  readonly loanBalance: string | null;
  readonly interestRate: string | null;
}

export interface StageColumn {
  readonly stageId: string;
  readonly name: string;
  readonly kind: StageCountKind;
  /** 1-based pipeline position for the eye; removed/unknown columns have none. */
  readonly number: number | null;
  readonly leads: readonly Lead[];
}

export interface LeadsView {
  readonly kind: 'not-set-up' | 'ready';
  readonly pipelineName: string | null;
  /** Every open lead in the mirrored pipeline, newest first. */
  readonly leads: readonly Lead[];
  /** Pipeline order, zeros kept; then a removed stage, then an unknown one, if either holds leads. */
  readonly columns: readonly StageColumn[];
  readonly freshness: Freshness;
  readonly sync: SyncState;
  readonly capped: boolean;
}

export const LEADS_OPPORTUNITY_LIMIT = 2_000;
export const CONTACTS_LIMIT = 2_000;
/** Rows shown at a time in the list, and cards per column on the board, before "Show more". */
export const PAGE_SIZE = 100;
export const FIELD_LOAN_BALANCE = 'loan_balance';
export const FIELD_INTEREST_RATE = 'current_interest_rate';

export function contactDisplayName(
  contact: Pick<GhlContactDetailRow, 'full_name' | 'first_name' | 'last_name'> | undefined,
): string | null {
  if (contact === undefined) return null;
  const full = contact.full_name?.trim() ?? '';
  if (full !== '') return full;
  const parts = [contact.first_name?.trim() ?? '', contact.last_name?.trim() ?? ''].filter(
    (p) => p !== '',
  );
  return parts.length === 0 ? null : parts.join(' ');
}

/** The id `ghl_field_map` holds for an internal contact field, or null when unmapped. */
export function fieldIdFor(fieldMap: readonly GhlFieldMapRow[], internal: string): string | null {
  const row = fieldMap.find((r) => r.entity === 'contact' && r.internal_field === internal);
  const id = row?.ghl_custom_field_id?.trim() ?? '';
  return id === '' ? null : id;
}

/**
 * A form answer as text, or null when there is none. The two fields in play are
 * MULTIPLE_OPTIONS bands, which GoHighLevel returns as a string or a one-element array; a
 * blank string, an empty array, null and a missing key are all "not captured", which is
 * normal — the fields were added to the form on 19 Aug and most leads predate them.
 */
export function customFieldText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? null : text;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (Array.isArray(raw)) {
    const parts = raw
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

function parse(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Newest arrival first; a lead with no date goes last; ties by id, so the order is stable. */
export function byNewest(a: Lead, b: Lead): number {
  return (
    (b.createdMs ?? -Infinity) - (a.createdMs ?? -Infinity) ||
    a.opportunityId.localeCompare(b.opportunityId)
  );
}

export function buildLeads(input: LeadsInput, nowMs: number): LeadsView {
  const sync = syncStateOf(input.runs, nowMs);
  const applied = input.runs.find((r) => r.applied_at !== null);
  const freshness = freshnessOf(applied?.applied_at ?? null, nowMs);
  const pipeline = pipelineOf(input);

  if (pipeline === null || freshness.kind === 'never') {
    return {
      kind: 'not-set-up',
      pipelineName: pipeline?.name ?? null,
      leads: [],
      columns: [],
      freshness,
      sync,
      capped: false,
    };
  }

  const stageRows = input.stages
    .filter((s) => s.pipeline_ghl_id === pipeline.ghl_id)
    .sort((a, b) => a.position - b.position || a.ghl_id.localeCompare(b.ghl_id));
  const stagesById = new Map(stageRows.map((s) => [s.ghl_id, s]));
  const liveStages = stageRows.filter((s) => s.removed_at === null);
  const positionOf = new Map(liveStages.map((s, i) => [s.ghl_id, i]));
  const contactsById = new Map(
    input.contacts.filter((c) => c.removed_at === null).map((c) => [c.ghl_id, c]),
  );
  const balanceId = fieldIdFor(input.fieldMap, FIELD_LOAN_BALANCE);
  const rateId = fieldIdFor(input.fieldMap, FIELD_INTEREST_RATE);

  const leads: Lead[] = input.opportunities
    .filter(
      (o) => o.pipeline_ghl_id === pipeline.ghl_id && o.removed_at === null && o.status === 'open',
    )
    .map((o) => {
      const contact = o.contact_ghl_id === null ? undefined : contactsById.get(o.contact_ghl_id);
      const stage = stagesById.get(o.stage_ghl_id);
      const stageKind: StageCountKind =
        stage === undefined
          ? 'unknown-stage'
          : stage.removed_at === null
            ? 'stage'
            : 'removed-stage';
      const contactName = contactDisplayName(contact);
      const ownName = o.name.trim();
      const createdMs = parse(o.ghl_created_at);
      return {
        opportunityId: o.ghl_id,
        name: contactName ?? (ownName === '' ? UNNAMED_LEAD : ownName),
        named: contactName !== null,
        stageId: o.stage_ghl_id,
        stageName:
          stage === undefined
            ? UNKNOWN_STAGE_LABEL
            : stageKind === 'removed-stage'
              ? `${stage.name}${REMOVED_STAGE_SUFFIX}`
              : stage.name,
        stageKind,
        stagePosition:
          positionOf.get(o.stage_ghl_id) ??
          (stageKind === 'removed-stage' ? liveStages.length : liveStages.length + 1),
        createdAt: o.ghl_created_at,
        createdMs,
        arrived: formatArrival(o.ghl_created_at, nowMs),
        contactKnown: contact !== undefined,
        email: contact?.email?.trim() === '' ? null : (contact?.email ?? null),
        phone: contact?.phone?.trim() === '' ? null : (contact?.phone ?? null),
        loanBalance: balanceId === null ? null : customFieldText(contact?.custom_fields[balanceId]),
        interestRate: rateId === null ? null : customFieldText(contact?.custom_fields[rateId]),
      };
    })
    .sort(byNewest);

  const byStage = new Map<string, Lead[]>();
  for (const lead of leads) {
    const bucket = byStage.get(lead.stageId);
    if (bucket === undefined) byStage.set(lead.stageId, [lead]);
    else bucket.push(lead);
  }

  const columns: StageColumn[] = liveStages.map((s, i) => ({
    stageId: s.ghl_id,
    name: s.name,
    kind: 'stage',
    number: i + 1,
    leads: byStage.get(s.ghl_id) ?? [],
  }));
  // A stage GoHighLevel removed but still holding leads, and a stage id the pipeline never
  // listed: shown as columns of their own after the pipeline, never folded into a neighbour.
  for (const [stageId, bucket] of byStage) {
    if (columns.some((c) => c.stageId === stageId)) continue;
    const removed = stagesById.get(stageId);
    columns.push(
      removed !== undefined
        ? {
            stageId,
            name: `${removed.name}${REMOVED_STAGE_SUFFIX}`,
            kind: 'removed-stage',
            number: null,
            leads: bucket,
          }
        : {
            stageId,
            name: UNKNOWN_STAGE_LABEL,
            kind: 'unknown-stage',
            number: null,
            leads: bucket,
          },
    );
  }

  return {
    kind: 'ready',
    pipelineName: pipeline.name,
    leads,
    columns,
    freshness,
    sync,
    capped: input.opportunities.length >= input.opportunityLimit,
  };
}

/* ---------- search, filter, sort ---------- */

/** Lower-cased, diacritics stripped, so "Ó Brádaigh" matches "o bradaigh". */
export function normaliseText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Digits only, so "0400 000 001", "+61 400 000 001" and "400000001" find each other. */
export function normalisePhone(text: string): string {
  return text.replace(/\D/g, '');
}

/**
 * Case- and accent-insensitive match on name, email and phone. A query with two or more
 * digits is also tried as a phone fragment, digits only; an all-space query matches
 * everything. Client-side on purpose (Part A decision 3): the whole set is already here.
 */
export function matchesQuery(lead: Lead, query: string): boolean {
  const q = normaliseText(query);
  if (q === '') return true;
  const digits = normalisePhone(q);
  if (digits.length >= 2 && lead.phone !== null && normalisePhone(lead.phone).includes(digits)) {
    return true;
  }
  const haystack = [lead.name, lead.email ?? '', lead.phone ?? ''].map(normaliseText);
  return haystack.some((h) => h.includes(q));
}

export type LeadSort = 'newest' | 'oldest' | 'name' | 'stage';

export const SORT_LABELS: Readonly<Record<LeadSort, string>> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name A–Z',
  stage: 'Stage order',
};

const COLLATOR = new Intl.Collator('en-AU', { sensitivity: 'base', numeric: true });

export function sortLeads(leads: readonly Lead[], sort: LeadSort): Lead[] {
  const copy = [...leads];
  switch (sort) {
    case 'newest':
      return copy.sort(byNewest);
    case 'oldest':
      return copy.sort((a, b) => -byNewest(a, b));
    case 'name':
      return copy.sort(
        (a, b) =>
          COLLATOR.compare(a.name, b.name) || a.opportunityId.localeCompare(b.opportunityId),
      );
    case 'stage':
      return copy.sort((a, b) => a.stagePosition - b.stagePosition || byNewest(a, b));
  }
}

export interface LeadFilter {
  readonly query: string;
  /** A stage id, or null for every stage. */
  readonly stageId: string | null;
}

export function filterLeads(leads: readonly Lead[], filter: LeadFilter): Lead[] {
  return leads.filter(
    (l) =>
      (filter.stageId === null || l.stageId === filter.stageId) && matchesQuery(l, filter.query),
  );
}

/** "3 of 10 leads match" · "No leads match" · null when nothing is filtering. */
export function describeMatches(shown: number, total: number, filter: LeadFilter): string | null {
  if (filter.query.trim() === '' && filter.stageId === null) return null;
  if (shown === 0) return 'No leads match';
  return `${String(shown)} of ${String(total)} lead${total === 1 ? '' : 's'} match`;
}

/* ---------- the remembered view ---------- */

export type LeadsViewChoice = 'board' | 'list';

export const VIEW_KEY = 'fundd-leads-view';

export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadViewChoice(storage: ViewStorage | null): LeadsViewChoice | null {
  try {
    const value = storage?.getItem(VIEW_KEY);
    return value === 'board' || value === 'list' ? value : null;
  } catch {
    return null;
  }
}

export function saveViewChoice(storage: ViewStorage | null, view: LeadsViewChoice): void {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    // Private mode or a full store: the choice simply is not remembered this time.
  }
}

/** The board is primary on a desktop, the list on a phone (Part A, fixed decision 2). */
export function defaultViewFor(viewportWidth: number): LeadsViewChoice {
  return viewportWidth >= 768 ? 'board' : 'list';
}
