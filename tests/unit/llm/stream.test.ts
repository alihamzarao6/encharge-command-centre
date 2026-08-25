/**
 * Streaming (part 6): the Anthropic event reducer and `client.stream()` against a scripted
 * fetch whose body is a real byte stream. What the review asked for, item by item:
 *   - one api_usage row per turn, with token counts from message_start / message_delta;
 *   - a stream that dies mid-reply records what it consumed and hands back the partial text;
 *   - the cap refuses before any request; an error envelope before the stream is retried
 *     exactly as the JSON path would; an API error event mid-stream is not retried.
 */
import { describe, expect, it } from 'vitest';

import { createClaudeClient } from '../../../src/lib/llm/client.js';
import {
  INITIAL_STREAM_STATE,
  applyAnthropicEvent,
  finalUsage,
  partialUsage,
  type StreamState,
} from '../../../src/lib/llm/stream.js';
import type { FetchLike } from '../../../src/lib/http.js';
import type { SystemBlock } from '../../../src/lib/llm/prompt.js';
import { capturingLogger, httpFor, memoryUsageStore, testConfig } from './helpers.js';

const NOW = new Date('2026-08-25T03:00:00Z');
const SYSTEM: readonly SystemBlock[] = [{ text: 'You are the writer.', cache: true }];

function ev(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const START = ev('message_start', {
  type: 'message_start',
  message: {
    id: 'msg_1',
    model: 'claude-sonnet-5',
    usage: { input_tokens: 3000, cache_read_input_tokens: 2900, cache_creation_input_tokens: 0 },
  },
});
const DELTA = (text: string): string =>
  ev('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text } });
const MESSAGE_DELTA = ev('message_delta', {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 42 },
});
const STOP = ev('message_stop', { type: 'message_stop' });
const PING = ev('ping', { type: 'ping' });

/** A Response whose body emits the given chunks, then either closes or errors. */
function streamResponse(
  chunks: readonly string[],
  ending: 'close' | 'error' | 'hang' = 'close',
  status = 200,
): Response {
  const encoder = new TextEncoder();
  const pending = [...chunks];
  // Pull-based so the chunks are actually read before the stream ends: a source that
  // enqueues and errors inside start() discards its queue, which is not what a dropped
  // connection does.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next !== undefined) {
        controller.enqueue(encoder.encode(next));
        return;
      }
      if (ending === 'close') controller.close();
      if (ending === 'error') controller.error(new Error('ECONNRESET'));
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_s1' },
  });
}

function scripted(responses: (() => Response | Promise<Response>)[]): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const remaining = [...responses];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = remaining.shift();
    if (next === undefined) return Promise.reject(new Error('no response scripted'));
    return Promise.resolve(next());
  };
  return { fetch, calls };
}

function client(fetch: FetchLike, spent = { day: 0, month: 0 }, overrides = {}) {
  const { log } = capturingLogger();
  const usage = memoryUsageStore(spent);
  const config = testConfig({ retries: 1, timeoutMs: 200, ...overrides });
  const claude = createClaudeClient({
    config,
    http: httpFor(fetch, log, 200),
    usage,
    log,
    now: () => NOW,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  return { claude, usage };
}

const REQUEST = {
  system: SYSTEM,
  messages: [{ role: 'user' as const, content: 'Write a post' }],
  operation: 'chat.turn',
  userId: 'u1',
  conversationId: 'c1',
};

describe('applyAnthropicEvent', () => {
  it('folds a full stream into text, usage, stop reason and completion', () => {
    let state: StreamState = INITIAL_STREAM_STATE;
    const deltas: string[] = [];
    for (const chunk of [START, PING, DELTA('Hel'), DELTA('lo'), MESSAGE_DELTA, STOP]) {
      const [event, data] = chunk.split('\n').map((line) => line.slice(line.indexOf(':') + 2));
      const step = applyAnthropicEvent(state, { event: event ?? '', data: data ?? '' });
      state = step.state;
      if (step.textDelta !== '') deltas.push(step.textDelta);
      expect(step.ignored).toBe(false);
    }
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(state.text).toBe('Hello');
    expect(state.model).toBe('claude-sonnet-5');
    expect(state.requestId).toBe('msg_1');
    expect(state.stopReason).toBe('end_turn');
    expect(state.complete).toBe(true);
    expect(finalUsage(state)).toEqual({
      inputTokens: 3000,
      outputTokens: 42,
      cacheReadTokens: 2900,
      cacheWriteTokens: 0,
    });
  });

  it('ignores malformed and unknown events without changing state', () => {
    const a = applyAnthropicEvent(INITIAL_STREAM_STATE, { event: 'message_start', data: '{' });
    expect(a).toEqual({ state: INITIAL_STREAM_STATE, textDelta: '', ignored: true });
    const b = applyAnthropicEvent(INITIAL_STREAM_STATE, { event: 'weird', data: '{}' });
    expect(b.ignored).toBe(true);
    const c = applyAnthropicEvent(INITIAL_STREAM_STATE, {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'x' },
      }),
    });
    expect(c).toEqual({ state: INITIAL_STREAM_STATE, textDelta: '', ignored: false });
  });

  it('records an API error event and a refusal category', () => {
    const errored = applyAnthropicEvent(INITIAL_STREAM_STATE, {
      event: 'error',
      data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    });
    expect(errored.state.apiError).toEqual({ type: 'overloaded_error', message: 'busy' });
    const refused = applyAnthropicEvent(INITIAL_STREAM_STATE, {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_details: { category: 'harmful' } },
        usage: { output_tokens: 1 },
      }),
    });
    expect(refused.state.stopReason).toBe('refusal');
    expect(refused.state.refusalCategory).toBe('harmful');
  });

  it('partialUsage uses wire input figures when message_start arrived, else the fallback', () => {
    const started = applyAnthropicEvent(INITIAL_STREAM_STATE, {
      event: 'message_start',
      data: START.split('\n')[1]?.slice(6) ?? '',
    }).state;
    const withText = { ...started, text: 'x'.repeat(30) };
    expect(partialUsage(withText, 999)).toEqual({
      inputTokens: 3000,
      outputTokens: 10,
      cacheReadTokens: 2900,
      cacheWriteTokens: 0,
    });
    expect(partialUsage(INITIAL_STREAM_STATE, 999)).toEqual({
      inputTokens: 999,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('client.stream', () => {
  it('streams deltas, bills from message_start + message_delta, one api_usage row', async () => {
    const { fetch, calls } = scripted([
      () => streamResponse([START, DELTA('Hel'), PING, DELTA('lo'), MESSAGE_DELTA, STOP]),
    ]);
    const { claude, usage } = client(fetch);
    const deltas: string[] = [];
    const result = await claude.stream?.(REQUEST, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      ok: true,
      value: {
        text: 'Hello',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        usage: { inputTokens: 3000, outputTokens: 42, cacheReadTokens: 2900, cacheWriteTokens: 0 },
        requestId: 'req_s1',
        attempts: 1,
      },
    });
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({
      operation: 'chat.turn',
      model: 'claude-sonnet-5',
      inputTokens: 3000,
      outputTokens: 42,
      cacheReadTokens: 2900,
      userId: 'u1',
      conversationId: 'c1',
    });
    expect(usage.rows[0]?.costUsd).toBeGreaterThan(0);
    const raw = calls[0]?.init.body;
    const body = JSON.parse(typeof raw === 'string' ? raw : '{}') as { stream?: boolean };
    expect(body.stream).toBe(true);
    expect(new Headers(calls[0]?.init.headers).get('accept')).toBe('text/event-stream');
  });

  it('a stream that dies mid-reply records a :partial row and returns the partial text', async () => {
    const { fetch } = scripted([
      () => streamResponse([START, DELTA('Half a '), DELTA('post')], 'error'),
    ]);
    const { claude, usage } = client(fetch);
    const deltas: string[] = [];
    const result = await claude.stream?.(REQUEST, (d) => deltas.push(d));
    expect(deltas).toEqual(['Half a ', 'post']);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected failure');
    expect(result.error.code).toBe('NETWORK');
    expect(result.error.context['partialText']).toBe('Half a post');
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({
      operation: 'chat.turn:partial',
      inputTokens: 3000,
      cacheReadTokens: 2900,
      outputTokens: 4, // ceil(11 chars / 3)
    });
  });

  it('a silent stream → TIMEOUT with the partial text, :partial row', async () => {
    const { fetch } = scripted([() => streamResponse([START, DELTA('so far')], 'hang')]);
    const { claude, usage } = client(fetch, { day: 0, month: 0 }, { timeoutMs: 40 });
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected failure');
    expect(result.error.code).toBe('TIMEOUT');
    expect(result.error.context['partialText']).toBe('so far');
    expect(usage.rows.map((r) => r.operation)).toEqual(['chat.turn:partial']);
  });

  it('a stream that ends before message_stop is interrupted, not a success', async () => {
    const { fetch } = scripted([() => streamResponse([START, DELTA('text'), MESSAGE_DELTA])]);
    const { claude, usage } = client(fetch);
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result?.ok).toBe(false);
    expect(usage.rows.map((r) => r.operation)).toEqual(['chat.turn:partial']);
    // The wire said 42 output tokens; the partial row keeps the larger of wire and estimate.
    expect(usage.rows[0]?.outputTokens).toBe(42);
  });

  it('an API error event mid-stream is not retried; partial recorded; 5xx-shaped error', async () => {
    const { fetch, calls } = scripted([
      () =>
        streamResponse([
          START,
          DELTA('a'),
          ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
        ]),
      () => streamResponse([START, DELTA('never'), MESSAGE_DELTA, STOP]),
    ]);
    const { claude, usage } = client(fetch);
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected failure');
    expect(result.error.code).toBe('HTTP_STATUS');
    expect(result.error.context['partialText']).toBe('a');
    expect(calls).toHaveLength(1);
    expect(usage.rows.map((r) => r.operation)).toEqual(['chat.turn:partial']);
  });

  it('the cap refuses before any request is opened', async () => {
    const { fetch, calls } = scripted([() => streamResponse([START, STOP])]);
    const { claude, usage } = client(fetch, { day: 5, month: 5 });
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected failure');
    expect(result.error.code).toBe('SPEND_CAP');
    expect(calls).toHaveLength(0);
    expect(usage.rows).toHaveLength(0);
  });

  it('a 529 envelope before the stream is retried once, like the JSON path', async () => {
    const { fetch, calls } = scripted([
      () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }),
          {
            status: 529,
            headers: { 'content-type': 'application/json' },
          },
        ),
      () => streamResponse([START, DELTA('ok'), MESSAGE_DELTA, STOP]),
    ]);
    const { claude, usage } = client(fetch);
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result).toMatchObject({ ok: true, value: { text: 'ok', attempts: 2 } });
    expect(calls).toHaveLength(2);
    expect(usage.rows).toHaveLength(1);
  });

  it('a refusal stop reason is billed and returned as MODEL_REFUSAL', async () => {
    const { fetch } = scripted([
      () =>
        streamResponse([
          START,
          ev('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'refusal', stop_details: { category: 'x' } },
            usage: { output_tokens: 2 },
          }),
          STOP,
        ]),
    ]);
    const { claude, usage } = client(fetch);
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('expected failure');
    expect(result.error.code).toBe('MODEL_REFUSAL');
    expect(usage.rows.map((r) => r.operation)).toEqual(['chat.turn']);
  });

  it('a transport failure before headers records the reservation and does not retry', async () => {
    const { fetch, calls } = scripted([() => Promise.reject(new Error('ECONNREFUSED'))]);
    const { claude, usage } = client(fetch);
    const result = await claude.stream?.(REQUEST, () => undefined);
    expect(result?.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(usage.rows.map((r) => r.operation)).toEqual(['chat.turn:unconfirmed']);
  });
});
