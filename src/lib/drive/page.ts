/**
 * The `drive` endpoint (Milestone 5 part 3a): connecting a person's Google Drive, saying how
 * that connection stands, disconnecting it, and reading one file he picked. Runtime-agnostic
 * and never throws — the Edge Function maps the returned status and body onto its response,
 * exactly as the files endpoint does.
 *
 *   status          how his connection stands — checked LIVE with Google whenever it claims to
 *                   be working, so the page never shows a stale "connected" (D122).
 *   connect_start   a single-use attempt (ten minutes) and Google's consent address for it.
 *   (callback)      Google comes back here, not to the app: its code is SEALED and held
 *                   against the attempt, and he is sent on to the app. Nothing is exchanged.
 *   connect_finish  the app, signed in, finishes the attempt. Only the person who started it
 *                   can (D123): the code becomes tokens, the scope is checked to be drive.file
 *                   and nothing wider, the account is named, the refresh token is sealed and
 *                   stored (D124), and a DIFFERENT previous account is revoked at Google
 *                   first — never the same account, whose grant the new token shares (D125).
 *   disconnect      revoke at Google, and only then delete the row (the brief's boundary).
 *   read_file       fetch or export one Drive file (formats.ts, D120) with HIS token and hand
 *                   the bytes to the browser, which reads them with part 1's readers. The
 *                   server records what it handed over (`drive_reads`) and `begin` attaches
 *                   those bytes and no others, naming them as Drive did.
 *   picked          the browser says how many files were picked; logged, nothing more.
 *
 * Order in every action: who is asking (401/403 before any work), then the input, then the
 * connection. No token, code, verifier, state or client secret is ever in a reply, a log line
 * or an error: what is logged is ids, a type group, sizes, durations and outcomes (rule 20),
 * and never a file's name or a word of its content.
 */
import { z } from 'zod';

import { verifyStaffAccess, type StaffIdentity, type VerifyDeps } from '../auth/verify.js';
import { refusal } from '../files/limits.js';
import type { Logger } from '../logger.js';
import type { DriveConfig } from './config.js';
import { SEALED_FOR, open, pkceChallenge, randomToken, seal, sha256Hex } from './crypto.js';
import {
  displayName,
  planFor,
  readerFileName,
  typeGroup,
  type DriveFileMeta,
  type ReadPlan,
} from './formats.js';
import {
  DISCONNECT_MESSAGES,
  DRIVE_CONNECTION_MESSAGES,
  DRIVE_LIMITS,
  DRIVE_RETRY_MESSAGES,
  SWITCH_LEFTOVER_NOTE,
  brokenReasonText,
  connectOutcomeMessage,
  driveRefusalMessage,
  googleTypeLabel,
  isDriveFileId,
  type BrokenReason,
  type ConnectOutcome,
  type DriveConnectionCode,
  type DriveRefusalCode,
  type DriveRetryCode,
} from './limits.js';
import { checkGrantedScope, type GoogleClient, type GoogleFailure } from './google.js';
import { driveStoreReason, type DriveConnectionRecord, type DriveStore } from './store.js';

export interface DrivePageDeps {
  readonly verify: VerifyDeps;
  /** Null when Drive is not set up on this Command Centre (config.ts). */
  readonly drive: {
    readonly config: DriveConfig;
    readonly google: GoogleClient;
    readonly store: DriveStore;
  } | null;
  readonly log: Logger;
  readonly now?: () => Date;
  /** A new token id (D124). Injected for tests. */
  readonly newId?: () => string;
}

export interface DrivePageInput {
  readonly token: string | null | undefined;
  readonly body: unknown;
}

export type DriveStatus =
  | { readonly state: 'unavailable' }
  | { readonly state: 'not_connected' }
  | {
      readonly state: 'connected';
      readonly email: string;
      readonly connectedAt: string;
      readonly lastUsedAt: string | null;
      /** False when Google could not be reached to confirm it just now. */
      readonly checked: boolean;
    }
  | {
      readonly state: 'broken';
      readonly email: string;
      readonly brokenAt: string;
      readonly reason: string;
      readonly message: string;
    };

export type DriveReply =
  | ({ readonly action: 'status' } & DriveStatus)
  | { readonly action: 'connect_start'; readonly authorizeUrl: string }
  | {
      readonly action: 'connect_finish';
      readonly outcome: ConnectOutcome;
      readonly message: string;
      readonly note: string | null;
    }
  | { readonly action: 'disconnect'; readonly disconnected: boolean; readonly message: string }
  | { readonly action: 'picked'; readonly logged: true };

/** What comes back WITH the bytes of a file read from Drive. Nothing here is its content. */
export interface DriveReadReply {
  readonly action: 'read_file';
  /** The server's record of this read; `begin` must quote it. */
  readonly readId: string;
  /** The name to show: Drive's, cleaned. */
  readonly name: string;
  /** The name to hand the reader: with the export's extension (formats.ts). */
  readonly fileName: string;
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly contentHash: string;
  /** What Google called it ("Google Doc"), or null for an ordinary file. */
  readonly googleType: string | null;
  /** The Drive file actually read (a shortcut's target when he picked a shortcut). */
  readonly fileId: string;
}

export interface DriveErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly refusal?: string;
  };
}

export type DriveErrorStatus = 400 | 401 | 403 | 409 | 422 | 429 | 500 | 502 | 503 | 504;

export type DrivePageResult =
  | { readonly status: 200; readonly body: DriveReply }
  | { readonly status: 200; readonly body: DriveReadReply; readonly bytes: Uint8Array }
  | { readonly status: DriveErrorStatus; readonly body: DriveErrorBody };

export const DRIVE_PAGE_MESSAGES = {
  storeDown:
    'The Command Centre could not reach its database just now. Nothing was changed. Try again.',
  misconfigured: 'Google Drive is set up wrongly on this Command Centre. Nothing was read.',
  tooManyAttempts:
    'Several connection attempts are already open. Finish the one at Google, or wait ten minutes and try again.',
  readAgain: 'That read was already used. Try again.',
} as const;

function failure(
  status: DriveErrorStatus,
  code: string,
  message: string,
  retryable = false,
  refused?: string,
): DrivePageResult {
  return {
    status,
    body: {
      error: { code, message, retryable, ...(refused === undefined ? {} : { refusal: refused }) },
    },
  };
}

function connection(code: DriveConnectionCode): DrivePageResult {
  const status = code === 'not_configured' ? 503 : 409;
  return failure(status, code.toUpperCase(), DRIVE_CONNECTION_MESSAGES[code]);
}

const RETRY_STATUS: Readonly<Record<DriveRetryCode, DriveErrorStatus>> = {
  drive_busy: 429,
  drive_unreachable: 502,
  drive_timeout: 504,
  drive_too_many_reads: 429,
};

function retryLater(code: DriveRetryCode): DrivePageResult {
  return failure(RETRY_STATUS[code], 'DRIVE_NOT_READ', DRIVE_RETRY_MESSAGES[code], true);
}

function refuseFile(code: DriveRefusalCode, label = ''): DrivePageResult {
  return failure(422, 'DRIVE_REFUSED', driveRefusalMessage(code, label), false, code);
}

const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

const REQUEST = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('connect_start') }),
  z.object({ action: z.literal('connect_finish'), attempt: UUID }),
  z.object({ action: z.literal('disconnect') }),
  z.object({
    action: z.literal('read_file'),
    requestId: UUID,
    // The shape is checked in the handler, so a wrong one is a sentence, not a schema error.
    fileId: z.string().max(256),
  }),
  z.object({ action: z.literal('picked'), count: z.number().int().min(1).max(50) }),
]);

type DriveRequest = z.infer<typeof REQUEST>;
type ActionRequest<A extends DriveRequest['action']> = Extract<DriveRequest, { action: A }>;

interface Ctx {
  readonly deps: DrivePageDeps;
  readonly drive: NonNullable<DrivePageDeps['drive']>;
  readonly user: StaffIdentity;
  readonly log: Logger;
  readonly now: () => Date;
}

function brokenStatus(row: DriveConnectionRecord, reason: string, at: string): DriveStatus {
  return {
    state: 'broken',
    email: row.googleEmail,
    brokenAt: at,
    reason,
    message: brokenReasonText(reason),
  };
}

/**
 * Google stopped honouring this token. Recorded — only if the row still holds it — and said.
 * A failure to record is logged and does not change what the person is told: the token is
 * dead either way.
 */
async function markBroken(
  ctx: Ctx,
  row: DriveConnectionRecord,
  reason: BrokenReason,
): Promise<void> {
  const marked = await ctx.drive.store.markBroken(row.userId, row.tokenId, reason);
  if (!marked.ok) {
    ctx.log.error('drive connection could not be marked broken', {
      userId: row.userId,
      reason,
      error: marked.error,
    });
  } else {
    ctx.log.warn('drive connection broken', { userId: row.userId, reason, recorded: marked.value });
  }
}

/** The refresh token from a row, or null when it does not open (the key changed, or tampering). */
async function refreshTokenOf(ctx: Ctx, row: DriveConnectionRecord): Promise<string | null> {
  const opened = await open(
    ctx.drive.config.sealKey,
    row.refreshTokenSealed,
    SEALED_FOR.refreshToken(row.userId, row.tokenId),
  );
  return opened.ok ? opened.value : null;
}

// ---------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------

async function status(ctx: Ctx): Promise<DrivePageResult> {
  const found = await ctx.drive.store.getConnection(ctx.user.userId);
  if (!found.ok) {
    ctx.log.error('drive connection unavailable for status', { error: found.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  const row = found.value;
  if (row === null) return { status: 200, body: { action: 'status', state: 'not_connected' } };
  if (row.status === 'broken') {
    return {
      status: 200,
      body: {
        action: 'status',
        ...brokenStatus(row, row.brokenReason ?? 'grant_revoked', row.brokenAt ?? row.connectedAt),
      },
    };
  }

  // It says it works. Ask Google — one token refresh, free — so "connected" is current.
  const connected = (checked: boolean): DrivePageResult => ({
    status: 200,
    body: {
      action: 'status',
      state: 'connected',
      email: row.googleEmail,
      connectedAt: row.connectedAt,
      lastUsedAt: row.lastUsedAt,
      checked,
    },
  });
  const refreshToken = await refreshTokenOf(ctx, row);
  if (refreshToken === null) {
    await markBroken(ctx, row, 'unreadable');
    return {
      status: 200,
      body: { action: 'status', ...brokenStatus(row, 'unreadable', ctx.now().toISOString()) },
    };
  }
  const refreshed = await ctx.drive.google.refresh(refreshToken);
  if (refreshed.ok) return connected(true);
  if (refreshed.error.kind === 'grant_invalid') {
    await markBroken(ctx, row, 'grant_revoked');
    return {
      status: 200,
      body: { action: 'status', ...brokenStatus(row, 'grant_revoked', ctx.now().toISOString()) },
    };
  }
  if (refreshed.error.kind === 'client_config') {
    ctx.log.error('google refused the oauth client configuration', { at: 'status' });
  }
  return connected(false);
}

// ---------------------------------------------------------------------------------------
// connect_start, the callback, connect_finish
// ---------------------------------------------------------------------------------------

async function connectStart(ctx: Ctx): Promise<DrivePageResult> {
  const state = randomToken(32);
  // 48 bytes → 64 characters: inside RFC 7636's 43–128.
  const verifier = randomToken(48);
  const stateHash = await sha256Hex(state);
  const verifierSealed = await seal(
    ctx.drive.config.sealKey,
    verifier,
    SEALED_FOR.verifier(stateHash),
  );
  const created = await ctx.drive.store.createAttempt({
    userId: ctx.user.userId,
    stateHash,
    verifierSealed,
    ttlSeconds: DRIVE_LIMITS.connectAttemptSeconds,
    maxOpen: DRIVE_LIMITS.maxOpenAttempts,
  });
  if (!created.ok) {
    if (driveStoreReason(created.error) === 'too_many_attempts') {
      return failure(429, 'TOO_MANY_ATTEMPTS', DRIVE_PAGE_MESSAGES.tooManyAttempts, true);
    }
    ctx.log.error('drive connect attempt not recorded', { error: created.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  ctx.log.info('drive connect started', { userId: ctx.user.userId, attempt: created.value });
  return {
    status: 200,
    body: {
      action: 'connect_start',
      authorizeUrl: ctx.drive.google.authorizeUrl({
        state,
        codeChallenge: await pkceChallenge(verifier),
      }),
    },
  };
}

export type DriveCallbackResult =
  { readonly status: 303; readonly location: string } | { readonly status: 404 };

/** Google's error, as a code we may store and show: lower case, letters and underscores. */
export function cleanGoogleError(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const code = raw
    .toLowerCase()
    .replace(/[^a-z_]/g, '')
    .slice(0, 48);
  return code === '' ? 'unknown_error' : code;
}

/**
 * Google comes back here — a top-level navigation with no session — with `state` and either a
 * `code` or an `error`. The code is sealed and held against the attempt, once; it is never
 * exchanged here, because nothing here can prove who is in the browser (D123). Anything that
 * does not match a fresh, unreturned attempt — replayed, doubled, invented, expired — changes
 * nothing and lands on the page as "stale".
 */
export async function handleDriveCallback(
  deps: DrivePageDeps,
  params: Readonly<Record<string, string | undefined>>,
): Promise<DriveCallbackResult> {
  const drive = deps.drive;
  if (drive === null) return { status: 404 };
  const log = deps.log.child({ component: 'drive' });
  const back = (query: string): DriveCallbackResult => ({
    status: 303,
    location: `${drive.config.appOrigin}/settings?${query}`,
  });
  try {
    const state = params['state'];
    if (state === undefined || !/^[A-Za-z0-9_-]{20,200}$/.test(state)) {
      log.info('drive connect returned', { outcome: 'no_state' });
      return back('drive=stale');
    }
    const stateHash = await sha256Hex(state);
    const code = params['code'];
    const usableCode = code !== undefined && code !== '' && code.length <= 4_000 ? code : null;
    const codeSealed =
      usableCode === null
        ? null
        : await seal(drive.config.sealKey, usableCode, SEALED_FOR.code(stateHash));
    const error = usableCode === null ? (cleanGoogleError(params['error']) ?? 'no_code') : null;
    const returned = await drive.store.returnAttempt({ stateHash, codeSealed, error });
    if (!returned.ok) {
      log.error('drive connect return not recorded', { error: returned.error });
      return back('drive=stale');
    }
    if (returned.value === null) {
      log.info('drive connect returned', { outcome: 'stale' });
      return back('drive=stale');
    }
    log.info('drive connect returned', {
      userId: returned.value.userId,
      attempt: returned.value.id,
      outcome: error ?? 'code',
    });
    return back(`drive=returned&attempt=${encodeURIComponent(returned.value.id)}`);
  } catch (caught: unknown) {
    log.error('drive callback threw', {
      errorName: caught instanceof Error ? caught.name : typeof caught,
    });
    return back('drive=stale');
  }
}

function finished(
  outcome: ConnectOutcome,
  detail = '',
  note: string | null = null,
): DrivePageResult {
  return {
    status: 200,
    body: {
      action: 'connect_finish',
      outcome,
      message: connectOutcomeMessage(outcome, detail),
      note,
    },
  };
}

async function connectFinish(
  ctx: Ctx,
  request: ActionRequest<'connect_finish'>,
): Promise<DrivePageResult> {
  const { drive, user, log } = ctx;
  const taken = await drive.store.takeAttempt(request.attempt, user.userId);
  if (!taken.ok) {
    log.error('drive connect attempt could not be taken', { error: taken.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  const attempt = taken.value;
  const outcome = (name: string): void => {
    log.info('drive connect finished', { userId: user.userId, outcome: name });
  };
  switch (attempt.outcome) {
    case 'wrong_user':
      log.warn('drive connect finished by a different user', {
        userId: user.userId,
        attempt: request.attempt,
      });
      return finished('wrong_user');
    case 'missing':
    case 'expired':
    case 'not_returned':
      outcome(attempt.outcome);
      return finished('stale');
    case 'declined':
      outcome(attempt.error);
      return attempt.error === 'access_denied'
        ? finished('cancelled')
        : finished('google_refused', attempt.error);
    case 'ok':
      break;
  }

  const verifier = await open(
    drive.config.sealKey,
    attempt.verifierSealed,
    SEALED_FOR.verifier(attempt.stateHash),
  );
  const code = await open(
    drive.config.sealKey,
    attempt.codeSealed,
    SEALED_FOR.code(attempt.stateHash),
  );
  if (!verifier.ok || !code.ok) {
    log.error('drive connect attempt did not open', { userId: user.userId });
    return finished('stale');
  }

  const grant = await drive.google.exchangeCode(code.value, verifier.value);
  if (!grant.ok) {
    if (grant.error.kind === 'client_config') {
      log.error('google refused the oauth client configuration', { at: 'exchange' });
      return failure(500, 'CONFIG', DRIVE_PAGE_MESSAGES.misconfigured);
    }
    outcome(grant.error.kind === 'grant_invalid' ? 'code_rejected' : grant.error.kind);
    return finished(grant.error.kind === 'grant_invalid' ? 'stale' : 'google_unreachable');
  }

  const existingRead = await drive.store.getConnection(user.userId);
  if (!existingRead.ok) {
    log.error('drive connection unavailable for finish', { error: existingRead.error });
    // Nothing stored and nothing to compare with: let the new token go rather than hold a
    // grant with no row. If it was the same account, the next status check says so.
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  const existing = existingRead.value;

  /**
   * Let a token we will not keep go at Google. Only when no connection exists: a new token
   * for an account already connected shares that connection's grant, and revoking it would
   * revoke the connection too (D125).
   */
  const discard = async (token: string): Promise<void> => {
    if (existing !== null) return;
    const revoked = await drive.google.revoke(token);
    if (!revoked.ok) log.warn('unkept drive token not revoked', { kind: revoked.error.kind });
  };

  const scope = checkGrantedScope(grant.value.scope);
  if (scope === 'wider') {
    // Never held, whatever it costs: revoke even if that ends an existing connection.
    const revoked = await drive.google.revoke(grant.value.accessToken);
    log.error('google granted a wider scope than drive.file', {
      userId: user.userId,
      revoked: revoked.ok,
    });
    return finished('scope_wider');
  }
  if (scope === 'missing') {
    await discard(grant.value.accessToken);
    outcome('scope_missing');
    return finished('scope_missing');
  }
  const refreshToken = grant.value.refreshToken;
  if (refreshToken === null) {
    await discard(grant.value.accessToken);
    outcome('no_lasting_access');
    return finished('no_lasting_access');
  }

  const account = await drive.google.about(grant.value.accessToken);
  if (!account.ok) {
    await discard(refreshToken);
    outcome(`about_${account.error.kind}`);
    return finished('google_unreachable');
  }

  let note: string | null = null;
  if (existing !== null && existing.googleAccountId !== account.value.permissionId) {
    // A DIFFERENT account replaces this one: its grant goes at Google first, so no grant is
    // ever left behind without a row. The new account's token is ours to revoke if that fails.
    const oldToken = await refreshTokenOf(ctx, existing);
    if (oldToken === null) {
      note = SWITCH_LEFTOVER_NOTE;
      log.error('previous drive token did not open; not revoked', { userId: user.userId });
    } else {
      const revoked = await drive.google.revoke(oldToken);
      if (!revoked.ok) {
        const undone = await drive.google.revoke(refreshToken);
        log.warn('drive account switch stopped: previous token not revoked', {
          userId: user.userId,
          kind: revoked.error.kind,
          newRevoked: undone.ok,
        });
        return finished('switch_failed');
      }
    }
  }

  const tokenId = (ctx.deps.newId ?? ((): string => crypto.randomUUID()))();
  const sealed = await seal(
    drive.config.sealKey,
    refreshToken,
    SEALED_FOR.refreshToken(user.userId, tokenId),
  );
  const saved = await drive.store.saveConnection({
    userId: user.userId,
    expectedTokenId: existing?.tokenId ?? null,
    tokenId,
    googleAccountId: account.value.permissionId,
    googleEmail: account.value.email,
    refreshTokenSealed: sealed,
    grantedScope: grant.value.scope,
  });
  if (!saved.ok) {
    if (driveStoreReason(saved.error) === 'changed') {
      // Another Connect finished in between. Keep this token only if it is the same account as
      // what is there now (one grant); otherwise let it go, so no grant is left without a row.
      const now = await drive.store.getConnection(user.userId);
      const sameAsNow = now.ok && now.value?.googleAccountId === account.value.permissionId;
      if (!sameAsNow) {
        const revoked = await drive.google.revoke(refreshToken);
        if (!revoked.ok) log.warn('unkept drive token not revoked', { kind: revoked.error.kind });
      }
      outcome('changed');
      return finished('changed');
    }
    log.error('drive connection not saved', { userId: user.userId, error: saved.error });
    const switched = existing !== null && existing.googleAccountId !== account.value.permissionId;
    if (existing === null || switched) {
      const revoked = await drive.google.revoke(refreshToken);
      if (!revoked.ok) log.warn('unsaved drive token not revoked', { kind: revoked.error.kind });
    }
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  log.info('drive connected', {
    userId: user.userId,
    replaced: saved.value.replaced,
    sameAccount: saved.value.sameAccount,
  });
  return finished('connected', account.value.email, note);
}

// ---------------------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------------------

async function disconnect(ctx: Ctx): Promise<DrivePageResult> {
  const { drive, user, log } = ctx;
  const found = await drive.store.getConnection(user.userId);
  if (!found.ok) {
    log.error('drive connection unavailable for disconnect', { error: found.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  const row = found.value;
  if (row === null) {
    return {
      status: 200,
      body: {
        action: 'disconnect',
        disconnected: false,
        message: DISCONNECT_MESSAGES.notConnected,
      },
    };
  }
  const refreshToken = await refreshTokenOf(ctx, row);
  let message: string = DISCONNECT_MESSAGES.done;
  if (refreshToken === null) {
    // Google cannot be told without the token. Said in full, with the place to do it by hand.
    message = DISCONNECT_MESSAGES.unreadable;
    log.error('drive token did not open; removed without revoking', { userId: user.userId });
  } else {
    const revoked = await drive.google.revoke(refreshToken);
    if (!revoked.ok) {
      log.warn('drive disconnect stopped: google did not confirm', {
        userId: user.userId,
        kind: revoked.error.kind,
      });
      return failure(503, 'GOOGLE_UNREACHABLE', DISCONNECT_MESSAGES.googleUnreachable, true);
    }
  }
  const deleted = await drive.store.deleteConnection(user.userId, row.tokenId);
  if (!deleted.ok) {
    // Google has let go; the row is now a dead token, and the next status check marks it.
    log.error('drive connection revoked but not deleted', {
      userId: user.userId,
      error: deleted.error,
    });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  log.info('drive disconnected', {
    userId: user.userId,
    revokedAtGoogle: refreshToken !== null,
    deleted: deleted.value,
  });
  return { status: 200, body: { action: 'disconnect', disconnected: true, message } };
}

// ---------------------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------------------

async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface ReadFailure {
  readonly result: DrivePageResult;
  /** How the record of the read ends. */
  readonly status: 'refused' | 'failed';
  /** A reason code. */
  readonly outcome: string;
}

/** A Google failure while reading a file → what he is told, and how the record ends. */
async function fileFailure(
  ctx: Ctx,
  row: DriveConnectionRecord,
  error: GoogleFailure,
  context: 'file' | 'shortcut',
): Promise<ReadFailure> {
  switch (error.kind) {
    case 'unauthorized':
    case 'grant_invalid':
      await markBroken(ctx, row, 'access_lost');
      return {
        result: connection('connection_broken'),
        status: 'failed',
        outcome: 'connection_broken',
      };
    case 'not_found':
    case 'no_access':
      return context === 'shortcut'
        ? {
            result: refuseFile('drive_shortcut_target'),
            status: 'refused',
            outcome: 'drive_shortcut_target',
          }
        : { result: refuseFile('drive_file_gone'), status: 'refused', outcome: 'drive_file_gone' };
    case 'download_blocked':
      return {
        result: refuseFile('drive_download_blocked'),
        status: 'refused',
        outcome: 'drive_download_blocked',
      };
    case 'domain_policy':
      return {
        result: refuseFile('drive_domain_policy'),
        status: 'refused',
        outcome: 'drive_domain_policy',
      };
    case 'export_too_large':
      return {
        result: refuseFile('drive_export_too_large'),
        status: 'refused',
        outcome: 'drive_export_too_large',
      };
    case 'too_large':
      return {
        result: failure(
          422,
          'DRIVE_REFUSED',
          refusal('too_large', error.received).message,
          false,
          'too_large',
        ),
        status: 'refused',
        outcome: 'too_large',
      };
    case 'busy':
      return { result: retryLater('drive_busy'), status: 'failed', outcome: 'drive_busy' };
    case 'timeout':
      return { result: retryLater('drive_timeout'), status: 'failed', outcome: 'drive_timeout' };
    case 'client_config':
      ctx.log.error('google refused the oauth client configuration', { at: 'read' });
      return {
        result: failure(500, 'CONFIG', DRIVE_PAGE_MESSAGES.misconfigured),
        status: 'failed',
        outcome: 'client_config',
      };
    case 'unreachable':
    case 'bad_response':
      return {
        result: retryLater('drive_unreachable'),
        status: 'failed',
        outcome: 'drive_unreachable',
      };
  }
}

/** A plan that refuses → what he is told. */
function planRefusal(plan: Extract<ReadPlan, { kind: 'refuse' }>): ReadFailure {
  if (plan.code === 'empty') {
    return {
      result: failure(422, 'DRIVE_REFUSED', refusal('empty').message, false, 'empty'),
      status: 'refused',
      outcome: 'empty',
    };
  }
  if (plan.code === 'too_large') {
    return {
      result: failure(
        422,
        'DRIVE_REFUSED',
        refusal('too_large', plan.bytes ?? 0).message,
        false,
        'too_large',
      ),
      status: 'refused',
      outcome: 'too_large',
    };
  }
  return { result: refuseFile(plan.code, plan.label ?? ''), status: 'refused', outcome: plan.code };
}

async function readFile(ctx: Ctx, request: ActionRequest<'read_file'>): Promise<DrivePageResult> {
  const { drive, user, log } = ctx;
  if (!isDriveFileId(request.fileId)) {
    return failure(400, 'BAD_REQUEST', 'fileId is not a Google Drive file id.');
  }
  const readId = request.requestId;
  const started = ctx.now().getTime();

  const found = await drive.store.getConnection(user.userId);
  if (!found.ok) {
    log.error('drive connection unavailable for a read', { error: found.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  const row = found.value;
  if (row === null) return connection('not_connected');
  if (row.status === 'broken') return connection('connection_broken');

  const claimed = await drive.store.claimRead({
    id: readId,
    userId: user.userId,
    driveFileId: request.fileId,
    perMinute: DRIVE_LIMITS.readsPerMinute,
  });
  if (!claimed.ok) {
    const reason = driveStoreReason(claimed.error);
    if (reason === 'not_connected') return connection('not_connected');
    if (reason === 'too_many_reads') {
      log.info('drive file not read', { userId: user.userId, readId, outcome: 'too_many_reads' });
      return retryLater('drive_too_many_reads');
    }
    log.error('drive read could not be claimed', { readId, error: claimed.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  if (!claimed.value.claimed) {
    // One id reads one file, once; the browser asks again under a new id.
    return failure(409, 'READ_EXPIRED', DRIVE_PAGE_MESSAGES.readAgain, true);
  }

  let type: string | null = null;
  const end = async (outcome: ReadFailure): Promise<DrivePageResult> => {
    const recorded = await drive.store.completeRead({
      id: readId,
      userId: user.userId,
      status: outcome.status,
      outcome: outcome.outcome,
      durationMs: ctx.now().getTime() - started,
    });
    if (!recorded.ok)
      log.error('drive read outcome not recorded', { readId, error: recorded.error });
    log.info('drive file not read', {
      userId: user.userId,
      readId,
      type,
      ms: ctx.now().getTime() - started,
      outcome: outcome.outcome,
    });
    return outcome.result;
  };

  const refreshToken = await refreshTokenOf(ctx, row);
  if (refreshToken === null) {
    await markBroken(ctx, row, 'unreadable');
    return end({
      result: connection('connection_broken'),
      status: 'failed',
      outcome: 'connection_broken',
    });
  }
  const access = await drive.google.refresh(refreshToken);
  if (!access.ok) {
    if (access.error.kind === 'grant_invalid') {
      await markBroken(ctx, row, 'grant_revoked');
      return end({
        result: connection('connection_broken'),
        status: 'failed',
        outcome: 'connection_broken',
      });
    }
    return end(await fileFailure(ctx, row, access.error, 'file'));
  }
  const token = access.value.accessToken;

  const meta = await drive.google.getFile(token, request.fileId);
  if (!meta.ok) return end(await fileFailure(ctx, row, meta.error, 'file'));
  let file: DriveFileMeta = meta.value;
  type = typeGroup(file.mimeType);
  let plan = planFor(file);
  let viaShortcut = false;
  if (plan.kind === 'shortcut') {
    viaShortcut = true;
    const target = await drive.google.getFile(token, plan.targetId);
    if (!target.ok) return end(await fileFailure(ctx, row, target.error, 'shortcut'));
    file = target.value;
    type = typeGroup(file.mimeType);
    plan = planFor(file, true);
  }
  if (plan.kind === 'refuse') return end(planRefusal(plan));
  if (plan.kind === 'shortcut')
    return end(planRefusal({ kind: 'refuse', code: 'drive_shortcut_target' }));

  const content = await drive.google.readContent(token, file.id, plan);
  if (!content.ok) return end(await fileFailure(ctx, row, content.error, 'file'));
  const bytes = content.value.bytes;
  if (bytes.length === 0) return end(planRefusal({ kind: 'refuse', code: 'empty' }));

  const contentHash = await sha256OfBytes(bytes);
  const name = displayName(file);
  const exportedAs = plan.kind === 'export' ? plan.format.mimeType : null;
  const recorded = await drive.store.completeRead({
    id: readId,
    userId: user.userId,
    status: 'fetched',
    outcome: null,
    name,
    googleMime: file.mimeType,
    exportedAs,
    byteSize: bytes.length,
    contentHash,
    modifiedAt: file.modifiedTime,
    durationMs: ctx.now().getTime() - started,
  });
  if (!recorded.ok) {
    log.error('drive file read but not recorded', { readId, error: recorded.error });
    return failure(503, 'STORE', DRIVE_PAGE_MESSAGES.storeDown, true);
  }
  if (!recorded.value) {
    // The record is gone: the connection was disconnected while this file was in flight. What
    // was fetched under it is not handed over (the brief: disconnect means disconnected).
    log.info('drive file not read', {
      userId: user.userId,
      readId,
      type,
      outcome: 'disconnected_in_flight',
    });
    return connection('not_connected');
  }
  log.info('drive file read', {
    userId: user.userId,
    readId,
    type,
    exported: plan.kind === 'export',
    viaShortcut,
    bytes: bytes.length,
    ms: ctx.now().getTime() - started,
    outcome: 'fetched',
  });
  return {
    status: 200,
    body: {
      action: 'read_file',
      readId,
      name,
      fileName: readerFileName(file, plan),
      contentType: exportedAs ?? content.value.contentType,
      byteSize: bytes.length,
      contentHash,
      googleType: plan.kind === 'export' ? googleTypeLabel(file.mimeType) : null,
      fileId: file.id,
    },
    bytes,
  };
}

// ---------------------------------------------------------------------------------------

async function route(deps: DrivePageDeps, input: DrivePageInput): Promise<DrivePageResult> {
  const log = deps.log.child({ component: 'drive' });
  const access = await verifyStaffAccess(deps.verify, input.token);
  if (!access.ok) {
    log.error('caller verification unavailable', { error: access.error });
    return failure(503, access.error.code, 'Service temporarily unavailable', true);
  }
  if (access.value.kind === 'unauthenticated') {
    return failure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  if (access.value.kind === 'forbidden') {
    return failure(403, 'FORBIDDEN', 'This account does not have access.');
  }

  const parsed = REQUEST.safeParse(input.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? 'body' : first.path.join('.');
    return failure(400, 'BAD_REQUEST', `Invalid request: ${where}.`);
  }
  const request = parsed.data;
  const user = access.value.user;

  if (deps.drive === null) {
    if (request.action === 'status') {
      return { status: 200, body: { action: 'status', state: 'unavailable' } };
    }
    return connection('not_configured');
  }
  const ctx: Ctx = {
    deps,
    drive: deps.drive,
    user,
    log,
    now: deps.now ?? ((): Date => new Date()),
  };
  switch (request.action) {
    case 'status':
      return status(ctx);
    case 'connect_start':
      return connectStart(ctx);
    case 'connect_finish':
      return connectFinish(ctx, request);
    case 'disconnect':
      return disconnect(ctx);
    case 'read_file':
      return readFile(ctx, request);
    case 'picked':
      log.info('drive files picked', { userId: user.userId, count: request.count });
      return { status: 200, body: { action: 'picked', logged: true } };
  }
}

export async function handleDriveRequest(
  deps: DrivePageDeps,
  input: DrivePageInput,
): Promise<DrivePageResult> {
  try {
    return await route(deps, input);
  } catch (caught: unknown) {
    // Nothing above is supposed to throw. If it does, a 500 with the cause's NAME logged —
    // never the cause itself, which could be holding a token.
    deps.log.error('drive request threw', {
      errorName: caught instanceof Error ? caught.name : typeof caught,
    });
    return failure(500, 'INTERNAL', 'Internal error.');
  }
}
