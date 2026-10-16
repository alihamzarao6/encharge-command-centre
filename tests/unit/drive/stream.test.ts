/**
 * The capped read (src/lib/drive/stream.ts): over the cap is a refusal and never a truncation,
 * counted on what arrives whatever the declared length says; a stalled stream is abandoned at
 * the deadline and cancelled; a broken one is said to be broken.
 */
import { describe, expect, it } from 'vitest';

import { readCapped } from '../../../src/lib/drive/stream.js';

function streamOf(
  chunks: readonly Uint8Array[],
  options: { stallAfter?: number; breakAfter?: number } = {},
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancelled: { value: boolean };
} {
  const cancelled = { value: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.breakAfter !== undefined && index === options.breakAfter) {
        controller.error(new Error('connection reset'));
        return;
      }
      if (options.stallAfter !== undefined && index === options.stallAfter) {
        return new Promise<void>(() => undefined);
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
      return undefined;
    },
    cancel() {
      cancelled.value = true;
    },
  });
  return { stream, cancelled };
}

const clock = { at: 0 };
const now = (): number => clock.at;

describe('readCapped', () => {
  it('returns every byte when the body fits', async () => {
    const { stream } = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]);
    const read = await readCapped(stream, {
      maxBytes: 10,
      deadlineAt: Date.now() + 5_000,
      now: () => Date.now(),
    });
    expect(read).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
  });

  it('a body of exactly the cap is accepted; one byte more is refused, not cut', async () => {
    const exact = streamOf([new Uint8Array(5)]);
    expect(
      (
        await readCapped(exact.stream, {
          maxBytes: 5,
          deadlineAt: Date.now() + 5_000,
          now: () => Date.now(),
        })
      ).ok,
    ).toBe(true);
    // More arriving than the cap allows, as a real download would have: what is left of the
    // stream is cancelled, not drained.
    const over = streamOf([
      new Uint8Array(3),
      new Uint8Array(3),
      new Uint8Array(3),
      new Uint8Array(3),
    ]);
    const read = await readCapped(over.stream, {
      maxBytes: 5,
      deadlineAt: Date.now() + 5_000,
      now: () => Date.now(),
    });
    expect(read).toEqual({ ok: false, why: 'too_large', received: 6 });
    expect(over.cancelled.value).toBe(true);
  });

  it('counts what arrives, whatever Content-Length claimed', async () => {
    const { stream } = streamOf([new Uint8Array(4), new Uint8Array(4)]);
    const read = await readCapped(stream, {
      maxBytes: 6,
      deadlineAt: Date.now() + 5_000,
      now: () => Date.now(),
      declaredLength: 2,
    });
    expect(read).toMatchObject({ ok: false, why: 'too_large' });
  });

  it('refuses a declared length over the cap before reading a byte', async () => {
    const { stream, cancelled } = streamOf([new Uint8Array(1)]);
    const read = await readCapped(stream, {
      maxBytes: 6,
      deadlineAt: Date.now() + 5_000,
      now: () => Date.now(),
      declaredLength: 7,
    });
    expect(read).toEqual({ ok: false, why: 'too_large', received: 0 });
    expect(cancelled.value).toBe(true);
  });

  it('abandons and cancels a stream that stalls past the deadline', async () => {
    const { stream, cancelled } = streamOf([new Uint8Array(2)], { stallAfter: 1 });
    const read = await readCapped(stream, {
      maxBytes: 100,
      deadlineAt: Date.now() + 50,
      now: () => Date.now(),
    });
    expect(read).toEqual({ ok: false, why: 'timeout', received: 2 });
    expect(cancelled.value).toBe(true);
  });

  it('stops at once when the deadline has already passed', async () => {
    clock.at = 1_000;
    const { stream } = streamOf([new Uint8Array(2)]);
    expect(await readCapped(stream, { maxBytes: 100, deadlineAt: 999, now })).toEqual({
      ok: false,
      why: 'timeout',
      received: 0,
    });
  });

  it('says a stream that errors is broken, with what had arrived', async () => {
    const { stream } = streamOf([new Uint8Array(3)], { breakAfter: 1 });
    const read = await readCapped(stream, {
      maxBytes: 100,
      deadlineAt: Date.now() + 5_000,
      now: () => Date.now(),
    });
    expect(read).toEqual({ ok: false, why: 'broken', received: 3 });
  });

  it('an absent body is an empty one', async () => {
    expect(
      await readCapped(null, {
        maxBytes: 5,
        deadlineAt: Date.now() + 1_000,
        now: () => Date.now(),
      }),
    ).toEqual({
      ok: true,
      bytes: new Uint8Array(0),
    });
  });
});
