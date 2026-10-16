/**
 * Shared fixtures for the knowledge tests: a deterministic embedder that needs no network
 * (bag of words hashed into a small vector, so passages sharing words with a question really
 * are nearer it), page and attachment builders, and a scriptable failure queue standing in
 * for Voyage's refusals.
 */
import {
  AppError,
  HttpStatusError,
  NetworkError,
  TimeoutError,
  ValidationError,
  err,
  ok,
  type Result,
} from '../../../src/lib/errors.js';
import type { ChunkablePage } from '../../../src/lib/knowledge/chunk.js';
import type { LocalAttachment } from '../../../src/lib/knowledge/local-store.js';
import { RateLimitedError, SpendCapError } from '../../../src/lib/llm/errors.js';
import type { EmbedError, Embedder, EmbeddingRequest } from '../../../src/lib/memory/embed.js';

export const USER = '11111111-1111-4111-8111-111111111111';
export const TEAMMATE = '22222222-2222-4222-8222-222222222222';
export const OUTSIDER = '99999999-9999-4999-8999-999999999999';
export const CONV_A = 'c0000000-0000-4000-8000-00000000000a';
export const CONV_B = 'c0000000-0000-4000-8000-00000000000b';
export const CONV_NEW = 'c0000000-0000-4000-8000-0000000000ee';

const DIMS = 4096;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % DIMS;
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'of',
  'to',
  'in',
  'is',
  'for',
  'me',
  'on',
  'it',
  'this',
  'what',
  'how',
  'do',
  'at',
  'with',
]);

/** A tiny "meaning" vector: words hashed into buckets, stop words dropped, normalised. */
export function bagOfWords(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || STOP.has(word)) continue;
    const index = hash(word);
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
  if (norm === 0) vector[0] = 1;
  return norm === 0 ? vector : vector.map((x) => x / norm);
}

export type ScriptedFailure =
  | 'rate_limited'
  | 'unauthorised'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'spend_cap'
  | 'bad_vectors';

export function failureOf(kind: ScriptedFailure): EmbedError {
  switch (kind) {
    case 'rate_limited':
      return new RateLimitedError(null, { context: { provider: 'voyage' } });
    case 'unauthorised':
      return new HttpStatusError('Voyage responded 401', 401, { context: { provider: 'voyage' } });
    case 'server_error':
      return new HttpStatusError('Voyage responded 503', 503, { context: { provider: 'voyage' } });
    case 'timeout':
      return new TimeoutError('Request timed out after 55000ms', 55_000);
    case 'network':
      return new NetworkError('Request failed: fetch failed');
    case 'spend_cap':
      return new SpendCapError('day', 0.5, 0.5, 0.001);
    case 'bad_vectors':
      return new ValidationError('Voyage returned unusable vectors', [
        { path: 'data.0', message: 'x' },
      ]);
  }
}

export interface FakeEmbedder extends Embedder {
  readonly calls: EmbeddingRequest[];
  /** Each entry answers one call, in order; when empty, calls succeed. */
  readonly script: (ScriptedFailure | 'ok')[];
}

export function fakeEmbedder(script: (ScriptedFailure | 'ok')[] = []): FakeEmbedder {
  const calls: EmbeddingRequest[] = [];
  const queue = [...script];
  return {
    calls,
    script: queue,
    embed: (request) => {
      calls.push(request);
      const next = queue.shift() ?? 'ok';
      if (next !== 'ok') return Promise.resolve(err(failureOf(next)));
      const tokens = Math.ceil(request.texts.reduce((n, t) => n + t.length, 0) / 4);
      return Promise.resolve(
        ok({
          vectors: request.texts.map(bagOfWords),
          model: 'voyage-3',
          totalTokens: tokens,
          costUsd: (tokens * 0.06) / 1_000_000,
          attempts: 1,
        }),
      );
    },
    checkBudget: (): Promise<Result<void, EmbedError>> => Promise.resolve(ok(undefined)),
  };
}

export function page(
  pageNo: number,
  content: string,
  label = `Page ${String(pageNo)}`,
): ChunkablePage {
  return { pageNo, label, content, method: 'pdf_text_layer', legibility: 'full' };
}

let counter = 0;
export function fileId(): string {
  counter += 1;
  return `f0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

export function attachment(
  overrides: Partial<LocalAttachment> & Pick<LocalAttachment, 'pages'>,
): LocalAttachment {
  return {
    fileId: fileId(),
    conversationId: CONV_A,
    uploadedBy: USER,
    name: 'Course transcript.pdf',
    kind: 'pdf',
    contentHash: 'a'.repeat(64),
    learnedAt: '2026-10-14T03:00:00Z',
    ...overrides,
  };
}

/** A paragraph of `words` words about `topic`, long enough to make several chunks. */
export function prose(topic: string, sentences = 30): string {
  return Array.from(
    { length: sentences },
    (_, i) => `In ${topic} we cover point ${String(i + 1)} of ${topic} in detail.`,
  ).join(' ');
}

export function appError(message: string): AppError {
  return new AppError('NETWORK', message, { retryable: true });
}
