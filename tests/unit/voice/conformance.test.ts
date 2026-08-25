/**
 * Voice conformance suite (PHASE-ACCEPTANCE.md Stage 2 item 8): ≥ 20 fixed prompts whose
 * RECORDED responses are checked by code. No network — CI runs this on every push. The
 * same prompts are re-run live with `npm run voice -- record`, which is the on-demand mode;
 * CI stays on fixtures because a live call is money, non-determinism and a dependency on
 * Anthropic being up, none of which belongs in a gate.
 *
 * A fixture recorded against a different prompt version is a failure, not a skip: the suite
 * proves the deployed prompt, or it proves nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALL_CHECK_IDS, runChecks, type VoicePrompt } from '../../../src/lib/voice/conformance.js';
import {
  parsePromptFile,
  parseRecordedResponse,
  type RecordedResponse,
} from '../../../src/lib/voice/fixtures.js';
import { VOICE_PROMPT_VERSION, voicePromptHash } from '../../../src/lib/voice/prompt.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'voice');

function loadPrompts(): readonly VoicePrompt[] {
  const parsed = parsePromptFile(JSON.parse(readFileSync(join(FIXTURES, 'prompts.json'), 'utf8')));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function loadResponses(): ReadonlyMap<string, RecordedResponse> {
  const dir = join(FIXTURES, 'responses');
  const map = new Map<string, RecordedResponse>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const parsed = parseRecordedResponse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    if (!parsed.ok) throw parsed.error;
    map.set(parsed.value.promptId, parsed.value);
  }
  return map;
}

const prompts = loadPrompts();
const responses = loadResponses();

describe('fixture set', () => {
  it('has at least 20 prompts and a recorded response for each', () => {
    expect(prompts.length).toBeGreaterThanOrEqual(20);
    for (const prompt of prompts) {
      expect(responses.has(prompt.id), `no recorded response for ${prompt.id}`).toBe(true);
    }
  });

  it('covers every format and every check at least once', () => {
    const formats = new Set(prompts.map((p) => p.format));
    expect([...formats].sort()).toEqual(
      [
        'chat',
        'facebook_post',
        'google_ad',
        'lead_reply',
        'meta_ad',
        'positioning',
        'refusal',
      ].sort(),
    );
    const used = new Set(prompts.flatMap((p) => p.checks));
    const unused = ALL_CHECK_IDS.filter((id) => !used.has(id));
    expect(unused, 'checks no prompt exercises').toEqual([]);
  });

  it('every response was recorded against the current prompt version and hash', () => {
    for (const [id, response] of responses) {
      expect(
        `${response.promptVersion}@${response.promptHash}`,
        `${id} was recorded against a different prompt — re-record with npm run voice -- record`,
      ).toBe(`${VOICE_PROMPT_VERSION}@${voicePromptHash()}`);
      expect(response.stopReason).toBe('end_turn');
      expect(response.text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('conformance — every check on every recorded response', () => {
  for (const prompt of prompts) {
    const response = responses.get(prompt.id);
    describe(`${prompt.id} (${prompt.format})`, () => {
      for (const check of prompt.checks) {
        it(check, () => {
          expect(response, 'missing response').toBeDefined();
          if (response === undefined) return;
          const result = runChecks(prompt, response.text).find((r) => r.id === check);
          expect(result?.pass, result?.detail).toBe(true);
        });
      }
    });
  }
});
