/**
 * Pure mapping from validated GoHighLevel records to the rows `apply_ghl_snapshot`
 * writes, plus the content hash that makes the write idempotent, plus the one place a
 * custom field value is interpreted by type.
 *
 * Hashing: SHA-256 over a canonical JSON form (fixed key order, custom-field keys sorted)
 * of exactly the columns the database mirrors. Two syncs of an unchanged record produce
 * the same hash, the upsert's WHERE clause skips the row, and the row stays byte-identical
 * — which is what the idempotency test checks.
 */
import { createHash } from 'node:crypto';

import type {
  CustomFieldValue,
  GhlContact,
  GhlCustomFieldDefinition,
  GhlOpportunity,
  GhlPipeline,
  GhlStage,
} from './types.js';

// ---------------------------------------------------------------------------------------
// Snapshot rows — the exact JSON apply_ghl_snapshot reads.
// ---------------------------------------------------------------------------------------

export interface PipelineRow {
  readonly ghl_id: string;
  readonly name: string;
  readonly location_id: string;
  readonly ghl_updated_at: string | null;
}

export interface StageRow {
  readonly ghl_id: string;
  readonly name: string;
  readonly position: number;
  readonly win_probability: number | null;
}

export interface OpportunityRow {
  readonly ghl_id: string;
  readonly stage_ghl_id: string;
  readonly contact_ghl_id: string | null;
  readonly name: string;
  readonly status: GhlOpportunity['status'];
  readonly monetary_value: number | null;
  readonly source: string | null;
  readonly assigned_to: string | null;
  readonly ghl_created_at: string | null;
  readonly ghl_updated_at: string | null;
  readonly last_stage_change_at: string | null;
  readonly last_status_change_at: string | null;
  readonly content_hash: string;
}

export interface ContactRow {
  readonly ghl_id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly full_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string | null;
  readonly dnd: boolean | null;
  readonly tags: readonly string[];
  readonly custom_fields: Readonly<Record<string, CustomFieldValue>>;
  readonly ghl_created_at: string | null;
  readonly ghl_updated_at: string | null;
  readonly content_hash: string;
}

export interface CustomFieldRow {
  readonly ghl_id: string;
  readonly name: string;
  readonly field_key: string | null;
  readonly data_type: string;
  readonly model: string;
  readonly parent_id: string | null;
  readonly position: number | null;
  readonly picklist_options: readonly string[] | null;
}

export interface Snapshot {
  readonly pipeline: PipelineRow;
  readonly stages: readonly StageRow[];
  readonly opportunities_complete: boolean;
  readonly opportunities: readonly OpportunityRow[];
  readonly contacts: readonly ContactRow[];
  readonly custom_fields_complete: boolean;
  readonly custom_fields: readonly CustomFieldRow[];
}

/** Canonical JSON: object keys sorted at every depth, so the hash is order-independent. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function toPipelineRow(pipeline: GhlPipeline, fallbackLocationId: string): PipelineRow {
  return {
    ghl_id: pipeline.id,
    name: pipeline.name,
    location_id: pipeline.locationId ?? fallbackLocationId,
    ghl_updated_at: pipeline.dateUpdated,
  };
}

export function toStageRow(stage: GhlStage): StageRow {
  return {
    ghl_id: stage.id,
    name: stage.name,
    position: stage.position,
    win_probability: stage.stageWinProbability,
  };
}

export function toOpportunityRow(opportunity: GhlOpportunity): OpportunityRow {
  const content = {
    ghl_id: opportunity.id,
    stage_ghl_id: opportunity.pipelineStageId,
    contact_ghl_id: opportunity.contactId,
    name: opportunity.name,
    status: opportunity.status,
    monetary_value: opportunity.monetaryValue,
    source: opportunity.source,
    assigned_to: opportunity.assignedTo,
    ghl_created_at: opportunity.createdAt,
    ghl_updated_at: opportunity.updatedAt,
    last_stage_change_at: opportunity.lastStageChangeAt,
    last_status_change_at: opportunity.lastStatusChangeAt,
  };
  return { ...content, content_hash: contentHash(content) };
}

/** A full name from the parts GHL gives; `contactName` when the parts are absent. */
export function fullNameOf(contact: GhlContact): string | null {
  const parts = [contact.firstName, contact.lastName]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '');
  if (parts.length > 0) return parts.join(' ');
  const whole = (contact.contactName ?? '').trim();
  return whole === '' ? null : whole;
}

export function toContactRow(contact: GhlContact): ContactRow {
  const customFields: Record<string, CustomFieldValue> = {};
  for (const field of contact.customFields) {
    customFields[field.id] = field.value ?? null;
  }
  const content = {
    ghl_id: contact.id,
    first_name: blankToNull(contact.firstName),
    last_name: blankToNull(contact.lastName),
    full_name: fullNameOf(contact),
    email: blankToNull(contact.email),
    phone: blankToNull(contact.phone),
    source: blankToNull(contact.source),
    dnd: contact.dnd,
    tags: [...contact.tags],
    custom_fields: customFields,
    ghl_created_at: contact.dateAdded,
    ghl_updated_at: contact.dateUpdated,
  };
  return { ...content, content_hash: contentHash(content) };
}

export function toCustomFieldRow(definition: GhlCustomFieldDefinition): CustomFieldRow {
  return {
    ghl_id: definition.id,
    name: definition.name,
    field_key: definition.fieldKey,
    data_type: definition.dataType,
    model: definition.model,
    parent_id: definition.parentId,
    position: definition.position,
    picklist_options: definition.picklistOptions,
  };
}

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() === '' ? null : value;
}

// ---------------------------------------------------------------------------------------
// Reading a custom field value by its definition's type (Part 3 will call this).
// ---------------------------------------------------------------------------------------

export type ReadCustomField =
  /** The contact record carried no entry for the field. */
  | { readonly kind: 'absent' }
  /** Present but empty: null, '', whitespace, or an empty list. Different from absent. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'options'; readonly values: readonly string[] }
  /** Present, non-empty, and not what the field's type says it should be. Shown empty, never guessed. */
  | { readonly kind: 'invalid'; readonly reason: string };

const NUMERIC_TYPES: ReadonlySet<string> = new Set(['NUMERICAL', 'MONETORY', 'MONETARY']);
const TEXT_TYPES: ReadonlySet<string> = new Set(['TEXT', 'LARGE_TEXT', 'PHONE', 'EMAIL', 'DATE']);
const SINGLE_OPTION_TYPES: ReadonlySet<string> = new Set(['SINGLE_OPTIONS', 'RADIO']);
const MULTI_OPTION_TYPES: ReadonlySet<string> = new Set(['MULTIPLE_OPTIONS', 'CHECKBOX']);

/**
 * Interpret a stored value by the field's GHL data type. Absent, null, empty string and
 * wrong type are all distinct outcomes (M4 brief) so the screen can show "—" for an
 * empty field and never render a guess for a malformed one.
 */
export function readCustomField(
  dataType: string,
  raw: CustomFieldValue | undefined,
): ReadCustomField {
  if (raw === undefined) return { kind: 'absent' };
  if (raw === null) return { kind: 'empty' };
  if (typeof raw === 'string' && raw.trim() === '') return { kind: 'empty' };
  if (Array.isArray(raw) && raw.every((v) => v.trim() === '')) return { kind: 'empty' };

  const type = dataType.toUpperCase();
  if (NUMERIC_TYPES.has(type)) {
    if (typeof raw === 'number') return { kind: 'number', value: raw };
    if (typeof raw === 'string') {
      const parsed = Number(raw.replace(/[,\s$]/g, ''));
      return Number.isFinite(parsed)
        ? { kind: 'number', value: parsed }
        : { kind: 'invalid', reason: 'not numeric' };
    }
    return { kind: 'invalid', reason: `expected a number, got ${describe(raw)}` };
  }
  if (TEXT_TYPES.has(type)) {
    if (typeof raw === 'string') return { kind: 'text', value: raw };
    if (typeof raw === 'number') return { kind: 'text', value: String(raw) };
    return { kind: 'invalid', reason: `expected text, got ${describe(raw)}` };
  }
  if (SINGLE_OPTION_TYPES.has(type)) {
    if (typeof raw === 'string') return { kind: 'options', values: [raw] };
    if (Array.isArray(raw)) return { kind: 'options', values: nonBlank(raw) };
    return { kind: 'invalid', reason: `expected an option, got ${describe(raw)}` };
  }
  if (MULTI_OPTION_TYPES.has(type)) {
    if (Array.isArray(raw)) return { kind: 'options', values: nonBlank(raw) };
    if (typeof raw === 'string') return { kind: 'options', values: [raw] };
    if (typeof raw === 'boolean') return { kind: 'boolean', value: raw };
    return { kind: 'invalid', reason: `expected options, got ${describe(raw)}` };
  }
  // A type this layer has not seen: keep what GHL sent, typed by its JSON shape.
  if (typeof raw === 'string') return { kind: 'text', value: raw };
  if (typeof raw === 'number') return { kind: 'number', value: raw };
  if (typeof raw === 'boolean') return { kind: 'boolean', value: raw };
  return { kind: 'options', values: nonBlank(raw) };
}

function nonBlank(values: readonly string[]): string[] {
  return values.filter((v) => v.trim() !== '');
}

function describe(value: CustomFieldValue): string {
  if (Array.isArray(value)) return 'a list';
  return typeof value;
}
