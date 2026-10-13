/**
 * The four tools: what they are called, what they accept, and what leaves (MCP connector,
 * stage 1 — D103, D104, D107, D109).
 *
 * Two readers matter here. One is the client's AI, which sees only a tool's name, title and
 * description and will call it the way those read; the other is the client, who pays for
 * every character that comes back. Both are tested: the descriptions say what each tool
 * returns and what it does not, and every result is bounded.
 */
import { describe, expect, it } from 'vitest';

import {
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  MODERN_VERSION,
  decodeHeaderValue,
  negotiateLegacyVersion,
  parseMessage,
  resolveVersion,
} from '../../../src/lib/connector/protocol.js';
import type { TOOL_NAMES } from '../../../src/lib/connector/tools.js';
import {
  FORM_FIELD_ORDER,
  LIMITS,
  NOTICE,
  OLD_AFTER_MS,
  STALE_AFTER_MS,
  TOOLS,
  ageWords,
  decodeCursor,
  describeFreshness,
  encodeCursor,
  isToolName,
  perthTime,
  prepareCall,
  rateLimitMessage,
  sanitiseText,
  shapeToolReply,
} from '../../../src/lib/connector/tools.js';
import { MAPPED_FIELD_ORDER } from '../../../web/src/lib/leadDetailView.js';
import {
  OLD_AFTER_MS as APP_OLD_AFTER_MS,
  STALE_AFTER_MS as APP_STALE_AFTER_MS,
} from '../../../web/src/lib/overviewView.js';
import { FRESH, SUMMARY, leadDetail, leadRow, listing } from './helpers.js';

function prepared(tool: (typeof TOOL_NAMES)[number], args: unknown = {}) {
  const call = prepareCall(tool, args);
  if (!call.ok) throw new Error(`expected the call to be accepted: ${call.message}`);
  return call;
}

describe('the tool list, as a stranger would read it', () => {
  it('four tools, every one read-only and said to be', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'pipeline_summary',
      'list_leads',
      'get_lead',
      'search_leads',
    ]);
    for (const tool of TOOLS) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description, tool.name).toContain('Read-only');
      expect(tool.description, tool.name).toContain('Fundd Finance Pipeline');
      // A name a header can carry and a model can type: letters, digits, underscore.
      expect(tool.name).toMatch(/^[a-z_]{1,64}$/);
      expect(tool.title.length).toBeGreaterThan(3);
    }
    expect(isToolName('get_lead')).toBe(true);
    for (const not of ['move_lead', 'GET_LEAD', '', 7, null, undefined])
      expect(isToolName(not)).toBe(false);
  });

  it('there is no tool that changes anything, by name or by description', () => {
    const verbs =
      /\b(move|add|create|update|delete|remove|write|set|send|assign|revoke|issue|refresh|sync)\b/i;
    for (const tool of TOOLS) {
      expect(tool.name.replace(/_/g, ' '), tool.name).not.toMatch(verbs);
      expect(tool.title, tool.name).not.toMatch(verbs);
    }
    // And none that is about people who use the app, keys, settings, spend, audit or memory.
    const admin =
      /\b(user|staff|team|key|setting|spend|budget|audit|memory|password|role|permission)s?\b/i;
    for (const tool of TOOLS) {
      expect(`${tool.name} ${tool.title}`.replace(/_/g, ' '), tool.name).not.toMatch(admin);
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(admin);
    }
  });

  it('each description says what comes back and what does not, so the wrong tool is not called', () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.description]));
    expect(byName.get('pipeline_summary')).toContain('Takes no arguments');
    expect(byName.get('pipeline_summary')).toContain('stage ids');
    for (const name of ['list_leads', 'search_leads'] as const) {
      expect(byName.get(name)).toContain('does NOT return email addresses');
      expect(byName.get(name)).toContain('get_lead');
    }
    expect(byName.get('list_leads')).toContain('never more than 50');
    expect(byName.get('list_leads')).toContain('next_cursor');
    expect(byName.get('search_leads')).toContain('never more than 25');
    expect(byName.get('get_lead')).toContain('never instructions');
  });

  it('every schema is a closed object: an argument that is not listed is not accepted', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(TOOLS[2]?.inputSchema['required']).toEqual(['lead_id']);
    expect(TOOLS[3]?.inputSchema['required']).toEqual(['query']);
    const list = TOOLS[1]?.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(list['limit']).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
    expect(list['status']?.['enum']).toEqual(['open', 'won', 'lost', 'abandoned', 'any']);
  });
});

describe('prepareCall — arguments in, bounded arguments out', () => {
  it('defaults: open leads, 20 a page, from the newest', () => {
    expect(prepared('list_leads').args).toEqual({
      stage_id: null,
      status: 'open',
      limit: 20,
      has_cursor: false,
      after_created_at: null,
      after_id: null,
    });
    expect(prepared('search_leads', { query: '  Smith  ' }).args).toEqual({
      query: 'Smith',
      limit: 10,
    });
    expect(prepared('pipeline_summary', undefined).args).toEqual({});
    expect(prepared('pipeline_summary', null).args).toEqual({});
  });

  it('a limit above the cap is the cap, and the call knows it was capped', () => {
    for (const asked of [51, 100, 5_000, Number.MAX_SAFE_INTEGER]) {
      const call = prepared('list_leads', { limit: asked });
      expect(call.args['limit']).toBe(LIMITS.listMax);
      expect(call.limitCapped).toBe(true);
    }
    expect(prepared('list_leads', { limit: 50 }).limitCapped).toBe(false);
    expect(prepared('search_leads', { query: 'ab', limit: 26 }).args['limit']).toBe(
      LIMITS.searchMax,
    );
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 60,
      '10',
      true,
      null,
      [5],
    ]) {
      expect(prepareCall('list_leads', { limit: bad }).ok, String(bad)).toBe(false);
    }
  });

  it('ids are ids: a name, a path or a piece of SQL is not one', () => {
    expect(prepared('get_lead', { lead_id: 'bxsEZfR8ghLL19YAL31t' }).args).toEqual({
      lead_id: 'bxsEZfR8ghLL19YAL31t',
    });
    expect(
      prepared('list_leads', { stage_id: '5d215f52-d09d-45c8-a192-a2555ce46317' }).args['stage_id'],
    ).toBe('5d215f52-d09d-45c8-a192-a2555ce46317');
    for (const bad of ['', ' ', 'New Lead', 'a/b', "x';--", 'x'.repeat(65), '%', '*']) {
      expect(prepareCall('get_lead', { lead_id: bad }).ok, bad).toBe(false);
      expect(prepareCall('list_leads', { stage_id: bad }).ok, bad).toBe(false);
    }
  });

  it('a search is cleaned before it is measured: hidden characters do not count, and do not travel', () => {
    expect(prepared('search_leads', { query: 'Sm\u{200B}ith\u{202E}' }).args['query']).toBe(
      'Smith',
    );
    expect(prepareCall('search_leads', { query: '\u{200B}\u{200B}a' }).ok).toBe(false);
    expect(prepareCall('search_leads', { query: ' a ' }).ok).toBe(false);
    expect(prepared('search_leads', { query: 'x'.repeat(100) }).args['query']).toHaveLength(100);
    expect(prepareCall('search_leads', { query: 'x'.repeat(101) }).ok).toBe(false);
    // A wildcard is text to find; the database escapes it (tests/security/connector.test.ts).
    expect(prepared('search_leads', { query: '100%' }).args['query']).toBe('100%');
  });

  it('an unknown argument is named — cleaned and short — with what the tool does accept', () => {
    const many = prepareCall('list_leads', { a: 1, b: 2, c: 3, d: 4 });
    expect(!many.ok && many.message).toBe(
      'Unknown argument: a, b, c. list_leads accepts stage_id, status, limit, cursor.',
    );
    const hostile = prepareCall('get_lead', {
      lead_id: 'x',
      [`evil\u{202E}${'z'.repeat(200)}`]: 1,
    });
    expect(!hostile.ok && hostile.message.length).toBeLessThan(120);
    expect(!hostile.ok && hostile.message).not.toContain('\u{202E}');
  });
});

describe('the cursor', () => {
  it('round-trips the last row exactly, and nothing else decodes', () => {
    const cursor = encodeCursor({ at: '2026-10-12T04:38:29.968845+00:00', id: 'op-2' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ at: '2026-10-12T04:38:29.968845+00:00', id: 'op-2' });
    expect(decodeCursor(encodeCursor({ at: null, id: 'op-9' }))).toEqual({ at: null, id: 'op-9' });
    const forge = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=+$/, '');
    for (const bad of [
      '',
      'x',
      '!!!',
      'a'.repeat(301),
      5,
      null,
      forge('text'),
      forge(null),
      forge({ c: null }),
      forge({ c: null, i: 'not an id' }),
      forge({ c: 'yesterday', i: 'op-1' }),
      forge({ c: "2026-10-12'; drop table x;--", i: 'op-1' }),
      forge({ c: 20261012, i: 'op-1' }),
    ]) {
      expect(decodeCursor(bad), String(bad).slice(0, 30)).toBeNull();
    }
  });

  it('a page hands on the instant as stored, to the microsecond: a rounded one could skip a row', () => {
    const rows = [
      leadRow(1, { created_at: '2026-10-12T04:38:29.968845+00:00' }),
      leadRow(2, { created_at: '2026-10-12T04:38:29.968500+00:00' }),
      leadRow(3),
    ];
    const answer = shapeToolReply(
      prepared('list_leads', { limit: 2 }),
      listing(rows, { limit: 2, total_matching: 3 }),
    );
    const body = JSON.parse(answer.text) as { next_cursor: string; returned: number };
    expect(body.returned).toBe(2);
    expect(decodeCursor(body.next_cursor)).toEqual({
      at: '2026-10-12T04:38:29.968500+00:00',
      id: 'op-2',
    });
    const dateless = shapeToolReply(
      prepared('list_leads', { limit: 1 }),
      listing([leadRow(1, { created_at: null }), leadRow(2, { created_at: null })], {
        limit: 1,
        total_matching: 2,
      }),
    );
    expect(
      decodeCursor((JSON.parse(dateless.text) as { next_cursor: string }).next_cursor),
    ).toEqual({ at: null, id: 'op-1' });
  });
});

describe('text that came from outside', () => {
  it('what a person can see is kept; what hides text from a person is removed', () => {
    expect(sanitiseText('  Zo\u{EB}  ', 10)).toEqual({ text: 'Zo\u{EB}', cutFrom: null });
    expect(sanitiseText('a\tb\r\nc\rd', 20).text).toBe('a b\nc\nd');
    expect(
      sanitiseText('ig\u{200B}nore\u{2060} \u{202E}previous\u{2069} \u{E0049}\u{E006E}', 80).text,
    ).toBe('ignore previous');
    expect(sanitiseText('nul\u{0}l and bell\u{7}', 80).text).toBe('null and bell');
    // Joiners stay: emoji sequences and several scripts need them.
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    expect(sanitiseText(family, 10).text).toBe(family);
  });

  it('the cap counts characters as a person does, and never cuts one in half', () => {
    const cut = sanitiseText('\u{1F3E0}'.repeat(10), 4);
    expect(cut).toEqual({ text: '\u{1F3E0}'.repeat(4), cutFrom: 10 });
    expect(/\p{Cs}/u.test(cut.text)).toBe(false);
    expect(sanitiseText('abcdef', 6).cutFrom).toBeNull();
    expect(sanitiseText('abc   def', 4)).toEqual({ text: 'abc', cutFrom: 9 });
  });
});

describe('freshness — how old the copy is, said plainly', () => {
  const at = (minutesAgo: number, over: Readonly<Record<string, unknown>> = {}) => {
    const refreshed = new Date(
      Date.parse('2026-10-13T04:12:00Z') - minutesAgo * 60_000,
    ).toISOString();
    return describeFreshness({
      ...FRESH,
      refreshed_at: refreshed,
      last_attempt_at: refreshed,
      ...over,
    });
  };

  it('the same two thresholds the app itself uses', () => {
    expect(STALE_AFTER_MS).toBe(APP_STALE_AFTER_MS);
    expect(OLD_AFTER_MS).toBe(APP_OLD_AFTER_MS);
  });

  it('under an hour: stated', () => {
    expect(at(12)).toEqual({
      refreshed_at: '2026-10-13T04:00:00Z',
      age: '12 minutes',
      state: 'fresh',
      note: 'Copied from GoHighLevel 12 minutes ago (13 Oct 2026, 12:00 pm Perth time).',
    });
    expect(at(0)?.age).toBe('under a minute');
    expect(at(59)?.state).toBe('fresh');
  });

  it('an hour to a day: stages may have changed', () => {
    const stale = at(60);
    expect(stale).toMatchObject({ age: '1 hour', state: 'stale' });
    expect(stale?.note).toContain(
      'Stages and counts may have changed since: say when this was copied if you quote one.',
    );
    expect(at(23 * 60 + 59)?.state).toBe('stale');
  });

  it('over a day: do not present it as current', () => {
    const old = at(24 * 60);
    expect(old).toMatchObject({ age: '1 day', state: 'old' });
    expect(old?.note).toContain('Do not present it as current.');
    expect(at(8 * 24 * 60)?.age).toBe('8 days');
  });

  it('a failed attempt since, or a partial refresh, is said as well', () => {
    const failed = at(120, {
      last_attempt_status: 'failed',
      last_attempt_at: '2026-10-13T04:10:00Z',
    });
    expect(failed?.note).toContain(
      'The most recent refresh attempt failed, so this is from the refresh before it.',
    );
    const partial = at(5, { last_attempt_status: 'partial' });
    expect(partial?.note).toContain('could not read every contact');
    // A later attempt that succeeded partially is not this refresh; nothing is claimed about it.
    const laterPartial = at(120, {
      last_attempt_status: 'partial',
      last_attempt_at: '2026-10-13T04:10:00Z',
    });
    expect(laterPartial?.note).not.toContain('could not read every contact');
  });

  it('a time that cannot be read is no freshness at all, and the result is then a failed read', () => {
    expect(describeFreshness({ ...FRESH, refreshed_at: null })).toBeNull();
    expect(describeFreshness({ ...FRESH, refreshed_at: 'soon' })).toBeNull();
    expect(describeFreshness({ ...FRESH, read_at: 'now' })).toBeNull();
    const answer = shapeToolReply(prepared('pipeline_summary'), {
      ...SUMMARY,
      freshness: { ...FRESH, read_at: 'now' },
    });
    expect(answer).toMatchObject({ isError: true, outcome: 'read_failed' });
  });

  it('Perth time, by hand, at the edges', () => {
    expect(perthTime(Date.parse('2026-10-12T16:00:00Z'))).toBe('13 Oct 2026, 12:00 am Perth time');
    expect(perthTime(Date.parse('2026-12-31T15:59:00Z'))).toBe('31 Dec 2026, 11:59 pm Perth time');
    expect(perthTime(Date.parse('2026-12-31T16:05:00Z'))).toBe('1 Jan 2027, 12:05 am Perth time');
    expect(ageWords(61_000)).toBe('1 minute');
    expect(ageWords(2 * 3_600_000)).toBe('2 hours');
  });
});

describe('what leaves', () => {
  it('pipeline_summary: counts in pipeline order, the freshness, and no stranger text', () => {
    const answer = shapeToolReply(prepared('pipeline_summary'), SUMMARY);
    expect(answer).toMatchObject({ isError: false, outcome: 'ok', records: 2 });
    expect(JSON.parse(answer.text)).toEqual({
      freshness: {
        refreshed_at: '2026-10-13T04:00:00Z',
        age: '12 minutes',
        state: 'fresh',
        note: 'Copied from GoHighLevel 12 minutes ago (13 Oct 2026, 12:00 pm Perth time).',
      },
      pipeline: { id: 'PIPE_FINANCE', name: 'Finance Pipeline' },
      open_leads: 3,
      new_open_leads_last_7_days: 2,
      leads_by_status: { open: 3, won: 1 },
      stages: [
        { stage_id: 'st-new', name: 'New Lead', open_leads: 2 },
        { stage_id: 'st-booked', name: 'Appointment Booked', open_leads: 1 },
      ],
    });
    // One compact line of JSON: no second, pretty-printed copy to pay for.
    expect(answer.text).not.toContain('\n');
  });

  it('list_leads: a short row each, the notice, and exactly these keys', () => {
    const answer = shapeToolReply(
      prepared('list_leads'),
      listing([leadRow(1), leadRow(2, { name: null })]),
    );
    const body = JSON.parse(answer.text) as { leads: Record<string, unknown>[] } & Record<
      string,
      unknown
    >;
    expect(Object.keys(body)).toEqual([
      'notice',
      'freshness',
      'leads',
      'returned',
      'total_matching',
      'limit',
      'next_cursor',
    ]);
    expect(body['notice']).toBe(NOTICE);
    expect(body.leads[0]).toEqual({
      lead_id: 'op-1',
      name: 'First1 Example1',
      stage_id: 'st-new',
      stage: 'New Lead',
      status: 'open',
      created_at: '2026-10-11T04:38:29Z',
    });
    expect(body.leads[1]?.['name']).toBe('Unnamed lead');
    expect(answer.records).toBe(2);
  });

  it('search_leads: says which field matched, and says when there are more than it shows', () => {
    const rows = Array.from({ length: 10 }, (_unused, i) =>
      leadRow(i, { matched_on: ['name', 'email'] }),
    );
    const answer = shapeToolReply(
      prepared('search_leads', { query: 'example' }),
      listing(rows, { limit: 10, total_matching: 37 }),
    );
    const body = JSON.parse(answer.text) as Record<string, unknown>;
    expect(body).not.toHaveProperty('next_cursor');
    expect((body['leads'] as { matched_on: string[] }[])[0]?.matched_on).toEqual(['name', 'email']);
    expect(body['note']).toBe(
      '37 leads match; the 10 newest are shown. Narrow the query to see the others.',
    );
    const capped = shapeToolReply(
      prepared('search_leads', { query: 'example', limit: 99 }),
      listing(rows, { limit: 25, total_matching: 10 }),
    );
    expect((JSON.parse(capped.text) as { note: string }).note).toBe(
      '25 is the most one search returns; narrow the query to see the others.',
    );
  });

  it('get_lead: the form answers in the order the app shows them, labelled as the app labels them', () => {
    expect(FORM_FIELD_ORDER).toEqual(MAPPED_FIELD_ORDER);
    const answer = shapeToolReply(prepared('get_lead', { lead_id: 'op-1' }), leadDetail());
    const lead = (JSON.parse(answer.text) as { lead: Record<string, unknown> }).lead;
    expect(lead['form_answers']).toEqual([
      { label: 'Loan Type', value: 'Refinance' },
      { label: 'Loan Amount', value: '451000' },
      { label: 'Annual Income', value: null },
    ]);
    expect(lead['notes']).toEqual([
      { added_at: '2026-10-13T03:38:29Z', written_by: 'a team member', text: 'Payslips received.' },
      {
        added_at: '2026-10-13T02:38:29Z',
        written_by: 'you',
        text: 'Called, wants a callback after 5pm.',
      },
    ]);
    expect(lead['notes_held']).toContain('A note typed straight into GoHighLevel is not');
    expect(lead).toMatchObject({
      lead_id: 'op-1',
      name: 'First1 Example1',
      status: 'open',
      stage: 'New Lead',
      monetary_value: 0,
      opportunity_name: 'Opportunity 1',
      contact: { name: 'First1 Example1', do_not_disturb: false, tags: ['refi', 'perth'] },
      other_fields: [{ label: 'Preferred Suburb', value: 'Joondalup' }],
    });
    // Nobody is named as a note's author: not an email, not a user id.
    expect(answer.text).not.toMatch(/author|user_id|@fundd/);
  });

  it('get_lead: what GoHighLevel does not hold is null, never a guess', () => {
    const bare = leadDetail({
      opportunity_name: '',
      monetary_value: null,
      source: '  ',
      contact: null,
      form_answers: [
        { internal_field: 'made_up_field', field_id: 'cf-z', label: null, value: ['a', ' ', 'b'] },
        { internal_field: 'loan_type', field_id: 'cf-t', label: null, value: { nested: true } },
        { internal_field: 'credit_concerns', field_id: 'cf-c', label: '', value: true },
        { internal_field: 'annual_income', field_id: 'cf-i', label: 'Income', value: Number.NaN },
      ],
      other_fields: [{ field_id: 'cf-empty', label: 'Empty', value: '   ' }],
      other_fields_total: 1,
      notes: [],
      notes_total: 0,
    });
    const lead = (
      JSON.parse(shapeToolReply(prepared('get_lead', { lead_id: 'op-1' }), bare).text) as {
        lead: Record<string, unknown>;
      }
    ).lead;
    expect(lead).toMatchObject({
      name: 'Unnamed lead',
      opportunity_name: null,
      monetary_value: null,
      source: null,
      contact: null,
      notes: [],
      other_fields: [],
    });
    expect(lead['form_answers']).toEqual([
      { label: 'Loan type', value: null },
      { label: 'Income', value: null },
      { label: 'Credit concerns', value: 'true' },
      { label: 'Made up field', value: 'a, b' },
    ]);
    expect(lead).not.toHaveProperty('notes_not_shown');
    expect(lead).not.toHaveProperty('other_fields_not_shown');
  });

  it('a contact with no full name is named from its parts; a note cut by the database says its real length', () => {
    const detail = leadDetail({
      contact: {
        full_name: ' ',
        first_name: 'Sam',
        last_name: '',
        email: null,
        phone: null,
        source: null,
        dnd: null,
        tags: null,
        tags_total: 0,
        created_at: null,
        updated_at: null,
      },
      notes: [{ note_id: 'n', body: 'short', body_length: 9_000, added_at: null, yours: false }],
      notes_total: 1,
    });
    const lead = (
      JSON.parse(shapeToolReply(prepared('get_lead', { lead_id: 'op-1' }), detail).text) as {
        lead: { name: string; contact: { tags: string[] }; notes: { text: string }[] };
      }
    ).lead;
    expect(lead.name).toBe('Sam');
    expect(lead.contact.tags).toEqual([]);
    expect(lead.notes[0]?.text).toBe('short …[cut: 9000 characters in all]');
  });

  it('every worst case stays inside a stated size', () => {
    const longText = '\u{5F20}'.repeat(5_000);
    const rows = Array.from({ length: 51 }, (_unused, i) =>
      leadRow(i, { name: longText, stage_name: longText }),
    );
    const list = shapeToolReply(
      prepared('list_leads', { limit: 50 }),
      listing(rows, { limit: 50, total_matching: 9_999 }),
    );
    expect(
      (JSON.parse(list.text) as { leads: { name: string }[] }).leads[0]?.name.length,
    ).toBeLessThan(260);
    expect(new TextEncoder().encode(list.text).length).toBeLessThan(80_000);
    const detail = leadDetail({
      opportunity_name: longText,
      source: longText,
      contact: {
        full_name: longText,
        first_name: longText,
        last_name: longText,
        email: longText,
        phone: longText,
        source: longText,
        dnd: true,
        tags: Array.from({ length: 21 }, () => longText),
        tags_total: 500,
        created_at: null,
        updated_at: null,
      },
      form_answers: FORM_FIELD_ORDER.map((name) => ({
        internal_field: name,
        field_id: name,
        label: longText,
        value: longText,
      })),
      other_fields: Array.from({ length: 21 }, (_unused, i) => ({
        field_id: `f${String(i)}`,
        label: longText,
        value: longText,
      })),
      other_fields_total: 400,
      notes: Array.from({ length: 5 }, (_unused, i) => ({
        note_id: `n${String(i)}`,
        body: longText.slice(0, 4_000),
        body_length: 20_000,
        added_at: null,
        yours: false,
      })),
      notes_total: 300,
    });
    const one = shapeToolReply(prepared('get_lead', { lead_id: 'op-1' }), detail);
    expect(new TextEncoder().encode(one.text).length).toBeLessThan(120_000);
    const lead = (JSON.parse(one.text) as { lead: Record<string, unknown> }).lead;
    expect((lead['other_fields'] as unknown[]).length).toBe(LIMITS.otherFields);
    expect((lead['notes'] as unknown[]).length).toBe(LIMITS.notes);
    expect(lead).toMatchObject({ other_fields_not_shown: 380, notes_not_shown: 295 });
  });

  it('the rate-limit sentence gives the wait in the unit a person would use', () => {
    expect(rateLimitMessage('minute', 1)).toContain('Wait 1 second,');
    expect(rateLimitMessage('minute', 45)).toContain('Wait 45 seconds,');
    expect(rateLimitMessage('day', 90)).toContain('in about 1 minute.');
    expect(rateLimitMessage('day', 86_400)).toContain('in about 1 day.');
  });
});

describe('the protocol, in its parts', () => {
  const headers = (values: Readonly<Record<string, string>> = {}) => ({
    get: (name: string): string | null => values[name.toLowerCase()] ?? null,
  });
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const message = parseMessage({ jsonrpc: '2.0', id: 1, method, params });
    if (message.kind !== 'request') throw new Error('expected a request');
    return message;
  };

  it('a message is a request, a notification, or said to be neither', () => {
    expect(parseMessage({ jsonrpc: '2.0', id: 'a', method: 'ping' })).toEqual({
      kind: 'request',
      id: 'a',
      method: 'ping',
      params: {},
    });
    expect(parseMessage({ jsonrpc: '2.0', method: 'x', params: { a: 1 } })).toEqual({
      kind: 'notification',
      method: 'x',
      params: { a: 1 },
    });
    expect(parseMessage({ jsonrpc: '2.0', id: 'x'.repeat(257), method: 'ping' }).kind).toBe(
      'invalid',
    );
    expect(parseMessage({ jsonrpc: '2.0', id: 2 ** 60, method: 'ping' }).kind).toBe('invalid');
    expect(parseMessage([])).toMatchObject({ kind: 'invalid', id: null });
  });

  it('the version a request names decides its era; one that names none is the last revision without a header', () => {
    expect(resolveVersion(headers(), request('tools/list'))).toEqual({
      ok: true,
      era: 'legacy',
      version: '2025-03-26',
    });
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      expect(
        resolveVersion(headers({ 'mcp-protocol-version': version }), request('tools/list')),
      ).toEqual({
        ok: true,
        era: 'legacy',
        version,
      });
    }
    const meta = { [META_PROTOCOL_VERSION]: MODERN_VERSION, [META_CLIENT_CAPABILITIES]: {} };
    expect(
      resolveVersion(
        headers({ 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/list' }),
        request('tools/list', { _meta: meta }),
      ),
    ).toEqual({ ok: true, era: 'modern', version: MODERN_VERSION });
    // A modern notification is not held to the headers: the revision does not define them.
    const notification = parseMessage({
      jsonrpc: '2.0',
      method: 'notifications/x',
      params: { _meta: meta },
    });
    if (notification.kind !== 'notification') throw new Error('expected a notification');
    expect(resolveVersion(headers(), notification)).toEqual({
      ok: true,
      era: 'modern',
      version: MODERN_VERSION,
    });
    // A requested version is echoed short, whatever was sent.
    const long = resolveVersion(
      headers({ 'mcp-protocol-version': 'x'.repeat(500) }),
      request('tools/list'),
    );
    expect(!long.ok && JSON.stringify(long.data).length).toBeLessThan(160);
  });

  it('header values: plain, base64, and broken', () => {
    expect(decodeHeaderValue('get_lead')).toBe('get_lead');
    expect(decodeHeaderValue(`=?base64?${btoa('get_lead')}?=`)).toBe('get_lead');
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, \u{4E16}\u{754C}');
    expect(decodeHeaderValue('=?base64?/w==?=')).toBeNull();
    expect(negotiateLegacyVersion(7)).toBeNull();
    expect(negotiateLegacyVersion('')).toBeNull();
  });
});
