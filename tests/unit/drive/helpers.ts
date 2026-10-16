/**
 * Fakes for the Drive unit tests: Google's answers from tests/fixtures/google behind a stubbed
 * fetch; a scripted `GoogleClient` for the endpoint's tests; and an in-memory `DriveStore` that
 * behaves as migration 20261016010000's functions do — single-use attempts, the same refusals
 * for the same reasons, reads that die with their connection — so the endpoint's handling of
 * each database answer is tested without a database. The functions themselves run on a stack
 * (tests/integration/drive.test.ts, tests/security/drive.test.ts).
 *
 * Token-SHAPED values are built here at runtime, never written as literals, so no file in the
 * repository holds anything a secret scanner would match.
 */
import { readFileSync } from 'node:fs';

import { AppError, err, ok, type Result } from '../../../src/lib/errors.js';
import type { DriveFileMeta, ReadPlan } from '../../../src/lib/drive/formats.js';
import type {
  DriveAccount,
  FileContent,
  GoogleClient,
  GoogleFailure,
  TokenGrant,
} from '../../../src/lib/drive/google.js';
import { DRIVE_FILE_SCOPE } from '../../../src/lib/drive/limits.js';
import type {
  CompleteReadInput,
  DriveConnectionRecord,
  DriveStore,
  DriveStoreReason,
  TakenAttempt,
} from '../../../src/lib/drive/store.js';

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/google/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

/** A fixture body with its placeholder tokens replaced. */
export function fixtureText(name: string, replace: Readonly<Record<string, string>> = {}): string {
  let text = JSON.stringify(fixture(name));
  for (const [from, to] of Object.entries(replace)) text = text.split(from).join(to);
  return text;
}

// Shaped like Google's, assembled at runtime (see the header).
export const ACCESS_TOKEN = ['ya', '29.', 'a0AfB_byC', 'Q'.repeat(60)].join('');
export const REFRESH_TOKEN = ['1', '//', '0g', 'R'.repeat(80)].join('');
export const AUTH_CODE = ['4', '/', '0Ad', 'C'.repeat(60)].join('');
export const CLIENT_SECRET = ['GOCSPX', '-', 'S'.repeat(28)].join('');
export const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';

export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** A fetch that answers from `route` and keeps what it was asked. */
export function googleServer(
  route: (request: SeenRequest, index: number) => Response | Promise<Response>,
): {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly seen: SeenRequest[];
} {
  const seen: SeenRequest[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const request: SeenRequest = {
        method: init.method ?? 'GET',
        url: input,
        headers,
        body: typeof init.body === 'string' ? init.body : '',
      };
      seen.push(request);
      return route(request, seen.length - 1);
    },
  };
}

// ---------------------------------------------------------------------------------------
// A scripted GoogleClient
// ---------------------------------------------------------------------------------------

export interface ScriptedGoogle extends GoogleClient {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
  exchange: Result<TokenGrant, GoogleFailure>;
  /** Refresh answers in order; the last one repeats. */
  refreshes: Result<{ readonly accessToken: string }, GoogleFailure>[];
  revokes: Result<'revoked' | 'already_gone', GoogleFailure>[];
  account: Result<DriveAccount, GoogleFailure>;
  files: Map<string, Result<DriveFileMeta, GoogleFailure>>;
  content: Map<string, Result<FileContent, GoogleFailure>>;
  /** Run before `readContent` answers: a test can disconnect in the middle of a read. */
  beforeContent: (() => Promise<void>) | null;
}

export function pdfMeta(overrides: Partial<DriveFileMeta> = {}): DriveFileMeta {
  return {
    id: 'PdfFileId0001',
    name: 'Lender policy.pdf',
    mimeType: 'application/pdf',
    size: 1_000,
    modifiedTime: '2026-10-14T09:00:00.000Z',
    trashed: false,
    canDownload: true,
    shortcutTargetId: null,
    shortcutTargetMimeType: null,
    ...overrides,
  };
}

export function scriptedGoogle(): ScriptedGoogle {
  const calls: { method: string; args: readonly unknown[] }[] = [];
  const google: ScriptedGoogle = {
    calls,
    exchange: ok({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      scope: DRIVE_FILE_SCOPE,
    }),
    refreshes: [ok({ accessToken: ACCESS_TOKEN })],
    revokes: [ok('revoked')],
    account: ok({ email: 'broker@example.com', permissionId: 'perm-ross-0001' }),
    files: new Map(),
    content: new Map(),
    beforeContent: null,
    authorizeUrl: (input) => {
      calls.push({ method: 'authorizeUrl', args: [input] });
      const extra = new URLSearchParams(input.extra ?? {}).toString();
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${input.state}&code_challenge=${input.codeChallenge}${extra === '' ? '' : `&${extra}`}`;
    },
    exchangeCode: (code, verifier) => {
      calls.push({ method: 'exchangeCode', args: [code, verifier] });
      return Promise.resolve(google.exchange);
    },
    refresh: (token) => {
      calls.push({ method: 'refresh', args: [token] });
      const next = google.refreshes.length > 1 ? google.refreshes.shift() : google.refreshes[0];
      return Promise.resolve(next ?? err({ kind: 'unreachable' }));
    },
    revoke: (token) => {
      calls.push({ method: 'revoke', args: [token] });
      const next = google.revokes.length > 1 ? google.revokes.shift() : google.revokes[0];
      return Promise.resolve(next ?? ok('revoked'));
    },
    about: (token) => {
      calls.push({ method: 'about', args: [token] });
      return Promise.resolve(google.account);
    },
    getFile: (token, fileId) => {
      calls.push({ method: 'getFile', args: [token, fileId] });
      return Promise.resolve(google.files.get(fileId) ?? err({ kind: 'not_found' }));
    },
    readContent: async (
      token,
      fileId,
      plan: Extract<ReadPlan, { kind: 'export' | 'download' }>,
    ) => {
      calls.push({ method: 'readContent', args: [token, fileId, plan] });
      if (google.beforeContent !== null) await google.beforeContent();
      return google.content.get(fileId) ?? err({ kind: 'not_found' });
    },
  };
  return google;
}

/** Every call of one method, in order. */
export function callsTo(google: ScriptedGoogle, method: string): (readonly unknown[])[] {
  return google.calls.filter((call) => call.method === method).map((call) => call.args);
}

// ---------------------------------------------------------------------------------------
// An in-memory DriveStore that behaves as the migration does
// ---------------------------------------------------------------------------------------

interface Attempt {
  id: string;
  stateHash: string;
  userId: string;
  verifierSealed: string;
  codeSealed: string | null;
  error: string | null;
  expiresAt: number;
  returned: boolean;
}

export interface ReadRow {
  id: string;
  userId: string;
  driveFileId: string;
  status: 'started' | 'fetched' | 'refused' | 'failed';
  outcome: string | null;
  name: string | null;
  googleMime: string | null;
  exportedAs: string | null;
  byteSize: number | null;
  contentHash: string | null;
  modifiedAt: string | null;
  durationMs: number | null;
  createdAt: number;
  fetchedAt: string | null;
}

export interface MemoryDriveStore extends DriveStore {
  readonly connections: Map<string, DriveConnectionRecord>;
  readonly attempts: Map<string, Attempt>;
  readonly reads: Map<string, ReadRow>;
  readonly audit: { action: string; userId: string; after: Readonly<Record<string, unknown>> }[];
  /** Fail the next call of a method with this error, once. */
  readonly failOnce: Map<keyof DriveStore, AppError>;
  /** Run once, just before the next saveConnection decides: another Connect landing. */
  beforeSave: (() => void) | null;
}

export function refusedBy(reason: DriveStoreReason): AppError {
  return new AppError('CONFLICT', `test store: ${reason}`, { context: { reason } });
}

let attemptSequence = 0;

export function memoryDriveStore(now: () => number = () => Date.now()): MemoryDriveStore {
  const connections = new Map<string, DriveConnectionRecord>();
  const attempts = new Map<string, Attempt>();
  const reads = new Map<string, ReadRow>();
  const audit: MemoryDriveStore['audit'] = [];
  const failOnce = new Map<keyof DriveStore, AppError>();
  const gate = <T>(method: keyof DriveStore, run: () => Result<T>): Promise<Result<T>> => {
    const planned = failOnce.get(method);
    if (planned !== undefined) {
      failOnce.delete(method);
      return Promise.resolve(err(planned));
    }
    return Promise.resolve(run());
  };
  const iso = (): string => new Date(now()).toISOString();

  const store: MemoryDriveStore = {
    connections,
    attempts,
    reads,
    audit,
    failOnce,
    beforeSave: null,

    getConnection: (userId) => gate('getConnection', () => ok(connections.get(userId) ?? null)),

    createAttempt: (input) =>
      gate('createAttempt', (): Result<string> => {
        for (const [id, attempt] of attempts) {
          if (attempt.userId === input.userId && attempt.expiresAt <= now()) attempts.delete(id);
        }
        const open = [...attempts.values()].filter((a) => a.userId === input.userId).length;
        if (open >= input.maxOpen) return err(refusedBy('too_many_attempts'));
        attemptSequence += 1;
        const id = `a0000000-0000-4000-8000-${String(attemptSequence).padStart(12, '0')}`;
        attempts.set(id, {
          id,
          stateHash: input.stateHash,
          userId: input.userId,
          verifierSealed: input.verifierSealed,
          codeSealed: null,
          error: null,
          expiresAt: now() + input.ttlSeconds * 1_000,
          returned: false,
        });
        return ok(id);
      }),

    returnAttempt: (input) =>
      gate('returnAttempt', () => {
        const attempt = [...attempts.values()].find(
          (a) => a.stateHash === input.stateHash && !a.returned && a.expiresAt > now(),
        );
        if (attempt === undefined) return ok(null);
        attempt.returned = true;
        attempt.codeSealed = input.codeSealed;
        attempt.error = input.codeSealed === null ? (input.error ?? 'no_code') : null;
        return ok({ id: attempt.id, userId: attempt.userId });
      }),

    takeAttempt: (id, userId) =>
      gate('takeAttempt', (): Result<TakenAttempt> => {
        const attempt = attempts.get(id);
        if (attempt === undefined) return ok({ outcome: 'missing' });
        attempts.delete(id);
        if (attempt.userId !== userId) return ok({ outcome: 'wrong_user' });
        if (attempt.expiresAt <= now()) return ok({ outcome: 'expired' });
        if (!attempt.returned) return ok({ outcome: 'not_returned' });
        if (attempt.error !== null) return ok({ outcome: 'declined', error: attempt.error });
        if (attempt.codeSealed === null) return ok({ outcome: 'declined', error: 'no_code' });
        return ok({
          outcome: 'ok',
          stateHash: attempt.stateHash,
          verifierSealed: attempt.verifierSealed,
          codeSealed: attempt.codeSealed,
        });
      }),

    saveConnection: (input) =>
      gate('saveConnection', () => {
        const hook = store.beforeSave;
        store.beforeSave = null;
        hook?.();
        const current = connections.get(input.userId) ?? null;
        if ((current?.tokenId ?? null) !== input.expectedTokenId) return err(refusedBy('changed'));
        connections.set(input.userId, {
          userId: input.userId,
          tokenId: input.tokenId,
          googleAccountId: input.googleAccountId,
          googleEmail: input.googleEmail,
          refreshTokenSealed: input.refreshTokenSealed,
          grantedScope: input.grantedScope,
          status: 'active',
          brokenReason: null,
          brokenAt: null,
          connectedAt: iso(),
          lastUsedAt: null,
        });
        const sameAccount = current !== null && current.googleAccountId === input.googleAccountId;
        audit.push({
          action: 'DRIVE_CONNECTED',
          userId: input.userId,
          after: { replaced: current !== null, same_account: sameAccount },
        });
        return ok({ replaced: current !== null, sameAccount });
      }),

    markBroken: (userId, tokenId, reason) =>
      gate('markBroken', () => {
        const current = connections.get(userId);
        if (current?.tokenId !== tokenId || current.status !== 'active') return ok(false);
        connections.set(userId, {
          ...current,
          status: 'broken',
          brokenReason: reason,
          brokenAt: iso(),
        });
        audit.push({ action: 'DRIVE_BROKEN', userId, after: { reason } });
        return ok(true);
      }),

    deleteConnection: (userId, tokenId) =>
      gate('deleteConnection', () => {
        const current = connections.get(userId);
        if (current?.tokenId !== tokenId) return ok(false);
        connections.delete(userId);
        // The reads go with it (on delete cascade).
        for (const [id, row] of reads) if (row.userId === userId) reads.delete(id);
        audit.push({ action: 'DRIVE_DISCONNECTED', userId, after: { revoked_at_google: true } });
        return ok(true);
      }),

    claimRead: (input) =>
      gate('claimRead', (): Result<{ readonly claimed: boolean }> => {
        if (reads.has(input.id)) return ok({ claimed: false });
        if (!connections.has(input.userId)) return err(refusedBy('not_connected'));
        const recent = [...reads.values()].filter(
          (row) => row.userId === input.userId && now() - row.createdAt < 60_000,
        );
        if (recent.length >= input.perMinute) return err(refusedBy('too_many_reads'));
        reads.set(input.id, {
          id: input.id,
          userId: input.userId,
          driveFileId: input.driveFileId,
          status: 'started',
          outcome: null,
          name: null,
          googleMime: null,
          exportedAs: null,
          byteSize: null,
          contentHash: null,
          modifiedAt: null,
          durationMs: null,
          createdAt: now(),
          fetchedAt: null,
        });
        const connection = connections.get(input.userId);
        if (connection !== undefined)
          connections.set(input.userId, { ...connection, lastUsedAt: iso() });
        return ok({ claimed: true });
      }),

    completeRead: (input: CompleteReadInput) =>
      gate('completeRead', () => {
        const row = reads.get(input.id);
        if (row?.userId !== input.userId) return ok(false);
        reads.set(input.id, {
          ...row,
          status: input.status,
          outcome: input.outcome,
          name: input.name ?? row.name,
          googleMime: input.googleMime ?? row.googleMime,
          exportedAs: input.exportedAs ?? row.exportedAs,
          byteSize: input.byteSize ?? row.byteSize,
          contentHash: input.contentHash ?? row.contentHash,
          modifiedAt: input.modifiedAt ?? row.modifiedAt,
          durationMs: input.durationMs ?? row.durationMs,
          fetchedAt: input.status === 'fetched' ? iso() : row.fetchedAt,
        });
        return ok(true);
      }),
  };
  return store;
}
