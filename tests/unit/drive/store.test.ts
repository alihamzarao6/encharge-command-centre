/**
 * The supabase-js adapter for Drive (src/lib/drive/store.ts) against a stubbed fetch serving
 * PostgREST shapes: each function called with exactly the parameters the migration declares,
 * each column read is one the table has, the database's refusals named — and nothing sealed is
 * ever put into an error.
 */
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDriveServiceClient,
  driveStoreReason,
  supabaseDriveStore,
  type DriveStore,
} from '../../../src/lib/drive/store.js';
import { AppError } from '../../../src/lib/errors.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const USER = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = 'b0000000-0000-4000-8000-000000000001';
const ATTEMPT = 'a0000000-0000-4000-8000-000000000001';
const READ = 'c1000000-0000-4000-8000-000000000001';
const SEALED = `v1.${'A'.repeat(16)}.${'B'.repeat(60)}`;

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
}
const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stub(handler: (req: Seen) => Response | undefined): void {
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const req: Seen = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: decodeURIComponent(url.search),
        body: typeof init?.body === 'string' ? init.body : '',
      };
      seen.push(req);
      const response = handler(req);
      if (response === undefined) throw new Error(`unstubbed: ${req.method} ${req.path}`);
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

function store(): DriveStore {
  return supabaseDriveStore(createDriveServiceClient(CONFIG));
}

const ROW = {
  user_id: USER,
  token_id: TOKEN_ID,
  google_account_id: 'perm-1',
  google_email: 'broker@example.com',
  refresh_token_sealed: SEALED,
  granted_scope: 'https://www.googleapis.com/auth/drive.file',
  status: 'active',
  broken_reason: null,
  broken_at: null,
  connected_at: '2026-10-16T00:00:00+00:00',
  last_used_at: null,
};

describe('reads and calls', () => {
  it('reads a connection by person', async () => {
    stub(() => json([ROW]));
    const found = await store().getConnection(USER);
    expect(found).toEqual({
      ok: true,
      value: {
        userId: USER,
        tokenId: TOKEN_ID,
        googleAccountId: 'perm-1',
        googleEmail: 'broker@example.com',
        refreshTokenSealed: SEALED,
        grantedScope: 'https://www.googleapis.com/auth/drive.file',
        status: 'active',
        brokenReason: null,
        brokenAt: null,
        connectedAt: '2026-10-16T00:00:00+00:00',
        lastUsedAt: null,
      },
    });
    expect(seen[0]?.path).toBe('/rest/v1/drive_connections');
    expect(seen[0]?.query).toContain(`user_id=eq.${USER}`);
  });

  it('no row is no connection', async () => {
    stub(() => json([]));
    expect(await store().getConnection(USER)).toEqual({ ok: true, value: null });
  });

  it("a row outside the table's constraints is an internal error, not a connection", async () => {
    stub(() => json([{ ...ROW, status: 'weird' }]));
    const found = await store().getConnection(USER);
    expect(found.ok).toBe(false);
  });

  it('takes an attempt: ok with its parts, or an outcome with nothing sealed', async () => {
    stub(() =>
      json([
        {
          outcome: 'ok',
          state_hash: 'a'.repeat(64),
          verifier_sealed: SEALED,
          code_sealed: SEALED,
          callback_error: null,
        },
      ]),
    );
    expect(await store().takeAttempt(ATTEMPT, USER)).toEqual({
      ok: true,
      value: {
        outcome: 'ok',
        stateHash: 'a'.repeat(64),
        verifierSealed: SEALED,
        codeSealed: SEALED,
      },
    });
    vi.unstubAllGlobals();
    for (const outcome of ['wrong_user', 'expired', 'not_returned', 'missing']) {
      stub(() =>
        json([
          {
            outcome,
            state_hash: null,
            verifier_sealed: null,
            code_sealed: null,
            callback_error: null,
          },
        ]),
      );
      expect(await store().takeAttempt(ATTEMPT, USER)).toEqual({ ok: true, value: { outcome } });
      vi.unstubAllGlobals();
    }
    stub(() =>
      json([
        {
          outcome: 'declined',
          state_hash: null,
          verifier_sealed: null,
          code_sealed: null,
          callback_error: 'access_denied',
        },
      ]),
    );
    expect(await store().takeAttempt(ATTEMPT, USER)).toEqual({
      ok: true,
      value: { outcome: 'declined', error: 'access_denied' },
    });
  });

  it('an ok without its parts, or an unknown outcome, is an internal error', async () => {
    stub(() =>
      json([
        {
          outcome: 'ok',
          state_hash: null,
          verifier_sealed: null,
          code_sealed: null,
          callback_error: null,
        },
      ]),
    );
    expect((await store().takeAttempt(ATTEMPT, USER)).ok).toBe(false);
    vi.unstubAllGlobals();
    stub(() =>
      json([
        {
          outcome: 'surprise',
          state_hash: null,
          verifier_sealed: null,
          code_sealed: null,
          callback_error: null,
        },
      ]),
    );
    expect((await store().takeAttempt(ATTEMPT, USER)).ok).toBe(false);
  });

  it('returns an attempt, or null when there is no fresh one', async () => {
    stub(() => json([{ id: ATTEMPT, user_id: USER }]));
    expect(
      await store().returnAttempt({ stateHash: 'a'.repeat(64), codeSealed: SEALED, error: null }),
    ).toEqual({
      ok: true,
      value: { id: ATTEMPT, userId: USER },
    });
    vi.unstubAllGlobals();
    stub(() => json([]));
    expect(
      await store().returnAttempt({
        stateHash: 'a'.repeat(64),
        codeSealed: null,
        error: 'access_denied',
      }),
    ).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("the database's refusals", () => {
  it.each([
    ['DV001', 'too_many_attempts'],
    ['DV002', 'changed'],
    ['DR001', 'too_many_reads'],
    ['23503', 'not_connected'],
  ])('SQLSTATE %s is %s, and the message is not kept', async (code, reason) => {
    stub(() =>
      json({ code, message: `secret-looking detail ${SEALED}`, details: null, hint: null }, 400),
    );
    const result = await store().saveConnection({
      userId: USER,
      expectedTokenId: null,
      tokenId: TOKEN_ID,
      googleAccountId: 'perm-1',
      googleEmail: 'broker@example.com',
      refreshTokenSealed: SEALED,
      grantedScope: 'scope',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(driveStoreReason(result.error)).toBe(reason);
      expect(JSON.stringify(result.error.toJSON())).not.toContain(SEALED);
    }
  });

  it('anything else is a database error with no reason, and a transport failure is retryable', async () => {
    stub(() => json({ code: 'XX000', message: 'boom', details: null, hint: null }, 500));
    const result = await store().markBroken(USER, TOKEN_ID, 'grant_revoked');
    expect(result.ok || driveStoreReason(result.error)).toBe(null);
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network')));
    const down = await store().getConnection(USER);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.retryable).toBe(true);
  });

  it("driveStoreReason ignores errors that are not the store's", () => {
    expect(
      driveStoreReason(new AppError('CONFLICT', 'x', { context: { reason: 'something_else' } })),
    ).toBeNull();
  });
});

/**
 * No stack here: the one mistake the stack suites exist to catch — a parameter or a column
 * spelled differently here than in the migration — is also caught by reading the migration.
 */
describe('the adapter and the migration agree', () => {
  const sql = readFileSync(
    new URL('../../../supabase/migrations/20261016010000_drive.sql', import.meta.url),
    'utf8',
  );
  function declaration(fn: string): string {
    const start = sql.lastIndexOf(`create or replace function public.${fn}(`);
    expect(start, `${fn} is declared`).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf('language plpgsql', start));
  }
  const parameters = (fn: string): string[] =>
    [...declaration(fn).matchAll(/^ {2}(p_\w+) /gm)].map((match) => match[1] ?? '');
  function columns(table: string): string[] {
    const start = sql.indexOf(`create table public.${table} (`);
    const body = sql.slice(start, sql.indexOf('\n);', start));
    return [
      ...body.matchAll(/^ {2}(\w+) (?:uuid|text|bigint|integer|timestamptz|boolean)\b/gm),
    ].map((m) => m[1] ?? '');
  }

  it('every function is called with exactly the parameters it declares', async () => {
    stub((req) => {
      if (req.path.endsWith('/take_drive_oauth_state')) {
        return json([
          {
            outcome: 'missing',
            state_hash: null,
            verifier_sealed: null,
            code_sealed: null,
            callback_error: null,
          },
        ]);
      }
      if (req.path.endsWith('/save_drive_connection'))
        return json([{ replaced: false, same_account: false }]);
      if (req.path.endsWith('/claim_drive_read')) return json([{ claimed: true, existing: false }]);
      if (req.path.startsWith('/rest/v1/rpc/')) return json(true);
      return undefined;
    });
    const s = store();
    await s.createAttempt({
      userId: USER,
      stateHash: 'a'.repeat(64),
      verifierSealed: SEALED,
      ttlSeconds: 600,
      maxOpen: 5,
    });
    await s.returnAttempt({ stateHash: 'a'.repeat(64), codeSealed: SEALED, error: null });
    await s.takeAttempt(ATTEMPT, USER);
    await s.saveConnection({
      userId: USER,
      expectedTokenId: null,
      tokenId: TOKEN_ID,
      googleAccountId: 'perm-1',
      googleEmail: 'broker@example.com',
      refreshTokenSealed: SEALED,
      grantedScope: 'scope',
    });
    await s.markBroken(USER, TOKEN_ID, 'grant_revoked');
    await s.deleteConnection(USER, TOKEN_ID);
    await s.claimRead({ id: READ, userId: USER, driveFileId: 'PdfFileId0001', perMinute: 20 });
    await s.completeRead({ id: READ, userId: USER, status: 'failed', outcome: 'drive_busy' });
    for (const fn of [
      'create_drive_oauth_state',
      'return_drive_oauth_state',
      'take_drive_oauth_state',
      'save_drive_connection',
      'mark_drive_connection_broken',
      'delete_drive_connection',
      'claim_drive_read',
      'complete_drive_read',
    ]) {
      const sent = Object.keys(
        JSON.parse(seen.find((req) => req.path === `/rest/v1/rpc/${fn}`)?.body ?? '{}') as object,
      );
      expect(sent.sort(), fn).toEqual(parameters(fn).sort());
    }
  });

  it('every column the adapter selects exists in drive_connections', async () => {
    stub(() => json([]));
    await store().getConnection(USER);
    const selected = (new URLSearchParams(seen[0]?.query).get('select') ?? '')
      .split(',')
      .map((c) => c.trim());
    expect(selected.length).toBeGreaterThan(5);
    for (const column of selected) expect(columns('drive_connections')).toContain(column);
  });

  it('every refusal the Drive functions raise is one the adapter names', async () => {
    const raised = [
      ...new Set([...sql.matchAll(/using errcode = '(\w+)'/g)].map((m) => m[1] ?? '')),
    ];
    // The migration also redefines begin / finish, whose codes (02000, FL…) the files store
    // names (tests/unit/files/store.test.ts). The D… codes are Drive's own.
    const drive = raised.filter((code) => code.startsWith('D'));
    expect(drive.sort()).toEqual(['DR001', 'DV001', 'DV002']);
    expect(
      raised
        .filter((code) => !code.startsWith('D'))
        .every((code) => code === '02000' || code.startsWith('FL')),
    ).toBe(true);
    for (const code of [...drive, '23503']) {
      stub(() => json({ code, message: 'refused', details: null, hint: null }, 400));
      const result = await store().claimRead({
        id: READ,
        userId: USER,
        driveFileId: 'PdfFileId0001',
        perMinute: 20,
      });
      expect(result.ok, code).toBe(false);
      if (!result.ok) expect(driveStoreReason(result.error), code).not.toBeNull();
      vi.unstubAllGlobals();
    }
  });
});
