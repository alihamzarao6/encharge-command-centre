/**
 * The settings page's reads (Milestone 5 part 4), driven through a real supabase-js client over
 * a recorded fetch: the assertions are on the requests PostgREST receives — which table, which
 * filter, which order and range, which columns — and on what a refusal turns into.
 *
 * The activity read is the one with a security property: `audit_log`'s before/after images hold
 * a note's words on the row-level trigger rows, so the page selects by action name and pulls only
 * NAMED keys out of the images. Asserted here on the request itself.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  readActivity,
  readDocuments,
  readKeys,
  readRoster,
} from '../../../web/src/lib/settingsData.js';
import type { WebClient } from '../../../web/src/lib/database.js';

interface Seen {
  readonly path: string;
  readonly params: URLSearchParams;
  readonly headers: Headers;
}

function client(
  answer: (
    path: string,
    params: URLSearchParams,
  ) => { status: number; body: unknown; range?: string },
): {
  client: WebClient;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fake = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({
      path: url.pathname,
      params: url.searchParams,
      headers: new Headers(init?.headers),
    });
    const reply = answer(url.pathname, url.searchParams);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: {
          'content-type': 'application/json',
          ...(reply.range === undefined ? {} : { 'content-range': reply.range }),
        },
      }),
    );
  };
  return {
    seen,
    client: createClient('https://p.supabase.co', 'anon', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fake },
    }),
  };
}

const ROW = {
  id: 's1',
  name: 'Rates.pdf',
  kind: 'pdf',
  source_host: null,
  source_url: 'https://l.example/r',
  content_hash: 'a'.repeat(64),
  uploaded_by: 'u1',
  learned_at: '2026-10-17T00:00:00Z',
  page_count: 3,
  chunk_count: 4,
  embedded_count: 4,
  status: 'ready',
  failure: null,
};

describe('readDocuments', () => {
  it('asks for one page of what is not forgotten, newest first with a tie-break, with the total', async () => {
    const t = client((_path, params) =>
      params.get('select')?.includes('page_count') === true
        ? { status: 200, body: [ROW], range: '25-25/312' }
        : { status: 200, body: [] },
    );
    const read = await readDocuments(t.client, 2, 25);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.value.total).toBe(312);
    const list = t.seen[0];
    expect(list?.path).toBe('/rest/v1/knowledge_sources');
    expect(list?.params.get('status')).toBe('neq.forgotten');
    expect(list?.params.get('order')).toBe('learned_at.desc,id.desc');
    expect(list?.params.get('offset')).toBe('25');
    expect(list?.params.get('limit')).toBe('25');
    expect(list?.headers.get('prefer')).toContain('count=exact');
    // Copies by the bytes, and other reads by the address — both still not forgotten.
    expect(t.seen[1]?.params.get('content_hash')).toBe(`in.(${'a'.repeat(64)})`);
    expect(t.seen[1]?.params.get('status')).toBe('neq.forgotten');
    expect(t.seen[2]?.params.get('source_url')).toBe('in.(https://l.example/r)');
  });

  it('an empty list asks nothing more', async () => {
    const t = client(() => ({ status: 200, body: [], range: '*/0' }));
    const read = await readDocuments(t.client, 1, 25);
    expect(read).toEqual({ kind: 'ok', value: { rows: [], related: [], total: 0 } });
    expect(t.seen).toHaveLength(1);
  });

  it('a session that ran out is "expired"; any other refusal is "unavailable" — never an empty list', async () => {
    const expired = client(() => ({
      status: 401,
      body: { code: 'PGRST301', message: 'JWT expired' },
    }));
    expect(await readDocuments(expired.client, 1, 25)).toEqual({ kind: 'expired' });
    // A 500, not a 503: supabase-js retries a 503 three times with backoff (7 s) before reporting it.
    const down = client(() => ({ status: 500, body: { code: 'XX000', message: 'internal' } }));
    expect(await readDocuments(down.client, 1, 25)).toEqual({ kind: 'unavailable' });
    const relatedDown = client((_p, params) =>
      params.get('select')?.includes('page_count') === true
        ? { status: 200, body: [ROW], range: '0-0/1' }
        : { status: 500, body: { code: 'XX000', message: 'x' } },
    );
    expect(await readDocuments(relatedDown.client, 1, 25)).toEqual({ kind: 'unavailable' });
    // The other reads of an address only add a sentence: their failure keeps the list.
    const readsDown = client((_p, params) =>
      params.get('select')?.includes('page_count') === true
        ? { status: 200, body: [ROW], range: '0-0/1' }
        : params.has('source_url')
          ? { status: 500, body: { code: 'XX000', message: 'x' } }
          : { status: 200, body: [] },
    );
    const kept = await readDocuments(readsDown.client, 1, 25);
    expect(kept.kind === 'ok' && kept.value.rows.length).toBe(1);
  });
});

describe('readKeys and readRoster', () => {
  it('reads the keys with no filter on whose — the policy returns the person’s own', async () => {
    const t = client(() => ({ status: 200, body: [] }));
    expect(await readKeys(t.client)).toEqual({ kind: 'ok', value: [] });
    expect(t.seen[0]?.path).toBe('/rest/v1/connector_keys');
    expect(t.seen[0]?.params.get('select')).toBe(
      'id,key_id,label,created_at,last_used_at,revoked_at',
    );
    expect(t.seen[0]?.params.has('user_id')).toBe(false);
    const failed = client(() => ({ status: 500, body: { code: 'XX000', message: 'x' } }));
    expect(await readKeys(failed.client)).toEqual({ kind: 'unavailable' });
  });

  it('a roster that cannot be read costs the names, not the page', async () => {
    const t = client(() => ({ status: 200, body: [{ user_id: 'u1', email: 'a@b.c' }] }));
    expect([...(await readRoster(t.client))]).toEqual([['u1', 'a@b.c']]);
    const failed = client(() => ({ status: 500, body: { code: 'XX000', message: 'x' } }));
    expect((await readRoster(failed.client)).size).toBe(0);
  });
});

describe('readActivity', () => {
  const AUDIT = {
    id: 'e1',
    actor: 'u1',
    action: 'LEAD_STAGE_MOVED',
    entity_type: 'ghl_writes',
    entity_id: 'w1',
    created_at: '2026-10-17T00:00:00Z',
    opportunity: 'opp-1',
    from_stage: 'st-a',
    to_stage: 'st-b',
    connector: null,
    file_kind: null,
    file_source: null,
  };

  it('selects by action name, newest first, and only NAMED keys out of before/after', async () => {
    const t = client((path) => {
      if (path === '/rest/v1/audit_log') return { status: 200, body: [AUDIT], range: '0-0/1' };
      if (path === '/rest/v1/ghl_stages') {
        return {
          status: 200,
          body: [
            { ghl_id: 'st-a', name: 'New' },
            { ghl_id: 'st-b', name: 'Settled' },
          ],
        };
      }
      return { status: 200, body: [{ ghl_id: 'opp-1', name: 'Jordan Lee' }] };
    });
    const read = await readActivity(t.client, 1, 25);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.value.total).toBe(1);
      expect([...read.value.stageNames]).toEqual([
        ['st-a', 'New'],
        ['st-b', 'Settled'],
      ]);
      expect(read.value.leadNames.get('opp-1')).toBe('Jordan Lee');
    }
    const audit = t.seen[0];
    expect(audit?.path).toBe('/rest/v1/audit_log');
    expect(audit?.params.get('order')).toBe('created_at.desc,id.desc');
    expect(audit?.params.get('action')).toMatch(/^in\.\(LEAD_STAGE_MOVED,LEAD_NOTE_ADDED,/);
    expect(audit?.params.get('action')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    const columns = (audit?.params.get('select') ?? '').split(',');
    // Never a whole image: every mention of before/after is a named key with ->>.
    expect(columns.filter((c) => c === 'before' || c === 'after')).toEqual([]);
    expect(
      columns.filter((c) => /\b(before|after)\b/.test(c)).every((c) => c.includes('->>')),
    ).toBe(true);
  });

  it('when the mirror cannot be read the record still lists; when the record cannot, it says so', async () => {
    const t = client((path) =>
      path === '/rest/v1/audit_log'
        ? { status: 200, body: [AUDIT], range: '0-0/1' }
        : { status: 500, body: { code: 'XX000', message: 'x' } },
    );
    const read = await readActivity(t.client, 1, 25);
    expect(read.kind === 'ok' && read.value.stageNames.size).toBe(0);
    const down = client(() => ({ status: 500, body: { code: 'XX000', message: 'x' } }));
    expect(await readActivity(down.client, 1, 25)).toEqual({ kind: 'unavailable' });
    const none = client(() => ({ status: 200, body: [], range: '*/0' }));
    const empty = await readActivity(none.client, 1, 25);
    expect(empty.kind === 'ok' && empty.value.rows.length).toBe(0);
    expect(none.seen).toHaveLength(1);
  });
});
