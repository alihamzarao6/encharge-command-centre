/**
 * The browser's streaming turn (web/src/lib/chatApi.ts streamTurn) and the Note: handling
 * behind Copy. The transport is a stubbed fetch whose body is a real byte stream, so the
 * same code path the phone runs is what is proven here.
 */
import { describe, expect, it } from 'vitest';

import { stripNotes as conformanceStripNotes } from '../../../src/lib/voice/conformance.js';
import { MESSAGES, streamTurn, type ChatOutcome } from '../../../web/src/lib/chatApi.js';
import { splitNotes, stripNotes } from '../../../web/src/lib/notes.js';

const DONE = {
  conversationId: 'c0000000-0000-4000-8000-000000000001',
  userMessageId: 'u',
  assistantMessageId: 'a',
  reply: 'Hello there',
};

function ev(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(chunks: readonly string[], ending: 'close' | 'error' | 'hang' = 'close'): Response {
  const encoder = new TextEncoder();
  const pending = [...chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next !== undefined) {
        controller.enqueue(encoder.encode(next));
        return;
      }
      if (ending === 'close') controller.close();
      if (ending === 'error') controller.error(new Error('reset'));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function deps(response: () => Response | Promise<Response>, idleTimeoutMs = 1_000) {
  const calls: RequestInit[] = [];
  return {
    calls,
    deps: {
      chatUrl: 'https://stack.test/functions/v1/chat',
      anonKey: 'anon',
      fetch: ((_url: unknown, init?: RequestInit) => {
        calls.push(init ?? {});
        return Promise.resolve(response());
      }) as typeof fetch,
      idleTimeoutMs,
    },
  };
}

const INPUT = { accessToken: 't', message: 'hi', conversationId: null };

async function run(
  response: () => Response | Promise<Response>,
  idleTimeoutMs?: number,
): Promise<{ outcome: ChatOutcome; deltas: string[]; started: string[]; calls: RequestInit[] }> {
  const d = deps(response, idleTimeoutMs);
  const deltas: string[] = [];
  const started: string[] = [];
  const outcome = await streamTurn(d.deps, INPUT, {
    onStart: (id) => started.push(id),
    onDelta: (t) => deltas.push(t),
  });
  return { outcome, deltas, started, calls: d.calls };
}

describe('streamTurn', () => {
  it('asks for an event stream, forwards deltas, settles on done', async () => {
    const { outcome, deltas, started, calls } = await run(() =>
      sse([
        ': open\n\n',
        ev('start', { type: 'start', conversationId: DONE.conversationId }),
        ev('delta', { type: 'delta', text: 'Hello ' }),
        ev('delta', { type: 'delta', text: 'there' }),
        ev('done', { type: 'done', reply: DONE }),
      ]),
    );
    expect(new Headers(calls[0]?.headers).get('accept')).toBe('text/event-stream');
    expect(started).toEqual([DONE.conversationId]);
    expect(deltas).toEqual(['Hello ', 'there']);
    expect(outcome).toEqual({ kind: 'ok', ...DONE });
  });

  it('a plain JSON answer (refusal before the stream, or a proxy) is read as JSON', async () => {
    const { outcome, deltas } = await run(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'SPEND_CAP', message: 'The monthly cap…', retryable: false },
          }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(deltas).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'error', failure: 'cap', message: MESSAGES.cap });
    const ok = await run(
      () =>
        new Response(JSON.stringify(DONE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(ok.outcome).toEqual({ kind: 'ok', ...DONE });
  });

  it('an error event mid-stream carries the partial text and the plain-language message', async () => {
    const { outcome, deltas } = await run(() =>
      sse([
        ev('start', { type: 'start', conversationId: DONE.conversationId }),
        ev('delta', { type: 'delta', text: 'Half a ' }),
        ev('error', {
          type: 'error',
          status: 503,
          body: {
            error: {
              code: 'NETWORK',
              message: 'Claude is unreachable right now.',
              retryable: true,
            },
          },
          partialText: 'Half a ',
        }),
      ]),
    );
    expect(deltas).toEqual(['Half a ']);
    expect(outcome).toMatchObject({
      kind: 'error',
      failure: 'retryable',
      message: MESSAGES.interrupted,
      partialText: 'Half a ',
    });
  });

  it('a dropped connection after some text → interrupted with the partial text', async () => {
    const { outcome } = await run(() =>
      sse(
        [
          ev('start', { type: 'start', conversationId: 'c' }),
          ev('delta', { type: 'delta', text: 'so far' }),
        ],
        'error',
      ),
    );
    expect(outcome).toMatchObject({
      kind: 'error',
      failure: 'retryable',
      code: 'STREAM_INTERRUPTED',
      message: MESSAGES.interrupted,
      partialText: 'so far',
    });
  });

  it('a dropped connection before any text → the plain network message, no partial', async () => {
    const { outcome } = await run(() => sse([], 'error'));
    expect(outcome).toMatchObject({
      kind: 'error',
      code: 'STREAM_INTERRUPTED',
      message: MESSAGES.network,
    });
    expect(outcome).not.toHaveProperty('partialText');
  });

  it('a silent stream → timeout, with what arrived', async () => {
    const { outcome } = await run(
      () => sse([ev('delta', { type: 'delta', text: 'x' })], 'hang'),
      30,
    );
    expect(outcome).toMatchObject({ kind: 'error', code: 'CLIENT_TIMEOUT', partialText: 'x' });
  });

  it('an empty reply on done is still an error, never ok', async () => {
    const { outcome } = await run(() =>
      sse([ev('done', { type: 'done', reply: { ...DONE, reply: '  ' } })]),
    );
    expect(outcome).toMatchObject({ kind: 'error', code: 'EMPTY_REPLY' });
  });

  it('a transport failure before headers → network, never a throw', async () => {
    const { outcome } = await run(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(outcome).toMatchObject({ kind: 'error', code: 'NETWORK', message: MESSAGES.network });
  });
});

describe('Note: lines', () => {
  const SAMPLES = [
    'Banks knocked you back? We know 40 lenders who might not.\n\nNote: confirm the lender count with Ross.',
    'A post with no notes at all.',
    'Line one\nnote: lowercase counts too\nLine three\nNote: and a second one',
    '   \nNote: only a note',
  ];

  it('agrees with the conformance suite on what is copy', () => {
    for (const sample of SAMPLES) {
      expect(stripNotes(sample)).toBe(conformanceStripNotes(sample));
    }
  });

  it('separates the notes for display', () => {
    expect(splitNotes(SAMPLES[0] ?? '')).toEqual({
      copy: 'Banks knocked you back? We know 40 lenders who might not.',
      notes: ['confirm the lender count with Ross.'],
    });
    expect(splitNotes(SAMPLES[2] ?? '').notes).toEqual([
      'lowercase counts too',
      'and a second one',
    ]);
    expect(splitNotes(SAMPLES[1] ?? '').notes).toEqual([]);
  });
});
