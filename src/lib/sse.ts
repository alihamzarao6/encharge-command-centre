/**
 * Server-sent events, both directions: parse a byte stream into events (the Edge Function
 * reading Anthropic, the browser reading the Edge Function) and format events for writing.
 * Runtime-neutral — Web Streams and TextDecoder only — so the same parser runs on Deno and
 * in the browser, and the same unit tests cover both.
 *
 * The parser is the WHATWG algorithm reduced to what these two producers emit: `event:` and
 * `data:` fields, multi-line data joined with '\n', blank-line dispatch, comment lines
 * (`:` prefix) ignored, CRLF tolerated. `id:` and `retry:` are ignored on purpose.
 */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export interface SseParser {
  /** Feed a decoded chunk; returns the events completed by it, in order. */
  push(chunk: string): SseEvent[];
  /** End of stream: dispatch a trailing event without a final blank line, if any. */
  end(): SseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const dispatch = (out: SseEvent[]): void => {
    if (dataLines.length > 0) {
      out.push({ event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') });
    }
    eventName = '';
    dataLines = [];
  };

  const handleLine = (line: string, out: SseEvent[]): void => {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  return {
    push(chunk) {
      const out: SseEvent[] = [];
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        handleLine(line, out);
      }
      return out;
    },
    end() {
      const out: SseEvent[] = [];
      if (buffer !== '') {
        handleLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer, out);
        buffer = '';
      }
      dispatch(out);
      return out;
    },
  };
}

export function formatSseEvent(event: string, data: unknown): string {
  // A JSON payload never contains a raw newline, so one data line is enough.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type SseReadOutcome =
  | { readonly kind: 'ended' }
  | { readonly kind: 'idle_timeout'; readonly idleMs: number }
  | { readonly kind: 'transport'; readonly error: Error }
  | { readonly kind: 'stopped' };

export interface SseReadOptions {
  /** Abort if no bytes arrive for this long. The producer's per-event pace, not a total. */
  readonly idleTimeoutMs: number;
  /**
   * Return false to stop reading (the consumer has what it needs). The stream is cancelled.
   */
  readonly onEvent: (event: SseEvent) => boolean | undefined;
}

/**
 * Drain a byte stream into events. Never throws: a broken connection or a silent producer
 * is an outcome the caller maps to "record what was consumed, show the partial text".
 */
export async function readSse(
  stream: ReadableStream<Uint8Array>,
  options: SseReadOptions,
): Promise<SseReadOutcome> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();

  const deliver = (events: SseEvent[]): boolean => {
    for (const event of events) {
      if (options.onEvent(event) === false) return false;
    }
    return true;
  };

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<'idle'>((resolve) => {
        timer = setTimeout(() => {
          resolve('idle');
        }, options.idleTimeoutMs);
      });
      const next = await Promise.race([reader.read(), idle]);
      clearTimeout(timer);
      if (next === 'idle') {
        await reader.cancel().catch(() => undefined);
        return { kind: 'idle_timeout', idleMs: options.idleTimeoutMs };
      }
      if (next.done) {
        deliver(parser.end());
        return { kind: 'ended' };
      }
      if (!deliver(parser.push(decoder.decode(next.value, { stream: true })))) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'stopped' };
      }
    }
  } catch (caught: unknown) {
    return {
      kind: 'transport',
      error: caught instanceof Error ? caught : new Error(String(caught)),
    };
  } finally {
    reader.releaseLock();
  }
}
