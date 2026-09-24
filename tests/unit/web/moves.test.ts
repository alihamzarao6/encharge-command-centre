/**
 * The browser half of moving a lead and the lead detail, without a browser (Milestone 4
 * part 4):
 *
 *   - web/src/lib/moveView.ts — the optimistic move over a built view (the card changes
 *     column at once, keeps its newest-first place, nothing else changes; same column in and
 *     out is the same view; dropping the override IS the rollback), and every sentence a
 *     move can end in: moved, already there, moved by someone else first, landed after a
 *     timeout, not mirrored, and every failure saying the lead is back where it was;
 *   - web/src/lib/crmApi.ts — the move and note requests on the wire, the replies read
 *     strictly, and every status the server can answer a write with (400, 403 outside the
 *     pipeline vs. the account boundary, 409, 410, 422, 502, 503, 504) become the right kind
 *     with the server's sentence kept; a dropped connection and a client timeout say what
 *     they mean for a move and for a note;
 *   - web/src/lib/leadDetailView.ts — every line traces to a column; a field GoHighLevel does
 *     not hold is "Not captured"; the eleven mapped answers in seed order, other captured
 *     fields after them labelled by definition or by id; notes newest first with "You" for
 *     the viewer and the roster email for a colleague; removed / not found; the move options
 *     are the live stages in order.
 */
import { describe, expect, it } from 'vitest';

import {
  CRM_MESSAGES,
  callCrm,
  interpretCrmResponse,
  newRequestId,
  type CrmMoveReply,
  type CrmOutcome,
} from '../../../web/src/lib/crmApi.js';
import {
  MAPPED_FIELD_ORDER,
  NOT_CAPTURED,
  buildLeadDetail,
  formatValue,
  humanise,
  telHref,
  type LeadDetailInput,
} from '../../../web/src/lib/leadDetailView.js';
import { buildLeads, type LeadsInput, type LeadsView } from '../../../web/src/lib/leadsView.js';
import {
  MOVE_BUSY,
  applyMove,
  describeMoveOutcome,
  moveControlLabel,
  stageNameOf,
  type PendingMove,
} from '../../../web/src/lib/moveView.js';

// 10:00 on Thursday 24 September 2026, Perth (UTC+8).
const NOW = Date.parse('2026-09-24T02:00:00Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const FINANCE = 'M4unnMKBy0TgwCwOA6wS';
const S = (n: number): string => `stage-${String(n).padStart(2, '0')}`;

function leadsInput(): LeadsInput {
  return {
    pipelines: [{ ghl_id: FINANCE, name: 'Finance Pipeline', last_changed_at: 'x' }],
    stages: ['New Lead', 'Appointment Booked', 'Contacted', 'Qualified'].map((name, i) => ({
      ghl_id: S(i + 1),
      pipeline_ghl_id: FINANCE,
      name,
      position: i,
      removed_at: null,
    })),
    opportunities: [
      {
        ghl_id: 'o1',
        pipeline_ghl_id: FINANCE,
        stage_ghl_id: S(1),
        contact_ghl_id: 'c1',
        name: 'Lead o1',
        status: 'open',
        ghl_created_at: new Date(NOW - HOUR).toISOString(),
        removed_at: null,
      },
      {
        ghl_id: 'o2',
        pipeline_ghl_id: FINANCE,
        stage_ghl_id: S(1),
        contact_ghl_id: 'c2',
        name: 'Lead o2',
        status: 'open',
        ghl_created_at: new Date(NOW - DAY).toISOString(),
        removed_at: null,
      },
      {
        ghl_id: 'o3',
        pipeline_ghl_id: FINANCE,
        stage_ghl_id: S(3),
        contact_ghl_id: 'c3',
        name: 'Lead o3',
        status: 'open',
        ghl_created_at: new Date(NOW - 3 * DAY).toISOString(),
        removed_at: null,
      },
    ],
    contacts: [
      {
        ghl_id: 'c1',
        full_name: 'Alex Tran',
        first_name: null,
        last_name: null,
        email: 'a@example.com',
        phone: '0400 000 001',
        custom_fields: {},
        removed_at: null,
      },
      {
        ghl_id: 'c2',
        full_name: 'Sam Ó Brádaigh',
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        custom_fields: {},
        removed_at: null,
      },
      {
        ghl_id: 'c3',
        full_name: 'Jo Bloggs',
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        custom_fields: {},
        removed_at: null,
      },
    ],
    fieldMap: [],
    runs: [
      {
        id: 'r1',
        pipeline_ghl_id: FINANCE,
        status: 'success',
        started_at: new Date(NOW - HOUR).toISOString(),
        applied_at: new Date(NOW - HOUR).toISOString(),
        finished_at: new Date(NOW - HOUR).toISOString(),
        error_code: null,
        contacts_failed: 0,
        contacts_missing: 0,
        contacts_rejected: 0,
        opportunities_rejected: 0,
      },
    ],
    opportunityLimit: 2_000,
  };
}

function view(): LeadsView {
  return buildLeads(leadsInput(), NOW);
}

function columnIds(v: LeadsView, stageId: string): string[] {
  return (v.columns.find((c) => c.stageId === stageId)?.leads ?? []).map((l) => l.opportunityId);
}

describe('applyMove — the optimistic move', () => {
  it('shows the lead in the new column at once, newest first there, and nowhere else', () => {
    const before = view();
    const after = applyMove(before, 'o2', S(3));
    expect(columnIds(after, S(1))).toEqual(['o1']);
    // o2 (1 day) is newer than o3 (3 days): newest first in its new column.
    expect(columnIds(after, S(3))).toEqual(['o2', 'o3']);
    const moved = after.leads.find((l) => l.opportunityId === 'o2');
    expect(moved).toMatchObject({
      stageId: S(3),
      stageName: 'Contacted',
      stagePosition: 2,
      name: 'Sam Ó Brádaigh',
    });
    // Nothing else changed, and the original view is untouched (the rollback is dropping this).
    expect(after.leads).toHaveLength(before.leads.length);
    expect(columnIds(before, S(1))).toEqual(['o1', 'o2']);
    expect(after.freshness).toBe(before.freshness);
  });

  it('is the same view for the same column, an unknown lead, or an unknown stage', () => {
    const before = view();
    expect(applyMove(before, 'o1', S(1))).toBe(before);
    expect(applyMove(before, 'nope', S(2))).toBe(before);
    expect(applyMove(before, 'o1', 'stage-99')).toBe(before);
  });

  it('applied again on a view that already has the lead there is a no-op — the override survives a re-read', () => {
    const after = applyMove(view(), 'o2', S(3));
    expect(applyMove(after, 'o2', S(3))).toBe(after);
  });
});

function pending(): PendingMove {
  const v = view();
  const before = v.leads.find((l) => l.opportunityId === 'o2');
  if (before === undefined) throw new Error('fixture');
  return { requestId: 'r', opportunityId: 'o2', fromStageId: S(1), toStageId: S(3), before };
}

function reply(overrides: Partial<CrmMoveReply> = {}): CrmOutcome {
  return {
    kind: 'ok',
    reply: {
      action: 'move',
      opportunityId: 'o2',
      fromStageId: S(1),
      toStageId: S(3),
      changed: true,
      movedByOther: false,
      replay: false,
      landedAfterTimeout: false,
      mirrored: true,
      writeId: 'w',
      durationMs: 700,
      ...overrides,
    },
  };
}

describe('describeMoveOutcome — what the screen says', () => {
  it('moved: the name and the stage in words', () => {
    const m = describeMoveOutcome(view(), pending(), reply());
    expect(m).toEqual({ tone: 'ok', text: 'Sam Ó Brádaigh moved to Contacted.', reread: false });
  });

  it('already there: says so and changes nothing', () => {
    const m = describeMoveOutcome(view(), pending(), reply({ changed: false }));
    expect(m.tone).toBe('ok');
    expect(m.text).toBe(
      'Sam Ó Brádaigh was already in Contacted in GoHighLevel. Nothing to change.',
    );
  });

  it('moved by someone else first: last write wins, and the person is told where it had been', () => {
    const m = describeMoveOutcome(
      view(),
      pending(),
      reply({ movedByOther: true, fromStageId: S(2) }),
    );
    expect(m.text).toContain('moved to Contacted.');
    expect(m.text).toContain(
      'Someone else had moved this lead to Appointment Booked since your screen loaded',
    );
    expect(m.reread).toBe(true);
  });

  it('landed after a timeout, and not mirrored, are said plainly', () => {
    expect(
      describeMoveOutcome(view(), pending(), reply({ landedAfterTimeout: true })).text,
    ).toContain('slow to answer, but the move went through');
    const m = describeMoveOutcome(view(), pending(), reply({ mirrored: false }));
    expect(m.text).toContain('catch up on the next refresh');
    expect(m.reread).toBe(true);
  });

  it('every failure keeps the server’s sentence and says the lead is back where it was', () => {
    const kinds: CrmOutcome[] = [
      {
        kind: 'error',
        failure: 'failed',
        message: "GoHighLevel didn't complete the move.",
        code: 'TIMEOUT',
        status: 502,
      },
      {
        kind: 'error',
        failure: 'refused',
        message: 'That stage is no longer in the pipeline.',
        code: 'STAGE_UNKNOWN',
        status: 409,
      },
      {
        kind: 'error',
        failure: 'unknown',
        message: "GoHighLevel didn't confirm the move.",
        code: 'UNKNOWN',
        status: 504,
      },
      {
        kind: 'error',
        failure: 'retryable',
        message: 'Rate limited.',
        code: 'RATE_LIMITED',
        status: 503,
      },
      {
        kind: 'error',
        failure: 'forbidden',
        message: 'No access.',
        code: 'FORBIDDEN',
        status: 403,
      },
      { kind: 'error', failure: 'fatal', message: 'x', code: 'X', status: 500 },
      {
        kind: 'error',
        failure: 'unauthenticated',
        message: 'expired',
        code: 'UNAUTHENTICATED',
        status: 401,
      },
    ];
    for (const outcome of kinds) {
      if (outcome.kind !== 'error') throw new Error('fixture');
      const m = describeMoveOutcome(view(), pending(), outcome);
      expect(m.tone, outcome.failure).toBe('warn');
      expect(m.text, outcome.failure).toContain('Sam Ó Brádaigh is back in New Lead.');
      if (outcome.failure !== 'unauthenticated') expect(m.text).toContain(outcome.message);
    }
    // A definite refusal and an unknown outcome both mean the world may have changed: re-read.
    const rereads = kinds.slice(0, 3).map((k) => describeMoveOutcome(view(), pending(), k).reread);
    expect(rereads).toEqual([false, true, true]);
  });

  it('an answer that is not a move puts the lead back', () => {
    const sync: CrmOutcome = {
      kind: 'ok',
      reply: {
        action: 'sync',
        status: 'success',
        runId: 'r',
        durationMs: 1,
        opportunitiesFetched: 1,
        contactsFetched: 1,
        contactsUnread: 0,
      },
    };
    expect(describeMoveOutcome(view(), pending(), sync).tone).toBe('warn');
  });

  it('names', () => {
    expect(stageNameOf(view(), S(2))).toBe('Appointment Booked');
    expect(stageNameOf(view(), 'zz')).toBe('a stage not in the pipeline');
    expect(moveControlLabel('Alex Tran')).toBe('Move Alex Tran to another stage');
    expect(MOVE_BUSY).toContain('Wait');
  });
});

describe('crmApi — the write requests and answers', () => {
  const MOVE = {
    action: 'move',
    opportunityId: 'o2',
    fromStageId: S(1),
    toStageId: S(3),
    changed: true,
    movedByOther: false,
    replay: false,
    landedAfterTimeout: false,
    mirrored: true,
    writeId: 'w',
    durationMs: 700,
  };
  const NOTE = {
    action: 'note',
    opportunityId: 'o2',
    noteId: 'n1',
    body: 'hi',
    createdAt: '2026-09-24T01:00:00.000Z',
    authorUserId: 'u',
    mirrored: true,
    writeId: 'w',
    durationMs: 300,
  };

  it('reads a move reply strictly, and a note reply strictly', () => {
    expect(interpretCrmResponse(200, MOVE, 'move')).toEqual({ kind: 'ok', reply: MOVE });
    expect(interpretCrmResponse(200, NOTE, 'note')).toEqual({ kind: 'ok', reply: NOTE });
    // A sync body answered to a move is not a move; a missing flag is not a reply.
    expect(interpretCrmResponse(200, { action: 'sync', status: 'success' }, 'move').kind).toBe(
      'error',
    );
    const { mirrored: _m, ...missing } = MOVE;
    void _m;
    expect(interpretCrmResponse(200, missing, 'move')).toMatchObject({
      kind: 'error',
      code: 'BAD_RESPONSE',
    });
    expect(interpretCrmResponse(200, MOVE, 'note').kind).toBe('error');
  });

  it('maps every status a write can answer with, keeping the server’s sentence', () => {
    const say = (
      status: number,
      code: string,
      message = `said ${code}`,
      retryable = false,
    ): CrmOutcome => interpretCrmResponse(status, { error: { code, message, retryable } }, 'move');
    expect(say(400, 'BAD_REQUEST')).toMatchObject({
      failure: 'refused',
      message: 'said BAD_REQUEST',
    });
    expect(say(401, 'UNAUTHENTICATED')).toMatchObject({
      failure: 'unauthenticated',
      message: CRM_MESSAGES.sessionExpired,
    });
    expect(say(403, 'FORBIDDEN')).toMatchObject({
      failure: 'forbidden',
      message: CRM_MESSAGES.forbidden,
    });
    expect(say(403, 'OUTSIDE_PIPELINE')).toMatchObject({
      failure: 'refused',
      message: 'said OUTSIDE_PIPELINE',
    });
    expect(say(409, 'STAGE_UNKNOWN')).toMatchObject({
      failure: 'refused',
      message: 'said STAGE_UNKNOWN',
    });
    expect(say(409, 'SYNC_RUNNING')).toMatchObject({ failure: 'running' });
    expect(say(410, 'OPPORTUNITY_GONE')).toMatchObject({ failure: 'refused', status: 410 });
    expect(say(422, 'NOTE_REJECTED')).toMatchObject({ failure: 'refused' });
    expect(say(502, 'UNAUTHENTICATED', 'the key is dead')).toMatchObject({
      failure: 'failed',
      message: 'the key is dead',
    });
    expect(say(503, 'RATE_LIMITED', 'wait', true)).toMatchObject({
      failure: 'retryable',
      message: 'wait',
    });
    expect(say(504, 'UNKNOWN', 'not confirmed')).toMatchObject({
      failure: 'unknown',
      message: 'not confirmed',
    });
    // The refresh's own 504 is unchanged.
    expect(interpretCrmResponse(504, {}, 'sync')).toMatchObject({
      failure: 'retryable',
      message: CRM_MESSAGES.timeout,
    });
    expect(interpretCrmResponse(500, null, 'move')).toMatchObject({
      failure: 'fatal',
      message: CRM_MESSAGES.moveUnknown,
    });
    expect(interpretCrmResponse(500, null, 'note')).toMatchObject({
      failure: 'fatal',
      message: CRM_MESSAGES.noteUnknown,
    });
  });

  it('sends the request as JSON with the bearer token, and reads the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({ url: typeof input === 'string' ? input : 'not-a-string', init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(MOVE), { status: 200 }));
    };
    const outcome = await callCrm(
      { crmUrl: 'https://x/functions/v1/crm', anonKey: 'anon', fetch: fakeFetch },
      'tok',
      { action: 'move', requestId: 'r', opportunityId: 'o2', toStageId: S(3), fromStageId: S(1) },
    );
    expect(outcome.kind).toBe('ok');
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    const sent = init?.body;
    if (typeof sent !== 'string') throw new Error('expected a string body');
    expect(JSON.parse(sent)).toEqual({
      action: 'move',
      requestId: 'r',
      opportunityId: 'o2',
      toStageId: S(3),
      fromStageId: S(1),
    });
  });

  it('a dropped connection and a client timeout say what they mean for a move and for a note', async () => {
    const dropped: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const abort: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const deps = (f: typeof fetch, timeoutMs?: number) => ({
      crmUrl: 'https://x',
      anonKey: 'a',
      fetch: f,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const move = {
      action: 'move',
      requestId: 'r',
      opportunityId: 'o',
      toStageId: 's',
      fromStageId: null,
    } as const;
    const note = { action: 'note', requestId: 'r', opportunityId: 'o', body: 'x' } as const;
    expect(await callCrm(deps(dropped), 't', move)).toMatchObject({
      failure: 'retryable',
      message: CRM_MESSAGES.moveNetwork,
      code: 'NETWORK',
    });
    expect(await callCrm(deps(dropped), 't', note)).toMatchObject({
      failure: 'retryable',
      message: CRM_MESSAGES.noteNetwork,
    });
    expect(await callCrm(deps(abort, 5), 't', move)).toMatchObject({
      failure: 'unknown',
      message: CRM_MESSAGES.moveTimeout,
      code: 'CLIENT_TIMEOUT',
    });
    expect(await callCrm(deps(abort, 5), 't', note)).toMatchObject({
      failure: 'unknown',
      message: CRM_MESSAGES.noteTimeout,
    });
    expect(await callCrm(deps(dropped), 't', { action: 'sync' })).toMatchObject({
      message: CRM_MESSAGES.network,
    });
  });

  it('mints a uuid per gesture, and never the same one twice', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------------------
// The lead detail
// ---------------------------------------------------------------------------------------

const LOAN_BALANCE = 'TANd0sfC9wRwuJKhSGFx';
const LOAN_TYPE = 'Vpn7DLqHwMoQ91AJUjzu';
const VIEWER = 'aaaaaaaa-0000-4000-8000-000000000001';
const COLLEAGUE = 'bbbbbbbb-0000-4000-8000-000000000002';

function detailInput(overrides: Partial<LeadDetailInput> = {}): LeadDetailInput {
  return {
    opportunity: {
      ghl_id: 'o1',
      pipeline_ghl_id: FINANCE,
      stage_ghl_id: S(2),
      contact_ghl_id: 'c1',
      name: 'Alex T',
      status: 'open',
      monetary_value: 0,
      source: 'meta_vsl_lp',
      assigned_to: null,
      ghl_created_at: new Date(NOW - 2 * DAY).toISOString(),
      ghl_updated_at: new Date(NOW - HOUR).toISOString(),
      last_stage_change_at: new Date(NOW - DAY).toISOString(),
      last_status_change_at: null,
      removed_at: null,
    },
    contact: {
      ghl_id: 'c1',
      full_name: 'Alex Tran',
      first_name: null,
      last_name: null,
      email: 'alex@example.com',
      phone: '+61 400 000 001',
      source: 'Facebook',
      dnd: true,
      tags: ['refi', 'vip'],
      custom_fields: {
        [LOAN_BALANCE]: ['$500k–$750k'],
        [LOAN_TYPE]: 'Refinance',
        zzUnknownField000001: 'raw',
      },
      ghl_created_at: new Date(NOW - 2 * DAY).toISOString(),
      ghl_updated_at: null,
      removed_at: null,
    },
    stages: leadsInput().stages,
    customFields: [
      {
        ghl_id: LOAN_BALANCE,
        name: 'Roughly how much is left on your home loan?',
        data_type: 'MULTIPLE_OPTIONS',
        parent_id: 'f',
        removed_at: null,
      },
      {
        ghl_id: LOAN_TYPE,
        name: 'Loan Type',
        data_type: 'SINGLE_OPTIONS',
        parent_id: 'f',
        removed_at: null,
      },
    ],
    fieldMap: [
      { internal_field: 'loan_balance', ghl_custom_field_id: LOAN_BALANCE, entity: 'contact' },
      { internal_field: 'loan_type', ghl_custom_field_id: LOAN_TYPE, entity: 'contact' },
      {
        internal_field: 'annual_income',
        ghl_custom_field_id: 'tQA4cVpB63irs4gBdKBO',
        entity: 'contact',
      },
      { internal_field: 'new_lead', ghl_custom_field_id: 'x', entity: 'stage' },
    ],
    notes: [
      {
        ghl_id: 'n-old',
        contact_ghl_id: 'c1',
        opportunity_ghl_id: 'o1',
        author_user_id: COLLEAGUE,
        body: 'Left a voicemail.',
        ghl_date_added: new Date(NOW - DAY).toISOString(),
        created_at: new Date(NOW - DAY).toISOString(),
      },
      {
        ghl_id: 'n-new',
        contact_ghl_id: 'c1',
        opportunity_ghl_id: 'o1',
        author_user_id: VIEWER,
        body: 'Spoke — docs coming Friday. 🏠',
        ghl_date_added: new Date(NOW - HOUR).toISOString(),
        created_at: new Date(NOW - HOUR).toISOString(),
      },
      {
        ghl_id: 'n-other',
        contact_ghl_id: 'c9',
        opportunity_ghl_id: 'o9',
        author_user_id: VIEWER,
        body: 'another lead',
        ghl_date_added: null,
        created_at: new Date(NOW).toISOString(),
      },
      {
        ghl_id: 'n-gone',
        contact_ghl_id: 'c1',
        opportunity_ghl_id: 'o1',
        author_user_id: 'cccccccc-0000-4000-8000-000000000003',
        body: 'By someone since removed.',
        ghl_date_added: new Date(NOW - 3 * DAY).toISOString(),
        created_at: new Date(NOW - 3 * DAY).toISOString(),
      },
    ],
    roster: [
      { user_id: VIEWER, email: 'ross@example.com' },
      { user_id: COLLEAGUE, email: 'jo@example.com' },
    ],
    viewerId: VIEWER,
    ...overrides,
  };
}

/** The fixture's opportunity row with some columns changed — no non-null assertions needed. */
function opportunityWith(
  overrides: Partial<NonNullable<LeadDetailInput['opportunity']>>,
): NonNullable<LeadDetailInput['opportunity']> {
  const base = detailInput().opportunity;
  if (base === null) throw new Error('fixture');
  return { ...base, ...overrides };
}

describe('buildLeadDetail', () => {
  it('lays out the lead from the rows: name, stage by id, arrival, in-stage-since, contact with tel/mailto, dnd, tags', () => {
    const d = buildLeadDetail(detailInput(), NOW);
    expect(d.kind).toBe('ready');
    if (d.kind !== 'ready') return;
    expect(d.name).toBe('Alex Tran');
    expect(d.named).toBe(true);
    expect(d.stageId).toBe(S(2));
    expect(d.stageName).toBe('Appointment Booked');
    expect(d.stageKind).toBe('stage');
    expect(d.arrived).toMatch(/Sept|Sep/);
    expect(d.inStageSince).toMatch(/Yesterday/);
    expect(d.contact).toMatchObject({
      known: true,
      email: 'alex@example.com',
      phone: '+61 400 000 001',
      source: 'Facebook',
      dnd: true,
      tags: ['refi', 'vip'],
    });
    expect(telHref('+61 400 000 001')).toBe('tel:+61400000001');
    expect(d.ids).toEqual({ opportunityId: 'o1', contactId: 'c1' });
    expect(d.stageOptions.map((s) => `${String(s.number)}:${s.name}`)).toEqual([
      '1:New Lead',
      '2:Appointment Booked',
      '3:Contacted',
      '4:Qualified',
    ]);
  });

  it('the opportunity lines: $0 is "$0" (GoHighLevel said zero), a missing value is Not captured, ids are shown as ids', () => {
    const d = buildLeadDetail(detailInput(), NOW);
    if (d.kind !== 'ready') throw new Error('ready');
    const line = (label: string): string | null => {
      const found = d.opportunity.find((l) => l.label === label);
      if (found === undefined) throw new Error(`no line ${label}`);
      return found.value;
    };
    expect(line('Status')).toBe('Open');
    expect(line('Value')).toBe('$0');
    expect(line('Opportunity name')).toBe('Alex T');
    expect(line('Source')).toBe('meta_vsl_lp');
    expect(line('Status changed')).toBeNull();
    expect(line('Assigned to (GoHighLevel user id)')).toBeNull();
    expect(formatValue(null)).toBeNull();
    expect(formatValue('1250000.50')).toBe('$1,250,001');
    expect(formatValue('abc')).toBeNull();
    const none = buildLeadDetail(
      detailInput({ opportunity: opportunityWith({ monetary_value: null, source: '', name: '' }) }),
      NOW,
    );
    if (none.kind !== 'ready') throw new Error('ready');
    expect(none.opportunity.find((l) => l.label === 'Value')?.value).toBeNull();
    expect(none.opportunity.find((l) => l.label === 'Source')?.value).toBeNull();
    expect(none.opportunity.find((l) => l.label === 'Opportunity name')?.value).toBeNull();
  });

  it('the form answers: the mapped fields first in seed order, labelled by definition, Not captured when absent; then other captured fields by definition or by id', () => {
    const d = buildLeadDetail(detailInput(), NOW);
    if (d.kind !== 'ready') throw new Error('ready');
    expect(d.answers.map((a) => a.label)).toEqual([
      'Loan Type',
      'Annual income',
      'Roughly how much is left on your home loan?',
      'zzUnknownField000001',
    ]);
    expect(d.answers.map((a) => a.value)).toEqual(['Refinance', null, '$500k–$750k', 'raw']);
    expect(d.answers.map((a) => a.mapped)).toEqual([true, true, true, false]);
    expect(d.answers[3]?.unlabelled).toBe(true);
    expect(d.answers[1]?.unlabelled).toBe(false);
    expect(NOT_CAPTURED).toBe('Not captured');
    expect(humanise('preferred_contact_time')).toBe('Preferred contact time');
    expect(MAPPED_FIELD_ORDER).toHaveLength(11);
  });

  it('notes: this lead’s only, newest first, "You" for the viewer, the roster email for a colleague, a stand-in for a former member', () => {
    const d = buildLeadDetail(detailInput(), NOW);
    if (d.kind !== 'ready') throw new Error('ready');
    expect(d.notes.map((n) => n.id)).toEqual(['n-new', 'n-old', 'n-gone']);
    expect(d.notes.map((n) => n.author)).toEqual(['You', 'jo@example.com', 'A former team member']);
    expect(d.notes[0]).toMatchObject({
      body: 'Spoke — docs coming Friday. 🏠',
      authorIsViewer: true,
    });
    expect(d.notes[0]?.when).toMatch(/Today/);
  });

  it('no contact synced: the contact block says so, the answers are empty, the name falls back', () => {
    const d = buildLeadDetail(detailInput({ contact: null }), NOW);
    if (d.kind !== 'ready') throw new Error('ready');
    expect(d.name).toBe('Alex T');
    expect(d.named).toBe(false);
    expect(d.contact.known).toBe(false);
    expect(d.answers.every((a) => a.value === null)).toBe(true);
    expect(d.ids.contactId).toBe('c1');
  });

  it('not found, removed, a removed stage, an unknown stage, an empty name', () => {
    expect(buildLeadDetail(detailInput({ opportunity: null }), NOW)).toEqual({ kind: 'not-found' });
    const removed = buildLeadDetail(
      detailInput({ opportunity: opportunityWith({ removed_at: 'x' }) }),
      NOW,
    );
    expect(removed).toEqual({ kind: 'removed', name: 'Alex Tran' });
    const stages = [
      ...leadsInput().stages,
      { ghl_id: 'stage-gone', pipeline_ghl_id: FINANCE, name: 'Old', position: 9, removed_at: 'x' },
    ];
    const onRemoved = buildLeadDetail(
      detailInput({ stages, opportunity: opportunityWith({ stage_ghl_id: 'stage-gone' }) }),
      NOW,
    );
    if (onRemoved.kind !== 'ready') throw new Error('ready');
    expect(onRemoved.stageKind).toBe('removed-stage');
    expect(onRemoved.stageName).toBe('Old (removed in GoHighLevel)');
    expect(onRemoved.stageOptions).toHaveLength(4);
    const unknown = buildLeadDetail(
      detailInput({ opportunity: opportunityWith({ stage_ghl_id: 'mystery' }) }),
      NOW,
    );
    if (unknown.kind !== 'ready') throw new Error('ready');
    expect(unknown.stageKind).toBe('unknown-stage');
    const unnamed = buildLeadDetail(
      detailInput({ contact: null, opportunity: opportunityWith({ name: '  ' }) }),
      NOW,
    );
    if (unnamed.kind !== 'ready') throw new Error('ready');
    expect(unnamed.name).toBe('Unnamed lead');
  });
});
