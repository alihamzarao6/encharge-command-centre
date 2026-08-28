/**
 * supabase-js adapters (src/lib/llm/store.ts) against a stubbed global fetch serving
 * PostgREST-shaped responses. The pagination test is the one that matters: a cap that reads
 * one page of a 1,000-row limit is blind past the first thousand calls of the month.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServiceClient } from '../../../src/lib/auth/clients.js';
import {
  TITLE_MAX_CHARS,
  supabaseConversationStore,
  supabaseUsageStore,
  titleFromMessage,
} from '../../../src/lib/llm/store.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = 'c0000000-0000-4000-8000-000000000001';

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
  range: string | null;
}

const seen: Seen[] = [];

type Handler = (req: Seen, index: number) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stub(handler: Handler): void {
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
      };
      seen.push(req);
      const response = handler(req, seen.length - 1);
      if (response === undefined) {
        throw new Error(`unstubbed: ${req.method} ${req.path}${req.query}`);
      }
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

describe('supabaseUsageStore', () => {
  it('spentSince sums cost_usd across pages until a short page', async () => {
    const page = (n: number): { cost_usd: number }[] =>
      Array.from({ length: n }, () => ({ cost_usd: 0.001 }));
    stub((req, index) => {
      if (req.path !== '/rest/v1/api_usage') return undefined;
      return json(index === 0 ? page(1000) : page(7));
    });
    const store = supabaseUsageStore(createServiceClient(CONFIG));
    const result = await store.spentSince('anthropic', new Date('2026-08-01T00:00:00Z'));
    expect(result).toEqual({ ok: true, value: 1.007 });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.query).toContain('provider=eq.anthropic');
    expect(seen[0]?.query).toContain('created_at=gte.2026-08-01T00%3A00%3A00.000Z');
    expect(seen[0]?.query).toContain('offset=0');
    expect(seen[0]?.query).toContain('limit=1000');
    expect(seen[1]?.query).toContain('offset=1000');
    expect(seen[1]?.query).toContain('limit=1000');
  });

  it('spentSince treats an empty ledger as zero and a null cost as zero', async () => {
    stub((_req, index) => json(index === 0 ? [{ cost_usd: null }] : []));
    const store = supabaseUsageStore(createServiceClient(CONFIG));
    expect(await store.spentSince('anthropic', new Date())).toEqual({ ok: true, value: 0 });
  });

  it('spentSince surfaces a PostgREST error and a transport failure as typed errors', async () => {
    stub(() => json({ message: 'permission denied', code: '42501' }, 401));
    const store = supabaseUsageStore(createServiceClient(CONFIG));
    const denied = await store.spentSince('anthropic', new Date());
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('HTTP_STATUS');

    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const down = await supabaseUsageStore(createServiceClient(CONFIG)).spentSince(
      'anthropic',
      new Date(),
    );
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.code).toBe('NETWORK');
  });

  it('record inserts every column the cap and the dashboard need', async () => {
    stub((req) => (req.method === 'POST' ? json([], 201) : undefined));
    const store = supabaseUsageStore(createServiceClient(CONFIG));
    const result = await store.record({
      provider: 'anthropic',
      operation: 'chat.turn',
      model: 'claude-sonnet-5',
      inputTokens: 123,
      outputTokens: 21,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.000684,
      userId: USER_ID,
      conversationId: CONV_ID,
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      provider: 'anthropic',
      operation: 'chat.turn',
      model: 'claude-sonnet-5',
      input_tokens: 123,
      output_tokens: 21,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.000684,
      user_id: USER_ID,
      conversation_id: CONV_ID,
    });
  });

  it('record maps failures', async () => {
    stub(() => json({ message: 'check violation', code: '23514' }, 400));
    const store = supabaseUsageStore(createServiceClient(CONFIG));
    const result = await store.record({
      provider: 'anthropic',
      operation: 'x',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      userId: null,
      conversationId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context['supabaseCode']).toBe('23514');

    vi.stubGlobal('fetch', () => Promise.reject(new Error('reset')));
    const down = await supabaseUsageStore(createServiceClient(CONFIG)).record({
      provider: 'anthropic',
      operation: 'x',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      userId: null,
      conversationId: null,
    });
    expect(down.ok).toBe(false);
  });
});

describe('supabaseConversationStore', () => {
  const ROW = { id: CONV_ID, user_id: USER_ID, scope: 'workspace', title: null, deleted_at: null };

  it('get returns the row, null when absent, and refuses an impossible scope', async () => {
    stub((req) => (req.query.includes('id=eq.') ? json([ROW]) : undefined));
    const store = supabaseConversationStore(createServiceClient(CONFIG));
    expect(await store.get(CONV_ID)).toEqual({
      ok: true,
      value: { id: CONV_ID, userId: USER_ID, scope: 'workspace', title: null, deletedAt: null },
    });

    stub(() => json([]));
    expect(await store.get(CONV_ID)).toEqual({ ok: true, value: null });

    stub(() => json([{ ...ROW, scope: 'org' }]));
    const bad = await store.get(CONV_ID);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INTERNAL');

    stub(() => json({ message: 'boom', code: 'XX000' }, 500));
    expect((await store.get(CONV_ID)).ok).toBe(false);

    vi.stubGlobal('fetch', () => Promise.reject(new Error('reset')));
    expect((await store.get(CONV_ID)).ok).toBe(false);
  });

  it('create inserts user_id only (scope defaults to workspace in the database) and returns the row', async () => {
    stub((req) => (req.method === 'POST' ? json(ROW, 201) : undefined));
    const store = supabaseConversationStore(createServiceClient(CONFIG));
    const result = await store.create(USER_ID, null);
    expect(result).toEqual({
      ok: true,
      value: { id: CONV_ID, userId: USER_ID, scope: 'workspace', title: null, deletedAt: null },
    });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ user_id: USER_ID });
  });

  it('create maps failures', async () => {
    stub(() => json({ message: 'fk', code: '23503' }, 409));
    expect(
      (await supabaseConversationStore(createServiceClient(CONFIG)).create(USER_ID, null)).ok,
    ).toBe(false);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('reset')));
    expect(
      (await supabaseConversationStore(createServiceClient(CONFIG)).create(USER_ID, null)).ok,
    ).toBe(false);
  });

  it('appendTurn writes the user message, the assistant message with model and tokens, then touches the conversation', async () => {
    stub((req, index) => {
      if (req.path === '/rest/v1/messages' && req.method === 'POST') {
        return json({ id: index === 0 ? 'm-user' : 'm-assistant' }, 201);
      }
      if (req.path === '/rest/v1/conversations' && req.method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const store = supabaseConversationStore(createServiceClient(CONFIG));
    const result = await store.appendTurn({
      conversation: {
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace',
        title: null,
        deletedAt: null,
      },
      userContent: 'hello',
      assistant: { content: 'reply', model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5 },
    });
    expect(result).toEqual({
      ok: true,
      value: { userMessageId: 'm-user', assistantMessageId: 'm-assistant' },
    });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /rest/v1/messages',
      'POST /rest/v1/messages',
      'PATCH /rest/v1/conversations',
    ]);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      conversation_id: CONV_ID,
      user_id: USER_ID,
      scope: 'workspace',
      role: 'user',
      content: 'hello',
    });
    expect(JSON.parse(seen[1]?.body ?? '')).toMatchObject({
      role: 'assistant',
      content: 'reply',
      model: 'claude-sonnet-5',
      input_tokens: 10,
      output_tokens: 5,
    });
    expect(seen[2]?.query).toContain(`id=eq.${CONV_ID}`);
  });

  it('appendTurn stops at the first failing write', async () => {
    const input = {
      conversation: {
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace' as const,
        title: null,
        deletedAt: null,
      },
      userContent: 'hello',
      assistant: { content: 'reply', model: 'm', inputTokens: 1, outputTokens: 1 },
    };
    stub(() => json({ message: 'nope', code: '42501' }, 401));
    const first = await supabaseConversationStore(createServiceClient(CONFIG)).appendTurn(input);
    expect(first.ok).toBe(false);
    expect(seen).toHaveLength(1);

    seen.length = 0;
    stub((_req, index) =>
      index === 0 ? json({ id: 'm-user' }, 201) : json({ message: 'nope' }, 500),
    );
    const second = await supabaseConversationStore(createServiceClient(CONFIG)).appendTurn(input);
    expect(second.ok).toBe(false);
    expect(seen).toHaveLength(2);

    seen.length = 0;
    stub((req, index) =>
      index < 2 ? json({ id: `m${index}` }, 201) : json({ message: 'nope' }, 500),
    );
    const third = await supabaseConversationStore(createServiceClient(CONFIG)).appendTurn(input);
    expect(third.ok).toBe(false);
    expect(seen).toHaveLength(3);

    vi.stubGlobal('fetch', () => Promise.reject(new Error('reset')));
    expect(
      (await supabaseConversationStore(createServiceClient(CONFIG)).appendTurn(input)).ok,
    ).toBe(false);
  });
});

describe('supabaseConversationStore — history and titles (part 6)', () => {
  it('recentMessages asks for the newest N user/assistant rows and returns them oldest first', async () => {
    stub((req) => {
      if (req.path !== '/rest/v1/messages') return undefined;
      return json([
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u1' },
      ]);
    });
    const store = supabaseConversationStore(createServiceClient(CONFIG));
    const result = await store.recentMessages(CONV_ID, 4);
    expect(result).toEqual({
      ok: true,
      value: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ],
    });
    const query = seen[0]?.query ?? '';
    expect(query).toContain(`conversation_id=eq.${CONV_ID}`);
    expect(query).toContain('role=in.%28user%2Cassistant%29');
    expect(query).toContain('content=not.is.null');
    expect(query).toContain('order=created_at.desc');
    expect(query).toContain('limit=4');
  });

  it('recentMessages drops rows it cannot use and surfaces failures as typed errors', async () => {
    stub(() =>
      json([
        { role: 'tool', content: 'x' },
        { role: 'user', content: null },
      ]),
    );
    const store = supabaseConversationStore(createServiceClient(CONFIG));
    expect(await store.recentMessages(CONV_ID, 10)).toEqual({ ok: true, value: [] });

    seen.length = 0;
    stub(() => json({ message: 'nope', code: '42501' }, 401));
    const refused = await store.recentMessages(CONV_ID, 10);
    expect(refused.ok).toBe(false);

    vi.stubGlobal('fetch', () => Promise.reject(new Error('reset')));
    expect((await store.recentMessages(CONV_ID, 10)).ok).toBe(false);
  });

  it('appendTurn titles an untitled conversation from the first message, and never re-titles', async () => {
    const handler: Handler = (req, index) => {
      if (req.path === '/rest/v1/messages') return json({ id: `m${index}` }, 201);
      if (req.path === '/rest/v1/conversations') return new Response(null, { status: 204 });
      return undefined;
    };
    stub(handler);
    const store = supabaseConversationStore(createServiceClient(CONFIG));
    await store.appendTurn({
      conversation: {
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace',
        title: null,
        deletedAt: null,
      },
      userContent: '  Write me a   post\nabout offsets ',
      assistant: { content: 'reply', model: 'm', inputTokens: 1, outputTokens: 1 },
    });
    expect(JSON.parse(seen[2]?.body ?? '')).toMatchObject({
      title: 'Write me a post about offsets',
    });

    seen.length = 0;
    stub(handler);
    await store.appendTurn({
      conversation: {
        id: CONV_ID,
        userId: USER_ID,
        scope: 'workspace',
        title: 'kept',
        deletedAt: null,
      },
      userContent: 'second',
      assistant: { content: 'reply', model: 'm', inputTokens: 1, outputTokens: 1 },
    });
    expect(JSON.parse(seen[2]?.body ?? '')).not.toHaveProperty('title');
  });

  it('titleFromMessage trims to one line and caps the length with an ellipsis', () => {
    expect(titleFromMessage('hi')).toBe('hi');
    const long = titleFromMessage('word '.repeat(40));
    expect(long.length).toBe(TITLE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});
