/**
 * Memory configuration (src/lib/memory/config.ts): defaults, validation, and the rule that
 * an error names the variable and never carries the key.
 */
import { describe, expect, it } from 'vitest';

import {
  POLICY_DEFAULTS,
  VOYAGE_DEFAULTS,
  hasVoyageKey,
  loadMemoryConfig,
  loadMemoryPolicy,
  loadVoyageConfig,
} from '../../../src/lib/memory/config.js';
import { FAKE_VOYAGE_KEY } from './helpers.js';

describe('loadVoyageConfig', () => {
  it('needs only the key; everything else has a default', () => {
    const result = loadVoyageConfig({ VOYAGE_API_KEY: FAKE_VOYAGE_KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      apiKey: FAKE_VOYAGE_KEY,
      baseUrl: 'https://api.voyageai.com',
      model: 'voyage-3',
      dimensions: 1024,
      timeoutMs: VOYAGE_DEFAULTS.timeoutMs,
      retries: VOYAGE_DEFAULTS.retries,
      pricePerMTok: 0.06,
      caps: { dailyUsd: 0.5, monthlyUsd: 5, warnFraction: 0.8 },
    });
  });

  it('a missing key is a CONFIG error naming the variable', () => {
    const result = loadVoyageConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.message).toContain('VOYAGE_API_KEY');
    expect(hasVoyageKey({})).toBe(false);
    expect(hasVoyageKey({ VOYAGE_API_KEY: '  ' })).toBe(false);
    expect(hasVoyageKey({ VOYAGE_API_KEY: FAKE_VOYAGE_KEY })).toBe(true);
  });

  it.each([
    ['VOYAGE_DIMENSIONS', '0'],
    ['VOYAGE_TIMEOUT_MS', '-1'],
    ['VOYAGE_RETRIES', '9'],
    ['VOYAGE_PRICE_PER_MTOK', 'free'],
    ['VOYAGE_DAILY_SPEND_CAP_USD', '-5'],
    ['VOYAGE_MONTHLY_SPEND_CAP_USD', 'x'],
    ['VOYAGE_SPEND_WARN_FRACTION', '2'],
  ])('refuses a malformed %s with an error that never contains the key', (name, value) => {
    const result = loadVoyageConfig({ VOYAGE_API_KEY: FAKE_VOYAGE_KEY, [name]: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(name);
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_VOYAGE_KEY);
  });

  it('refuses a non-https base URL and strips a trailing slash from a good one', () => {
    expect(
      loadVoyageConfig({ VOYAGE_API_KEY: FAKE_VOYAGE_KEY, VOYAGE_BASE_URL: 'http://x' }).ok,
    ).toBe(false);
    const good = loadVoyageConfig({
      VOYAGE_API_KEY: FAKE_VOYAGE_KEY,
      VOYAGE_BASE_URL: 'https://voyage.test/',
      VOYAGE_MODEL: 'voyage-3-lite',
      VOYAGE_DAILY_SPEND_CAP_USD: '0',
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.baseUrl).toBe('https://voyage.test');
    expect(good.value.model).toBe('voyage-3-lite');
    expect(good.value.caps.dailyUsd).toBe(0);
  });
});

describe('loadMemoryPolicy', () => {
  it('defaults match POLICY_DEFAULTS', () => {
    expect(loadMemoryPolicy({})).toEqual({ ok: true, value: POLICY_DEFAULTS });
  });

  it('minTail may not exceed the chunk size', () => {
    const result = loadMemoryPolicy({ MEMORY_CHUNK_MESSAGES: '4', MEMORY_MIN_TAIL_MESSAGES: '5' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('MEMORY_MIN_TAIL_MESSAGES');
  });

  it.each([
    ['MEMORY_CHUNK_MESSAGES', '1'],
    ['MEMORY_IDLE_HOURS', '-1'],
    ['MEMORY_MAX_CHUNKS_PER_TRIGGER', '0'],
    ['MEMORY_SUMMARY_MAX_CHARS', '10'],
  ])('refuses a malformed %s', (name, value) => {
    const result = loadMemoryPolicy({ [name]: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(name);
  });

  it('loadMemoryConfig composes both', () => {
    const result = loadMemoryConfig({ VOYAGE_API_KEY: FAKE_VOYAGE_KEY, MEMORY_IDLE_HOURS: '0' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policy.idleHours).toBe(0);
    expect(result.value.voyage.model).toBe('voyage-3');
    expect(loadMemoryConfig({}).ok).toBe(false);
  });
});
