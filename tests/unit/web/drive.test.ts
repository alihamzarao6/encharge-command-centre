/**
 * The browser's half of Google Drive (Milestone 5 part 3a), with no browser and no network:
 * the calls (web/src/lib/driveApi.ts) — what is sent, how every answer is read, and that the
 * bytes of a file are believed only when they are what the server said it handed over; the
 * Drive section's words (web/src/lib/driveView.ts) — four states, never ambiguous; and what
 * the thread says of a Drive file (web/src/lib/filesView.ts).
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { encodeDriveMeta, DRIVE_META_HEADER } from '../../../src/lib/drive/meta.js';
import { DISCONNECT_MESSAGES, DRIVE_CONNECTION_MESSAGES } from '../../../src/lib/drive/limits.js';
import {
  DRIVE_API_MESSAGES,
  callDrive,
  interpretDriveFailure,
  interpretDriveResponse,
  readDriveFile,
  type DriveDeps,
} from '../../../web/src/lib/driveApi.js';
import {
  DRIVE_SECTION_TEXT,
  STALE_RETURN_TEXT,
  parseReturn,
  returnMessage,
  sectionView,
} from '../../../web/src/lib/driveView.js';
import type { AttachedFile } from '../../../web/src/lib/filesApi.js';
import {
  REPLACED_FILE_TEXT,
  REPLACED_PAGE_TEXT,
  busyNote,
  goneText,
  sourceNote,
  uploadStatus,
} from '../../../web/src/lib/filesView.js';
import { isCanonicalPath, pathFor, sectionFor } from '../../../web/src/lib/routes.js';
import type { UploadItem } from '../../../web/src/lib/uploads.js';

const NOW = Date.parse('2026-10-16T04:00:00Z');
const ZONE = 'Australia/Perth';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bodyText = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

function deps(
  respond: (body: unknown) => Response | Promise<Response>,
  seen: { url: string; init: RequestInit }[] = [],
): DriveDeps {
  return {
    driveUrl: 'https://project.supabase.co/functions/v1/drive',
    anonKey: 'anon',
    fetch: ((url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(respond(JSON.parse(bodyText(init)) as unknown));
    }) as typeof fetch,
    hash: (bytes) => Promise.resolve(sha(bytes)),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('callDrive', () => {
  it('posts the action with the session, and reads a status', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const outcome = await callDrive(
      deps(
        () =>
          json({
            action: 'status',
            state: 'connected',
            email: 'broker@example.com',
            connectedAt: 'x',
            lastUsedAt: null,
            checked: true,
          }),
        seen,
      ),
      'session-token',
      { action: 'status' },
    );
    expect(outcome).toMatchObject({
      kind: 'ok',
      reply: { state: 'connected', email: 'broker@example.com' },
    });
    expect(seen[0]?.init.headers).toMatchObject({
      authorization: 'Bearer session-token',
      apikey: 'anon',
    });
    expect(JSON.parse(bodyText(seen[0]?.init))).toEqual({ action: 'status' });
  });

  it("a Connect address that is not Google's is not believed", async () => {
    const outcome = await callDrive(
      deps(() => json({ action: 'connect_start', authorizeUrl: 'https://evil.example/' })),
      't',
      {
        action: 'connect_start',
      },
    );
    expect(outcome).toMatchObject({ kind: 'error', code: 'BAD_RESPONSE' });
  });

  it('a transport failure is retryable and never throws', async () => {
    const failing: DriveDeps = {
      ...deps(() => json({})),
      fetch: () => Promise.reject(new TypeError('offline')),
    };
    expect(await callDrive(failing, 't', { action: 'status' })).toMatchObject({
      kind: 'error',
      failure: 'retryable',
      code: 'NETWORK',
      reconnect: false,
    });
  });

  it('a call that never answers is stopped at its limit', async () => {
    const hanging: DriveDeps = {
      ...deps(() => json({})),
      timeoutMs: 10,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        })) as typeof fetch,
    };
    expect(await callDrive(hanging, 't', { action: 'status' })).toMatchObject({
      code: 'CLIENT_TIMEOUT',
    });
  });
});

describe('reading the answers', () => {
  it.each([
    ['NOT_CONNECTED', 409, DRIVE_CONNECTION_MESSAGES.not_connected],
    ['CONNECTION_BROKEN', 409, DRIVE_CONNECTION_MESSAGES.connection_broken],
    ['NOT_CONFIGURED', 503, DRIVE_CONNECTION_MESSAGES.not_configured],
  ])('%s is not "try again": the way out is Settings', (code, status, message) => {
    const failure = interpretDriveFailure(status, { error: { code, message, retryable: false } });
    expect(failure).toMatchObject({ failure: 'fatal', reconnect: true, message });
  });

  it("a busy Google is retryable and keeps the server's sentence", () => {
    const failure = interpretDriveFailure(429, {
      error: {
        code: 'DRIVE_NOT_READ',
        message: 'Google Drive is busy right now…',
        retryable: true,
      },
    });
    expect(failure).toMatchObject({
      failure: 'retryable',
      reconnect: false,
      message: 'Google Drive is busy right now…',
    });
  });

  it('a refused file keeps its sentence and is not retried', () => {
    const failure = interpretDriveFailure(422, {
      error: {
        code: 'DRIVE_REFUSED',
        message: 'That is a folder.',
        retryable: false,
        refusal: 'drive_folder',
      },
    });
    expect(failure).toMatchObject({ failure: 'refused', message: 'That is a folder.' });
  });

  it('a 401 is "sign in again"', () => {
    expect(interpretDriveFailure(401, null)).toMatchObject({ failure: 'unauthenticated' });
  });

  it.each([
    ['status with no state', 'status', { action: 'status' }],
    ['connected with no address', 'status', { action: 'status', state: 'connected' }],
    ['broken with no sentence', 'status', { action: 'status', state: 'broken', email: 'x' }],
    ['a finish with no outcome', 'connect_finish', { action: 'connect_finish' }],
    ['a disconnect with no answer', 'disconnect', { action: 'disconnect', message: 'x' }],
    ['the wrong action', 'status', { action: 'disconnect', disconnected: true, message: 'x' }],
  ] as const)('a 200 that is %s is not a success', (_name, action, body) => {
    expect(interpretDriveResponse(action, 200, body)).toMatchObject({
      kind: 'error',
      code: 'BAD_RESPONSE',
    });
  });
});

describe('readDriveFile', () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 a statement');
  const meta = {
    action: 'read_file',
    readId: 'r0000000-0000-4000-8000-000000000001',
    name: 'Statement Oct',
    fileName: 'Statement Oct',
    contentType: 'application/pdf',
    byteSize: bytes.length,
    contentHash: sha(bytes),
    googleType: null,
    fileId: 'PdfFileId0001',
  };
  const fileResponse = (body: Uint8Array, header: unknown = meta): Response =>
    new Response(new Uint8Array(body), {
      status: 200,
      headers: { [DRIVE_META_HEADER]: encodeDriveMeta(header) },
    });

  it('takes the bytes and what the server measured, and checks one against the other', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const progress: number[] = [];
    const outcome = await readDriveFile(
      deps(() => fileResponse(bytes), seen),
      't',
      { requestId: meta.readId, fileId: 'PdfFileId0001' },
      undefined,
      (received) => {
        progress.push(received);
      },
    );
    expect(outcome).toMatchObject({
      kind: 'ok',
      reply: {
        readId: meta.readId,
        name: 'Statement Oct',
        contentHash: meta.contentHash,
        fileId: 'PdfFileId0001',
      },
    });
    expect(outcome.kind === 'ok' && outcome.reply.bytes).toEqual(bytes);
    expect(JSON.parse(bodyText(seen[0]?.init))).toEqual({
      action: 'read_file',
      requestId: meta.readId,
      fileId: 'PdfFileId0001',
    });
    expect(progress.at(-1)).toBe(bytes.length);
  });

  it('a file cut short on the way here is not read as if it were whole', async () => {
    const outcome = await readDriveFile(
      deps(() => fileResponse(bytes.slice(0, 5))),
      't',
      { requestId: meta.readId, fileId: 'PdfFileId0001' },
    );
    expect(outcome).toMatchObject({
      kind: 'error',
      code: 'INCOMPLETE_FILE',
      message: DRIVE_API_MESSAGES.incompleteFile,
      failure: 'retryable',
    });
  });

  it('bytes that are not the ones the server hashed are not believed', async () => {
    const other = new TextEncoder().encode('%PDF-1.7 a statemenX');
    expect(
      await readDriveFile(
        deps(() => fileResponse(other)),
        't',
        { requestId: meta.readId, fileId: 'PdfFileId0001' },
      ),
    ).toMatchObject({ code: 'INCOMPLETE_FILE' });
  });

  it('a 200 without the header, or with one missing a field, is not a file', async () => {
    expect(
      await readDriveFile(
        deps(() => new Response(bytes, { status: 200 })),
        't',
        { requestId: meta.readId, fileId: 'PdfFileId0001' },
      ),
    ).toMatchObject({ code: 'BAD_RESPONSE' });
    expect(
      await readDriveFile(
        deps(() => fileResponse(bytes, { ...meta, readId: 7 })),
        't',
        { requestId: meta.readId, fileId: 'PdfFileId0001' },
      ),
    ).toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('a broken connection comes back as itself, with the way out', async () => {
    const outcome = await readDriveFile(
      deps(() =>
        json(
          {
            error: {
              code: 'CONNECTION_BROKEN',
              message: DRIVE_CONNECTION_MESSAGES.connection_broken,
              retryable: false,
            },
          },
          409,
        ),
      ),
      't',
      { requestId: meta.readId, fileId: 'PdfFileId0001' },
    );
    expect(outcome).toMatchObject({ kind: 'error', reconnect: true, failure: 'fatal' });
  });

  it('never throws on a dropped connection', async () => {
    const failing: DriveDeps = {
      ...deps(() => json({})),
      fetch: () => Promise.reject(new TypeError('offline')),
    };
    expect(
      await readDriveFile(failing, 't', { requestId: meta.readId, fileId: 'PdfFileId0001' }),
    ).toMatchObject({ code: 'NETWORK' });
  });
});

describe('the Drive section: four states, never ambiguous', () => {
  it('not set up', () => {
    expect(sectionView({ state: 'unavailable' }, NOW)).toEqual({
      headline: DRIVE_SECTION_TEXT.unavailableHeadline,
      detail: DRIVE_SECTION_TEXT.unavailableDetail,
      tone: 'neutral',
      actions: [],
    });
  });

  it('not connected: what connecting allows, and the one button', () => {
    const view = sectionView({ state: 'not_connected' }, NOW);
    expect(view.headline).toBe('Not connected');
    expect(view.detail).toMatch(/only the files you pick, and nothing else in your Drive/);
    expect(view.actions).toEqual(['connect']);
  });

  it('connected and checked: WHICH account, since when', () => {
    const view = sectionView(
      {
        state: 'connected',
        email: 'broker@example.com',
        connectedAt: '2026-10-16T02:00:00Z',
        lastUsedAt: null,
        checked: true,
      },
      NOW,
      ZONE,
    );
    expect(view).toMatchObject({
      headline: 'Connected as broker@example.com',
      tone: 'ok',
      actions: ['disconnect'],
    });
    expect(view.detail).toMatch(/^Connected today at 10:00 am\./);
  });

  it('connected but not checked just now: says so, rather than claiming it works', () => {
    const view = sectionView(
      {
        state: 'connected',
        email: 'broker@example.com',
        connectedAt: '2026-10-16T02:00:00Z',
        lastUsedAt: null,
        checked: false,
      },
      NOW,
      ZONE,
    );
    expect(view.tone).toBe('warn');
    expect(view.detail).toMatch(/Google could not be reached just now/);
  });

  it('broken: not working, why, since when, and the way back', () => {
    const view = sectionView(
      {
        state: 'broken',
        email: 'broker@example.com',
        brokenAt: '2026-10-15T01:00:00Z',
        reason: 'grant_revoked',
        message: "Google stopped accepting this app's access.",
      },
      NOW,
      ZONE,
    );
    expect(view).toMatchObject({
      headline: 'Not working — broker@example.com',
      tone: 'problem',
      actions: ['reconnect', 'disconnect'],
    });
    expect(view.detail).toMatch(/Noticed yesterday at 9:00 am\. Connect again/);
  });

  it('no two states share a headline', () => {
    const headlines = [
      sectionView({ state: 'unavailable' }, NOW).headline,
      sectionView({ state: 'not_connected' }, NOW).headline,
      sectionView(
        { state: 'connected', email: 'a@b.c', connectedAt: 'x', lastUsedAt: null, checked: true },
        NOW,
      ).headline,
      sectionView(
        { state: 'broken', email: 'a@b.c', brokenAt: 'x', reason: 'r', message: 'm' },
        NOW,
      ).headline,
    ];
    expect(new Set(headlines).size).toBe(4);
  });
});

describe('back from Google', () => {
  it('reads the attempt to finish', () => {
    expect(parseReturn('?drive=returned&attempt=a0000000-0000-4000-8000-000000000001')).toEqual({
      kind: 'returned',
      attempt: 'a0000000-0000-4000-8000-000000000001',
    });
  });

  it.each(['?drive=stale', '?drive=returned', '?drive=returned&attempt=../../x'])(
    '%s is stale: nothing to finish',
    (search) => {
      expect(parseReturn(search)).toEqual({ kind: 'stale' });
    },
  );

  it('anything else is no return at all', () => {
    expect(parseReturn('')).toEqual({ kind: 'none' });
    expect(parseReturn('?tab=x')).toEqual({ kind: 'none' });
  });

  it('a connect that worked reads as good news; anything else as a problem', () => {
    expect(returnMessage('connected', 'Google Drive is connected as a@b.c.')).toEqual({
      text: 'Google Drive is connected as a@b.c.',
      tone: 'ok',
    });
    expect(returnMessage('cancelled', 'You cancelled at Google…').tone).toBe('problem');
    expect(STALE_RETURN_TEXT).toMatch(/expired or was already used/);
  });

  it('the disconnect step says what it does before he does it', () => {
    expect(DISCONNECT_MESSAGES.confirm).toMatch(/tells Google to remove this app's access/);
  });
});

describe('what the thread says of a Drive file', () => {
  const driveFile = (overrides: Partial<AttachedFile> = {}): AttachedFile => ({
    id: 'f1',
    conversationId: 'c1',
    uploadedBy: 'u1',
    name: 'Rate sheet',
    kind: 'docx',
    byteSize: 12_000,
    pageCount: 1,
    visionPages: 0,
    status: 'ready',
    createdAt: '2026-10-16T02:00:00Z',
    expiresAt: '2026-11-15T02:00:00Z',
    sourceUrl: 'https://drive.google.com/file/d/DocFileId0001/view',
    sourceHost: 'drive.google.com',
    fetchedAt: '2026-10-16T02:00:00Z',
    valuesMissing: 0,
    readAsSent: false,
    removedReason: null,
    driveFileId: 'DocFileId0001',
    ...overrides,
  });

  it('"from Google Drive", never the host its address happens to use', () => {
    expect(sourceNote(driveFile(), NOW, ZONE)).toBe('from Google Drive, read today at 10:00 am');
    expect(
      sourceNote(driveFile({ driveFileId: null, sourceHost: 'www.lender.example.org' }), NOW, ZONE),
    ).toBe('from lender.example.org, read today at 10:00 am');
  });

  it('a document read again is a file, not a web page', () => {
    expect(
      goneText(
        driveFile({ status: 'removed', name: null, removedReason: 'replaced', driveFileId: null }),
        NOW,
      ),
    ).toBe(REPLACED_FILE_TEXT);
    expect(
      goneText(
        driveFile({ kind: 'html', status: 'removed', name: null, removedReason: 'replaced' }),
        NOW,
      ),
    ).toBe(REPLACED_PAGE_TEXT);
  });

  const upload = (overrides: Partial<UploadItem> = {}): UploadItem => ({
    localId: 'u1',
    name: 'Rate sheet',
    byteSize: 0,
    kind: null,
    phase: 'fetching',
    done: 0,
    total: 0,
    message: null,
    retryable: false,
    estimate: null,
    source: 'drive',
    url: null,
    driveFileId: 'DocFileId0001',
    reconnect: false,
    ...overrides,
  });

  it('while Google prepares it, says so; once bytes arrive, counts them', () => {
    expect(uploadStatus(upload())).toBe('Getting it from Google Drive…');
    expect(uploadStatus(upload({ done: 1024, total: 4096 }))).toBe('Downloading… 1 KB of 4 KB');
    expect(uploadStatus(upload({ phase: 'waiting' }))).toBe('Waiting for the one before it…');
  });

  it('Send waits, and says what for', () => {
    expect(busyNote([upload()])).toBe(
      'Wait for Rate sheet to come in from Google Drive before you send.',
    );
  });
});

describe('the Settings address', () => {
  it("is /settings, and Google's return to it keeps its query", () => {
    expect(pathFor('settings')).toBe('/settings');
    expect(sectionFor('/settings')).toBe('settings');
    expect(sectionFor('/Settings/')).toBe('settings');
    expect(isCanonicalPath('/settings')).toBe(true);
  });
});
