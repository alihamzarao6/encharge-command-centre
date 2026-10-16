/**
 * Fixed decision 8, measured live, before and after (Milestone 5 part 5) — the method the
 * credit-advice fix used (D100): the same questions to the real model, several times each, every
 * reply judged in code, the replies kept word for word.
 *
 *   BEFORE (tests/fixtures/knowledge/why-before.json) — the code on `main`: its document rules
 *   (2026-10-14.1) and its word-matched excerpt at the 24,000 characters a file got with two
 *   attached. The first turn showed 4 of 33 pages, as the client saw.
 *   AFTER (tests/fixtures/knowledge/why-after.json) — this code: today's rules, the document
 *   learned and searched by meaning, `npm run knowledge -- why`.
 *
 * Both were run on a STAND-IN transcript (33 pages, invented content) — the client's own file was
 * not available to this build; the questions about it are reconstructions of what he asked, not
 * his words. The judge is re-applied here, so tightening it re-judges both recordings.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DOCUMENT_RULES_VERSION } from '../../../src/lib/files/rules.js';
import { judgeCoverageExplanation } from '../../../src/lib/knowledge/probe.js';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'knowledge');

const RECORD = z.object({
  rulesVersion: z.string(),
  document: z.looseObject({ pages: z.number(), chars: z.number() }),
  firstQuestion: z.string(),
  firstReply: z.string(),
  runs: z.array(z.looseObject({ question: z.string(), reply: z.string() })).min(1),
});

function load(name: string): z.infer<typeof RECORD> {
  const path = join(DIR, name);
  expect(existsSync(path), `${path} is missing; record it with npm run knowledge -- why`).toBe(
    true,
  );
  return RECORD.parse(JSON.parse(readFileSync(path, 'utf8')));
}

describe('why it did not see everything — before and after', () => {
  it('BEFORE: the old code invented a cause or a fix in the replies to the same questions', () => {
    const before = load('why-before.json');
    expect(before.rulesVersion).toBe('2026-10-14.1');
    const invented = before.runs.filter((run) => judgeCoverageExplanation(run.reply).invented);
    expect(invented.length).toBeGreaterThan(0);
  });

  it('AFTER: the same questions, today’s rules — no reply invents a cause, blames anyone, names a setting or asks for the file again', () => {
    const after = load('why-after.json');
    expect(after.rulesVersion).toBe(DOCUMENT_RULES_VERSION);
    expect(after.runs.length).toBe(load('why-before.json').runs.length);
    for (const run of after.runs) {
      const verdict = judgeCoverageExplanation(run.reply);
      expect(
        verdict.reasons.filter((r) => r !== 'does not give the real reason'),
        run.reply,
      ).toEqual([]);
    }
    // And most give the real reason, in words the judge recognises.
    const trueReason = after.runs.filter(
      (run) => judgeCoverageExplanation(run.reply).trueReason,
    ).length;
    expect(trueReason).toBeGreaterThanOrEqual(Math.ceil(after.runs.length * 0.75));
  });
});
