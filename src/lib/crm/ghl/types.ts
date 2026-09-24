/**
 * What this system accepts from GoHighLevel, and nothing more.
 *
 * Every response is parsed against one of these Zod schemas before it becomes a typed
 * value; a record that does not match is REJECTED and logged, never written half-parsed
 * (CLAUDE.md rule 13, M4 part 1 brief). Keys that are not listed are stripped — which is
 * also how the opportunity's `relations` and `attributions` blocks (IP address, user
 * agent, Facebook pixel ids) never reach the database.
 *
 * Shapes were taken from one authorized read of the live account on 12 Sep 2026
 * (MEMORY.md), not from documentation: `nextPage` is a number on a middle page and an
 * empty string on the last one; `startAfterId`/`startAfter` are the cursor; a contact's
 * custom field value is a string for a dropdown and a string array for a multi-select.
 *
 * Dates: GHL returns ISO-8601 UTC. They are validated as parseable and NORMALISED to UTC
 * ISO strings — never converted to a local time. The screen converts to Perth time once,
 * at display (Part 3); this layer never does.
 */
import { z } from 'zod';

const isoTimestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'not an ISO-8601 timestamp' })
  .transform((s) => new Date(s).toISOString());

const optionalTimestamp = isoTimestamp.nullish().transform((v) => v ?? null);
const optionalString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

/** A GHL id: a non-empty string. Stages are UUIDs, everything else is a 20-char id. */
const ghlId = z.string().min(1).max(64);

// ---------------------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------------------

export const STAGE_SCHEMA = z.object({
  id: ghlId,
  name: z.string(),
  position: z.number().int().nonnegative(),
  stageWinProbability: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
});

export const PIPELINE_SCHEMA = z.object({
  id: ghlId,
  name: z.string(),
  locationId: optionalString,
  dateUpdated: optionalTimestamp,
  stages: z.array(STAGE_SCHEMA),
});

export const PIPELINES_RESPONSE_SCHEMA = z.object({
  pipelines: z.array(PIPELINE_SCHEMA),
});

export type GhlStage = z.infer<typeof STAGE_SCHEMA>;
export type GhlPipeline = z.infer<typeof PIPELINE_SCHEMA>;

// ---------------------------------------------------------------------------------------
// Opportunities (search)
// ---------------------------------------------------------------------------------------

export const OPPORTUNITY_STATUSES = ['open', 'won', 'lost', 'abandoned'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_SCHEMA = z.object({
  id: ghlId,
  name: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  pipelineId: ghlId,
  pipelineStageId: ghlId,
  contactId: optionalString,
  status: z.enum(OPPORTUNITY_STATUSES),
  // null and 0 are different things (M4 brief): null = GHL carried no value.
  monetaryValue: z
    .number()
    .nullish()
    .transform((v) => v ?? null),
  source: optionalString,
  assignedTo: optionalString,
  createdAt: optionalTimestamp,
  updatedAt: optionalTimestamp,
  lastStageChangeAt: optionalTimestamp,
  lastStatusChangeAt: optionalTimestamp,
});

export type GhlOpportunity = z.infer<typeof OPPORTUNITY_SCHEMA>;

/**
 * The page envelope. Each opportunity is validated INDIVIDUALLY by the client so one bad
 * record is rejected on its own; here the list is only required to be a list.
 */
export const OPPORTUNITY_PAGE_SCHEMA = z.object({
  opportunities: z.array(z.unknown()),
  meta: z
    .object({
      total: z.number().int().nonnegative().nullish(),
      startAfterId: z.string().nullish(),
      startAfter: z.number().nullish(),
      nextPage: z.union([z.number(), z.string(), z.null()]).optional(),
    })
    .nullish(),
});

export type OpportunityPage = z.infer<typeof OPPORTUNITY_PAGE_SCHEMA>;

// ---------------------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------------------

/** What a custom field value may be on the wire. Anything else rejects the contact. */
export const CUSTOM_FIELD_VALUE_SCHEMA = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);
export type CustomFieldValue = z.infer<typeof CUSTOM_FIELD_VALUE_SCHEMA>;

export const CONTACT_SCHEMA = z.object({
  id: ghlId,
  firstName: optionalString,
  lastName: optionalString,
  contactName: optionalString,
  email: optionalString,
  phone: optionalString,
  source: optionalString,
  dnd: z
    .boolean()
    .nullish()
    .transform((v) => v ?? null),
  tags: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
  dateAdded: optionalTimestamp,
  dateUpdated: optionalTimestamp,
  customFields: z
    .array(z.object({ id: ghlId, value: CUSTOM_FIELD_VALUE_SCHEMA.optional() }))
    .nullish()
    .transform((v) => v ?? []),
});

export const CONTACT_RESPONSE_SCHEMA = z.object({ contact: CONTACT_SCHEMA });

export type GhlContact = z.infer<typeof CONTACT_SCHEMA>;

// ---------------------------------------------------------------------------------------
// Custom field definitions
// ---------------------------------------------------------------------------------------

export const CUSTOM_FIELD_DEFINITION_SCHEMA = z.object({
  id: ghlId,
  name: z.string(),
  fieldKey: optionalString,
  dataType: z.string().min(1),
  model: z
    .string()
    .nullish()
    .transform((v) => v ?? 'contact'),
  parentId: optionalString,
  position: z
    .number()
    .int()
    .nullish()
    .transform((v) => v ?? null),
  picklistOptions: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? null),
});

export const CUSTOM_FIELDS_RESPONSE_SCHEMA = z.object({
  customFields: z.array(z.unknown()),
});

export type GhlCustomFieldDefinition = z.infer<typeof CUSTOM_FIELD_DEFINITION_SCHEMA>;

// ---------------------------------------------------------------------------------------
// Writes (Milestone 4 part 4) — shapes taken from the live probe on 24 Sep 2026 against a
// test opportunity, not from documentation.
// ---------------------------------------------------------------------------------------

/**
 * `GET /opportunities/{id}` and the `PUT` that moves a stage both answer
 * `{ opportunity: {...} }` — the search record plus a `contact` sub-object carrying the
 * person's name and email. OPPORTUNITY_SCHEMA strips that sub-object: nothing here needs
 * it and nothing here may log it.
 */
export const OPPORTUNITY_RESPONSE_SCHEMA = z.object({ opportunity: OPPORTUNITY_SCHEMA });

/** `POST /contacts/{id}/notes` → 201 `{ note }`; `userId` is null for an integration. */
export const NOTE_SCHEMA = z.object({
  id: ghlId,
  body: z.string(),
  userId: optionalString,
  dateAdded: optionalTimestamp,
  contactId: optionalString,
});

export const NOTE_RESPONSE_SCHEMA = z.object({ note: NOTE_SCHEMA });

export type GhlNote = z.infer<typeof NOTE_SCHEMA>;

/**
 * GoHighLevel's error envelope, as seen live: `{ statusCode, error, message, code }` for the
 * opportunities API (`OPPORTUNITY_STAGE_ID_INVALID`, `OPPORTUNITY_NOT_FOUND`), `{ message:
 * string[] , statusCode }` for a 422, and `{ error, status }` for a note on a missing
 * contact. Everything is optional so the parse never fails; `code` is what is matched on.
 */
export const GHL_ERROR_BODY_SCHEMA = z.object({
  statusCode: z.number().optional(),
  status: z.number().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

export type GhlErrorBody = z.infer<typeof GHL_ERROR_BODY_SCHEMA>;
