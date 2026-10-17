/**
 * Fixtures for the settings page's stack suites (Milestone 5 part 4): users signed in through
 * GoTrue, documents attached and learned through the same database functions the files function
 * and the drain call, and the settings handler wired to the real stores. Every row carries this
 * run's tag; `cleanup` removes what was made and nothing else.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';

import { createServiceClient, supabaseVerifyDeps } from '../../src/lib/auth/clients.js';
import { ok } from '../../src/lib/errors.js';
import {
  createKnowledgeServiceClient,
  supabaseKnowledgeStore,
  type KnowledgeStore,
} from '../../src/lib/knowledge/store.js';
import { supabaseUsageStore } from '../../src/lib/llm/store.js';
import { createLogger } from '../../src/lib/logger.js';
import {
  handleSettingsRequest,
  type SettingsPageDeps,
  type SettingsPageResult,
} from '../../src/lib/settings/page.js';
import { createSettingsClient, supabaseSettingsStore } from '../../src/lib/settings/store.js';
import type { SupabaseTestEnv } from './supabaseEnv.js';

export const DIMS = 1024;

export function vector(axis: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[axis] = 1;
  return v;
}

export interface StackUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly client: SupabaseClient;
}

export interface SeededDocument {
  readonly fileId: string;
  readonly sourceId: string;
  readonly hash: string;
}

export type Learning = 'ready' | 'learning' | 'pending' | 'failed';

export class SettingsStack {
  readonly db: pg.Client;
  readonly admin: ReturnType<typeof createClient>;
  readonly knowledge: KnowledgeStore;
  readonly lines: string[] = [];
  private readonly users: StackUser[] = [];
  private readonly conversations: string[] = [];
  private readonly sources: string[] = [];

  constructor(
    readonly cfg: SupabaseTestEnv,
    readonly run: string,
  ) {
    this.db = new pg.Client({ connectionString: cfg.dbUrl });
    this.admin = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    this.knowledge = supabaseKnowledgeStore(createKnowledgeServiceClient(cfg));
  }

  async connect(): Promise<void> {
    await this.db.connect();
  }

  /** A real account; `staff` puts it on the allowlist, `admin` makes it an administrator. */
  async user(label: string, staff: { active: boolean; admin: boolean } | null): Promise<StackUser> {
    const email = `settings-${label}-${this.run}@example.com`;
    const password = crypto.randomUUID();
    const made = await this.admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (made.error !== null) throw new Error(`createUser ${label}: ${made.error.message}`);
    const id = made.data.user.id;
    if (staff !== null) {
      await this.db.query(
        `insert into public.app_users (user_id, email, role, is_active, is_admin) values ($1, $2, 'staff', $3, $4)`,
        [id, email, staff.active, staff.admin],
      );
    }
    // Signed in on a client of its own, so no other client is left holding this session.
    const signer = createClient(this.cfg.url, this.cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await signer.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(`signIn ${label}: ${signIn.error.message}`);
    const token = signIn.data.session.access_token;
    const client = createClient(this.cfg.url, this.cfg.anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const user = { id, email, token, client };
    this.users.push(user);
    return user;
  }

  async conversation(owner: StackUser, scope: 'user' | 'workspace'): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.query(
      'insert into public.conversations (id, user_id, scope) values ($1, $2, $3)',
      [id, owner.id, scope],
    );
    this.conversations.push(id);
    return id;
  }

  /**
   * A document attached the way the files function attaches one — begin's row, the pages,
   * finish — so the enqueue trigger makes its learned copy; then learned as far as `learning`
   * says, through the store the drain uses. `text` is the one page's text.
   */
  async attach(
    conversation: string,
    uploader: StackUser,
    hash: string,
    text: string,
    learning: Learning,
    axis: number,
  ): Promise<SeededDocument> {
    const fileId = crypto.randomUUID();
    const scope = await this.db.query<{ scope: string; user_id: string }>(
      'select scope, user_id from public.conversations where id = $1',
      [conversation],
    );
    const owner = scope.rows[0];
    if (owner === undefined) throw new Error('no such conversation');
    await this.db.query(
      `insert into public.conversation_files (id, conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size, content_hash, expected_pages, expires_at)
       values ($1, $2, $3, $4, $5, gen_random_uuid(), $6, 'pdf', 1000, $7, 1, now() + interval '30 days')`,
      [
        fileId,
        conversation,
        owner.user_id,
        owner.scope,
        uploader.id,
        `Settings doc ${this.run}.pdf`,
        hash,
      ],
    );
    await this.db.query('select public.append_conversation_file_pages($1, $2::jsonb)', [
      fileId,
      JSON.stringify([
        {
          page_no: 1,
          label: 'Page 1',
          content: text,
          extraction_method: 'pdf_text_layer',
          confidence: 1,
          legibility: 'full',
          letter_count: 40,
        },
      ]),
    ]);
    await this.db.query('select public.finish_conversation_file($1, $2, 1000000)', [
      fileId,
      uploader.id,
    ]);
    const source = await this.db.query<{ id: string }>(
      'select id from public.knowledge_sources where file_id = $1',
      [fileId],
    );
    const sourceId = source.rows[0]?.id ?? '';
    this.sources.push(sourceId);
    if (learning === 'pending') return { fileId, sourceId, hash };
    if (learning === 'failed') {
      const failed = await this.knowledge.fail(sourceId, 'no_text');
      if (!failed.ok || !failed.value) throw new Error('the test document did not fail');
      return { fileId, sourceId, hash };
    }
    const chunk = (ordinal: number, content: string) => ({
      ordinal,
      pageNo: 1,
      pageLabel: 'Page 1',
      method: 'pdf_text_layer' as const,
      legibility: 'full' as const,
      section: null,
      charStart: 0,
      charEnd: content.length,
      content,
    });
    const captured = await this.knowledge.capture(
      sourceId,
      'c1-1500-200',
      [chunk(1, text), chunk(2, `${text} (continued)`)],
      learning === 'ready',
    );
    if (!captured.ok) throw captured.error;
    if (learning === 'ready') {
      const summary = await this.knowledge.addSummaries(sourceId, [
        {
          position: 1,
          pageNo: 1,
          pageTo: 1,
          pageLabel: 'Page 1',
          content: `Summary: ${text}`,
          section: null,
        },
      ]);
      if (!summary.ok) throw summary.error;
      const embedded = await this.knowledge.attachEmbeddings(
        sourceId,
        [1, 2, 3].map((ordinal) => ({ ordinal, vector: vector(axis) })),
      );
      if (!embedded.ok || embedded.value.status !== 'ready') {
        throw new Error('the test document did not become ready');
      }
    } else {
      // Learning: one of its passages embedded, the rest still to come.
      const embedded = await this.knowledge.attachEmbeddings(sourceId, [
        { ordinal: 1, vector: vector(axis) },
      ]);
      if (!embedded.ok || embedded.value.status !== 'learning') {
        throw new Error('the test document is not still learning');
      }
    }
    return { fileId, sourceId, hash };
  }

  /** The settings handler over the real stores, logging into `lines`. */
  deps(): SettingsPageDeps {
    const service = createServiceClient(this.cfg);
    return {
      verify: supabaseVerifyDeps(service),
      store: supabaseSettingsStore(createSettingsClient(this.cfg)),
      usage: supabaseUsageStore(service),
      caps: ok({ dailyUsd: 5, monthlyUsd: 80, warnFraction: 0.8 }),
      log: createLogger({ level: 'info', sink: (line) => this.lines.push(line) }),
    };
  }

  ask(user: StackUser | null, body: unknown): Promise<SettingsPageResult> {
    return handleSettingsRequest(this.deps(), { token: user?.token ?? null, body });
  }

  async state(doc: SeededDocument): Promise<{
    source: string;
    chunks: number;
    file: string;
    pages: number;
  }> {
    const row = await this.db.query<{
      source: string;
      chunks: number;
      file: string;
      pages: number;
    }>(
      `select s.status as source,
              (select count(*)::int from public.knowledge_chunks c where c.source_id = s.id) as chunks,
              coalesce((select f.status from public.conversation_files f where f.id = $2), 'gone') as file,
              (select count(*)::int from public.conversation_file_pages p where p.file_id = $2) as pages
         from public.knowledge_sources s where s.id = $1`,
      [doc.sourceId, doc.fileId],
    );
    const found = row.rows[0];
    if (found === undefined) throw new Error('no such source');
    return found;
  }

  async cleanup(): Promise<void> {
    const ids = this.users.map((u) => u.id);
    await this.db.query('delete from public.knowledge_sources where id = any($1::uuid[])', [
      this.sources,
    ]);
    await this.db.query('delete from public.messages where user_id = any($1::uuid[])', [ids]);
    await this.db.query(
      'delete from public.conversation_files where conversation_id = any($1::uuid[])',
      [this.conversations],
    );
    // Including the ones a turn asked without a conversation made for itself.
    await this.db.query(
      'delete from public.conversations where id = any($1::uuid[]) or user_id = any($2::uuid[])',
      [this.conversations, ids],
    );
    await this.db.query('delete from public.connector_keys where user_id = any($1::uuid[])', [ids]);
    await this.db.query('delete from public.audit_log where actor = any($1::text[])', [ids]);
    await this.db.query('delete from public.app_users where user_id = any($1::uuid[])', [ids]);
    for (const user of this.users) await this.admin.auth.admin.deleteUser(user.id);
    await this.db.end();
  }
}

/** A content hash unique to this run and this document. */
export function hashFor(run: string, n: number): string {
  return `${run}${String(n)}`.replace(/[^0-9a-f]/g, '0').padEnd(64, '0');
}
