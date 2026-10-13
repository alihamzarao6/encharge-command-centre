/**
 * The connector's supabase-js adapters (src/lib/connector/store.ts and keyAdmin.ts) against a
 * stubbed global fetch serving PostgREST-shaped responses: what is sent, what each answer is
 * turned into, and that a database error's own words never travel.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKeyAdminClient,
  supabaseKeyAdminStore,
} from '../../../src/lib/connector/keyAdmin.js';
import { mintKey } from '../../../src/lib/connector/keys.js';
import {
  byteaHex,
  createConnectorServiceClient,
  parseCallReply,
  supabaseConnectorStore,
} from '../../../src/lib/connector/store.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };

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
      if (response === undefined) throw new Error(`unstubbed: ${req.method} ${req.path}`);
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

const store = () => supabaseConnectorStore(createConnectorServiceClient(CONFIG, 5_000));
const admin = () => supabaseKeyAdminStore(createKeyAdminClient(CONFIG));

async function input(over: Readonly<Record<string, unknown>> = {}) {
  const minted = await mintKey();
  return {
    minted,
    call: {
      credential: { kind: 'key' as const, keyId: minted.keyId, digestHex: minted.digestHex },
      method: 'tools/call',
      tool: 'get_lead',
      args: { lead_id: 'op-1' },
      pipelineId: 'PIPE_FINANCE',
      perMinute: 30,
      perDay: 1_000,
      ...over,
    },
  };
}

describe('the one call a request makes', () => {
  it('sends the public id and the digest as a bytea — and the key itself nowhere', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/connector_call'
        ? json({ outcome: 'ok', key_id: 'aaaaaaaaaaaa', call_id: 'c1', data: { outcome: 'ok' } })
        : undefined,
    );
    const { minted, call } = await input();
    const reply = await store().call(call);
    expect(reply.ok && reply.value).toEqual({
      outcome: 'ok',
      keyId: 'aaaaaaaaaaaa',
      callId: 'c1',
      data: { outcome: 'ok' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_key_id: minted.keyId,
      p_key_hash: `\\x${minted.digestHex}`,
      p_method: 'tools/call',
      p_tool: 'get_lead',
      p_args: { lead_id: 'op-1' },
      p_pipeline_ghl_id: 'PIPE_FINANCE',
      p_per_minute: 30,
      p_per_day: 1_000,
    });
    expect(JSON.stringify(seen)).not.toContain(minted.key);
    expect(JSON.stringify(seen)).not.toContain(minted.key.slice(-43));
    // No user id is sent, because there is none to send.
    expect(seen[0]?.body).not.toMatch(/user/i);
    expect(byteaHex('00ff')).toBe('\\x00ff');
  });

  it('every answer the database gives has one meaning', () => {
    expect(parseCallReply({ outcome: 'unauthenticated', reason: 'unknown_key' })).toEqual({
      outcome: 'unauthenticated',
      reason: 'unknown_key',
      keyId: null,
    });
    expect(
      parseCallReply({ outcome: 'unauthenticated', reason: 'revoked', key_id: 'aaaaaaaaaaaa' }),
    ).toEqual({
      outcome: 'unauthenticated',
      reason: 'revoked',
      keyId: 'aaaaaaaaaaaa',
    });
    expect(
      parseCallReply({
        outcome: 'rate_limited',
        key_id: 'a',
        window: 'day',
        retry_after_seconds: 60,
      }),
    ).toEqual({ outcome: 'rate_limited', keyId: 'a', window: 'day', retryAfterSeconds: 60 });
    expect(
      parseCallReply({
        outcome: 'read_failed',
        key_id: 'a',
        call_id: 'c',
        data: { sqlstate: '42501' },
      }),
    ).toEqual({
      outcome: 'read_failed',
      keyId: 'a',
      callId: 'c',
    });
    for (const unknown of [
      null,
      'ok',
      {},
      { outcome: 'granted' },
      { outcome: 'ok' },
      { outcome: 'unauthenticated', reason: 'because' },
      { outcome: 'rate_limited', key_id: 'a', window: 'hour', retry_after_seconds: 1 },
      { outcome: 'rate_limited', key_id: 'a', window: 'minute', retry_after_seconds: 0 },
    ]) {
      expect(parseCallReply(unknown), JSON.stringify(unknown)).toBeNull();
    }
  });

  it('an answer in a shape this code does not know is an error, never a result', async () => {
    stub(() => json({ outcome: 'ok', rows: ['everything'] }));
    const reply = await store().call((await input()).call);
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.error.code).toBe('INTERNAL');
  });

  it('a database error keeps its code and loses its words: they may name a column or a value', async () => {
    stub(() =>
      json(
        {
          code: '42501',
          message: 'permission denied for table ghl_contacts',
          details: 'secret detail',
        },
        403,
      ),
    );
    const reply = await store().call((await input()).call);
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.message).toBe('connector_call: database error');
    expect(reply.error.context).toEqual({ operation: 'connector_call', supabaseCode: '42501' });
    expect(JSON.stringify(reply.error.toJSON())).not.toContain('ghl_contacts');
  });

  it('a transport failure, or a fetch that throws, is a retryable network error', async () => {
    stub(() => {
      throw new TypeError('fetch failed');
    });
    const reply = await store().call((await input()).call);
    expect(!reply.ok && reply.error.code).toBe('NETWORK');
    expect(!reply.ok && reply.error.retryable).toBe(true);
  });
});

describe('key management over Supabase', () => {
  it('issue: sends the digest, never the key; and reads the three refusals from their codes', async () => {
    const minted = await mintKey();
    stub((req) =>
      req.path === '/rest/v1/rpc/issue_connector_key'
        ? json([{ id: 'u1', key_id: minted.keyId, created_at: '2026-10-13T04:00:00+00:00' }])
        : undefined,
    );
    const issued = await admin().issue({
      userId: 'user-1',
      keyId: minted.keyId,
      digestHex: minted.digestHex,
      label: 'Grok',
    });
    expect(issued.ok && issued.value).toEqual({
      kind: 'issued',
      keyId: minted.keyId,
      createdAt: '2026-10-13T04:00:00+00:00',
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_user_id: 'user-1',
      p_key_id: minted.keyId,
      p_key_hash: `\\x${minted.digestHex}`,
      p_label: 'Grok',
      p_created_by: null,
    });
    expect(JSON.stringify(seen)).not.toContain(minted.key);

    for (const [code, kind] of [
      ['CK001', 'not_staff'],
      ['CK002', 'too_many'],
      ['CK003', 'id_taken'],
    ] as const) {
      stub(() => json({ code, message: 'x' }, 400));
      const refused = await admin().issue({
        userId: 'u',
        keyId: minted.keyId,
        digestHex: minted.digestHex,
        label: '',
      });
      expect(refused.ok && refused.value).toEqual({ kind });
    }
    stub(() =>
      json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409),
    );
    const other = await admin().issue({
      userId: 'u',
      keyId: minted.keyId,
      digestHex: minted.digestHex,
      label: '',
    });
    expect(!other.ok && other.error.message).toBe('issue_connector_key: database error');
    stub(() => json([]));
    const empty = await admin().issue({
      userId: 'u',
      keyId: minted.keyId,
      digestHex: minted.digestHex,
      label: '',
    });
    expect(!empty.ok && empty.error.code).toBe('INTERNAL');
  });

  it('list: selects every column but the digest', async () => {
    stub((req) =>
      req.path === '/rest/v1/connector_keys'
        ? json([
            {
              id: 'k1',
              key_id: 'aaaaaaaaaaaa',
              user_id: 'user-1',
              label: 'Grok',
              created_at: '2026-10-13T04:00:00+00:00',
              last_used_at: null,
              revoked_at: null,
            },
          ])
        : undefined,
    );
    const all = await admin().list(null);
    expect(all.ok && all.value).toEqual([
      {
        keyId: 'aaaaaaaaaaaa',
        userId: 'user-1',
        label: 'Grok',
        createdAt: '2026-10-13T04:00:00+00:00',
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(seen[0]?.query).toContain(
      'select=id,key_id,user_id,label,created_at,last_used_at,revoked_at',
    );
    expect(seen[0]?.query).not.toContain('key_hash');
    expect(seen[0]?.query).not.toContain('*');
    await admin().list('user-1');
    expect(seen[1]?.query).toContain('user_id=eq.user-1');
  });

  it('revoke: revoked, already revoked, and no such key', async () => {
    stub(() =>
      json([{ key_id: 'aaaaaaaaaaaa', revoked_at: '2026-10-13T05:00:00+00:00', already: false }]),
    );
    expect((await admin().revoke('aaaaaaaaaaaa')).ok).toBe(true);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_user_id: null,
      p_key_id: 'aaaaaaaaaaaa',
      p_revoked_by: null,
    });
    stub(() =>
      json([{ key_id: 'aaaaaaaaaaaa', revoked_at: '2026-10-13T05:00:00+00:00', already: true }]),
    );
    const again = await admin().revoke('aaaaaaaaaaaa');
    expect(again.ok && again.value.kind).toBe('already_revoked');
    stub(() => json([]));
    const none = await admin().revoke('zzzzzzzzzzzz');
    expect(none.ok && none.value).toEqual({ kind: 'not_found' });
  });

  it('staff are found by address; emails are fetched for a list, and not at all for an empty one', async () => {
    stub((req) =>
      req.path === '/rest/v1/app_users'
        ? json([{ user_id: 'user-1', email: 'ross@example.test', is_active: true }])
        : undefined,
    );
    const found = await admin().findStaffByEmail('ross@example.test');
    expect(found.ok && found.value).toEqual({
      userId: 'user-1',
      email: 'ross@example.test',
      isActive: true,
    });
    expect(seen[0]?.query).toContain('email=eq.ross@example.test');
    const emails = await admin().emailsFor(['user-1', 'user-1']);
    expect(emails.ok && [...emails.value]).toEqual([['user-1', 'ross@example.test']]);
    const calls = seen.length;
    const none = await admin().emailsFor([]);
    expect(none.ok && none.value.size).toBe(0);
    expect(seen).toHaveLength(calls);
    stub(() => json([]));
    const missing = await admin().findStaffByEmail('nobody@example.test');
    expect(missing.ok && missing.value).toBeNull();
  });

  it('every read fails as an error, not as an empty answer', async () => {
    stub(() => json({ code: '42501', message: 'permission denied' }, 403));
    for (const result of [
      await admin().findStaffByEmail('a@b.test'),
      await admin().list(null),
      await admin().revoke('aaaaaaaaaaaa'),
      await admin().emailsFor(['u']),
    ]) {
      expect(result.ok).toBe(false);
    }
    // A fetch that throws: the two writes, which the client library does not retry. (It
    // retries a failed read with a backoff of its own before giving the same answer.)
    stub(() => {
      throw new TypeError('fetch failed');
    });
    for (const result of [
      await admin().revoke('aaaaaaaaaaaa'),
      await admin().issue({
        userId: 'u',
        keyId: 'aaaaaaaaaaaa',
        digestHex: '00'.repeat(32),
        label: '',
      }),
    ]) {
      expect(!result.ok && result.error.code).toBe('NETWORK');
    }
  });
});
