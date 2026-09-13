/**
 * The overview's browser half, without a browser (Milestone 4 part 2):
 *
 *   - web/src/lib/routes.ts — the default route is the overview; the Assistant has an
 *     address; unknown paths land on the overview (Part A decision 1);
 *   - web/src/lib/overviewView.ts — every number on the screen against KNOWN rows (Part D
 *     item 14), every data state in Part C: not set up, zero in a stage, stale, running,
 *     failed, partial, a stage not in the pipeline, a removed stage, large counts, long and
 *     unicode names, a capped read;
 *   - web/src/lib/crmApi.ts — what the refresh button says for every answer the server can
 *     give.
 */
import { describe, expect, it } from 'vitest';

import { CRM_MESSAGES, callCrm, interpretCrmResponse } from '../../../web/src/lib/crmApi.js';
import {
  ARRIVALS_SHOWN,
  OLD_AFTER_MS,
  OVERVIEW_OPPORTUNITY_LIMIT,
  REMOVED_STAGE_SUFFIX,
  RUNNING_BELIEVED_FOR_MS,
  STALE_AFTER_MS,
  UNKNOWN_STAGE_LABEL,
  UNNAMED_LEAD,
  buildOverview,
  formatAgo,
  formatArrival,
  formatCount,
  freshnessOf,
  type GhlContactRow,
  type GhlOpportunityRow,
  type GhlStageRow,
  type GhlSyncRunRow,
  type OverviewInput,
} from '../../../web/src/lib/overviewView.js';
import {
  DEFAULT_SECTION,
  isCanonicalPath,
  pathFor,
  sectionFor,
} from '../../../web/src/lib/routes.js';

// 10:00 on Saturday 13 September 2026, Perth (UTC+8).
const NOW = Date.parse('2026-09-13T02:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FINANCE = 'M4unnMKBy0TgwCwOA6wS';

const STAGE_NAMES = [
  'New Lead',
  'Appointment Booked',
  'Contacted',
  'Qualified',
  'Docs Requested',
  'Docs Received',
  'Submitted to Lender',
  'Approved',
  'Settled',
  'Lost / Not Proceeding',
];

function stages(pipeline = FINANCE): GhlStageRow[] {
  return STAGE_NAMES.map((name, i) => ({
    ghl_id: `stage-${String(i + 1).padStart(2, '0')}`,
    pipeline_ghl_id: pipeline,
    name,
    position: i,
    removed_at: null,
  }));
}

function opp(
  id: string,
  stage: string,
  overrides: Partial<GhlOpportunityRow> = {},
): GhlOpportunityRow {
  return {
    ghl_id: id,
    pipeline_ghl_id: FINANCE,
    stage_ghl_id: stage,
    contact_ghl_id: `contact-${id}`,
    name: `Lead ${id}`,
    status: 'open',
    ghl_created_at: new Date(NOW - 3 * DAY).toISOString(),
    removed_at: null,
    ...overrides,
  };
}

function contact(
  id: string,
  fullName: string | null,
  overrides: Partial<GhlContactRow> = {},
): GhlContactRow {
  return {
    ghl_id: id,
    full_name: fullName,
    first_name: null,
    last_name: null,
    removed_at: null,
    ...overrides,
  };
}

function run(overrides: Partial<GhlSyncRunRow> = {}): GhlSyncRunRow {
  const started = new Date(NOW - 10 * MIN - 3_000).toISOString();
  const finished = new Date(NOW - 10 * MIN).toISOString();
  return {
    id: 'run-1',
    pipeline_ghl_id: FINANCE,
    status: 'success',
    started_at: started,
    applied_at: finished,
    finished_at: finished,
    error_code: null,
    contacts_failed: 0,
    contacts_missing: 0,
    contacts_rejected: 0,
    opportunities_rejected: 0,
    ...overrides,
  };
}

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  return {
    pipelines: [
      { ghl_id: FINANCE, name: 'Finance Pipeline', last_changed_at: '2026-09-12T00:00:00Z' },
    ],
    stages: stages(),
    opportunities: [
      opp('o1', 'stage-01', { ghl_created_at: new Date(NOW - 45 * MIN).toISOString() }),
      opp('o2', 'stage-01', { ghl_created_at: new Date(NOW - 20 * HOUR).toISOString() }),
      opp('o3', 'stage-02', { ghl_created_at: new Date(NOW - 5 * DAY).toISOString() }),
      opp('o4', 'stage-02', { ghl_created_at: new Date(NOW - 8 * DAY).toISOString() }),
      opp('o5', 'stage-03', { ghl_created_at: '2026-08-09T20:08:01.977Z' }),
      // Won and lost are not "in the pipeline"; a removed row is not either.
      opp('o6', 'stage-09', { status: 'won' }),
      opp('o7', 'stage-10', { status: 'lost' }),
      opp('o8', 'stage-01', { removed_at: '2026-09-12T00:00:00Z' }),
    ],
    contacts: [
      contact('contact-o1', 'Alex Tran'),
      contact('contact-o2', 'Sam Ó Brádaigh 🏠'),
      contact('contact-o3', null, { first_name: 'Priya', last_name: 'Raman-Ó Súilleabháin' }),
    ],
    runs: [run()],
    opportunityLimit: OVERVIEW_OPPORTUNITY_LIMIT,
    ...overrides,
  };
}

describe('routes', () => {
  it('the default route is the overview, and each section has one address', () => {
    expect(DEFAULT_SECTION).toBe('overview');
    expect(pathFor('overview')).toBe('/');
    expect(pathFor('assistant')).toBe('/assistant');
    for (const id of ['overview', 'assistant', 'memory', 'team'] as const) {
      expect(sectionFor(pathFor(id))).toBe(id);
      expect(isCanonicalPath(pathFor(id))).toBe(true);
    }
  });

  it('the old single url, a trailing slash, letter case and anything unknown land on the overview', () => {
    expect(sectionFor('/')).toBe('overview');
    expect(sectionFor('')).toBe('overview');
    expect(sectionFor('/assistant/')).toBe('assistant');
    expect(sectionFor('/Team')).toBe('team');
    expect(sectionFor('/content')).toBe('overview');
    expect(sectionFor('/ads')).toBe('overview');
    expect(sectionFor('/index.html')).toBe('overview');
    expect(isCanonicalPath('/assistant/')).toBe(false);
  });
});

describe('the overview numbers, against known rows', () => {
  it('counts open leads per stage BY ID, including the stages with zero, in pipeline order', () => {
    const view = buildOverview(input(), NOW);
    expect(view.kind).toBe('ready');
    expect(view.pipelineName).toBe('Finance Pipeline');
    expect(view.openTotal).toBe(5);
    expect(view.stages.map((s) => [s.name, s.count])).toEqual([
      ['New Lead', 2],
      ['Appointment Booked', 2],
      ['Contacted', 1],
      ['Qualified', 0],
      ['Docs Requested', 0],
      ['Docs Received', 0],
      ['Submitted to Lender', 0],
      ['Approved', 0],
      ['Settled', 0],
      ['Lost / Not Proceeding', 0],
    ]);
    expect(view.stages.every((s) => s.kind === 'stage')).toBe(true);
    expect(view.capped).toBe(false);
  });

  it('new this week is by GoHighLevel’s created date: 45 minutes, 20 hours and 5 days count; 8 days and August do not', () => {
    expect(buildOverview(input(), NOW).newThisWeek).toBe(3);
  });

  it('the arrivals are the newest open leads, named from the contact where the sync has one', () => {
    const view = buildOverview(input(), NOW);
    expect(view.arrivals).toHaveLength(5);
    expect(view.arrivals.map((a) => [a.name, a.stageName, a.contactKnown])).toEqual([
      ['Alex Tran', 'New Lead', true],
      ['Sam Ó Brádaigh 🏠', 'New Lead', true],
      ['Priya Raman-Ó Súilleabháin', 'Appointment Booked', true],
      ['Lead o4', 'Appointment Booked', false],
      ['Lead o5', 'Contacted', false],
    ]);
    expect(view.arrivals[0]?.when).toMatch(/^Today, 9:15\s?am$/);
    expect(view.arrivals[1]?.when).toMatch(/^Yesterday, 2:00\s?pm$/);
    // Five days before Saturday the 13th is Tuesday the 8th; "Sept" is en-AU's short September.
    expect(view.arrivals[2]?.when).toMatch(/^Tue,? 8 Sept?$/);
    expect(view.arrivals[4]?.when).toMatch(/^10 Aug 2026$/);
  });

  it('shows at most five arrivals and names an unnamed lead honestly', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      opp(`m${String(i)}`, 'stage-01', {
        name: i === 0 ? '   ' : `Lead ${String(i)}`,
        contact_ghl_id: null,
        ghl_created_at: new Date(NOW - i * HOUR).toISOString(),
      }),
    );
    const view = buildOverview(input({ opportunities: many, contacts: [] }), NOW);
    expect(view.arrivals).toHaveLength(ARRIVALS_SHOWN);
    expect(view.arrivals[0]?.name).toBe(UNNAMED_LEAD);
    expect(view.arrivals.map((a) => a.contactKnown)).toEqual([false, false, false, false, false]);
  });

  it('a stage GoHighLevel removed, and a stage id the pipeline never listed, are shown with their counts', () => {
    const removed: GhlStageRow = {
      ghl_id: 'stage-gone',
      pipeline_ghl_id: FINANCE,
      name: 'Old Stage',
      position: 99,
      removed_at: '2026-09-01T00:00:00Z',
    };
    const view = buildOverview(
      input({
        stages: [...stages(), removed],
        opportunities: [
          opp('a', 'stage-01'),
          opp('b', 'stage-gone'),
          opp('c', 'mystery-stage'),
          opp('d', 'mystery-stage'),
        ],
        contacts: [],
      }),
      NOW,
    );
    expect(view.openTotal).toBe(4);
    expect(view.stages).toHaveLength(12);
    expect(view.stages.slice(10)).toEqual([
      {
        stageId: 'stage-gone',
        name: `Old Stage${REMOVED_STAGE_SUFFIX}`,
        count: 1,
        kind: 'removed-stage',
      },
      { stageId: 'mystery-stage', name: UNKNOWN_STAGE_LABEL, count: 2, kind: 'unknown-stage' },
    ]);
    expect(view.arrivals.find((a) => a.opportunityId === 'c')?.stageName).toBe(UNKNOWN_STAGE_LABEL);
  });

  it('only the mirrored pipeline counts: another pipeline’s rows are ignored', () => {
    const view = buildOverview(
      input({
        pipelines: [
          { ghl_id: FINANCE, name: 'Finance Pipeline', last_changed_at: '2026-09-12T00:00:00Z' },
          { ghl_id: 'OTHER', name: 'Other Business', last_changed_at: '2026-09-13T00:00:00Z' },
        ],
        stages: [
          ...stages(),
          ...stages('OTHER').map((s) => ({ ...s, ghl_id: `other-${s.ghl_id}` })),
        ],
        opportunities: [
          opp('a', 'stage-01'),
          opp('b', 'other-stage-01', { pipeline_ghl_id: 'OTHER' }),
        ],
        contacts: [],
      }),
      NOW,
    );
    // The last applied run names the pipeline, not the most recently changed row.
    expect(view.pipelineName).toBe('Finance Pipeline');
    expect(view.openTotal).toBe(1);
    expect(view.stages).toHaveLength(10);
  });

  it('a read that hit its page size is flagged rather than trusted', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      opp(`x${String(i)}`, 'stage-01', { contact_ghl_id: null }),
    );
    expect(
      buildOverview(input({ opportunities: rows, contacts: [], opportunityLimit: 50 }), NOW).capped,
    ).toBe(true);
    expect(
      buildOverview(input({ opportunities: rows, contacts: [], opportunityLimit: 51 }), NOW).capped,
    ).toBe(false);
  });

  it('large counts are grouped, never abbreviated', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(12345)).toBe('12,345');
  });
});

describe('what the screen says about the data it shows', () => {
  it('no sync has ever written rows → "not set up", never zero leads', () => {
    const view = buildOverview(
      input({ pipelines: [], stages: [], opportunities: [], contacts: [], runs: [] }),
      NOW,
    );
    expect(view.kind).toBe('not-set-up');
    expect(view.freshness).toEqual({ kind: 'never' });
    expect(view.sync.lastFailed).toBe(false);
    expect(view.stages).toEqual([]);
  });

  it('a first sync that failed before writing anything → still "not set up", and the failure is visible', () => {
    const failed = run({ status: 'failed', applied_at: null, error_code: 'UNAUTHENTICATED' });
    const view = buildOverview(
      input({ pipelines: [], stages: [], opportunities: [], contacts: [], runs: [failed] }),
      NOW,
    );
    expect(view.kind).toBe('not-set-up');
    expect(view.sync).toMatchObject({
      lastFailed: true,
      lastRun: { status: 'failed', errorCode: 'UNAUTHENTICATED' },
    });
  });

  it('freshness: fresh under an hour, stale under a day, old after that — with the age in words', () => {
    expect(freshnessOf(new Date(NOW - 12 * MIN).toISOString(), NOW)).toMatchObject({
      kind: 'known',
      tone: 'fresh',
      label: 'Updated 12 minutes ago',
    });
    expect(freshnessOf(new Date(NOW - 30_000).toISOString(), NOW)).toMatchObject({
      label: 'Updated just now',
    });
    expect(freshnessOf(new Date(NOW - STALE_AFTER_MS).toISOString(), NOW)).toMatchObject({
      tone: 'stale',
      label: 'Last refreshed 1 hour ago',
    });
    expect(freshnessOf(new Date(NOW - 3 * HOUR - 5 * MIN).toISOString(), NOW)).toMatchObject({
      tone: 'stale',
      label: 'Last refreshed 3 hours ago',
    });
    expect(freshnessOf(new Date(NOW - OLD_AFTER_MS).toISOString(), NOW)).toMatchObject({
      tone: 'old',
      label: 'Last refreshed 1 day ago',
    });
    expect(freshnessOf(new Date(NOW - 9 * DAY).toISOString(), NOW)).toMatchObject({
      tone: 'old',
      label: 'Last refreshed 9 days ago',
    });
    expect(freshnessOf('not a date', NOW)).toEqual({ kind: 'never' });
    expect(formatAgo(1 * MIN)).toBe('1 minute ago');
    expect(formatAgo(HOUR)).toBe('1 hour ago');
    expect(formatAgo(DAY)).toBe('1 day ago');
  });

  it('a stale mirror still shows its numbers — old, not hidden', () => {
    const old = run({
      applied_at: new Date(NOW - 2 * DAY).toISOString(),
      finished_at: new Date(NOW - 2 * DAY).toISOString(),
    });
    const view = buildOverview(input({ runs: [old] }), NOW);
    expect(view.kind).toBe('ready');
    expect(view.openTotal).toBe(5);
    expect(view.freshness).toMatchObject({ tone: 'old', label: 'Last refreshed 2 days ago' });
  });

  it('a run in progress is shown as running, without hiding the numbers from the last one', () => {
    const running = run({
      id: 'run-2',
      status: 'running',
      applied_at: null,
      finished_at: null,
      started_at: new Date(NOW - 20_000).toISOString(),
    });
    const view = buildOverview(input({ runs: [running, run()] }), NOW);
    expect(view.kind).toBe('ready');
    expect(view.sync).toMatchObject({ running: true, stuck: false, lastFailed: false });
    expect(view.freshness).toMatchObject({ label: 'Updated 10 minutes ago' });
  });

  it('a run that says "running" for too long is stuck, not running', () => {
    const stuck = run({
      id: 'run-2',
      status: 'running',
      applied_at: null,
      finished_at: null,
      started_at: new Date(NOW - RUNNING_BELIEVED_FOR_MS).toISOString(),
    });
    const view = buildOverview(input({ runs: [stuck, run()] }), NOW);
    expect(view.sync).toMatchObject({ running: false, stuck: true });
  });

  it('the last run failing is on the screen, with its code, and the numbers stay from the last good one', () => {
    const failed = run({
      id: 'run-2',
      status: 'failed',
      applied_at: null,
      error_code: 'UNAUTHENTICATED',
      started_at: new Date(NOW - MIN).toISOString(),
      finished_at: new Date(NOW - MIN).toISOString(),
    });
    const view = buildOverview(input({ runs: [failed, run()] }), NOW);
    expect(view.kind).toBe('ready');
    expect(view.sync).toMatchObject({
      lastFailed: true,
      lastPartial: false,
      lastRun: { errorCode: 'UNAUTHENTICATED' },
    });
    expect(view.freshness).toMatchObject({ label: 'Updated 10 minutes ago' });
    expect(view.openTotal).toBe(5);
  });

  it('a partial run says how many contacts could not be read, and the arrivals say which', () => {
    const partial = run({
      status: 'partial',
      contacts_failed: 1,
      contacts_missing: 1,
      contacts_rejected: 0,
    });
    const view = buildOverview(
      input({ runs: [partial], contacts: [contact('contact-o1', 'Alex Tran')] }),
      NOW,
    );
    expect(view.sync).toMatchObject({ lastPartial: true, contactsUnread: 2 });
    expect(view.arrivals.map((a) => a.contactKnown)).toEqual([true, false, false, false, false]);
  });

  it('contacts present but no opportunity rows is a legitimate zero, not "not set up"', () => {
    const view = buildOverview(
      input({ opportunities: [], contacts: [contact('c', 'Someone')] }),
      NOW,
    );
    expect(view.kind).toBe('ready');
    expect(view.openTotal).toBe(0);
    expect(view.stages.every((s) => s.count === 0)).toBe(true);
    expect(view.arrivals).toEqual([]);
  });

  it('long and unicode names come through untouched — the layout, not the data, has to cope', () => {
    const long =
      'Bartholomew Montgomery-Fitzgerald-Whittingtonshire of the Very Long Family Name Trust Pty Ltd 🏡🏡🏡';
    const view = buildOverview(
      input({ opportunities: [opp('l', 'stage-01')], contacts: [contact('contact-l', long)] }),
      NOW,
    );
    expect(view.arrivals[0]?.name).toBe(long);
  });

  it('formatArrival handles an unparsable date without throwing', () => {
    expect(formatArrival(null, NOW)).toBe('Date unknown');
    expect(formatArrival('garbage', NOW)).toBe('Date unknown');
  });
});

describe('the refresh call', () => {
  const OK = {
    action: 'sync',
    status: 'success',
    runId: 'run-9',
    durationMs: 2400,
    opportunitiesFetched: 10,
    contactsFetched: 10,
    contactsUnread: 0,
  };

  it('reads a good reply and refuses a malformed one', () => {
    expect(interpretCrmResponse(200, OK)).toEqual({ kind: 'ok', reply: OK });
    expect(interpretCrmResponse(200, { ...OK, status: 'partial' })).toMatchObject({ kind: 'ok' });
    expect(interpretCrmResponse(200, { action: 'sync' })).toMatchObject({
      kind: 'error',
      code: 'BAD_RESPONSE',
    });
    expect(interpretCrmResponse(200, null)).toMatchObject({ kind: 'error', failure: 'retryable' });
  });

  it('maps every status the server can answer to what the screen should say', () => {
    const env = (code: string, message: string, retryable = false): unknown => ({
      error: { code, message, retryable },
    });
    expect(interpretCrmResponse(401, env('UNAUTHENTICATED', 'Sign in'))).toMatchObject({
      failure: 'unauthenticated',
      message: CRM_MESSAGES.sessionExpired,
    });
    expect(interpretCrmResponse(403, env('FORBIDDEN', 'no'))).toMatchObject({
      failure: 'forbidden',
      message: CRM_MESSAGES.forbidden,
    });
    expect(interpretCrmResponse(409, env('SYNC_RUNNING', 'running', true))).toMatchObject({
      failure: 'running',
      message: CRM_MESSAGES.running,
    });
    // 502: the server's sentence names the cause and is shown as written.
    expect(
      interpretCrmResponse(502, env('UNAUTHENTICATED', 'GoHighLevel rejected our access key.')),
    ).toMatchObject({
      failure: 'failed',
      message: 'GoHighLevel rejected our access key.',
      code: 'UNAUTHENTICATED',
    });
    expect(interpretCrmResponse(504, null)).toMatchObject({
      failure: 'retryable',
      message: CRM_MESSAGES.timeout,
      code: 'HTTP_504',
    });
    expect(interpretCrmResponse(503, env('AUTH_UNAVAILABLE', 'x', true))).toMatchObject({
      failure: 'retryable',
    });
    expect(interpretCrmResponse(500, env('INTERNAL', 'x'))).toMatchObject({
      failure: 'fatal',
      message: CRM_MESSAGES.unknown,
    });
  });

  it('sends the bearer token and the anon key, and never throws on transport failure', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchOk = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(OK), { status: 200 }));
    }) as unknown as typeof fetch;
    const outcome = await callCrm(
      { crmUrl: 'https://x.test/functions/v1/crm', anonKey: 'anon', fetch: fetchOk },
      'tok',
      { action: 'sync' },
    );
    expect(outcome).toMatchObject({ kind: 'ok' });
    expect(calls[0]?.url).toBe('https://x.test/functions/v1/crm');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer tok', apikey: 'anon' });
    expect(calls[0]?.init.body).toBe('{"action":"sync"}');

    const fetchDown = (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
    expect(
      await callCrm({ crmUrl: 'u', anonKey: 'a', fetch: fetchDown }, 'tok', { action: 'sync' }),
    ).toMatchObject({
      failure: 'retryable',
      code: 'NETWORK',
      message: CRM_MESSAGES.network,
    });

    const fetchHangs = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    expect(
      await callCrm({ crmUrl: 'u', anonKey: 'a', fetch: fetchHangs, timeoutMs: 5 }, 'tok', {
        action: 'sync',
      }),
    ).toMatchObject({
      failure: 'retryable',
      code: 'CLIENT_TIMEOUT',
      message: CRM_MESSAGES.timeout,
    });

    const fetchNotJson = (() =>
      Promise.resolve(new Response('<html>', { status: 502 }))) as unknown as typeof fetch;
    expect(
      await callCrm({ crmUrl: 'u', anonKey: 'a', fetch: fetchNotJson }, 'tok', { action: 'sync' }),
    ).toMatchObject({
      failure: 'failed',
      code: 'HTTP_502',
    });
  });
});
