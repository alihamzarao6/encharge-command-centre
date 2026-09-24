/**
 * Moving a lead and adding a note against a real Supabase stack (Milestone 4 part 4) — the
 * production code path (moveLead / addNote over the real write client through
 * src/lib/http.ts, the real write store, the real database functions of migration
 * 20260924010000) with ONE substitution: fetch to GoHighLevel is a scripted world built from
 * the live probe's shapes, so CI touches no live CRM and needs no token.
 *
 * What is proven, row by row:
 *   1. a move: ONE PUT to GoHighLevel, then the mirror row updated from the answer (stage,
 *      hash, last_changed_at), the write record closed with who / from / to / status /
 *      duration, and an audit_log row naming the actor and the two stage ids — and never the
 *      contact's name or email (acceptance items 7, 9);
 *   2. IDEMPOTENCY (Part D item 17): the same request id again is answered from the record
 *      with no PUT, no second write row and no second audit row; the same target with a new
 *      id is a noop — read, not written, not audited;
 *   3. a write that times out and did not land (Part D item 14): the mirror row is
 *      byte-identical to before, the write record says failed/TIMEOUT, no audit row;
 *   4. deleted in GoHighLevel: refused, the mirror row marked removed, no write;
 *   5. in another pipeline (Part D item 16): refused with ZERO writes, whatever the mirror says;
 *   6. a note: ONE POST, the ghl_notes row with the author and the unprefixed body, an audit
 *      row; a member reads it under RLS, an outsider reads nothing;
 *   7. finishing a write twice is a definite CONFLICT.
 *
 * Every row is scoped to this file's pipeline id and removed afterwards. Never a whole-table
 * count: every count is keyed on this run's ids.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GhlConfig } from '../../src/lib/crm/ghl/config.js';
import { addNote, moveLead, type Actor, type MoveDeps } from '../../src/lib/crm/ghl/moves.js';
import { createGhlWriteClient } from '../../src/lib/crm/ghl/write.js';
import {
  createGhlWriteServiceClient,
  supabaseWriteStore,
} from '../../src/lib/crm/ghl/writeStore.js';
import { createHttpClient, type FetchLike } from '../../src/lib/http.js';
import { createLogger } from '../../src/lib/logger.js';
import { loadSupabaseTestEnv } from '../helpers/supabaseEnv.js';

const env = loadSupabaseTestEnv();
const RUN = crypto.randomUUID().slice(0, 8);
const PIPELINE = `WRTEST-${RUN}`;
const OTHER_PIPELINE = `WROTHER-${RUN}`;
const STAGES = ['s1', 's2', 's3'].map((s) => `${PIPELINE}-${s}`);
const OPP = `${PIPELINE}-opp`;
const CONTACT = `${PIPELINE}-contact`;
const CONTACT_NAME = 'Wr Test Person';
const CONTACT_EMAIL = `wr-${RUN}@example.com`;

const cfg = env ?? {
  url: 'http://stack-not-running.invalid',
  anonKey: 'unset',
  serviceRoleKey: 'unset',
  dbUrl: 'postgresql://stack-not-running.invalid/postgres',
};

const config: GhlConfig = {
  token: 'pit-00000000-0000-4000-8000-000000000000',
  baseUrl: 'https://ghl.test',
  apiVersion: '2021-07-28',
  locationId: 'loc',
  pipelineId: PIPELINE,
  customFieldFolderIds: [],
  timeoutMs: 200,
  retries: 0,
  pageSize: 100,
  maxPages: 50,
  maxContactsPerRun: 2_000,
  staleRunAfterSeconds: 900,
  rateLimitFloor: 0,
};

/** The scripted GoHighLevel: one opportunity, and knobs for the failure cases. */
const world = {
  pipelineId: PIPELINE,
  stageId: STAGES[0] ?? '',
  status: 'open' as string,
  contactId: CONTACT as string | null,
  exists: true,
  putBehaviour: 'ok' as 'ok' | 'hang' | 'hang-but-land' | 'stage-invalid',
  puts: 0,
  posts: 0,
  notes: 0,
};

function record(): string {
  return JSON.stringify({
    opportunity: {
      id: OPP,
      name: 'WR test opportunity',
      monetaryValue: 0,
      pipelineId: world.pipelineId,
      pipelineStageId: world.stageId,
      status: world.status,
      lastStatusChangeAt: '2026-09-24T00:57:30.215Z',
      lastStageChangeAt: '2026-09-24T00:57:31.351Z',
      createdAt: '2026-09-24T00:57:30.215Z',
      updatedAt: '2026-09-24T00:57:31.356Z',
      contactId: world.contactId,
      contact: { id: world.contactId, name: CONTACT_NAME, email: CONTACT_EMAIL },
    },
  });
}

const scriptedFetch: FetchLike = (url, init) => {
  const { pathname } = new URL(url);
  const method = init.method ?? 'GET';
  const answer = (body: string, status = 200): Promise<Response> =>
    Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    );
  if (pathname === `/opportunities/${OPP}` && method === 'GET') {
    if (!world.exists) {
      return answer(
        '{"statusCode":404,"error":"Not Found","message":"Opportunity not found","code":"OPPORTUNITY_NOT_FOUND"}',
        404,
      );
    }
    return answer(record());
  }
  if (pathname === `/opportunities/${OPP}` && method === 'PUT') {
    world.puts += 1;
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
      pipelineId: string;
      pipelineStageId: string;
    };
    if (world.putBehaviour === 'stage-invalid') {
      return answer(
        '{"statusCode":400,"error":"Bad Request","message":"stageId must be one of the following values: x","code":"OPPORTUNITY_STAGE_ID_INVALID"}',
        400,
      );
    }
    if (world.putBehaviour === 'hang' || world.putBehaviour === 'hang-but-land') {
      if (world.putBehaviour === 'hang-but-land') world.stageId = body.pipelineStageId;
      return new Promise(() => undefined);
    }
    if (body.pipelineId !== PIPELINE)
      throw new Error('a write named a pipeline other than the configured one');
    world.stageId = body.pipelineStageId;
    return answer(record());
  }
  if (pathname === `/contacts/${CONTACT}/notes` && method === 'POST') {
    world.posts += 1;
    world.notes += 1;
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { body: string };
    return answer(
      JSON.stringify({
        note: {
          id: `${PIPELINE}-note-${String(world.notes)}`,
          body: body.body,
          userId: null,
          dateAdded: '2026-09-24T01:00:00.000Z',
          contactId: CONTACT,
        },
      }),
      201,
    );
  }
  return Promise.reject(new Error(`unexpected route ${method} ${pathname}`));
};

interface TestUser {
  readonly id: string;
  readonly client: SupabaseClient;
}

describe.skipIf(env === null)('moving a lead and adding a note against a real stack', () => {
  const db = new pg.Client({ connectionString: cfg.dbUrl });
  const admin = createClient(cfg.url, cfg.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const logLines: string[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      logLines.push(line);
    },
  });
  const store = supabaseWriteStore(createGhlWriteServiceClient(cfg));
  const http = createHttpClient({ fetch: scriptedFetch, retries: 0, timeoutMs: 200, logger: log });
  const write = createGhlWriteClient({ config, http, log, sleep: () => Promise.resolve() });
  const deps: MoveDeps = { config, write, store, log };
  let staff: TestUser;
  let outsider: TestUser;
  let actor: Actor;
  const created: string[] = [];

  async function createUser(label: string, allowlisted: boolean): Promise<TestUser> {
    const email = `wr-${label}-${RUN}@example.com`;
    const password = crypto.randomUUID();
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (result.error !== null) throw new Error(result.error.message);
    const id = result.data.user.id;
    created.push(id);
    if (allowlisted) {
      await db.query(
        `insert into public.app_users (user_id, email, role, is_active) values ($1, $2, 'staff', true)`,
        [id, email],
      );
    }
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error !== null) throw new Error(signIn.error.message);
    const client = createClient(cfg.url, cfg.anonKey, {
      global: { headers: { Authorization: `Bearer ${signIn.data.session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return { id, client };
  }

  async function opportunityRow(): Promise<Record<string, unknown>> {
    const res = await db.query<{ row: Record<string, unknown> }>(
      `select to_jsonb(o) as row from public.ghl_opportunities o where ghl_id = $1`,
      [OPP],
    );
    const row = res.rows[0]?.row;
    if (row === undefined) throw new Error('opportunity row missing');
    return row;
  }

  async function writeRows(): Promise<Record<string, unknown>[]> {
    const res = await db.query<{ row: Record<string, unknown> }>(
      `select to_jsonb(w) as row from public.ghl_writes w where pipeline_ghl_id = $1 order by started_at`,
      [PIPELINE],
    );
    return res.rows.map((r) => r.row);
  }

  async function auditRows(): Promise<Record<string, unknown>[]> {
    const res = await db.query<{ row: Record<string, unknown> }>(
      `select to_jsonb(a) as row from public.audit_log a
       where entity_type = 'ghl_writes'
         and entity_id in (select id from public.ghl_writes where pipeline_ghl_id = $1)
       order by created_at`,
      [PIPELINE],
    );
    return res.rows.map((r) => r.row);
  }

  beforeAll(async () => {
    await db.connect();
    staff = await createUser('staff', true);
    outsider = await createUser('outsider', false);
    actor = { userId: staff.id, email: `wr-staff-${RUN}@example.com` };
    await db.query(
      `insert into public.ghl_pipelines (ghl_id, name, location_id) values ($1, 'WR pipeline', 'loc')`,
      [PIPELINE],
    );
    for (const [i, stage] of STAGES.entries()) {
      await db.query(
        `insert into public.ghl_stages (ghl_id, pipeline_ghl_id, name, position) values ($1, $2, $3, $4)`,
        [stage, PIPELINE, `Stage ${String(i + 1)}`, i],
      );
    }
    await db.query(
      `insert into public.ghl_contacts (ghl_id, full_name, email, content_hash) values ($1, $2, $3, 'h')`,
      [CONTACT, CONTACT_NAME, CONTACT_EMAIL],
    );
    await db.query(
      `insert into public.ghl_opportunities (ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, content_hash)
       values ($1, $2, $3, $4, 'WR test opportunity', 'open', 'before')`,
      [OPP, PIPELINE, STAGES[0], CONTACT],
    );
  }, 60_000);

  afterAll(async () => {
    await db.query(
      `delete from public.audit_log where entity_type = 'ghl_writes' and entity_id in (select id from public.ghl_writes where pipeline_ghl_id = $1)`,
      [PIPELINE],
    );
    await db.query(`delete from public.ghl_notes where opportunity_ghl_id = $1`, [OPP]);
    await db.query(`delete from public.ghl_writes where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_opportunities where ghl_id = $1`, [OPP]);
    await db.query(`delete from public.ghl_contacts where ghl_id = $1`, [CONTACT]);
    await db.query(`delete from public.ghl_stages where pipeline_ghl_id = $1`, [PIPELINE]);
    await db.query(`delete from public.ghl_pipelines where ghl_id = $1`, [PIPELINE]);
    for (const id of created) {
      await db.query(`delete from public.app_users where user_id = $1`, [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await db.end();
  }, 60_000);

  const s = (i: number): string => STAGES[i] ?? '';
  const move = (requestId: string, to: string, screen: string | null = s(0)) =>
    moveLead(deps, actor, { requestId, opportunityId: OPP, toStageId: to, screenStageId: screen });

  it('1. a move: one PUT, the mirror row from the answer, the write record and the audit row — ids only', async () => {
    const before = await opportunityRow();
    const requestId = crypto.randomUUID();
    const outcome = await move(requestId, s(1));
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(world.puts).toBe(1);
    expect(outcome).toMatchObject({
      fromStageId: s(0),
      toStageId: s(1),
      movedByOther: false,
      mirrored: true,
    });

    const after = await opportunityRow();
    expect(after['stage_ghl_id']).toBe(s(1));
    expect(after['content_hash']).not.toBe('before');
    expect(after['last_changed_at']).not.toBe(before['last_changed_at']);
    expect(after['removed_at']).toBeNull();

    const writes = await writeRows();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      request_id: requestId,
      actor: staff.id,
      kind: 'stage_move',
      pipeline_ghl_id: PIPELINE,
      opportunity_ghl_id: OPP,
      contact_ghl_id: CONTACT,
      from_stage_ghl_id: s(0),
      to_stage_ghl_id: s(1),
      screen_stage_ghl_id: s(0),
      status: 'success',
      ghl_status: 200,
      error_code: null,
    });
    expect(typeof writes[0]?.['duration_ms']).toBe('number');
    expect(writes[0]?.['finished_at']).not.toBeNull();

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: staff.id,
      action: 'LEAD_STAGE_MOVED',
      entity_type: 'ghl_writes',
      entity_id: writes[0]?.['id'],
      before: { opportunity_ghl_id: OPP, stage_ghl_id: s(0) },
      after: { opportunity_ghl_id: OPP, stage_ghl_id: s(1), status: 'success' },
    });
    const everything = JSON.stringify([writes, audits, logLines]);
    expect(everything).not.toContain(CONTACT_NAME);
    expect(everything).not.toContain(CONTACT_EMAIL);
  });

  it('2. idempotency: the same request id is answered from the record; the same target is a noop; neither writes or audits again', async () => {
    const writesBefore = await writeRows();
    const requestId = writesBefore[0]?.['request_id'];
    if (typeof requestId !== 'string') throw new Error('request id');
    const putsBefore = world.puts;

    const replay = await move(requestId, s(1));
    expect(replay.kind).toBe('moved');
    if (replay.kind !== 'moved') return;
    expect(replay.replay).toBe(true);
    expect(replay.fromStageId).toBe(s(0));

    const noop = await move(crypto.randomUUID(), s(1), s(1));
    expect(noop.kind).toBe('unchanged');

    expect(world.puts).toBe(putsBefore);
    const writes = await writeRows();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      status: 'noop',
      from_stage_ghl_id: s(1),
      to_stage_ghl_id: s(1),
    });
    expect(await auditRows()).toHaveLength(1);
    expect((await opportunityRow())['stage_ghl_id']).toBe(s(1));
  });

  it('3. a write that times out and did not land: the mirror row is byte-identical, the record says failed/TIMEOUT, no audit row', async () => {
    const before = await opportunityRow();
    world.putBehaviour = 'hang';
    const outcome = await move(crypto.randomUUID(), s(2), s(1));
    world.putBehaviour = 'ok';
    expect(outcome).toMatchObject({ kind: 'failed', code: 'TIMEOUT' });
    expect(world.stageId).toBe(s(1));
    const after = await opportunityRow();
    // The re-read wrote the row back from GoHighLevel's answer: same stage, same hash.
    expect(after['stage_ghl_id']).toBe(before['stage_ghl_id']);
    expect(after['content_hash']).toBe(before['content_hash']);
    expect(after['last_changed_at']).toBe(before['last_changed_at']);
    const writes = await writeRows();
    expect(writes.at(-1)).toMatchObject({
      status: 'failed',
      error_code: 'TIMEOUT',
      to_stage_ghl_id: s(2),
    });
    expect(await auditRows()).toHaveLength(1);
  });

  it('3b. a write that times out but LANDED: the re-read finds it, success is recorded and audited, one PUT', async () => {
    const putsBefore = world.puts;
    world.putBehaviour = 'hang-but-land';
    const outcome = await move(crypto.randomUUID(), s(2), s(1));
    world.putBehaviour = 'ok';
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.landedAfterTimeout).toBe(true);
    expect(world.puts).toBe(putsBefore + 1);
    expect((await opportunityRow())['stage_ghl_id']).toBe(s(2));
    expect(await auditRows()).toHaveLength(2);
  });

  it('4. deleted in GoHighLevel: refused, the mirror row marked removed, no write', async () => {
    const putsBefore = world.puts;
    world.exists = false;
    const outcome = await move(crypto.randomUUID(), s(0), s(2));
    world.exists = true;
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'OPPORTUNITY_GONE' });
    expect(world.puts).toBe(putsBefore);
    const row = await opportunityRow();
    expect(row['removed_at']).not.toBeNull();
    expect((await writeRows()).at(-1)).toMatchObject({
      status: 'failed',
      error_code: 'OPPORTUNITY_GONE',
    });
    // Put it back for the tests that follow (the sync would do this on the next full read).
    await db.query(`update public.ghl_opportunities set removed_at = null where ghl_id = $1`, [
      OPP,
    ]);
  });

  it('5. in another pipeline, whatever the mirror says: refused with zero writes (Part D item 16)', async () => {
    const putsBefore = world.puts;
    world.pipelineId = OTHER_PIPELINE;
    const outcome = await move(crypto.randomUUID(), s(0), s(2));
    world.pipelineId = PIPELINE;
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'OUTSIDE_PIPELINE' });
    expect(world.puts).toBe(putsBefore);
    expect((await opportunityRow())['stage_ghl_id']).toBe(s(2));
    expect((await writeRows()).at(-1)).toMatchObject({
      status: 'failed',
      error_code: 'OUTSIDE_PIPELINE',
    });
  });

  it('5b. a stage GoHighLevel refuses: nothing changed, recorded as STAGE_UNKNOWN', async () => {
    world.putBehaviour = 'stage-invalid';
    const outcome = await move(crypto.randomUUID(), s(0), s(2));
    world.putBehaviour = 'ok';
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'STAGE_UNKNOWN' });
    expect((await opportunityRow())['stage_ghl_id']).toBe(s(2));
    expect((await writeRows()).at(-1)).toMatchObject({
      status: 'failed',
      error_code: 'STAGE_UNKNOWN',
      ghl_status: 400,
    });
  });

  it('6. a note: one POST, the ghl_notes row with the author and the unprefixed body, an audit row; RLS as everywhere', async () => {
    const outcome = await addNote(deps, actor, {
      requestId: crypto.randomUUID(),
      opportunityId: OPP,
      body: 'Called — no answer. Try after 5pm. 🏠',
    });
    expect(outcome.kind).toBe('noted');
    if (outcome.kind !== 'noted') return;
    expect(world.posts).toBe(1);
    expect(outcome.contactId).toBe(CONTACT);

    const notes = await db.query<{ row: Record<string, unknown> }>(
      `select to_jsonb(n) as row from public.ghl_notes n where opportunity_ghl_id = $1`,
      [OPP],
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]?.row).toMatchObject({
      ghl_id: outcome.noteId,
      contact_ghl_id: CONTACT,
      opportunity_ghl_id: OPP,
      author_user_id: staff.id,
      body: 'Called — no answer. Try after 5pm. 🏠',
      write_id: outcome.writeId,
    });
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'LEAD_NOTE_ADDED',
      actor: staff.id,
    });

    const asStaff = await staff.client
      .from('ghl_notes')
      .select('ghl_id, body')
      .eq('opportunity_ghl_id', OPP);
    expect(asStaff.error).toBeNull();
    expect(asStaff.data).toEqual([
      { ghl_id: outcome.noteId, body: 'Called — no answer. Try after 5pm. 🏠' },
    ]);
    const writesAsStaff = await staff.client
      .from('ghl_writes')
      .select('id')
      .eq('pipeline_ghl_id', PIPELINE);
    expect(writesAsStaff.error).toBeNull();
    expect((writesAsStaff.data ?? []).length).toBeGreaterThan(0);
    const asOutsider = await outsider.client
      .from('ghl_notes')
      .select('ghl_id')
      .eq('opportunity_ghl_id', OPP);
    expect(asOutsider.data).toEqual([]);
    const anonRead = await anon.from('ghl_writes').select('id').eq('pipeline_ghl_id', PIPELINE);
    expect(anonRead.data ?? []).toEqual([]);
  });

  it('7. finishing a write twice is a definite CONFLICT, never a second audit row', async () => {
    const writes = await writeRows();
    const id = writes[0]?.['id'];
    if (typeof id !== 'string') throw new Error('write id');
    const audits = await auditRows();
    const again = await store.finishWrite({
      id,
      status: 'success',
      ghlStatus: 200,
      errorCode: null,
      durationMs: 1,
      fromStageId: s(0),
      opportunity: null,
      note: null,
    });
    expect(!again.ok && again.error.code).toBe('CONFLICT');
    expect(await auditRows()).toHaveLength(audits.length);
  });
});
