/**
 * The lead detail (Milestone 4 part 4): everything the mirror holds about one lead, laid out
 * to be read on a phone. Pure, so what every line says is unit-tested against known rows.
 *
 * NOTHING IS INVENTED. Every line traces to a column the part-1 sync wrote — the
 * opportunity row, the contact row, the custom-field DEFINITIONS (for the labels) and the
 * seeded field map (for which ids are the form's answers) — plus the notes this part mirrors
 * and the roster (for a note's author). A field GoHighLevel does not hold is shown as "Not
 * captured", never guessed or defaulted (acceptance item 5). Ids that resolve to no
 * definition are shown as ids: raw, but honest.
 */
import { contactDisplayName, customFieldText, type GhlFieldMapRow } from './leadsView.js';
import {
  REMOVED_STAGE_SUFFIX,
  UNKNOWN_STAGE_LABEL,
  UNNAMED_LEAD,
  formatArrival,
  type GhlStageRow,
} from './overviewView.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   Type aliases, not interfaces: supabase-js matches a schema structurally (see supabase.ts). */
/** The whole opportunity row, as the detail selects it. */
export type GhlOpportunityDetailRow = {
  ghl_id: string;
  pipeline_ghl_id: string;
  stage_ghl_id: string;
  contact_ghl_id: string | null;
  name: string;
  status: string;
  monetary_value: number | string | null;
  source: string | null;
  assigned_to: string | null;
  ghl_created_at: string | null;
  ghl_updated_at: string | null;
  last_stage_change_at: string | null;
  last_status_change_at: string | null;
  removed_at: string | null;
};

/** The whole contact row, as the detail selects it. */
export type GhlContactFullRow = {
  ghl_id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  dnd: boolean | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  ghl_created_at: string | null;
  ghl_updated_at: string | null;
  removed_at: string | null;
};

/** A custom-field definition: the label for an id. */
export type GhlCustomFieldRow = {
  ghl_id: string;
  name: string;
  data_type: string;
  parent_id: string | null;
  removed_at: string | null;
};

/** A note this app wrote through to GoHighLevel and mirrored. */
export type GhlNoteRow = {
  ghl_id: string;
  contact_ghl_id: string;
  opportunity_ghl_id: string;
  author_user_id: string | null;
  body: string;
  ghl_date_added: string | null;
  created_at: string;
};

export type RosterEmailRow = { user_id: string; email: string };
/* eslint-enable @typescript-eslint/consistent-type-definitions */

export interface LeadDetailInput {
  readonly opportunity: GhlOpportunityDetailRow | null;
  readonly contact: GhlContactFullRow | null;
  readonly stages: readonly GhlStageRow[];
  readonly customFields: readonly GhlCustomFieldRow[];
  readonly fieldMap: readonly GhlFieldMapRow[];
  readonly notes: readonly GhlNoteRow[];
  readonly roster: readonly RosterEmailRow[];
  /** The signed-in person, so their own notes say "you". */
  readonly viewerId: string;
}

export interface DetailLine {
  readonly label: string;
  /** Null = GoHighLevel holds nothing here; the screen says "Not captured". */
  readonly value: string | null;
}

export interface FormAnswer extends DetailLine {
  readonly fieldId: string;
  /** True for the eleven fields the seed maps; false for any other value the contact carries. */
  readonly mapped: boolean;
  /** True when the label is the id itself: the definition was never mirrored. */
  readonly unlabelled: boolean;
}

export interface NoteView {
  readonly id: string;
  readonly body: string;
  readonly author: string;
  readonly authorIsViewer: boolean;
  /** "Today, 9:15 am" · "Tue 9 Sep" — Perth. */
  readonly when: string;
  readonly at: string | null;
}

export interface StageOption {
  readonly stageId: string;
  readonly name: string;
  readonly number: number;
}

export interface LeadDetailView {
  readonly kind: 'ready';
  readonly opportunityId: string;
  readonly name: string;
  readonly named: boolean;
  readonly stageId: string;
  readonly stageName: string;
  readonly stageKind: 'stage' | 'removed-stage' | 'unknown-stage';
  readonly arrived: string;
  /** From `last_stage_change_at`; null when GoHighLevel carried none. */
  readonly inStageSince: string | null;
  readonly status: string;
  readonly contact: {
    readonly known: boolean;
    readonly email: string | null;
    readonly phone: string | null;
    readonly source: string | null;
    readonly tags: readonly string[];
    /** GoHighLevel's do-not-disturb flag; null = not carried. */
    readonly dnd: boolean | null;
    readonly added: string | null;
  };
  readonly opportunity: readonly DetailLine[];
  readonly answers: readonly FormAnswer[];
  readonly notes: readonly NoteView[];
  /** The live stages of the pipeline, in order, for the move control. */
  readonly stageOptions: readonly StageOption[];
  readonly ids: { readonly opportunityId: string; readonly contactId: string | null };
}

export type LeadDetailState =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'removed'; readonly name: string }
  | LeadDetailView;

/** The seed's order for the form's answers (supabase/seed.sql, `entity = 'contact'`). */
export const MAPPED_FIELD_ORDER: readonly string[] = [
  'loan_type',
  'loan_amount',
  'property_value',
  'deposit_amount',
  'employment_type',
  'annual_income',
  'credit_concerns',
  'lead_source',
  'preferred_contact_time',
  'loan_balance',
  'current_interest_rate',
];

export const NOT_CAPTURED = 'Not captured';

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

/** "loan_balance" → "Loan balance": the fallback label when no definition was mirrored. */
export function humanise(internal: string): string {
  const words = internal.replace(/_/g, ' ').trim();
  return words === '' ? internal : words.charAt(0).toUpperCase() + words.slice(1);
}

/** GoHighLevel's monetary value as money, or null when it carried none. 0 is "$0". */
export function formatValue(raw: number | string | null): string | null {
  if (raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return AUD.format(n);
}

function statusWord(status: string): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'won':
      return 'Won';
    case 'lost':
      return 'Lost';
    case 'abandoned':
      return 'Abandoned';
    default:
      return status;
  }
}

export function buildLeadDetail(input: LeadDetailInput, nowMs: number): LeadDetailState {
  const o = input.opportunity;
  if (o === null) return { kind: 'not-found' };
  const contact = input.contact;
  const contactName = contactDisplayName(contact ?? undefined);
  const ownName = o.name.trim();
  const name = contactName ?? (ownName === '' ? UNNAMED_LEAD : ownName);
  if (o.removed_at !== null) return { kind: 'removed', name };

  const stage = input.stages.find((s) => s.ghl_id === o.stage_ghl_id);
  const stageKind: LeadDetailView['stageKind'] =
    stage === undefined ? 'unknown-stage' : stage.removed_at === null ? 'stage' : 'removed-stage';
  const stageName =
    stage === undefined
      ? UNKNOWN_STAGE_LABEL
      : stageKind === 'removed-stage'
        ? `${stage.name}${REMOVED_STAGE_SUFFIX}`
        : stage.name;

  const liveStages = input.stages
    .filter((s) => s.pipeline_ghl_id === o.pipeline_ghl_id && s.removed_at === null)
    .sort((a, b) => a.position - b.position || a.ghl_id.localeCompare(b.ghl_id));
  const stageOptions: StageOption[] = liveStages.map((s, i) => ({
    stageId: s.ghl_id,
    name: s.name,
    number: i + 1,
  }));

  const definitions = new Map(input.customFields.map((f) => [f.ghl_id, f]));
  const values = contact?.custom_fields ?? {};
  const answers: FormAnswer[] = [];
  const seen = new Set<string>();
  for (const internal of MAPPED_FIELD_ORDER) {
    const row = input.fieldMap.find((r) => r.entity === 'contact' && r.internal_field === internal);
    const fieldId = row?.ghl_custom_field_id?.trim() ?? '';
    if (fieldId === '') continue;
    seen.add(fieldId);
    const definition = definitions.get(fieldId);
    answers.push({
      fieldId,
      label: definition?.name ?? humanise(internal),
      value: customFieldText(values[fieldId]),
      mapped: true,
      unlabelled: false,
    });
  }
  // Anything else the contact carries: labelled by its definition when mirrored, else by id.
  for (const fieldId of Object.keys(values).sort()) {
    if (seen.has(fieldId)) continue;
    const value = customFieldText(values[fieldId]);
    if (value === null) continue;
    const definition = definitions.get(fieldId);
    answers.push({
      fieldId,
      label: definition?.name ?? fieldId,
      value,
      mapped: false,
      unlabelled: definition === undefined,
    });
  }

  const roster = new Map(input.roster.map((r) => [r.user_id, r.email]));
  const notes: NoteView[] = [...input.notes]
    .filter((n) => n.opportunity_ghl_id === o.ghl_id)
    .sort((a, b) => {
      const at = (n: GhlNoteRow): number => Date.parse(n.ghl_date_added ?? n.created_at) || 0;
      return at(b) - at(a) || b.ghl_id.localeCompare(a.ghl_id);
    })
    .map((n) => {
      const at = n.ghl_date_added ?? n.created_at;
      const isViewer = n.author_user_id === input.viewerId;
      return {
        id: n.ghl_id,
        body: n.body,
        author: isViewer
          ? 'You'
          : n.author_user_id === null
            ? 'Unknown'
            : (roster.get(n.author_user_id) ?? 'A former team member'),
        authorIsViewer: isViewer,
        when: formatArrival(at, nowMs),
        at,
      };
    });

  const opportunityLines: DetailLine[] = [
    { label: 'Status', value: statusWord(o.status) },
    { label: 'Value', value: formatValue(o.monetary_value) },
    { label: 'Opportunity name', value: ownName === '' ? null : ownName },
    { label: 'Source', value: o.source?.trim() === '' ? null : o.source },
    {
      label: 'Last updated in GoHighLevel',
      value: o.ghl_updated_at === null ? null : formatArrival(o.ghl_updated_at, nowMs),
    },
    {
      label: 'Status changed',
      value:
        o.last_status_change_at === null ? null : formatArrival(o.last_status_change_at, nowMs),
    },
    {
      label: 'Assigned to (GoHighLevel user id)',
      value: o.assigned_to?.trim() === '' ? null : o.assigned_to,
    },
  ];

  return {
    kind: 'ready',
    opportunityId: o.ghl_id,
    name,
    named: contactName !== null,
    stageId: o.stage_ghl_id,
    stageName,
    stageKind,
    arrived: formatArrival(o.ghl_created_at, nowMs),
    inStageSince:
      o.last_stage_change_at === null ? null : formatArrival(o.last_stage_change_at, nowMs),
    status: o.status,
    contact: {
      known: contact !== null,
      email: contact?.email?.trim() === '' ? null : (contact?.email ?? null),
      phone: contact?.phone?.trim() === '' ? null : (contact?.phone ?? null),
      source: contact?.source?.trim() === '' ? null : (contact?.source ?? null),
      tags: contact?.tags ?? [],
      dnd: contact?.dnd ?? null,
      added:
        contact?.ghl_created_at === null || contact === null
          ? null
          : formatArrival(contact.ghl_created_at, nowMs),
    },
    opportunity: opportunityLines,
    answers,
    notes,
    stageOptions,
    ids: { opportunityId: o.ghl_id, contactId: o.contact_ghl_id },
  };
}

/** A phone number as a `tel:` target: digits and a leading plus, nothing else. */
export function telHref(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, '');
  return `tel:${cleaned}`;
}
