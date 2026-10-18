/**
 * The settings store over Supabase (Milestone 5 part 4): the real supabase-js client, over a
 * recorded fetch — so what is asserted is the request PostgREST would receive (which function,
 * with which arguments, as whom) and how each answer and each refusal is read.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  ANSWERS_MAX_PAGES,
  ANSWERS_PAGE_ROWS,
  createSettingsClient,
  readForgetRow,
  supabaseSettingsStore,
  type SettingsClient,
} from '../../../src/lib/settings/store.js';

interface Seen {
  readonly url: string;
  readonly body: unknown;
}

function client(
  answer: (url: string, body: unknown) => { status: number; body: unknown } | 'throw',
): { client: SettingsClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    seen.push({ url, body });
    const reply = answer(url, body);
    if (reply === 'throw') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return {
    seen,
    client: createClient('https://project.supabase.co', 'service-role-test', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fake },
    }),
  };
}

const USER = 'a0000000-0000-4000-8000-000000000001';
const SOURCE = '5b4c3d2e-1f00-4a00-8b00-000000000abc';

describe('forgetDocument', () => {
  it('calls forget_document with the source and the person, and reads the counts', async () => {
    const t = client(() => ({
      status: 200,
      body: [{ outcome: 'forgotten', sources: 2, files: 1, chunks: 9 }],
    }));
    const result = await supabaseSettingsStore(t.client).forgetDocument(SOURCE, USER);
    expect(result).toEqual({
      ok: true,
      value: { kind: 'forgotten', sources: 2, files: 1, chunks: 9 },
    });
    expect(t.seen[0]?.url).toBe('https://project.supabase.co/rest/v1/rpc/forget_document');
    expect(t.seen[0]?.body).toEqual({ p_source_id: SOURCE, p_actor: USER });
  });

  it.each(['already', 'not_found', 'not_allowed'])('reads %s', async (outcome) => {
    const t = client(() => ({ status: 200, body: [{ outcome, sources: 0, files: 0, chunks: 0 }] }));
    const result = await supabaseSettingsStore(t.client).forgetDocument(SOURCE, USER);
    expect(result).toEqual({ ok: true, value: { kind: outcome } });
  });

  it('KF001 — the person is not active staff — is an answer, not an error', async () => {
    const t = client(() => ({
      status: 400,
      body: { code: 'KF001', message: 'user … is not', details: null, hint: null },
    }));
    expect(await supabaseSettingsStore(t.client).forgetDocument(SOURCE, USER)).toEqual({
      ok: true,
      value: { kind: 'not_staff' },
    });
  });

  it('any other database refusal is an error carrying the code, never the message', async () => {
    const t = client(() => ({
      status: 500,
      body: {
        code: 'KF002',
        message: 'document 5b4c… was not wholly forgotten',
        details: null,
        hint: null,
      },
    }));
    const result = await supabaseSettingsStore(t.client).forgetDocument(SOURCE, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('HTTP_STATUS');
      expect(JSON.stringify(result.error.toJSON())).not.toContain('5b4c');
    }
  });

  it('an answer in a shape this code does not know is an error, not a guess', async () => {
    for (const body of [
      [],
      [{ outcome: 'forgotten', sources: -1, files: 0, chunks: 0 }],
      [{ outcome: 'vanished' }],
    ]) {
      const t = client(() => ({ status: 200, body }));
      const result = await supabaseSettingsStore(t.client).forgetDocument(SOURCE, USER);
      expect(result.ok).toBe(false);
    }
  });

  it('a transport failure is a network error, which the endpoint answers as "check, then retry"', async () => {
    const t = client(() => 'throw');
    const result = await supabaseSettingsStore(t.client).forgetDocument(SOURCE, USER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NETWORK');
  });
});

describe('readForgetRow', () => {
  it('needs whole, non-negative counts for a forget', () => {
    expect(readForgetRow({ outcome: 'forgotten', sources: 1, files: 0, chunks: 3 })).toEqual({
      kind: 'forgotten',
      sources: 1,
      files: 0,
      chunks: 3,
    });
    expect(readForgetRow({ outcome: 'forgotten', sources: 1.5, files: 0, chunks: 3 })).toBeNull();
    expect(readForgetRow(null)).toBeNull();
    expect(readForgetRow('forgotten')).toBeNull();
  });
});

describe('issueKey', () => {
  it('sends the digest as a bytea, never the key, and names the person as the one who made it', async () => {
    const t = client(() => ({
      status: 200,
      body: [{ id: 'row', key_id: 'abcdefghjkmn', created_at: '2026-10-17T05:30:00+00:00' }],
    }));
    const result = await supabaseSettingsStore(t.client).issueKey({
      userId: USER,
      keyId: 'abcdefghjkmn',
      digestHex: 'ab'.repeat(32),
      label: 'Laptop',
    });
    expect(result).toEqual({
      ok: true,
      value: { kind: 'issued', keyId: 'abcdefghjkmn', createdAt: '2026-10-17T05:30:00+00:00' },
    });
    expect(t.seen[0]?.url).toBe('https://project.supabase.co/rest/v1/rpc/issue_connector_key');
    expect(t.seen[0]?.body).toEqual({
      p_user_id: USER,
      p_key_id: 'abcdefghjkmn',
      p_key_hash: `\\x${'ab'.repeat(32)}`,
      p_label: 'Laptop',
      p_created_by: USER,
    });
  });

  it.each([
    ['CK001', 'not_staff'],
    ['CK002', 'too_many'],
    ['CK003', 'id_taken'],
  ])('%s is %s', async (code, kind) => {
    const t = client(() => ({
      status: 400,
      body: { code, message: 'x', details: null, hint: null },
    }));
    const result = await supabaseSettingsStore(t.client).issueKey({
      userId: USER,
      keyId: 'abcdefghjkmn',
      digestHex: 'ab'.repeat(32),
      label: 'x',
    });
    expect(result).toEqual({ ok: true, value: { kind } });
  });

  it('no row back, another refusal or a dropped connection is an error', async () => {
    for (const answer of [
      () => ({ status: 200, body: [] }),
      () => ({
        status: 500,
        body: { code: '42501', message: 'denied', details: null, hint: null },
      }),
      () => 'throw' as const,
    ]) {
      const t = client(answer);
      const result = await supabaseSettingsStore(t.client).issueKey({
        userId: USER,
        keyId: 'abcdefghjkmn',
        digestHex: 'ab'.repeat(32),
        label: 'x',
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('revokeKey', () => {
  it('passes the person’s own id, so only their own key can be switched off from the page', async () => {
    const t = client(() => ({
      status: 200,
      body: [{ key_id: 'abcdefghjkmn', revoked_at: '2026-10-17T05:31:00+00:00', already: false }],
    }));
    const result = await supabaseSettingsStore(t.client).revokeKey(USER, 'abcdefghjkmn');
    expect(result).toEqual({
      ok: true,
      value: { kind: 'revoked', keyId: 'abcdefghjkmn', revokedAt: '2026-10-17T05:31:00+00:00' },
    });
    expect(t.seen[0]?.body).toEqual({
      p_user_id: USER,
      p_key_id: 'abcdefghjkmn',
      p_revoked_by: USER,
    });
  });

  it('already switched off; nothing back (not theirs, or no such key); errors', async () => {
    const already = client(() => ({
      status: 200,
      body: [{ key_id: 'abcdefghjkmn', revoked_at: '2026-10-16T00:00:00+00:00', already: true }],
    }));
    expect((await supabaseSettingsStore(already.client).revokeKey(USER, 'abcdefghjkmn')).ok).toBe(
      true,
    );
    const none = client(() => ({ status: 200, body: [] }));
    expect(await supabaseSettingsStore(none.client).revokeKey(USER, 'abcdefghjkmn')).toEqual({
      ok: true,
      value: { kind: 'not_found' },
    });
    const refused = client(() => ({
      status: 500,
      body: { code: 'XX000', message: 'x', details: null, hint: null },
    }));
    expect((await supabaseSettingsStore(refused.client).revokeKey(USER, 'abcdefghjkmn')).ok).toBe(
      false,
    );
    const dropped = client(() => 'throw');
    expect((await supabaseSettingsStore(dropped.client).revokeKey(USER, 'abcdefghjkmn')).ok).toBe(
      false,
    );
  });
});

describe('createSettingsClient', () => {
  it('builds a service client for the project without touching the network', () => {
    const made = createSettingsClient({
      url: 'https://project.supabase.co',
      anonKey: 'anon',
      serviceRoleKey: 'service',
    });
    expect(typeof made.rpc).toBe('function');
  });
});

describe('copiesOf — every id the document goes by, read before the forget', () => {
  const HASH = 'c'.repeat(64);

  it('this copy, every other learned copy of the same bytes, and every attachment of them', async () => {
    const t = client((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/knowledge_sources') && u.searchParams.has('id')) {
        return {
          status: 200,
          body: [{ id: SOURCE, content_hash: HASH, file_id: 'f1', status: 'ready' }],
        };
      }
      if (u.pathname.endsWith('/knowledge_sources')) {
        return {
          status: 200,
          body: [
            { id: SOURCE, content_hash: HASH, file_id: 'f1', status: 'ready' },
            { id: 'copy', content_hash: HASH, file_id: null, status: 'ready' },
          ],
        };
      }
      return {
        status: 200,
        body: [
          { id: 'f1', content_hash: HASH, status: 'ready' },
          { id: 'f2', content_hash: HASH, status: 'ready' },
        ],
      };
    });
    const result = await supabaseSettingsStore(t.client).copiesOf(SOURCE);
    expect(result).toEqual({
      ok: true,
      value: { sources: [SOURCE, 'copy'], files: ['f1', 'f2'] },
    });
    const copies = new URL(t.seen[1]?.url ?? '');
    expect(copies.searchParams.get('content_hash')).toBe(`eq.${HASH}`);
    expect(copies.searchParams.get('status')).toBe('neq.forgotten');
    expect(new URL(t.seen[2]?.url ?? '').pathname).toBe('/rest/v1/conversation_files');
  });

  it('a copy already forgotten has no hash left: it stands for itself; no such source is null', async () => {
    const gone = client(() => ({
      status: 200,
      body: [{ id: SOURCE, content_hash: null, file_id: 'f1', status: 'forgotten' }],
    }));
    expect(await supabaseSettingsStore(gone.client).copiesOf(SOURCE)).toEqual({
      ok: true,
      value: { sources: [SOURCE], files: ['f1'] },
    });
    expect(gone.seen).toHaveLength(1);
    const none = client(() => ({ status: 200, body: [] }));
    expect(await supabaseSettingsStore(none.client).copiesOf(SOURCE)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('any read that fails is an error, so the count is said to be unknown rather than guessed', async () => {
    const refusal = {
      status: 500,
      body: { code: 'XX000', message: 'x', details: null, hint: null },
    };
    for (const failAt of [0, 1, 2]) {
      let n = 0;
      const t = client(() => {
        const at = n;
        n += 1;
        if (at === failAt) return refusal;
        return at === 0
          ? {
              status: 200,
              body: [{ id: SOURCE, content_hash: HASH, file_id: null, status: 'ready' }],
            }
          : { status: 200, body: [] };
      });
      expect((await supabaseSettingsStore(t.client).copiesOf(SOURCE)).ok).toBe(false);
    }
    const dropped = client(() => 'throw');
    expect((await supabaseSettingsStore(dropped.client).copiesOf(SOURCE)).ok).toBe(false);
  });
});

describe('conversationsWithAnswers — answers that name the document, in conversations still there', () => {
  const answer = (id: string, conversationId: string, entry: Record<string, unknown>) => ({
    id,
    conversation_id: conversationId,
    role: 'assistant',
    document_coverage: { v: 1, documents: [entry] },
  });

  it('asks for assistant answers whose record names each id, then which of their conversations remain', async () => {
    const t = client((url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/conversations')) {
        return { status: 200, body: [{ id: 'c1', deleted_at: null }] };
      }
      const named = u.searchParams.get('document_coverage') ?? '';
      return {
        status: 200,
        body: named.includes('src-a')
          ? [
              answer('m1', 'c1', { source: 'src-a', mode: 'part' }),
              answer('m2', 'c-deleted', { source: 'src-a', mode: 'part' }),
            ]
          : [answer('m3', 'c1', { file: 'file-a', mode: 'whole' })],
      };
    });
    const ids = { sources: ['src-a'], files: ['file-a'] };
    expect(await supabaseSettingsStore(t.client).conversationsWithAnswers(ids)).toEqual({
      ok: true,
      value: 1,
    });
    const first = new URL(t.seen[0]?.url ?? '');
    expect(first.pathname).toBe('/rest/v1/messages');
    expect(first.searchParams.get('role')).toBe('eq.assistant');
    expect(first.searchParams.get('document_coverage')).toBe(
      'cs.{"documents":[{"source":"src-a"}]}',
    );
    expect(first.searchParams.get('order')).toBe('id.asc');
    expect(new URL(t.seen[1]?.url ?? '').searchParams.get('document_coverage')).toBe(
      'cs.{"documents":[{"file":"file-a"}]}',
    );
    const alive = new URL(t.seen[2]?.url ?? '');
    expect(alive.pathname).toBe('/rest/v1/conversations');
    expect(alive.searchParams.get('deleted_at')).toBe('is.null');
  });

  it('reads page after page while pages come back full; at the cap it says it cannot count', async () => {
    const row = answer('m', 'c1', { source: 'src-a', mode: 'part' });
    const full = Array.from({ length: ANSWERS_PAGE_ROWS }, () => row);
    let pages = 0;
    const twoPages = client((url) => {
      if (new URL(url).pathname.endsWith('/conversations')) {
        return { status: 200, body: [{ id: 'c1', deleted_at: null }] };
      }
      pages += 1;
      return { status: 200, body: pages === 1 ? full : [row] };
    });
    const ids = { sources: ['src-a'], files: [] };
    expect(await supabaseSettingsStore(twoPages.client).conversationsWithAnswers(ids)).toEqual({
      ok: true,
      value: 1,
    });
    expect(pages).toBe(2);
    const endless = client(() => ({ status: 200, body: full }));
    const capped = await supabaseSettingsStore(endless.client).conversationsWithAnswers(ids);
    expect(capped.ok).toBe(false);
    expect(endless.seen).toHaveLength(ANSWERS_MAX_PAGES);
  });

  it('nothing names it: zero, and no conversation is asked about', async () => {
    const t = client(() => ({ status: 200, body: [] }));
    expect(
      await supabaseSettingsStore(t.client).conversationsWithAnswers({ sources: ['s'], files: [] }),
    ).toEqual({ ok: true, value: 0 });
    expect(t.seen).toHaveLength(1);
  });

  it('a refused or dropped read is an error, never a smaller number', async () => {
    const ids = { sources: ['s'], files: [] };
    const refusal = {
      status: 500,
      body: { code: 'XX000', message: 'x', details: null, hint: null },
    };
    const refused = client(() => refusal);
    expect((await supabaseSettingsStore(refused.client).conversationsWithAnswers(ids)).ok).toBe(
      false,
    );
    let n = 0;
    const aliveFails = client(() => {
      n += 1;
      return n === 1
        ? {
            status: 200,
            body: [{ id: 'm', conversation_id: 'c1', role: 'assistant', document_coverage: null }],
          }
        : refusal;
    });
    expect((await supabaseSettingsStore(aliveFails.client).conversationsWithAnswers(ids)).ok).toBe(
      false,
    );
    const dropped = client(() => 'throw');
    expect((await supabaseSettingsStore(dropped.client).conversationsWithAnswers(ids)).ok).toBe(
      false,
    );
  });
});
