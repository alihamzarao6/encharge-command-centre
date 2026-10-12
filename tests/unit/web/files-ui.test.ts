/**
 * The words and the wire for files in the interface: reading the endpoint's answers
 * (filesApi.ts), the sentences a person is shown (filesView.ts), and the two things the
 * thread store learned for files — moving onto a conversation an upload opened, and saying
 * when a reply was cut off (thread.ts, chatApi.ts).
 */
import { describe, expect, it } from 'vitest';

import { interpretChatResponse } from '../../../web/src/lib/chatApi.js';
import { resolveWebConfig } from '../../../web/src/lib/config.js';
import {
  CONVERSATION_FILE_COLUMNS,
  FILES_API_MESSAGES,
  callFiles,
  interpretFilesResponse,
  toAttachedFiles,
  type AttachedFile,
  type ConversationFileRow,
  type VisionEstimate,
} from '../../../web/src/lib/filesApi.js';
import {
  EXPIRED_FILE_TEXT,
  REMOVED_FILE_TEXT,
  RETENTION_HINT,
  busyNote,
  canRemove,
  confirmButtonText,
  confirmText,
  fileSummary,
  isExpired,
  retentionText,
  timeline,
  uploadPercent,
  uploadStatus,
} from '../../../web/src/lib/filesView.js';
import { createThreadStore, type ThreadMessage } from '../../../web/src/lib/thread.js';
import type { UploadItem } from '../../../web/src/lib/uploads.js';

const NOW = Date.parse('2026-10-12T04:00:00Z');

const FILE: AttachedFile = {
  id: 'f1',
  conversationId: 'c1',
  uploadedBy: 'u1',
  name: 'payslip.pdf',
  kind: 'pdf',
  byteSize: 214 * 1024,
  pageCount: 2,
  visionPages: 0,
  status: 'ready',
  createdAt: '2026-10-12T03:00:00Z',
  expiresAt: '2026-11-11T03:00:00Z',
  sourceUrl: null,
  sourceHost: null,
  fetchedAt: null,
  valuesMissing: 0,
  readAsSent: false,
  removedReason: null,
};

const item = (overrides: Partial<UploadItem> = {}): UploadItem => ({
  localId: 'upload-1',
  name: 'statement.pdf',
  byteSize: 1024,
  kind: 'pdf',
  phase: 'reading',
  done: 0,
  total: 0,
  message: null,
  retryable: false,
  estimate: null,
  source: 'file',
  url: null,
  ...overrides,
});

describe('reading the files endpoint', () => {
  const view = { ...FILE };

  it('a 200 with the promised shape is the reply', () => {
    expect(
      interpretFilesResponse('finish', 200, { action: 'finish', duplicate: false, file: view }),
    ).toEqual({
      kind: 'ok',
      reply: { action: 'finish', duplicate: false, file: view },
    });
    expect(
      interpretFilesResponse('begin', 200, {
        action: 'begin',
        fileId: 'f',
        conversationId: 'c',
        status: 'reading',
        duplicate: false,
        pagesStored: [],
      }).kind,
    ).toBe('ok');
    expect(
      interpretFilesResponse('estimate', 200, {
        action: 'estimate',
        pages: 3,
        estimateUsd: 0.08,
        affordable: true,
      }).kind,
    ).toBe('ok');
    expect(
      interpretFilesResponse('read_page', 200, {
        action: 'read_page',
        pageNo: 2,
        legibility: 'full',
        pageKind: 'document',
      }).kind,
    ).toBe('ok');
    expect(interpretFilesResponse('append', 200, { action: 'append', stored: 2 }).kind).toBe('ok');
    expect(interpretFilesResponse('remove', 200, { action: 'remove', removed: true }).kind).toBe(
      'ok',
    );
    expect(interpretFilesResponse('refused', 200, { action: 'refused', logged: true }).kind).toBe(
      'ok',
    );
  });

  it('a 200 with the wrong shape is not a success', () => {
    for (const [action, body] of [
      ['finish', { action: 'finish', file: { id: 'x' } }],
      ['finish', { action: 'begin' }],
      ['begin', { action: 'begin', fileId: 'f', conversationId: 'c' }],
      ['estimate', { action: 'estimate', estimateUsd: '0.08' }],
      ['read_page', { action: 'read_page' }],
      ['append', null],
      ['append', 'ok'],
    ] as const) {
      expect(interpretFilesResponse(action, 200, body)).toMatchObject({
        kind: 'error',
        failure: 'retryable',
        code: 'BAD_RESPONSE',
      });
    }
  });

  it("uses the server's own sentence, and knows a refused file from a failed call", () => {
    const refused = interpretFilesResponse('begin', 422, {
      error: {
        code: 'FILE_REFUSED',
        message: 'This conversation already has 10 files attached. Remove one first.',
        retryable: false,
        refusal: 'too_many_files',
      },
    });
    expect(refused).toEqual({
      kind: 'error',
      failure: 'refused',
      message: 'This conversation already has 10 files attached. Remove one first.',
      code: 'FILE_REFUSED',
      status: 422,
      refusal: 'too_many_files',
    });
    expect(
      interpretFilesResponse('read_page', 402, {
        error: { code: 'SPEND_CAP', message: 'Budget used up.', retryable: false },
      }),
    ).toMatchObject({ failure: 'cap', message: 'Budget used up.' });
    expect(
      interpretFilesResponse('remove', 403, {
        error: {
          code: 'FORBIDDEN',
          message: 'Only the person who attached this file, or an administrator, can remove it.',
        },
      }),
    ).toMatchObject({
      failure: 'forbidden',
      message: 'Only the person who attached this file, or an administrator, can remove it.',
    });
    expect(
      interpretFilesResponse('begin', 401, {
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
      }),
    ).toMatchObject({ failure: 'unauthenticated', message: FILES_API_MESSAGES.sessionExpired });
    expect(
      interpretFilesResponse('append', 404, {
        error: { code: 'NOT_FOUND', message: 'That file or conversation is no longer available.' },
      }),
    ).toMatchObject({ failure: 'fatal' });
    expect(
      interpretFilesResponse('append', 400, {
        error: { code: 'BAD_REQUEST', message: 'Invalid request: pages.' },
      }),
    ).toMatchObject({ failure: 'fatal' });
    // An unknown refusal code is dropped rather than passed on.
    expect(
      interpretFilesResponse('begin', 422, {
        error: { code: 'X', message: 'm', refusal: 'made_up' },
      }),
    ).not.toHaveProperty('refusal');
  });

  it('server trouble, a rate limit and an unfinished upload can be tried again; a bare failure has words too', () => {
    expect(
      interpretFilesResponse('finish', 409, {
        error: { code: 'INCOMPLETE', message: 'Not every page arrived.', retryable: true },
      }),
    ).toMatchObject({ failure: 'retryable', message: 'Not every page arrived.' });
    expect(
      interpretFilesResponse('read_page', 429, {
        error: { code: 'RATE_LIMITED', message: 'Busy.' },
      }),
    ).toMatchObject({ failure: 'retryable' });
    expect(interpretFilesResponse('read_page', 504, null)).toEqual({
      kind: 'error',
      failure: 'retryable',
      message: FILES_API_MESSAGES.unknown,
      code: 'HTTP_504',
      status: 504,
    });
    expect(
      interpretFilesResponse('begin', 418, { error: { code: 'TEAPOT', message: 'No.' } }),
    ).toMatchObject({ failure: 'fatal' });
    expect(interpretFilesResponse('begin', 403, {})).toMatchObject({
      message: FILES_API_MESSAGES.forbidden,
    });
    expect(interpretFilesResponse('read_page', 402, {})).toMatchObject({
      message: FILES_API_MESSAGES.unknown,
    });
    expect(interpretFilesResponse('begin', 422, {})).toMatchObject({
      failure: 'refused',
      message: FILES_API_MESSAGES.unknown,
    });
  });

  it('callFiles posts JSON with the session and the public key, and never throws', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchOk: typeof fetch = (input, init) => {
      seen.push({ url: typeof input === 'string' ? input : '(not a string)', init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ action: 'remove', removed: true }), { status: 200 }),
      );
    };
    const deps = { filesUrl: 'https://x.test/functions/v1/files', anonKey: 'anon', fetch: fetchOk };
    expect(await callFiles(deps, 'token', { action: 'remove', fileId: 'f1' })).toEqual({
      kind: 'ok',
      reply: { action: 'remove', removed: true },
    });
    expect(seen[0]?.url).toBe('https://x.test/functions/v1/files');
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer token',
      apikey: 'anon',
    });
    expect(seen[0]?.init.body).toBe('{"action":"remove","fileId":"f1"}');

    const down: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(
      await callFiles({ ...deps, fetch: down }, 't', { action: 'finish', fileId: 'f1' }),
    ).toEqual({
      kind: 'error',
      failure: 'retryable',
      message: FILES_API_MESSAGES.network,
      code: 'NETWORK',
      status: null,
    });
    const notJson: typeof fetch = () =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 }));
    expect(
      await callFiles({ ...deps, fetch: notJson }, 't', { action: 'finish', fileId: 'f1' }),
    ).toMatchObject({ failure: 'retryable', code: 'HTTP_502' });
  });

  it('a call that takes too long is a timeout; one the person stopped is aborted', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const deps = { filesUrl: 'https://x.test/f', anonKey: 'anon', fetch: hang, timeoutMs: 10 };
    expect(await callFiles(deps, 't', { action: 'finish', fileId: 'f1' })).toMatchObject({
      failure: 'retryable',
      message: FILES_API_MESSAGES.timeout,
      code: 'CLIENT_TIMEOUT',
    });
    const controller = new AbortController();
    const pending = callFiles(
      { ...deps, timeoutMs: 5_000 },
      't',
      { action: 'finish', fileId: 'f1' },
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({ failure: 'retryable', code: 'NETWORK' });
  });

  it('rows become files; anything unfinished or of an unknown kind is left out', () => {
    const row = (overrides: Partial<ConversationFileRow> = {}): ConversationFileRow => ({
      id: 'f1',
      conversation_id: 'c1',
      uploaded_by: 'u1',
      name: 'payslip.pdf',
      kind: 'pdf',
      byte_size: 100,
      page_count: 2,
      vision_pages: 1,
      status: 'ready',
      created_at: 'a',
      expires_at: 'b',
      source_url: null,
      source_host: null,
      fetched_at: null,
      values_missing: 0,
      read_as_sent: false,
      removed_reason: null,
      ...overrides,
    });
    expect(
      toAttachedFiles([
        row(),
        row({ id: 'f2', status: 'removed', name: null }),
        row({ id: 'f3', status: 'reading' }),
        row({ id: 'f4', kind: 'exe' }),
      ]),
    ).toEqual([
      {
        id: 'f1',
        conversationId: 'c1',
        uploadedBy: 'u1',
        name: 'payslip.pdf',
        kind: 'pdf',
        byteSize: 100,
        pageCount: 2,
        visionPages: 1,
        status: 'ready',
        createdAt: 'a',
        expiresAt: 'b',
        sourceUrl: null,
        sourceHost: null,
        fetchedAt: null,
        valuesMissing: 0,
        readAsSent: false,
        removedReason: null,
      },
      {
        id: 'f2',
        conversationId: 'c1',
        uploadedBy: 'u1',
        name: null,
        kind: 'pdf',
        byteSize: 100,
        pageCount: 2,
        visionPages: 1,
        status: 'removed',
        createdAt: 'a',
        expiresAt: 'b',
        sourceUrl: null,
        sourceHost: null,
        fetchedAt: null,
        valuesMissing: 0,
        readAsSent: false,
        removedReason: null,
      },
    ]);
    // A page read from a link carries where it came from; a reason nobody defined is no reason.
    expect(
      toAttachedFiles([
        row({
          id: 'p1',
          kind: 'html',
          name: 'Home loan rates',
          source_url: 'https://www.lender.example.org/rates',
          source_host: 'www.lender.example.org',
          fetched_at: '2026-10-12T06:14:00Z',
          values_missing: 12,
        }),
        row({ id: 'p2', kind: 'html', status: 'removed', name: null, removed_reason: 'replaced' }),
        row({ id: 'p3', status: 'removed', name: null, removed_reason: 'something-else' }),
      ]).map((file) => [
        file.id,
        file.kind,
        file.sourceHost,
        file.valuesMissing,
        file.removedReason,
      ]),
    ).toEqual([
      ['p1', 'html', 'www.lender.example.org', 12, null],
      ['p2', 'html', null, 0, 'replaced'],
      ['p3', 'pdf', null, 0, null],
    ]);
    // The browser never asks for the text or the hash: neither column is in the select.
    expect(CONVERSATION_FILE_COLUMNS).not.toMatch(/content|hash|text/);
  });

  it('the endpoint has an address beside the others', () => {
    expect(
      resolveWebConfig({ VITE_SUPABASE_URL: 'https://p.supabase.co/', VITE_SUPABASE_ANON_KEY: 'k' })
        .filesUrl,
    ).toBe('https://p.supabase.co/functions/v1/files');
  });
});

describe('what a person is shown', () => {
  it('summarises a file: kind, pages, size, and what was read from images', () => {
    expect(fileSummary(FILE)).toBe('PDF · 2 pages · 214 KB');
    expect(fileSummary({ ...FILE, pageCount: 1 })).toBe('PDF · 1 page · 214 KB');
    expect(fileSummary({ ...FILE, pageCount: 12, visionPages: 12 })).toBe(
      'PDF · 12 pages · 214 KB · 12 read from images',
    );
    expect(fileSummary({ ...FILE, pageCount: 3, visionPages: 1 })).toBe(
      'PDF · 3 pages · 214 KB · 1 read from an image',
    );
    expect(fileSummary({ ...FILE, kind: 'image', pageCount: 1, visionPages: 1 })).toBe(
      'Photo · 1 page · 214 KB · read from the image',
    );
    expect(fileSummary({ ...FILE, kind: 'xlsx', pageCount: 4 })).toBe(
      'Excel workbook · 4 parts · 214 KB',
    );
    expect(fileSummary({ ...FILE, kind: 'text', pageCount: 1 })).toBe(
      'Text file · 1 part · 214 KB',
    );
  });

  it('says how long a file is kept, and knows when its date has passed', () => {
    expect(retentionText(FILE, NOW)).toBe('Kept for 30 more days');
    expect(retentionText({ expiresAt: '2026-10-13T03:00:00Z' }, NOW)).toBe('Removed tomorrow');
    expect(retentionText({ expiresAt: '2026-10-12T04:00:01Z' }, NOW)).toBe('Removed tomorrow');
    expect(retentionText({ expiresAt: '2026-10-12T03:59:00Z' }, NOW)).toBe('Removed today');
    expect(retentionText({ expiresAt: 'nonsense' }, NOW)).toBe('');
    expect(isExpired(FILE, NOW)).toBe(false);
    expect(isExpired({ expiresAt: '2026-10-12T04:00:00Z' }, NOW)).toBe(true);
    expect(isExpired({ expiresAt: 'nonsense' }, NOW)).toBe(false);
    expect(RETENTION_HINT).toBe('Files are read on this device, kept for 30 days, then removed.');
    expect(REMOVED_FILE_TEXT).not.toContain('payslip');
    expect(EXPIRED_FILE_TEXT).toContain('30 days');
  });

  it('offers Remove to the person who attached it and to an administrator', () => {
    expect(canRemove(FILE, { userId: 'u1', isAdmin: false })).toBe(true);
    expect(canRemove(FILE, { userId: 'u2', isAdmin: true })).toBe(true);
    expect(canRemove(FILE, { userId: 'u2', isAdmin: false })).toBe(false);
  });

  it("asks before a scan is read: pages, cost, and the share of today's budget (D90)", () => {
    const estimate: VisionEstimate = {
      pages: 23,
      perPageUsd: 0.027132,
      estimateUsd: 0.624036,
      dailyCapUsd: 5,
      spentTodayUsd: 1.25,
      affordable: true,
    };
    expect(confirmText(estimate)).toBe(
      "This is a scan. 23 pages will be read as images, which costs about $0.62 — around 12% of today's $5.00 budget. $1.25 of it has been used today.",
    );
    expect(confirmButtonText(estimate)).toBe('Read 23 pages');
    expect(confirmText({ ...estimate, pages: 50, estimateUsd: 1.3566, spentTodayUsd: 0 })).toBe(
      "This is a scan. 50 pages will be read as images, which costs about $1.36 — around 27% of today's $5.00 budget.",
    );
    // A tiny share is "around 1%", never "0%"; a zero cap does not divide by zero.
    expect(confirmText({ ...estimate, pages: 2, estimateUsd: 0.01, spentTodayUsd: 0 })).toContain(
      'around 1%',
    );
    expect(confirmText({ ...estimate, dailyCapUsd: 0 })).toContain(
      "around 1% of today's $0.00 budget",
    );
  });

  it('describes each step of an upload, with an honest bar', () => {
    expect(uploadStatus(item({ phase: 'waiting' }))).toBe('Waiting for the file before it…');
    expect(uploadStatus(item({ phase: 'reading' }))).toBe('Reading the file…');
    expect(uploadStatus(item({ phase: 'reading', done: 2, total: 212 }))).toBe(
      'Reading the file… page 3 of 212',
    );
    expect(uploadStatus(item({ phase: 'sending', done: 40, total: 95 }))).toBe(
      'Sending… part 41 of 95',
    );
    expect(uploadStatus(item({ phase: 'sending', done: 0, total: 1 }))).toBe('Sending…');
    expect(uploadStatus(item({ phase: 'looking', done: 2, total: 12 }))).toBe(
      'Reading page 3 of 12 as an image…',
    );
    expect(uploadStatus(item({ phase: 'looking', done: 12, total: 12 }))).toBe(
      'Reading page 12 of 12 as an image…',
    );
    expect(uploadStatus(item({ phase: 'finishing' }))).toBe('Finishing…');
    for (const phase of ['confirm', 'failed', 'refused'] as const)
      expect(uploadStatus(item({ phase }))).toBeNull();

    expect(uploadPercent(item({ phase: 'reading', done: 0, total: 0 }))).toBeNull();
    expect(uploadPercent(item({ phase: 'looking', done: 3, total: 12 }))).toBe(25);
    expect(uploadPercent(item({ phase: 'sending', done: 95, total: 95 }))).toBe(100);
    expect(uploadPercent(item({ phase: 'reading', done: 500, total: 3 }))).toBe(100);
    expect(uploadPercent(item({ phase: 'confirm', done: 0, total: 12 }))).toBeNull();
    expect(uploadPercent(item({ phase: 'failed', done: 3, total: 12 }))).toBeNull();
  });

  it('says why Send is waiting', () => {
    expect(busyNote([])).toBeNull();
    expect(busyNote([item({ phase: 'failed' }), item({ phase: 'refused' })])).toBeNull();
    expect(busyNote([item({ phase: 'looking' })])).toBe(
      'Wait for statement.pdf to finish before you send.',
    );
    expect(busyNote([item({ phase: 'confirm' })])).toBe(
      'Choose whether to read statement.pdf before you send.',
    );
  });
});

describe('the thread as a timeline of messages and files', () => {
  const message = (localId: string, createdAt?: string): ThreadMessage => ({
    localId,
    id: createdAt === undefined ? null : localId,
    role: 'user',
    content: localId,
    status: createdAt === undefined ? 'sending' : 'saved',
    ...(createdAt === undefined ? {} : { createdAt }),
  });
  const fileAt = (id: string, createdAt: string): AttachedFile => ({ ...FILE, id, createdAt });
  const keys = (messages: ThreadMessage[], files: AttachedFile[]): string[] =>
    timeline(messages, files).map((entry) => entry.key);

  it('a file sits where it was attached, between the messages around it', () => {
    expect(
      keys(
        [
          message('m1', '2026-10-12T01:00:00Z'),
          message('m2', '2026-10-12T03:00:00Z'),
          message('m3', '2026-10-12T05:00:00Z'),
        ],
        [fileAt('late', '2026-10-12T04:00:00Z'), fileAt('early', '2026-10-12T02:00:00Z')],
      ),
    ).toEqual(['message-m1', 'file-early', 'message-m2', 'file-late', 'message-m3']);
  });

  it('a message only just sent comes after every file already attached', () => {
    expect(
      keys(
        [message('m1', '2026-10-12T01:00:00Z'), message('just-sent')],
        [fileAt('f', '2026-10-12T02:00:00Z')],
      ),
    ).toEqual(['message-m1', 'file-f', 'message-just-sent']);
  });

  it('files with no messages, messages with no files, and nothing at all', () => {
    expect(keys([], [fileAt('f', 'a')])).toEqual(['file-f']);
    expect(keys([message('m1', 'a')], [])).toEqual(['message-m1']);
    expect(keys([], [])).toEqual([]);
    // A file attached after the last saved message is at the end.
    expect(
      keys([message('m1', '2026-10-12T01:00:00Z')], [fileAt('f', '2026-10-12T02:00:00Z')]),
    ).toEqual(['message-m1', 'file-f']);
  });
});

describe('the thread store and files', () => {
  function store(): ReturnType<typeof createThreadStore> {
    return createThreadStore({
      storage: null,
      loadMessages: () => Promise.resolve([]),
      streamTurn: () =>
        Promise.resolve({
          kind: 'ok',
          conversationId: 'c-new',
          userMessageId: 'u1',
          assistantMessageId: 'a1',
          reply: 'cut off here',
          truncated: true,
        }),
      getAccessToken: () => Promise.resolve('t'),
      onSessionExpired: () => Promise.resolve(),
    });
  }

  it('an upload to a new conversation moves the thread onto it, keeping the draft', () => {
    const s = store();
    s.setDraft('half a question');
    s.adoptConversation('c-new');
    expect(s.getState()).toMatchObject({
      activeId: 'c-new',
      draft: 'half a question',
      initialised: true,
      messages: [],
    });
    // Already on a conversation: an upload elsewhere does not move it.
    s.adoptConversation('c-other');
    expect(s.getState().activeId).toBe('c-new');
  });

  it('a reply that stopped at the length limit is marked, so it is never shown as whole', async () => {
    const s = store();
    await s.send('List every transaction', null);
    const reply = s.getState().messages.at(-1);
    expect(reply).toMatchObject({ role: 'assistant', content: 'cut off here', truncated: true });
    expect(s.getState().messages[0]).not.toHaveProperty('truncated');
  });

  it('chatApi reads the stop reason: only max_tokens is a cut-off', () => {
    const body = {
      conversationId: 'c',
      userMessageId: 'u',
      assistantMessageId: 'a',
      reply: 'text',
    };
    expect(interpretChatResponse(200, { ...body, stopReason: 'max_tokens' })).toMatchObject({
      kind: 'ok',
      truncated: true,
    });
    expect(interpretChatResponse(200, { ...body, stopReason: 'end_turn' })).not.toHaveProperty(
      'truncated',
    );
    expect(interpretChatResponse(200, body)).not.toHaveProperty('truncated');
  });
});
