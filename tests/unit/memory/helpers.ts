/**
 * Shared fakes for the memory-layer unit tests: a Voyage config with a deliberately fake
 * key that matches the logger's `pa-` redaction pattern, Voyage fixtures, and an in-memory
 * ChunkStore that behaves like the real table (ordinals, coverage, the no-overlap rule).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { err, ok, type AppError, type Result } from '../../../src/lib/errors.js';
import type {
  ChunkCoverage,
  ChunkInsert,
  ChunkStore,
  ConversationRef,
  OrdinalMessage,
} from '../../../src/lib/memory/chunks.js';
import { POLICY_DEFAULTS, type VoyageConfig } from '../../../src/lib/memory/config.js';
import type { Embedder, Embedding } from '../../../src/lib/memory/embed.js';
import { nextUncoveredOrdinal, type MessageRange } from '../../../src/lib/memory/policy.js';

// Fake by construction: matches the logger's pa- pattern, is not a real key.
export const FAKE_VOYAGE_KEY = 'pa-unittest-not-a-real-key-0000000000000000';

export const CONV_ID = 'c0000000-0000-4000-8000-000000000001';
export const USER_ID = '11111111-1111-4111-8111-111111111111';

export const CONVERSATION: ConversationRef = {
  id: CONV_ID,
  userId: USER_ID,
  scope: 'workspace',
  title: 'Offset accounts post for tradies',
};

export function voyageConfig(overrides: Partial<VoyageConfig> = {}): VoyageConfig {
  return {
    apiKey: FAKE_VOYAGE_KEY,
    baseUrl: 'https://voyage.test',
    model: 'voyage-3',
    dimensions: 1024,
    timeoutMs: 1_000,
    retries: 2,
    pricePerMTok: 0.06,
    caps: { dailyUsd: 0.5, monthlyUsd: 5, warnFraction: 0.8 },
    ...overrides,
  };
}

export function voyageFixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', '..', 'fixtures', 'voyage', `${name}.json`),
    'utf8',
  );
}

export function anthropicFixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', '..', 'fixtures', 'anthropic', `${name}.json`),
    'utf8',
  );
}

export const FIXTURE_VECTOR: readonly number[] =
  (JSON.parse(voyageFixture('embeddings-ok')) as { data: { embedding: number[] }[] }).data[0]
    ?.embedding ?? [];

export interface StoredChunk extends ChunkInsert {
  readonly id: string;
}

export interface FakeChunkStore extends ChunkStore {
  readonly messages: OrdinalMessage[];
  readonly chunks: StoredChunk[];
  readonly reads: { coverage: number; ranges: MessageRange[] };
  idle: ConversationRef[];
  failCoverage: AppError | null;
  failMessages: AppError | null;
  failInsert: AppError | null;
}

/** `n` alternating user/assistant messages, each `createdAt` spaced a minute apart from `start`. */
export function messagesOf(n: number, start = new Date('2026-08-25T09:00:00Z')): OrdinalMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    ordinal: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${i % 2 === 0 ? 'User' : 'Assistant'} message ${i + 1} about offset accounts for tradies`,
    createdAt: new Date(start.getTime() + i * 60_000),
  }));
}

export function fakeChunkStore(messages: OrdinalMessage[] = []): FakeChunkStore {
  const store: FakeChunkStore = {
    messages,
    chunks: [],
    reads: { coverage: 0, ranges: [] },
    idle: [],
    failCoverage: null,
    failMessages: null,
    failInsert: null,
    coverage: (): Promise<Result<ChunkCoverage>> => {
      store.reads.coverage += 1;
      if (store.failCoverage !== null) return Promise.resolve(err(store.failCoverage));
      const ranges = store.chunks.map((c) => c.range);
      return Promise.resolve(
        ok({
          messageCount: store.messages.length,
          nextOrdinal: nextUncoveredOrdinal(ranges),
          ranges,
        }),
      );
    },
    messagesInRange: (_conversationId, range): Promise<Result<readonly OrdinalMessage[]>> => {
      store.reads.ranges.push(range);
      if (store.failMessages !== null) return Promise.resolve(err(store.failMessages));
      return Promise.resolve(
        ok(store.messages.filter((m) => m.ordinal >= range.lo && m.ordinal < range.hi)),
      );
    },
    insertChunk: (input): Promise<Result<'inserted' | 'exists'>> => {
      if (store.failInsert !== null) return Promise.resolve(err(store.failInsert));
      const overlaps = store.chunks.some(
        (c) =>
          c.conversationId === input.conversationId &&
          c.range.lo < input.range.hi &&
          input.range.lo < c.range.hi,
      );
      if (overlaps) return Promise.resolve(ok('exists'));
      store.chunks.push({ ...input, id: `chunk-${store.chunks.length + 1}` });
      return Promise.resolve(ok('inserted'));
    },
    idleConversations: (): Promise<Result<readonly ConversationRef[]>> =>
      Promise.resolve(ok(store.idle)),
  };
  return store;
}

export function fakeEmbedder(
  outcome: Result<Embedding> = ok({
    vectors: [FIXTURE_VECTOR],
    model: 'voyage-3',
    totalTokens: 212,
    costUsd: 0.000013,
    attempts: 1,
  }),
): Embedder & { calls: string[][]; budgetChecks: number } {
  const fake = {
    calls: [] as string[][],
    budgetChecks: 0,
    checkBudget: (): Promise<Result<void>> => {
      fake.budgetChecks += 1;
      return Promise.resolve(outcome.ok ? ok(undefined) : err(outcome.error));
    },
    embed: (request: { texts: readonly string[] }): Promise<Result<Embedding>> => {
      fake.calls.push([...request.texts]);
      return Promise.resolve(outcome);
    },
  };
  return fake;
}

export const POLICY = POLICY_DEFAULTS;
