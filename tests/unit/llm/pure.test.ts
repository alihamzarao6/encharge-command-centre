/**
 * The pure modules of the Claude layer: config, pricing, spend, response parsing, prompt.
 */
import { describe, expect, it } from 'vitest';

import { CONFIG_DEFAULTS, loadLlmConfig } from '../../../src/lib/llm/config.js';
import {
  DEFAULT_PRICING,
  costUsd,
  estimateInputTokens,
  estimateWorstCaseUsd,
  parsePricingJson,
  pricingFor,
  roundUsd,
} from '../../../src/lib/llm/pricing.js';
import { buildSystemBlocks } from '../../../src/lib/llm/prompt.js';
import { buildVoicePrefix } from '../../../src/lib/voice/prompt.js';
import { parseErrorEnvelope, parseMessageResponse } from '../../../src/lib/llm/response.js';
import { checkSpendCap, utcDayStart, utcMonthStart } from '../../../src/lib/llm/spend.js';
import { FAKE_KEY, fixture } from './helpers.js';

const BASE_ENV = {
  ANTHROPIC_API_KEY: FAKE_KEY,
  ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
  ANTHROPIC_MONTHLY_SPEND_CAP_USD: '50',
};

describe('loadLlmConfig', () => {
  it('reads the key and caps, and defaults everything else', () => {
    const result = loadLlmConfig(BASE_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      apiKey: FAKE_KEY,
      baseUrl: 'https://api.anthropic.com',
      apiVersion: '2023-06-01',
      models: { default: 'claude-sonnet-5', fast: 'claude-haiku-4-5-20251001' },
      maxTokens: CONFIG_DEFAULTS.maxTokens,
      timeoutMs: CONFIG_DEFAULTS.timeoutMs,
      retries: CONFIG_DEFAULTS.retries,
      thinking: 'disabled',
      caps: { dailyUsd: 5, monthlyUsd: 50, warnFraction: 0.8 },
    });
    expect(result.value.pricing).toBe(DEFAULT_PRICING);
  });

  it('models, caps, max tokens, timeout and retries all come from the environment', () => {
    const result = loadLlmConfig({
      ...BASE_ENV,
      CLAUDE_MODEL_DEFAULT: 'claude-sonnet-5',
      CLAUDE_MODEL_FAST: 'claude-haiku-4-5',
      CLAUDE_MAX_TOKENS: '2048',
      CLAUDE_TIMEOUT_MS: '30000',
      CLAUDE_RETRIES: '0',
      CLAUDE_THINKING: 'adaptive',
      ANTHROPIC_SPEND_WARN_FRACTION: '0.5',
      ANTHROPIC_DAILY_SPEND_CAP_USD: '0',
      ANTHROPIC_BASE_URL: 'https://proxy.example/',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      models: { default: 'claude-sonnet-5', fast: 'claude-haiku-4-5' },
      maxTokens: 2048,
      timeoutMs: 30_000,
      retries: 0,
      thinking: 'adaptive',
      caps: { dailyUsd: 0, monthlyUsd: 50, warnFraction: 0.5 },
      baseUrl: 'https://proxy.example',
    });
  });

  it.each([
    ['missing key', { ...BASE_ENV, ANTHROPIC_API_KEY: '' }],
    ['missing daily cap', { ...BASE_ENV, ANTHROPIC_DAILY_SPEND_CAP_USD: undefined }],
    ['missing monthly cap', { ...BASE_ENV, ANTHROPIC_MONTHLY_SPEND_CAP_USD: undefined }],
    ['negative cap', { ...BASE_ENV, ANTHROPIC_DAILY_SPEND_CAP_USD: '-1' }],
    ['non-numeric cap', { ...BASE_ENV, ANTHROPIC_MONTHLY_SPEND_CAP_USD: 'fifty' }],
    ['fractional max tokens', { ...BASE_ENV, CLAUDE_MAX_TOKENS: '1.5' }],
    ['zero timeout', { ...BASE_ENV, CLAUDE_TIMEOUT_MS: '0' }],
    ['too many retries', { ...BASE_ENV, CLAUDE_RETRIES: '9' }],
    ['unknown thinking mode', { ...BASE_ENV, CLAUDE_THINKING: 'enabled' }],
    ['warn fraction > 1', { ...BASE_ENV, ANTHROPIC_SPEND_WARN_FRACTION: '2' }],
    ['http base url', { ...BASE_ENV, ANTHROPIC_BASE_URL: 'http://plain.example' }],
    ['bad pricing json', { ...BASE_ENV, CLAUDE_PRICING_JSON: '{' }],
  ])('refuses %s with a CONFIG error that never contains the key', (_label, env) => {
    const result = loadLlmConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_KEY);
  });

  it('merges a pricing override over the defaults', () => {
    const result = loadLlmConfig({
      ...BASE_ENV,
      CLAUDE_PRICING_JSON: JSON.stringify({
        'claude-new-1': {
          inputPerMTok: 2,
          outputPerMTok: 10,
          cacheWritePerMTok: 2.5,
          cacheReadPerMTok: 0.2,
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pricing['claude-new-1']?.outputPerMTok).toBe(10);
    expect(result.value.pricing['claude-sonnet-5']).toBe(DEFAULT_PRICING['claude-sonnet-5']);
  });
});

describe('conversation history bounds (TASKS 2.6.2a)', () => {
  it('defaults to 20 messages / 24,000 chars and accepts overrides', () => {
    const base = loadLlmConfig(BASE_ENV);
    expect(base.ok && base.value.history).toEqual({ maxMessages: 20, maxChars: 24_000 });
    const custom = loadLlmConfig({
      ...BASE_ENV,
      CHAT_HISTORY_MAX_MESSAGES: '0',
      CHAT_HISTORY_MAX_CHARS: '100',
    });
    expect(custom.ok && custom.value.history).toEqual({ maxMessages: 0, maxChars: 100 });
  });

  it.each([
    ['CHAT_HISTORY_MAX_MESSAGES', '-1'],
    ['CHAT_HISTORY_MAX_MESSAGES', '201'],
    ['CHAT_HISTORY_MAX_MESSAGES', '1.5'],
    ['CHAT_HISTORY_MAX_CHARS', '-5'],
  ])('rejects %s=%s', (name, value) => {
    const result = loadLlmConfig({ ...BASE_ENV, [name]: value });
    expect(result.ok).toBe(false);
  });
});

describe('pricing', () => {
  const sonnet = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  };
  it('is the checked-in Sonnet 5 price', () => {
    expect(DEFAULT_PRICING['claude-sonnet-5']).toEqual(sonnet);
  });

  it('costs a call at list price, rounded to 6 dp', () => {
    expect(
      costUsd(sonnet, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(3);
    expect(
      costUsd(sonnet, {
        inputTokens: 123,
        outputTokens: 21,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0.000684);
    expect(
      costUsd(sonnet, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(4.05);
    expect(roundUsd(0.1234567)).toBe(0.123457);
  });

  it('estimates input tokens pessimistically (3 chars/token) and never negative', () => {
    expect(estimateInputTokens(0)).toBe(0);
    expect(estimateInputTokens(-5)).toBe(0);
    expect(estimateInputTokens(1)).toBe(1);
    expect(estimateInputTokens(300)).toBe(100);
    // 100 input tokens × $3/M + 256 × $15/M = 0.0003 + 0.00384
    expect(estimateWorstCaseUsd(sonnet, 300, 256)).toBe(0.00414);
  });

  it('refuses to price an unknown model', () => {
    expect(pricingFor(DEFAULT_PRICING, 'claude-sonnet-5').ok).toBe(true);
    const unknown = pricingFor(DEFAULT_PRICING, 'gpt-something');
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe('CONFIG');
    expect(unknown.error.context['known']).toContain('claude-sonnet-5');
  });

  it.each([
    ['[]', 'object keyed by model'],
    ['{"m": 1}', 'must be an object'],
    [
      '{"m": {"inputPerMTok": -1, "outputPerMTok": 1, "cacheWritePerMTok": 1, "cacheReadPerMTok": 1}}',
      'non-negative',
    ],
    ['{"m": {"inputPerMTok": 1}}', 'non-negative'],
  ])('rejects pricing json %s', (json, message) => {
    const result = parsePricingJson(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(message);
  });
});

describe('spend cap decision', () => {
  const caps = { dailyUsd: 5, monthlyUsd: 50, warnFraction: 0.8 };

  it('allows under both caps, with no warnings', () => {
    expect(checkSpendCap(caps, { dayUsd: 1, monthUsd: 10 }, 0.01)).toEqual({
      allowed: true,
      warnings: [],
    });
  });

  it('refuses when spent + estimate exceeds the month, naming the month first', () => {
    expect(checkSpendCap(caps, { dayUsd: 4.999, monthUsd: 49.999 }, 0.01)).toEqual({
      allowed: false,
      window: 'month',
      spentUsd: 49.999,
      capUsd: 50,
      estimateUsd: 0.01,
    });
  });

  it('refuses on the day when the month is fine', () => {
    expect(checkSpendCap(caps, { dayUsd: 4.999, monthUsd: 10 }, 0.01)).toMatchObject({
      allowed: false,
      window: 'day',
    });
  });

  it('exactly at the cap is allowed; one micro-dollar over is not', () => {
    expect(checkSpendCap(caps, { dayUsd: 4.99, monthUsd: 0 }, 0.01).allowed).toBe(true);
    expect(checkSpendCap(caps, { dayUsd: 4.99, monthUsd: 0 }, 0.010001).allowed).toBe(false);
  });

  it('warns at the configured fraction of either cap', () => {
    expect(checkSpendCap(caps, { dayUsd: 4, monthUsd: 40 }, 0)).toEqual({
      allowed: true,
      warnings: ['month', 'day'],
    });
  });

  it('a zero cap refuses any positive estimate', () => {
    expect(
      checkSpendCap({ ...caps, dailyUsd: 0 }, { dayUsd: 0, monthUsd: 0 }, 0.000001).allowed,
    ).toBe(false);
  });

  it('windows are UTC calendar boundaries', () => {
    const at = new Date('2026-08-25T23:59:59.999Z');
    expect(utcDayStart(at).toISOString()).toBe('2026-08-25T00:00:00.000Z');
    expect(utcMonthStart(at).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // 08:30 in Perth on the 26th is still the 25th in UTC.
    expect(utcDayStart(new Date('2026-08-26T08:30:00+08:00')).toISOString()).toBe(
      '2026-08-26T00:00:00.000Z',
    );
    expect(utcDayStart(new Date('2026-08-26T07:30:00+08:00')).toISOString()).toBe(
      '2026-08-25T00:00:00.000Z',
    );
  });
});

describe('response parsing', () => {
  it('parses the recorded success fixture', () => {
    const result = parseMessageResponse(JSON.parse(fixture('messages-ok')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      model: 'claude-sonnet-5',
      stopReason: 'end_turn',
      refusalCategory: null,
      usage: { inputTokens: 168, outputTokens: 118, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(result.value.text).toContain('brand voice');
  });

  it('concatenates text blocks and ignores unknown block types', () => {
    const body = {
      ...(JSON.parse(fixture('messages-ok')) as object),
      content: [
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'b' },
      ],
    };
    const result = parseMessageResponse(body);
    expect(result.ok && result.value.text).toBe('ab');
  });

  it('treats missing cache counters as zero', () => {
    const body = JSON.parse(fixture('messages-ok')) as { usage: Record<string, unknown> };
    delete body.usage['cache_creation_input_tokens'];
    delete body.usage['cache_read_input_tokens'];
    const result = parseMessageResponse(body);
    expect(result.ok && result.value.usage.cacheWriteTokens).toBe(0);
  });

  it('exposes the refusal category', () => {
    const result = parseMessageResponse(JSON.parse(fixture('messages-refusal')));
    expect(result.ok && result.value.refusalCategory).toBe('fixture_category');
  });

  it.each([
    ['null', null],
    ['missing usage', { id: 'x', type: 'message', model: 'm', stop_reason: null, content: [] }],
    [
      'negative tokens',
      {
        id: 'x',
        type: 'message',
        model: 'm',
        stop_reason: null,
        content: [],
        usage: { input_tokens: -1, output_tokens: 0 },
      },
    ],
    [
      'wrong type',
      {
        id: 'x',
        type: 'error',
        model: 'm',
        stop_reason: null,
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    ],
  ])('refuses %s with paths in the issues', (_label, body) => {
    const result = parseMessageResponse(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('VALIDATION');
    expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it('reads the error envelope, or null', () => {
    expect(parseErrorEnvelope(fixture('error-429'))).toEqual({
      type: 'rate_limit_error',
      message: "This request would exceed your organization's rate limit.",
    });
    expect(parseErrorEnvelope('not json')).toBeNull();
    expect(parseErrorEnvelope('{"type":"message"}')).toBeNull();
  });
});

describe('system prompt', () => {
  it('is the voice prefix with a cache breakpoint after it', () => {
    const blocks = buildSystemBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(buildVoicePrefix());
    expect(blocks[0]?.cache).toBe(true);
  });
});
