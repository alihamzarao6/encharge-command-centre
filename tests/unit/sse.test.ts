/**
 * The SSE parser and reader (src/lib/sse.ts) — shared by the Edge Function reading Anthropic
 * and the browser reading the Edge Function, so both directions are proven here.
 */
import { describe, expect, it } from 'vitest';

import { createSseParser, formatSseEvent, readSse, type SseEvent } from '../../src/lib/sse.js';

function bytes(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('createSseParser', () => {
  it('dispatches on the blank line, joins multi-line data, defaults the event name', () => {
    const parser = createSseParser();
    expect(parser.push('event: a\ndata: 1\n\n')).toEqual([{ event: 'a', data: '1' }]);
    expect(parser.push('data: x\ndata: y\n\n')).toEqual([{ event: 'message', data: 'x\ny' }]);
  });

  it('handles chunks split anywhere, CRLF, comments and unknown fields', () => {
    const parser = createSseParser();
    const out: SseEvent[] = [];
    for (const piece of ['ev', 'ent: t\r\n: keepalive\r\nid: 7\r\nda', 'ta: {"k":1}\r\n\r', '\n']) {
      out.push(...parser.push(piece));
    }
    expect(out).toEqual([{ event: 't', data: '{"k":1}' }]);
  });

  it('flushes a trailing event without a final blank line on end()', () => {
    const parser = createSseParser();
    expect(parser.push('event: last\ndata: z')).toEqual([]);
    expect(parser.end()).toEqual([{ event: 'last', data: 'z' }]);
    expect(parser.end()).toEqual([]);
  });

  it('round-trips formatSseEvent', () => {
    const parser = createSseParser();
    const text = formatSseEvent('delta', { text: 'a\nb' });
    expect(parser.push(text)).toEqual([{ event: 'delta', data: '{"text":"a\\nb"}' }]);
  });
});

describe('readSse', () => {
  it('delivers events across chunk boundaries and reports a clean end', async () => {
    const seen: SseEvent[] = [];
    const outcome = await readSse(bytes('event: a\nda', 'ta: 1\n\nevent: b\ndata: 2\n\n'), {
      idleTimeoutMs: 1_000,
      onEvent: (event) => {
        seen.push(event);
        return undefined;
      },
    });
    expect(outcome).toEqual({ kind: 'ended' });
    expect(seen).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('stops when the consumer returns false and cancels the stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const seen: string[] = [];
    const outcome = await readSse(stream, {
      idleTimeoutMs: 1_000,
      onEvent: (event) => {
        seen.push(event.event);
        return false;
      },
    });
    expect(outcome).toEqual({ kind: 'stopped' });
    expect(seen).toEqual(['a']);
    expect(cancelled).toBe(true);
  });

  it('a silent producer → idle_timeout with what arrived already delivered', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n'));
        // never closes
      },
    });
    const seen: string[] = [];
    const outcome = await readSse(stream, {
      idleTimeoutMs: 30,
      onEvent: (event) => {
        seen.push(event.event);
        return undefined;
      },
    });
    expect(outcome).toEqual({ kind: 'idle_timeout', idleMs: 30 });
    expect(seen).toEqual(['a']);
  });

  it('a broken connection → transport, never a throw', async () => {
    // Pull-based: a source that enqueues and errors inside start() discards its queue,
    // which is not what a dropped connection does.
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n'));
          return;
        }
        controller.error(new Error('ECONNRESET'));
      },
    });
    const seen: string[] = [];
    const outcome = await readSse(stream, {
      idleTimeoutMs: 1_000,
      onEvent: (event) => {
        seen.push(event.event);
        return undefined;
      },
    });
    expect(outcome).toMatchObject({ kind: 'transport', error: { message: 'ECONNRESET' } });
    expect(seen).toEqual(['a']);
  });
});
