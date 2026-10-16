/**
 * The calls to Google (src/lib/drive/google.ts), against a fake Google behind fetch serving the
 * shapes in tests/fixtures/google: what each call SENDS (and that nothing secret is in a URL),
 * how each ANSWER is read, which failures are retried — busy and down, with backoff — and which
 * never are: turning a code into tokens. The Part C rows "Google returns 401, 403, 429 and
 * 5xx" and "the export takes long enough to matter" are here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReadPlan } from '../../../src/lib/drive/formats.js';
import {
  GOOGLE_ENDPOINTS,
  checkGrantedScope,
  createGoogleClient,
  driveFailure,
  grantedScopes,
  googleReason,
  tokenFailure,
  type GoogleClient,
  type GoogleConfig,
} from '../../../src/lib/drive/google.js';
import { DRIVE_FILE_SCOPE, DRIVE_LIMITS } from '../../../src/lib/drive/limits.js';
import { HttpStatusError, NetworkError, TimeoutError } from '../../../src/lib/errors.js';
import { createHttpClient } from '../../../src/lib/http.js';
import { createLogger } from '../../../src/lib/logger.js';
import {
  ACCESS_TOKEN,
  AUTH_CODE,
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  fixtureText,
  googleServer,
  json,
  type SeenRequest,
} from './helpers.js';

const CONFIG: GoogleConfig = {
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: 'https://project.supabase.co/functions/v1/drive/callback',
  responseMode: 'form_post',
};

const TOKENS = { TEST_ACCESS_TOKEN: ACCESS_TOKEN, TEST_REFRESH_TOKEN: REFRESH_TOKEN };
const silent = createLogger({ level: 'silent' });

function client(
  route: (request: SeenRequest, index: number) => Response | Promise<Response>,
  config: GoogleConfig = CONFIG,
): { google: GoogleClient; seen: SeenRequest[]; slept: number[] } {
  const server = googleServer(route);
  const slept: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    slept.push(ms);
    return Promise.resolve();
  };
  const http = createHttpClient({
    fetch: server.fetch,
    retries: 2,
    sleep,
    random: () => 0.5,
    logger: silent,
  });
  return {
    google: createGoogleClient({ config, http, sleep, random: () => 0.5 }),
    seen: server.seen,
    slept,
  };
}

const EXPORT_DOCX: Extract<ReadPlan, { kind: 'export' }> = {
  kind: 'export',
  format: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  },
};

describe('authorizeUrl', () => {
  it('asks for drive.file and nothing else, lasting access, consent, PKCE and form_post', () => {
    const { google } = client(() => json({}));
    const url = new URL(
      google.authorizeUrl({ state: 'S'.repeat(43), codeChallenge: 'C'.repeat(43) }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_ENDPOINTS.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: CONFIG.redirectUri,
      response_type: 'code',
      scope: DRIVE_FILE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state: 'S'.repeat(43),
      code_challenge: 'C'.repeat(43),
      code_challenge_method: 'S256',
      response_mode: 'form_post',
    });
    // The secret is never in an address a browser is sent to.
    expect(url.href).not.toContain(CLIENT_SECRET);
  });

  it('leaves the response mode to Google when it is query, and carries extra parameters', () => {
    const { google } = client(() => json({}), { ...CONFIG, responseMode: 'query' });
    const url = new URL(
      google.authorizeUrl({
        state: 's'.repeat(43),
        codeChallenge: 'c'.repeat(43),
        extra: { trigger_onepick: 'true' },
      }),
    );
    expect(url.searchParams.has('response_mode')).toBe(false);
    expect(url.searchParams.get('trigger_onepick')).toBe('true');
    expect(url.searchParams.getAll('scope')).toEqual([DRIVE_FILE_SCOPE]);
  });
});

describe('exchangeCode', () => {
  it('posts the code, the verifier and the client credentials as a form body, never in the URL', async () => {
    const { google, seen } = client(() => json(fixtureText('token-exchange.json', TOKENS)));
    const grant = await google.exchangeCode(AUTH_CODE, 'verifier-'.repeat(6));
    expect(grant).toEqual({
      ok: true,
      value: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE },
    });
    const sent = seen[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe(GOOGLE_ENDPOINTS.token);
    expect(sent?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(sent?.body))).toEqual({
      grant_type: 'authorization_code',
      code: AUTH_CODE,
      code_verifier: 'verifier-'.repeat(6),
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CONFIG.redirectUri,
    });
  });

  it('is never retried: a code works once, so a 500 is one request and an answer', async () => {
    const { google, seen } = client(() => json({ error: 'internal_failure' }, 500));
    const grant = await google.exchangeCode(AUTH_CODE, 'v');
    expect(grant).toEqual({ ok: false, error: { kind: 'unreachable' } });
    expect(seen).toHaveLength(1);
  });

  it('says when Google gave no lasting access', async () => {
    const { google } = client(() => json(fixtureText('token-exchange-no-refresh.json', TOKENS)));
    const grant = await google.exchangeCode(AUTH_CODE, 'v');
    expect(grant.ok && grant.value.refreshToken).toBeNull();
  });

  it.each([
    ['error-invalid-grant.json', 400, 'grant_invalid'],
    ['error-invalid-client.json', 401, 'client_config'],
  ] as const)('reads %s as %s', async (name, status, kind) => {
    const { google } = client(() => json(fixtureText(name), status));
    expect(await google.exchangeCode(AUTH_CODE, 'v')).toEqual({ ok: false, error: { kind } });
  });

  it.each([
    ['not JSON', '<html>oops</html>'],
    ['no access token', JSON.stringify({ token_type: 'Bearer' })],
  ])('treats a 200 that is %s as a bad response', async (_name, body) => {
    const { google } = client(() => new Response(body, { status: 200 }));
    expect(await google.exchangeCode(AUTH_CODE, 'v')).toEqual({
      ok: false,
      error: { kind: 'bad_response' },
    });
  });
});

describe('refresh', () => {
  it('sends the refresh token in the form body and reads the new access token', async () => {
    const { google, seen } = client(() => json(fixtureText('token-refresh.json', TOKENS)));
    expect(await google.refresh(REFRESH_TOKEN)).toEqual({
      ok: true,
      value: { accessToken: ACCESS_TOKEN },
    });
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(seen[0]?.url).not.toContain(REFRESH_TOKEN);
  });

  it('is retried with backoff when Google is down for a moment (it is safe to ask twice)', async () => {
    const { google, seen, slept } = client((_request, index) =>
      index === 0
        ? json({ error: 'backend_error' }, 503)
        : json(fixtureText('token-refresh.json', TOKENS)),
    );
    expect((await google.refresh(REFRESH_TOKEN)).ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(slept.length).toBeGreaterThan(0);
  });

  it('a revoked or lapsed grant is grant_invalid (the connection is broken, D122)', async () => {
    const { google, seen } = client(() => json(fixtureText('error-invalid-grant.json'), 400));
    expect(await google.refresh(REFRESH_TOKEN)).toEqual({
      ok: false,
      error: { kind: 'grant_invalid' },
    });
    expect(seen).toHaveLength(1);
  });

  it('a wrong client id or secret is our configuration, not his connection', async () => {
    const { google } = client(() => json(fixtureText('error-invalid-client.json'), 401));
    expect(await google.refresh(REFRESH_TOKEN)).toEqual({
      ok: false,
      error: { kind: 'client_config' },
    });
  });

  it('a dropped connection on every attempt is unreachable', async () => {
    const { google, seen } = client(() => Promise.reject(new TypeError('fetch failed')));
    expect(await google.refresh(REFRESH_TOKEN)).toEqual({
      ok: false,
      error: { kind: 'unreachable' },
    });
    expect(seen).toHaveLength(3);
  });

  it('a 429 that does not go away is busy', async () => {
    const { google } = client(() => json({ error: 'rate_limit_exceeded' }, 429));
    expect(await google.refresh(REFRESH_TOKEN)).toEqual({ ok: false, error: { kind: 'busy' } });
  });
});

describe('revoke', () => {
  it('posts the token as a form body and reports it revoked', async () => {
    const { google, seen } = client(() => new Response('', { status: 200 }));
    expect(await google.revoke(REFRESH_TOKEN)).toEqual({ ok: true, value: 'revoked' });
    expect(seen[0]?.url).toBe(GOOGLE_ENDPOINTS.revoke);
    expect(seen[0]?.url).not.toContain(REFRESH_TOKEN);
    expect(new URLSearchParams(seen[0]?.body).get('token')).toBe(REFRESH_TOKEN);
  });

  it('a token Google no longer knows is already gone — the outcome a disconnect wants', async () => {
    const { google } = client(() => json(fixtureText('revoke-invalid-token.json'), 400));
    expect(await google.revoke(REFRESH_TOKEN)).toEqual({ ok: true, value: 'already_gone' });
  });

  it('Google down is not "revoked": the caller keeps the row (the brief’s boundary)', async () => {
    const { google } = client(() => json({ error: 'backend_error' }, 503));
    expect(await google.revoke(REFRESH_TOKEN)).toEqual({
      ok: false,
      error: { kind: 'unreachable' },
    });
  });
});

describe('about', () => {
  it('names the account by address and permission id, asking only for those fields', async () => {
    const { google, seen } = client(() => json(fixtureText('about.json')));
    expect(await google.about(ACCESS_TOKEN)).toEqual({
      ok: true,
      value: { email: 'broker@example.com', permissionId: '01234567890123456789' },
    });
    const url = new URL(seen[0]?.url ?? '');
    expect(url.pathname).toBe('/drive/v3/about');
    expect(url.searchParams.get('fields')).toBe('user(emailAddress,permissionId)');
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(seen[0]?.url).not.toContain(ACCESS_TOKEN);
  });

  it('retries a 403 "user rate limit exceeded", which Drive documents as slow down', async () => {
    const { google, seen, slept } = client((_r, index) =>
      index === 0 ? json(fixtureText('drive-403-rate.json'), 403) : json(fixtureText('about.json')),
    );
    expect((await google.about(ACCESS_TOKEN)).ok).toBe(true);
    expect(seen).toHaveLength(2);
    // Equal jitter over a 500 ms first cap: [250, 500), and 375 at the middle of the range.
    expect(slept).toEqual([375]);
  });

  it('a 403 rate limit that never lifts is busy, after the retries', async () => {
    const { google, seen } = client(() => json(fixtureText('drive-403-rate.json'), 403));
    expect(await google.about(ACCESS_TOKEN)).toEqual({ ok: false, error: { kind: 'busy' } });
    expect(seen).toHaveLength(1 + DRIVE_LIMITS.busyRetries);
  });

  it('a 401 is unauthorized: access was removed between the refresh and this call', async () => {
    const { google } = client(() => json(fixtureText('drive-401.json'), 401));
    expect(await google.about(ACCESS_TOKEN)).toEqual({
      ok: false,
      error: { kind: 'unauthorized' },
    });
  });
});

describe('getFile', () => {
  it('asks for the fields formats.ts needs, in shared drives too, and reads a Google Doc', async () => {
    const { google, seen } = client(() => json(fixtureText('file-google-doc.json')));
    const meta = await google.getFile(ACCESS_TOKEN, '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(meta).toEqual({
      ok: true,
      value: {
        id: '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
        name: 'Rate sheet',
        mimeType: 'application/vnd.google-apps.document',
        size: null,
        modifiedTime: '2026-10-15T01:02:03.000Z',
        trashed: false,
        canDownload: true,
        shortcutTargetId: null,
        shortcutTargetMimeType: null,
      },
    });
    const url = new URL(seen[0]?.url ?? '');
    expect(url.pathname).toBe('/drive/v3/files/1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('fields')?.split(',')).toEqual(
      expect.arrayContaining(['trashed', 'capabilities/canDownload', 'shortcutDetails/targetId']),
    );
  });

  it("reads a PDF's size, a shortcut's target and a file in the bin", async () => {
    const { google } = client((request) => {
      if (request.url.includes('/1Pdf')) return json(fixtureText('file-pdf.json'));
      if (request.url.includes('/1Cut')) return json(fixtureText('file-shortcut.json'));
      return json(fixtureText('file-trashed.json'));
    });
    const pdf = await google.getFile(ACCESS_TOKEN, '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(pdf.ok && pdf.value.size).toBe(48_211);
    const cut = await google.getFile(ACCESS_TOKEN, '1CutAbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(cut.ok && [cut.value.shortcutTargetId, cut.value.shortcutTargetMimeType]).toEqual([
      '1DocAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'application/vnd.google-apps.document',
    ]);
    const bin = await google.getFile(ACCESS_TOKEN, '1BinAbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(bin.ok && bin.value.trashed).toBe(true);
  });

  it('an owner who turned off downloading is canDownload false', async () => {
    const { google } = client(() =>
      json({
        ...(JSON.parse(fixtureText('file-pdf.json')) as object),
        capabilities: { canDownload: false },
      }),
    );
    const meta = await google.getFile(ACCESS_TOKEN, '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(meta.ok && meta.value.canDownload).toBe(false);
  });

  it.each([
    ['drive-404.json', 404, 'not_found'],
    ['drive-403-not-authorized.json', 403, 'no_access'],
    ['drive-403-domain.json', 403, 'domain_policy'],
    ['drive-401.json', 401, 'unauthorized'],
  ] as const)('reads %s as %s', async (name, status, kind) => {
    const { google } = client(() => json(fixtureText(name), status));
    expect(await google.getFile(ACCESS_TOKEN, '1PdfAbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toEqual({
      ok: false,
      error: { kind },
    });
  });

  it('a 5xx is retried by the HTTP layer, then said to be unreachable', async () => {
    const { google, seen } = client(() => json({ error: { code: 500 } }, 500));
    expect(await google.getFile(ACCESS_TOKEN, 'PdfFileId0001')).toEqual({
      ok: false,
      error: { kind: 'unreachable' },
    });
    expect(seen).toHaveLength(3);
  });

  it('a 200 in an unexpected shape is a bad response, not a file', async () => {
    const { google } = client(() => json({ id: 'x' }));
    expect(await google.getFile(ACCESS_TOKEN, 'PdfFileId0001')).toEqual({
      ok: false,
      error: { kind: 'bad_response' },
    });
  });
});

describe('readContent', () => {
  it('exports a Google file with its export type, and downloads an ordinary one with alt=media', async () => {
    const { google, seen } = client(
      () =>
        new Response(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'application/zip; charset=binary' },
        }),
    );
    const exported = await google.readContent(ACCESS_TOKEN, 'DocFileId0001', EXPORT_DOCX);
    expect(exported).toEqual({
      ok: true,
      value: { bytes: new Uint8Array([80, 75, 3, 4]), contentType: 'application/zip' },
    });
    const exportUrl = new URL(seen[0]?.url ?? '');
    expect(exportUrl.pathname).toBe('/drive/v3/files/DocFileId0001/export');
    expect(exportUrl.searchParams.get('mimeType')).toBe(EXPORT_DOCX.format.mimeType);

    await google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' });
    const downloadUrl = new URL(seen[1]?.url ?? '');
    expect(downloadUrl.pathname).toBe('/drive/v3/files/PdfFileId0001');
    expect(downloadUrl.searchParams.get('alt')).toBe('media');
    expect(downloadUrl.searchParams.get('supportsAllDrives')).toBe('true');
    for (const request of seen) {
      expect(request.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(request.url).not.toContain(ACCESS_TOKEN);
    }
  });

  it("an export over Google's 10 MB is export_too_large", async () => {
    const { google } = client(() => json(fixtureText('drive-403-export-size.json'), 403));
    expect(await google.readContent(ACCESS_TOKEN, 'DocFileId0001', EXPORT_DOCX)).toEqual({
      ok: false,
      error: { kind: 'export_too_large' },
    });
  });

  it('a 429, then a 200: retried, and read', async () => {
    const { google, seen } = client((_r, index) =>
      index === 0 ? json({ error: { code: 429 } }, 429) : new Response(new Uint8Array([1, 2, 3])),
    );
    const read = await google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' });
    expect(read.ok && read.value.bytes.length).toBe(3);
    expect(seen).toHaveLength(2);
  });

  it('a 403 rate limit, then a 200: retried, and read', async () => {
    const { google, seen } = client((_r, index) =>
      index === 0
        ? json(fixtureText('drive-403-rate.json'), 403)
        : new Response(new Uint8Array([1])),
    );
    expect((await google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' })).ok).toBe(
      true,
    );
    expect(seen).toHaveLength(2);
  });

  it('a 5xx on every attempt is unreachable, and a 429 on every attempt is busy', async () => {
    const down = client(() => json({ error: { code: 503 } }, 503));
    expect(
      await down.google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' }),
    ).toEqual({
      ok: false,
      error: { kind: 'unreachable' },
    });
    expect(down.seen).toHaveLength(1 + DRIVE_LIMITS.busyRetries);
    const busy = client(() => json({ error: { code: 429 } }, 429));
    expect(
      await busy.google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' }),
    ).toEqual({
      ok: false,
      error: { kind: 'busy' },
    });
  });

  it('a 401 mid-read is unauthorized, and a 404 not_found — neither retried', async () => {
    const gone = client(() => json(fixtureText('drive-404.json'), 404));
    expect(
      await gone.google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' }),
    ).toEqual({
      ok: false,
      error: { kind: 'not_found' },
    });
    expect(gone.seen).toHaveLength(1);
    const revoked = client(() => json(fixtureText('drive-401.json'), 401));
    expect(
      await revoked.google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' }),
    ).toEqual({
      ok: false,
      error: { kind: 'unauthorized' },
    });
  });

  it("a declared length over part 1's limit is refused before the body is read", async () => {
    const { google } = client(
      () =>
        new Response(new Uint8Array(4), {
          status: 200,
          headers: { 'content-length': String(DRIVE_LIMITS.maxBytes + 1) },
        }),
    );
    expect(await google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' })).toEqual({
      ok: false,
      error: { kind: 'too_large', received: 0 },
    });
  });

  it('a body that turns out larger than the limit is refused, never cut short', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const { google } = client(() => new Response(body, { status: 200 }));
    const read = await google.readContent(ACCESS_TOKEN, 'PdfFileId0001', { kind: 'download' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.kind).toBe('too_large');
    expect(sent).toBeLessThan(30);
  });
});

describe('a slow Google (Part C: "the export takes long enough to matter")', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that answers only when `afterMs` has passed, or fails when aborted first. */
  function slowFetch(afterMs: number, response: () => Response) {
    return (_input: string, init: RequestInit): Promise<Response> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(response());
        }, afterMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
  }

  function slowClient(
    fetchImpl: (input: string, init: RequestInit) => Promise<Response>,
  ): GoogleClient {
    const http = createHttpClient({
      fetch: fetchImpl,
      retries: 2,
      logger: silent,
      random: () => 0.5,
    });
    return createGoogleClient({ config: CONFIG, http, random: () => 0.5 });
  }

  it('an export Google takes 30 s to prepare is waited for, and read', async () => {
    const google = slowClient(slowFetch(30_000, () => new Response(new Uint8Array([1, 2]))));
    const pending = google.readContent(ACCESS_TOKEN, 'DocFileId0001', EXPORT_DOCX);
    await vi.advanceTimersByTimeAsync(30_000);
    const read = await pending;
    expect(read.ok && read.value.bytes.length).toBe(2);
  });

  it('an export that has not started after the first-byte limit is a timeout — and not asked for again', async () => {
    let asked = 0;
    const fetchImpl = (input: string, init: RequestInit): Promise<Response> => {
      asked += 1;
      return slowFetch(10 * 60_000, () => new Response(''))(input, init);
    };
    const google = slowClient(fetchImpl);
    const pending = google.readContent(ACCESS_TOKEN, 'DocFileId0001', EXPORT_DOCX);
    await vi.advanceTimersByTimeAsync(DRIVE_LIMITS.contentFirstByteMs + 1);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(asked).toBe(1);
  });

  it('a body that stalls is abandoned at the overall limit', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
    });
    const google = slowClient(() => Promise.resolve(new Response(stalled)));
    const pending = google.readContent(ACCESS_TOKEN, 'DocFileId0001', EXPORT_DOCX);
    await vi.advanceTimersByTimeAsync(DRIVE_LIMITS.contentTotalMs + 1);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout' } });
  });

  it('a metadata call that hangs times out after its own limit', async () => {
    const google = slowClient(slowFetch(10 * 60_000, () => new Response('{}')));
    const pending = google.getFile(ACCESS_TOKEN, 'PdfFileId0001');
    await vi.advanceTimersByTimeAsync(DRIVE_LIMITS.metadataTimeoutMs * 4);
    expect(await pending).toEqual({ ok: false, error: { kind: 'timeout' } });
  });
});

describe("reading Google's failures", () => {
  const status = (code: number, body: string): HttpStatusError =>
    new HttpStatusError(`GET responded ${String(code)}`, code, { context: { bodySnippet: body } });

  it('takes the reason code, never the message', () => {
    expect(googleReason(status(403, fixtureText('drive-403-rate.json')))).toBe(
      'userRateLimitExceeded',
    );
    expect(googleReason(status(400, fixtureText('error-invalid-grant.json')))).toBe(
      'invalid_grant',
    );
    expect(googleReason(status(500, 'no json here'))).toBeNull();
    expect(googleReason(new NetworkError('down'))).toBeNull();
  });

  it.each([
    [403, 'cannotDownloadFile', 'download_blocked'],
    [403, 'cannotDownloadAbusiveFile', 'download_blocked'],
    [403, 'sharingRateLimitExceeded', 'busy'],
    [403, 'dailyLimitExceeded', 'busy'],
    [403, 'insufficientFilePermissions', 'no_access'],
    [400, 'badRequest', 'not_found'],
    [418, 'teapot', 'bad_response'],
  ])('a Drive %s %s is %s', (code, reason, kind) => {
    const body = JSON.stringify({ error: { code, errors: [{ reason }] } });
    expect(driveFailure(status(code, body))).toEqual({ kind });
  });

  it('a timeout and a network failure are what they are', () => {
    expect(driveFailure(new TimeoutError('slow', 10))).toEqual({ kind: 'timeout' });
    expect(driveFailure(new NetworkError('down'))).toEqual({ kind: 'unreachable' });
    expect(tokenFailure(new TimeoutError('slow', 10))).toEqual({ kind: 'timeout' });
    expect(tokenFailure(new NetworkError('down'))).toEqual({ kind: 'unreachable' });
  });

  it.each([
    ['unauthorized_client', 400, 'client_config'],
    ['redirect_uri_mismatch', 400, 'client_config'],
    ['invalid_request', 400, 'bad_response'],
  ])('a token-endpoint %s is %s', (reason, code, kind) => {
    expect(tokenFailure(status(code, JSON.stringify({ error: reason })))).toEqual({ kind });
  });
});

describe('the granted scope', () => {
  it('accepts exactly drive.file', () => {
    expect(checkGrantedScope(DRIVE_FILE_SCOPE)).toBe('ok');
    expect(checkGrantedScope(` ${DRIVE_FILE_SCOPE}  `)).toBe('ok');
  });

  it("says missing when he unticked it on Google's screen", () => {
    expect(checkGrantedScope('')).toBe('missing');
    expect(checkGrantedScope('openid')).toBe('missing');
  });

  it("refuses anything wider, whatever it is (the brief's decision 1)", () => {
    expect(
      checkGrantedScope(`${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly`),
    ).toBe('wider');
    expect(checkGrantedScope(`${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive`)).toBe(
      'wider',
    );
    expect(checkGrantedScope(`${DRIVE_FILE_SCOPE} email`)).toBe('wider');
  });

  it('splits on any whitespace', () => {
    expect(grantedScopes('a  b\tc')).toEqual(['a', 'b', 'c']);
  });
});
