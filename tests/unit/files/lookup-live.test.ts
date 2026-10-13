/**
 * THE LOOKUP TEST (13 Oct 2026, D100): what the real model said when the broker asked a plain
 * question about a rate on a page he supplied.
 *
 * The bug: the reply answered, then told him it could not give personal credit advice and
 * that he should book a Discovery Session with Ross. He is Ross. The replies under "before"
 * below are the live model's own, word for word, from the rules as they shipped on 12 Oct;
 * `judgeLookup` fails every one of them, which is the regression this file exists for.
 *
 * The recordings (tests/fixtures/files/lookups/, made by `npm run files -- record`) are held
 * to three things on every run, with no network:
 *
 *   1. not vacuous — the fixture, read today, contains the figure the question asks for;
 *   2. not stale — the request the code builds TODAY is byte-for-byte the one recorded, so a
 *      change to the rules, the wrapper or the voice prefix fails here until re-recorded;
 *   3. a lookup was answered with no lecture, and a judgement (which lender, how much can
 *      they borrow) was still declined. The second half is the boundary the fix must not
 *      take with it.
 *
 * A recording is what the model did on the day with the request still being built. It is
 * not a promise about every future reply.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  LOOKUP_PROBES,
  RECORDED_PROBE,
  judgeLookup,
  lookupRequest,
  requestFingerprintSource,
  toTurnFile,
  type LookupProbe,
  type RecordedProbe,
} from '../../../src/lib/files/probe.js';
import { DOCUMENT_RULES, DOCUMENT_RULES_VERSION } from '../../../src/lib/files/rules.js';
import { sanitiseTitle } from '../../../src/lib/files/text.js';
import type { CompletionRequest } from '../../../src/lib/llm/client.js';
import { extractFile } from '../../../web/src/lib/files/extract.js';
import { FIXTURES, accepted, fixtureBytes, nodeEngines } from '../web/filesHelpers.js';

const LOOKUPS = join(FIXTURES, 'lookups');
const WEB = join(FIXTURES, '..', 'web');
const RERECORD = 'Record the probes again: npm run files -- record';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function requestToday(probe: LookupProbe): Promise<CompletionRequest> {
  const fromLink = probe.page !== undefined;
  const extraction = accepted(
    await extractFile(
      fromLink
        ? {
            name: probe.file,
            bytes: new Uint8Array(readFileSync(join(WEB, probe.file))),
            fromLink: true,
            contentType: 'text/html',
          }
        : { name: probe.file, bytes: fixtureBytes(probe.file) },
      nodeEngines(),
    ),
  );
  const file = toTurnFile({
    name: probe.file,
    kind: extraction.kind,
    pages: extraction.pages,
    vision: extraction.vision,
  });
  const title =
    probe.page !== undefined && extraction.kind === 'html'
      ? sanitiseTitle(extraction.title, probe.page.host)
      : probe.file;
  extraction.dispose();
  if (file === null) throw new Error(`${probe.file} has pages that need to be read as images`);
  return lookupRequest(file, probe, title).request;
}

function recording(probe: LookupProbe): RecordedProbe {
  const path = join(LOOKUPS, `${probe.id}.json`);
  expect(existsSync(path), `${path} is missing. ${RERECORD}`).toBe(true);
  return RECORDED_PROBE.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * BEFORE (tests/fixtures/files/lookup-before.json). The live model's whole replies, word for
 * word, to plain rate questions about the same page, with the document rules at 2026-10-12.3.
 */
const BEFORE = z
  .object({
    rulesVersion: z.literal('2026-10-12.3'),
    replies: z.array(z.object({ question: z.string().min(1), reply: z.string().min(1) })).min(3),
  })
  .parse(JSON.parse(readFileSync(join(FIXTURES, 'lookup-before.json'), 'utf8')));

describe('before: the paragraph the client objected to', () => {
  it.each(BEFORE.replies)('"$question" was answered, and then lectured the broker', (before) => {
    const verdict = judgeLookup(before.reply, { kind: 'lookup', mustMention: [] });
    expect(verdict.lectured).toBe(true);
    expect(verdict.reasons.length).toBeGreaterThan(0);
    // Each of them sends the broker to the broker, in one wording or another.
    expect(before.reply).toMatch(/Ross|Discovery Session/);
  });

  it('the rules no longer carry the line that invited it, and say who is asking', () => {
    expect(DOCUMENT_RULES).not.toContain('Reading a document is not advice');
    expect(DOCUMENT_RULES).toContain('The person asking is Ross or one of his team');
    expect(DOCUMENT_RULES).toContain('It is never a borrower and never a member of the public');
    expect(DOCUMENT_RULES).toContain('Answer a lookup and stop');
  });
});

describe.each(LOOKUP_PROBES)('a question about a document the broker supplied: $id', (probe) => {
  it('the fixture really contains what the question asks for', async () => {
    const text = requestFingerprintSource(await requestToday(probe));
    for (const needle of probe.mustMention) expect(text, needle).toContain(needle);
    // A page carries its site and read time; an uploaded file carries neither.
    expect(text.includes('# Pages read from a link')).toBe(probe.page !== undefined);
  });

  it('the recording is of the request this code sends today', async () => {
    const recorded = recording(probe);
    expect(recorded).toMatchObject({ id: probe.id, file: probe.file, question: probe.question });
    expect(recorded.rulesVersion, RERECORD).toBe(DOCUMENT_RULES_VERSION);
    expect(sha256(requestFingerprintSource(await requestToday(probe))), RERECORD).toBe(
      recorded.requestSha256,
    );
  });

  it(
    probe.kind === 'lookup'
      ? 'the model answered from the document and left it there'
      : 'the model still declined to make the call, and did not make it anyway',
    () => {
      const recorded = recording(probe);
      expect(recorded.stopReason).toBe('end_turn');
      expect(recorded.reply.trim().length).toBeGreaterThan(20);
      expect(judgeLookup(recorded.reply, probe)).toEqual({
        answered: true,
        lectured: false,
        decided: false,
        reasons: [],
      });
    },
  );

  it('the same check fails on a reply that gets it wrong — it can tell the difference', () => {
    const recorded = recording(probe);
    if (probe.kind === 'lookup') {
      const lectured = judgeLookup(
        `${recorded.reply}\n\nThis is general information, not personal credit advice. Book a Discovery Session with Ross.`,
        probe,
      );
      expect(lectured.lectured).toBe(true);
      expect(judgeLookup('I can only help with marketing copy.', probe).answered).toBe(false);
    } else {
      expect(
        judgeLookup(`${recorded.reply} On those numbers they could borrow around $540,000.`, probe)
          .decided,
      ).toBe(true);
      expect(judgeLookup('Yes, go with this lender. The rates are sharp.', probe).decided).toBe(
        true,
      );
    }
  });
});

describe('the lookup recordings as a set', () => {
  it('there is one recording per probe, and nothing else', () => {
    expect(readdirSync(LOOKUPS).sort()).toEqual(
      LOOKUP_PROBES.map((probe) => `${probe.id}.json`).sort(),
    );
  });

  it('both halves are on record: lookups, and the judgements that must still be declined', () => {
    expect(new Set(LOOKUP_PROBES.map((probe) => probe.id)).size).toBe(LOOKUP_PROBES.length);
    expect(LOOKUP_PROBES.filter((probe) => probe.kind === 'lookup').length).toBeGreaterThanOrEqual(
      3,
    );
    expect(
      LOOKUP_PROBES.filter((probe) => probe.kind === 'judgement').length,
    ).toBeGreaterThanOrEqual(2);
    // The complaint was about a page; the same rules are sent for an uploaded file.
    expect(LOOKUP_PROBES.some((probe) => probe.page !== undefined)).toBe(true);
    expect(LOOKUP_PROBES.some((probe) => probe.page === undefined)).toBe(true);
    for (const probe of LOOKUP_PROBES) {
      expect(probe.mustMention.length > 0, probe.id).toBe(probe.kind === 'lookup');
    }
  });

  it('nothing recorded holds a key, and every recording says which model and what it cost', () => {
    for (const name of readdirSync(LOOKUPS)) {
      const raw = readFileSync(join(LOOKUPS, name), 'utf8');
      expect(raw, name).not.toMatch(/sk-ant-[A-Za-z0-9_-]{8,}/);
      const recorded = RECORDED_PROBE.parse(JSON.parse(raw));
      expect(recorded.model, name).toMatch(/^claude-/);
      expect(recorded.costUsd, name).toBeGreaterThan(0);
    }
  });
});
