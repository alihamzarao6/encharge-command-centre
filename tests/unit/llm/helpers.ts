/**
 * Shared fakes for the Claude-layer unit tests: a scripted fetch, an in-memory usage
 * store, a capturing log sink and a config with a deliberately fake key that matches the
 * redaction pattern so "the key never appears" is a real assertion.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError, err, ok, type Result } from '../../../src/lib/errors.js';
import { createHttpClient, type FetchLike, type HttpClient } from '../../../src/lib/http.js';
import type { LlmConfig } from '../../../src/lib/llm/config.js';
import type { UsageRecord, UsageStore } from '../../../src/lib/llm/client.js';
import { DEFAULT_PRICING } from '../../../src/lib/llm/pricing.js';
import { createLogger, type Logger } from '../../../src/lib/logger.js';

// Fake by construction: matches the logger's sk-ant- pattern, is not a real key shape.
export const FAKE_KEY = 'sk-ant-unittest-not-a-real-key-0000000000';

export function testConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    apiKey: FAKE_KEY,
    baseUrl: 'https://anthropic.test',
    apiVersion: '2023-06-01',
    models: { default: 'claude-sonnet-5', fast: 'claude-haiku-4-5-20251001' },
    maxTokens: 256,
    timeoutMs: 1_000,
    retries: 2,
    thinking: 'disabled',
    history: { maxMessages: 20, maxChars: 24_000 },
    caps: { dailyUsd: 5, monthlyUsd: 50, warnFraction: 0.8 },
    pricing: DEFAULT_PRICING,
    ...overrides,
  };
}

export function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', '..', 'fixtures', 'anthropic', `${name}.json`),
    'utf8',
  );
}

export type Step =
  | { kind: 'status'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'throw'; error: Error }
  | { kind: 'hang' };

export interface ScriptedFetch {
  readonly fetch: FetchLike;
  readonly calls: { url: string; init: RequestInit }[];
}

export function scriptedFetch(steps: readonly Step[]): ScriptedFetch {
  const remaining = [...steps];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const step = remaining.shift();
    if (step === undefined) {
      return Promise.reject(new Error('scriptedFetch: no step left'));
    }
    switch (step.kind) {
      case 'status':
        return Promise.resolve(
          new Response(step.body, {
            status: step.status,
            headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
          }),
        );
      case 'throw':
        return Promise.reject(step.error);
      case 'hang':
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
    }
  };
  return { fetch, calls };
}

export function httpFor(fetch: FetchLike, log: Logger, timeoutMs = 1_000): HttpClient {
  return createHttpClient({
    fetch,
    timeoutMs,
    retries: 0,
    sleep: () => Promise.resolve(),
    logger: log,
    breaker: { failureThreshold: 100 },
  });
}

export interface MemoryUsageStore extends UsageStore {
  readonly rows: UsageRecord[];
  readonly spentQueries: Date[];
  spent: { day: number; month: number };
  failSpent: AppError | null;
  failRecord: AppError | null;
}

export function memoryUsageStore(spent = { day: 0, month: 0 }): MemoryUsageStore {
  const store: MemoryUsageStore = {
    rows: [],
    spentQueries: [],
    spent,
    failSpent: null,
    failRecord: null,
    spentSince: (_provider, since): Promise<Result<number>> => {
      store.spentQueries.push(since);
      if (store.failSpent !== null) return Promise.resolve(err(store.failSpent));
      // Tests pin `now` to the 25th, so a window starting on the 1st is the month window.
      const isMonth = since.getUTCDate() === 1;
      return Promise.resolve(ok(isMonth ? store.spent.month : store.spent.day));
    },
    record: (row): Promise<Result<void>> => {
      if (store.failRecord !== null) return Promise.resolve(err(store.failRecord));
      store.rows.push(row);
      return Promise.resolve(ok(undefined));
    },
  };
  return store;
}

export function capturingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const log = createLogger({
    level: 'debug',
    sink: (line) => {
      lines.push(line);
    },
  });
  return { log, lines };
}

export function infraError(): AppError {
  return new AppError('NETWORK', 'store unreachable', { retryable: true });
}
