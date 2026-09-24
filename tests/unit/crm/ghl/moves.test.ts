/**
 * moveLead / addNote (src/lib/crm/ghl/moves.ts) with a recording fake store and a
 * programmable fake write client — every Part C case that lives in the orchestration:
 *
 *   the write failing: 401 (loud, no re-read), 429, 5xx / timeout / dropped connection /
 *   wrong shape (ONE write, then a READ — landed → success, not landed → failed with the
 *   mirror set to the truth, read also failed → unknown);
 *   the data moving underneath: deleted (404 → refused, row marked removed), the stage gone
 *   (mirror or GoHighLevel), moved by someone else first (last write wins, visibly), the
 *   opportunity closed, the opportunity in ANOTHER pipeline (refused with zero writes —
 *   Part D item 16);
 *   idempotency: the same request id twice is answered from the record (Part D item 17); the
 *   same target twice is a noop with no write; an in-flight id is refused;
 *   the order of calls: GoHighLevel before the mirror, always;
 *   nothing in a log line but ids and statuses.
 */
import { describe, expect, it } from 'vitest';

import {
  AppError,
  TimeoutError,
  ValidationError,
  err,
  ok,
  type Result,
} from '../../../../src/lib/errors.js';
import { RateLimitedError } from '../../../../src/lib/llm/errors.js';
import { createLogger } from '../../../../src/lib/logger.js';
import {
  addNote,
  moveLead,
  notePrefix,
  type Actor,
  type BeginWriteInput,
  type BeginWriteResult,
  type FinishWriteInput,
  type MirrorOpportunity,
  type MoveDeps,
  type WriteStore,
} from '../../../../src/lib/crm/ghl/moves.js';
import {
  OPPORTUNITY_RESPONSE_SCHEMA,
  type GhlNote,
  type GhlOpportunity,
} from '../../../../src/lib/crm/ghl/types.js';
import {
  GhlWriteRefusedError,
  type GhlWriteClient,
  type StageUpdate,
} from '../../../../src/lib/crm/ghl/write.js';
import { FINANCE_PIPELINE_ID, ghlConfig, ghlFixtureJson, must } from './helpers.js';

const OPP = 'bxsEZfR8ghLL19YAL31t';
const CONTACT = 'Kglw9sSb0SI8tg1Lukh7';
const NEW_LEAD = '51c98561-cd26-49a9-a001-97536c31dd0a';
const BOOKED = '3a47fe3c-57d1-41d4-bc89-20241eb978f4';
const CONTACTED = 'f2393065-3038-4fba-bdf1-8c39b7b18183';
const STAGES = [NEW_LEAD, BOOKED, CONTACTED];
const ACTOR: Actor = { userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'ross@example.com' };
const REQUEST = 'd3b07384-d9a0-4f7b-8a5c-000000000001';
const WRITE_ID = 'e0000000-0000-4000-8000-0000000000aa';

function live(overrides: Partial<GhlOpportunity> = {}): GhlOpportunity {
  const base = OPPORTUNITY_RESPONSE_SCHEMA.parse(
    ghlFixtureJson('write-opportunity-get'),
  ).opportunity;
  return { ...base, ...overrides };
}

interface FakeWrite extends GhlWriteClient {
  gets: Result<GhlOpportunity | null>[];
  put: Result<StageUpdate>;
  post: Result<GhlNote>;
  readonly calls: string[];
}

function fakeWrite(): FakeWrite {
  const w: FakeWrite = {
    gets: [ok(live())],
    put: ok({ opportunity: live({ pipelineStageId: CONTACTED }), status: 200, attempts: 1 }),
    post: ok({
      id: 'NOTE0000000000000001',
      body: 'x',
      userId: null,
      dateAdded: '2026-09-24T01:00:00.000Z',
      contactId: CONTACT,
    }),
    calls: [],
    getOpportunity: (id) => {
      w.calls.push(`get:${id}`);
      const next = w.gets.length > 1 ? w.gets.shift() : w.gets[0];
      return Promise.resolve(must(next));
    },
    updateStage: (id, stage) => {
      w.calls.push(`put:${id}:${stage}`);
      return Promise.resolve(w.put);
    },
    createNote: (contact, body) => {
      w.calls.push(`post:${contact}:${body}`);
      return Promise.resolve(w.post);
    },
    requestsMade: () => w.calls.length,
  };
  return w;
}

interface FakeStore extends WriteStore {
  mirror: Result<MirrorOpportunity | null>;
  stages: Result<readonly string[]>;
  begin: Result<BeginWriteResult>;
  finishResult: Result<void>;
  readonly begins: BeginWriteInput[];
  readonly finishes: FinishWriteInput[];
  readonly removed: string[];
  readonly calls: string[];
}

function fakeStore(): FakeStore {
  const s: FakeStore = {
    mirror: ok({
      pipelineId: FINANCE_PIPELINE_ID,
      stageId: NEW_LEAD,
      contactId: CONTACT,
      removedAt: null,
    }),
    stages: ok(STAGES),
    begin: ok({
      id: WRITE_ID,
      existing: false,
      status: 'in_flight',
      fromStageId: null,
      toStageId: CONTACTED,
      errorCode: null,
    }),
    finishResult: ok(undefined),
    begins: [],
    finishes: [],
    removed: [],
    calls: [],
    liveStageIds: () => {
      s.calls.push('stages');
      return Promise.resolve(s.stages);
    },
    mirrorOpportunity: () => {
      s.calls.push('mirror');
      return Promise.resolve(s.mirror);
    },
    beginWrite: (input) => {
      s.calls.push('begin');
      s.begins.push(input);
      return Promise.resolve(s.begin);
    },
    finishWrite: (input) => {
      s.calls.push(`finish:${input.status}`);
      s.finishes.push(input);
      return Promise.resolve(s.finishResult);
    },
    markOpportunityRemoved: (id) => {
      s.calls.push('removed');
      s.removed.push(id);
      return Promise.resolve(ok(true));
    },
  };
  return s;
}

function harness(): { deps: MoveDeps; write: FakeWrite; store: FakeStore; lines: string[] } {
  const write = fakeWrite();
  const store = fakeStore();
  const lines: string[] = [];
  let t = 1_000;
  const deps: MoveDeps = {
    config: ghlConfig(),
    write,
    store,
    log: createLogger({
      level: 'debug',
      sink: (line) => {
        lines.push(line);
      },
    }),
    now: () => (t += 100),
  };
  return { deps, write, store, lines };
}

const move = (h: ReturnType<typeof harness>, screen: string | null = NEW_LEAD, to = CONTACTED) =>
  moveLead(h.deps, ACTOR, {
    requestId: REQUEST,
    opportunityId: OPP,
    toStageId: to,
    screenStageId: screen,
  });

describe('moveLead — the happy path', () => {
  it('reads live, writes GoHighLevel ONCE, then updates the mirror from the answer, in that order', async () => {
    const h = harness();
    const outcome = await move(h);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome).toMatchObject({
      writeId: WRITE_ID,
      opportunityId: OPP,
      fromStageId: NEW_LEAD,
      toStageId: CONTACTED,
      movedByOther: false,
      replay: false,
      landedAfterTimeout: false,
      mirrored: true,
    });
    expect(outcome.durationMs).toBeGreaterThan(0);
    expect(h.write.calls).toEqual([`get:${OPP}`, `put:${OPP}:${CONTACTED}`]);
    expect(h.store.calls).toEqual(['mirror', 'begin', 'stages', 'finish:success']);
    // The mirror is written from GoHighLevel's reply — after the PUT, never before.
    const finish = must(h.store.finishes[0]);
    expect(finish.fromStageId).toBe(NEW_LEAD);
    expect(finish.opportunity?.stage_ghl_id).toBe(CONTACTED);
    expect(finish.opportunity?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(finish.ghlStatus).toBe(200);
    expect(finish.note).toBeNull();
    const begin = must(h.store.begins[0]);
    expect(begin).toMatchObject({
      requestId: REQUEST,
      actor: ACTOR.userId,
      kind: 'stage_move',
      pipelineId: FINANCE_PIPELINE_ID,
      opportunityId: OPP,
      contactId: CONTACT,
      screenStageId: NEW_LEAD,
      toStageId: CONTACTED,
    });
  });

  it('logs who, what, the GoHighLevel status and how long — and never an email', async () => {
    const h = harness();
    await move(h);
    const moved = h.lines.find((l) => l.includes('move: moved'));
    expect(moved).toBeDefined();
    expect(moved).toContain(ACTOR.userId);
    expect(moved).toContain(OPP);
    expect(moved).toContain(CONTACTED);
    expect(moved).toContain('"ghlStatus":200');
    expect(moved).toContain('"durationMs"');
    expect(h.lines.join('\n')).not.toContain('example.com');
  });
});

describe('moveLead — idempotency (Part D item 17)', () => {
  it('the same target twice: the second is a noop — read, never written, recorded as noop', async () => {
    const h = harness();
    h.write.gets = [ok(live({ pipelineStageId: CONTACTED }))];
    const outcome = await move(h, CONTACTED);
    expect(outcome.kind).toBe('unchanged');
    expect(h.write.calls).toEqual([`get:${OPP}`]);
    expect(must(h.store.finishes[0]).status).toBe('noop');
    expect(must(h.store.finishes[0]).opportunity?.stage_ghl_id).toBe(CONTACTED);
  });

  it('the same request id again is answered from the record with zero GoHighLevel calls', async () => {
    const h = harness();
    h.store.begin = ok({
      id: WRITE_ID,
      existing: true,
      status: 'success',
      fromStageId: NEW_LEAD,
      toStageId: CONTACTED,
      errorCode: null,
    });
    const outcome = await move(h);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.replay).toBe(true);
    expect(outcome.fromStageId).toBe(NEW_LEAD);
    expect(h.write.calls).toEqual([]);
    expect(h.store.finishes).toEqual([]);
  });

  it('a request id still in flight is refused, and a finished failure asks for a new id', async () => {
    const a = harness();
    a.store.begin = ok({
      id: WRITE_ID,
      existing: true,
      status: 'in_flight',
      fromStageId: null,
      toStageId: CONTACTED,
      errorCode: null,
    });
    expect(await move(a)).toEqual({ kind: 'refused', reason: 'IN_FLIGHT', writeId: WRITE_ID });
    const b = harness();
    b.store.begin = ok({
      id: WRITE_ID,
      existing: true,
      status: 'failed',
      fromStageId: NEW_LEAD,
      toStageId: CONTACTED,
      errorCode: 'TIMEOUT',
    });
    expect(await move(b)).toEqual({ kind: 'refused', reason: 'REQUEST_REUSED', writeId: WRITE_ID });
    expect(a.write.calls).toEqual([]);
    expect(b.write.calls).toEqual([]);
  });
});

describe('moveLead — the data moving underneath', () => {
  it('deleted in GoHighLevel (404 on the live read): refused, the mirror row marked removed, no write', async () => {
    const h = harness();
    h.write.gets = [ok(null)];
    const outcome = await move(h);
    expect(outcome).toEqual({ kind: 'refused', reason: 'OPPORTUNITY_GONE', writeId: WRITE_ID });
    expect(h.store.removed).toEqual([OPP]);
    expect(h.write.calls).toEqual([`get:${OPP}`]);
    expect(must(h.store.finishes[0])).toMatchObject({
      status: 'failed',
      errorCode: 'OPPORTUNITY_GONE',
      ghlStatus: 404,
    });
  });

  it('the target stage is not in the mirror: refused before any GoHighLevel call', async () => {
    const h = harness();
    const outcome = await move(h, NEW_LEAD, '9cef8b67-0000-4000-8000-000000000000');
    expect(outcome).toEqual({ kind: 'refused', reason: 'STAGE_UNKNOWN', writeId: WRITE_ID });
    expect(h.write.calls).toEqual([]);
    expect(must(h.store.finishes[0]).status).toBe('failed');
  });

  it('GoHighLevel refuses the stage (the list changed since the mirror): refused, nothing changed', async () => {
    const h = harness();
    h.write.put = err(new GhlWriteRefusedError('STAGE_INVALID', 400, 'no such stage'));
    const outcome = await move(h);
    expect(outcome).toEqual({ kind: 'refused', reason: 'STAGE_UNKNOWN', writeId: WRITE_ID });
    expect(h.write.calls).toHaveLength(2);
    const finish = must(h.store.finishes[0]);
    expect(finish.status).toBe('failed');
    expect(finish.ghlStatus).toBe(400);
    // The mirror is set to what the live read found — the lead is still where it was.
    expect(finish.opportunity?.stage_ghl_id).toBe(NEW_LEAD);
  });

  it('someone else moved it first: the move proceeds and says so, with the real previous stage', async () => {
    const h = harness();
    h.write.gets = [ok(live({ pipelineStageId: BOOKED }))];
    const outcome = await move(h, NEW_LEAD);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.movedByOther).toBe(true);
    expect(outcome.fromStageId).toBe(BOOKED);
    expect(must(h.store.finishes[0]).fromStageId).toBe(BOOKED);
  });

  it('closed in GoHighLevel since the screen loaded: refused, no write', async () => {
    const h = harness();
    h.write.gets = [ok(live({ status: 'won' }))];
    expect(await move(h)).toEqual({ kind: 'refused', reason: 'NOT_OPEN', writeId: WRITE_ID });
    expect(h.write.calls).toEqual([`get:${OPP}`]);
  });

  it('in ANOTHER pipeline, whatever the mirror says: refused with zero writes (Part D item 16)', async () => {
    const h = harness();
    h.write.gets = [ok(live({ pipelineId: 'civcWG1oOY8u5g2dGcdM' }))];
    const outcome = await move(h);
    expect(outcome).toEqual({ kind: 'refused', reason: 'OUTSIDE_PIPELINE', writeId: WRITE_ID });
    expect(h.write.calls).toEqual([`get:${OPP}`]);
    expect(h.write.calls.some((c) => c.startsWith('put:'))).toBe(false);
    expect(must(h.store.finishes[0])).toMatchObject({
      status: 'failed',
      errorCode: 'OUTSIDE_PIPELINE',
      opportunity: null,
    });
    expect(h.lines.some((l) => l.includes('another pipeline'))).toBe(true);
  });

  it('the mirror has never seen the opportunity: the live read decides', async () => {
    const h = harness();
    h.store.mirror = ok(null);
    const outcome = await move(h, null);
    expect(outcome.kind).toBe('moved');
    expect(must(h.store.begins[0]).contactId).toBeNull();
  });

  it('GoHighLevel answers 200 with the stage unchanged: failed, the mirror set to the answer', async () => {
    const h = harness();
    h.write.put = ok({
      opportunity: live({ pipelineStageId: NEW_LEAD }),
      status: 200,
      attempts: 1,
    });
    const outcome = await move(h);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'GHL_ERROR', writeId: WRITE_ID });
    expect(must(h.store.finishes[0]).opportunity?.stage_ghl_id).toBe(NEW_LEAD);
  });
});

describe('moveLead — the write failing', () => {
  it('401: loud, no re-read, failed, nothing written to the mirror', async () => {
    const h = harness();
    h.write.put = err(new AppError('UNAUTHENTICATED', 'rejected', { context: { status: 401 } }));
    const outcome = await move(h);
    expect(outcome).toEqual({
      kind: 'failed',
      code: 'UNAUTHENTICATED',
      writeId: WRITE_ID,
      ghlStatus: 401,
    });
    expect(h.write.calls).toHaveLength(2);
    const finish = must(h.store.finishes[0]);
    expect(finish.status).toBe('failed');
    expect(finish.opportunity?.stage_ghl_id).toBe(NEW_LEAD);
  });

  it('429 after the client gave up: failed RATE_LIMITED, no re-read', async () => {
    const h = harness();
    h.write.put = err(new RateLimitedError(5_000, { context: { status: 429 } }));
    const outcome = await move(h);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'RATE_LIMITED', ghlStatus: 429 });
    expect(h.write.calls).toHaveLength(2);
  });

  it('a 401 on the live read itself fails the move before any write', async () => {
    const h = harness();
    h.write.gets = [err(new AppError('UNAUTHENTICATED', 'rejected', { context: { status: 401 } }))];
    const outcome = await move(h);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'UNAUTHENTICATED' });
    expect(h.write.calls).toEqual([`get:${OPP}`]);
  });

  it('timeout, then the re-read says it LANDED: success, noted as landed after timeout, one PUT', async () => {
    const h = harness();
    h.write.put = err(new TimeoutError('PUT timed out', 50));
    h.write.gets = [ok(live()), ok(live({ pipelineStageId: CONTACTED }))];
    const outcome = await move(h);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.landedAfterTimeout).toBe(true);
    expect(h.write.calls).toEqual([`get:${OPP}`, `put:${OPP}:${CONTACTED}`, `get:${OPP}`]);
    expect(must(h.store.finishes[0]).status).toBe('success');
  });

  it('timeout, then the re-read says it did NOT land: failed, the card goes back, the mirror is the truth', async () => {
    const h = harness();
    h.write.put = err(new TimeoutError('PUT timed out', 50));
    const outcome = await move(h);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'TIMEOUT' });
    expect(h.write.calls.filter((c) => c.startsWith('put:'))).toHaveLength(1);
    const finish = must(h.store.finishes[0]);
    expect(finish.status).toBe('failed');
    expect(finish.opportunity?.stage_ghl_id).toBe(NEW_LEAD);
  });

  it('timeout, and the re-read also fails: unknown — recorded as such, nothing written to the mirror', async () => {
    const h = harness();
    h.write.put = err(new TimeoutError('PUT timed out', 50));
    h.write.gets = [ok(live()), err(new TimeoutError('GET timed out', 50))];
    const outcome = await move(h);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'UNKNOWN' });
    const finish = must(h.store.finishes[0]);
    expect(finish.status).toBe('unknown');
    expect(finish.opportunity).toBeNull();
  });

  it('5xx, a dropped connection and a wrong-shaped 2xx all re-read once and never re-write', async () => {
    for (const failure of [
      new AppError('HTTP_STATUS', 'GoHighLevel responded 503', { context: { status: 503 } }),
      new AppError('NETWORK', 'socket hang up'),
      new ValidationError('shape', []),
    ]) {
      const h = harness();
      h.write.put = err(failure);
      const outcome = await move(h);
      expect(outcome.kind).toBe('failed');
      expect(h.write.calls).toEqual([`get:${OPP}`, `put:${OPP}:${CONTACTED}`, `get:${OPP}`]);
    }
  });

  it('the re-read after an uncertain write finds the opportunity gone: refused and marked', async () => {
    const h = harness();
    h.write.put = err(new AppError('NETWORK', 'socket hang up'));
    h.write.gets = [ok(live()), ok(null)];
    expect(await move(h)).toEqual({
      kind: 'refused',
      reason: 'OPPORTUNITY_GONE',
      writeId: WRITE_ID,
    });
    expect(h.store.removed).toEqual([OPP]);
  });

  it('GoHighLevel moved it but the mirror could not be updated: still moved, mirrored false, logged', async () => {
    const h = harness();
    h.store.finishResult = err(new AppError('NETWORK', 'database unreachable'));
    const outcome = await move(h);
    expect(outcome.kind).toBe('moved');
    if (outcome.kind !== 'moved') return;
    expect(outcome.mirrored).toBe(false);
    expect(h.lines.some((l) => l.includes('write record could not be finished'))).toBe(true);
  });

  it('the store refusing before GoHighLevel is involved: failed STORE with zero GoHighLevel calls', async () => {
    const a = harness();
    a.store.mirror = err(new AppError('NETWORK', 'db'));
    expect(await move(a)).toEqual({
      kind: 'failed',
      code: 'STORE',
      writeId: null,
      ghlStatus: null,
    });
    const b = harness();
    b.store.begin = err(new AppError('NETWORK', 'db'));
    expect(await move(b)).toEqual({
      kind: 'failed',
      code: 'STORE',
      writeId: null,
      ghlStatus: null,
    });
    const c = harness();
    c.store.stages = err(new AppError('NETWORK', 'db'));
    expect(await move(c)).toEqual({
      kind: 'failed',
      code: 'STORE',
      writeId: WRITE_ID,
      ghlStatus: null,
    });
    expect([...a.write.calls, ...b.write.calls, ...c.write.calls]).toEqual([]);
  });
});

describe('addNote', () => {
  const note = (h: ReturnType<typeof harness>, body = 'Called, no answer. Try after 5pm.') =>
    addNote(h.deps, ACTOR, { requestId: REQUEST, opportunityId: OPP, body });

  it('reads live, posts the prefixed body to the LIVE contact, mirrors the unprefixed body with the author', async () => {
    const h = harness();
    const outcome = await note(h);
    expect(outcome.kind).toBe('noted');
    if (outcome.kind !== 'noted') return;
    expect(outcome).toMatchObject({
      noteId: 'NOTE0000000000000001',
      contactId: CONTACT,
      body: 'Called, no answer. Try after 5pm.',
      createdAt: '2026-09-24T01:00:00.000Z',
      mirrored: true,
    });
    expect(h.write.calls).toEqual([
      `get:${OPP}`,
      `post:${CONTACT}:${notePrefix(ACTOR)}Called, no answer. Try after 5pm.`,
    ]);
    const finish = must(h.store.finishes[0]);
    expect(finish.status).toBe('success');
    expect(finish.note).toEqual({
      ghl_id: 'NOTE0000000000000001',
      contact_ghl_id: CONTACT,
      opportunity_ghl_id: OPP,
      body: 'Called, no answer. Try after 5pm.',
      ghl_date_added: '2026-09-24T01:00:00.000Z',
    });
    expect(finish.opportunity?.ghl_id).toBe(OPP);
    // The author's email goes to GoHighLevel (that is the point) and nowhere in a log line.
    expect(h.lines.join('\n')).not.toContain('example.com');
  });

  it('unicode and emoji pass through untouched', async () => {
    const h = harness();
    const text = 'Spoke to Ó Brádaigh 🏠 — settling 12/10. “Ready.”';
    const outcome = await note(h, text);
    expect(outcome.kind).toBe('noted');
    expect(must(h.write.calls[1])).toBe(`post:${CONTACT}:${notePrefix(ACTOR)}${text}`);
    expect(must(h.store.finishes[0]).note?.body).toBe(text);
  });

  it('no contact on the live opportunity: refused, nothing posted', async () => {
    const h = harness();
    h.write.gets = [ok(live({ contactId: null }))];
    expect(await note(h)).toEqual({ kind: 'refused', reason: 'NO_CONTACT', writeId: WRITE_ID });
    expect(h.write.calls).toEqual([`get:${OPP}`]);
  });

  it('GoHighLevel refusals: 422 → NOTE_REJECTED, contact gone → NO_CONTACT', async () => {
    const a = harness();
    a.write.post = err(new GhlWriteRefusedError('NOTE_REJECTED', 422, 'empty'));
    expect(await note(a)).toEqual({ kind: 'refused', reason: 'NOTE_REJECTED', writeId: WRITE_ID });
    const b = harness();
    b.write.post = err(new GhlWriteRefusedError('CONTACT_NOT_FOUND', 400, 'gone'));
    expect(await note(b)).toEqual({ kind: 'refused', reason: 'NO_CONTACT', writeId: WRITE_ID });
  });

  it('deleted / another pipeline / a replayed id: refused, nothing posted', async () => {
    const a = harness();
    a.write.gets = [ok(null)];
    expect(await note(a)).toEqual({
      kind: 'refused',
      reason: 'OPPORTUNITY_GONE',
      writeId: WRITE_ID,
    });
    expect(a.store.removed).toEqual([OPP]);
    const b = harness();
    b.write.gets = [ok(live({ pipelineId: 'civcWG1oOY8u5g2dGcdM' }))];
    expect(await note(b)).toEqual({
      kind: 'refused',
      reason: 'OUTSIDE_PIPELINE',
      writeId: WRITE_ID,
    });
    const c = harness();
    c.store.begin = ok({
      id: WRITE_ID,
      existing: true,
      status: 'success',
      fromStageId: null,
      toStageId: null,
      errorCode: null,
    });
    expect(await note(c)).toEqual({ kind: 'refused', reason: 'REQUEST_REUSED', writeId: WRITE_ID });
    expect(
      [...a.write.calls, ...b.write.calls, ...c.write.calls].filter((x) => x.startsWith('post:')),
    ).toEqual([]);
  });

  it('a timeout on the post is UNKNOWN — one post, never a second, the text is the screen’s to keep', async () => {
    const h = harness();
    h.write.post = err(new TimeoutError('POST timed out', 50));
    const outcome = await note(h);
    expect(outcome).toMatchObject({ kind: 'failed', code: 'UNKNOWN', writeId: WRITE_ID });
    expect(h.write.calls.filter((c) => c.startsWith('post:'))).toHaveLength(1);
    expect(must(h.store.finishes[0]).status).toBe('unknown');
  });

  it('401 on the post is loud and failed', async () => {
    const h = harness();
    h.write.post = err(new AppError('UNAUTHENTICATED', 'rejected', { context: { status: 401 } }));
    expect(await note(h)).toMatchObject({
      kind: 'failed',
      code: 'UNAUTHENTICATED',
      ghlStatus: 401,
    });
  });
});
