/**
 * Typed outcomes of a Claude call that are not transport failures (Stage 2 part 4).
 *
 * The operator needs to know whether a turn failed because of the spend cap, a rate limit,
 * a model refusal, or a timeout — each is handled differently (raise the cap / wait / reword
 * / retry). Transport failures keep the codes from errors.ts (TIMEOUT, NETWORK, HTTP_STATUS,
 * CIRCUIT_OPEN). None of these is thrown across a module boundary; they travel in `Result`.
 */
import { AppError, type AppErrorOptions } from '../errors.js';

export type SpendWindow = 'day' | 'month';

/** The call was refused BEFORE any request left the process. Nothing was spent. */
export class SpendCapError extends AppError {
  public readonly window: SpendWindow;
  public readonly spentUsd: number;
  public readonly capUsd: number;
  public readonly estimateUsd: number;

  public constructor(window: SpendWindow, spentUsd: number, capUsd: number, estimateUsd: number) {
    super(
      'SPEND_CAP',
      `Spend cap reached: ${window} spend ${spentUsd.toFixed(4)} USD + this call ≈ ${estimateUsd.toFixed(4)} USD would exceed the ${capUsd.toFixed(2)} USD ${window} cap`,
      { retryable: false, context: { window, spentUsd, capUsd, estimateUsd } },
    );
    this.window = window;
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
    this.estimateUsd = estimateUsd;
  }
}

/** Who answered 429, in words, by the `provider` the caller puts in the context. */
const RATE_LIMITED_BY: Readonly<Record<string, string>> = {
  ghl: 'GoHighLevel',
  voyage: 'Voyage',
};

/**
 * A provider answered 429. Nothing was billed. Retryable after the server's delay.
 *
 * Written for Anthropic, then reused by the GoHighLevel and Voyage clients — whose 429s were
 * stored and logged as "Anthropic rate limit reached" until 14 Oct 2026, a message that sends
 * whoever reads it to the wrong account. The message names the `provider` given in the
 * context; with none given it is Anthropic, as it always was for the Claude client.
 */
export class RateLimitedError extends AppError {
  public readonly retryAfterMs: number | null;

  public constructor(retryAfterMs: number | null, options: AppErrorOptions = {}) {
    const provider = options.context?.['provider'];
    const by = typeof provider === 'string' ? (RATE_LIMITED_BY[provider] ?? provider) : 'Anthropic';
    super('RATE_LIMITED', `${by} rate limit reached`, {
      retryable: true,
      ...options,
      context: { ...(options.context ?? {}), retryAfterMs },
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/** The model declined to answer (stop_reason "refusal"). The request WAS billed. */
export class ModelRefusalError extends AppError {
  public readonly category: string | null;

  public constructor(category: string | null, options: AppErrorOptions = {}) {
    super('MODEL_REFUSAL', 'The model declined to answer this request', {
      retryable: false,
      ...options,
      context: { ...(options.context ?? {}), category },
    });
    this.category = category;
  }
}
