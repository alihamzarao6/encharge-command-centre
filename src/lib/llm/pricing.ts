/**
 * Cost arithmetic for Claude calls. Pure.
 *
 * Prices are configuration with a checked-in default (SECURITY.md §8): a model the table
 * does not know cannot be priced, and a call that cannot be priced cannot be capped, so it
 * is refused with a ConfigError rather than guessed at. Override or extend the table
 * without a redeploy via CLAUDE_PRICING_JSON (config.ts).
 *
 * Defaults are Anthropic list prices per million tokens (24 Aug 2026). Sonnet 5 has an
 * introductory $2/$10 through 31 Aug 2026 — the table deliberately carries the standard
 * $3/$15 so the cap is never tuned against a discount that expires.
 * Cache: writes bill at 1.25× input, reads at 0.1× input.
 */
import { ConfigError, err, ok, type Result } from '../errors.js';

export interface ModelPricing {
  /** USD per 1,000,000 uncached input tokens. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheWritePerMTok: number;
  readonly cacheReadPerMTok: number;
}

export type PricingTable = Readonly<Record<string, ModelPricing>>;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const SONNET_5: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
};

const HAIKU_4_5: ModelPricing = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheWritePerMTok: 1.25,
  cacheReadPerMTok: 0.1,
};

export const DEFAULT_PRICING: PricingTable = Object.freeze({
  'claude-sonnet-5': SONNET_5,
  'claude-haiku-4-5-20251001': HAIKU_4_5,
  'claude-haiku-4-5': HAIKU_4_5,
});

const MICRO = 1_000_000;

/** Round to the 6 decimal places api_usage.cost_usd numeric(10,6) can hold. */
export function roundUsd(value: number): number {
  return Math.round(value * MICRO) / MICRO;
}

export function costUsd(pricing: ModelPricing, usage: TokenUsage): number {
  const raw =
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cacheWriteTokens * pricing.cacheWritePerMTok +
      usage.cacheReadTokens * pricing.cacheReadPerMTok) /
    MICRO;
  return roundUsd(raw);
}

/**
 * Pre-call estimate of input tokens from character count. Deliberately pessimistic
 * (English prose runs ≈ 4 chars/token; 3 is used) so the cap check errs towards refusing.
 */
export function estimateInputTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 3);
}

/** Worst case for the cap check: every input token uncached, every output token used. */
export function estimateWorstCaseUsd(
  pricing: ModelPricing,
  inputChars: number,
  maxOutputTokens: number,
): number {
  return costUsd(pricing, {
    inputTokens: estimateInputTokens(inputChars),
    outputTokens: maxOutputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

export function pricingFor(table: PricingTable, model: string): Result<ModelPricing, ConfigError> {
  const pricing = Object.hasOwn(table, model) ? table[model] : undefined;
  if (pricing === undefined) {
    return err(
      new ConfigError(`No pricing configured for model ${model}; refusing to call unpriced model`, {
        context: { model, known: Object.keys(table) },
      }),
    );
  }
  return ok(pricing);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Parse a CLAUDE_PRICING_JSON override: `{ "<model>": { inputPerMTok, ... } }`. */
export function parsePricingJson(json: string): Result<PricingTable, ConfigError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return err(new ConfigError('CLAUDE_PRICING_JSON is not valid JSON'));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(new ConfigError('CLAUDE_PRICING_JSON must be an object keyed by model id'));
  }
  const out: Record<string, ModelPricing> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== 'object') {
      return err(new ConfigError(`CLAUDE_PRICING_JSON.${model} must be an object`));
    }
    const record = value as Record<string, unknown>;
    const inputPerMTok = record['inputPerMTok'];
    const outputPerMTok = record['outputPerMTok'];
    const cacheWritePerMTok = record['cacheWritePerMTok'];
    const cacheReadPerMTok = record['cacheReadPerMTok'];
    if (
      !isNonNegativeNumber(inputPerMTok) ||
      !isNonNegativeNumber(outputPerMTok) ||
      !isNonNegativeNumber(cacheWritePerMTok) ||
      !isNonNegativeNumber(cacheReadPerMTok)
    ) {
      return err(
        new ConfigError(
          `CLAUDE_PRICING_JSON.${model} needs non-negative inputPerMTok, outputPerMTok, cacheWritePerMTok, cacheReadPerMTok`,
        ),
      );
    }
    out[model] = { inputPerMTok, outputPerMTok, cacheWritePerMTok, cacheReadPerMTok };
  }
  return ok(Object.freeze(out));
}
