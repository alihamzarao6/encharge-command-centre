/**
 * The GoHighLevel write client (src/lib/crm/ghl/write.ts) against scripted fetches and the
 * responses recorded from the live probe of 24 Sep 2026 (tests/fixtures/ghl/write-*.json,
 * all from a test contact and opportunity created for the purpose).
 *
 * What is proven, per the Part C list:
 *   - a stage write is ONE request (rule 8): a 5xx, a timeout and a dropped connection each
 *     produce exactly one PUT and a typed error — nothing is sent again;
 *   - 429 is the one exception: waited out (Retry-After, capped) and retried, with a cap;
 *   - every PUT carries the CONFIGURED pipeline id and the stage id, nothing else;
 *   - 401 is loud and unambiguous; 400 OPPORTUNITY_STAGE_ID_INVALID (even truncated to the
 *     500-character snippet http.ts keeps) and 404 are typed refusals;
 *   - a 2xx of the wrong shape is a VALIDATION error, never a half-parsed value;
 *   - the `contact` sub-object GoHighLevel returns (a name and an email) never reaches the
 *     result or a log line; the token appears in exactly one header and in no log line;
 *   - the rate-limit floor pauses the next request as the read client does.
 */
import { describe, expect, it } from 'vitest';

import { createHttpClient, type FetchLike, type HttpClient } from '../../../../src/lib/http.js';
import type { Logger } from '../../../../src/lib/logger.js';
import { GHL_TOKEN_REJECTED_MESSAGE } from '../../../../src/lib/crm/ghl/client.js';
import type { GhlConfig } from '../../../../src/lib/crm/ghl/config.js';
import {
  GhlWriteRefusedError,
  WRITE_RATE_LIMIT_RETRIES,
  createGhlWriteClient,
  isStageInvalid,
  readGhlErrorCode,
  type GhlWriteClient,
} from '../../../../src/lib/crm/ghl/write.js';
import { capturingLogger, scriptedFetch, type Step } from '../../llm/helpers.js';
import { FAKE_GHL_TOKEN, FINANCE_PIPELINE_ID, ghlConfig, ghlFixture, must } from './helpers.js';

const OPP = 'bxsEZfR8ghLL19YAL31t';
const CONTACT = 'Kglw9sSb0SI8tg1Lukh7';
const NEW_LEAD = '51c98561-cd26-49a9-a001-97536c31dd0a';
const CONTACTED = 'f2393065-3038-4fba-bdf1-8c39b7b18183';

function httpFor(fetch: FetchLike, log: Logger): HttpClient {
  return createHttpClient({
    fetch,
    logger: log,
    timeoutMs: 50,
    retries: 3,
    sleep: () => Promise.resolve(),
    breaker: { failureThreshold: 100 },
  });
}

function client(
  steps: readonly Step[],
  overrides: Partial<GhlConfig> = {},
): {
  client: GhlWriteClient;
  calls: { url: string; init: RequestInit }[];
  lines: string[];
  sleeps: number[];
} {
  const { log, lines } = capturingLogger();
  const fetch = scriptedFetch(steps);
  const config = ghlConfig({ timeoutMs: 50, ...overrides });
  const sleeps: number[] = [];
  const c = createGhlWriteClient({
    config,
    http: httpFor(fetch.fetch, log),
    log,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => 0,
  });
  return { client: c, calls: fetch.calls, lines, sleeps };
}

/** The request body as text; a body of another shape is a test failure. */
function bodyOf(call: { init: RequestInit }): string {
  const body = call.init.body;
  if (typeof body !== 'string') throw new Error('expected a string body');
  return body;
}

const okStep = (fixture: string, status = 200, headers: Record<string, string> = {}): Step => ({
  kind: 'status',
  status,
  body: ghlFixture(fixture),
  headers,
});

const errorStep = (
  fixture: string,
  status: number,
  headers: Record<string, string> = {},
): Step => ({
  kind: 'status',
  status,
  body: ghlFixture(fixture),
  headers,
});

describe('getOpportunity', () => {
  it('is a GET with the token in one header, and answers the live record without the contact', async () => {
    const c = client([okStep('write-opportunity-get')]);
    const got = await c.client.getOpportunity(OPP);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.id).toBe(OPP);
    expect(got.value?.pipelineStageId).toBe(NEW_LEAD);
    expect(got.value?.contactId).toBe(CONTACT);
    expect(JSON.stringify(got.value)).not.toContain('example.com');
    expect(JSON.stringify(got.value)).not.toContain('"contact"');
    const call = must(c.calls[0]);
    expect(call.init.method).toBe('GET');
    expect(call.url).toBe(`https://ghl.test/opportunities/${OPP}`);
    const headers = call.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${FAKE_GHL_TOKEN}`);
    expect(headers['version']).toBe('2021-07-28');
    expect(c.lines.join('\n')).not.toContain(FAKE_GHL_TOKEN);
    expect(c.lines.join('\n')).not.toContain('example.com');
  });

  it('answers null on 404 — deleted since the mirror last saw it', async () => {
    const c = client([errorStep('write-error-opportunity-not-found', 404)]);
    const got = await c.client.getOpportunity('zzzzzzzzzzzzzzzzzzzz');
    expect(got).toEqual({ ok: true, value: null });
  });

  it('401 is loud and unambiguous', async () => {
    const c = client([errorStep('error-401', 401)]);
    const got = await c.client.getOpportunity(OPP);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('UNAUTHENTICATED');
    expect(got.error.message).toBe(GHL_TOKEN_REJECTED_MESSAGE);
    expect(c.lines.some((l) => l.includes('ghl_token_rejected'))).toBe(true);
  });

  it('a 2xx of the wrong shape is a VALIDATION error, never a value', async () => {
    const c = client([{ kind: 'status', status: 200, body: '{"opportunity":{"id":"x"}}' }]);
    const got = await c.client.getOpportunity('x');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe('VALIDATION');
  });
});

describe('updateStage', () => {
  it('is ONE PUT carrying the configured pipeline id and the stage id, and answers the moved record', async () => {
    const c = client([okStep('write-opportunity-moved')]);
    const moved = await c.client.updateStage(OPP, CONTACTED);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.opportunity.pipelineStageId).toBe(CONTACTED);
    expect(moved.value.status).toBe(200);
    expect(moved.value.attempts).toBe(1);
    expect(c.calls).toHaveLength(1);
    const call = must(c.calls[0]);
    expect(call.init.method).toBe('PUT');
    expect(call.url).toBe(`https://ghl.test/opportunities/${OPP}`);
    expect(JSON.parse(bodyOf(call))).toEqual({
      pipelineId: FINANCE_PIPELINE_ID,
      pipelineStageId: CONTACTED,
    });
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.stringify(moved.value)).not.toContain('example.com');
    expect(c.lines.join('\n')).not.toContain('example.com');
  });

  it('a 5xx is one request and a typed error — the write is never sent again', async () => {
    const c = client([errorStep('error-500', 500), okStep('write-opportunity-moved')]);
    const moved = await c.client.updateStage(OPP, CONTACTED);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe('HTTP_STATUS');
    expect(moved.error.context['status']).toBe(500);
    expect(c.calls).toHaveLength(1);
  });

  it('a timeout is one request and TIMEOUT', async () => {
    const c = client([{ kind: 'hang' }, okStep('write-opportunity-moved')]);
    const moved = await c.client.updateStage(OPP, CONTACTED);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe('TIMEOUT');
    expect(c.calls).toHaveLength(1);
  });

  it('a dropped connection is one request and NETWORK', async () => {
    const c = client([{ kind: 'throw', error: new TypeError('fetch failed') }]);
    const moved = await c.client.updateStage(OPP, CONTACTED);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error.code).toBe('NETWORK');
    expect(c.calls).toHaveLength(1);
  });

  it('429 is waited out on Retry-After and retried; the cap holds', async () => {
    const c = client([
      errorStep('error-429', 429, { 'retry-after': '2' }),
      okStep('write-opportunity-moved'),
    ]);
    const moved = await c.client.updateStage(OPP, CONTACTED);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.attempts).toBe(2);
    expect(c.calls).toHaveLength(2);
    expect(c.sleeps).toEqual([2_000]);

    const capped = client(
      Array.from({ length: WRITE_RATE_LIMIT_RETRIES + 2 }, () =>
        errorStep('error-429', 429, { 'retry-after': '60' }),
      ),
    );
    const refused = await capped.client.updateStage(OPP, CONTACTED);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('RATE_LIMITED');
    expect(capped.calls).toHaveLength(WRITE_RATE_LIMIT_RETRIES + 1);
    // Retry-After 60 s is capped to the write's maximum wait.
    expect(capped.sleeps.every((ms) => ms <= 12_000)).toBe(true);
  });

  it('400 OPPORTUNITY_STAGE_ID_INVALID is a typed refusal, read from the truncated snippet', async () => {
    const c = client([errorStep('write-error-stage-invalid', 400)]);
    const moved = await c.client.updateStage(OPP, '00000000-0000-4000-8000-000000000000');
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error).toBeInstanceOf(GhlWriteRefusedError);
    expect((moved.error as GhlWriteRefusedError).reason).toBe('STAGE_INVALID');
    expect(moved.error.retryable).toBe(false);
  });

  it('404 is a typed OPPORTUNITY_NOT_FOUND refusal', async () => {
    const c = client([errorStep('write-error-opportunity-not-found', 404)]);
    const moved = await c.client.updateStage('zzzzzzzzzzzzzzzzzzzz', CONTACTED);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error).toBeInstanceOf(GhlWriteRefusedError);
    expect((moved.error as GhlWriteRefusedError).reason).toBe('OPPORTUNITY_NOT_FOUND');
  });

  it('401 and 403 on a write are typed the same way as on a read', async () => {
    const a = client([errorStep('error-401', 401)]);
    const unauth = await a.client.updateStage(OPP, CONTACTED);
    expect(!unauth.ok && unauth.error.code).toBe('UNAUTHENTICATED');
    const b = client([errorStep('error-403', 403)]);
    const forbidden = await b.client.updateStage(OPP, CONTACTED);
    expect(!forbidden.ok && forbidden.error.code).toBe('FORBIDDEN');
  });

  it('a 2xx with a body of the wrong shape is VALIDATION', async () => {
    const c = client([{ kind: 'status', status: 200, body: '{"ok":true}' }]);
    const moved = await c.client.updateStage(OPP, CONTACTED);
    expect(!moved.ok && moved.error.code).toBe('VALIDATION');
  });

  it('pauses for the window when the remaining count reaches the floor', async () => {
    const c = client([
      okStep('write-opportunity-moved', 200, {
        'x-ratelimit-remaining': '5',
        'x-ratelimit-interval-milliseconds': '10000',
      }),
    ]);
    await c.client.updateStage(OPP, CONTACTED);
    expect(c.sleeps).toEqual([10_000]);
  });
});

describe('createNote', () => {
  it('is ONE POST with the body, and answers the note as GoHighLevel created it', async () => {
    const c = client([okStep('write-note-created', 201)]);
    const note = await c.client.createNote(CONTACT, '[Fundd app test] Note one');
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    expect(note.value.id).toBe('DSgfTTv3iy3MZeJq0HH0');
    expect(note.value.dateAdded).toBe('2026-09-24T00:57:37.099Z');
    expect(note.value.contactId).toBe(CONTACT);
    const call = must(c.calls[0]);
    expect(call.init.method).toBe('POST');
    expect(call.url).toBe(`https://ghl.test/contacts/${CONTACT}/notes`);
    expect(JSON.parse(bodyOf(call))).toEqual({ body: '[Fundd app test] Note one' });
    expect(c.calls).toHaveLength(1);
  });

  it('422 is NOTE_REJECTED and a 400 "not found" is CONTACT_NOT_FOUND', async () => {
    const a = client([errorStep('write-error-note-empty', 422)]);
    const empty = await a.client.createNote(CONTACT, '');
    expect(!empty.ok && (empty.error as GhlWriteRefusedError).reason).toBe('NOTE_REJECTED');
    const b = client([errorStep('write-error-note-contact', 400)]);
    const gone = await b.client.createNote('zzzzzzzzzzzzzzzzzzzz', 'hello');
    expect(!gone.ok && (gone.error as GhlWriteRefusedError).reason).toBe('CONTACT_NOT_FOUND');
  });

  it('a timeout on a note is one request and TIMEOUT — never re-posted', async () => {
    const c = client([{ kind: 'hang' }, okStep('write-note-created', 201)]);
    const note = await c.client.createNote(CONTACT, 'hello');
    expect(!note.ok && note.error.code).toBe('TIMEOUT');
    expect(c.calls).toHaveLength(1);
  });
});

describe('readGhlErrorCode', () => {
  it('reads code and error from whole and truncated bodies', () => {
    const whole = ghlFixture('write-error-opportunity-not-found');
    expect(readGhlErrorCode(whole)).toEqual({ code: 'OPPORTUNITY_NOT_FOUND', error: 'Not Found' });
    const truncated = ghlFixture('write-error-stage-invalid').slice(0, 500);
    expect(readGhlErrorCode(truncated).error).toBe('Bad Request');
    // The stage list pushes `code` past 500 characters in the real body; the pattern still
    // finds it when the snippet happens to hold it, and the caller matches on 400 + code.
    const withCode = '{"statusCode":400,"message":"x","code":"OPPORTUNITY_STAGE_ID_INVALID","arg';
    expect(readGhlErrorCode(withCode).code).toBe('OPPORTUNITY_STAGE_ID_INVALID');
    expect(readGhlErrorCode('not json')).toEqual({ code: null, error: null });
  });

  it('recognises the stage refusal whole, truncated inside the code, and by its message alone', () => {
    const whole = ghlFixture('write-error-stage-invalid');
    expect(isStageInvalid(400, whole)).toBe(true);
    expect(isStageInvalid(400, whole.slice(0, 500))).toBe(true);
    expect(isStageInvalid(400, '{"code":"OPPORTUNITY_STAGE')).toBe(true);
    expect(isStageInvalid(400, '{"message":"stageId must be one of the following values: a"')).toBe(
      true,
    );
    expect(isStageInvalid(500, whole)).toBe(false);
    expect(isStageInvalid(400, '{"code":"SOMETHING_ELSE"}')).toBe(false);
  });
});
