/**
 * The overview's write path (Milestone 4 part 2): "refresh from GoHighLevel" — server-side,
 * runtime-agnostic, never throws. The Supabase Edge Function `crm` is a thin adapter over
 * `handleCrmRequest`, exactly as `admin` is over `handleUsersRequest`.
 *
 * NOTHING IS READ THROUGH HERE. The overview selects the six `ghl_*` mirror tables directly
 * under RLS as the signed-in person (migration 20260912010000: SELECT for active staff, no
 * write policy at all). This endpoint exists because the mirror can only be refreshed by the
 * one process that holds the GoHighLevel token — `src/lib/crm/ghl/config.ts` is its sole
 * reader — and that process is the server. The browser asks; the server reads GoHighLevel and
 * writes the tables; the browser re-reads them.
 *
 * ONE ACTION, `sync`, open to every active allowlisted member, not only administrators: a
 * refresh is a read of GoHighLevel and a rewrite of a mirror the same person can already
 * read, so there is nothing to protect that RLS does not already protect. The run row
 * records who asked (`triggered_by`), which is the audit trail.
 *
 * WHAT COMES BACK is ids and counts, never a person's details: the sync report already keeps
 * to GHL ids (CLAUDE.md rule 20), and the reply repeats only the parts the screen needs. A
 * failure names its cause in a sentence written here — a rejected token says so, in words,
 * because the numbers on screen being possibly wrong is the thing the client must see.
 *
 * Two syncs cannot overlap: the database refuses the second with a definite error, which
 * this endpoint turns into 409 rather than a wait. The screen polls the run row instead.
 *
 * TWO SYNCS CANNOT FOLLOW EACH OTHER TOO CLOSELY EITHER (part 3, item 10). The token behind
 * this read also serves the client's live lead flow, and GoHighLevel allows 100 requests per
 * 10 seconds on it; a refresh is a dozen of those and grows with the pipeline. Before a run
 * starts, the newest run row is read, and a run that ended inside the window
 * `src/lib/crm/cooldown.ts` defines is a 429 with how long to wait — enforced here, not only
 * by a disabled button. Two requests in the same instant can both pass this check; the
 * database's one-running-slot rule then refuses the second, so the worst case is one run.
 *
 * PART 4 — THE FIRST WRITES: two more actions, `move` (a stage change) and `note`, open to
 * the same people, validated here and carried out by moves.ts. Every one is keyed on the
 * browser's `requestId` (idempotent, rule 9), acts on the opportunity as GoHighLevel holds it
 * live, is refused without a write if the opportunity is outside the configured pipeline
 * (R22, R25), and answers in a sentence written for the person holding the phone — a
 * refused or failed write always says the lead was NOT moved and where it is.
 *
 * THE SCHEDULE (14 Oct 2026, D111–D116): a fourth action, `scheduled-sync`, for the database's
 * scheduler and nobody else. It has no session, so it is not verified as staff; it carries a
 * two-minute token signed with a secret of its own, in a header of its own
 * (src/lib/crm/schedule.ts), and without a good one it is a 401 before anything is read. It runs the same `runSync` with `trigger:
 * 'schedule'` and no user. It does NOT consult the cooldown — at one request every ten minutes
 * it cannot hammer GoHighLevel, and consulting it would let a press at 09:59 cancel the 10:00
 * run. The lock is the only thing that can refuse it, and a refusal there is not a failure:
 * the mirror is being refreshed that second by whoever holds the slot. A scheduled run DOES
 * count towards the button's cooldown, because the cooldown reads the newest run of any kind.
 * Every scheduled request writes one structured line: when it started, what it fetched, what
 * it changed, how long it took and how it ended — ids and counts, never a person's details.
 */
import { verifyStaffAccess, type VerifyDeps } from '../../auth/verify.js';
import type { Result } from '../../errors.js';
import type { Logger } from '../../logger.js';
import {
  SYNC_COOLDOWN_MS,
  cooldownRemainingMs,
  describeCooldown,
  type CooldownRun,
} from '../cooldown.js';
import { SCHEDULED_SYNC_ACTION, changesOf, checkScheduleToken } from '../schedule.js';
import {
  NOTE_MAX_LENGTH,
  type Actor,
  type FailureCode,
  type MoveOutcome,
  type MoveRequest,
  type NoteOutcome,
  type NoteRequest,
  type RefusalReason,
} from './moves.js';
import type { RunOptions, SyncErrorEntry, SyncReport } from './sync.js';

export interface CrmRequestBody {
  readonly action?: unknown;
  /** move / note: the opportunity, always by GoHighLevel id. */
  readonly opportunityId?: unknown;
  /** move: the target stage id and, when the screen knows it, the stage it showed. */
  readonly toStageId?: unknown;
  readonly fromStageId?: unknown;
  /** move / note: a uuid minted per gesture — the idempotency key. */
  readonly requestId?: unknown;
  /** note: the text. */
  readonly body?: unknown;
}

export interface CrmPageInput {
  readonly token: string | null | undefined;
  readonly body: CrmRequestBody;
  /** The scheduler's two-minute token, from its own header. A browser never sends one. */
  readonly scheduleToken?: string | null | undefined;
}

export interface CrmSyncReply {
  readonly action: 'sync';
  readonly status: 'success' | 'partial';
  readonly runId: string;
  readonly durationMs: number;
  readonly opportunitiesFetched: number;
  readonly contactsFetched: number;
  /** Contacts the run could not read: failed, missing (404) or rejected (shape). */
  readonly contactsUnread: number;
  /** GHL ids and codes only. */
  readonly errors: readonly SyncErrorEntry[];
}

/** What the scheduler hears back, and what `pg_net` keeps of it: ids and counts. */
export interface CrmScheduledReply {
  readonly action: 'scheduled-sync';
  readonly status: 'success' | 'partial';
  readonly runId: string;
  readonly durationMs: number;
  readonly opportunitiesFetched: number;
  readonly contactsFetched: number;
  readonly contactsUnread: number;
  /** Rows inserted, changed or marked removed. 0 = GoHighLevel had not moved. */
  readonly changed: number;
}

export interface CrmMoveReply {
  readonly action: 'move';
  readonly opportunityId: string;
  /** The stage GoHighLevel held before the move — the real one, not what the screen showed. */
  readonly fromStageId: string;
  readonly toStageId: string;
  /** False when the lead was already in the target stage: nothing was written. */
  readonly changed: boolean;
  /** Someone else had moved this lead since the screen loaded. */
  readonly movedByOther: boolean;
  readonly replay: boolean;
  readonly landedAfterTimeout: boolean;
  readonly mirrored: boolean;
  readonly writeId: string;
  readonly durationMs: number;
}

export interface CrmNoteReply {
  readonly action: 'note';
  readonly opportunityId: string;
  readonly noteId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly authorUserId: string;
  readonly mirrored: boolean;
  readonly writeId: string;
  readonly durationMs: number;
}

export interface CrmErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  /** Set when a run row exists for the failure, so the screen can show the same row. */
  readonly runId?: string;
  /** Set on 429: whole seconds until a refresh will be accepted. */
  readonly retryAfterSeconds?: number;
}

export type CrmErrorStatus = 400 | 401 | 403 | 409 | 410 | 422 | 429 | 500 | 502 | 503 | 504;

export type CrmPageResult =
  | {
      readonly status: 200;
      readonly body: CrmSyncReply | CrmScheduledReply | CrmMoveReply | CrmNoteReply;
    }
  | { readonly status: CrmErrorStatus; readonly body: CrmErrorBody };

export interface CrmPageDeps {
  readonly verify: VerifyDeps;
  /** `runGhlSync` over the real client and store, or a fake in tests. */
  readonly runSync: (options: RunOptions) => Promise<SyncReport>;
  /** The newest `ghl_sync_runs` row, any status, or null when no run has ever started. */
  readonly latestRun: () => Promise<Result<CooldownRun | null>>;
  /** Part 4: `moveLead` / `addNote` over the real write client and store, or fakes in tests. */
  readonly move: (actor: Actor, request: MoveRequest) => Promise<MoveOutcome>;
  readonly note: (actor: Actor, request: NoteRequest) => Promise<NoteOutcome>;
  readonly log: Logger;
  /**
   * The schedule's secret as this function holds it. Absent or null = not configured, and
   * then `scheduled-sync` is refused whatever is sent.
   */
  readonly scheduleSecret?: string | null;
  /** Defaults to SYNC_COOLDOWN_MS; a test shortens it. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

function failure(
  status: CrmErrorStatus,
  code: string,
  message: string,
  retryable = false,
  runId?: string,
): CrmPageResult {
  return runId === undefined
    ? { status, body: { error: { code, message, retryable } } }
    : { status, body: { error: { code, message, retryable }, runId } };
}

function cooldown(remainingMs: number, cooldownMs: number): CrmPageResult {
  const described = describeCooldown(remainingMs, cooldownMs);
  return {
    status: 429,
    body: {
      error: { code: 'SYNC_COOLDOWN', message: described.message, retryable: true },
      retryAfterSeconds: described.retryAfterSeconds,
    },
  };
}

/**
 * The sentence for a failed run. Written for the client, names the cause, never a value:
 * a rejected token is the case that matters most, because it is the one that looks like an
 * empty pipeline if nobody says otherwise.
 */
export function describeSyncFailure(code: string): { message: string; retryable: boolean } {
  switch (code) {
    case 'UNAUTHENTICATED':
      return {
        message:
          'GoHighLevel rejected our access key, so nothing was read. The numbers on screen are from the last successful refresh — the key needs replacing on the server.',
        retryable: false,
      };
    case 'FORBIDDEN':
      return {
        message:
          'GoHighLevel refused this read, so nothing was refreshed. The numbers on screen are from the last successful refresh.',
        retryable: false,
      };
    case 'CONFIG':
      return {
        message:
          'The pipeline is not configured correctly on the server, so nothing was refreshed.',
        retryable: false,
      };
    case 'TIMEOUT':
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
      return {
        message:
          "GoHighLevel didn't answer, so nothing was refreshed. The numbers on screen are from the last successful refresh — try again in a minute.",
        retryable: true,
      };
    default:
      return {
        message: `The refresh failed (${code}), so nothing was refreshed. The numbers on screen are from the last successful refresh.`,
        retryable: false,
      };
  }
}

export async function handleCrmRequest(
  deps: CrmPageDeps,
  input: CrmPageInput,
): Promise<CrmPageResult> {
  try {
    return await route(deps, input);
  } catch (caught: unknown) {
    // Nothing below is supposed to throw. If it does it is a 500 with the cause logged,
    // never an unhandled rejection in the runtime.
    deps.log.error('crm request threw', { error: caught });
    return failure(500, 'INTERNAL', 'Internal error.');
  }
}

/** The one line every scheduled request writes. Grep for it; `outcome` says how it ended. */
export const SCHEDULED_LOG_MESSAGE = 'crm: scheduled refresh';

/**
 * When it started, what it fetched, what it changed, how long it took, how it ended. A failed
 * run is an error, a partial or a skipped one a warning — the level is how loud it is.
 */
function logScheduled(deps: CrmPageDeps, report: SyncReport, startedAtMs: number): void {
  const fields = {
    trigger: 'schedule',
    outcome: report.status === 'refused' ? 'skipped' : report.status,
    runId: report.runId,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: report.durationMs,
    staleMarked: report.staleMarked,
    fetched: report.fetch,
    changed: report.apply === null ? null : changesOf(report.apply),
    errorCode: report.error?.code ?? null,
    errorCount: report.errors.length,
  };
  if (report.status === 'failed') deps.log.error(SCHEDULED_LOG_MESSAGE, fields);
  else if (report.status === 'success') deps.log.info(SCHEDULED_LOG_MESSAGE, fields);
  else deps.log.warn(SCHEDULED_LOG_MESSAGE, fields);
}

async function routeScheduled(deps: CrmPageDeps, input: CrmPageInput): Promise<CrmPageResult> {
  const now = deps.now ?? Date.now;
  const check = await checkScheduleToken(input.scheduleToken, deps.scheduleSecret, now());
  if (!check.ok) {
    // One answer for every cause; which cause it was is here and nowhere else.
    deps.log.error('crm: scheduled refresh refused', {
      reason: check.reason,
      alert: 'ghl_schedule_refused',
    });
    return failure(401, 'UNAUTHENTICATED', 'Not authorised.');
  }

  const startedAtMs = now();
  const report = await deps.runSync({ trigger: 'schedule', triggeredBy: null });
  logScheduled(deps, report, startedAtMs);

  if (report.status === 'refused') {
    return failure(409, 'SYNC_RUNNING', 'A refresh is already running.', true);
  }
  if (report.status === 'failed') {
    const code = report.error?.code ?? 'UNKNOWN';
    const described = describeSyncFailure(code);
    return failure(502, code, described.message, described.retryable, report.runId ?? undefined);
  }
  if (report.runId === null) {
    return failure(500, 'INTERNAL', 'The refresh finished without a run record.');
  }
  return {
    status: 200,
    body: {
      action: 'scheduled-sync',
      status: report.status,
      runId: report.runId,
      durationMs: report.durationMs,
      opportunitiesFetched: report.fetch.opportunities_fetched,
      contactsFetched: report.fetch.contacts_fetched,
      contactsUnread:
        report.fetch.contacts_failed +
        report.fetch.contacts_missing +
        report.fetch.contacts_rejected,
      changed: report.apply === null ? 0 : changesOf(report.apply).total,
    },
  };
}

async function route(deps: CrmPageDeps, input: CrmPageInput): Promise<CrmPageResult> {
  const action = input.body.action;
  // Before the staff check, because the scheduler is not staff and has no session.
  if (action === SCHEDULED_SYNC_ACTION) return routeScheduled(deps, input);
  if (action !== 'sync' && action !== 'move' && action !== 'note') {
    return failure(400, 'BAD_REQUEST', 'action must be sync, move or note.');
  }

  const access = await verifyStaffAccess(deps.verify, input.token);
  if (!access.ok) {
    deps.log.error('crm: caller could not be verified', { error: access.error });
    return failure(503, 'AUTH_UNAVAILABLE', "Couldn't verify who is asking. Try again.", true);
  }
  if (access.value.kind === 'unauthenticated') {
    return failure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  if (access.value.kind === 'forbidden') {
    return failure(403, 'FORBIDDEN', 'This account does not have access.');
  }
  const actor: Actor = { userId: access.value.user.userId, email: access.value.user.email };

  if (action === 'move') return routeMove(deps, actor, input.body);
  if (action === 'note') return routeNote(deps, actor, input.body);

  // Fail closed: a rate limit that cannot be checked is not a rate limit that is waived.
  const latest = await deps.latestRun();
  if (!latest.ok) {
    deps.log.error('crm: could not read the last run before refreshing', { error: latest.error });
    return failure(503, 'COOLDOWN_UNKNOWN', "Couldn't check the last refresh. Try again.", true);
  }
  const cooldownMs = deps.cooldownMs ?? SYNC_COOLDOWN_MS;
  const remaining = cooldownRemainingMs(latest.value, (deps.now ?? Date.now)(), cooldownMs);
  if (remaining > 0) {
    deps.log.info('crm: refresh refused, inside the cooldown', {
      remainingMs: remaining,
      cooldownMs,
      requestedBy: access.value.user.userId,
    });
    return cooldown(remaining, cooldownMs);
  }

  const report = await deps.runSync({ trigger: 'api', triggeredBy: access.value.user.userId });
  deps.log.info('crm: sync requested from the app', {
    runId: report.runId,
    status: report.status,
    durationMs: report.durationMs,
    fetch: report.fetch,
    errorCode: report.error?.code ?? null,
  });

  if (report.status === 'refused') {
    return failure(409, 'SYNC_RUNNING', 'A refresh is already running.', true);
  }
  if (report.status === 'failed') {
    const described = describeSyncFailure(report.error?.code ?? 'UNKNOWN');
    return failure(
      502,
      report.error?.code ?? 'UNKNOWN',
      described.message,
      described.retryable,
      report.runId ?? undefined,
    );
  }
  if (report.runId === null) {
    return failure(500, 'INTERNAL', 'The refresh finished without a run record.');
  }
  return {
    status: 200,
    body: {
      action: 'sync',
      status: report.status,
      runId: report.runId,
      durationMs: report.durationMs,
      opportunitiesFetched: report.fetch.opportunities_fetched,
      contactsFetched: report.fetch.contacts_fetched,
      contactsUnread:
        report.fetch.contacts_failed +
        report.fetch.contacts_missing +
        report.fetch.contacts_rejected,
      errors: report.errors,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Part 4: moving a lead and adding a note
// ---------------------------------------------------------------------------------------

/** What a GoHighLevel id looks like, generously; a uuid for the request id. */
const GHL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ghlId(value: unknown): string | null {
  return typeof value === 'string' && GHL_ID.test(value) ? value : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The sentence for a refused write. Every one says nothing was changed, because the
 * dangerous misreading is "the move went through and the screen is wrong".
 */
export function describeRefusal(reason: RefusalReason): {
  status: CrmErrorStatus;
  message: string;
} {
  switch (reason) {
    case 'IN_FLIGHT':
      return { status: 409, message: 'That change is still being saved. Wait a moment.' };
    case 'REQUEST_REUSED':
      return {
        status: 409,
        message: 'That attempt already finished. Refresh, then try the change again.',
      };
    case 'OPPORTUNITY_GONE':
      return {
        status: 410,
        message:
          'This lead was deleted in GoHighLevel since your screen loaded. Nothing was changed — refresh to update the board.',
      };
    case 'OUTSIDE_PIPELINE':
      return {
        status: 403,
        message:
          'This lead is not in the Finance Pipeline in GoHighLevel, so the app will not change it. Nothing was changed.',
      };
    case 'NOT_OPEN':
      return {
        status: 409,
        message:
          'This lead was closed in GoHighLevel (won or lost) since your screen loaded. Nothing was changed — refresh to update the board.',
      };
    case 'STAGE_UNKNOWN':
      return {
        status: 409,
        message:
          'That stage is no longer in the pipeline. Nothing was changed — refresh to see the current stages.',
      };
    case 'NO_CONTACT':
      return {
        status: 409,
        message:
          'This lead has no contact in GoHighLevel, so there is nowhere to attach a note. Nothing was saved.',
      };
    case 'NOTE_REJECTED':
      return { status: 422, message: 'GoHighLevel refused the note. Nothing was saved.' };
  }
}

/** The sentence for a failed write. Names the cause; says where the lead is. */
export function describeWriteFailure(
  code: FailureCode,
  kind: 'move' | 'note',
): { status: CrmErrorStatus; message: string; retryable: boolean } {
  const thing = kind === 'move' ? 'the lead was not moved' : 'the note was not saved';
  switch (code) {
    case 'UNAUTHENTICATED':
      return {
        status: 502,
        message: `GoHighLevel rejected our access key, so ${thing}. The connection needs reauthorising — a new key on the server. Nothing on this screen has changed in GoHighLevel.`,
        retryable: false,
      };
    case 'FORBIDDEN':
      return {
        status: 502,
        message: `GoHighLevel refused this change, so ${thing}. Nothing was changed.`,
        retryable: false,
      };
    case 'RATE_LIMITED':
      return {
        status: 503,
        message: `GoHighLevel is rate-limiting us right now, so ${thing}. Wait a moment, then try again.`,
        retryable: true,
      };
    case 'TIMEOUT':
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
    case 'GHL_ERROR':
    case 'RESPONSE_SHAPE':
      return {
        status: 502,
        message:
          kind === 'move'
            ? "GoHighLevel didn't complete the move. The lead is still in its previous stage. Try again in a moment."
            : "GoHighLevel didn't save the note. Your text is still here — try again in a moment.",
        retryable: true,
      };
    case 'UNKNOWN':
      return {
        status: 504,
        message:
          kind === 'move'
            ? "GoHighLevel didn't confirm the move, and we couldn't check. The board shows the last known stage — refresh in a minute to see where the lead is before moving it again."
            : "GoHighLevel didn't confirm the note. Check the contact in GoHighLevel before adding it again — your text is still here.",
        retryable: false,
      };
    case 'STORE':
      return {
        status: 503,
        message: `The Command Centre could not record the change, so ${thing}. Try again.`,
        retryable: true,
      };
  }
}

function outcomeDetail(outcome: MoveOutcome | NoteOutcome): string | null {
  if (outcome.kind === 'refused') return outcome.reason;
  if (outcome.kind === 'failed') return outcome.code;
  return null;
}

async function routeMove(
  deps: CrmPageDeps,
  actor: Actor,
  body: CrmRequestBody,
): Promise<CrmPageResult> {
  const requestId = uuid(body.requestId);
  const opportunityId = ghlId(body.opportunityId);
  const toStageId = ghlId(body.toStageId);
  const fromGiven = body.fromStageId !== undefined && body.fromStageId !== null;
  const fromStageId = fromGiven ? ghlId(body.fromStageId) : null;
  if (requestId === null || opportunityId === null || toStageId === null) {
    return failure(
      400,
      'BAD_REQUEST',
      'move needs requestId (uuid), opportunityId and toStageId (GoHighLevel ids).',
    );
  }
  if (fromGiven && fromStageId === null) {
    return failure(400, 'BAD_REQUEST', 'fromStageId must be a GoHighLevel id when given.');
  }

  const outcome = await deps.move(actor, {
    requestId,
    opportunityId,
    toStageId,
    screenStageId: fromStageId,
  });
  deps.log.info('crm: move requested from the app', {
    requestedBy: actor.userId,
    opportunityId,
    toStageId,
    fromStageId,
    outcome: outcome.kind,
    detail: outcomeDetail(outcome),
    writeId: outcome.writeId,
  });

  switch (outcome.kind) {
    case 'moved':
    case 'unchanged':
      return {
        status: 200,
        body: {
          action: 'move',
          opportunityId: outcome.opportunityId,
          fromStageId: outcome.fromStageId,
          toStageId: outcome.toStageId,
          changed: outcome.kind === 'moved',
          movedByOther: outcome.movedByOther,
          replay: outcome.replay,
          landedAfterTimeout: outcome.landedAfterTimeout,
          mirrored: outcome.mirrored,
          writeId: outcome.writeId,
          durationMs: outcome.durationMs,
        },
      };
    case 'refused': {
      const described = describeRefusal(outcome.reason);
      return failure(
        described.status,
        outcome.reason,
        described.message,
        false,
        outcome.writeId ?? undefined,
      );
    }
    case 'failed': {
      const described = describeWriteFailure(outcome.code, 'move');
      return failure(
        described.status,
        outcome.code,
        described.message,
        described.retryable,
        outcome.writeId ?? undefined,
      );
    }
  }
}

async function routeNote(
  deps: CrmPageDeps,
  actor: Actor,
  body: CrmRequestBody,
): Promise<CrmPageResult> {
  const requestId = uuid(body.requestId);
  const opportunityId = ghlId(body.opportunityId);
  if (requestId === null || opportunityId === null) {
    return failure(400, 'BAD_REQUEST', 'note needs requestId (uuid) and opportunityId.');
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (text === '') {
    return failure(400, 'EMPTY_NOTE', 'Write something before saving the note.');
  }
  if (text.length > NOTE_MAX_LENGTH) {
    return failure(
      400,
      'NOTE_TOO_LONG',
      `A note can be at most ${String(NOTE_MAX_LENGTH)} characters; this one is ${String(text.length)}.`,
    );
  }

  const outcome = await deps.note(actor, { requestId, opportunityId, body: text });
  deps.log.info('crm: note requested from the app', {
    requestedBy: actor.userId,
    opportunityId,
    bodyLength: text.length,
    outcome: outcome.kind,
    detail: outcomeDetail(outcome),
    writeId: outcome.writeId,
  });

  switch (outcome.kind) {
    case 'noted':
      return {
        status: 200,
        body: {
          action: 'note',
          opportunityId: outcome.opportunityId,
          noteId: outcome.noteId,
          body: outcome.body,
          createdAt: outcome.createdAt,
          authorUserId: actor.userId,
          mirrored: outcome.mirrored,
          writeId: outcome.writeId,
          durationMs: outcome.durationMs,
        },
      };
    case 'refused': {
      const described = describeRefusal(outcome.reason);
      return failure(
        described.status,
        outcome.reason,
        described.message,
        false,
        outcome.writeId ?? undefined,
      );
    }
    case 'failed': {
      const described = describeWriteFailure(outcome.code, 'note');
      return failure(
        described.status,
        outcome.code,
        described.message,
        described.retryable,
        outcome.writeId ?? undefined,
      );
    }
  }
}
