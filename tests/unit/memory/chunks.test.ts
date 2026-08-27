/**
 * supabase-js chunk store (src/lib/memory/chunks.ts) against a stubbed global fetch serving
 * PostgREST-shaped responses: the coverage read, the ordinal window, the insert shape (the
 * vector and the range travel as text), and the exclusion violation reported as `exists`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServiceClient } from '../../../src/lib/auth/clients.js';
import { supabaseChunkStore } from '../../../src/lib/memory/chunks.js';
import { CONV_ID, FIXTURE_VECTOR, USER_ID } from './helpers.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
  range: string | null;
  prefer: string | null;
}

const seen: Seen[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function stub(handler: (req: Seen) => Response | undefined): void {
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const headers = new Headers(init?.headers);
      const req: Seen = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        body: typeof init?.body === 'string' ? init.body : '',
        range: headers.get('range'),
        prefer: headers.get('prefer'),
      };
      seen.push(req);
      const response = handler(req);
      if (response === undefined)
        throw new Error(`unstubbed: ${req.method} ${req.path}${req.query}`);
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

describe('coverage', () => {
  it('counts every message and parses the ranges into the next uncovered ordinal', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/messages') {
        return json([], 200, { 'content-range': '0-0/24' });
      }
      if (req.path === '/rest/v1/memory_chunks') {
        return json([{ turn_range: '[1,11)' }, { turn_range: '[11,21)' }]);
      }
      return undefined;
    });
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const result = await store.coverage(CONV_ID);
    expect(result).toEqual({
      ok: true,
      value: {
        messageCount: 24,
        nextOrdinal: 21,
        ranges: [
          { lo: 1, hi: 11 },
          { lo: 11, hi: 21 },
        ],
      },
    });
    expect(seen[0]?.query).toContain(`conversation_id=eq.${CONV_ID}`);
    expect(seen[0]?.prefer).toContain('count=exact');
  });

  it('an empty conversation has count 0 and next ordinal 1', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/messages') return json([], 200, { 'content-range': '*/0' });
      if (req.path === '/rest/v1/memory_chunks') return json([]);
      return undefined;
    });
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    expect(await store.coverage(CONV_ID)).toEqual({
      ok: true,
      value: { messageCount: 0, nextOrdinal: 1, ranges: [] },
    });
  });

  it('a malformed range in the table is a VALIDATION error, not a guess', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/messages') return json([], 200, { 'content-range': '0-0/2' });
      if (req.path === '/rest/v1/memory_chunks') return json([{ turn_range: 'empty' }]);
      return undefined;
    });
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const result = await store.coverage(CONV_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
  });

  it('maps a PostgREST error to HTTP_STATUS and a transport failure to NETWORK', async () => {
    stub(() => json({ message: 'boom', code: '42P01' }, 500));
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const failed = await store.coverage(CONV_ID);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe('HTTP_STATUS');

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const down = await supabaseChunkStore(createServiceClient(CONFIG)).coverage(CONV_ID);
    expect(down.ok).toBe(false);
    if (down.ok) return;
    expect(down.error.code).toBe('NETWORK');
  });
});

describe('messagesInRange', () => {
  it('asks for the ordinal window with a Range header and numbers the rows', async () => {
    stub((req) => {
      if (req.path !== '/rest/v1/messages') return undefined;
      return json([
        { role: 'user', content: 'a', created_at: '2026-08-25T09:00:00Z' },
        { role: 'assistant', content: 'b', created_at: '2026-08-25T09:01:00Z' },
        { role: 'tool', content: null, created_at: '2026-08-25T09:02:00Z' },
      ]);
    });
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const result = await store.messagesInRange(CONV_ID, { lo: 11, hi: 14 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((m) => [m.ordinal, m.role, m.content])).toEqual([
      [11, 'user', 'a'],
      [12, 'assistant', 'b'],
      [13, 'tool', null],
    ]);
    expect(result.value[0]?.createdAt.toISOString()).toBe('2026-08-25T09:00:00.000Z');
    expect(seen[0]?.query).toContain('offset=10');
    expect(seen[0]?.query).toContain('limit=3');
    expect(seen[0]?.query).toContain('order=created_at.asc%2Cid.asc');
  });

  it('an empty range makes no request', async () => {
    stub(() => undefined);
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    expect(await store.messagesInRange(CONV_ID, { lo: 5, hi: 5 })).toEqual({ ok: true, value: [] });
    expect(seen).toHaveLength(0);
  });
});

describe('insertChunk', () => {
  const input = {
    conversationId: CONV_ID,
    userId: USER_ID,
    scope: 'workspace' as const,
    summary: 'The user asked about offset accounts.',
    audience: 'tradies',
    embedding: FIXTURE_VECTOR,
    range: { lo: 1, hi: 11 },
  };

  it('sends the vector as text and the range in canonical form', async () => {
    stub((req) => (req.path === '/rest/v1/memory_chunks' ? json([], 201) : undefined));
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    expect(await store.insertChunk(input)).toEqual({ ok: true, value: 'inserted' });
    const body = JSON.parse(seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['turn_range']).toBe('[1,11)');
    expect(body['scope']).toBe('workspace');
    expect(body['summary']).toBe(input.summary);
    expect(body['audience']).toBe('tradies');
    expect(typeof body['embedding']).toBe('string');
    expect(JSON.parse(body['embedding'] as string)).toHaveLength(1024);
  });

  it('reports the exclusion violation as exists — the database refused a duplicate range', async () => {
    stub(() =>
      json(
        {
          code: '23P01',
          message: 'conflicting key value violates exclusion constraint',
          details: '',
          hint: null,
        },
        409,
      ),
    );
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    expect(await store.insertChunk(input)).toEqual({ ok: true, value: 'exists' });
  });

  it('any other refusal is an error', async () => {
    stub(() => json({ code: '23514', message: 'check constraint', details: '', hint: null }, 400));
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const result = await store.insertChunk(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(result.error.context['supabaseCode']).toBe('23514');
  });
});

describe('idleConversations', () => {
  it('lists live conversations last active on or before the cutoff', async () => {
    stub((req) =>
      req.path === '/rest/v1/conversations'
        ? json([{ id: CONV_ID, user_id: USER_ID, scope: 'user', title: 'Draft' }])
        : undefined,
    );
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const result = await store.idleConversations(new Date('2026-08-25T00:00:00Z'), 5);
    expect(result).toEqual({
      ok: true,
      value: [{ id: CONV_ID, userId: USER_ID, scope: 'user', title: 'Draft' }],
    });
    expect(seen[0]?.query).toContain('select=id%2Cuser_id%2Cscope%2Ctitle');
    expect(seen[0]?.query).toContain('deleted_at=is.null');
    expect(seen[0]?.query).toContain('last_active_at=lte.2026-08-25T00%3A00%3A00.000Z');
    expect(seen[0]?.query).toContain('limit=5');
  });

  it('refuses a scope outside the check constraint', async () => {
    stub(() => json([{ id: CONV_ID, user_id: USER_ID, scope: 'org' }]));
    const store = supabaseChunkStore(createServiceClient(CONFIG));
    const result = await store.idleConversations(new Date(), 5);
    expect(result.ok).toBe(false);
  });
});
