/**
 * The database half of "a forgotten document must not speak from the history"
 * (`supabaseWithdrawnLookup`, src/lib/knowledge/store.ts) against a stubbed PostgREST: the two
 * reads, their filters, and that an attachment which only expired is never called gone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKnowledgeServiceClient,
  supabaseWithdrawnLookup,
} from '../../../src/lib/knowledge/store.js';
import type { WithdrawnLookup } from '../../../src/lib/knowledge/withdrawn.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const CONV = 'c0000000-0000-4000-8000-000000000001';
const SOURCE = 'a0000000-0000-4000-8000-000000000001';
const OTHER_SOURCE = 'a0000000-0000-4000-8000-000000000002';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const EXPIRED = 'f0000000-0000-4000-8000-000000000002';

interface Seen {
  path: string;
  query: string;
}

const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stub(handler: (req: Seen) => Response | undefined): void {
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const req: Seen = { path: url.pathname, query: decodeURIComponent(url.search) };
    seen.push(req);
    const response = handler(req);
    if (response === undefined) throw new Error(`unstubbed: ${req.path}`);
    return Promise.resolve(response);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

const lookup = (): WithdrawnLookup => supabaseWithdrawnLookup(createKnowledgeServiceClient(CONFIG));

describe('supabaseWithdrawnLookup (18 Oct 2026)', () => {
  it('reads the attachments a person removed here, and the learned copies forgotten by id or by file', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') return json([{ id: FILE }]);
      if (req.path === '/rest/v1/knowledge_sources')
        return json([
          { id: SOURCE, file_id: null },
          { id: 'a0000000-0000-4000-8000-000000000009', file_id: EXPIRED },
        ]);
      return undefined;
    });
    const result = await lookup().forgotten({
      conversationId: CONV,
      sources: [SOURCE, OTHER_SOURCE],
      files: [FILE, EXPIRED],
    });
    expect(result.ok && result.value).toEqual({
      sources: new Set([SOURCE]),
      files: new Set([FILE, EXPIRED]),
      anyRemovedHere: true,
    });
    expect(seen[0]?.query).toContain(`conversation_id=eq.${CONV}`);
    expect(seen[0]?.query).toContain('status=eq.removed');
    expect(seen[0]?.query).toContain('removed_reason=eq.user');
    expect(seen[1]?.query).toContain('status=eq.forgotten');
    expect(seen[1]?.query).toContain(
      `or=(id.in.(${SOURCE},${OTHER_SOURCE}),file_id.in.(${FILE},${EXPIRED}))`,
    );
    expect(seen).toHaveLength(2);
  });

  it('with no ids to ask about, only the conversation is read; nothing removed reads as nothing', async () => {
    stub((req) => (req.path === '/rest/v1/conversation_files' ? json([]) : undefined));
    const result = await lookup().forgotten({ conversationId: CONV, sources: [], files: [] });
    expect(result.ok && result.value).toEqual({
      sources: new Set(),
      files: new Set(),
      anyRemovedHere: false,
    });
    expect(seen).toHaveLength(1);
  });

  it('an attachment that merely expired is not gone: the removed-by-a-person read leaves it out, and only a forgotten copy brings it back', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') return json([]);
      if (req.path === '/rest/v1/knowledge_sources') return json([]);
      return undefined;
    });
    const result = await lookup().forgotten({
      conversationId: CONV,
      sources: [],
      files: [EXPIRED],
    });
    expect(result.ok && result.value).toEqual({
      sources: new Set(),
      files: new Set(),
      anyRemovedHere: false,
    });
    expect(seen[1]?.query).toContain(`or=(file_id.in.(${EXPIRED}))`);
  });

  it('a row that comes back for an id nobody asked about is not reported', async () => {
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files')
        return json([{ id: 'f0000000-0000-4000-8000-00000000000f' }]);
      if (req.path === '/rest/v1/knowledge_sources')
        return json([{ id: OTHER_SOURCE, file_id: null }]);
      return undefined;
    });
    const result = await lookup().forgotten({
      conversationId: CONV,
      sources: [SOURCE],
      files: [FILE],
    });
    expect(result.ok && result.value).toEqual({
      sources: new Set(),
      files: new Set(),
      anyRemovedHere: true,
    });
  });

  it('either read failing is a typed error, never a guess', async () => {
    stub((req) =>
      req.path === '/rest/v1/conversation_files'
        ? json({ message: 'nope', code: '42501' }, 401)
        : undefined,
    );
    expect(
      (await lookup().forgotten({ conversationId: CONV, sources: [SOURCE], files: [] })).ok,
    ).toBe(false);
    seen.length = 0;
    stub((req) => {
      if (req.path === '/rest/v1/conversation_files') return json([]);
      if (req.path === '/rest/v1/knowledge_sources')
        return json({ message: 'nope', code: '42501' }, 401);
      return undefined;
    });
    expect(
      (await lookup().forgotten({ conversationId: CONV, sources: [SOURCE], files: [] })).ok,
    ).toBe(false);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('reset')));
    expect((await lookup().forgotten({ conversationId: CONV, sources: [], files: [] })).ok).toBe(
      false,
    );
  });
});
