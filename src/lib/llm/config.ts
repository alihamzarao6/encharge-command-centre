/**
 * Claude integration configuration — read from the SERVER environment only.
 *
 * This is the only module in the repository that reads ANTHROPIC_API_KEY
 * (tests/security/secrets.test.ts asserts it). The key is held in the returned config
 * object and used by client.ts to set one request header; it is never logged (the logger
 * redacts `sk-ant-` by pattern and `apiKey` by key name), never returned to a caller, and
 * never part of an error message.
 *
 * Everything an operator might change without a redeploy is here rather than in code:
 * model ids, caps, max tokens, timeout, pricing. Supabase Edge Functions read secrets at
 * invocation, so `supabase secrets set CLAUDE_MODEL_DEFAULT=...` takes effect on the next
 * call.
 */
import { ConfigError, err, ok, type Result } from '../errors.js';
import { DEFAULT_PRICING, parsePricingJson, type PricingTable } from './pricing.js';
import type { SpendCaps } from './spend.js';

export interface LlmConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly models: { readonly default: string; readonly fast: string };
  readonly maxTokens: number;
  readonly timeoutMs: number;
  /** Retries after the first attempt, applied ONLY to responses that provably billed nothing. */
  readonly retries: number;
  readonly caps: SpendCaps;
  readonly pricing: PricingTable;
}

export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2023-06-01';

export const CONFIG_DEFAULTS = {
  modelDefault: 'claude-sonnet-5',
  modelFast: 'claude-haiku-4-5-20251001',
  maxTokens: 1024,
  timeoutMs: 60_000,
  retries: 2,
  warnFraction: 0.8,
} as const;

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function readNumber(
  env: Env,
  name: string,
  fallback: number | undefined,
  predicate: (n: number) => boolean,
  requirement: string,
): Result<number, ConfigError> {
  const raw = read(env, name);
  if (raw === undefined) {
    if (fallback === undefined) {
      return err(new ConfigError(`${name} is required`, { context: { name } }));
    }
    return ok(fallback);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || !predicate(value)) {
    return err(new ConfigError(`${name} must be ${requirement}`, { context: { name } }));
  }
  return ok(value);
}

export function loadLlmConfig(env: Env = process.env): Result<LlmConfig, ConfigError> {
  const apiKey = read(env, 'ANTHROPIC_API_KEY');
  if (apiKey === undefined) {
    return err(new ConfigError('ANTHROPIC_API_KEY is required (server environment only)'));
  }

  // Caps have NO default. An unset cap is not "unlimited" — it is a misconfiguration, and a
  // misconfigured cap refuses every call rather than silently spending.
  const daily = readNumber(env, 'ANTHROPIC_DAILY_SPEND_CAP_USD', undefined, (n) => n >= 0, '>= 0');
  if (!daily.ok) return daily;
  const monthly = readNumber(
    env,
    'ANTHROPIC_MONTHLY_SPEND_CAP_USD',
    undefined,
    (n) => n >= 0,
    '>= 0',
  );
  if (!monthly.ok) return monthly;
  const warn = readNumber(
    env,
    'ANTHROPIC_SPEND_WARN_FRACTION',
    CONFIG_DEFAULTS.warnFraction,
    (n) => n > 0 && n <= 1,
    'between 0 and 1',
  );
  if (!warn.ok) return warn;
  const maxTokens = readNumber(
    env,
    'CLAUDE_MAX_TOKENS',
    CONFIG_DEFAULTS.maxTokens,
    (n) => Number.isInteger(n) && n > 0,
    'a positive integer',
  );
  if (!maxTokens.ok) return maxTokens;
  const timeoutMs = readNumber(
    env,
    'CLAUDE_TIMEOUT_MS',
    CONFIG_DEFAULTS.timeoutMs,
    (n) => Number.isInteger(n) && n > 0,
    'a positive integer',
  );
  if (!timeoutMs.ok) return timeoutMs;
  const retries = readNumber(
    env,
    'CLAUDE_RETRIES',
    CONFIG_DEFAULTS.retries,
    (n) => Number.isInteger(n) && n >= 0 && n <= 5,
    'an integer from 0 to 5',
  );
  if (!retries.ok) return retries;

  let pricing: PricingTable = DEFAULT_PRICING;
  const pricingJson = read(env, 'CLAUDE_PRICING_JSON');
  if (pricingJson !== undefined) {
    const parsed = parsePricingJson(pricingJson);
    if (!parsed.ok) return parsed;
    pricing = Object.freeze({ ...DEFAULT_PRICING, ...parsed.value });
  }

  const baseUrl = read(env, 'ANTHROPIC_BASE_URL') ?? ANTHROPIC_API_BASE_URL;
  if (!baseUrl.startsWith('https://')) {
    return err(new ConfigError('ANTHROPIC_BASE_URL must be an https URL'));
  }

  return ok({
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiVersion: ANTHROPIC_API_VERSION,
    models: {
      default: read(env, 'CLAUDE_MODEL_DEFAULT') ?? CONFIG_DEFAULTS.modelDefault,
      fast: read(env, 'CLAUDE_MODEL_FAST') ?? CONFIG_DEFAULTS.modelFast,
    },
    maxTokens: maxTokens.value,
    timeoutMs: timeoutMs.value,
    retries: retries.value,
    caps: { dailyUsd: daily.value, monthlyUsd: monthly.value, warnFraction: warn.value },
    pricing,
  });
}
