/**
 * The settings page against a real Supabase stack (Milestone 5 part 4): forgetting a document as
 * the handler does it, every Part C case for it, a question asked before and straight after, and
 * a connector key switched off while the connector is being called — through the real handlers,
 * the real stores, PostgREST and the database functions.
 *
 * Nothing here depends on winning a race. "Two tabs" runs both forgets at once and asserts the
 * only two outcomes that can follow in either order; "a call in flight" holds the call's own
 * transaction open on purpose, WAITS until it can see the switch-off blocked behind it, and only
 * then lets it go.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { supabaseVerifyDeps, createServiceClient } from '../../src/lib/auth/clients.js';
import { bearerKeyAuthenticator } from '../../src/lib/connector/auth.js';
import { loadConnectorConfig } from '../../src/lib/connector/config.js';
import {
  handleConnectorRequest,
  type ConnectorHttpResponse,
} from '../../src/lib/connector/handler.js';
import { digestKey } from '../../src/lib/connector/keys.js';
import {
  byteaHex,
  createConnectorServiceClient,
  supabaseConnectorStore,
} from '../../src/lib/connector/store.js';
import { ok } from '../../src/lib/errors.js';
import { createTurnDocuments } from '../../src/lib/files/context.js';
import { createFilesServiceClient, supabaseFileStore } from '../../src/lib/files/store.js';
import { KNOWLEDGE_DEFAULTS } from '../../src/lib/knowledge/config.js';
import { handleChatTurn, type ChatDeps } from '../../src/lib/llm/chat.js';
import { supabaseConversationStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';
import { SettingsStack, hashFor, vector, type StackUser } from '../helpers/settingsStack.js';
import { completion, scriptedClaude } from '../unit/files/helpers.js';

const env = loadSupabaseTestEnv();
const RUN = randomUUID().slice(0, 8);
const AXIS = 409;
const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

describe.skipIf(env === null)('the settings page (requires a running Supabase stack)', () => {
  const stack = new SettingsStack(cfg, RUN);
  const log = createLogger({ level: 'silent' });
  let ross: StackUser;

  beforeAll(async () => {
    await stack.connect();
    ross = await stack.user('ross', { active: true, admin: true });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  /** A real turn: verify, conversations, the files and knowledge stores, the vector search. */
  function turn(): { deps: ChatDeps; claude: ReturnType<typeof scriptedClaude> } {
    const claude = scriptedClaude(ok(completion('An answer.')));
    const service = createServiceClient(cfg);
    const knowledge = stack.knowledge;
    return {
      claude,
      deps: {
        verify: supabaseVerifyDeps(service),
        claude,
        conversations: supabaseConversationStore(service),
        log,
        documents: createTurnDocuments(
          supabaseFileStore(createFilesServiceClient(cfg)),
          48_000,
          () => new Date(),
          {
            sourcesForFiles: (ids) => knowledge.sourcesForFiles(ids),
            match: (q, p) => knowledge.match(q, p),
            neighbours: (s, o) => knowledge.neighbours(s, o),
            summaries: (s) => knowledge.summariesOf(s),
            anyReady: () => knowledge.anyReady(),
            config: { ...KNOWLEDGE_DEFAULTS.retrieval, minSimilarity: 0.9 },
            log,
          },
        ),
        query: {
          embed: () =>
            Promise.resolve(
              ok({ vector: vector(AXIS), text: '', aboutDocuments: true, overview: false }),
            ),
        },
      },
    };
  }

  async function ask(conversationId: string | null, canary: string): Promise<boolean> {
    const t = turn();
    const result = await handleChatTurn(t.deps, {
      token: ross.token,
      message: 'what does the rate sheet say',
      ...(conversationId === null ? {} : { conversationId }),
    });
    expect(result.status).toBe(200);
    return JSON.stringify(t.claude.calls).includes(canary);
  }

  describe('forgetting', () => {
    it('a question that found it before does not find it straight after — elsewhere, or in its own conversation', async () => {
      const canary = `RATE-CANARY-${RUN}-a`;
      const own = await stack.conversation(ross, 'workspace');
      const doc = await stack.attach(
        own,
        ross,
        hashFor(RUN, 10),
        `Two year fixed 5.99% ${canary}`,
        'ready',
        AXIS,
      );
      // A copy of the same file in a second conversation — it would answer there otherwise.
      const elsewhere = await stack.conversation(ross, 'workspace');
      const copy = await stack.attach(
        elsewhere,
        ross,
        hashFor(RUN, 10),
        `Two year fixed 5.99% ${canary}`,
        'ready',
        AXIS,
      );

      expect(await ask(null, canary)).toBe(true);
      expect(await ask(own, canary)).toBe(true);
      expect(await ask(elsewhere, canary)).toBe(true);

      const forgot = await stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId });
      // Three conversations answered from it — a new one (from the learned copy), its own and the
      // copy's (each from its attachment) — and every one of them still holds that answer.
      expect(forgot).toMatchObject({
        status: 200,
        body: {
          outcome: 'forgotten',
          sources: 2,
          files: 2,
          chunks: 6,
          conversationsWithAnswers: 3,
        },
      });

      expect(await ask(null, canary)).toBe(false);
      expect(await ask(own, canary)).toBe(false);
      expect(await ask(elsewhere, canary)).toBe(false);
      for (const d of [doc, copy]) {
        expect(await stack.state(d)).toEqual({
          source: 'forgotten',
          chunks: 0,
          file: 'removed',
          pages: 0,
        });
      }
    });

    it('a question in flight: what it already holds it keeps; nothing more of the document reaches it', async () => {
      const own = await stack.conversation(ross, 'workspace');
      const doc = await stack.attach(
        own,
        ross,
        hashFor(RUN, 11),
        `In flight ${RUN}`,
        'ready',
        AXIS,
      );
      const params = {
        userId: ross.id,
        attachedFileIds: [],
        excludeFileIds: [],
        includeLearned: true,
        sections: [],
        limit: 20,
        minSimilarity: 0.9,
        attachedMinSimilarity: 0.9,
      };
      // The turn's search ran and chose passages...
      const before = await stack.knowledge.match(vector(AXIS), params);
      expect(before.ok && before.value.some((c) => c.sourceId === doc.sourceId)).toBe(true);
      // ...the document is forgotten while the turn is still assembling its prompt...
      await stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId });
      // ...and the turn's next reads — the passages either side, the summary — get nothing.
      const neighbours = await stack.knowledge.neighbours(doc.sourceId, [1, 2]);
      const summaries = await stack.knowledge.summariesOf(doc.sourceId);
      expect(neighbours.ok && neighbours.value).toEqual([]);
      expect(summaries.ok && summaries.value).toEqual([]);
      const after = await stack.knowledge.match(vector(AXIS), params);
      expect(after.ok && after.value.some((c) => c.sourceId === doc.sourceId)).toBe(false);
    });

    it('a document still being learned: forgotten, and the drain’s next batch for it takes nothing', async () => {
      const own = await stack.conversation(ross, 'workspace');
      const doc = await stack.attach(
        own,
        ross,
        hashFor(RUN, 12),
        `Learning ${RUN}`,
        'learning',
        AXIS,
      );
      expect((await stack.state(doc)).source).toBe('learning');
      const forgot = await stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId });
      expect(forgot).toMatchObject({ status: 200, body: { outcome: 'forgotten', files: 1 } });
      // The embedding batch that was in flight comes back: refused, nothing stored.
      const late = await stack.knowledge.attachEmbeddings(doc.sourceId, [
        { ordinal: 2, vector: vector(AXIS) },
      ]);
      expect(late.ok && late.value).toEqual({
        status: 'forgotten',
        embeddedCount: 0,
        chunkCount: 0,
      });
      expect(await stack.state(doc)).toEqual({
        source: 'forgotten',
        chunks: 0,
        file: 'removed',
        pages: 0,
      });
    });

    it('a document never learned: its attachment still held the text — both go', async () => {
      const own = await stack.conversation(ross, 'workspace');
      const doc = await stack.attach(own, ross, hashFor(RUN, 13), `Never ${RUN}`, 'failed', AXIS);
      expect(await stack.state(doc)).toEqual({
        source: 'failed',
        chunks: 0,
        file: 'ready',
        pages: 1,
      });
      const forgot = await stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId });
      expect(forgot).toMatchObject({
        status: 200,
        body: { outcome: 'forgotten', sources: 1, files: 1, chunks: 0 },
      });
      expect(await stack.state(doc)).toEqual({
        source: 'forgotten',
        chunks: 0,
        file: 'removed',
        pages: 0,
      });
    });

    it('a document whose file was purged past its 30 days: the knowledge is still there, and still forgettable', async () => {
      const own = await stack.conversation(ross, 'workspace');
      const doc = await stack.attach(own, ross, hashFor(RUN, 14), `Purged ${RUN}`, 'ready', AXIS);
      await stack.db.query(
        `update public.conversation_files set expires_at = now() - interval '31 days', created_at = now() - interval '61 days' where id = $1`,
        [doc.fileId],
      );
      await stack.db.query(`select public.remove_conversation_file($1, null, 'expired')`, [
        doc.fileId,
      ]);
      expect(await stack.state(doc)).toEqual({
        source: 'ready',
        chunks: 3,
        file: 'removed',
        pages: 0,
      });
      const forgot = await stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId });
      expect(forgot).toMatchObject({
        status: 200,
        body: { outcome: 'forgotten', sources: 1, files: 0, chunks: 3 },
      });
      expect(await stack.state(doc)).toEqual({
        source: 'forgotten',
        chunks: 0,
        file: 'removed',
        pages: 0,
      });
    });

    it('the same document forgotten twice at once, from two tabs: one forgets, the other is told it already went', async () => {
      const own = await stack.conversation(ross, 'workspace');
      const doc = await stack.attach(own, ross, hashFor(RUN, 15), `Twice ${RUN}`, 'ready', AXIS);
      const both = await Promise.all([
        stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId }),
        stack.ask(ross, { action: 'forget_document', sourceId: doc.sourceId }),
      ]);
      expect(both.map((r) => r.status)).toEqual([200, 200]);
      expect(both.map((r) => (r.body as { outcome: string }).outcome).sort()).toEqual([
        'already',
        'forgotten',
      ]);
      const audited = await stack.db.query<{ n: number }>(
        `select count(*)::int as n from public.audit_log where action = 'KNOWLEDGE_FORGOTTEN' and entity_id = $1`,
        [doc.sourceId],
      );
      expect(audited.rows[0]?.n).toBe(1);
    });
  });

  describe('connector keys', () => {
    const PIPELINE = `SETTINGS-${RUN}`;

    function connector(key: string): Promise<ConnectorHttpResponse> {
      const config = loadConnectorConfig({ GHL_PIPELINE_ID: PIPELINE, SUPABASE_URL: cfg.url });
      if (!config.ok) throw new Error(config.error.message);
      const headers = new Map(
        Object.entries({ authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' }),
      );
      return handleConnectorRequest(
        {
          config: config.value,
          authenticator: bearerKeyAuthenticator(),
          store: supabaseConnectorStore(createConnectorServiceClient(cfg, 15_000)),
          log,
        },
        {
          method: 'POST',
          hasQuery: false,
          headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
          readBody: () =>
            Promise.resolve({
              ok: true,
              text: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
            }),
        },
      );
    }

    async function makeKey(label: string): Promise<{ key: string; keyId: string }> {
      const made = await stack.ask(ross, { action: 'create_key', label });
      expect(made.status).toBe(200);
      return made.body as { key: string; keyId: string };
    }

    it('a key made on the page works at the connector; a second key while one exists is simply another', async () => {
      const first = await makeKey(`First ${RUN}`);
      const second = await makeKey(`Second ${RUN}`);
      expect(first.keyId).not.toBe(second.keyId);
      expect((await connector(first.key)).status).toBe(200);
      expect((await connector(second.key)).status).toBe(200);
    });

    it('switched off: the very next request is refused — no cache to wait out — and switching off again says so', async () => {
      const { key, keyId } = await makeKey(`Revoke ${RUN}`);
      expect((await connector(key)).status).toBe(200);
      const revoked = await stack.ask(ross, { action: 'revoke_key', keyId });
      expect(revoked).toMatchObject({ status: 200, body: { outcome: 'revoked', keyId } });
      // No wait of any kind between the two.
      expect((await connector(key)).status).toBe(401);
      const again = await stack.ask(ross, { action: 'revoke_key', keyId });
      expect(again).toMatchObject({ status: 200, body: { outcome: 'already' } });
      expect((await connector(key)).status).toBe(401);
    });

    it('switched off while a call from it is in flight: the call finishes, the switch-off waits for it, the next call is refused', async () => {
      const { key, keyId } = await makeKey(`In flight ${RUN}`);
      const digest = await digestKey(key);
      // The in-flight call: connector_call inside a transaction held open, as a slow request is.
      const call = new pg.Client({ connectionString: cfg.dbUrl });
      await call.connect();
      try {
        await call.query('begin');
        await call.query('set local role service_role');
        const inFlight = await call.query<{ reply: { outcome: string } }>(
          `select public.connector_call($1, $2::bytea, 'ping', null, '{}'::jsonb, $3, 30, 1000) as reply`,
          [keyId, byteaHex(digest), PIPELINE],
        );
        expect(inFlight.rows[0]?.reply.outcome).toBe('ok');

        let settled = false;
        const switchOff = stack.ask(ross, { action: 'revoke_key', keyId }).finally(() => {
          settled = true;
        });
        // Wait until the switch-off is SEEN waiting on the call's lock — an observed state, not a race.
        const deadline = Date.now() + 15_000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const waiting = await stack.db.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
              where wait_event_type = 'Lock' and query like '%revoke_connector_key%'`,
          );
          blocked = (waiting.rows[0]?.n ?? 0) > 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
        await call.query('commit');
        const revoked = await switchOff;
        expect(revoked).toMatchObject({ status: 200, body: { outcome: 'revoked' } });
        expect((await connector(key)).status).toBe(401);
      } finally {
        await call.end();
      }
    });
  });

  describe('spend', () => {
    it('reads what the cap reads: a call recorded now moves today and the month by exactly its cost', async () => {
      const before = await stack.ask(ross, { action: 'spend' });
      expect(before.status).toBe(200);
      await stack.db.query(
        `insert into public.api_usage (provider, operation, model, cost_usd, user_id) values ('anthropic', 'settings-test', 'claude-sonnet-5', 0.123456, $1)`,
        [ross.id],
      );
      const after = await stack.ask(ross, { action: 'spend' });
      const b = before.body as { todayUsd: number; monthUsd: number; capDailyUsd: number };
      const a = after.body as { todayUsd: number; monthUsd: number; capDailyUsd: number };
      expect(a.todayUsd - b.todayUsd).toBeCloseTo(0.123456, 6);
      expect(a.monthUsd - b.monthUsd).toBeCloseTo(0.123456, 6);
      expect(a.capDailyUsd).toBe(5);
      await stack.db.query(
        `delete from public.api_usage where operation = 'settings-test' and user_id = $1`,
        [ross.id],
      );
    });
  });
});
