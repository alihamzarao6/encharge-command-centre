/**
 * The leads screen's browser half, without a browser (Milestone 4 part 3):
 *
 *   - web/src/lib/routes.ts — the leads addresses: /leads, /leads/board, /leads/list,
 *     /leads/<id>; the reserved words; what is canonical;
 *   - web/src/lib/leadsView.ts — the count in every column against KNOWN rows (Part D item
 *     12), every data state in Part C: no leads, a stage with zero, all in one stage, a stage
 *     not in the pipeline, a lead with no contact, a contact with no name, no email and no
 *     phone, the loan balance absent / null / empty / an array / a string, long and unicode
 *     names, a capped read; the within-stage order; search, filter and sort; the remembered
 *     view;
 *   - web/src/lib/crmApi.ts — the 429 the cooldown answers, shown in the server's words.
 */
import { describe, expect, it } from 'vitest';

import { CRM_MESSAGES, interpretCrmResponse } from '../../../web/src/lib/crmApi.js';
import {
  FIELD_INTEREST_RATE,
  FIELD_LOAN_BALANCE,
  LEADS_OPPORTUNITY_LIMIT,
  VIEW_KEY,
  buildLeads,
  contactDisplayName,
  customFieldText,
  defaultViewFor,
  describeMatches,
  fieldIdFor,
  filterLeads,
  loadViewChoice,
  matchesQuery,
  normalisePhone,
  normaliseText,
  saveViewChoice,
  sortLeads,
  type GhlContactDetailRow,
  type GhlFieldMapRow,
  type Lead,
  type LeadsInput,
} from '../../../web/src/lib/leadsView.js';
import {
  REMOVED_STAGE_SUFFIX,
  UNKNOWN_STAGE_LABEL,
  UNNAMED_LEAD,
  type GhlOpportunityRow,
  type GhlStageRow,
  type GhlSyncRunRow,
} from '../../../web/src/lib/overviewView.js';
import {
  isCanonicalPath,
  leadsPath,
  leadsRouteFor,
  pathFor,
  sectionFor,
} from '../../../web/src/lib/routes.js';

// 10:00 on Monday 14 September 2026, Perth (UTC+8).
const NOW = Date.parse('2026-09-14T02:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FINANCE = 'M4unnMKBy0TgwCwOA6wS';
const BALANCE_ID = 'TANd0sfC9wRwuJKhSGFx';
const RATE_ID = 'hX8JQblBT9iJhYEa348M';

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
  overrides: Partial<GhlContactDetailRow> = {},
): GhlContactDetailRow {
  return {
    ghl_id: id,
    full_name: fullName,
    first_name: null,
    last_name: null,
    email: `${id}@example.com`,
    phone: '+61400000001',
    custom_fields: {},
    removed_at: null,
    ...overrides,
  };
}

const FIELD_MAP: GhlFieldMapRow[] = [
  { internal_field: FIELD_LOAN_BALANCE, ghl_custom_field_id: BALANCE_ID, entity: 'contact' },
  { internal_field: FIELD_INTEREST_RATE, ghl_custom_field_id: RATE_ID, entity: 'contact' },
  { internal_field: 'lead_source', ghl_custom_field_id: 'axTFAYBC1ZCQ4KKuAMXZ', entity: 'contact' },
];

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

/** The known fixture every count below is checked against. */
function input(overrides: Partial<LeadsInput> = {}): LeadsInput {
  return {
    pipelines: [
      { ghl_id: FINANCE, name: 'Finance Pipeline', last_changed_at: run().applied_at ?? '' },
    ],
    stages: stages(),
    opportunities: [
      opp('o1', 'stage-01', { ghl_created_at: new Date(NOW - 40 * MIN).toISOString() }),
      opp('o2', 'stage-01', { ghl_created_at: new Date(NOW - 20 * HOUR).toISOString() }),
      opp('o3', 'stage-02', { ghl_created_at: new Date(NOW - 5 * DAY).toISOString() }),
      opp('o4', 'stage-02', { ghl_created_at: new Date(NOW - 8 * DAY).toISOString() }),
      opp('o5', 'stage-03', {
        ghl_created_at: new Date(NOW - 30 * DAY).toISOString(),
        contact_ghl_id: null,
      }),
    ],
    contacts: [
      contact('contact-o1', 'Alex Tran', {
        custom_fields: { [BALANCE_ID]: ['$500k–$750k'], [RATE_ID]: ['6.2% - 6.5%'] },
      }),
      contact('contact-o2', 'Sam Ó Brádaigh 🏠', { email: null, phone: '0400 000 002' }),
      contact('contact-o3', null, {
        first_name: 'Priya',
        last_name: 'Raman',
        custom_fields: { [BALANCE_ID]: 'Over $1m' },
      }),
      contact('contact-o4', null, { email: null, phone: null }),
    ],
    fieldMap: FIELD_MAP,
    runs: [run()],
    opportunityLimit: LEADS_OPPORTUNITY_LIMIT,
    ...overrides,
  };
}

describe('the leads routes', () => {
  it('the section has an address, each view has one, and each lead has one', () => {
    expect(pathFor('leads')).toBe('/leads');
    expect(leadsPath({ kind: 'index' })).toBe('/leads');
    expect(leadsPath({ kind: 'view', view: 'board' })).toBe('/leads/board');
    expect(leadsPath({ kind: 'view', view: 'list' })).toBe('/leads/list');
    expect(leadsPath({ kind: 'lead', opportunityId: 'Abc123_-' })).toBe('/leads/Abc123_-');
    expect(sectionFor('/leads')).toBe('leads');
    expect(sectionFor('/leads/board')).toBe('leads');
    expect(sectionFor('/LEADS/list/')).toBe('leads');
    expect(sectionFor('/leads/M4unnMKBy0TgwCwOA6wS')).toBe('leads');
  });

  it('parses the view words case-insensitively and keeps an id’s case', () => {
    expect(leadsRouteFor('/leads')).toEqual({ kind: 'index' });
    expect(leadsRouteFor('/leads/')).toEqual({ kind: 'index' });
    expect(leadsRouteFor('/leads/Board')).toEqual({ kind: 'view', view: 'board' });
    expect(leadsRouteFor('/leads/LIST')).toEqual({ kind: 'view', view: 'list' });
    expect(leadsRouteFor('/leads/aBc')).toEqual({ kind: 'lead', opportunityId: 'aBc' });
    expect(leadsRouteFor('/')).toBeNull();
    expect(leadsRouteFor('/memory')).toBeNull();
    expect(leadsRouteFor('/leadsx')).toBeNull();
  });

  it('a path that is not an id, or goes deeper, is not a lead — it lands on the overview', () => {
    expect(leadsRouteFor('/leads/a/b')).toBeNull();
    expect(leadsRouteFor('/leads/..')).toBeNull();
    expect(leadsRouteFor('/leads/has space')).toBeNull();
    expect(leadsRouteFor(`/leads/${'x'.repeat(65)}`)).toBeNull();
    expect(sectionFor('/leads/a/b')).toBe('overview');
  });

  it('knows which of them is canonical', () => {
    for (const path of ['/leads', '/leads/board', '/leads/list', '/leads/o1']) {
      expect(isCanonicalPath(path), path).toBe(true);
    }
    for (const path of ['/leads/', '/Leads', '/leads/BOARD', '/leads/a/b']) {
      expect(isCanonicalPath(path), path).toBe(false);
    }
  });
});

describe('the board columns, against known rows', () => {
  it('one column per stage in pipeline order, the count in each, zeros kept, cards newest first', () => {
    const view = buildLeads(input(), NOW);
    expect(view.kind).toBe('ready');
    expect(view.pipelineName).toBe('Finance Pipeline');
    expect(view.leads).toHaveLength(5);
    expect(view.columns.map((c) => [c.number, c.name, c.leads.length])).toEqual([
      [1, 'New Lead', 2],
      [2, 'Appointment Booked', 2],
      [3, 'Contacted', 1],
      [4, 'Qualified', 0],
      [5, 'Docs Requested', 0],
      [6, 'Docs Received', 0],
      [7, 'Submitted to Lender', 0],
      [8, 'Approved', 0],
      [9, 'Settled', 0],
      [10, 'Lost / Not Proceeding', 0],
    ]);
    expect(view.columns[0]?.leads.map((l) => l.opportunityId)).toEqual(['o1', 'o2']);
    expect(view.columns[1]?.leads.map((l) => l.opportunityId)).toEqual(['o3', 'o4']);
    expect(view.leads.map((l) => l.opportunityId)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    expect(view.capped).toBe(false);
  });

  it('every lead in one stage: that column holds them all and the other nine are empty', () => {
    const rows = input();
    const view = buildLeads(
      input({ opportunities: rows.opportunities.map((o) => ({ ...o, stage_ghl_id: 'stage-07' })) }),
      NOW,
    );
    expect(view.columns.map((c) => c.leads.length)).toEqual([0, 0, 0, 0, 0, 0, 5, 0, 0, 0]);
  });

  it('no leads at all with a synced mirror is ten empty columns — ready, not "not set up"', () => {
    const view = buildLeads(input({ opportunities: [] }), NOW);
    expect(view.kind).toBe('ready');
    expect(view.columns).toHaveLength(10);
    expect(view.columns.every((c) => c.leads.length === 0)).toBe(true);
    expect(view.leads).toEqual([]);
  });

  it('no sync ever → "not set up", never zero leads', () => {
    const view = buildLeads(input({ pipelines: [], stages: [], opportunities: [], runs: [] }), NOW);
    expect(view.kind).toBe('not-set-up');
    expect(view.columns).toEqual([]);
  });

  it('a removed stage and a stage the pipeline never listed become columns of their own, after the pipeline', () => {
    const rows = input();
    const view = buildLeads(
      input({
        stages: [
          ...rows.stages,
          {
            ghl_id: 'stage-gone',
            pipeline_ghl_id: FINANCE,
            name: 'Old Stage',
            position: 99,
            removed_at: run().applied_at,
          },
        ],
        opportunities: [
          ...rows.opportunities,
          opp('g1', 'stage-gone'),
          opp('u1', 'mystery'),
          opp('u2', 'mystery'),
        ],
      }),
      NOW,
    );
    expect(view.columns).toHaveLength(12);
    expect(view.columns[10]).toMatchObject({
      stageId: 'stage-gone',
      name: `Old Stage${REMOVED_STAGE_SUFFIX}`,
      kind: 'removed-stage',
      number: null,
    });
    expect(view.columns[11]).toMatchObject({
      stageId: 'mystery',
      name: UNKNOWN_STAGE_LABEL,
      kind: 'unknown-stage',
      number: null,
    });
    expect(view.columns[11]?.leads).toHaveLength(2);
    // On a row the stage reads the same way, and sorts after every pipeline stage.
    const g1 = view.leads.find((l) => l.opportunityId === 'g1');
    const u1 = view.leads.find((l) => l.opportunityId === 'u1');
    expect(g1?.stageName).toBe(`Old Stage${REMOVED_STAGE_SUFFIX}`);
    expect(u1?.stageName).toBe(UNKNOWN_STAGE_LABEL);
    expect(g1?.stagePosition).toBe(10);
    expect(u1?.stagePosition).toBe(11);
  });

  it('won, lost and removed rows, and another pipeline’s rows, are not leads', () => {
    const rows = input();
    const view = buildLeads(
      input({
        opportunities: [
          ...rows.opportunities,
          opp('w', 'stage-09', { status: 'won' }),
          opp('l', 'stage-10', { status: 'lost' }),
          opp('r', 'stage-01', { removed_at: run().applied_at }),
          opp('x', 'stage-01', { pipeline_ghl_id: 'other' }),
        ],
      }),
      NOW,
    );
    expect(view.leads).toHaveLength(5);
  });

  it('a read that hit its page size is flagged rather than trusted', () => {
    const rows = input();
    const view = buildLeads(input({ opportunities: rows.opportunities, opportunityLimit: 5 }), NOW);
    expect(view.capped).toBe(true);
  });
});

describe('what a card and a row say', () => {
  const view = buildLeads(input(), NOW);
  const lead = (id: string): Lead => {
    const found = view.leads.find((l) => l.opportunityId === id);
    if (found === undefined) throw new Error(`no lead ${id}`);
    return found;
  };

  it('names from the contact — full name, else first + last — with phone, email and the form’s bands', () => {
    expect(lead('o1')).toMatchObject({
      name: 'Alex Tran',
      named: true,
      stageName: 'New Lead',
      arrived: 'Today, 9:20 am',
      contactKnown: true,
      email: 'contact-o1@example.com',
      phone: '+61400000001',
      loanBalance: '$500k–$750k',
      interestRate: '6.2% - 6.5%',
    });
    expect(lead('o3')).toMatchObject({
      name: 'Priya Raman',
      loanBalance: 'Over $1m',
      interestRate: null,
    });
  });

  it('a contact with no name shows the opportunity’s own name, never blank or "undefined"', () => {
    expect(lead('o4')).toMatchObject({ name: 'Lead o4', named: false, contactKnown: true });
    const blank = buildLeads(
      input({
        opportunities: [opp('b', 'stage-01', { name: '   ' })],
        contacts: [contact('contact-b', '  ', { first_name: ' ', last_name: null })],
      }),
      NOW,
    );
    expect(blank.leads[0]?.name).toBe(UNNAMED_LEAD);
    expect(contactDisplayName(undefined)).toBeNull();
  });

  it('a lead with no contact attached, and a contact with no email and no phone, are both explicit', () => {
    expect(lead('o5')).toMatchObject({
      name: 'Lead o5',
      contactKnown: false,
      email: null,
      phone: null,
      loanBalance: null,
      interestRate: null,
    });
    expect(lead('o4')).toMatchObject({ contactKnown: true, email: null, phone: null });
    expect(lead('o2')).toMatchObject({ email: null, phone: '0400 000 002' });
  });

  it('a contact the sync marked removed does not name a lead', () => {
    const view2 = buildLeads(
      input({ contacts: [contact('contact-o1', 'Gone Person', { removed_at: run().applied_at })] }),
      NOW,
    );
    expect(view2.leads.find((l) => l.opportunityId === 'o1')?.contactKnown).toBe(false);
  });

  it('loan balance and rate: absent, null, empty string, empty array, blank array, string, array, number', () => {
    expect(customFieldText(undefined)).toBeNull();
    expect(customFieldText(null)).toBeNull();
    expect(customFieldText('')).toBeNull();
    expect(customFieldText('   ')).toBeNull();
    expect(customFieldText([])).toBeNull();
    expect(customFieldText(['', ' '])).toBeNull();
    expect(customFieldText('$300k–$500k')).toBe('$300k–$500k');
    expect(customFieldText(['Under $300k'])).toBe('Under $300k');
    expect(customFieldText(['a', 'b'])).toBe('a, b');
    expect(customFieldText(650000)).toBe('650000');
    expect(customFieldText({ odd: true })).toBeNull();
    expect(customFieldText(true)).toBeNull();
  });

  it('the field ids come from ghl_field_map, and an unmapped field is simply not shown', () => {
    expect(fieldIdFor(FIELD_MAP, FIELD_LOAN_BALANCE)).toBe(BALANCE_ID);
    expect(fieldIdFor(FIELD_MAP, 'nothing')).toBeNull();
    expect(
      fieldIdFor(
        [{ internal_field: FIELD_LOAN_BALANCE, ghl_custom_field_id: null, entity: 'contact' }],
        FIELD_LOAN_BALANCE,
      ),
    ).toBeNull();
    expect(
      fieldIdFor(
        [{ internal_field: FIELD_LOAN_BALANCE, ghl_custom_field_id: 'x', entity: 'stage' }],
        FIELD_LOAN_BALANCE,
      ),
    ).toBeNull();
    const unmapped = buildLeads(input({ fieldMap: [] }), NOW);
    expect(unmapped.leads.every((l) => l.loanBalance === null && l.interestRate === null)).toBe(
      true,
    );
  });

  it('long, unicode and emoji names come through untouched; a missing date says so and sorts last', () => {
    const long =
      'Bartholomew Montgomery-Fitzgerald-Whittingtonshire of the Very Long Family Name Trust Pty Ltd 🏡🏡🏡';
    const view2 = buildLeads(
      input({
        opportunities: [opp('a', 'stage-01'), opp('b', 'stage-01', { ghl_created_at: null })],
        contacts: [contact('contact-a', long), contact('contact-b', 'Sam Ó Brádaigh 🏠')],
      }),
      NOW,
    );
    expect(view2.leads.map((l) => [l.name, l.arrived])).toEqual([
      [long, 'Fri, 11 Sept'],
      ['Sam Ó Brádaigh 🏠', 'Date unknown'],
    ]);
  });

  it('two leads with the same date keep a stable order', () => {
    const view2 = buildLeads(
      input({ opportunities: [opp('z', 'stage-01'), opp('a', 'stage-01'), opp('m', 'stage-01')] }),
      NOW,
    );
    expect(view2.leads.map((l) => l.opportunityId)).toEqual(['a', 'm', 'z']);
  });
});

describe('search, filter and sort', () => {
  const view = buildLeads(input(), NOW);

  it('normalises case, accents and phone digits', () => {
    expect(normaliseText('  Ó Brádaigh ')).toBe('o bradaigh');
    expect(normalisePhone('+61 400 000 001')).toBe('61400000001');
  });

  it('finds a person by name, email or phone, however typed', () => {
    const sam = view.leads.find((l) => l.opportunityId === 'o2');
    if (sam === undefined) throw new Error('unreachable');
    expect(matchesQuery(sam, 'bradaigh')).toBe(true);
    expect(matchesQuery(sam, 'SAM Ó')).toBe(true);
    expect(matchesQuery(sam, '0400000002')).toBe(true);
    expect(matchesQuery(sam, '400 000 002')).toBe(true);
    expect(matchesQuery(sam, 'alex')).toBe(false);
    expect(matchesQuery(sam, '   ')).toBe(true);
    expect(
      filterLeads(view.leads, { query: 'contact-o1@', stageId: null }).map((l) => l.opportunityId),
    ).toEqual(['o1']);
    // A single digit is not a digits-only phone search (it would match every number); it
    // still matches the phone and email text as typed — o1 by email, o3 by phone.
    expect(
      filterLeads(view.leads, { query: '1', stageId: null }).map((l) => l.opportunityId),
    ).toEqual(['o1', 'o3']);
  });

  it('filters by stage id, combines with the search, and says how many match', () => {
    expect(
      filterLeads(view.leads, { query: '', stageId: 'stage-02' }).map((l) => l.opportunityId),
    ).toEqual(['o3', 'o4']);
    expect(
      filterLeads(view.leads, { query: 'priya', stageId: 'stage-02' }).map((l) => l.opportunityId),
    ).toEqual(['o3']);
    expect(filterLeads(view.leads, { query: 'priya', stageId: 'stage-01' })).toEqual([]);
    expect(describeMatches(5, 5, { query: '', stageId: null })).toBeNull();
    expect(describeMatches(2, 5, { query: '', stageId: 'stage-02' })).toBe('2 of 5 leads match');
    expect(describeMatches(0, 5, { query: 'zzz', stageId: null })).toBe('No leads match');
    expect(describeMatches(1, 1, { query: 'a', stageId: null })).toBe('1 of 1 lead match');
  });

  it('sorts newest, oldest, by name and by stage order (then newest)', () => {
    const ids = (sort: Parameters<typeof sortLeads>[1]): string[] =>
      sortLeads(view.leads, sort).map((l) => l.opportunityId);
    expect(ids('newest')).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    expect(ids('oldest')).toEqual(['o5', 'o4', 'o3', 'o2', 'o1']);
    // Alex, Lead o4, Lead o5, Priya, Sam.
    expect(ids('name')).toEqual(['o1', 'o4', 'o5', 'o3', 'o2']);
    expect(ids('stage')).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
    // The input is never mutated.
    expect(view.leads.map((l) => l.opportunityId)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5']);
  });
});

describe('the remembered view', () => {
  function memory(): {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    map: Map<string, string>;
  } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
    };
  }

  it('round-trips, ignores garbage, and never throws on a broken store', () => {
    const store = memory();
    expect(loadViewChoice(store)).toBeNull();
    saveViewChoice(store, 'list');
    expect(store.map.get(VIEW_KEY)).toBe('list');
    expect(loadViewChoice(store)).toBe('list');
    store.map.set(VIEW_KEY, 'grid');
    expect(loadViewChoice(store)).toBeNull();
    expect(loadViewChoice(null)).toBeNull();
    const broken = {
      getItem: (): string | null => {
        throw new Error('private mode');
      },
      setItem: (): void => {
        throw new Error('full');
      },
    };
    expect(loadViewChoice(broken)).toBeNull();
    expect(() => {
      saveViewChoice(broken, 'board');
    }).not.toThrow();
  });

  it('the board is primary on a desktop, the list on a phone', () => {
    expect(defaultViewFor(375)).toBe('list');
    expect(defaultViewFor(767)).toBe('list');
    expect(defaultViewFor(768)).toBe('board');
    expect(defaultViewFor(1280)).toBe('board');
  });
});

describe('the cooldown refusal, as the screen reads it', () => {
  it('a 429 is shown in the server’s words with how long to wait', () => {
    const outcome = interpretCrmResponse(429, {
      error: {
        code: 'SYNC_COOLDOWN',
        message: 'The pipeline was refreshed 20 seconds ago. You can refresh again in 40 seconds.',
        retryable: true,
      },
      retryAfterSeconds: 40,
    });
    expect(outcome).toEqual({
      kind: 'error',
      failure: 'cooldown',
      message: 'The pipeline was refreshed 20 seconds ago. You can refresh again in 40 seconds.',
      code: 'SYNC_COOLDOWN',
      status: 429,
      retryAfterSeconds: 40,
    });
  });

  it('a 429 with no body still says what to do', () => {
    expect(interpretCrmResponse(429, null)).toEqual({
      kind: 'error',
      failure: 'cooldown',
      message: CRM_MESSAGES.cooldown,
      code: 'HTTP_429',
      status: 429,
    });
  });
});
