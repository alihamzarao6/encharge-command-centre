/**
 * GoHighLevel client (src/lib/crm/ghl/client.ts) against scripted fetches and recorded
 * fixtures — the API edge cases of the M4 part 1 brief: pagination, 429 with backoff and
 * a cap, timeouts, a LOUD 401, 5xx retried then abandoned, a shape that does not match
 * rejected and logged. And the two invariants that matter most: every request is a GET,
 * and the token appears in exactly one header and in no log line.
 */
import { describe, expect, it } from 'vitest';

import {
  GHL_TOKEN_REJECTED_MESSAGE,
  createGhlClient,
  type GhlClient,
} from '../../../../src/lib/crm/ghl/client.js';
import type { GhlConfig } from '../../../../src/lib/crm/ghl/config.js';
import { capturingLogger, httpFor, scriptedFetch, type Step } from '../../llm/helpers.js';
import {
  FAKE_GHL_TOKEN,
  FINANCE_PIPELINE_ID,
  LOCATION_ID,
  ghlConfig,
  ghlFixture,
  must,
} from './helpers.js';

function client(
  steps: readonly Step[],
  overrides: Partial<GhlConfig> = {},
): {
  client: GhlClient;
  calls: { url: string; init: RequestInit }[];
  lines: string[];
  sleeps: number[];
} {
  const { log, lines } = capturingLogger();
  const fetch = scriptedFetch(steps);
  const config = ghlConfig(overrides);
  const http = httpFor(fetch.fetch, log, config.timeoutMs);
  const sleeps: number[] = [];
  const c = createGhlClient({
    config,
    http,
    log,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { client: c, calls: fetch.calls, lines, sleeps };
}

const okStep = (fixture: string, headers: Record<string, string> = {}): Step => ({
  kind: 'status',
  status: 200,
  body: ghlFixture(fixture),
  headers,
});

describe('every request', () => {
  it('is a GET with the token in exactly one header, the Version header, and a pipeline-scoped URL', async () => {
    const c = client([
      okStep('pipelines'),
      okStep('opportunities-all'),
      okStep('contact-1'),
      okStep('custom-fields-clean'),
    ]);
    await c.client.getPipelines();
    await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    await c.client.getContact('CONTACT000000000001');
    await c.client.getCustomFields();
    expect(c.calls).toHaveLength(4);
    for (const call of c.calls) {
      expect(call.init.method).toBe('GET');
      const headers = call.init.headers as Record<string, string>;
      expect(headers['authorization']).toBe(`Bearer ${FAKE_GHL_TOKEN}`);
      expect(headers['version']).toBe('2021-07-28');
      expect(call.init.body).toBeUndefined();
      expect(call.url).not.toContain(FAKE_GHL_TOKEN);
    }
    const search = new URL(must(c.calls[1]).url);
    expect(search.pathname).toBe('/opportunities/search');
    expect(search.searchParams.get('location_id')).toBe(LOCATION_ID);
    expect(search.searchParams.get('pipeline_id')).toBe(FINANCE_PIPELINE_ID);
    expect(search.searchParams.get('limit')).toBe('100');
    expect(new URL(must(c.calls[0]).url).searchParams.get('locationId')).toBe(LOCATION_ID);
    expect(new URL(must(c.calls[3]).url).pathname).toBe(`/locations/${LOCATION_ID}/customFields`);
    expect(c.client.requestsMade()).toBe(4);
  });

  it('never lets the token into a log line, even at debug level', async () => {
    const c = client([
      okStep('pipelines'),
      { kind: 'status', status: 401, body: ghlFixture('error-401') },
    ]);
    await c.client.getPipelines();
    await c.client.getPipelines();
    expect(c.lines.length).toBeGreaterThan(0);
    for (const line of c.lines) expect(line).not.toContain(FAKE_GHL_TOKEN);
  });
});

describe('pipelines', () => {
  it('parses the list and keeps stage names verbatim for display only', async () => {
    const c = client([okStep('pipelines')]);
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((p) => p.id)).toEqual(['civcWG1oOY8u5g2dGcdM', FINANCE_PIPELINE_ID]);
    expect(result.value[0]?.stages[1]?.name).toBe('Contacted ');
    expect(result.value[1]?.stages).toHaveLength(10);
  });

  it('rejects an envelope of the wrong shape with a VALIDATION error and reads nothing', async () => {
    const c = client([{ kind: 'status', status: 200, body: '{"pipelines": "nope"}' }]);
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(c.lines.some((l) => l.includes('did not match the expected shape'))).toBe(true);
  });

  it('a body that is not JSON is a VALIDATION error', async () => {
    const c = client([{ kind: 'status', status: 200, body: '<html>maintenance</html>' }]);
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
  });
});

describe('opportunities — pagination', () => {
  it('follows the startAfterId / startAfter cursor across pages until a short page', async () => {
    const c = client(
      [
        okStep('opportunities-page-1'),
        okStep('opportunities-page-2'),
        okStep('opportunities-page-3-empty'),
      ],
      { pageSize: 2 },
    );
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.opportunities.map((o) => o.id)).toEqual([
      'OPP0000000000000001',
      'OPP0000000000000002',
      'OPP0000000000000003',
      'OPP0000000000000004',
    ]);
    expect(result.value.pages).toBe(3);
    expect(result.value.total).toBe(4);
    expect(result.value.rejected).toEqual([]);
    expect(c.calls).toHaveLength(3);
    const second = new URL(must(c.calls[1]).url).searchParams;
    expect(second.get('startAfterId')).toBe('OPP0000000000000002');
    expect(second.get('startAfter')).toBe('1789030099030');
    expect(new URL(must(c.calls[0]).url).searchParams.has('startAfterId')).toBe(false);
  });

  it('a single short page ends the read in one request — the live last-page shape (nextPage "")', async () => {
    const c = client([okStep('opportunities-all')]);
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok && result.value.opportunities.length).toBe(4);
    expect(c.calls).toHaveLength(1);
  });

  it('an empty pipeline is a valid state: zero opportunities, no error', async () => {
    const c = client([okStep('opportunities-empty')]);
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ opportunities: [], pages: 1, total: 0, rejected: [] });
  });

  it('refuses to truncate: hitting the page cap fails the read with a LIMIT reason', async () => {
    const c = client([okStep('opportunities-page-1'), okStep('opportunities-page-2')], {
      pageSize: 2,
      maxPages: 1,
    });
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context['reason']).toBe('LIMIT');
    expect(c.calls).toHaveLength(1);
  });

  it('stops when the cursor does not advance instead of looping forever', async () => {
    const c = client([okStep('opportunities-page-1'), okStep('opportunities-page-1')], {
      pageSize: 2,
    });
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(c.calls).toHaveLength(2);
    expect(result.value.opportunities).toHaveLength(2);
    expect(c.lines.some((l) => l.includes('cursor did not advance'))).toBe(true);
  });
});

describe('opportunities — shape', () => {
  it('rejects one bad record, one from another pipeline and one without an id, keeps the good one, logs ids only', async () => {
    const c = client([okStep('opportunities-bad-records')]);
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.opportunities.map((o) => o.id)).toEqual(['OPP0000000000000001']);
    expect(result.value.rejected).toEqual([
      { id: 'OPP0000000000000001', reason: 'shape' },
      { id: 'OPPOTHERPIPELINE0001', reason: 'wrong_pipeline' },
      { id: null, reason: 'shape' },
    ]);
    const warnings = c.lines.filter((l) => l.includes('opportunity rejected'));
    expect(warnings).toHaveLength(3);
    for (const line of warnings) expect(line).not.toContain('Alex Tran');
  });

  it('a malformed page envelope aborts the read', async () => {
    const c = client([okStep('opportunities-bad-envelope')]);
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
  });
});

describe('the API failing', () => {
  it('401 surfaces as UNAUTHENTICATED with the loud message, logged at error level with an alert marker', async () => {
    const c = client([{ kind: 'status', status: 401, body: ghlFixture('error-401') }]);
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNAUTHENTICATED');
    expect(result.error.message).toBe(GHL_TOKEN_REJECTED_MESSAGE);
    expect(result.error.message).toContain('NOT an empty pipeline');
    const errorLine = c.lines.find(
      (l) => l.includes('"level":"error"') && l.includes('ghl_token_rejected'),
    );
    expect(errorLine).toBeDefined();
    expect(c.calls).toHaveLength(1);
  });

  it('403 surfaces as FORBIDDEN (scope or location)', async () => {
    const c = client([{ kind: 'status', status: 403, body: ghlFixture('error-403') }]);
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('FORBIDDEN');
  });

  it('429 is retried with backoff (Retry-After honoured) and succeeds', async () => {
    const c = client(
      [
        {
          kind: 'status',
          status: 429,
          body: ghlFixture('error-429'),
          headers: { 'retry-after': '1' },
        },
        okStep('pipelines'),
      ],
      { retries: 2 },
    );
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(true);
    expect(c.calls).toHaveLength(2);
    expect(c.client.requestsMade()).toBe(2);
  });

  it('429 beyond the retry cap is RATE_LIMITED and stops', async () => {
    const step: Step = {
      kind: 'status',
      status: 429,
      body: ghlFixture('error-429'),
      headers: { 'retry-after': '3' },
    };
    const c = client([step, step, step, step], { retries: 2 });
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RATE_LIMITED');
    expect(result.error.context['retryAfterMs']).toBe(3000);
    expect(c.calls).toHaveLength(3);
    expect(c.client.requestsMade()).toBe(3);
  });

  it('5xx is retried, then abandoned cleanly as HTTP_STATUS', async () => {
    const step: Step = { kind: 'status', status: 500, body: ghlFixture('error-500') };
    const c = client([step, step, step], { retries: 1 });
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(result.error.context['status']).toBe(500);
    expect(c.calls).toHaveLength(2);
  });

  it('a hanging request times out as TIMEOUT', async () => {
    const c = client([{ kind: 'hang' }], { timeoutMs: 50 });
    const result = await c.client.getPipelines();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
  });

  it('a transport failure mid-page fails the whole read, never a half page', async () => {
    const c = client(
      [okStep('opportunities-page-1'), { kind: 'throw', error: new TypeError('reset') }],
      {
        pageSize: 2,
      },
    );
    const result = await c.client.listOpportunities(FINANCE_PIPELINE_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NETWORK');
  });

  it('paces itself when GHL says the window is nearly spent', async () => {
    const c = client([
      okStep('pipelines', {
        'x-ratelimit-remaining': '3',
        'x-ratelimit-interval-milliseconds': '10000',
      }),
      okStep('pipelines', {
        'x-ratelimit-remaining': '80',
        'x-ratelimit-interval-milliseconds': '10000',
      }),
    ]);
    await c.client.getPipelines();
    await c.client.getPipelines();
    expect(c.sleeps).toEqual([10000]);
  });
});

describe('contacts', () => {
  it('returns the contact, and null on 404', async () => {
    const c = client([
      okStep('contact-1'),
      { kind: 'status', status: 404, body: ghlFixture('contact-not-found') },
    ]);
    const found = await c.client.getContact('CONTACT000000000001');
    expect(found.ok && found.value?.id).toBe('CONTACT000000000001');
    expect(new URL(must(c.calls[0]).url).pathname).toBe('/contacts/CONTACT000000000001');
    const missing = await c.client.getContact('CONTACT0000000000GONE');
    expect(missing.ok && missing.value).toBeNull();
  });

  it('rejects a contact whose custom field holds an object, with a VALIDATION error naming the id only', async () => {
    const c = client([okStep('contact-bad-shape')]);
    const result = await c.client.getContact('CONTACTBADSHAPE0001');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    const line = c.lines.find((l) => l.includes('contact rejected'));
    expect(line).toContain('CONTACTBADSHAPE0001');
    expect(line).not.toContain('bad.synthetic@example.com');
  });
});

describe('custom field definitions', () => {
  it('parses definitions and rejects the one with no data type', async () => {
    const c = client([okStep('custom-fields')]);
    const result = await c.client.getCustomFields();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.definitions).toHaveLength(14);
    expect(result.value.rejected).toEqual([{ id: 'BROKENFIELD000000001', reason: 'shape' }]);
    expect(
      result.value.definitions.find((d) => d.id === 'Vpn7DLqHwMoQ91AJUjzu')?.picklistOptions,
    ).toContain('Refinance');
  });
});
