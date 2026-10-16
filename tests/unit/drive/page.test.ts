/**
 * The `drive` endpoint (src/lib/drive/page.ts) with a scripted Google and an in-memory store:
 * every Part C case about THE CONNECTION, and every case about THE FILE that is decided on the
 * server. What a person is told, what is recorded, what is revoked at Google and what is not —
 * and that no token, code, verifier, state or file name ever reaches a reply or a log line.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { DriveConfig } from '../../../src/lib/drive/config.js';
import { SEALED_FOR, open, seal, sha256Hex, toBase64Url } from '../../../src/lib/drive/crypto.js';
import { importSealKey } from '../../../src/lib/drive/crypto.js';
import {
  DRIVE_LIMITS,
  DRIVE_FILE_SCOPE,
  SWITCH_LEFTOVER_NOTE,
} from '../../../src/lib/drive/limits.js';
import {
  handleDriveCallback,
  handleDriveRequest,
  type DrivePageDeps,
  type DrivePageResult,
  type DriveReadReply,
} from '../../../src/lib/drive/page.js';
import type { DriveConnectionRecord } from '../../../src/lib/drive/store.js';
import { AppError, err, ok } from '../../../src/lib/errors.js';
import { verifyAs } from '../files/helpers.js';
import { capturingLogger } from '../llm/helpers.js';
import {
  ACCESS_TOKEN,
  AUTH_CODE,
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  callsTo,
  memoryDriveStore,
  pdfMeta,
  scriptedGoogle,
  type MemoryDriveStore,
  type ScriptedGoogle,
} from './helpers.js';

const ROSS = '11111111-1111-4111-8111-111111111111';
const COLLEAGUE = '22222222-2222-4222-8222-222222222222';
const APP = 'https://fundd-command-centre.vercel.app';
const KEY = toBase64Url(new Uint8Array(32).fill(5));
const NOW = Date.parse('2026-10-16T02:00:00Z');
const CANARY_NAME = 'Sample-Person-CANARY-NAME-91f0 payslip';

interface Harness {
  readonly deps: DrivePageDeps;
  readonly google: ScriptedGoogle;
  readonly store: MemoryDriveStore;
  readonly lines: string[];
  readonly clock: { at: number };
  readonly config: DriveConfig;
}

let key: CryptoKey;
beforeEach(async () => {
  const imported = await importSealKey(KEY);
  if (!imported.ok) throw imported.error;
  key = imported.value;
});

let ids = 0;
function newId(): string {
  ids += 1;
  return `b0000000-0000-4000-8000-${String(ids).padStart(12, '0')}`;
}
let requests = 0;
function requestId(): string {
  requests += 1;
  return `c1000000-0000-4000-8000-${String(requests).padStart(12, '0')}`;
}

function harness(userId: string = ROSS): Harness {
  const clock = { at: NOW };
  const google = scriptedGoogle();
  const store = memoryDriveStore(() => clock.at);
  const { log, lines } = capturingLogger();
  const config: DriveConfig = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    sealKey: key,
    redirectUri: 'https://project.supabase.co/functions/v1/drive/callback',
    responseMode: 'form_post',
    appOrigin: APP,
  };
  return {
    deps: {
      verify: verifyAs(userId),
      drive: { config, google, store },
      log,
      now: () => new Date(clock.at),
      newId,
    },
    google,
    store,
    lines,
    clock,
    config,
  };
}

function as(h: Harness, userId: string): DrivePageDeps {
  return { ...h.deps, verify: verifyAs(userId) };
}

function call(
  deps: DrivePageDeps,
  body: unknown,
  token: string | null = 'session',
): Promise<DrivePageResult> {
  return handleDriveRequest(deps, { token, body });
}

function body(result: DrivePageResult): Record<string, unknown> {
  return result.body as unknown as Record<string, unknown>;
}

function errorOf(result: DrivePageResult): {
  code: string;
  message: string;
  retryable: boolean;
  refusal?: string;
} {
  return (
    result.body as {
      error: { code: string; message: string; retryable: boolean; refusal?: string };
    }
  ).error;
}

/** A connection already in the store, sealed as the endpoint would seal it. */
async function connect(
  h: Harness,
  userId = ROSS,
  overrides: Partial<DriveConnectionRecord> = {},
  refreshToken = REFRESH_TOKEN,
): Promise<DriveConnectionRecord> {
  const tokenId = overrides.tokenId ?? newId();
  const row: DriveConnectionRecord = {
    userId,
    tokenId,
    googleAccountId: 'perm-ross-0001',
    googleEmail: 'broker@example.com',
    refreshTokenSealed: await seal(key, refreshToken, SEALED_FOR.refreshToken(userId, tokenId)),
    grantedScope: DRIVE_FILE_SCOPE,
    status: 'active',
    brokenReason: null,
    brokenAt: null,
    connectedAt: new Date(NOW - 86_400_000).toISOString(),
    lastUsedAt: null,
    ...overrides,
  };
  h.store.connections.set(userId, row);
  return row;
}

/** Everything a person or a log could see, for the never-leaks checks. */
function visible(h: Harness, results: readonly DrivePageResult[]): string {
  return [...results.map((result) => JSON.stringify(result.body)), ...h.lines].join('\n');
}

function expectNoSecrets(text: string, extra: readonly string[] = []): void {
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, AUTH_CODE, CLIENT_SECRET, ...extra]) {
    expect(text).not.toContain(secret);
  }
  // A leak the logger caught would still show as a redaction: none is expected anywhere.
  expect(text).not.toContain('[REDACTED]');
}

// ---------------------------------------------------------------------------------------

describe('who may ask', () => {
  it('no session is 401 before anything else happens', async () => {
    const h = harness();
    const result = await call(h.deps, { action: 'status' }, null);
    expect(result.status).toBe(401);
    expect(h.google.calls).toHaveLength(0);
  });

  it('an account not on the allowlist is 403', async () => {
    const h = harness();
    const result = await call(
      { ...h.deps, verify: verifyAs(ROSS, { allowlisted: false }) },
      { action: 'status' },
    );
    expect(result.status).toBe(403);
  });

  it('a deactivated account is 403, even with a connection in the store', async () => {
    const h = harness();
    await connect(h);
    const result = await call(
      { ...h.deps, verify: verifyAs(ROSS, { isActive: false }) },
      {
        action: 'read_file',
        requestId: requestId(),
        fileId: 'PdfFileId0001',
      },
    );
    expect(result.status).toBe(403);
    expect(h.google.calls).toHaveLength(0);
  });

  it('when verification cannot be done, says so (503), never 403', async () => {
    const h = harness();
    const down = {
      getUserFromToken: () => Promise.resolve(err(new AppError('NETWORK', 'down'))),
      getStaffRow: () => Promise.resolve(ok(null)),
    };
    expect((await call({ ...h.deps, verify: down }, { action: 'status' })).status).toBe(503);
  });

  it('a malformed request is 400 naming the field, not the value', async () => {
    const h = harness();
    const result = await call(h.deps, { action: 'connect_finish', attempt: 'not-a-uuid' });
    expect(result.status).toBe(400);
    expect(errorOf(result).message).toBe('Invalid request: attempt.');
  });
});

describe('Drive not set up on this Command Centre', () => {
  it('status says unavailable; everything else is refused in a sentence', async () => {
    const h = harness();
    const deps: DrivePageDeps = { ...h.deps, drive: null };
    expect(body(await call(deps, { action: 'status' }))).toEqual({
      action: 'status',
      state: 'unavailable',
    });
    const start = await call(deps, { action: 'connect_start' });
    expect(start.status).toBe(503);
    expect(errorOf(start)).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(errorOf(start).message).toMatch(/not set up/);
    expect(await handleDriveCallback(deps, { state: 'x'.repeat(43), code: AUTH_CODE })).toEqual({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------------------

describe('status (A3: never a stale "connected")', () => {
  it('not connected', async () => {
    const h = harness();
    expect(body(await call(h.deps, { action: 'status' }))).toEqual({
      action: 'status',
      state: 'not_connected',
    });
  });

  it('connected, CHECKED with Google now: one token refresh', async () => {
    const h = harness();
    await connect(h);
    const result = await call(h.deps, { action: 'status' });
    expect(body(result)).toMatchObject({
      action: 'status',
      state: 'connected',
      email: 'broker@example.com',
      checked: true,
    });
    expect(callsTo(h.google, 'refresh')).toEqual([[REFRESH_TOKEN]]);
    expectNoSecrets(visible(h, [result]));
  });

  it('access removed in his Google account: the check finds it, records it, and says so', async () => {
    const h = harness();
    const row = await connect(h);
    h.google.refreshes = [err({ kind: 'grant_invalid' })];
    const result = await call(h.deps, { action: 'status' });
    expect(body(result)).toMatchObject({
      state: 'broken',
      email: 'broker@example.com',
      reason: 'grant_revoked',
    });
    expect(String(body(result)['message'])).toMatch(/removed in your Google account/);
    expect(h.store.connections.get(ROSS)).toMatchObject({
      status: 'broken',
      brokenReason: 'grant_revoked',
      tokenId: row.tokenId,
    });
    expect(h.store.audit.map((entry) => entry.action)).toEqual(['DRIVE_BROKEN']);
  });

  it('a broken connection stays broken without asking Google again', async () => {
    const h = harness();
    await connect(h, ROSS, {
      status: 'broken',
      brokenReason: 'access_lost',
      brokenAt: '2026-10-15T00:00:00.000Z',
    });
    const result = await call(h.deps, { action: 'status' });
    expect(body(result)).toMatchObject({
      state: 'broken',
      reason: 'access_lost',
      brokenAt: '2026-10-15T00:00:00.000Z',
    });
    expect(h.google.calls).toHaveLength(0);
  });

  it('Google unreachable: connected, but plainly not checked', async () => {
    const h = harness();
    await connect(h);
    h.google.refreshes = [err({ kind: 'unreachable' })];
    expect(body(await call(h.deps, { action: 'status' }))).toMatchObject({
      state: 'connected',
      checked: false,
    });
    expect(h.store.connections.get(ROSS)?.status).toBe('active');
  });

  it('a stored token that does not open (the key changed) is broken, not "connected"', async () => {
    const h = harness();
    await connect(h, ROSS, {
      refreshTokenSealed: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const result = await call(h.deps, { action: 'status' });
    expect(body(result)).toMatchObject({ state: 'broken', reason: 'unreadable' });
    expect(h.google.calls).toHaveLength(0);
  });

  it('the database down is a 503, not "not connected"', async () => {
    const h = harness();
    h.store.failOnce.set('getConnection', new AppError('NETWORK', 'down'));
    const result = await call(h.deps, { action: 'status' });
    expect(result.status).toBe(503);
    expect(errorOf(result).retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------

/** Start a connection and come back from Google with a code. Returns the attempt id. */
async function startAndReturn(
  h: Harness,
  deps: DrivePageDeps = h.deps,
  params: Record<string, string> = {},
): Promise<string> {
  const started = await call(deps, { action: 'connect_start' });
  expect(started.status).toBe(200);
  const url = new URL(String(body(started)['authorizeUrl']));
  const state = url.searchParams.get('state') ?? '';
  const back = await handleDriveCallback(deps, { state, code: AUTH_CODE, ...params });
  expect(back.status).toBe(303);
  const location = back.status === 303 ? new URL(back.location) : null;
  return location?.searchParams.get('attempt') ?? '';
}

describe('connect_start and the callback', () => {
  it("stores the HASH of the state and a SEALED verifier, and hands back Google's address", async () => {
    const h = harness();
    const result = await call(h.deps, { action: 'connect_start' });
    const url = new URL(String(body(result)['authorizeUrl']));
    const state = url.searchParams.get('state') ?? '';
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [attempt] = [...h.store.attempts.values()];
    expect(attempt?.stateHash).toBe(await sha256Hex(state));
    expect(attempt?.verifierSealed).toMatch(/^v1\./);
    // The verifier opens only for this state, and its challenge is what Google was sent.
    const verifier = await open(
      key,
      attempt?.verifierSealed ?? '',
      SEALED_FOR.verifier(attempt?.stateHash ?? ''),
    );
    expect(verifier.ok).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(verifier.ok ? verifier.value : 'x');
    expect(attempt?.expiresAt).toBe(NOW + DRIVE_LIMITS.connectAttemptSeconds * 1_000);
  });

  it('a loop pressing Connect is stopped at five open attempts', async () => {
    const h = harness();
    for (let i = 0; i < DRIVE_LIMITS.maxOpenAttempts; i += 1) {
      expect((await call(h.deps, { action: 'connect_start' })).status).toBe(200);
    }
    const sixth = await call(h.deps, { action: 'connect_start' });
    expect(sixth.status).toBe(429);
    expect(errorOf(sixth).message).toMatch(/already open/);
  });

  it('the callback holds the code SEALED and sends him on to the app, exchanging nothing', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    expect(attempt).toMatch(/^a0000000-/);
    const held = h.store.attempts.get(attempt);
    expect(held?.codeSealed).toMatch(/^v1\./);
    expect(held?.codeSealed).not.toContain(AUTH_CODE);
    expect(callsTo(h.google, 'exchangeCode')).toHaveLength(0);
    expectNoSecrets(h.lines.join('\n'));
  });

  it("the callback answers with the app's own Settings address and nothing of Google's", async () => {
    const h = harness();
    const started = await call(h.deps, { action: 'connect_start' });
    const state = new URL(String(body(started)['authorizeUrl'])).searchParams.get('state') ?? '';
    const back = await handleDriveCallback(h.deps, {
      state,
      code: AUTH_CODE,
      scope: DRIVE_FILE_SCOPE,
    });
    expect(
      back.status === 303 && back.location.startsWith(`${APP}/settings?drive=returned&attempt=`),
    ).toBe(true);
    expect(back.status === 303 ? back.location : '').not.toContain(AUTH_CODE);
    expect(back.status === 303 ? back.location : '').not.toContain(state);
  });

  it.each([
    ['no state', {}],
    ['a malformed state', { state: 'short' }],
    ['a state nobody issued', { state: 'Z'.repeat(43) }],
  ])('%s changes nothing and lands as stale', async (_name, params) => {
    const h = harness();
    const back = await handleDriveCallback(h.deps, { code: AUTH_CODE, ...params });
    expect(back).toEqual({ status: 303, location: `${APP}/settings?drive=stale` });
  });

  it('the callback arriving TWICE: the second changes nothing and cannot replace the code', async () => {
    const h = harness();
    const started = await call(h.deps, { action: 'connect_start' });
    const state = new URL(String(body(started)['authorizeUrl'])).searchParams.get('state') ?? '';
    const first = await handleDriveCallback(h.deps, { state, code: AUTH_CODE });
    const held = [...h.store.attempts.values()][0]?.codeSealed;
    const second = await handleDriveCallback(h.deps, {
      state,
      code: 'another-code-from-an-attacker',
    });
    expect(first.status === 303 && first.location).toContain('drive=returned');
    expect(second).toEqual({ status: 303, location: `${APP}/settings?drive=stale` });
    expect([...h.store.attempts.values()][0]?.codeSealed).toBe(held);
  });

  it('a callback after the ten minutes is stale', async () => {
    const h = harness();
    const started = await call(h.deps, { action: 'connect_start' });
    const state = new URL(String(body(started)['authorizeUrl'])).searchParams.get('state') ?? '';
    h.clock.at += DRIVE_LIMITS.connectAttemptSeconds * 1_000 + 1;
    expect(await handleDriveCallback(h.deps, { state, code: AUTH_CODE })).toEqual({
      status: 303,
      location: `${APP}/settings?drive=stale`,
    });
  });

  it("Google's error is kept as a clean code", async () => {
    const h = harness();
    const started = await call(h.deps, { action: 'connect_start' });
    const state = new URL(String(body(started)['authorizeUrl'])).searchParams.get('state') ?? '';
    await handleDriveCallback(h.deps, { state, error: 'access_denied<script>' });
    expect([...h.store.attempts.values()][0]?.error).toBe('access_deniedscript');
  });

  it('the database down at the callback is stale, never an exception', async () => {
    const h = harness();
    h.store.failOnce.set('returnAttempt', new AppError('NETWORK', 'down'));
    expect(await handleDriveCallback(h.deps, { state: 'Q'.repeat(43), code: AUTH_CODE })).toEqual({
      status: 303,
      location: `${APP}/settings?drive=stale`,
    });
  });
});

// ---------------------------------------------------------------------------------------

describe('connect_finish', () => {
  it('turns the code into a connection: checked scope, named account, SEALED token (D123, D124)', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toEqual({
      action: 'connect_finish',
      outcome: 'connected',
      message: 'Google Drive is connected as broker@example.com.',
      note: null,
    });
    const [code, verifier] = callsTo(h.google, 'exchangeCode')[0] ?? [];
    expect(code).toBe(AUTH_CODE);
    expect(String(verifier)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const row = h.store.connections.get(ROSS);
    expect(row).toMatchObject({
      googleAccountId: 'perm-ross-0001',
      googleEmail: 'broker@example.com',
      status: 'active',
    });
    expect(row?.refreshTokenSealed).not.toContain(REFRESH_TOKEN);
    const opened = await open(
      key,
      row?.refreshTokenSealed ?? '',
      SEALED_FOR.refreshToken(ROSS, row?.tokenId ?? ''),
    );
    expect(opened.ok && opened.value).toBe(REFRESH_TOKEN);
    expect(h.store.audit.at(-1)).toEqual({
      action: 'DRIVE_CONNECTED',
      userId: ROSS,
      after: { replaced: false, same_account: false },
    });
    expect(callsTo(h.google, 'revoke')).toHaveLength(0);
    expectNoSecrets(visible(h, [result]));
  });

  it("he cancels at Google's consent screen: nothing is exchanged, nothing is stored", async () => {
    const h = harness();
    const started = await call(h.deps, { action: 'connect_start' });
    const state = new URL(String(body(started)['authorizeUrl'])).searchParams.get('state') ?? '';
    const back = await handleDriveCallback(h.deps, { state, error: 'access_denied' });
    const attempt =
      back.status === 303 ? (new URL(back.location).searchParams.get('attempt') ?? '') : '';
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'cancelled' });
    expect(String(body(result)['message'])).toMatch(/You cancelled at Google/);
    expect(callsTo(h.google, 'exchangeCode')).toHaveLength(0);
    expect(h.store.connections.size).toBe(0);
  });

  it("another refusal from Google is said with Google's own code", async () => {
    const h = harness();
    const started = await call(h.deps, { action: 'connect_start' });
    const state = new URL(String(body(started)['authorizeUrl'])).searchParams.get('state') ?? '';
    const back = await handleDriveCallback(h.deps, { state, error: 'admin_policy_enforced' });
    const attempt =
      back.status === 303 ? (new URL(back.location).searchParams.get('attempt') ?? '') : '';
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'google_refused' });
    expect(String(body(result)['message'])).toContain('admin_policy_enforced');
  });

  it('FINISHED BY A DIFFERENT SIGNED-IN PERSON: refused, never exchanged, and the attempt is spent', async () => {
    // The attack D123 closes: a colleague starts a flow, gets Ross to approve it in his browser,
    // and would otherwise receive Ross's Drive.
    const h = harness(COLLEAGUE);
    const attempt = await startAndReturn(h, as(h, COLLEAGUE));
    const stolen = await call(as(h, ROSS), { action: 'connect_finish', attempt });
    expect(body(stolen)).toMatchObject({ outcome: 'wrong_user' });
    expect(callsTo(h.google, 'exchangeCode')).toHaveLength(0);
    expect(h.store.connections.size).toBe(0);
    // …and the attempt cannot be finished afterwards by anyone.
    const late = await call(as(h, COLLEAGUE), { action: 'connect_finish', attempt });
    expect(body(late)).toMatchObject({ outcome: 'stale' });
  });

  it('a finish replayed after it succeeded is stale and changes nothing', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    await call(h.deps, { action: 'connect_finish', attempt });
    const tokenId = h.store.connections.get(ROSS)?.tokenId;
    const again = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(again)).toMatchObject({ outcome: 'stale' });
    expect(h.store.connections.get(ROSS)?.tokenId).toBe(tokenId);
    expect(callsTo(h.google, 'exchangeCode')).toHaveLength(1);
  });

  it('a finish for an attempt that never came back from Google is stale', async () => {
    const h = harness();
    await call(h.deps, { action: 'connect_start' });
    const [attempt] = [...h.store.attempts.keys()];
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'stale',
    });
  });

  it('a finish after the ten minutes is stale (the code is never exchanged)', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.clock.at += DRIVE_LIMITS.connectAttemptSeconds * 1_000 + 1;
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'stale',
    });
    expect(callsTo(h.google, 'exchangeCode')).toHaveLength(0);
  });

  it.each([
    ['grant_invalid', 'stale'],
    ['unreachable', 'google_unreachable'],
    ['timeout', 'google_unreachable'],
  ] as const)('an exchange that fails with %s is %s', async (kind, outcome) => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.google.exchange = err({ kind });
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome,
    });
    expect(h.store.connections.size).toBe(0);
  });

  it('Google refusing OUR client configuration is a 500 and an error in the log', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.google.exchange = err({ kind: 'client_config' });
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(result.status).toBe(500);
    expect(
      h.lines.some((line) => line.includes('google refused the oauth client configuration')),
    ).toBe(true);
  });

  it('he unticked the Drive box: not connected, and the useless token is let go', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.google.exchange = ok({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      scope: 'openid',
    });
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'scope_missing' });
    expect(String(body(result)['message'])).toMatch(/leave the Drive box ticked/);
    expect(callsTo(h.google, 'revoke')).toEqual([[ACCESS_TOKEN]]);
    expect(h.store.connections.size).toBe(0);
  });

  it('…but NOT revoked when he is already connected: it would end that connection (D125)', async () => {
    const h = harness();
    const existing = await connect(h);
    const attempt = await startAndReturn(h);
    h.google.exchange = ok({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, scope: '' });
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'scope_missing',
    });
    expect(callsTo(h.google, 'revoke')).toHaveLength(0);
    expect(h.store.connections.get(ROSS)).toEqual(existing);
  });

  it('anything wider than drive.file is never kept: revoked, whatever it costs', async () => {
    const h = harness();
    await connect(h);
    const attempt = await startAndReturn(h);
    h.google.exchange = ok({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly`,
    });
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'scope_wider' });
    expect(callsTo(h.google, 'revoke')).toEqual([[ACCESS_TOKEN]]);
    expect(h.store.connections.get(ROSS)?.grantedScope).toBe(DRIVE_FILE_SCOPE);
  });

  it('no lasting access granted: not connected, and the token is let go', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.google.exchange = ok({
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      scope: DRIVE_FILE_SCOPE,
    });
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'no_lasting_access',
    });
    expect(callsTo(h.google, 'revoke')).toEqual([[ACCESS_TOKEN]]);
  });

  it('the account cannot be named: not connected, and the new grant is let go', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.google.account = err({ kind: 'unreachable' });
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'google_unreachable',
    });
    expect(callsTo(h.google, 'revoke')).toEqual([[REFRESH_TOKEN]]);
    expect(h.store.connections.size).toBe(0);
  });

  it('A SECOND GOOGLE ACCOUNT over the first: the first is revoked at Google, then replaced', async () => {
    const h = harness();
    const oldToken = ['1', '//', '0old', 'O'.repeat(70)].join('');
    const first = await connect(h, ROSS, {}, oldToken);
    const attempt = await startAndReturn(h);
    h.google.account = ok({
      email: 'ross.personal@example.com',
      permissionId: 'perm-ross-PERSONAL',
    });
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({
      outcome: 'connected',
      message: 'Google Drive is connected as ross.personal@example.com.',
    });
    expect(callsTo(h.google, 'revoke')).toEqual([[oldToken]]);
    const row = h.store.connections.get(ROSS);
    expect(row?.googleAccountId).toBe('perm-ross-PERSONAL');
    expect(row?.tokenId).not.toBe(first.tokenId);
    expect(h.store.audit.at(-1)?.after).toEqual({ replaced: true, same_account: false });
    expectNoSecrets(visible(h, [result]), [oldToken]);
  });

  it("THE SAME account again: the old token is NOT revoked — it shares the new one's grant (D125)", async () => {
    const h = harness();
    await connect(h);
    const attempt = await startAndReturn(h);
    const newRefresh = ['1', '//', '0new', 'N'.repeat(70)].join('');
    h.google.exchange = ok({
      accessToken: ACCESS_TOKEN,
      refreshToken: newRefresh,
      scope: DRIVE_FILE_SCOPE,
    });
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'connected',
    });
    expect(callsTo(h.google, 'revoke')).toHaveLength(0);
    const row = h.store.connections.get(ROSS);
    const opened = await open(
      key,
      row?.refreshTokenSealed ?? '',
      SEALED_FOR.refreshToken(ROSS, row?.tokenId ?? ''),
    );
    expect(opened.ok && opened.value).toBe(newRefresh);
    expect(h.store.audit.at(-1)?.after).toEqual({ replaced: true, same_account: true });
  });

  it('switching accounts when Google will not revoke the old one: nothing changes, the new grant goes', async () => {
    const h = harness();
    const first = await connect(h);
    const attempt = await startAndReturn(h);
    h.google.account = ok({ email: 'other@example.com', permissionId: 'perm-OTHER' });
    h.google.revokes = [err({ kind: 'unreachable' }), ok('revoked')];
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'switch_failed' });
    expect(callsTo(h.google, 'revoke')).toEqual([[REFRESH_TOKEN], [REFRESH_TOKEN]]);
    expect(h.store.connections.get(ROSS)).toEqual(first);
  });

  it('switching accounts when the old token cannot be opened: connected, and told to check Google', async () => {
    const h = harness();
    await connect(h, ROSS, {
      refreshTokenSealed: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const attempt = await startAndReturn(h);
    h.google.account = ok({ email: 'other@example.com', permissionId: 'perm-OTHER' });
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'connected', note: SWITCH_LEFTOVER_NOTE });
  });

  it('another Connect landing in between (a different account): this one changes nothing, its grant goes', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    const other = await seal(key, 'x', 'y');
    h.store.beforeSave = () => {
      h.store.connections.set(ROSS, {
        userId: ROSS,
        tokenId: 'b9999999-0000-4000-8000-000000000000',
        googleAccountId: 'perm-SOMEONE-ELSE',
        googleEmail: 'else@example.com',
        refreshTokenSealed: other,
        grantedScope: DRIVE_FILE_SCOPE,
        status: 'active',
        brokenReason: null,
        brokenAt: null,
        connectedAt: new Date(NOW).toISOString(),
        lastUsedAt: null,
      });
    };
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(body(result)).toMatchObject({ outcome: 'changed' });
    expect(callsTo(h.google, 'revoke')).toEqual([[REFRESH_TOKEN]]);
    expect(h.store.connections.get(ROSS)?.googleAccountId).toBe('perm-SOMEONE-ELSE');
  });

  it('another Connect landing in between (the same account): kept, never revoked', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    const sealedOther = await seal(key, 'x', 'y');
    h.store.beforeSave = () => {
      h.store.connections.set(ROSS, {
        userId: ROSS,
        tokenId: 'b9999999-0000-4000-8000-000000000001',
        googleAccountId: 'perm-ross-0001',
        googleEmail: 'broker@example.com',
        refreshTokenSealed: sealedOther,
        grantedScope: DRIVE_FILE_SCOPE,
        status: 'active',
        brokenReason: null,
        brokenAt: null,
        connectedAt: new Date(NOW).toISOString(),
        lastUsedAt: null,
      });
    };
    expect(body(await call(h.deps, { action: 'connect_finish', attempt }))).toMatchObject({
      outcome: 'changed',
    });
    expect(callsTo(h.google, 'revoke')).toHaveLength(0);
  });

  it('the database failing at the save: 503, and a grant with no row behind it is let go', async () => {
    const h = harness();
    const attempt = await startAndReturn(h);
    h.store.failOnce.set('saveConnection', new AppError('NETWORK', 'down'));
    const result = await call(h.deps, { action: 'connect_finish', attempt });
    expect(result.status).toBe(503);
    expect(callsTo(h.google, 'revoke')).toEqual([[REFRESH_TOKEN]]);
  });

  it('TWO PEOPLE connect their own Drives: two rows, each sealed for its own person', async () => {
    const h = harness();
    const rossAttempt = await startAndReturn(h, as(h, ROSS));
    await call(as(h, ROSS), { action: 'connect_finish', attempt: rossAttempt });
    const colleagueRefresh = ['1', '//', '0col', 'K'.repeat(70)].join('');
    h.google.exchange = ok({
      accessToken: ACCESS_TOKEN,
      refreshToken: colleagueRefresh,
      scope: DRIVE_FILE_SCOPE,
    });
    h.google.account = ok({ email: 'colleague@example.com', permissionId: 'perm-colleague' });
    const colleagueAttempt = await startAndReturn(h, as(h, COLLEAGUE));
    await call(as(h, COLLEAGUE), { action: 'connect_finish', attempt: colleagueAttempt });

    const ross = h.store.connections.get(ROSS);
    const colleague = h.store.connections.get(COLLEAGUE);
    expect([ross?.googleEmail, colleague?.googleEmail]).toEqual([
      'broker@example.com',
      'colleague@example.com',
    ]);
    // Each seal opens only as its owner's: moving a ciphertext to the other row does not work.
    expect(
      (
        await open(
          key,
          colleague?.refreshTokenSealed ?? '',
          SEALED_FOR.refreshToken(ROSS, ross?.tokenId ?? ''),
        )
      ).ok,
    ).toBe(false);
    expect(callsTo(h.google, 'revoke')).toHaveLength(0);
    // …and each person's status is their own.
    expect(body(await call(as(h, COLLEAGUE), { action: 'status' }))).toMatchObject({
      email: 'colleague@example.com',
    });
  });
});

// ---------------------------------------------------------------------------------------

describe("disconnect (revoke at Google, THEN delete — the brief's boundary)", () => {
  it('revokes the stored refresh token at Google, then deletes the row', async () => {
    const h = harness();
    await connect(h);
    const result = await call(h.deps, { action: 'disconnect' });
    expect(body(result)).toMatchObject({ action: 'disconnect', disconnected: true });
    expect(String(body(result)['message'])).toMatch(/Google has removed this app's access/);
    expect(String(body(result)['message'])).toMatch(
      /stay there until they are removed, or for 30 days/,
    );
    expect(callsTo(h.google, 'revoke')).toEqual([[REFRESH_TOKEN]]);
    expect(h.store.connections.has(ROSS)).toBe(false);
    expect(h.store.audit.at(-1)?.action).toBe('DRIVE_DISCONNECTED');
    expectNoSecrets(visible(h, [result]));
  });

  it('a grant Google had already let go of is deleted too: that is the outcome he asked for', async () => {
    const h = harness();
    await connect(h);
    h.google.revokes = [ok('already_gone')];
    expect(body(await call(h.deps, { action: 'disconnect' }))).toMatchObject({
      disconnected: true,
    });
    expect(h.store.connections.has(ROSS)).toBe(false);
  });

  it('Google unreachable: the row is KEPT and he is told Drive is still connected', async () => {
    const h = harness();
    const row = await connect(h);
    h.google.revokes = [err({ kind: 'unreachable' })];
    const result = await call(h.deps, { action: 'disconnect' });
    expect(result.status).toBe(503);
    expect(errorOf(result).message).toMatch(/still connected/);
    expect(h.store.connections.get(ROSS)).toEqual(row);
  });

  it('nothing to disconnect is said as such', async () => {
    const h = harness();
    expect(body(await call(h.deps, { action: 'disconnect' }))).toMatchObject({
      disconnected: false,
    });
    expect(h.google.calls).toHaveLength(0);
  });

  it('a token that cannot be opened: removed here, and he is told where to finish it at Google', async () => {
    const h = harness();
    await connect(h, ROSS, {
      refreshTokenSealed: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const result = await call(h.deps, { action: 'disconnect' });
    expect(body(result)).toMatchObject({ disconnected: true });
    expect(String(body(result)['message'])).toContain('https://myaccount.google.com/connections');
    expect(callsTo(h.google, 'revoke')).toHaveLength(0);
    expect(h.store.connections.has(ROSS)).toBe(false);
  });

  it('revoked at Google but the delete fails: 503 (the next status check will mark the dead token)', async () => {
    const h = harness();
    await connect(h);
    h.store.failOnce.set('deleteConnection', new AppError('NETWORK', 'down'));
    expect((await call(h.deps, { action: 'disconnect' })).status).toBe(503);
  });

  it("one person's disconnect never touches another's connection", async () => {
    const h = harness();
    await connect(h, ROSS);
    const colleague = await connect(h, COLLEAGUE, { googleAccountId: 'perm-colleague' });
    await call(as(h, ROSS), { action: 'disconnect' });
    expect(h.store.connections.get(COLLEAGUE)).toEqual(colleague);
  });
});

// ---------------------------------------------------------------------------------------

const DOCX = new TextEncoder().encode('PK\u0003\u0004 a docx');
const XLSX = new TextEncoder().encode('PK\u0003\u0004 an xlsx');
const PDF = new TextEncoder().encode('%PDF-1.7 a pdf');

async function read(
  h: Harness,
  fileId: string,
  deps: DrivePageDeps = h.deps,
  id: string = requestId(),
): Promise<DrivePageResult> {
  return call(deps, { action: 'read_file', requestId: id, fileId });
}

function readReply(result: DrivePageResult): DriveReadReply & { bytes: Uint8Array } {
  if (!('bytes' in result)) throw new Error(`not a read: ${JSON.stringify(result.body)}`);
  return { ...result.body, bytes: result.bytes };
}

describe('read_file: the connection', () => {
  it('not connected: 409 with the way back, and Google is never asked', async () => {
    const h = harness();
    const result = await read(h, 'PdfFileId0001');
    expect(result.status).toBe(409);
    expect(errorOf(result)).toMatchObject({ code: 'NOT_CONNECTED' });
    expect(errorOf(result).message).toMatch(/Connect it in Settings/);
    expect(h.google.calls).toHaveLength(0);
  });

  it('a connection already broken: 409 CONNECTION_BROKEN, in words', async () => {
    const h = harness();
    await connect(h, ROSS, {
      status: 'broken',
      brokenReason: 'grant_revoked',
      brokenAt: '2026-10-15T00:00:00.000Z',
    });
    const result = await read(h, 'PdfFileId0001');
    expect(errorOf(result)).toMatchObject({ code: 'CONNECTION_BROKEN' });
    expect(errorOf(result).message).toMatch(/no longer connected/);
  });

  it('THE REFRESH TOKEN REJECTED on a later read: marked broken, said, and the read recorded as failed', async () => {
    const h = harness();
    await connect(h);
    h.google.refreshes = [err({ kind: 'grant_invalid' })];
    const id = requestId();
    const result = await read(h, 'PdfFileId0001', h.deps, id);
    expect(errorOf(result)).toMatchObject({ code: 'CONNECTION_BROKEN' });
    expect(h.store.connections.get(ROSS)).toMatchObject({
      status: 'broken',
      brokenReason: 'grant_revoked',
    });
    expect(h.store.reads.get(id)).toMatchObject({ status: 'failed', outcome: 'connection_broken' });
  });

  it('access REVOKED FROM HIS GOOGLE ACCOUNT between the refresh and the read (a 401): broken', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', err({ kind: 'unauthorized' }));
    const result = await read(h, 'PdfFileId0001');
    expect(errorOf(result)).toMatchObject({ code: 'CONNECTION_BROKEN' });
    expect(h.store.connections.get(ROSS)).toMatchObject({
      status: 'broken',
      brokenReason: 'access_lost',
    });
  });

  it('DISCONNECTED WHILE A READ IS IN FLIGHT: the bytes are not handed over', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', ok(pdfMeta()));
    h.google.content.set('PdfFileId0001', ok({ bytes: PDF, contentType: 'application/pdf' }));
    h.google.beforeContent = async () => {
      const disconnected = await call(h.deps, { action: 'disconnect' });
      expect(body(disconnected)).toMatchObject({ disconnected: true });
    };
    const result = await read(h, 'PdfFileId0001');
    expect('bytes' in result).toBe(false);
    expect(result.status).toBe(409);
    expect(errorOf(result)).toMatchObject({ code: 'NOT_CONNECTED' });
    expect(h.lines.some((line) => line.includes('disconnected_in_flight'))).toBe(true);
  });

  it('a read whose id was already used opens nothing (one id reads one file, once)', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', ok(pdfMeta()));
    h.google.content.set('PdfFileId0001', ok({ bytes: PDF, contentType: 'application/pdf' }));
    const id = requestId();
    expect((await read(h, 'PdfFileId0001', h.deps, id)).status).toBe(200);
    const again = await read(h, 'PdfFileId0001', h.deps, id);
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'READ_EXPIRED', retryable: true });
    expect(callsTo(h.google, 'readContent')).toHaveLength(1);
  });

  it('more than twenty reads in a minute is "wait a moment"', async () => {
    const h = harness();
    await connect(h);
    for (let i = 0; i < DRIVE_LIMITS.readsPerMinute; i += 1) await read(h, 'MissingFile001');
    const result = await read(h, 'MissingFile001');
    expect(result.status).toBe(429);
    expect(errorOf(result).message).toMatch(/a lot of files from Drive in one minute/);
  });

  it('a file id that is not one is refused before anything is recorded', async () => {
    const h = harness();
    await connect(h);
    const result = await read(h, '../../etc/passwd');
    expect(result.status).toBe(400);
    expect(h.store.reads.size).toBe(0);
  });
});

describe('read_file: the file (A1 and Part C)', () => {
  beforeEach(() => {
    requests = 0;
  });

  it.each([
    [
      'a Google Doc',
      'application/vnd.google-apps.document',
      'Rate sheet.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Google Doc',
      DOCX,
      'google_doc',
    ],
    [
      'a Google Sheet',
      'application/vnd.google-apps.spreadsheet',
      'Rate sheet.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Google Sheet',
      XLSX,
      'google_sheet',
    ],
    [
      'a Google Slides deck',
      'application/vnd.google-apps.presentation',
      'Rate sheet.pdf',
      'application/pdf',
      'Google Slides deck',
      PDF,
      'google_slides',
    ],
  ])(
    '%s is exported, recorded and handed over',
    async (_name, mimeType, fileName, exportedAs, googleType, bytes, group) => {
      const h = harness();
      await connect(h);
      h.google.files.set(
        'GoogleFile0001',
        ok(pdfMeta({ id: 'GoogleFile0001', name: 'Rate sheet', mimeType, size: null })),
      );
      h.google.content.set('GoogleFile0001', ok({ bytes, contentType: 'application/zip' }));
      const id = requestId();
      const result = await read(h, 'GoogleFile0001', h.deps, id);
      const reply = readReply(result);
      expect(reply).toMatchObject({
        action: 'read_file',
        readId: id,
        name: 'Rate sheet',
        fileName,
        contentType: exportedAs,
        byteSize: bytes.length,
        googleType,
        fileId: 'GoogleFile0001',
      });
      expect(reply.bytes).toEqual(bytes);
      expect(reply.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const plan = callsTo(h.google, 'readContent')[0]?.[2] as {
        kind: string;
        format: { mimeType: string };
      };
      expect(plan).toMatchObject({ kind: 'export', format: { mimeType: exportedAs } });
      expect(h.store.reads.get(id)).toMatchObject({
        status: 'fetched',
        name: 'Rate sheet',
        googleMime: mimeType,
        exportedAs,
        byteSize: bytes.length,
        contentHash: reply.contentHash,
      });
      const line = h.lines.find((l) => l.includes('"drive file read"')) ?? '';
      expect(JSON.parse(line)).toMatchObject({
        readId: id,
        type: group,
        exported: true,
        bytes: bytes.length,
        outcome: 'fetched',
      });
      expect(JSON.parse(line)).toHaveProperty('ms');
    },
  );

  it.each([
    ['a PDF', 'application/pdf', 'pdf'],
    [
      'a Word file',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'word',
    ],
    ['an Excel file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'excel'],
    ['a CSV', 'text/csv', 'csv'],
    ['an image', 'image/jpeg', 'image'],
    ['a plain text file', 'text/plain', 'text'],
  ])('%s is downloaded as it is and left to the readers', async (_name, mimeType, group) => {
    const h = harness();
    await connect(h);
    h.google.files.set(
      'OrdinaryFile01',
      ok(pdfMeta({ id: 'OrdinaryFile01', name: 'statement', mimeType })),
    );
    h.google.content.set('OrdinaryFile01', ok({ bytes: PDF, contentType: mimeType }));
    const reply = readReply(await read(h, 'OrdinaryFile01'));
    expect(reply).toMatchObject({ fileName: 'statement', contentType: mimeType, googleType: null });
    expect(callsTo(h.google, 'readContent')[0]?.[2]).toEqual({ kind: 'download' });
    const line = h.lines.find((l) => l.includes('"drive file read"')) ?? '';
    expect(JSON.parse(line)).toMatchObject({ type: group, exported: false });
  });

  it.each([
    [
      'a Google Form',
      pdfMeta({ mimeType: 'application/vnd.google-apps.form', size: null }),
      'drive_google_type',
      /That is a Google Form, which can't be read/,
    ],
    [
      'a folder',
      pdfMeta({ mimeType: 'application/vnd.google-apps.folder', size: null }),
      'drive_folder',
      /That is a folder/,
    ],
    ['a file in the bin', pdfMeta({ trashed: true }), 'drive_in_bin', /in your Google Drive bin/],
    [
      'a file whose owner blocked downloads',
      pdfMeta({ canDownload: false }),
      'drive_download_blocked',
      /turned off downloading/,
    ],
    ['a zero-byte file', pdfMeta({ size: 0 }), 'empty', /empty \(0 bytes\)/],
    [
      'a file over the 20 MB limit',
      pdfMeta({ size: 25 * 1024 * 1024 }),
      'too_large',
      /25\.0 MB, which is over the 20 MB limit/,
    ],
  ])(
    '%s is refused with a clear sentence, and nothing is downloaded',
    async (_name, meta, refusal, words) => {
      const h = harness();
      await connect(h);
      h.google.files.set('PdfFileId0001', ok(meta));
      const id = requestId();
      const result = await read(h, 'PdfFileId0001', h.deps, id);
      expect(result.status).toBe(422);
      expect(errorOf(result)).toMatchObject({ code: 'DRIVE_REFUSED', refusal, retryable: false });
      expect(errorOf(result).message).toMatch(words);
      expect(callsTo(h.google, 'readContent')).toHaveLength(0);
      expect(h.store.reads.get(id)).toMatchObject({ status: 'refused', outcome: refusal });
    },
  );

  it('A SHORTCUT is followed to the file it points at, once', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set(
      'ShortcutFile01',
      ok(
        pdfMeta({
          id: 'ShortcutFile01',
          name: 'Rate sheet (shortcut)',
          mimeType: 'application/vnd.google-apps.shortcut',
          size: null,
          shortcutTargetId: 'TargetDocFile1',
          shortcutTargetMimeType: 'application/vnd.google-apps.document',
        }),
      ),
    );
    h.google.files.set(
      'TargetDocFile1',
      ok(
        pdfMeta({
          id: 'TargetDocFile1',
          name: 'Rate sheet',
          mimeType: 'application/vnd.google-apps.document',
          size: null,
        }),
      ),
    );
    h.google.content.set('TargetDocFile1', ok({ bytes: DOCX, contentType: null }));
    const reply = readReply(await read(h, 'ShortcutFile01'));
    expect(reply).toMatchObject({
      fileId: 'TargetDocFile1',
      name: 'Rate sheet',
      fileName: 'Rate sheet.docx',
    });
    expect(callsTo(h.google, 'getFile').map((args) => args[1])).toEqual([
      'ShortcutFile01',
      'TargetDocFile1',
    ]);
    expect(JSON.parse(h.lines.find((l) => l.includes('"drive file read"')) ?? '{}')).toMatchObject({
      viaShortcut: true,
    });
  });

  it('a shortcut whose file was never opened through the app is refused, pointing at the original', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set(
      'ShortcutFile01',
      ok(
        pdfMeta({
          mimeType: 'application/vnd.google-apps.shortcut',
          size: null,
          shortcutTargetId: 'TargetDocFile1',
          shortcutTargetMimeType: 'application/pdf',
        }),
      ),
    );
    h.google.files.set('TargetDocFile1', err({ kind: 'no_access' }));
    const result = await read(h, 'ShortcutFile01');
    expect(errorOf(result)).toMatchObject({ refusal: 'drive_shortcut_target' });
    expect(errorOf(result).message).toMatch(/Pick the original file/);
  });

  it('a shortcut to a shortcut is not followed again', async () => {
    const h = harness();
    await connect(h);
    const shortcut = { mimeType: 'application/vnd.google-apps.shortcut', size: null } as const;
    h.google.files.set(
      'ShortcutFile01',
      ok(pdfMeta({ ...shortcut, shortcutTargetId: 'ShortcutFile02' })),
    );
    h.google.files.set(
      'ShortcutFile02',
      ok(pdfMeta({ ...shortcut, id: 'ShortcutFile02', shortcutTargetId: 'ShortcutFile01' })),
    );
    expect(errorOf(await read(h, 'ShortcutFile01'))).toMatchObject({
      refusal: 'drive_shortcut_target',
    });
    expect(callsTo(h.google, 'getFile')).toHaveLength(2);
  });

  it.each([
    ['DELETED (Drive says not found)', 'not_found'],
    ['never opened through this app', 'no_access'],
  ] as const)(
    'a file %s is "no longer in your Drive, or not given access — pick it again"',
    async (_name, kind) => {
      const h = harness();
      await connect(h);
      h.google.files.set('PdfFileId0001', err({ kind }));
      const result = await read(h, 'PdfFileId0001');
      expect(errorOf(result)).toMatchObject({ refusal: 'drive_file_gone' });
      expect(errorOf(result).message).toMatch(/Pick it again from Drive/);
    },
  );

  it("a file RENAMED between picking and reading takes Drive's name at the moment it is read", async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', ok(pdfMeta({ name: 'Renamed in Drive.pdf' })));
    h.google.content.set('PdfFileId0001', ok({ bytes: PDF, contentType: 'application/pdf' }));
    const id = requestId();
    const reply = readReply(await read(h, 'PdfFileId0001', h.deps, id));
    expect(reply.name).toBe('Renamed in Drive.pdf');
    expect(h.store.reads.get(id)?.name).toBe('Renamed in Drive.pdf');
  });

  it('a file in a SHARED DRIVE, or shared with him and not his own, is read the same way', async () => {
    // Drive answers files.get the same for both when the app was given the file; what makes
    // the difference is `supportsAllDrives=true` on every call, asserted in google.test.ts.
    const h = harness();
    await connect(h);
    h.google.files.set(
      'SharedDrive001',
      ok(pdfMeta({ id: 'SharedDrive001', name: 'Team rate card.pdf' })),
    );
    h.google.content.set('SharedDrive001', ok({ bytes: PDF, contentType: 'application/pdf' }));
    expect(readReply(await read(h, 'SharedDrive001')).name).toBe('Team rate card.pdf');
  });

  it("an export over Google's 10 MB is refused with its own sentence", async () => {
    const h = harness();
    await connect(h);
    h.google.files.set(
      'GoogleFile0001',
      ok(
        pdfMeta({
          id: 'GoogleFile0001',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          size: null,
        }),
      ),
    );
    h.google.content.set('GoogleFile0001', err({ kind: 'export_too_large' }));
    const result = await read(h, 'GoogleFile0001');
    expect(errorOf(result)).toMatchObject({ refusal: 'drive_export_too_large' });
    expect(errorOf(result).message).toMatch(/at most 10 MB/);
  });

  it('a body that turns out over the limit is refused, and one that turns out empty too', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', ok(pdfMeta({ size: null })));
    h.google.content.set('PdfFileId0001', err({ kind: 'too_large', received: 21 * 1024 * 1024 }));
    expect(errorOf(await read(h, 'PdfFileId0001'))).toMatchObject({ refusal: 'too_large' });
    h.google.content.set('PdfFileId0001', ok({ bytes: new Uint8Array(0), contentType: null }));
    expect(errorOf(await read(h, 'PdfFileId0001'))).toMatchObject({ refusal: 'empty' });
  });

  it("a Workspace administrator's block is said as such", async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', err({ kind: 'domain_policy' }));
    expect(errorOf(await read(h, 'PdfFileId0001')).message).toMatch(/Workspace administrator/);
  });

  it.each([
    ['busy (429 / 403 rate limit)', 'busy', 429, /busy right now/],
    ['unreachable (5xx)', 'unreachable', 502, /could not be reached/],
    ['slow (timeout)', 'timeout', 504, /took too long/],
    ['answering nonsense', 'bad_response', 502, /could not be reached/],
  ] as const)(
    'Google %s: retryable, in words, and recorded as failed',
    async (_name, kind, status, words) => {
      const h = harness();
      await connect(h);
      h.google.files.set('PdfFileId0001', ok(pdfMeta()));
      h.google.content.set('PdfFileId0001', err({ kind }));
      const id = requestId();
      const result = await read(h, 'PdfFileId0001', h.deps, id);
      expect(result.status).toBe(status);
      expect(errorOf(result)).toMatchObject({ code: 'DRIVE_NOT_READ', retryable: true });
      expect(errorOf(result).message).toMatch(words);
      expect(h.store.reads.get(id)).toMatchObject({ status: 'failed' });
      expect(h.store.connections.get(ROSS)?.status).toBe('active');
    },
  );

  it('the token refresh failing for a moment is retryable too, and does not break the connection', async () => {
    const h = harness();
    await connect(h);
    h.google.refreshes = [err({ kind: 'unreachable' })];
    const result = await read(h, 'PdfFileId0001');
    expect(result.status).toBe(502);
    expect(h.store.connections.get(ROSS)?.status).toBe('active');
  });

  it('TWO FILES PICKED AT ONCE are two reads, two records, both handed over', async () => {
    const h = harness();
    await connect(h);
    for (const id of ['FirstFile00001', 'SecondFile0001']) {
      h.google.files.set(id, ok(pdfMeta({ id, name: `${id}.pdf` })));
      h.google.content.set(id, ok({ bytes: PDF, contentType: 'application/pdf' }));
    }
    const [one, two] = await Promise.all([read(h, 'FirstFile00001'), read(h, 'SecondFile0001')]);
    expect([readReply(one).name, readReply(two).name]).toEqual([
      'FirstFile00001.pdf',
      'SecondFile0001.pdf',
    ]);
    expect([...h.store.reads.values()].filter((row) => row.status === 'fetched')).toHaveLength(2);
  });

  it('THE SAME FILE PICKED TWICE: two reads of the same bytes, the same hash (begin attaches it once)', async () => {
    const h = harness();
    await connect(h);
    h.google.files.set('PdfFileId0001', ok(pdfMeta()));
    h.google.content.set('PdfFileId0001', ok({ bytes: PDF, contentType: 'application/pdf' }));
    const one = readReply(await read(h, 'PdfFileId0001'));
    const two = readReply(await read(h, 'PdfFileId0001'));
    expect(one.readId).not.toBe(two.readId);
    expect(one.contentHash).toBe(two.contentHash);
  });

  it('a read costs no model call at all: the endpoint has no Claude client to spend with', () => {
    // The spend cap applies where money is spent: a scanned page from Drive is read by the
    // files endpoint's read_page, under the same cap as an upload (tests/unit/files/page.test.ts).
    const h = harness();
    expect(Object.keys(h.deps).sort()).toEqual(['drive', 'log', 'newId', 'now', 'verify']);
  });

  it("NEVER the file's name, content or any token in a log line or an error", async () => {
    const h = harness();
    await connect(h);
    const canaryBytes = new TextEncoder().encode('%PDF-1.7 CANARY-CONTENT-7f3a91-net-pay');
    h.google.files.set('PdfFileId0001', ok(pdfMeta({ name: CANARY_NAME })));
    h.google.content.set(
      'PdfFileId0001',
      ok({ bytes: canaryBytes, contentType: 'application/pdf' }),
    );
    h.google.files.set(
      'PdfFileId0002',
      ok(pdfMeta({ id: 'PdfFileId0002', name: CANARY_NAME, trashed: true })),
    );
    const results = [await read(h, 'PdfFileId0001'), await read(h, 'PdfFileId0002')];
    const logs = h.lines.join('\n');
    expect(logs).not.toContain('CANARY-NAME');
    expect(logs).not.toContain('CANARY-CONTENT');
    expect(JSON.stringify(results[1]?.body)).not.toContain('CANARY-NAME');
    expectNoSecrets(logs);
  });
});

describe('picked', () => {
  it('logs how many files were picked, and nothing about them', async () => {
    const h = harness();
    const result = await call(h.deps, { action: 'picked', count: 2 });
    expect(body(result)).toEqual({ action: 'picked', logged: true });
    expect(JSON.parse(h.lines.find((l) => l.includes('drive files picked')) ?? '{}')).toMatchObject(
      { count: 2, userId: ROSS },
    );
  });

  it('refuses a count of zero or more than fifty', async () => {
    const h = harness();
    expect((await call(h.deps, { action: 'picked', count: 0 })).status).toBe(400);
    expect((await call(h.deps, { action: 'picked', count: 51 })).status).toBe(400);
  });
});
