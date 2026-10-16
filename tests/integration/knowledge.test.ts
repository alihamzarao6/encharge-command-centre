/**
 * Learned knowledge in the real database (migration 20261017010000) — Milestone 5 part 5. The
 * SQL half of every Part C case the in-memory store is unit-tested on (local-store.ts says it
 * restates these functions; this file is what holds the SQL to the same rules):
 *
 *   * an attachment finishing (`finish_conversation_file`) enqueues ONE source, in the same
 *     transaction, and a repeated finish does not enqueue twice;
 *   * capture is idempotent; a half-embedded source is invisible to other conversations and
 *     visible, flagged, in its own; the last batch flips it to ready in the same statement;
 *   * retrieval is exact and correct WITH exclusions in place (the approximate-index trap: an
 *     excluded file's 50 nearer chunks must not hide the one that answers);
 *   * a teammate retrieves from a private conversation's document (decision 3); a deactivated
 *     member and a non-member retrieve nothing;
 *   * the same bytes twice → once; an address read twice → the newer, but only once it is ready;
 *   * a near-identical passage in a newer document flags the older one;
 *   * a deleted conversation keeps its knowledge (decided 16 Oct) and the NULL trap is closed;
 *   * expiry keeps it; removal by a person forgets every copy, audited by id, and an embedding
 *     batch or a capture in flight cannot bring it back;
 *   * the lease, the cooldown, and the scheduler's token (never the secret).
 *
 * pg only, so it also runs against a throwaway PostgreSQL with a stand-in vector type (the
 * vector literal below adapts); CI runs it on the real stack with pgvector. Rows it creates are
 * keyed on RUN and removed in afterAll; no assertion counts a whole table.
 */
import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drainTokenFor } from '../../src/lib/knowledge/schedule.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const DIMS = 1024;

describe.skipIf(env === null)('learned knowledge (requires a database with the migrations)', () => {
  const db = new pg.Client({
    connectionString: env?.dbUrl ?? 'postgresql://stack-not-running.invalid/postgres',
  });
  let stub = false;
  const users: Record<'a' | 'b' | 'deactivated' | 'outsider', string> = {
    a: crypto.randomUUID(),
    b: crypto.randomUUID(),
    deactivated: crypto.randomUUID(),
    outsider: crypto.randomUUID(),
  };
  const convPrivate = crypto.randomUUID();
  const convShared = crypto.randomUUID();
  const sourceIds: string[] = [];

  /** A 1,024-wide vector pointing mostly along `axis`, in whichever literal the column takes. */
  function vec(axis: number, lean = 0, leanAxis = axis + 1): string {
    const v = new Array<number>(DIMS).fill(0);
    v[axis % DIMS] = 1;
    v[leanAxis % DIMS] = lean;
    return stub ? `{${v.join(',')}}` : `[${v.join(',')}]`;
  }

  const hash = (seed: string): string =>
    createHash('sha256')
      .update(seed + RUN)
      .digest('hex');

  async function attach(
    fileId: string,
    conv: string,
    by: string,
    name: string,
    contentHash: string,
    url: string | null,
    pages: number,
  ): Promise<string> {
    await db.query(
      `insert into public.conversation_files
         (id, conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size,
          content_hash, expected_pages, expires_at, source_url, source_host, fetched_at)
       values ($1, $2, $3, 'workspace', $3, gen_random_uuid(), $4, $5, 1000, $6, $7,
               now() + interval '30 days', $8, $9, case when $8::text is null then null else now() end)`,
      [
        fileId,
        conv,
        by,
        name,
        url === null ? 'pdf' : 'html',
        contentHash,
        pages,
        url,
        url === null ? null : 'rates.example',
      ],
    );
    const pagesJson = Array.from({ length: pages }, (_, i) => ({
      page_no: i + 1,
      label: `Page ${String(i + 1)}`,
      content: `Text of page ${String(i + 1)} ${RUN}`,
      extraction_method: url === null ? 'pdf_text_layer' : 'html_text',
      confidence: 1,
      legibility: 'full',
      letter_count: 10,
    }));
    await db.query('select public.append_conversation_file_pages($1, $2::jsonb)', [
      fileId,
      JSON.stringify(pagesJson),
    ]);
    await db.query('select public.finish_conversation_file($1, $2, 1000000)', [fileId, by]);
    const source = await db.query<{ id: string }>(
      'select id from public.knowledge_sources where file_id = $1',
      [fileId],
    );
    const id = source.rows[0]?.id ?? '';
    sourceIds.push(id);
    return id;
  }

  async function capture(
    sourceId: string,
    contents: readonly string[],
    sections: readonly (string | null)[] = [],
    summarise = false,
  ): Promise<void> {
    const chunks = contents.map((content, i) => ({
      ordinal: i + 1,
      page_no: 1,
      page_label: 'Page 1',
      extraction_method: 'pdf_text_layer',
      legibility: 'full',
      char_start: i * 10,
      char_end: i * 10 + content.length,
      content,
      section: sections[i] ?? null,
    }));
    await db.query('select * from public.capture_knowledge_source($1, $2, $3::jsonb, $4)', [
      sourceId,
      'c1-1500-200',
      JSON.stringify(chunks),
      summarise,
    ]);
  }

  async function embed(
    sourceId: string,
    vectors: readonly [number, string][],
  ): Promise<{ status: string; embedded_count: number }> {
    const r = await db.query<{ status: string; embedded_count: number }>(
      'select * from public.attach_knowledge_embeddings($1, $2::jsonb)',
      [sourceId, JSON.stringify(vectors.map(([ordinal, embedding]) => ({ ordinal, embedding })))],
    );
    return r.rows[0] ?? { status: 'none', embedded_count: -1 };
  }

  interface MatchRow {
    source_id: string;
    ordinal: number;
    chunk_kind: string;
    content: string;
    attached: boolean;
    source_status: string;
    section: string | null;
    named: boolean;
    newer_twin_learned_at: string | null;
    similarity: number;
  }

  async function match(
    query: string,
    userId: string,
    attached: readonly string[] = [],
    exclude: readonly string[] = [],
    limit = 40,
    floor = 0,
    includeLearned = true,
    attachedFloor = floor,
    sections: readonly string[] = [],
  ): Promise<MatchRow[]> {
    const r = await db.query<MatchRow>(
      'select * from public.match_knowledge_chunks($1, $2, $3::uuid[], $4::uuid[], $5, $6::text[], $7, $8, $9)',
      [query, userId, attached, exclude, includeLearned, sections, limit, floor, attachedFloor],
    );
    return r.rows.filter((row) => sourceIds.includes(row.source_id));
  }

  async function status(sourceId: string): Promise<Record<string, unknown>> {
    const r = await db.query('select * from public.knowledge_sources where id = $1', [sourceId]);
    return r.rows[0] as Record<string, unknown>;
  }

  beforeAll(async () => {
    await db.connect();
    const type = await db.query<{ typtype: string }>(
      `select t.typtype from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'extensions' and t.typname = 'vector'`,
    );
    stub = type.rows[0]?.typtype === 'd';
    for (const [label, id] of Object.entries(users)) {
      await db.query('insert into auth.users (id, email) values ($1, $2)', [
        id,
        `${label}-${RUN}@knowledge.test`,
      ]);
      if (label !== 'outsider') {
        await db.query(
          `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', $3)`,
          [id, `${label}-${RUN}@knowledge.test`, label !== 'deactivated'],
        );
      }
    }
    await db.query(
      `insert into public.conversations (id, user_id, scope) values ($1, $2, 'user'), ($3, $4, 'workspace')`,
      [convPrivate, users.a, convShared, users.b],
    );
  });

  afterAll(async () => {
    await db.query('delete from public.knowledge_sources where id = any($1::uuid[])', [
      sourceIds.filter((id) => id !== ''),
    ]);
    await db.query(
      'delete from public.conversation_files where conversation_id = any($1::uuid[])',
      [[convPrivate, convShared]],
    );
    await db.query('delete from public.messages where conversation_id = any($1::uuid[])', [
      [convPrivate, convShared],
    ]);
    await db.query('delete from public.conversations where id = any($1::uuid[])', [
      [convPrivate, convShared],
    ]);
    await db.query(
      `delete from public.audit_log where entity_type in ('conversation_files', 'knowledge_sources') and actor = any($1::text[])`,
      [Object.values(users)],
    );
    await db.query('delete from public.app_users where user_id = any($1::uuid[])', [
      Object.values(users),
    ]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [Object.values(users)]);
    await db.query(
      `update public.knowledge_drain_state set lease_holder = null, lease_until = null, cooldown_until = null`,
    );
    await db.end();
  });

  const fileA = crypto.randomUUID();
  let sourceA = '';

  it('an attachment finishing enqueues one pending source, in the same transaction; finishing again does not', async () => {
    sourceA = await attach(
      fileA,
      convPrivate,
      users.a,
      `Course transcript ${RUN}.pdf`,
      hash('a'),
      null,
      3,
    );
    expect(await status(sourceA)).toMatchObject({
      status: 'pending',
      name: `Course transcript ${RUN}.pdf`,
      page_count: 3,
      scope: 'workspace',
      file_id: fileA,
    });
    await db.query('select public.finish_conversation_file($1, $2, 1000000)', [fileA, users.a]);
    const count = await db.query(
      'select count(*)::int as n from public.knowledge_sources where file_id = $1',
      [fileA],
    );
    expect(count.rows[0]).toEqual({ n: 1 });
  });

  it('files already ready when the migration ran are enqueued once, the newest learned first', async () => {
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    await attach(older, convShared, users.b, `Older ${RUN}.pdf`, hash('older'), null, 1);
    await attach(newer, convShared, users.b, `Newer ${RUN}.pdf`, hash('newer'), null, 1);
    // As if attached before the deploy: ready, with no source, read two days and one day ago.
    await db.query('delete from public.knowledge_sources where file_id = any($1::uuid[])', [
      [older, newer],
    ]);
    await db.query(
      `update public.conversation_files set ready_at = now() - case id when $1::uuid then interval '2 days' else interval '1 day' end where id = any($2::uuid[])`,
      [older, [older, newer]],
    );
    const first = await db.query<{ n: number }>(
      'select public.knowledge_enqueue_ready_files() as n',
    );
    expect(first.rows[0]?.n).toBeGreaterThanOrEqual(2);
    const rows = await db.query<{ id: string; file_id: string; status: string; queued: Date }>(
      `select id, file_id, status, created_at as queued from public.knowledge_sources
        where file_id = any($1::uuid[])`,
      [[older, newer]],
    );
    sourceIds.push(...rows.rows.map((r) => r.id));
    const of = (file: string) => rows.rows.find((r) => r.file_id === file);
    expect(of(older)?.status).toBe('pending');
    expect(of(newer)?.status).toBe('pending');
    // The drain takes the oldest queued first, so the newest file is queued earliest.
    expect(Number(of(newer)?.queued)).toBeLessThan(Number(of(older)?.queued));
    await db.query('select public.knowledge_enqueue_ready_files()');
    const again = await db.query<{ n: number }>(
      'select count(*)::int as n from public.knowledge_sources where file_id = any($1::uuid[])',
      [[older, newer]],
    );
    expect(again.rows[0]).toEqual({ n: 2 });
  });

  it('capture stores the chunks once; half embedded is invisible elsewhere, flagged here; the last batch makes it ready', async () => {
    await capture(
      sourceA,
      [`week one plan ${RUN}`, `week two plan ${RUN}`, `week six wrap ${RUN}`],
      ['Week 1', 'Week 1', 'Week 1, Week 2'],
    );
    expect(await status(sourceA)).toMatchObject({
      status: 'learning',
      chunk_count: 3,
      embedded_count: 0,
    });
    await capture(sourceA, ['ignored']);
    expect(await status(sourceA)).toMatchObject({ chunk_count: 3 });

    expect(await embed(sourceA, [[1, vec(10)]])).toMatchObject({
      status: 'learning',
      embedded_count: 1,
    });
    expect(await match(vec(10), users.b)).toEqual([]);
    const here = await match(vec(10), users.a, [fileA]);
    expect(here.map((r) => [r.ordinal, r.attached, r.source_status])).toEqual([
      [1, true, 'learning'],
    ]);

    expect(
      await embed(sourceA, [
        [2, vec(11)],
        [3, vec(12)],
      ]),
    ).toMatchObject({ status: 'ready', embedded_count: 3 });
    expect((await status(sourceA))['ready_at']).not.toBeNull();
  });

  it('a teammate retrieves it — from the author’s PRIVATE conversation — by meaning, best first, above the floor', async () => {
    const found = await match(vec(11, 0.2, 10), users.b);
    expect(found.map((r) => r.ordinal)).toEqual([2, 1, 3]);
    expect((await match(vec(11), users.b, [], [], 40, 0.9)).map((r) => r.ordinal)).toEqual([2]);
  });

  it('learned elsewhere is searched only when asked; the attached floor and the learned floor are separate', async () => {
    // B, a teammate in another conversation: with the learned switch off, nothing.
    expect(await match(vec(11), users.b, [], [], 40, 0, false)).toEqual([]);
    // A, in the conversation the transcript is attached to: still found with the switch off.
    expect(
      (await match(vec(11), users.a, [fileA], [], 40, 0, false)).map((r) => r.ordinal),
    ).toContain(2);
    // A floor no chunk clears for learned documents, a floor every chunk clears for attached ones.
    expect(await match(vec(11, 0.2, 10), users.b, [], [], 40, 0.999, true, 0)).toEqual([]);
    expect((await match(vec(11, 0.2, 10), users.a, [fileA], [], 40, 0.999, true, 0)).length).toBe(
      3,
    );
  });

  it('a chunk keeps its section, and the search returns it', async () => {
    const r = await db.query<{ section: string | null }>(
      'select section from public.knowledge_chunks where source_id = $1 order by ordinal',
      [sourceA],
    );
    expect(r.rows.map((row) => row.section)).toEqual(['Week 1', 'Week 1', 'Week 1, Week 2']);
    const found = await match(vec(12), users.b, [], [], 1, 0.9);
    expect(found).toEqual([
      expect.objectContaining({ ordinal: 3, section: 'Week 1, Week 2', named: false }),
    ]);
  });

  it('a section the question names comes first and skips the floor; one it does not name does not', async () => {
    // Chunk 3 at 0.98, chunk 2 at 0.20, chunk 1 at 0 — under a floor of 0.999 none clears it.
    const q = vec(12, 0.2, 11);
    expect(await match(q, users.b, [], [], 40, 0.999, true, 0.999)).toEqual([]);
    const week2 = await match(q, users.b, [], [], 40, 0.999, true, 0.999, ['Week 2']);
    expect(week2.map((r) => [r.ordinal, r.named])).toEqual([[3, true]]);
    // A chunk spanning two sections answers to either; named ones keep similarity order.
    const week1 = await match(q, users.b, [], [], 40, 0.999, true, 0.999, ['Week 1']);
    expect(week1.map((r) => [r.ordinal, r.named])).toEqual([
      [3, true],
      [2, true],
      [1, true],
    ]);
    expect(await match(q, users.b, [], [], 40, 0.999, true, 0.999, ['Week 9'])).toEqual([]);
    // Chunk 2 is the exact match, but the question named week 2: chunk 3 takes the one place.
    expect(
      (await match(vec(11), users.b, [], [], 1, 0, true, 0, ['Week 2'])).map((r) => r.ordinal),
    ).toEqual([3]);
    // Naming a section never reaches a document the search is not allowed to look at.
    expect(await match(q, users.b, [], [], 40, 0, false, 0, ['Week 1'])).toEqual([]);
    expect(await match(q, users.deactivated, [], [], 40, 0, true, 0, ['Week 1'])).toEqual([]);
  });

  it('nothing outside active staff: a deactivated member and a non-member retrieve nothing', async () => {
    expect(await match(vec(11), users.deactivated)).toEqual([]);
    expect(await match(vec(11), users.outsider)).toEqual([]);
  });

  it('exact, not approximate: 50 nearer chunks of an excluded file do not hide the one that answers', async () => {
    const crowdFile = crypto.randomUUID();
    const crowd = await attach(
      crowdFile,
      convShared,
      users.b,
      `crowd ${RUN}.pdf`,
      hash('c'),
      null,
      1,
    );
    await capture(
      crowd,
      Array.from({ length: 50 }, (_, i) => `crowd ${String(i)} ${RUN}`),
    );
    await embed(
      crowd,
      Array.from({ length: 50 }, (_, i) => [i + 1, vec(20, 0.01 * i, 21)] as [number, string]),
    );
    const target = await match(vec(20, 0.6, 12), users.b, [], [crowdFile], 5);
    expect(target.some((r) => r.source_id === sourceA)).toBe(true);
    expect(target.some((r) => r.source_id === crowd)).toBe(false);
  });

  it('the same bytes twice: copied with no new text, retrieved once', async () => {
    const copyFile = crypto.randomUUID();
    const copy = await attach(
      copyFile,
      convShared,
      users.b,
      `transcript copy ${RUN}.pdf`,
      hash('a'),
      null,
      3,
    );
    const copied = await db.query<{ copied: boolean }>(
      'select public.copy_knowledge_from_twin($1, $2) as copied',
      [copy, 'c1-1500-200'],
    );
    expect(copied.rows[0]?.copied).toBe(true);
    expect(await status(copy)).toMatchObject({ status: 'ready', embedded_count: 3 });
    expect(
      (await match(vec(11), users.b)).filter((r) => r.content === `week two plan ${RUN}`),
    ).toHaveLength(1);
  });

  it('an address read twice: the older answers until the newer is learned, then only the newer', async () => {
    const url = `https://rates.example/${RUN}`;
    const older = await attach(
      crypto.randomUUID(),
      convShared,
      users.b,
      'Rates',
      hash('o'),
      url,
      1,
    );
    await capture(older, [`variable 6.40 ${RUN}`]);
    await embed(older, [[1, vec(30)]]);
    const newer = await attach(
      crypto.randomUUID(),
      convPrivate,
      users.a,
      'Rates',
      hash('n'),
      url,
      1,
    );
    await capture(newer, [`variable 6.15 ${RUN}`]);
    expect((await match(vec(30), users.b, [], [], 40, 0.99)).map((r) => r.content)).toEqual([
      `variable 6.40 ${RUN}`,
    ]);
    await embed(newer, [[1, vec(30)]]);
    expect((await match(vec(30), users.b, [], [], 40, 0.99)).map((r) => r.content)).toEqual([
      `variable 6.15 ${RUN}`,
    ]);
  });

  it('last month’s near-identical sheet is flagged as the older; this month’s is not', async () => {
    const sept = await attach(
      crypto.randomUUID(),
      convShared,
      users.b,
      `September ${RUN}.pdf`,
      hash('s'),
      null,
      1,
    );
    await db.query(
      `update public.knowledge_sources set learned_at = now() - interval '30 days' where id = $1`,
      [sept],
    );
    await capture(sept, [`fixed 6.29 ${RUN}`]);
    await embed(sept, [[1, vec(40, 0.05, 41)]]);
    const oct = await attach(
      crypto.randomUUID(),
      convShared,
      users.b,
      `October ${RUN}.pdf`,
      hash('t'),
      null,
      1,
    );
    await capture(oct, [`fixed 5.99 ${RUN}`]);
    await embed(oct, [[1, vec(40)]]);
    const rows = await match(vec(40), users.b, [], [], 40, 0.9);
    expect(
      rows.find((r) => r.content.startsWith('fixed 6.29'))?.newer_twin_learned_at,
    ).not.toBeNull();
    expect(rows.find((r) => r.content.startsWith('fixed 5.99'))?.newer_twin_learned_at).toBeNull();
  });

  it('expiry keeps the knowledge; deleting the conversation keeps it too, with file_id null and no NULL trap', async () => {
    const expiring = crypto.randomUUID();
    const kept = await attach(
      expiring,
      convShared,
      users.b,
      `expiring ${RUN}.pdf`,
      hash('e'),
      null,
      1,
    );
    await capture(kept, [`kept after expiry ${RUN}`]);
    await embed(kept, [[1, vec(50)]]);
    await db.query(`select public.remove_conversation_file($1, null, 'expired')`, [expiring]);
    expect(await status(kept)).toMatchObject({ status: 'ready', name: `expiring ${RUN}.pdf` });

    await db.query('update public.conversations set deleted_at = now() where id = $1', [
      convShared,
    ]);
    expect(await status(kept)).toMatchObject({ status: 'ready', file_id: null });
    const found = await match(vec(50), users.a, [], [fileA], 40, 0.9);
    expect(found.map((r) => r.source_id)).toContain(kept);
  });

  it('removal by a person forgets every copy of the bytes, audited by id; nothing in flight brings it back', async () => {
    await db.query(`select public.remove_conversation_file($1, $2, 'user')`, [fileA, users.a]);
    const forgotten = await db.query(
      `select id, status, name, content_hash, version_key, chunk_count from public.knowledge_sources where id = any($1::uuid[]) and forgotten_reason = 'user'`,
      [sourceIds],
    );
    expect(forgotten.rows.length).toBe(2);
    for (const row of forgotten.rows)
      expect(row).toMatchObject({
        status: 'forgotten',
        name: null,
        content_hash: null,
        version_key: null,
        chunk_count: 0,
      });
    const chunks = await db.query(
      'select count(*)::int as n from public.knowledge_chunks where source_id = any($1::uuid[])',
      [forgotten.rows.map((r: { id: string }) => r.id)],
    );
    expect(chunks.rows[0]).toEqual({ n: 0 });
    const audit = await db.query(
      `select before from public.audit_log where action = 'KNOWLEDGE_FORGOTTEN' and entity_id = $1`,
      [sourceA],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0])).not.toContain('transcript');
    expect(await embed(sourceA, [[1, vec(10)]])).toMatchObject({ status: 'forgotten' });
    const recapture = await db.query(
      'select * from public.capture_knowledge_source($1, $2, $3::jsonb, false)',
      [
        sourceA,
        'c1',
        JSON.stringify([
          {
            ordinal: 1,
            page_no: 1,
            page_label: 'P',
            extraction_method: 'plain_text',
            legibility: 'full',
            char_start: 0,
            char_end: 1,
            content: 'x',
          },
        ]),
      ],
    );
    expect(recapture.rows[0]).toMatchObject({ status: 'forgotten' });
    expect((await match(vec(11), users.b)).filter((r) => r.content.startsWith('week'))).toEqual([]);
  });

  it('a source whose text is gone before capture fails with a code — and only a pending one', async () => {
    const failing = await attach(
      crypto.randomUUID(),
      convPrivate,
      users.a,
      `gone ${RUN}.pdf`,
      hash('g'),
      null,
      1,
    );
    const r = await db.query<{ ok: boolean }>(
      `select public.fail_knowledge_source($1, 'text_gone') as ok`,
      [failing],
    );
    expect(r.rows[0]?.ok).toBe(true);
    expect(await status(failing)).toMatchObject({ status: 'failed', failure: 'text_gone' });
    const again = await db.query<{ ok: boolean }>(
      `select public.fail_knowledge_source($1, 'text_gone') as ok`,
      [failing],
    );
    expect(again.rows[0]?.ok).toBe(false);
  });

  it('a summary: written after capture, stored after the passages, never a neighbour; ready only with it', async () => {
    const fileS = crypto.randomUUID();
    const src = await attach(
      fileS,
      convShared,
      users.b,
      `Course ${RUN}.pdf`,
      hash('summary'),
      null,
      3,
    );
    await capture(src, [`week one ${RUN}`, `week one more ${RUN}`], ['Week 1', 'Week 1'], true);
    expect(await status(src)).toMatchObject({
      status: 'learning',
      summary_status: 'pending',
      chunk_count: 2,
    });
    const summaries = JSON.stringify([
      {
        position: 1,
        page_no: 1,
        page_to: 3,
        page_label: 'Summary of pages 1–3',
        content: `Recap ${RUN}`,
        section: 'Week 1',
      },
    ]);
    const added = await db.query('select * from public.add_knowledge_summaries($1, $2::jsonb)', [
      src,
      summaries,
    ]);
    expect(added.rows[0]).toEqual({ status: 'learning', chunk_count: 3, summary_status: 'done' });
    // Again: nothing added twice.
    const again = await db.query('select * from public.add_knowledge_summaries($1, $2::jsonb)', [
      src,
      summaries,
    ]);
    expect(again.rows[0]).toMatchObject({ chunk_count: 3, summary_status: 'done' });
    const rows = await db.query<{ ordinal: number; kind: string; page_to: number | null }>(
      'select ordinal, kind, page_to from public.knowledge_chunks where source_id = $1 order by ordinal',
      [src],
    );
    expect(rows.rows.map((r) => [r.ordinal, r.kind, r.page_to])).toEqual([
      [1, 'passage', null],
      [2, 'passage', null],
      [3, 'summary', 3],
    ]);
    // The flip to ready comes with the summary's vector, not before it.
    expect(
      await embed(src, [
        [1, vec(300)],
        [2, vec(301)],
      ]),
    ).toMatchObject({ status: 'learning' });
    expect(await embed(src, [[3, vec(302)]])).toMatchObject({ status: 'ready', embedded_count: 3 });
    // Neighbours are passages: the summary's ordinal is never one.
    const near = await db.query<{ ordinal: number }>(
      'select ordinal from public.knowledge_neighbours($1, $2::integer[])',
      [src, [2, 3]],
    );
    expect(near.rows.map((r) => r.ordinal)).toEqual([2]);
    const read = await db.query(
      'select ordinal, page_no, page_to from public.knowledge_summaries_of($1)',
      [src],
    );
    expect(read.rows).toEqual([{ ordinal: 3, page_no: 1, page_to: 3 }]);
    const found = await match(vec(302), users.a, [], [], 40, 0.99);
    expect(found.filter((r) => r.source_id === src).map((r) => [r.ordinal, r.chunk_kind])).toEqual([
      [3, 'summary'],
    ]);
    // The table itself refuses a summary shaped like a passage, or a passage claiming the model wrote it.
    await expect(
      db.query(
        `insert into public.knowledge_chunks (source_id, ordinal, kind, page_no, page_to, page_label, extraction_method, char_start, char_end, content)
         values ($1, 99, 'summary', 3, 1, 'x', 'model_summary', 0, 1, 'x')`,
        [src],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `insert into public.knowledge_chunks (source_id, ordinal, kind, page_no, page_label, extraction_method, char_start, char_end, content)
         values ($1, 98, 'passage', 1, 'x', 'model_summary', 0, 1, 'x')`,
        [src],
      ),
    ).rejects.toThrow();
    // The same bytes again: copied with the summary, no model call.
    const twinFile = crypto.randomUUID();
    const twin = await attach(
      twinFile,
      convPrivate,
      users.a,
      `Course copy ${RUN}.pdf`,
      hash('summary'),
      null,
      3,
    );
    const copied = await db.query<{ ok: boolean }>(
      'select public.copy_knowledge_from_twin($1, $2) as ok',
      [twin, 'c1-1500-200'],
    );
    expect(copied.rows[0]).toEqual({ ok: true });
    expect(await status(twin)).toMatchObject({
      status: 'ready',
      summary_status: 'done',
      chunk_count: 3,
    });
  });

  it('a summary that keeps failing is given up on: the document is never left waiting', async () => {
    const fileF = crypto.randomUUID();
    const src = await attach(
      fileF,
      convShared,
      users.b,
      `Failing ${RUN}.pdf`,
      hash('fails'),
      null,
      1,
    );
    await capture(src, [`text ${RUN}`], [], true);
    const fail = async () =>
      (await db.query<{ s: string }>('select public.fail_knowledge_summary($1, 2) as s', [src]))
        .rows[0]?.s;
    expect(await fail()).toBe('pending');
    expect(await fail()).toBe('failed');
    expect(await fail()).toBe('unchanged');
    expect(await status(src)).toMatchObject({
      status: 'learning',
      summary_status: 'failed',
      summary_attempts: 2,
    });
  });

  it('the lease: one drain at a time; the holder releases; a cooldown rests everyone', async () => {
    const holder = crypto.randomUUID();
    const other = crypto.randomUUID();
    await db.query(
      'update public.knowledge_drain_state set lease_holder = null, lease_until = null, cooldown_until = null',
    );
    expect(
      (await db.query('select * from public.claim_knowledge_drain($1, 60)', [holder])).rows[0],
    ).toMatchObject({ claimed: true });
    expect(
      (await db.query('select * from public.claim_knowledge_drain($1, 60)', [other])).rows[0],
    ).toMatchObject({ claimed: false });
    expect(
      (await db.query('select public.release_knowledge_drain($1, $2, 0) as ok', [other, 'drained']))
        .rows[0],
    ).toEqual({ ok: false });
    expect(
      (
        await db.query('select public.release_knowledge_drain($1, $2, 65) as ok', [
          holder,
          'rate_limited',
        ])
      ).rows[0],
    ).toEqual({ ok: true });
    const resting = (
      await db.query<{ claimed: boolean; wait_ms: number }>(
        'select * from public.claim_knowledge_drain($1, 60)',
        [other],
      )
    ).rows[0];
    expect(resting?.claimed).toBe(false);
    expect(resting?.wait_ms).toBeGreaterThan(55_000);
    await db.query('update public.knowledge_drain_state set cooldown_until = null');
  });

  it('the scheduler: the token the database makes is the one the function checks; the secret never leaves', async () => {
    const pending = await attach(
      crypto.randomUUID(),
      convPrivate,
      users.a,
      `pending ${RUN}.pdf`,
      hash('p'),
      null,
      1,
    );
    expect(pending).not.toBe('');
    const secret = 'k'.repeat(43);
    await db
      .query(`select vault.create_secret($1, 'knowledge_drain_secret')`, [secret])
      .catch(async () => {
        await db.query(
          `insert into vault.secrets (name, secret) values ('knowledge_drain_secret', $1) on conflict (name) do update set secret = excluded.secret`,
          [secret],
        );
      });
    await db
      .query(
        `select vault.create_secret('https://example.invalid/functions/v1/memory', 'knowledge_drain_url')`,
      )
      .catch(async () => {
        await db.query(
          `insert into vault.secrets (name, secret) values ('knowledge_drain_url', 'https://example.invalid/functions/v1/memory') on conflict (name) do update set secret = excluded.secret`,
        );
      });
    try {
      const dispatched = await db.query<{ d: string }>(
        'select public.dispatch_knowledge_drain() as d',
      );
      expect(dispatched.rows[0]?.d).toBe('requested');
      const sent = stub
        ? await db.query<{ headers: Record<string, string> }>(
            `select headers from net.calls order by id desc limit 1`,
          )
        : await db.query<{ headers: Record<string, string> }>(
            `select headers from net.http_request_queue order by id desc limit 1`,
          );
      const token = sent.rows[0]?.headers['x-knowledge-drain-token'] ?? '';
      expect(JSON.stringify(sent.rows[0])).not.toContain(secret);
      const second = Number(token.split('.')[0]);
      expect(token).toBe(await drainTokenFor(secret, second));
      const job = await db.query(
        `select schedule, command from cron.job where jobname = 'knowledge-drain'`,
      );
      expect(job.rows[0]).toEqual({
        schedule: '* * * * *',
        command: 'select public.dispatch_knowledge_drain()',
      });
    } finally {
      await db.query(
        `delete from vault.secrets where name in ('knowledge_drain_secret', 'knowledge_drain_url')`,
      );
    }
  });

  it('who may call what: the browser roles execute none of it; the dispatcher is the owner’s alone', async () => {
    const fns = [
      'public.match_knowledge_chunks(extensions.vector,uuid,uuid[],uuid[],boolean,text[],integer,double precision,double precision)',
      'public.capture_knowledge_source(uuid,text,jsonb,boolean)',
      'public.add_knowledge_summaries(uuid,jsonb)',
      'public.fail_knowledge_summary(uuid,integer)',
      'public.knowledge_summaries_of(uuid)',
      'public.attach_knowledge_embeddings(uuid,jsonb)',
      'public.forget_knowledge(uuid,text,uuid,text)',
      'public.claim_knowledge_drain(uuid,integer)',
      'public.knowledge_neighbours(uuid,integer[])',
      'public.copy_knowledge_from_twin(uuid,text)',
      'public.fail_knowledge_source(uuid,text)',
      'public.release_knowledge_drain(uuid,text,integer)',
    ];
    const r = await db.query<{ fn: string; role: string; can: boolean }>(
      `select fn, role, has_function_privilege(role, fn, 'execute') as can
       from unnest($1::text[]) fn cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
      [fns],
    );
    for (const row of r.rows)
      expect(row.can, `${row.role} on ${row.fn}`).toBe(row.role === 'service_role');
    const ownerOnly = await db.query<{ fn: string; role: string; can: boolean }>(
      `select fn, role, has_function_privilege(role, fn, 'execute') as can
       from unnest(array['public.dispatch_knowledge_drain()', 'public.knowledge_enqueue_ready_files()']) fn
       cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)`,
    );
    for (const row of ownerOnly.rows) expect(row.can, `${row.role} on ${row.fn}`).toBe(false);
  });
});
