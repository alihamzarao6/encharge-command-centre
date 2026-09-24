/**
 * Moving a lead and adding a note (Milestone 4 part 4): the orchestration between the
 * browser's request, GoHighLevel and the mirror. Pure of I/O — every side effect is behind
 * `WriteStore` and `GhlWriteClient` — so every branch below is unit-tested with fakes.
 *
 * The order is fixed (Part A decision 2): claim the request id → check the target stage
 * against the mirror → READ the opportunity live → write to GoHighLevel → update the mirror
 * from GoHighLevel's answer, in that order, and never the mirror before GoHighLevel.
 *
 *   - The request id is claimed FIRST, in the database, so a replay of the same gesture
 *     (Try again after a dropped connection, a double-tap that slipped through) is answered
 *     from the record and never sent to GoHighLevel twice (rule 9). A gesture towards the
 *     stage the lead is already in is a `noop`: read, not written.
 *   - The live read is what the move acts on, not the mirror and not what the screen showed
 *     ten minutes ago. Deleted → refused and the mirror row marked removed. In another
 *     pipeline → refused, no write, whatever the mirror says (R22, R25). Closed → refused.
 *     Moved by someone else since the screen loaded → the move still proceeds (last write
 *     wins, deliberately) and the reply says so, with the real previous stage.
 *   - The write is sent ONCE. When the answer is uncertain — a timeout, a dropped connection,
 *     a 5xx, a reply of the wrong shape — the opportunity is READ again to learn whether the
 *     move landed; it is never written again (rule 8). Landed → success, noted as such. Not
 *     landed → failed, and the mirror is set to what GoHighLevel actually holds. The read
 *     also failing → `unknown`: the screen puts the card back and says the next refresh will
 *     show where the lead is; the sync reconciles by hash.
 *   - One database function closes the write record, updates the mirror row from
 *     GoHighLevel's own reply and writes the audit row, in one transaction. If that fails
 *     after GoHighLevel succeeded, GoHighLevel is right: the reply still says moved, the
 *     record says `mirror_failed`, and the next sync overwrites the row.
 *
 * Nothing here logs a name, an email or a phone: ids, stage ids, statuses and durations.
 */
import type { AppError, Result } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { GhlConfig } from './config.js';
import { toOpportunityRow, type OpportunityRow } from './map.js';
import type { GhlOpportunity } from './types.js';
import { GhlWriteRefusedError, type GhlWriteClient } from './write.js';

export { NOTE_MAX_LENGTH } from '../notes.js';

export type WriteKind = 'stage_move' | 'note';
export type WriteStatus = 'in_flight' | 'success' | 'noop' | 'failed' | 'unknown' | 'mirror_failed';

export interface MirrorOpportunity {
  readonly pipelineId: string;
  readonly stageId: string;
  readonly contactId: string | null;
  readonly removedAt: string | null;
}

export interface BeginWriteInput {
  readonly requestId: string;
  readonly actor: string;
  readonly kind: WriteKind;
  readonly pipelineId: string;
  readonly opportunityId: string;
  readonly contactId: string | null;
  readonly screenStageId: string | null;
  readonly toStageId: string | null;
}

export interface BeginWriteResult {
  readonly id: string;
  /** True when another request with this id got there first; `status` is that request's. */
  readonly existing: boolean;
  readonly status: WriteStatus;
  readonly fromStageId: string | null;
  readonly toStageId: string | null;
  readonly errorCode: string | null;
}

export interface NoteRow {
  readonly ghl_id: string;
  readonly contact_ghl_id: string;
  readonly opportunity_ghl_id: string;
  /** Without the "[Fundd app · email]" prefix GoHighLevel shows. */
  readonly body: string;
  readonly ghl_date_added: string | null;
}

export interface FinishWriteInput {
  readonly id: string;
  readonly status: Exclude<WriteStatus, 'in_flight'>;
  readonly ghlStatus: number | null;
  readonly errorCode: string | null;
  readonly durationMs: number;
  /** The stage GoHighLevel held live before a move; null for a note or when never read. */
  readonly fromStageId: string | null;
  /** The opportunity as GoHighLevel returned it — updates the mirror row; null = untouched. */
  readonly opportunity: OpportunityRow | null;
  readonly note: NoteRow | null;
}

export interface WriteStore {
  /** Live (not removed) stage ids of the pipeline, from the mirror. */
  liveStageIds(pipelineId: string): Promise<Result<readonly string[]>>;
  /** The mirror row, or null when the mirror has never seen this opportunity. */
  mirrorOpportunity(opportunityId: string): Promise<Result<MirrorOpportunity | null>>;
  beginWrite(input: BeginWriteInput): Promise<Result<BeginWriteResult>>;
  finishWrite(input: FinishWriteInput): Promise<Result<void>>;
  /** GoHighLevel answered 404: mark the row removed now. True when this call marked it. */
  markOpportunityRemoved(opportunityId: string): Promise<Result<boolean>>;
}

export interface MoveDeps {
  readonly config: GhlConfig;
  readonly write: GhlWriteClient;
  readonly store: WriteStore;
  readonly log: Logger;
  readonly now?: () => number;
}

export interface Actor {
  readonly userId: string;
  readonly email: string;
}

export interface MoveRequest {
  readonly requestId: string;
  readonly opportunityId: string;
  readonly toStageId: string;
  /** The stage the screen showed when the person acted, or null when it did not know. */
  readonly screenStageId: string | null;
}

export interface NoteRequest {
  readonly requestId: string;
  readonly opportunityId: string;
  readonly body: string;
}

/** Why a write was refused before or by GoHighLevel: a definite answer, nothing applied. */
export type RefusalReason =
  /** The live read answered 404: deleted in GoHighLevel. The mirror row is now marked. */
  | 'OPPORTUNITY_GONE'
  /** The opportunity is not in the configured pipeline (R22): never written. */
  | 'OUTSIDE_PIPELINE'
  /** Closed (won / lost / abandoned) in GoHighLevel since the screen loaded. */
  | 'NOT_OPEN'
  /** The target stage is not a live stage of the pipeline (mirror or GoHighLevel said so). */
  | 'STAGE_UNKNOWN'
  /** The same request id is being processed right now. */
  | 'IN_FLIGHT'
  /** The same request id already finished with a failure; a retry needs a new id. */
  | 'REQUEST_REUSED'
  /** A note needs a contact and GoHighLevel holds none for this opportunity. */
  | 'NO_CONTACT'
  /** GoHighLevel refused the note body. */
  | 'NOTE_REJECTED';

/** Why a write failed: GoHighLevel could not be written, or did not say. */
export type FailureCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'CIRCUIT_OPEN'
  /** A non-2xx answer other than the typed refusals: nothing applied (confirmed by re-read). */
  | 'GHL_ERROR'
  /** GoHighLevel answered 2xx with a body of the wrong shape, and the re-read says not applied. */
  | 'RESPONSE_SHAPE'
  /** The write's outcome could not be learned: the write and the re-read both failed. */
  | 'UNKNOWN'
  /** The database refused before GoHighLevel was involved. */
  | 'STORE';

export interface MoveDetail {
  readonly writeId: string;
  readonly opportunityId: string;
  /** The stage GoHighLevel held before the move (live), not what the screen showed. */
  readonly fromStageId: string;
  readonly toStageId: string;
  /** True when the live stage differed from the one the screen showed: someone else moved it. */
  readonly movedByOther: boolean;
  readonly durationMs: number;
  /** The answer came from the record of an earlier request with the same id, not a new write. */
  readonly replay: boolean;
  /** The write timed out (or the like) and a re-read found it had landed. */
  readonly landedAfterTimeout: boolean;
  /** False when GoHighLevel changed but the mirror row could not be updated. */
  readonly mirrored: boolean;
}

export type MoveOutcome =
  | ({ readonly kind: 'moved' } & MoveDetail)
  | ({ readonly kind: 'unchanged' } & MoveDetail)
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly writeId: string | null }
  | {
      readonly kind: 'failed';
      readonly code: FailureCode;
      readonly writeId: string | null;
      readonly ghlStatus: number | null;
    };

export interface NoteDetail {
  readonly writeId: string;
  readonly opportunityId: string;
  readonly contactId: string;
  readonly noteId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly durationMs: number;
  readonly replay: boolean;
  readonly mirrored: boolean;
}

export type NoteOutcome =
  | ({ readonly kind: 'noted' } & NoteDetail)
  | { readonly kind: 'refused'; readonly reason: RefusalReason; readonly writeId: string | null }
  | {
      readonly kind: 'failed';
      readonly code: FailureCode;
      readonly writeId: string | null;
      readonly ghlStatus: number | null;
    };

/** The prefix GoHighLevel shows so a note is attributable there; the mirror stores the body alone. */
export function notePrefix(actor: Actor): string {
  return `[Fundd app · ${actor.email}] `;
}

const FAILURE_CODES: Readonly<Partial<Record<AppError['code'], FailureCode>>> = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  VALIDATION: 'RESPONSE_SHAPE',
};

function failureCodeOf(error: AppError): FailureCode {
  return FAILURE_CODES[error.code] ?? 'GHL_ERROR';
}

function ghlStatusOf(error: AppError): number | null {
  const status = error.context['status'];
  return typeof status === 'number' ? status : null;
}

/** A write whose answer is not known to be "not applied": read before deciding. */
function isUncertain(error: AppError): boolean {
  if (error instanceof GhlWriteRefusedError) return false;
  return (
    error.code !== 'UNAUTHENTICATED' && error.code !== 'FORBIDDEN' && error.code !== 'RATE_LIMITED'
  );
}

export async function moveLead(
  deps: MoveDeps,
  actor: Actor,
  request: MoveRequest,
): Promise<MoveOutcome> {
  const { config, write, store } = deps;
  const log = deps.log.child({ component: 'ghl-move' });
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);
  const base = {
    actor: actor.userId,
    opportunityId: request.opportunityId,
    toStageId: request.toStageId,
    screenStageId: request.screenStageId,
  };

  const mirror = await store.mirrorOpportunity(request.opportunityId);
  if (!mirror.ok) {
    log.error('move: mirror row could not be read', { ...base, error: mirror.error });
    return { kind: 'failed', code: 'STORE', writeId: null, ghlStatus: null };
  }

  const begin = await store.beginWrite({
    requestId: request.requestId,
    actor: actor.userId,
    kind: 'stage_move',
    pipelineId: config.pipelineId,
    opportunityId: request.opportunityId,
    contactId: mirror.value?.contactId ?? null,
    screenStageId: request.screenStageId,
    toStageId: request.toStageId,
  });
  if (!begin.ok) {
    log.error('move: write record could not be started', { ...base, error: begin.error });
    return { kind: 'failed', code: 'STORE', writeId: null, ghlStatus: null };
  }
  const writeId = begin.value.id;

  if (begin.value.existing) {
    const prior = begin.value;
    log.info('move: request id seen before; answering from the record', {
      ...base,
      writeId,
      status: prior.status,
    });
    if (prior.status === 'in_flight') return { kind: 'refused', reason: 'IN_FLIGHT', writeId };
    if (
      (prior.status === 'success' || prior.status === 'noop' || prior.status === 'mirror_failed') &&
      prior.fromStageId !== null &&
      prior.toStageId !== null
    ) {
      const detail: MoveDetail = {
        writeId,
        opportunityId: request.opportunityId,
        fromStageId: prior.fromStageId,
        toStageId: prior.toStageId,
        movedByOther: request.screenStageId !== null && request.screenStageId !== prior.fromStageId,
        durationMs: elapsed(),
        replay: true,
        landedAfterTimeout: false,
        mirrored: prior.status !== 'mirror_failed',
      };
      return prior.status === 'noop'
        ? { kind: 'unchanged', ...detail }
        : { kind: 'moved', ...detail };
    }
    return { kind: 'refused', reason: 'REQUEST_REUSED', writeId };
  }

  const finish = async (
    status: FinishWriteInput['status'],
    ghlStatus: number | null,
    errorCode: string | null,
    fromStageId: string | null,
    opportunity: GhlOpportunity | null,
  ): Promise<boolean> => {
    const done = await store.finishWrite({
      id: writeId,
      status,
      ghlStatus,
      errorCode,
      durationMs: elapsed(),
      fromStageId,
      opportunity: opportunity === null ? null : toOpportunityRow(opportunity),
      note: null,
    });
    if (!done.ok) {
      log.error('move: write record could not be finished', {
        ...base,
        writeId,
        status,
        error: done.error,
      });
      return false;
    }
    return true;
  };

  const refuse = async (
    reason: RefusalReason,
    ghlStatus: number | null,
    fromStageId: string | null,
    opportunity: GhlOpportunity | null,
  ): Promise<MoveOutcome> => {
    await finish('failed', ghlStatus, reason, fromStageId, opportunity);
    log.warn('move: refused', { ...base, writeId, reason, ghlStatus, durationMs: elapsed() });
    return { kind: 'refused', reason, writeId };
  };

  const fail = async (
    code: FailureCode,
    status: 'failed' | 'unknown',
    ghlStatus: number | null,
    fromStageId: string | null,
    opportunity: GhlOpportunity | null,
  ): Promise<MoveOutcome> => {
    await finish(status, ghlStatus, code, fromStageId, opportunity);
    log.error('move: failed', { ...base, writeId, code, status, ghlStatus, durationMs: elapsed() });
    return { kind: 'failed', code, writeId, ghlStatus };
  };

  // The target must be a live stage of THIS pipeline as the mirror knows it. GoHighLevel
  // checks again (OPPORTUNITY_STAGE_ID_INVALID); this check refuses before any request.
  const stages = await store.liveStageIds(config.pipelineId);
  if (!stages.ok) {
    log.error('move: stages could not be read', { ...base, writeId, error: stages.error });
    await finish('failed', null, 'STORE', null, null);
    return { kind: 'failed', code: 'STORE', writeId, ghlStatus: null };
  }
  if (!stages.value.includes(request.toStageId)) {
    return refuse('STAGE_UNKNOWN', null, null, null);
  }

  // The real current state, never the mirror.
  const live = await write.getOpportunity(request.opportunityId);
  if (!live.ok) {
    return fail(failureCodeOf(live.error), 'failed', ghlStatusOf(live.error), null, null);
  }
  if (live.value === null) {
    await store.markOpportunityRemoved(request.opportunityId);
    return refuse('OPPORTUNITY_GONE', 404, null, null);
  }
  const current = live.value;
  if (current.pipelineId !== config.pipelineId) {
    // Never write outside the configured pipeline, whatever the mirror said (R22, R25).
    log.error('move: opportunity is in another pipeline; refused without a write', {
      ...base,
      writeId,
      pipelineId: current.pipelineId,
    });
    return refuse('OUTSIDE_PIPELINE', null, current.pipelineStageId, null);
  }
  if (current.status !== 'open') {
    return refuse('NOT_OPEN', null, current.pipelineStageId, current);
  }
  const fromStageId = current.pipelineStageId;
  const movedByOther = request.screenStageId !== null && request.screenStageId !== fromStageId;

  const detail = (
    opportunity: GhlOpportunity,
    extra: Partial<Pick<MoveDetail, 'landedAfterTimeout' | 'mirrored'>> = {},
  ): MoveDetail => ({
    writeId,
    opportunityId: request.opportunityId,
    fromStageId,
    toStageId: opportunity.pipelineStageId,
    movedByOther,
    durationMs: elapsed(),
    replay: false,
    landedAfterTimeout: false,
    mirrored: true,
    ...extra,
  });

  if (fromStageId === request.toStageId) {
    const mirrored = await finish('noop', null, null, fromStageId, current);
    log.info('move: already in the target stage; nothing written', {
      ...base,
      writeId,
      fromStageId,
      durationMs: elapsed(),
    });
    return { kind: 'unchanged', ...detail(current, { mirrored }) };
  }

  const put = await write.updateStage(request.opportunityId, request.toStageId);
  if (put.ok) {
    const answered = put.value.opportunity;
    if (answered.pipelineStageId !== request.toStageId) {
      // 2xx, valid shape, wrong stage: GoHighLevel's answer is the truth for the mirror, and
      // the move did not happen.
      return fail('GHL_ERROR', 'failed', put.value.status, fromStageId, answered);
    }
    const mirrored = await finish('success', put.value.status, null, fromStageId, answered);
    log.info('move: moved', {
      ...base,
      writeId,
      fromStageId,
      movedByOther,
      ghlStatus: put.value.status,
      attempts: put.value.attempts,
      durationMs: elapsed(),
      mirrored,
    });
    return { kind: 'moved', ...detail(answered, { mirrored }) };
  }

  const error = put.error;
  if (error instanceof GhlWriteRefusedError) {
    if (error.reason === 'OPPORTUNITY_NOT_FOUND') {
      await store.markOpportunityRemoved(request.opportunityId);
      return refuse('OPPORTUNITY_GONE', error.status, fromStageId, null);
    }
    return refuse('STAGE_UNKNOWN', error.status, fromStageId, current);
  }
  if (!isUncertain(error)) {
    return fail(failureCodeOf(error), 'failed', ghlStatusOf(error), fromStageId, current);
  }

  // Uncertain: the write may or may not have landed. READ, never write again (rule 8).
  const code = failureCodeOf(error);
  log.warn('move: write answer uncertain; re-reading the opportunity', {
    ...base,
    writeId,
    code,
    ghlStatus: ghlStatusOf(error),
  });
  const again = await write.getOpportunity(request.opportunityId);
  if (!again.ok) {
    return fail('UNKNOWN', 'unknown', ghlStatusOf(error), fromStageId, null);
  }
  if (again.value === null) {
    await store.markOpportunityRemoved(request.opportunityId);
    return refuse('OPPORTUNITY_GONE', 404, fromStageId, null);
  }
  if (again.value.pipelineStageId === request.toStageId) {
    const mirrored = await finish('success', ghlStatusOf(error), null, fromStageId, again.value);
    log.info('move: landed despite the uncertain answer', {
      ...base,
      writeId,
      fromStageId,
      code,
      durationMs: elapsed(),
      mirrored,
    });
    return { kind: 'moved', ...detail(again.value, { landedAfterTimeout: true, mirrored }) };
  }
  return fail(code, 'failed', ghlStatusOf(error), fromStageId, again.value);
}

export async function addNote(
  deps: MoveDeps,
  actor: Actor,
  request: NoteRequest,
): Promise<NoteOutcome> {
  const { config, write, store } = deps;
  const log = deps.log.child({ component: 'ghl-note' });
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => Math.max(0, now() - startedAt);
  const base = {
    actor: actor.userId,
    opportunityId: request.opportunityId,
    bodyLength: request.body.length,
  };

  const mirror = await store.mirrorOpportunity(request.opportunityId);
  if (!mirror.ok) {
    log.error('note: mirror row could not be read', { ...base, error: mirror.error });
    return { kind: 'failed', code: 'STORE', writeId: null, ghlStatus: null };
  }

  const begin = await store.beginWrite({
    requestId: request.requestId,
    actor: actor.userId,
    kind: 'note',
    pipelineId: config.pipelineId,
    opportunityId: request.opportunityId,
    contactId: mirror.value?.contactId ?? null,
    screenStageId: null,
    toStageId: null,
  });
  if (!begin.ok) {
    log.error('note: write record could not be started', { ...base, error: begin.error });
    return { kind: 'failed', code: 'STORE', writeId: null, ghlStatus: null };
  }
  const writeId = begin.value.id;
  if (begin.value.existing) {
    log.info('note: request id seen before', { ...base, writeId, status: begin.value.status });
    if (begin.value.status === 'in_flight')
      return { kind: 'refused', reason: 'IN_FLIGHT', writeId };
    // A note's content is not on the write row, so a replay of a success cannot be re-answered
    // with the note; the screen treats REQUEST_REUSED on a note as "already saved — reload".
    return { kind: 'refused', reason: 'REQUEST_REUSED', writeId };
  }

  const finish = async (
    status: FinishWriteInput['status'],
    ghlStatus: number | null,
    errorCode: string | null,
    opportunity: GhlOpportunity | null,
    note: NoteRow | null,
  ): Promise<boolean> => {
    const done = await store.finishWrite({
      id: writeId,
      status,
      ghlStatus,
      errorCode,
      durationMs: elapsed(),
      fromStageId: null,
      opportunity: opportunity === null ? null : toOpportunityRow(opportunity),
      note,
    });
    if (!done.ok) {
      log.error('note: write record could not be finished', {
        ...base,
        writeId,
        status,
        error: done.error,
      });
      return false;
    }
    return true;
  };

  const refuse = async (
    reason: RefusalReason,
    ghlStatus: number | null,
    opportunity: GhlOpportunity | null,
  ): Promise<NoteOutcome> => {
    await finish('failed', ghlStatus, reason, opportunity, null);
    log.warn('note: refused', { ...base, writeId, reason, ghlStatus, durationMs: elapsed() });
    return { kind: 'refused', reason, writeId };
  };

  const fail = async (
    code: FailureCode,
    status: 'failed' | 'unknown',
    ghlStatus: number | null,
    opportunity: GhlOpportunity | null,
  ): Promise<NoteOutcome> => {
    await finish(status, ghlStatus, code, opportunity, null);
    log.error('note: failed', { ...base, writeId, code, status, ghlStatus, durationMs: elapsed() });
    return { kind: 'failed', code, writeId, ghlStatus };
  };

  const live = await write.getOpportunity(request.opportunityId);
  if (!live.ok) {
    return fail(failureCodeOf(live.error), 'failed', ghlStatusOf(live.error), null);
  }
  if (live.value === null) {
    await store.markOpportunityRemoved(request.opportunityId);
    return refuse('OPPORTUNITY_GONE', 404, null);
  }
  const current = live.value;
  if (current.pipelineId !== config.pipelineId) {
    log.error('note: opportunity is in another pipeline; refused without a write', {
      ...base,
      writeId,
      pipelineId: current.pipelineId,
    });
    return refuse('OUTSIDE_PIPELINE', null, null);
  }
  if (current.contactId === null) {
    return refuse('NO_CONTACT', null, current);
  }
  const contactId = current.contactId;

  const posted = await write.createNote(contactId, `${notePrefix(actor)}${request.body}`);
  if (posted.ok) {
    const note = posted.value;
    const createdAt = note.dateAdded ?? new Date(now()).toISOString();
    const mirrored = await finish('success', 201, null, current, {
      ghl_id: note.id,
      contact_ghl_id: contactId,
      opportunity_ghl_id: request.opportunityId,
      body: request.body,
      ghl_date_added: createdAt,
    });
    log.info('note: added', {
      ...base,
      writeId,
      contactId,
      noteId: note.id,
      durationMs: elapsed(),
      mirrored,
    });
    return {
      kind: 'noted',
      writeId,
      opportunityId: request.opportunityId,
      contactId,
      noteId: note.id,
      body: request.body,
      createdAt,
      durationMs: elapsed(),
      replay: false,
      mirrored,
    };
  }

  const error = posted.error;
  if (error instanceof GhlWriteRefusedError) {
    if (error.reason === 'NOTE_REJECTED') return refuse('NOTE_REJECTED', error.status, current);
    if (error.reason === 'CONTACT_NOT_FOUND') return refuse('NO_CONTACT', error.status, current);
    if (error.reason === 'OPPORTUNITY_NOT_FOUND') {
      await store.markOpportunityRemoved(request.opportunityId);
      return refuse('OPPORTUNITY_GONE', error.status, null);
    }
    return refuse('NOTE_REJECTED', error.status, current);
  }
  if (!isUncertain(error)) {
    return fail(failureCodeOf(error), 'failed', ghlStatusOf(error), current);
  }
  // A note cannot be re-read cheaply (there is no id to look for), so an uncertain answer
  // stays unknown: the text stays in the box and the sentence says to check the CRM first.
  return fail('UNKNOWN', 'unknown', ghlStatusOf(error), current);
}
