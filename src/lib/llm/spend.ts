/**
 * Spend-cap decision. Pure — the client (client.ts) feeds it the sums and acts on the answer.
 *
 * Shape of the cap (Stage 2 part 4 decision, MEMORY.md 25 Aug):
 *  - MONTHLY hard cap — the promise made to the client ("50 to 80 a month with a hard cap").
 *  - DAILY hard cap — the retry-storm brake: one bad day cannot spend the month.
 *  - Both are provider-wide (all users, all conversations): one card pays. Per-user and
 *    per-conversation limits are not promised and are not built.
 *  - Windows are UTC calendar days/months because the cap protects the Anthropic invoice,
 *    which is cut in UTC. A Perth-local window would let a call land in "yesterday's" bill.
 *  - The check is spent-so-far PLUS the worst case of THIS call. Refusing at "spent ≥ cap"
 *    alone lets the last call overshoot by one call's cost.
 */
import type { SpendWindow } from './errors.js';

export interface SpendCaps {
  readonly dailyUsd: number;
  readonly monthlyUsd: number;
  /** Fraction of a cap at which a warning is emitted. 0.8 = warn at 80%. */
  readonly warnFraction: number;
}

export interface SpentSoFar {
  readonly dayUsd: number;
  readonly monthUsd: number;
}

export type CapDecision =
  | { readonly allowed: true; readonly warnings: readonly SpendWindow[] }
  | {
      readonly allowed: false;
      readonly window: SpendWindow;
      readonly spentUsd: number;
      readonly capUsd: number;
      readonly estimateUsd: number;
    };

export function checkSpendCap(
  caps: SpendCaps,
  spent: SpentSoFar,
  estimateUsd: number,
): CapDecision {
  // Month first: it is the promise; the day is the brake.
  if (spent.monthUsd + estimateUsd > caps.monthlyUsd) {
    return {
      allowed: false,
      window: 'month',
      spentUsd: spent.monthUsd,
      capUsd: caps.monthlyUsd,
      estimateUsd,
    };
  }
  if (spent.dayUsd + estimateUsd > caps.dailyUsd) {
    return {
      allowed: false,
      window: 'day',
      spentUsd: spent.dayUsd,
      capUsd: caps.dailyUsd,
      estimateUsd,
    };
  }
  const warnings: SpendWindow[] = [];
  if (spent.monthUsd + estimateUsd >= caps.monthlyUsd * caps.warnFraction) {
    warnings.push('month');
  }
  if (spent.dayUsd + estimateUsd >= caps.dailyUsd * caps.warnFraction) {
    warnings.push('day');
  }
  return { allowed: true, warnings };
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
