/**
 * createFilesPageDeps and the chat path's document wiring: the one place the environment
 * becomes the files endpoint's dependencies. A missing or malformed variable is a CONFIG
 * error naming the variable (never a value); a model with no price is refused at wiring; and
 * a complete environment wires everything without touching the network.
 */
import { describe, expect, it } from 'vitest';

import { createFilesPageDeps } from '../../../src/lib/files/wiring.js';
import { createChatDeps } from '../../../src/lib/llm/wiring.js';
import { DEFAULT_PRICING } from '../../../src/lib/llm/pricing.js';
import { FAKE_KEY, capturingLogger } from '../llm/helpers.js';

const FULL_ENV = {
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
  ANTHROPIC_API_KEY: FAKE_KEY,
  ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
  ANTHROPIC_MONTHLY_SPEND_CAP_USD: '50',
};

describe('createFilesPageDeps', () => {
  it('wires the endpoint from a complete environment, with the defaults on record', () => {
    const { log, lines } = capturingLogger();
    const result = createFilesPageDeps(FULL_ENV, log);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deps = result.value;
    expect(typeof deps.verify.getUserFromToken).toBe('function');
    expect(typeof deps.files.begin).toBe('function');
    expect(typeof deps.conversations.create).toBe('function');
    expect(typeof deps.usage.spentSince).toBe('function');
    expect(deps.caps).toEqual({ dailyUsd: 5, monthlyUsd: 50, warnFraction: 0.8 });
    expect(deps.config).toEqual({
      contextMaxChars: 48_000,
      retentionDays: 30,
      visionRoute: 'default',
      visionMaxTokens: 4096,
    });
    // A page image is read by the default model, and priced as that model.
    expect(deps.vision).toMatchObject({ route: 'default', maxTokens: 4096 });
    expect(deps.visionPricing).toEqual(DEFAULT_PRICING['claude-sonnet-5']);
    // Construction is silent and secret-free.
    expect(lines).toEqual([]);
    expect(JSON.stringify(deps)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(deps)).not.toContain('service-role-value');
  });

  it('the fast route is priced as the fast model', () => {
    const result = createFilesPageDeps(
      { ...FULL_ENV, FILES_VISION_ROUTE: 'fast' },
      capturingLogger().log,
    );
    expect(result.ok && result.value.vision.route).toBe('fast');
    expect(result.ok && result.value.visionPricing).toEqual(
      DEFAULT_PRICING['claude-haiku-4-5-20251001'],
    );
  });

  it.each([
    ['SUPABASE_SERVICE_ROLE_KEY', ''],
    ['ANTHROPIC_API_KEY', ''],
    ['ANTHROPIC_DAILY_SPEND_CAP_USD', ''],
    ['FILES_RETENTION_DAYS', 'forever'],
    ['FILES_VISION_ROUTE', 'opus'],
  ])('refuses a missing or malformed %s as a CONFIG error with no secret in it', (name, value) => {
    const result = createFilesPageDeps({ ...FULL_ENV, [name]: value }, capturingLogger().log);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    const serialised = JSON.stringify(result.error.toJSON());
    expect(serialised).toContain(name);
    expect(serialised).not.toContain(FAKE_KEY);
    expect(serialised).not.toContain('service-role-value');
  });

  it('a vision model with no price is refused at wiring: what cannot be priced cannot be capped', () => {
    const result = createFilesPageDeps(
      { ...FULL_ENV, CLAUDE_MODEL_DEFAULT: 'claude-unpriced-model' },
      capturingLogger().log,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain('claude-unpriced-model');
  });
});

describe('the chat path reads attached files', () => {
  it('a complete environment gives the chat a documents dependency', () => {
    const result = createChatDeps(FULL_ENV, capturingLogger().log);
    expect(result.ok && typeof result.value.documents?.load).toBe('function');
  });

  it('a malformed files budget stops the chat from starting rather than being guessed at', () => {
    const result = createChatDeps(
      { ...FULL_ENV, FILES_CONTEXT_MAX_CHARS: 'lots' },
      capturingLogger().log,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain('FILES_CONTEXT_MAX_CHARS');
  });
});
