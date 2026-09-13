/**
 * Schemas and mapping (src/lib/crm/ghl/types.ts, map.ts) — the data edge cases of the M4
 * part 1 brief at the record level: unicode and very long values, monetary zero versus
 * null, UTC in and UTC out with no local conversion, a contact with no email or phone,
 * a contact whose name changed (same id, different hash), custom fields absent / null /
 * empty / wrong type, and the PII-bearing blocks GHL attaches that must never be stored.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  contentHash,
  fullNameOf,
  readCustomField,
  toContactRow,
  toCustomFieldRow,
  toOpportunityRow,
  toPipelineRow,
  toStageRow,
} from '../../../../src/lib/crm/ghl/map.js';
import {
  CONTACT_SCHEMA,
  CUSTOM_FIELD_DEFINITION_SCHEMA,
  OPPORTUNITY_SCHEMA,
  PIPELINES_RESPONSE_SCHEMA,
} from '../../../../src/lib/crm/ghl/types.js';
import {
  FINANCE_PIPELINE_ID,
  LOCATION_ID,
  fixtureContact,
  fixtureOpportunities,
  fixturePipelines,
  ghlFixtureJson,
  must,
} from './helpers.js';

describe('opportunity schema and row', () => {
  const listing = fixtureOpportunities();
  const byId = new Map(listing.opportunities.map((o) => [o.id, o]));

  it('keeps zero and null monetary values apart, and a fractional value exact', () => {
    expect(byId.get('OPP0000000000000001')?.monetaryValue).toBe(0);
    expect(byId.get('OPP0000000000000002')?.monetaryValue).toBeNull();
    expect(byId.get('OPP0000000000000003')?.monetaryValue).toBe(450000.5);
    expect(toOpportunityRow(must(byId.get('OPP0000000000000002'))).monetary_value).toBeNull();
    expect(toOpportunityRow(must(byId.get('OPP0000000000000001'))).monetary_value).toBe(0);
  });

  it('strips relations, attributions and the embedded contact (IP, user agent, pixel ids)', () => {
    const raw = ghlFixtureJson('opportunities-all') as { opportunities: Record<string, unknown>[] };
    expect(raw.opportunities[0]).toHaveProperty('relations');
    expect(raw.opportunities[0]).toHaveProperty('attributions');
    const parsed = OPPORTUNITY_SCHEMA.parse(raw.opportunities[0]);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'id',
        'name',
        'pipelineId',
        'pipelineStageId',
        'contactId',
        'status',
        'monetaryValue',
        'source',
        'assignedTo',
        'createdAt',
        'updatedAt',
        'lastStageChangeAt',
        'lastStatusChangeAt',
      ].sort(),
    );
    const text = JSON.stringify(toOpportunityRow(parsed));
    expect(text).not.toContain('203.0.113.10');
    expect(text).not.toContain('Mozilla');
    expect(text).not.toContain('fb.1.');
    expect(text).not.toContain('synthetic@example.com');
  });

  it('an opportunity with no contact maps to a null contact id', () => {
    expect(toOpportunityRow(must(byId.get('OPP0000000000000003'))).contact_ghl_id).toBeNull();
  });

  it('rejects an unknown status and a missing id rather than guessing', () => {
    const raw = ghlFixtureJson('opportunities-bad-records') as { opportunities: unknown[] };
    expect(OPPORTUNITY_SCHEMA.safeParse(raw.opportunities[1]).success).toBe(false);
    expect(OPPORTUNITY_SCHEMA.safeParse(raw.opportunities[3]).success).toBe(false);
  });

  it('stores timestamps as UTC ISO strings and never converts to local time', () => {
    const base = ghlFixtureJson('opportunities-all') as {
      opportunities: Record<string, unknown>[];
    };
    const withOffset = {
      ...base.opportunities[0],
      createdAt: '2026-09-01T10:15:00.000+08:00',
      updatedAt: '2026-09-03T05:40:12.000Z',
    };
    const parsed = OPPORTUNITY_SCHEMA.parse(withOffset);
    // Perth 10:15 (+08:00) IS 02:15 UTC — a normalisation, not a conversion to local time.
    expect(parsed.createdAt).toBe('2026-09-01T02:15:00.000Z');
    expect(parsed.updatedAt).toBe('2026-09-03T05:40:12.000Z');
    expect(parsed.createdAt?.endsWith('Z')).toBe(true);
    expect(
      OPPORTUNITY_SCHEMA.safeParse({ ...base.opportunities[0], createdAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('preserves unicode and emoji in names', () => {
    const row = toOpportunityRow(must(byId.get('OPP0000000000000002')));
    expect(row.name).toBe('Sam Ó Brádaigh 🏠');
  });

  it('hashes deterministically, and a stage move changes the hash', () => {
    const one = must(byId.get('OPP0000000000000001'));
    const a = toOpportunityRow(one);
    const b = toOpportunityRow(OPPORTUNITY_SCHEMA.parse(JSON.parse(JSON.stringify(one))));
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const moved = toOpportunityRow({ ...one, pipelineStageId: 'other-stage' });
    expect(moved.content_hash).not.toBe(a.content_hash);
    expect(moved.ghl_id).toBe(a.ghl_id);
  });
});

describe('pipeline and stage rows', () => {
  it('keys stages on id and keeps the name — including a trailing space — for display only', () => {
    const pipelines = fixturePipelines();
    const decoy = must(pipelines[0]);
    const trailing = decoy.stages.find((s) => s.name === 'Contacted ');
    expect(trailing?.id).toBe('824d0c9d-2ad1-4f11-9675-124bc1e53a8b');
    expect(toStageRow(must(trailing))).toEqual({
      ghl_id: '824d0c9d-2ad1-4f11-9675-124bc1e53a8b',
      name: 'Contacted ',
      position: 1,
      win_probability: 40,
    });
    const finance = must(pipelines.find((p) => p.id === FINANCE_PIPELINE_ID));
    expect(toPipelineRow(finance, 'fallback')).toEqual({
      ghl_id: FINANCE_PIPELINE_ID,
      name: 'Finance Pipeline',
      location_id: LOCATION_ID,
      ghl_updated_at: '2026-08-24T01:38:07.564Z',
    });
    expect(finance.stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a renamed and reordered pipeline maps to the same stage ids', () => {
    const before = must(fixturePipelines().find((p) => p.id === FINANCE_PIPELINE_ID));
    const after = must(
      fixturePipelines('pipelines-changed').find((p) => p.id === FINANCE_PIPELINE_ID),
    );
    expect(after.name).toBe('Fundd Pipeline ');
    const renamed = after.stages.find((s) => s.id === '51c98561-cd26-49a9-a001-97536c31dd0a');
    expect(renamed?.name).toBe('Lead In ');
    expect(before.stages.find((s) => s.id === renamed?.id)?.name).toBe('New Lead');
    expect(after.stages.some((s) => s.id === '9cef8b67-1171-4347-9275-36e1055a97aa')).toBe(false);
    expect(after.stages.some((s) => s.name === 'Pre-Approval')).toBe(true);
  });

  it('refuses a pipelines envelope that is not a list', () => {
    expect(PIPELINES_RESPONSE_SCHEMA.safeParse({ pipelines: 'nope' }).success).toBe(false);
  });
});

describe('contact schema and row', () => {
  it('keys custom fields by id and keeps null and empty-string values distinct from absent', () => {
    const row = toContactRow(fixtureContact('contact-1'));
    expect(row.custom_fields).toEqual({
      Ht7MfhngWRq1uloc65B3: ['WA'],
      TANd0sfC9wRwuJKhSGFx: ['$500k–$750k'],
      hX8JQblBT9iJhYEa348M: ['6.2% - 6.5%'],
      axTFAYBC1ZCQ4KKuAMXZ: 'Facebook Ad',
      UWmWQyJn1lEhC8XRjqQD: 650000,
      '9Qm4YOeMoHMDNyl2keDL': '',
      tQA4cVpB63irs4gBdKBO: null,
    });
    expect('ZtrfHuvMZQZAPEEd7o1U' in row.custom_fields).toBe(false);
    expect(row.full_name).toBe('Alex Tran');
    expect(row.dnd).toBe(false);
    expect(row.tags).toEqual(['fb lead']);
    expect(row.ghl_created_at).toBe('2026-09-01T02:14:58.000Z');
  });

  it('a contact with no phone keeps a null phone; one with nothing at all is still a row', () => {
    const two = toContactRow(fixtureContact('contact-2'));
    expect(two.email).toBe('sam.synthetic@example.com');
    expect(two.phone).toBeNull();
    expect(two.full_name).toBe('Sam Ó Brádaigh 🏠');
    const three = toContactRow(fixtureContact('contact-3-minimal'));
    expect(three).toMatchObject({
      ghl_id: 'CONTACT000000000003',
      first_name: null,
      last_name: null,
      full_name: null,
      email: null,
      phone: null,
      dnd: null,
      tags: [],
      custom_fields: {},
    });
  });

  it('carries a 5,000-character unicode value through untouched', () => {
    const row = toContactRow(fixtureContact('contact-2'));
    const note = row.custom_fields['3ma6Czg50bY5yhJ18zrD'];
    expect(typeof note).toBe('string');
    expect((note as string).length).toBeGreaterThan(5000);
    expect((note as string).startsWith('ŁŁŁ')).toBe(true);
    expect(note as string).toContain('🏠🔥');
  });

  it('a renamed contact (GHL merged a new submission into the same email) keeps its id and changes its hash', () => {
    const before = toContactRow(fixtureContact('contact-1'));
    const after = toContactRow(fixtureContact('contact-1-renamed'));
    expect(after.ghl_id).toBe(before.ghl_id);
    expect(after.email).toBe(before.email);
    expect(after.full_name).toBe('Alexandra Tran-Nguyen');
    expect(after.content_hash).not.toBe(before.content_hash);
  });

  it('rejects a custom field value that is an object — the whole contact, never half of it', () => {
    const raw = ghlFixtureJson('contact-bad-shape') as { contact: unknown };
    expect(CONTACT_SCHEMA.safeParse(raw.contact).success).toBe(false);
  });

  it('never keeps the attribution block', () => {
    const raw = ghlFixtureJson('contact-1') as { contact: Record<string, unknown> };
    expect(raw.contact).toHaveProperty('attributionSource');
    const text = JSON.stringify(toContactRow(CONTACT_SCHEMA.parse(raw.contact)));
    expect(text).not.toContain('203.0.113.10');
    expect(text).not.toContain('Mozilla');
  });

  it('fullNameOf falls back to contactName and then to null', () => {
    const base = fixtureContact('contact-3-minimal');
    expect(fullNameOf({ ...base, contactName: '  Whole Name ' })).toBe('Whole Name');
    expect(fullNameOf({ ...base, firstName: ' ', lastName: 'Only' })).toBe('Only');
    expect(fullNameOf(base)).toBeNull();
  });
});

describe('custom field definitions', () => {
  it('maps a definition to its row', () => {
    const raw = ghlFixtureJson('custom-fields-clean') as { customFields: unknown[] };
    const def = CUSTOM_FIELD_DEFINITION_SCHEMA.parse(raw.customFields[0]);
    expect(toCustomFieldRow(def)).toEqual({
      ghl_id: 'UWmWQyJn1lEhC8XRjqQD',
      name: 'Loan Amount',
      field_key: 'contact.loan_amount',
      data_type: 'NUMERICAL',
      model: 'contact',
      parent_id: 'BEFyPDjs8dlcpRuz3ZcL',
      position: 50,
      picklist_options: null,
    });
  });
});

describe('canonicalJson and contentHash', () => {
  it('is independent of key order at every depth', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } });
    const b = canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(contentHash({ x: 1, y: 2 })).toBe(contentHash({ y: 2, x: 1 }));
    expect(contentHash({ x: 1 })).not.toBe(contentHash({ x: 2 }));
  });
});

describe('readCustomField', () => {
  it('distinguishes absent from empty', () => {
    expect(readCustomField('NUMERICAL', undefined)).toEqual({ kind: 'absent' });
    expect(readCustomField('NUMERICAL', null)).toEqual({ kind: 'empty' });
    expect(readCustomField('TEXT', '')).toEqual({ kind: 'empty' });
    expect(readCustomField('TEXT', '   ')).toEqual({ kind: 'empty' });
    expect(readCustomField('MULTIPLE_OPTIONS', [])).toEqual({ kind: 'empty' });
    expect(readCustomField('MULTIPLE_OPTIONS', ['', ' '])).toEqual({ kind: 'empty' });
  });

  it('reads numbers, tolerating GHL sending a numeric string', () => {
    expect(readCustomField('NUMERICAL', 650000)).toEqual({ kind: 'number', value: 650000 });
    expect(readCustomField('NUMERICAL', '650000')).toEqual({ kind: 'number', value: 650000 });
    expect(readCustomField('NUMERICAL', '$650,000')).toEqual({ kind: 'number', value: 650000 });
    expect(readCustomField('NUMERICAL', 0)).toEqual({ kind: 'number', value: 0 });
    expect(readCustomField('numerical', '12.5')).toEqual({ kind: 'number', value: 12.5 });
  });

  it('a wrong type is invalid, never guessed', () => {
    expect(readCustomField('NUMERICAL', 'six hundred')).toMatchObject({ kind: 'invalid' });
    expect(readCustomField('NUMERICAL', ['1'])).toMatchObject({ kind: 'invalid' });
    expect(readCustomField('NUMERICAL', true)).toMatchObject({ kind: 'invalid' });
    expect(readCustomField('TEXT', ['a'])).toMatchObject({ kind: 'invalid' });
    expect(readCustomField('TEXT', true)).toMatchObject({ kind: 'invalid' });
    expect(readCustomField('SINGLE_OPTIONS', 3)).toMatchObject({ kind: 'invalid' });
    expect(readCustomField('MULTIPLE_OPTIONS', 3)).toMatchObject({ kind: 'invalid' });
  });

  it('reads text and options by their type', () => {
    expect(readCustomField('TEXT', 'hello')).toEqual({ kind: 'text', value: 'hello' });
    expect(readCustomField('LARGE_TEXT', 42)).toEqual({ kind: 'text', value: '42' });
    expect(readCustomField('SINGLE_OPTIONS', 'Refinance')).toEqual({
      kind: 'options',
      values: ['Refinance'],
    });
    expect(readCustomField('RADIO', ['Yes'])).toEqual({ kind: 'options', values: ['Yes'] });
    expect(readCustomField('MULTIPLE_OPTIONS', ['WA', '', 'NSW'])).toEqual({
      kind: 'options',
      values: ['WA', 'NSW'],
    });
    expect(readCustomField('CHECKBOX', 'one')).toEqual({ kind: 'options', values: ['one'] });
    expect(readCustomField('CHECKBOX', true)).toEqual({ kind: 'boolean', value: true });
  });

  it('an unknown data type keeps the JSON shape', () => {
    expect(readCustomField('SIGNATURE', 'sig')).toEqual({ kind: 'text', value: 'sig' });
    expect(readCustomField('SIGNATURE', 7)).toEqual({ kind: 'number', value: 7 });
    expect(readCustomField('SIGNATURE', false)).toEqual({ kind: 'boolean', value: false });
    expect(readCustomField('SIGNATURE', ['a', 'b'])).toEqual({
      kind: 'options',
      values: ['a', 'b'],
    });
  });
});
