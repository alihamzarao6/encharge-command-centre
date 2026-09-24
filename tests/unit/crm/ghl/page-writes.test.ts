/**
 * The crm endpoint's two write actions (src/lib/crm/ghl/page.ts, Milestone 4 part 4) with
 * the move / note orchestration faked: what a request must carry, what each outcome becomes
 * on the wire, and what the sentences say. Every refused or failed answer must say the lead
 * was NOT moved (or the note not saved) — the dangerous misreading is the other one.
 *
 *   - no token → 401; not allowlisted / deactivated → 403; the auth server down → 503, and in
 *     every one of those the orchestration is never called (acceptance item 11);
 *   - a member (not only an admin) may move and note; the actor is who was verified;
 *   - missing / malformed ids and request ids → 400 before anything runs; an empty or
 *     over-long note → 400;
 *   - every RefusalReason and FailureCode → its status and its sentence;
 *   - 200 bodies carry ids and flags only — never a name, an email or a phone;
 *   - the log line per request names the actor id, the opportunity id and the outcome.
 */
import { describe, expect, it } from 'vitest';

import type { StaffRow } from '../../../../src/lib/auth/verify.js';
import {
  NOTE_MAX_LENGTH,
  type FailureCode,
  type MoveOutcome,
  type MoveRequest,
  type NoteOutcome,
  type NoteRequest,
  type RefusalReason,
} from '../../../../src/lib/crm/ghl/moves.js';
import {
  describeRefusal,
  describeWriteFailure,
  handleCrmRequest,
  type CrmPageDeps,
  type CrmPageResult,
} from '../../../../src/lib/crm/ghl/page.js';
import { NetworkError, err, ok } from '../../../../src/lib/errors.js';
import { createLogger } from '../../../../src/lib/logger.js';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAFF_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const GONE_ID = 'cccccccc-0000-4000-8000-000000000003';
const OUTSIDER_ID = 'dddddddd-0000-4000-8000-000000000004';
const OPP = 'bxsEZfR8ghLL19YAL31t';
const NEW_LEAD = '51c98561-cd26-49a9-a001-97536c31dd0a';
const CONTACTED = 'f2393065-3038-4fba-bdf1-8c39b7b18183';
const REQUEST = 'D3B07384-D9A0-4F7B-8A5C-000000000001';
const WRITE_ID = 'e0000000-0000-4000-8000-0000000000aa';

const MOVED: MoveOutcome = {
  kind: 'moved',
  writeId: WRITE_ID,
  opportunityId: OPP,
  fromStageId: NEW_LEAD,
  toStageId: CONTACTED,
  movedByOther: false,
  durationMs: 812,
  replay: false,
  landedAfterTimeout: false,
  mirrored: true,
};

const NOTED: NoteOutcome = {
  kind: 'noted',
  writeId: WRITE_ID,
  opportunityId: OPP,
  contactId: 'Kglw9sSb0SI8tg1Lukh7',
  noteId: 'NOTE0000000000000001',
  body: 'Called, no answer.',
  createdAt: '2026-09-24T01:00:00.000Z',
  durationMs: 400,
  replay: false,
  mirrored: true,
};

interface Harness {
  readonly deps: CrmPageDeps;
  readonly moves: { actor: { userId: string; email: string }; request: MoveRequest }[];
  readonly notes: { actor: { userId: string; email: string }; request: NoteRequest }[];
  readonly logLines: string[];
}

function makeHarness(
  move: MoveOutcome = MOVED,
  note: NoteOutcome = NOTED,
  authDown = false,
): Harness {
  const rows = new Map<string, StaffRow>([
    [
      ADMIN_ID,
      { user_id: ADMIN_ID, email: 'admin@x.com', role: 'owner', is_active: true, is_admin: true },
    ],
    [
      STAFF_ID,
      { user_id: STAFF_ID, email: 'staff@x.com', role: 'staff', is_active: true, is_admin: false },
    ],
    [
      GONE_ID,
      { user_id: GONE_ID, email: 'gone@x.com', role: 'staff', is_active: false, is_admin: false },
    ],
  ]);
  const tokens = new Map<string, string>([
    ['admin-token', ADMIN_ID],
    ['staff-token', STAFF_ID],
    ['gone-token', GONE_ID],
    ['outsider-token', OUTSIDER_ID],
  ]);
  const moves: Harness['moves'] = [];
  const notes: Harness['notes'] = [];
  const logLines: string[] = [];
  const deps: CrmPageDeps = {
    verify: {
      getUserFromToken: (token) => {
        if (authDown) return Promise.resolve(err(new NetworkError('auth unreachable')));
        const id = tokens.get(token);
        return Promise.resolve(ok(id === undefined ? null : { id, email: `${id}@x.com` }));
      },
      getStaffRow: (userId) => Promise.resolve(ok(rows.get(userId) ?? null)),
    },
    runSync: () => Promise.reject(new Error('sync is not part of this harness')),
    latestRun: () => Promise.resolve(ok(null)),
    move: (actor, request) => {
      moves.push({ actor, request });
      return Promise.resolve(move);
    },
    note: (actor, request) => {
      notes.push({ actor, request });
      return Promise.resolve(note);
    },
    log: createLogger({
      level: 'debug',
      sink: (line) => {
        logLines.push(line);
      },
    }),
  };
  return { deps, moves, notes, logLines };
}

const MOVE_BODY = {
  action: 'move',
  requestId: REQUEST,
  opportunityId: OPP,
  toStageId: CONTACTED,
  fromStageId: NEW_LEAD,
};
const NOTE_BODY = {
  action: 'note',
  requestId: REQUEST,
  opportunityId: OPP,
  body: 'Called, no answer.',
};

function call(h: Harness, token: string | null, body: unknown): Promise<CrmPageResult> {
  return handleCrmRequest(h.deps, { token, body: body as Record<string, unknown> });
}

describe('who may write (acceptance item 11)', () => {
  it('no token → 401, an outsider or a deactivated member → 403, the auth server down → 503; nothing runs', async () => {
    for (const [token, status] of [
      [null, 401],
      ['bogus', 401],
      ['outsider-token', 403],
      ['gone-token', 403],
    ] as const) {
      const h = makeHarness();
      const result = await call(h, token, MOVE_BODY);
      expect(result.status).toBe(status);
      const noteResult = await call(h, token, NOTE_BODY);
      expect(noteResult.status).toBe(status);
      expect(h.moves).toEqual([]);
      expect(h.notes).toEqual([]);
    }
    const down = makeHarness(MOVED, NOTED, true);
    expect((await call(down, 'admin-token', MOVE_BODY)).status).toBe(503);
    expect(down.moves).toEqual([]);
  });

  it('a member, not only an admin, may move and note; the verified person is the actor', async () => {
    const h = makeHarness();
    const result = await call(h, 'staff-token', MOVE_BODY);
    expect(result.status).toBe(200);
    expect(h.moves[0]?.actor).toEqual({ userId: STAFF_ID, email: 'staff@x.com' });
    await call(h, 'staff-token', NOTE_BODY);
    expect(h.notes[0]?.actor).toEqual({ userId: STAFF_ID, email: 'staff@x.com' });
  });
});

describe('the move request', () => {
  it('passes the ids through, the request id lower-cased, and answers the outcome', async () => {
    const h = makeHarness();
    const result = await call(h, 'admin-token', MOVE_BODY);
    expect(h.moves[0]?.request).toEqual({
      requestId: REQUEST.toLowerCase(),
      opportunityId: OPP,
      toStageId: CONTACTED,
      screenStageId: NEW_LEAD,
    });
    expect(result).toEqual({
      status: 200,
      body: {
        action: 'move',
        opportunityId: OPP,
        fromStageId: NEW_LEAD,
        toStageId: CONTACTED,
        changed: true,
        movedByOther: false,
        replay: false,
        landedAfterTimeout: false,
        mirrored: true,
        writeId: WRITE_ID,
        durationMs: 812,
      },
    });
    const line = h.logLines.find((l) => l.includes('move requested from the app'));
    expect(line).toContain(ADMIN_ID);
    expect(line).toContain(OPP);
    expect(line).toContain('"outcome":"moved"');
    expect(h.logLines.join('\n')).not.toContain('@x.com');
  });

  it('an unchanged outcome is 200 with changed: false', async () => {
    const h = makeHarness({ ...MOVED, kind: 'unchanged' });
    const result = await call(h, 'admin-token', MOVE_BODY);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ action: 'move', changed: false });
  });

  it('fromStageId is optional, and null when the screen did not know', async () => {
    const h = makeHarness();
    const { fromStageId: _omitted, ...withoutFrom } = MOVE_BODY;
    void _omitted;
    await call(h, 'admin-token', withoutFrom);
    expect(h.moves[0]?.request.screenStageId).toBeNull();
    await call(h, 'admin-token', { ...MOVE_BODY, fromStageId: null });
    expect(h.moves[1]?.request.screenStageId).toBeNull();
  });

  it('refuses a malformed request with 400 before anything runs', async () => {
    const h = makeHarness();
    const bad = [
      { ...MOVE_BODY, requestId: 'not-a-uuid' },
      { ...MOVE_BODY, requestId: undefined },
      { ...MOVE_BODY, opportunityId: '../etc' },
      { ...MOVE_BODY, opportunityId: '' },
      { ...MOVE_BODY, toStageId: 42 },
      { ...MOVE_BODY, fromStageId: 'has space' },
      { action: 'move' },
      { action: 'delete', requestId: REQUEST, opportunityId: OPP },
    ];
    for (const body of bad) {
      const result = await call(h, 'admin-token', body);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.moves).toEqual([]);
  });

  it('every refusal is its status and a sentence that says nothing was changed', async () => {
    const reasons: RefusalReason[] = [
      'IN_FLIGHT',
      'REQUEST_REUSED',
      'OPPORTUNITY_GONE',
      'OUTSIDE_PIPELINE',
      'NOT_OPEN',
      'STAGE_UNKNOWN',
      'NO_CONTACT',
      'NOTE_REJECTED',
    ];
    for (const reason of reasons) {
      const h = makeHarness({ kind: 'refused', reason, writeId: WRITE_ID });
      const result = await call(h, 'admin-token', MOVE_BODY);
      const described = describeRefusal(reason);
      expect(result.status, reason).toBe(described.status);
      expect(result.body).toMatchObject({
        error: { code: reason, message: described.message, retryable: false },
        runId: WRITE_ID,
      });
      if (reason !== 'IN_FLIGHT' && reason !== 'REQUEST_REUSED') {
        expect(described.message, reason).toMatch(/Nothing was (changed|saved)/);
      }
    }
    expect(describeRefusal('OPPORTUNITY_GONE').status).toBe(410);
    expect(describeRefusal('OUTSIDE_PIPELINE').status).toBe(403);
    expect(describeRefusal('STAGE_UNKNOWN').message).toContain('refresh');
  });

  it('every failure is its status, its retryability and a sentence that says where the lead is', async () => {
    const codes: FailureCode[] = [
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'RATE_LIMITED',
      'TIMEOUT',
      'NETWORK',
      'CIRCUIT_OPEN',
      'GHL_ERROR',
      'RESPONSE_SHAPE',
      'UNKNOWN',
      'STORE',
    ];
    for (const code of codes) {
      const h = makeHarness({ kind: 'failed', code, writeId: WRITE_ID, ghlStatus: null });
      const result = await call(h, 'admin-token', MOVE_BODY);
      const described = describeWriteFailure(code, 'move');
      expect(result.status, code).toBe(described.status);
      expect(result.body).toMatchObject({
        error: { code, message: described.message, retryable: described.retryable },
      });
      expect(described.message, code).toMatch(/not moved|previous stage|last known stage/);
    }
    // The dead key is loud and says what to do; it must never read as "nothing happened".
    const dead = describeWriteFailure('UNAUTHENTICATED', 'move');
    expect(dead.status).toBe(502);
    expect(dead.message).toContain('reauthorising');
    expect(dead.retryable).toBe(false);
    expect(describeWriteFailure('UNKNOWN', 'move').status).toBe(504);
    expect(describeWriteFailure('RATE_LIMITED', 'move')).toMatchObject({
      status: 503,
      retryable: true,
    });
    expect(describeWriteFailure('TIMEOUT', 'move')).toMatchObject({ status: 502, retryable: true });
  });
});

describe('the note request', () => {
  it('trims the body, passes it through and answers the note', async () => {
    const h = makeHarness();
    const result = await call(h, 'admin-token', { ...NOTE_BODY, body: '  Called, no answer.  ' });
    expect(h.notes[0]?.request).toEqual({
      requestId: REQUEST.toLowerCase(),
      opportunityId: OPP,
      body: 'Called, no answer.',
    });
    expect(result).toEqual({
      status: 200,
      body: {
        action: 'note',
        opportunityId: OPP,
        noteId: 'NOTE0000000000000001',
        body: 'Called, no answer.',
        createdAt: '2026-09-24T01:00:00.000Z',
        authorUserId: ADMIN_ID,
        mirrored: true,
        writeId: WRITE_ID,
        durationMs: 400,
      },
    });
    const line = h.logLines.find((l) => l.includes('note requested from the app'));
    expect(line).toContain('"bodyLength":18');
    expect(line).not.toContain('Called');
  });

  it('an empty or whitespace note is 400 EMPTY_NOTE; over the cap is 400 NOTE_TOO_LONG; nothing runs', async () => {
    const h = makeHarness();
    for (const body of ['', '   ', '\n\t', undefined, 42]) {
      const result = await call(h, 'admin-token', { ...NOTE_BODY, body });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: { code: 'EMPTY_NOTE' } });
    }
    const long = await call(h, 'admin-token', {
      ...NOTE_BODY,
      body: 'x'.repeat(NOTE_MAX_LENGTH + 1),
    });
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ error: { code: 'NOTE_TOO_LONG' } });
    const atCap = await call(h, 'admin-token', { ...NOTE_BODY, body: 'x'.repeat(NOTE_MAX_LENGTH) });
    expect(atCap.status).toBe(200);
    expect(h.notes).toHaveLength(1);
  });

  it('unicode and emoji reach the orchestration untouched', async () => {
    const h = makeHarness();
    const text = 'Spoke to Ó Brádaigh 🏠 — settling 12/10.';
    await call(h, 'admin-token', { ...NOTE_BODY, body: text });
    expect(h.notes[0]?.request.body).toBe(text);
  });

  it('a failed note says the text is still there', async () => {
    for (const code of ['TIMEOUT', 'UNKNOWN', 'NETWORK'] as const) {
      const h = makeHarness(MOVED, { kind: 'failed', code, writeId: WRITE_ID, ghlStatus: null });
      const result = await call(h, 'admin-token', NOTE_BODY);
      expect(result.status).toBe(describeWriteFailure(code, 'note').status);
      const said = (result.body as { error: { message: string } }).error.message;
      expect(said).toContain('still here');
    }
    const h = makeHarness(MOVED, { kind: 'refused', reason: 'NO_CONTACT', writeId: WRITE_ID });
    const result = await call(h, 'admin-token', NOTE_BODY);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: 'NO_CONTACT' } });
  });
});
