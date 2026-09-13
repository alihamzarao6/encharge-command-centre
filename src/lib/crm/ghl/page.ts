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
 */
import { verifyStaffAccess, type VerifyDeps } from '../../auth/verify.js';
import type { Logger } from '../../logger.js';
import type { RunOptions, SyncErrorEntry, SyncReport } from './sync.js';

export interface CrmRequestBody {
  readonly action?: unknown;
}

export interface CrmPageInput {
  readonly token: string | null | undefined;
  readonly body: CrmRequestBody;
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

export interface CrmErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  /** Set when a run row exists for the failure, so the screen can show the same row. */
  readonly runId?: string;
}

export type CrmErrorStatus = 400 | 401 | 403 | 409 | 500 | 502 | 503;

export type CrmPageResult =
  | { readonly status: 200; readonly body: CrmSyncReply }
  | { readonly status: CrmErrorStatus; readonly body: CrmErrorBody };

export interface CrmPageDeps {
  readonly verify: VerifyDeps;
  /** `runGhlSync` over the real client and store, or a fake in tests. */
  readonly runSync: (options: RunOptions) => Promise<SyncReport>;
  readonly log: Logger;
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

async function route(deps: CrmPageDeps, input: CrmPageInput): Promise<CrmPageResult> {
  if (input.body.action !== 'sync') {
    return failure(400, 'BAD_REQUEST', 'action must be sync.');
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
