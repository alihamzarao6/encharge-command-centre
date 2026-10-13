/**
 * MCP connector, stage 1, against a real Supabase stack — the path a request actually takes:
 * the handler → supabase-js → PostgREST → `connector_call`, reached as `authenticator` with
 * the server's role, exactly as the deployed function reaches it.
 *
 * tests/security/connector.test.ts proves what the SQL decides, over a plain Postgres
 * connection. This file proves the same decisions survive the trip through PostgREST — the
 * digest as a `bytea` parameter, the role switch inside a request PostgREST opened, the
 * answer coming back as JSON — and that a key made by `npm run connector`'s own code is a
 * key the endpoint accepts.
 *
 * Every row is seeded under ids of this run and removed afterwards; nothing is asserted about
 * any other row in the database.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearerKeyAuthenticator } from '../../src/lib/connector/auth.js';
import { loadConnectorConfig } from '../../src/lib/connector/config.js';
import {
  handleConnectorRequest,
  type ConnectorDeps,
  type ConnectorHttpResponse,
} from '../../src/lib/connector/handler.js';
import {
  createKeyAdminClient,
  issueKey,
  listKeys,
  revokeKey,
  supabaseKeyAdminStore,
} from '../../src/lib/connector/keyAdmin.js';
import {
  createConnectorServiceClient,
  supabaseConnectorStore,
} from '../../src/lib/connector/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};
const RUN = randomUUID().slice(0, 8);
const FINANCE = `CONNINT-${RUN}-finance`;
const OTHER = `CONNINT-${RUN}-other`;

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly client: SupabaseClient;
}

describe.skipIf(env === null)(
  'the connector through PostgREST (requires a running Supabase stack)',
  () => {
    const db = new pg.Client({ connectionString: cfg.dbUrl });
    const supabase = { url: cfg.url, anonKey: cfg.anonKey, serviceRoleKey: cfg.serviceRoleKey };
    const service = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const keyAdmin = supabaseKeyAdminStore(createKeyAdminClient(supabase));
    const lines: string[] = [];
    const created: string[] = [];
    let alice: TestUser;
    let bob: TestUser;
    let aliceKey = '';
    let aliceKeyId = '';
    let bobKey = '';

    function deps(perMinute = 30): ConnectorDeps {
      const config = loadConnectorConfig({
        GHL_PIPELINE_ID: FINANCE,
        SUPABASE_URL: cfg.url,
        CONNECTOR_RATE_PER_MINUTE: String(perMinute),
      });
      if (!config.ok) throw new Error(config.error.message);
      return {
        config: config.value,
        authenticator: bearerKeyAuthenticator(),
        store: supabaseConnectorStore(createConnectorServiceClient(supabase, 15_000)),
        log: createLogger({ level: 'info', sink: (line) => lines.push(line) }),
      };
    }

    function post(
      key: string,
      message: unknown,
      options: { perMinute?: number; headers?: Record<string, string> } = {},
    ): Promise<ConnectorHttpResponse> {
      const headers = new Map(
        Object.entries({
          authorization: `Bearer ${key}`,
          'mcp-protocol-version': '2025-06-18',
          ...options.headers,
        }),
      );
      return handleConnectorRequest(deps(options.perMinute), {
        method: 'POST',
        hasQuery: false,
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
        readBody: () => Promise.resolve({ ok: true, text: JSON.stringify(message) }),
      });
    }

    const call = (
      name: string,
      args: Record<string, unknown> = {},
      id = 1,
    ): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });

    function toolBody(response: ConnectorHttpResponse): {
      isError: boolean;
      text: string;
      json: Record<string, unknown>;
    } {
      const result = (
        JSON.parse(response.body ?? '{}') as {
          result: { isError: boolean; content: { text: string }[] };
        }
      ).result;
      const text = result.content[0]?.text ?? '';
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // An error result is a sentence, not JSON.
      }
      return { isError: result.isError, text, json };
    }

    async function createUser(label: string): Promise<TestUser> {
      const email = `connint-${label}-${RUN}@example.com`;
      const password = randomUUID();
      const result = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (result.error !== null) throw new Error(result.error.message);
      const id = result.data.user.id;
      created.push(id);
      await db.query(
        `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
        [id, email],
      );
      const signIn = await anon.auth.signInWithPassword({ email, password });
      if (signIn.error !== null) throw new Error(signIn.error.message);
      const client = createClient(cfg.url, cfg.anonKey, {
        global: { headers: { Authorization: `Bearer ${signIn.data.session.access_token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      return { id, email, client };
    }

    async function issued(email: string, label: string): Promise<{ key: string; keyId: string }> {
      const result = await issueKey(keyAdmin, { email, label });
      if (!result.ok || result.value.kind !== 'issued') {
        throw new Error(
          `no key was issued: ${result.ok ? result.value.kind : result.error.message}`,
        );
      }
      return { key: result.value.key, keyId: result.value.keyId };
    }

    beforeAll(async () => {
      await db.connect();
      alice = await createUser('alice');
      bob = await createUser('bob');
      await db.query(
        `insert into public.ghl_pipelines (ghl_id, name, location_id) values ($1, 'Finance Pipeline', 'loc'), ($2, 'Club Memberships', 'loc')`,
        [FINANCE, OTHER],
      );
      await db.query(
        `insert into public.ghl_stages (ghl_id, pipeline_ghl_id, name, position) values ($1, $2, 'New Lead', 0)`,
        [`${FINANCE}-new`, FINANCE],
      );
      await db.query(
        `insert into public.ghl_contacts (ghl_id, full_name, email, phone, custom_fields, content_hash) values
         ($1, 'Zo\u{EB} \u{5F20} \u{1F3E0}', 'zoe@example.com', '+61400000111', '{}'::jsonb, 'h'),
         ($2, 'Casey Clubmember', 'casey@example.com', '+61400000333', '{}'::jsonb, 'h')`,
        [`${FINANCE}-c1`, `${OTHER}-c1`],
      );
      await db.query(
        `insert into public.ghl_opportunities (ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, ghl_created_at, content_hash) values
         ($1, $3, $5, $6, 'Finance one', 'open', now() - interval '1 day', 'h'),
         ($2, $4, 'x', $7, 'Club membership', 'open', now(), 'h')`,
        [
          `${FINANCE}-o1`,
          `${OTHER}-o1`,
          FINANCE,
          OTHER,
          `${FINANCE}-new`,
          `${FINANCE}-c1`,
          `${OTHER}-c1`,
        ],
      );
      await db.query(
        `insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, status, started_at, applied_at, finished_at)
       values ($1, 'test', 'success', now() - interval '3 days', now() - interval '3 days', now() - interval '3 days')`,
        [FINANCE],
      );
      await db.query(
        `insert into public.ghl_notes (ghl_id, contact_ghl_id, opportunity_ghl_id, author_user_id, body, ghl_date_added)
       values ($1, $2, $3, $4, 'Written by Alice.', now())`,
        [`${FINANCE}-n1`, `${FINANCE}-c1`, `${FINANCE}-o1`, alice.id],
      );
      ({ key: aliceKey, keyId: aliceKeyId } = await issued(alice.email, `integration ${RUN}`));
      ({ key: bobKey } = await issued(bob.email, `integration ${RUN}`));
    }, 90_000);

    afterAll(async () => {
      await db.query(
        `delete from public.audit_log where entity_type = 'connector_keys' and after ->> 'user_id' = any($1)`,
        [created],
      );
      await db.query(`delete from public.connector_keys where user_id = any($1::uuid[])`, [
        created,
      ]);
      await db.query(`delete from public.ghl_notes where ghl_id like $1`, [`CONNINT-${RUN}%`]);
      await db.query(`delete from public.ghl_opportunities where ghl_id like $1`, [
        `CONNINT-${RUN}%`,
      ]);
      await db.query(`delete from public.ghl_contacts where ghl_id like $1`, [`CONNINT-${RUN}%`]);
      await db.query(`delete from public.ghl_stages where pipeline_ghl_id = any($1)`, [
        [FINANCE, OTHER],
      ]);
      await db.query(`delete from public.ghl_sync_runs where pipeline_ghl_id = any($1)`, [
        [FINANCE, OTHER],
      ]);
      await db.query(`delete from public.ghl_pipelines where ghl_id = any($1)`, [[FINANCE, OTHER]]);
      await db.query(`delete from public.app_users where user_id = any($1::uuid[])`, [created]);
      for (const id of created) await service.auth.admin.deleteUser(id);
      await db.end();
    }, 60_000);

    it('a key issued by the terminal command connects: the handshake, the tool list, and all four tools', async () => {
      const init = await post(aliceKey, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'integration', version: '1' },
        },
      });
      expect(init.status).toBe(200);
      expect(JSON.parse(init.body ?? '{}')).toMatchObject({
        result: { protocolVersion: '2025-06-18' },
      });

      const summary = toolBody(await post(aliceKey, call('pipeline_summary')));
      expect(summary.isError).toBe(false);
      expect(summary.json).toMatchObject({
        pipeline: { id: FINANCE, name: 'Finance Pipeline' },
        open_leads: 1,
        stages: [{ stage_id: `${FINANCE}-new`, name: 'New Lead', open_leads: 1 }],
        // Three days old: said, and said not to be called current.
        freshness: { age: '3 days', state: 'old' },
      });

      const list = toolBody(await post(aliceKey, call('list_leads')));
      expect(list.json).toMatchObject({
        returned: 1,
        total_matching: 1,
        next_cursor: null,
        leads: [
          {
            lead_id: `${FINANCE}-o1`,
            name: 'Zo\u{EB} \u{5F20} \u{1F3E0}',
            stage: 'New Lead',
            status: 'open',
          },
        ],
      });
      expect(list.text).not.toContain('zoe@example.com');

      const lead = toolBody(await post(aliceKey, call('get_lead', { lead_id: `${FINANCE}-o1` })));
      expect(lead.json['lead']).toMatchObject({
        lead_id: `${FINANCE}-o1`,
        contact: { email: 'zoe@example.com', phone: '+61400000111' },
        notes: [{ written_by: 'you', text: 'Written by Alice.' }],
      });

      const search = toolBody(await post(aliceKey, call('search_leads', { query: 'zoe@example' })));
      expect(search.json).toMatchObject({
        total_matching: 1,
        leads: [{ lead_id: `${FINANCE}-o1`, matched_on: ['email'] }],
      });
    }, 60_000);

    it("the same lead read with another person's key is read as THAT person", async () => {
      const lead = toolBody(await post(bobKey, call('get_lead', { lead_id: `${FINANCE}-o1` })));
      expect((lead.json['lead'] as { notes: unknown[] }).notes).toEqual([
        expect.objectContaining({ written_by: 'a team member', text: 'Written by Alice.' }),
      ]);
      const rows = await db.query<{ user_id: string }>(
        `select distinct c.user_id from public.connector_calls c where c.user_id = any($1::uuid[])`,
        [[alice.id, bob.id]],
      );
      expect(new Set(rows.rows.map((row) => row.user_id))).toEqual(new Set([alice.id, bob.id]));
    }, 30_000);

    it("the other business's pipeline is out of reach: not found, not listed, not searchable", async () => {
      const foreign = toolBody(await post(aliceKey, call('get_lead', { lead_id: `${OTHER}-o1` })));
      const never = toolBody(
        await post(aliceKey, call('get_lead', { lead_id: `CONNINT-${RUN}-nope` })),
      );
      expect(foreign.isError).toBe(true);
      expect(foreign.text).toBe(never.text);
      const search = toolBody(await post(aliceKey, call('search_leads', { query: 'Clubmember' })));
      expect(search.json).toMatchObject({ total_matching: 0, leads: [] });
    }, 30_000);

    it('the limit is counted in the database: the fourth request in a minute is refused, clearly', async () => {
      const { key } = await issued(bob.email, `rate ${RUN}`);
      for (let i = 0; i < 3; i += 1) {
        expect(
          toolBody(await post(key, call('pipeline_summary', {}, i), { perMinute: 3 })).isError,
        ).toBe(false);
      }
      const refusedTool = toolBody(await post(key, call('pipeline_summary'), { perMinute: 3 }));
      expect(refusedTool.isError).toBe(true);
      expect(refusedTool.text).toMatch(
        /^Too many requests in the last minute for this key\. Nothing was read\. Wait \d+ seconds?,/,
      );
      const refusedList = await post(
        key,
        { jsonrpc: '2.0', id: 9, method: 'tools/list' },
        { perMinute: 3 },
      );
      expect(refusedList.status).toBe(429);
      expect(Number(refusedList.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it('a revoked key, and a key whose owner was deactivated, are refused on the very next request', async () => {
      const { key, keyId } = await issued(alice.email, `revoke ${RUN}`);
      expect((await post(key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
      const revoked = await revokeKey(keyAdmin, { keyId });
      expect(revoked.ok && revoked.value.kind).toBe('revoked');
      const after = await post(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(after.status).toBe(401);
      expect(after.headers['www-authenticate']).toContain('Bearer');
      // Alice's other key is untouched.
      expect((await post(aliceKey, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(
        200,
      );

      const carol = await createUser('carol');
      const { key: carolKey } = await issued(carol.email, `carol ${RUN}`);
      expect((await post(carolKey, call('pipeline_summary'))).status).toBe(200);
      await db.query('update public.app_users set is_active = false where user_id = $1', [
        carol.id,
      ]);
      const inactive = await post(carolKey, call('pipeline_summary'));
      expect(inactive.status).toBe(401);
      expect(inactive.body).toBe(after.body);
    }, 60_000);

    it('the list shows who holds which key and never the key; five live keys is the most one person has', async () => {
      const dave = await createUser('dave');
      const keys: string[] = [];
      for (let i = 0; i < 5; i += 1) keys.push((await issued(dave.email, `k${String(i)}`)).key);
      const sixth = await issueKey(keyAdmin, { email: dave.email, label: 'one too many' });
      expect(sixth.ok && sixth.value.kind).toBe('too_many');
      const listed = await listKeys(keyAdmin, { email: dave.email });
      if (!listed.ok || listed.value.kind !== 'listed') throw new Error('expected a list');
      expect(listed.value.keys).toHaveLength(5);
      expect(
        listed.value.keys.every((key) => key.email === dave.email && key.state === 'live'),
      ).toBe(true);
      const text = JSON.stringify(listed.value);
      for (const key of keys) expect(text).not.toContain(key.slice(-43));
    }, 60_000);

    it('through her own session a person reads her own keys and never a digest — what a settings screen will use', async () => {
      const mine = await alice.client
        .from('connector_keys')
        .select('key_id, label, last_used_at, revoked_at');
      expect(mine.error).toBeNull();
      const ids = (mine.data ?? []).map((row) => (row as { key_id: string }).key_id);
      expect(ids).toContain(aliceKeyId);
      const theirs = await bob.client
        .from('connector_keys')
        .select('key_id')
        .eq('key_id', aliceKeyId);
      expect(theirs.data).toEqual([]);
      // The digests are in a table of their own whose one policy admits nobody.
      const digest = await alice.client.from('connector_key_secrets').select('*');
      expect(digest.error).toBeNull();
      expect(digest.data).toEqual([]);
      const held = await db.query<{ n: string }>(
        `select count(*) as n from public.connector_key_secrets x join public.connector_keys k on k.id = x.connector_key_id
       where k.key_id = $1`,
        [aliceKeyId],
      );
      expect(held.rows[0]?.n).toBe('1');
      const write = await alice.client
        .from('connector_keys')
        .update({ revoked_at: null })
        .eq('key_id', aliceKeyId);
      expect(write.error?.code).toBe('42501');
      const calls = await bob.client.from('connector_calls').select('user_id');
      const owners = (calls.data ?? []) as { user_id: string }[];
      expect(new Set(owners.map((row) => row.user_id))).toEqual(new Set([bob.id]));
    }, 30_000);

    it('no browser can call the functions: not signed out, not signed in', async () => {
      for (const client of [anon, alice.client]) {
        const door = await client.rpc('connector_call', {
          p_key_id: aliceKeyId,
          p_key_hash: `\\x${'00'.repeat(32)}`,
          p_method: 'tools/list',
          p_tool: null,
          p_args: null,
          p_pipeline_ghl_id: FINANCE,
          p_per_minute: 30,
          p_per_day: 1000,
        });
        expect(door.error).not.toBeNull();
        const reader = await client.rpc('connector_read', {
          p_user_id: bob.id,
          p_pipeline_ghl_id: FINANCE,
          p_tool: 'list_leads',
          p_args: {},
        });
        expect(reader.error).not.toBeNull();
        const issue = await client.rpc('issue_connector_key', {
          p_user_id: alice.id,
          p_key_id: 'aaaaaaaaaaaa',
          p_key_hash: `\\x${'00'.repeat(32)}`,
          p_label: 'x',
          p_created_by: null,
        });
        expect(issue.error).not.toBeNull();
      }
    }, 30_000);

    it('nothing that was logged holds a key, a name, an email or a phone number', () => {
      const all = lines.join('\n');
      expect(lines.length).toBeGreaterThan(10);
      for (const secret of [
        aliceKey,
        bobKey,
        aliceKey.slice(-43),
        'Zo\u{EB}',
        'zoe@example.com',
        '+61400000111',
        'Written by Alice',
      ]) {
        expect(all).not.toContain(secret);
      }
      expect(all).toContain(`"caller":"${aliceKeyId}"`);
    });
  },
);
