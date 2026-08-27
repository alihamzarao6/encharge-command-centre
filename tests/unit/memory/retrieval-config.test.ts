/**
 * Retrieval configuration (src/lib/memory/config.ts, part 2): defaults, bounds, and the
 * wiring of the on-path memory into the chat dependencies.
 */
import { describe, expect, it } from 'vitest';

import { createChatDeps } from '../../../src/lib/llm/wiring.js';
import {
  RETRIEVAL_DEFAULTS,
  loadMemoryConfig,
  loadRetrievalConfig,
} from '../../../src/lib/memory/config.js';
import { MAX_BELOW_BREAKPOINT_CHARS } from '../../../src/lib/voice/prompt.js';
import { FAKE_KEY, capturingLogger } from '../llm/helpers.js';
import { FAKE_VOYAGE_KEY } from './helpers.js';

describe('loadRetrievalConfig', () => {
  it('defaults: top 3 above 0.45, budgets that fit the below-breakpoint cap, 4 s deadline', () => {
    expect(loadRetrievalConfig({})).toEqual({ ok: true, value: RETRIEVAL_DEFAULTS });
    expect(RETRIEVAL_DEFAULTS.chunkBudgetChars + RETRIEVAL_DEFAULTS.factBudgetChars).toBeLessThan(
      MAX_BELOW_BREAKPOINT_CHARS,
    );
  });

  it('reads every knob', () => {
    expect(
      loadRetrievalConfig({
        MEMORY_RETRIEVAL_TOP_K: '5',
        MEMORY_RETRIEVAL_MIN_SIMILARITY: '0.6',
        MEMORY_RETRIEVAL_CHUNK_CHARS: '1500',
        MEMORY_RETRIEVAL_FACT_CHARS: '500',
        MEMORY_RETRIEVAL_MAX_FACTS: '3',
        MEMORY_RECALL_TIMEOUT_MS: '2500',
      }),
    ).toEqual({
      ok: true,
      value: {
        topK: 5,
        minSimilarity: 0.6,
        chunkBudgetChars: 1_500,
        factBudgetChars: 500,
        maxFacts: 3,
        timeoutMs: 2_500,
      },
    });
  });

  it.each([
    ['MEMORY_RETRIEVAL_TOP_K', '11'],
    ['MEMORY_RETRIEVAL_TOP_K', '1.5'],
    ['MEMORY_RETRIEVAL_MIN_SIMILARITY', '1.2'],
    ['MEMORY_RETRIEVAL_CHUNK_CHARS', '9000'],
    ['MEMORY_RETRIEVAL_FACT_CHARS', '-1'],
    ['MEMORY_RETRIEVAL_MAX_FACTS', 'many'],
    ['MEMORY_RECALL_TIMEOUT_MS', '0'],
  ])('refuses a malformed %s naming the variable', (name, value) => {
    const result = loadRetrievalConfig({ [name]: value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(name);
  });

  it('loadMemoryConfig carries retrieval alongside voyage and policy', () => {
    const result = loadMemoryConfig({ VOYAGE_API_KEY: FAKE_VOYAGE_KEY });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.retrieval).toEqual(RETRIEVAL_DEFAULTS);
  });
});

describe('createChatDeps and the on-path memory', () => {
  const BASE_ENV = {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
    ANTHROPIC_API_KEY: FAKE_KEY,
    ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
    ANTHROPIC_MONTHLY_SPEND_CAP_USD: '50',
  };

  it('with the Voyage key: `memory` is wired next to `afterTurn`; without it, neither', () => {
    const { log } = capturingLogger();
    const withKey = createChatDeps({ ...BASE_ENV, VOYAGE_API_KEY: FAKE_VOYAGE_KEY }, log);
    expect(withKey.ok).toBe(true);
    if (withKey.ok) {
      expect(typeof withKey.value.memory?.recall).toBe('function');
      expect(typeof withKey.value.memory?.attachSource).toBe('function');
    }
    const without = createChatDeps(BASE_ENV, log);
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.value.memory).toBeUndefined();
  });

  it('a malformed retrieval knob is a CONFIG error naming the variable, never the key', () => {
    const { log, lines } = capturingLogger();
    const result = createChatDeps(
      { ...BASE_ENV, VOYAGE_API_KEY: FAKE_VOYAGE_KEY, MEMORY_RETRIEVAL_TOP_K: 'lots' },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.message).toContain('MEMORY_RETRIEVAL_TOP_K');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_VOYAGE_KEY);
    expect(lines.join('\n')).not.toContain(FAKE_VOYAGE_KEY);
  });
});
