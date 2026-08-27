/**
 * Durable facts (src/lib/memory/facts.ts): the key shape, and the supabase-js store over a
 * stubbed PostgREST — the current-facts predicate (live rows, workspace-or-own), the RPC
 * write with its three outcomes, the source back-fill, and every failure typed.
 * Part C items 1–3 at the store level; the database half is tests/integration/recall.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServiceClient } from '../../../src/lib/auth/clients.js';
import {
  FACT_VALUE_MAX_CHARS,
  factKey,
  slugify,
  supabaseFactStore,
  validateFactKey,
} from '../../../src/lib/memory/facts.js';
import { USER_ID } from './helpers.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
}
const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
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

describe('keys', () => {
  it('slugify: lowercase, hyphens, no edges, bounded', () => {
    expect(slugify('Finance Content')).toBe('finance-content');
    expect(slugify('  Rule of One / CTA!! ')).toBe('rule-of-one-cta');
    expect(slugify('Ümläut café')).toBe('umlaut-cafe');
    expect(slugify('')).toBe('');
    expect(slugify('a'.repeat(100)).length).toBe(40);
    expect(slugify('abc-def-ghi', 4)).toBe('abc');
  });

  it('validateFactKey accepts the migration shape and refuses everything else', () => {
    expect(validateFactKey('writing:finance-content').ok).toBe(true);
    expect(validateFactKey('personal:x1').ok).toBe(true);
    for (const bad of [
      'tone',
      'Writing:finance',
      'writing:Finance',
      'writing:',
      'writing:-a',
      'writing:a--b',
      'other:thing',
      'writing:a b',
      `writing:${'a'.repeat(70)}`,
    ]) {
      const result = validateFactKey(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION');
    }
  });

  it('factKey builds from a category and free topic text, or refuses an empty slug', () => {
    expect(factKey('writing', 'Finance content')).toEqual({
      ok: true,
      value: 'writing:finance-content',
    });
    expect(factKey('writing', '!!!').ok).toBe(false);
  });
});

describe('currentFacts', () => {
  it('asks for live rows the user may read, newest first, and maps every column', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/memory_facts' && req.method === 'GET') {
        return json([
          {
            id: 'f1',
            user_id: OTHER_ID,
            scope: 'workspace',
            key: 'writing:finance-content',
            value: 'Finance content uses the Rule of One.',
            confidence: 1,
            source_message_id: 'm1',
            superseded_by: null,
            created_at: '2026-08-26T01:00:00Z',
          },
          {
            id: 'f2',
            user_id: USER_ID,
            scope: 'user',
            key: 'personal:coffee',
            value: 'Drinks long blacks.',
            confidence: null,
            source_message_id: null,
            superseded_by: null,
            created_at: '2026-08-25T01:00:00Z',
          },
        ]);
      }
      return undefined;
    });
    const result = await supabaseFactStore(createServiceClient(CONFIG)).currentFacts(USER_ID, 48);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(result.value[0]).toEqual({
      id: 'f1',
      userId: OTHER_ID,
      scope: 'workspace',
      key: 'writing:finance-content',
      value: 'Finance content uses the Rule of One.',
      confidence: 1,
      sourceMessageId: 'm1',
      supersededBy: null,
      createdAt: new Date('2026-08-26T01:00:00Z'),
    });
    const query = seen[0]?.query ?? '';
    expect(query).toContain('superseded_by=is.null');
    expect(query).toContain(`or=(scope.eq.workspace,user_id.eq.${USER_ID})`);
    expect(query).toContain('order=created_at.desc');
    expect(query).toContain('limit=48');
  });

  it('a scope outside the check constraint is an INTERNAL error; a PostgREST error is typed', async () => {
    stub(() =>
      json([
        {
          id: 'f9',
          user_id: USER_ID,
          scope: 'org',
          key: 'writing:x',
          value: 'v',
          confidence: null,
          source_message_id: null,
          superseded_by: null,
          created_at: '2026-08-26T01:00:00Z',
        },
      ]),
    );
    const bad = await supabaseFactStore(createServiceClient(CONFIG)).currentFacts(USER_ID, 10);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('INTERNAL');

    stub(() => json({ code: '42501', message: 'permission denied' }, 401));
    const refused = await supabaseFactStore(createServiceClient(CONFIG)).currentFacts(USER_ID, 10);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('HTTP_STATUS');
  });
});

describe('upsert', () => {
  it('calls upsert_memory_fact with every argument and maps the outcome', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/rpc/upsert_memory_fact' && req.method === 'POST') {
        return json([{ id: 'new', superseded_id: 'old', outcome: 'superseded' }]);
      }
      return undefined;
    });
    const result = await supabaseFactStore(createServiceClient(CONFIG)).upsert({
      userId: USER_ID,
      scope: 'workspace',
      key: 'writing:finance-content',
      value: '  Finance content uses PAS.  ',
      confidence: 1,
      sourceMessageId: null,
    });
    expect(result).toEqual({
      ok: true,
      value: { id: 'new', supersededId: 'old', outcome: 'superseded' },
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_user_id: USER_ID,
      p_scope: 'workspace',
      p_key: 'writing:finance-content',
      p_value: 'Finance content uses PAS.',
      p_confidence: 1,
      p_source_message_id: null,
    });
  });

  it('refuses a malformed key or an empty/oversized value before any request', async () => {
    stub(() => undefined);
    const store = supabaseFactStore(createServiceClient(CONFIG));
    const base = { userId: USER_ID, scope: 'user' as const, confidence: 1, sourceMessageId: null };
    const badKey = await store.upsert({ ...base, key: 'tone', value: 'x' });
    expect(badKey.ok).toBe(false);
    const empty = await store.upsert({ ...base, key: 'writing:x', value: '   ' });
    expect(empty.ok).toBe(false);
    const long = await store.upsert({
      ...base,
      key: 'writing:x',
      value: 'a'.repeat(FACT_VALUE_MAX_CHARS + 1),
    });
    expect(long.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('an unknown outcome, an empty result and a PostgREST error are all typed failures', async () => {
    const store = supabaseFactStore(createServiceClient(CONFIG));
    const input = {
      userId: USER_ID,
      scope: 'workspace' as const,
      key: 'writing:x',
      value: 'v',
      confidence: 1,
      sourceMessageId: null,
    };
    stub(() => json([{ id: 'n', superseded_id: null, outcome: 'exploded' }]));
    const unknown = await store.upsert(input);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('INTERNAL');
    stub(() => json([]));
    const empty = await store.upsert(input);
    expect(empty.ok).toBe(false);
    stub(() => json({ code: '23514', message: 'check violation' }, 400));
    const refused = await store.upsert(input);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.context['supabaseCode']).toBe('23514');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const transport = await store.upsert(input);
    expect(transport.ok).toBe(false);
    if (!transport.ok) expect(transport.error.code).toBe('NETWORK');
  });
});

describe('setSource', () => {
  it('patches only a row whose source is still null', async () => {
    stub((req) =>
      req.path === '/rest/v1/memory_facts' && req.method === 'PATCH' ? json([]) : undefined,
    );
    const result = await supabaseFactStore(createServiceClient(CONFIG)).setSource('f1', 'm1');
    expect(result.ok).toBe(true);
    expect(seen[0]?.query).toContain('id=eq.f1');
    expect(seen[0]?.query).toContain('source_message_id=is.null');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ source_message_id: 'm1' });
  });
});
