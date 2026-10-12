/**
 * supabase-js adapter for attached files (src/lib/files/store.ts) against a stubbed global
 * fetch serving PostgREST-shaped responses: each function with its arguments, the database's
 * refusals (FL001–FL006, 02000) turned into reasons, what a turn loads — and what it does not
 * load — and that an error from here never carries a file's name or text.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONVERSATION_FILE_COLUMNS } from '../../../web/src/lib/filesApi.js';

import { FILE_LIMITS } from '../../../src/lib/files/limits.js';
import {
  createFilesServiceClient,
  fileStoreReason,
  supabaseFileStore,
  type FileStore,
} from '../../../src/lib/files/store.js';
import { AppError } from '../../../src/lib/errors.js';
import { CANARY_NAME, CANARY_TEXT, CONV_ID, HASH, USER_ID } from './helpers.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const FILE_ID = 'f1000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-12T04:00:00Z');

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
  headers: Record<string, string>;
}

const seen: Seen[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function pgError(code: string, message = 'refused'): Response {
  return json({ code, message, details: null, hint: null }, 400);
}

function stub(handler: (req: Seen) => Response | undefined): void {
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const req: Seen = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: decodeURIComponent(url.search),
        body: typeof init?.body === 'string' ? init.body : '',
        headers,
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

function store(): FileStore {
  return supabaseFileStore(createFilesServiceClient(CONFIG), () => NOW);
}

const FILE_ROW = {
  id: FILE_ID,
  conversation_id: CONV_ID,
  user_id: USER_ID,
  scope: 'workspace',
  uploaded_by: USER_ID,
  name: 'payslip.pdf',
  kind: 'pdf',
  byte_size: 4651,
  expected_pages: 2,
  vision_pages: 0,
  page_count: 2,
  char_count: 40,
  status: 'ready',
  created_at: '2026-10-12T03:00:00Z',
  expires_at: '2026-11-11T03:00:00Z',
};

const BEGIN = {
  conversationId: CONV_ID,
  uploadedBy: USER_ID,
  requestId: 'd3b07384-d9a0-4f7b-8a5c-000000000001',
  name: 'payslip.pdf',
  kind: 'pdf' as const,
  byteSize: 4651,
  contentHash: HASH('a'),
  expectedPages: 2,
  visionPages: 0,
  retentionDays: 30,
};

describe('begin', () => {
  it('calls the function with the limits the server enforces, and reads the row back', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/begin_conversation_file'
        ? json([
            {
              id: FILE_ID,
              status: 'reading',
              existing: false,
              duplicate: false,
              expected_pages: 2,
              pages_stored: [],
            },
          ])
        : undefined,
    );
    expect(await store().begin(BEGIN)).toEqual({
      ok: true,
      value: {
        id: FILE_ID,
        status: 'reading',
        existing: false,
        duplicate: false,
        expectedPages: 2,
        pagesStored: [],
      },
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_conversation_id: CONV_ID,
      p_uploaded_by: USER_ID,
      p_request_id: BEGIN.requestId,
      p_name: 'payslip.pdf',
      p_kind: 'pdf',
      p_byte_size: 4651,
      p_content_hash: HASH('a'),
      p_expected_pages: 2,
      p_vision_pages: 0,
      p_retention_days: 30,
      p_max_files: FILE_LIMITS.maxFilesPerConversation,
      p_abandoned_minutes: FILE_LIMITS.abandonedAfterMinutes,
    });
    expect(seen[0]?.method).toBe('POST');
  });

  it('a replay hands back the stored pages; a duplicate is flagged', async () => {
    stub(() =>
      json([
        {
          id: FILE_ID,
          status: 'ready',
          existing: true,
          duplicate: true,
          expected_pages: 2,
          pages_stored: [1, 2],
        },
      ]),
    );
    const result = await store().begin(BEGIN);
    expect(result.ok && result.value).toMatchObject({
      existing: true,
      duplicate: true,
      status: 'ready',
      pagesStored: [1, 2],
    });
  });

  it.each([
    ['FL001', 'too_many_files'],
    ['02000', 'not_found'],
  ])('SQLSTATE %s becomes the reason %s', async (code, reason) => {
    stub(() => pgError(code, `conversation holds ${CANARY_NAME}`));
    const result = await store().begin(BEGIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(fileStoreReason(result.error)).toBe(reason);
    expect(result.error.code).toBe('CONFLICT');
    // Whatever Postgres said is not carried: only the reason is.
    expect(JSON.stringify(result.error)).not.toContain('CANARY');
  });

  it('no row, an unknown status, a database error and a transport failure are typed', async () => {
    stub(() => json([]));
    expect((await store().begin(BEGIN)).ok).toBe(false);
    stub(() =>
      json([
        {
          id: FILE_ID,
          status: 'weird',
          existing: false,
          duplicate: false,
          expected_pages: 1,
          pages_stored: [],
        },
      ]),
    );
    expect((await store().begin(BEGIN)).ok).toBe(false);
    stub(() => pgError('42P01', `relation missing ${CANARY_TEXT}`));
    const failed = await store().begin(BEGIN);
    expect(!failed.ok && failed.error.code).toBe('HTTP_STATUS');
    expect(!failed.ok && fileStoreReason(failed.error)).toBeNull();
    expect(!failed.ok && JSON.stringify(failed.error)).not.toContain('CANARY');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const down = await store().begin(BEGIN);
    expect(!down.ok && down.error.code).toBe('NETWORK');
  });
});

describe('pages', () => {
  it('appendPages sends the pages with their provenance and returns the count stored', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/append_conversation_file_pages' ? json(2) : undefined,
    );
    const stored = await store().appendPages(FILE_ID, [
      {
        pageNo: 1,
        label: 'Page 1',
        content: 'one',
        method: 'pdf_text_layer',
        confidence: 1,
        legibility: 'full',
        letterCount: 3,
      },
      {
        pageNo: 2,
        label: 'Page 2',
        content: 'two',
        method: 'claude_vision',
        confidence: 0.6,
        legibility: 'partial',
        letterCount: 3,
      },
    ]);
    expect(stored).toEqual({ ok: true, value: 2 });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_file_id: FILE_ID,
      p_pages: [
        {
          page_no: 1,
          label: 'Page 1',
          content: 'one',
          extraction_method: 'pdf_text_layer',
          confidence: 1,
          legibility: 'full',
          letter_count: 3,
        },
        {
          page_no: 2,
          label: 'Page 2',
          content: 'two',
          extraction_method: 'claude_vision',
          confidence: 0.6,
          legibility: 'partial',
          letter_count: 3,
        },
      ],
    });
  });

  it.each([
    ['FL002', 'not_reading'],
    ['FL003', 'page_out_of_range'],
  ])('appendPages: SQLSTATE %s becomes %s', async (code, reason) => {
    stub(() => pgError(code));
    const result = await store().appendPages(FILE_ID, []);
    expect(!result.ok && fileStoreReason(result.error)).toBe(reason);
  });

  it('pageInfo answers whether a page is stored, with sizes and not its text', async () => {
    stub((req) =>
      req.path === '/rest/v1/conversation_file_pages'
        ? json([
            {
              page_no: 2,
              extraction_method: 'claude_vision',
              legibility: 'partial',
              letter_count: 9,
              content: CANARY_TEXT,
            },
          ])
        : undefined,
    );
    const info = await store().pageInfo(FILE_ID, 2);
    expect(info).toEqual({
      ok: true,
      value: {
        pageNo: 2,
        method: 'claude_vision',
        legibility: 'partial',
        chars: CANARY_TEXT.length,
        letterCount: 9,
      },
    });
    expect(JSON.stringify(info)).not.toContain('CANARY');
    expect(seen[0]?.query).toContain(`file_id=eq.${FILE_ID}`);
    expect(seen[0]?.query).toContain('page_no=eq.2');
    stub(() => json([]));
    expect(await store().pageInfo(FILE_ID, 9)).toEqual({ ok: true, value: null });
    stub(() =>
      json([
        {
          page_no: 1,
          extraction_method: 'ocr_service',
          legibility: 'full',
          letter_count: 1,
          content: 'x',
        },
      ]),
    );
    expect((await store().pageInfo(FILE_ID, 1)).ok).toBe(false);
    stub(() => pgError('42501'));
    expect((await store().pageInfo(FILE_ID, 1)).ok).toBe(false);
  });

  it('visionPagesStored counts with a HEAD request and reads the range header', async () => {
    stub((req) =>
      req.method === 'HEAD' ? json(null, 200, { 'Content-Range': '0-6/7' }) : undefined,
    );
    expect(await store().visionPagesStored(FILE_ID)).toEqual({ ok: true, value: 7 });
    expect(seen[0]?.query).toContain('extraction_method=eq.claude_vision');
    stub(() => json(null, 200, { 'Content-Range': '*/0' }));
    expect(await store().visionPagesStored(FILE_ID)).toEqual({ ok: true, value: 0 });
  });
});

describe('finish, remove, purge, get', () => {
  it('finish passes the length limit and maps the row', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/finish_conversation_file'
        ? json([
            {
              id: FILE_ID,
              duplicate: false,
              already: false,
              page_count: 2,
              char_count: 40,
              vision_pages: 1,
              confidence: 0.9,
            },
          ])
        : undefined,
    );
    expect(await store().finish(FILE_ID, USER_ID)).toEqual({
      ok: true,
      value: {
        id: FILE_ID,
        duplicate: false,
        already: false,
        pageCount: 2,
        charCount: 40,
        visionPages: 1,
      },
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_file_id: FILE_ID,
      p_actor: USER_ID,
      p_max_chars: FILE_LIMITS.maxFileChars,
    });
  });

  it.each([
    ['FL004', 'incomplete'],
    ['FL005', 'no_text'],
    ['FL006', 'too_long'],
    ['FL002', 'not_reading'],
  ])('finish: SQLSTATE %s becomes %s', async (code, reason) => {
    stub(() => pgError(code));
    const result = await store().finish(FILE_ID, USER_ID);
    expect(!result.ok && fileStoreReason(result.error)).toBe(reason);
    stub(() => json([]));
    expect((await store().finish(FILE_ID, USER_ID)).ok).toBe(false);
  });

  it("remove is always a person's removal; purge uses the abandoned cut-off", async () => {
    stub((req) => {
      if (req.path === '/rest/v1/rpc/remove_conversation_file') return json(true);
      if (req.path === '/rest/v1/rpc/purge_conversation_files')
        return json([{ abandoned: 2, expired: 1 }]);
      return undefined;
    });
    expect(await store().remove(FILE_ID, USER_ID)).toEqual({ ok: true, value: true });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_file_id: FILE_ID,
      p_actor: USER_ID,
      p_reason: 'user',
    });
    expect(await store().purge()).toEqual({ ok: true, value: { abandoned: 2, expired: 1 } });
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({ p_abandoned_minutes: 15 });
    stub(() => json([]));
    expect(await store().purge()).toEqual({ ok: true, value: { abandoned: 0, expired: 0 } });
    stub(() => pgError('42501'));
    expect((await store().remove(FILE_ID, USER_ID)).ok).toBe(false);
    expect((await store().purge()).ok).toBe(false);
  });

  it('get maps a row, answers null for none, and refuses a row outside its constraints', async () => {
    stub(() => json([FILE_ROW]));
    expect(await store().get(FILE_ID)).toEqual({
      ok: true,
      value: {
        id: FILE_ID,
        conversationId: CONV_ID,
        uploadedBy: USER_ID,
        name: 'payslip.pdf',
        kind: 'pdf',
        byteSize: 4651,
        pageCount: 2,
        charCount: 40,
        visionPages: 0,
        status: 'ready',
        createdAt: '2026-10-12T03:00:00Z',
        expiresAt: '2026-11-11T03:00:00Z',
        expectedPages: 2,
        conversationAuthorId: USER_ID,
        scope: 'workspace',
      },
    });
    // The hash is never selected: nothing above this layer needs it.
    expect(seen[0]?.query).not.toContain('content_hash');
    stub(() => json([]));
    expect(await store().get(FILE_ID)).toEqual({ ok: true, value: null });
    stub(() => json([{ ...FILE_ROW, kind: 'exe' }]));
    expect((await store().get(FILE_ID)).ok).toBe(false);
    stub(() => json([{ ...FILE_ROW, scope: 'public' }]));
    expect((await store().get(FILE_ID)).ok).toBe(false);
    stub(() => pgError('42501'));
    expect((await store().get(FILE_ID)).ok).toBe(false);
  });
});

describe('forTurn — what a turn may read', () => {
  const fileRow = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    name: `${id}.pdf`,
    kind: 'pdf',
    status: 'ready',
    created_at: '2026-10-12T03:00:00Z',
    expires_at: '2026-11-11T03:00:00Z',
    ...extra,
  });
  const pageRow = (
    fileId: string,
    pageNo: number,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    file_id: fileId,
    page_no: pageNo,
    label: `Page ${String(pageNo)}`,
    content: `text ${fileId} ${String(pageNo)}`,
    extraction_method: 'pdf_text_layer',
    legibility: 'full',
    ...extra,
  });

  it('loads only ready, unexpired files, with their pages in order', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') {
        return json([
          fileRow('live'),
          fileRow('expired', { expires_at: '2026-10-12T03:59:59Z' }),
          fileRow('removed', { status: 'removed', name: null }),
        ]);
      }
      if (req.path === '/rest/v1/conversation_file_pages') {
        return json([
          pageRow('live', 1),
          pageRow('live', 2, { extraction_method: 'claude_vision', legibility: 'partial' }),
        ]);
      }
      return undefined;
    });
    const loaded = await store().forTurn(CONV_ID);
    expect(loaded).toEqual({
      ok: true,
      value: {
        everHadFile: true,
        files: [
          {
            id: 'live',
            name: 'live.pdf',
            kind: 'pdf',
            createdAt: '2026-10-12T03:00:00Z',
            pages: [
              {
                pageNo: 1,
                label: 'Page 1',
                content: 'text live 1',
                method: 'pdf_text_layer',
                legibility: 'full',
              },
              {
                pageNo: 2,
                label: 'Page 2',
                content: 'text live 2',
                method: 'claude_vision',
                legibility: 'partial',
              },
            ],
          },
        ],
      },
    });
    // Never an upload still in progress, and pages only for the files that are live.
    expect(seen[0]?.query).toContain(`conversation_id=eq.${CONV_ID}`);
    expect(seen[0]?.query).toContain('status=in.(ready,removed)');
    expect(seen[1]?.query).toContain('file_id=in.(live)');
  });

  it('expiry is decided on the instant, however the database spells the time', async () => {
    // NOW is 04:00:00Z. One second before it and one second after it, written the way
    // Postgres writes a timestamptz in a session that is not on UTC. Compared as text the
    // first reads as "later than now" (13 > 04) and a file past its date would be loaded.
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') {
        return json([
          fileRow('past', { expires_at: '2026-10-12T13:59:59+10:00' }),
          fileRow('future', { expires_at: '2026-10-11T23:00:01.250000-05:00' }),
        ]);
      }
      return json([pageRow('future', 1)]);
    });
    const loaded = await store().forTurn(CONV_ID);
    expect(loaded.ok && loaded.value.files.map((file) => file.id)).toEqual(['future']);
    expect(seen[1]?.query).toContain('file_id=in.(future)');
  });

  it('a conversation with no files asks for no pages; one whose files are all gone still "had" one', async () => {
    stub((req) => (req.path === '/rest/v1/conversation_files' ? json([]) : undefined));
    expect(await store().forTurn(CONV_ID)).toEqual({
      ok: true,
      value: { files: [], everHadFile: false },
    });
    expect(seen).toHaveLength(1);
    seen.length = 0;
    stub((req) =>
      req.path === '/rest/v1/conversation_files'
        ? json([fileRow('gone', { status: 'removed', name: null })])
        : undefined,
    );
    expect(await store().forTurn(CONV_ID)).toEqual({
      ok: true,
      value: { files: [], everHadFile: true },
    });
    expect(seen).toHaveLength(1);
  });

  it('reads pages in slices until a short one', async () => {
    let call = 0;
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') return json([fileRow('big')]);
      if (req.path === '/rest/v1/conversation_file_pages') {
        call += 1;
        const from = (call - 1) * 500;
        const count = call === 1 ? 500 : 120;
        return json(Array.from({ length: count }, (_, i) => pageRow('big', from + i + 1)));
      }
      return undefined;
    });
    const loaded = await store().forTurn(CONV_ID);
    expect(loaded.ok && loaded.value.files[0]?.pages).toHaveLength(620);
    // Two slices of 500, the second starting where the first ended.
    const slices = seen
      .filter((req) => req.path === '/rest/v1/conversation_file_pages')
      .map((req) => new URLSearchParams(req.query));
    expect(slices.map((query) => query.get('limit'))).toEqual(['500', '500']);
    expect(slices.map((query) => query.get('offset') ?? '0')).toEqual(['0', '500']);
  });

  it('a failure reading files or pages fails the load — never "no files"', async () => {
    stub(() => pgError('42501'));
    expect((await store().forTurn(CONV_ID)).ok).toBe(false);
    stub((req) =>
      req.path === '/rest/v1/conversation_files' ? json([fileRow('live')]) : pgError('57014'),
    );
    expect((await store().forTurn(CONV_ID)).ok).toBe(false);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const down = await store().forTurn(CONV_ID);
    expect(!down.ok && down.error.code).toBe('NETWORK');
  });

  it('a page row with an unknown method is left out rather than shown under a false label', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') return json([fileRow('live')]);
      return json([pageRow('live', 1, { extraction_method: 'guesswork' }), pageRow('live', 2)]);
    });
    const loaded = await store().forTurn(CONV_ID);
    expect(loaded.ok && loaded.value.files[0]?.pages.map((p) => p.pageNo)).toEqual([2]);
  });
});

/**
 * The stack suites (tests/integration/files.test.ts) run this adapter against the real
 * functions, in CI. This machine has no stack, so the one mistake those suites exist to catch
 * — an argument or a column spelled differently here than in the migration — is also caught
 * here, by reading the migration.
 */
describe('the adapter and the migration agree', () => {
  const sql = readFileSync(
    new URL('../../../supabase/migrations/20261012010000_conversation_files.sql', import.meta.url),
    'utf8',
  );

  function declaration(fn: string): string {
    const start = sql.indexOf(`create or replace function public.${fn}(`);
    expect(start, `${fn} is declared`).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf('language plpgsql', start));
  }
  /** The whole function, body included. */
  function definition(fn: string): string {
    const start = sql.indexOf(`create or replace function public.${fn}(`);
    return sql.slice(start, sql.indexOf('\n$$;', start));
  }
  /** `p_name type` on its own line: the parameters, in order. */
  const parameters = (fn: string): string[] =>
    [...declaration(fn).matchAll(/^ {2}(p_\w+) /gm)].map((match) => match[1] ?? '');
  /** The names in `returns table (...)`. */
  function returned(fn: string): string[] {
    const body = /returns table \(([^)]*)\)/.exec(declaration(fn))?.[1] ?? '';
    return [...body.matchAll(/(\w+) (?:uuid|text|boolean|integer|numeric)/g)].map(
      (match) => match[1] ?? '',
    );
  }
  /** The column names of `create table public.<table>`. */
  function columns(table: string): string[] {
    const start = sql.indexOf(`create table public.${table} (`);
    expect(start, `${table} is created`).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf('\n);', start));
    return [
      ...body.matchAll(/^ {2}(\w+) (?:uuid|text|bigint|integer|numeric|timestamptz|boolean)\b/gm),
    ].map((match) => match[1] ?? '');
  }
  const selected = (req: Seen | undefined): string[] =>
    (new URLSearchParams(req?.query ?? '').get('select') ?? '')
      .split(',')
      .map((column) => column.trim());
  const sent = (path: string): string[] =>
    Object.keys(
      JSON.parse(seen.find((req) => req.path === path)?.body ?? '{}') as Record<string, unknown>,
    );

  it('every function is called with exactly the parameters it declares', async () => {
    stub((req) => (req.path.startsWith('/rest/v1/rpc/') ? json([]) : undefined));
    const s = store();
    await s.begin(BEGIN);
    await s.appendPages(FILE_ID, []);
    await s.finish(FILE_ID, USER_ID);
    await s.remove(FILE_ID, USER_ID);
    await s.purge();
    for (const fn of [
      'begin_conversation_file',
      'append_conversation_file_pages',
      'finish_conversation_file',
      'remove_conversation_file',
      'purge_conversation_files',
    ]) {
      const declared = parameters(fn);
      expect(declared.length, fn).toBeGreaterThan(0);
      expect(sent(`/rest/v1/rpc/${fn}`).sort(), fn).toEqual([...declared].sort());
    }
  });

  it('the rows the functions return carry the names the adapter reads', () => {
    expect(returned('begin_conversation_file')).toEqual([
      'id',
      'status',
      'existing',
      'duplicate',
      'expected_pages',
      'pages_stored',
    ]);
    expect(returned('finish_conversation_file')).toEqual([
      'id',
      'duplicate',
      'already',
      'page_count',
      'char_count',
      'vision_pages',
      'confidence',
    ]);
    expect(returned('purge_conversation_files')).toEqual(['abandoned', 'expired']);
  });

  it('a page is stored with exactly the fields the function reads out of the JSON', async () => {
    stub((req) => (req.path.startsWith('/rest/v1/rpc/') ? json(1) : undefined));
    await store().appendPages(FILE_ID, [
      {
        pageNo: 1,
        label: 'Page 1',
        content: 'text',
        method: 'pdf_text_layer',
        confidence: 1,
        legibility: 'full',
        letterCount: 4,
      },
    ]);
    const body = JSON.parse(seen[0]?.body ?? '{}') as { p_pages: Record<string, unknown>[] };
    const read = /jsonb_to_recordset\(p_pages\) as x\(\s*([^)]*)\)\s*on conflict/.exec(
      definition('append_conversation_file_pages'),
    )?.[1];
    const fields = [...(read ?? '').matchAll(/(\w+) (?:integer|text|numeric)/g)].map(
      (match) => match[1] ?? '',
    );
    expect(fields).toHaveLength(7);
    expect(Object.keys(body.p_pages[0] ?? {}).sort()).toEqual([...fields].sort());
    // …and each of them is a column of the table it is inserted into.
    for (const field of fields) expect(columns('conversation_file_pages')).toContain(field);
  });

  it('every column the adapter selects or filters on exists in its table', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') return json([{ ...FILE_ROW, id: 'live' }]);
      if (req.path === '/rest/v1/conversation_file_pages') return json([]);
      return undefined;
    });
    const s = store();
    await s.get(FILE_ID);
    await s.pageInfo(FILE_ID, 1);
    await s.visionPagesStored(FILE_ID);
    await s.forTurn(CONV_ID);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const req of seen) {
      const table = req.path.replace('/rest/v1/', '');
      const known = columns(table);
      expect(known.length, table).toBeGreaterThan(5);
      const filters = [...new URLSearchParams(req.query).keys()].filter(
        (key) => !['select', 'limit', 'offset', 'order'].includes(key),
      );
      const ordered = (new URLSearchParams(req.query).get('order') ?? '')
        .split(',')
        .map((part) => part.split('.')[0] ?? '')
        .filter((part) => part !== '');
      for (const column of [...selected(req), ...filters, ...ordered]) {
        expect(known, `${table}.${column}`).toContain(column);
      }
    }
  });

  it('every refusal the functions raise is one the adapter can name', async () => {
    const raised = [
      ...new Set([...sql.matchAll(/using errcode = '(\w+)'/g)].map((match) => match[1] ?? '')),
    ].sort();
    expect(raised).toEqual(['02000', 'FL001', 'FL002', 'FL003', 'FL004', 'FL005', 'FL006']);
    const reasons: (string | null)[] = [];
    for (const code of raised) {
      stub(() => pgError(code));
      const result = await store().finish(FILE_ID, USER_ID);
      reasons.push(result.ok ? null : fileStoreReason(result.error));
    }
    expect(reasons).not.toContain(null);
    // Seven codes, seven different reasons: none of them is swallowed by another.
    expect(new Set(reasons).size).toBe(raised.length);
  });

  it('what the browser reads is a table column too, and never the text or the hash', () => {
    const known = columns('conversation_files');
    const asked = CONVERSATION_FILE_COLUMNS.split(',').map((column) => column.trim());
    for (const column of asked) expect(known, column).toContain(column);
    expect(asked).not.toContain('content_hash');
    expect(asked).not.toContain('request_id');
  });

  it('there is no bucket, and so no file URL to guess: nothing in this part touches Storage', () => {
    // "Can a file URL be guessed?" The original file is never stored (D84), so there is no
    // object and no URL. This holds only while nobody adds a bucket or a Storage call here.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/storage\./i);
    expect(statements).not.toMatch(/\bbucket/i);
    const root = new URL('../../../', import.meta.url);
    const sources = [
      'src/lib/files',
      'src/functions/files',
      'web/src/lib/files',
      'web/src/lib/filesApi.ts',
      'web/src/lib/uploads.ts',
      'web/src/components/FileItems.tsx',
      'web/src/components/UploadsContext.tsx',
    ].flatMap((path) => {
      const at = new URL(path, root);
      return statSync(at).isDirectory()
        ? readdirSync(at)
            .filter((name) => /\.tsx?$/.test(name))
            .map((name) => new URL(`${path}/${name}`, root))
        : [at];
    });
    expect(sources.length).toBeGreaterThan(20);
    for (const source of sources) {
      const code = readFileSync(source, 'utf8');
      expect(code, source.pathname).not.toMatch(/\.storage\s*\.|storage\.from\(|createSignedUrl/);
    }
  });
});

describe('fileStoreReason', () => {
  it('reads only the reasons this store sets', () => {
    expect(
      fileStoreReason(new AppError('CONFLICT', 'x', { context: { reason: 'incomplete' } })),
    ).toBe('incomplete');
    expect(
      fileStoreReason(new AppError('CONFLICT', 'x', { context: { reason: 'something_else' } })),
    ).toBeNull();
    expect(fileStoreReason(new AppError('NETWORK', 'x'))).toBeNull();
  });
});
