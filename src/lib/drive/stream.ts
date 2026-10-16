/**
 * Reading a file's bytes from Google under a size cap and a deadline (Milestone 5 part 3a).
 * Pure apart from the timer.
 *
 * Over the cap is a REFUSAL, never a truncation: half a statement read as if it were the whole
 * one is the silent failure part 1 was built to refuse. The count is of what actually arrives,
 * so a missing or lying Content-Length changes nothing. A declared length over the cap is
 * refused before a byte is read.
 *
 * The deadline covers the whole body. A stalled stream is abandoned and cancelled when it
 * passes; the pending read is caught so its rejection never surfaces unhandled.
 */

export type CappedRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly why: 'too_large'; readonly received: number }
  | { readonly ok: false; readonly why: 'timeout' | 'broken'; readonly received: number };

export interface CappedReadOptions {
  readonly maxBytes: number;
  /** An instant, on the same clock as `now`. */
  readonly deadlineAt: number;
  readonly now: () => number;
  /** The Content-Length the server declared, if any. */
  readonly declaredLength?: number | null;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  options: CappedReadOptions,
): Promise<CappedRead> {
  const declared = options.declaredLength;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > options.maxBytes) {
    try {
      await body?.cancel();
    } catch {
      // Already closed: nothing to release.
    }
    return { ok: false, why: 'too_large', received: 0 };
  }
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stop = async (result: CappedRead): Promise<CappedRead> => {
    try {
      await reader.cancel();
    } catch {
      // The stream is already finished or already broken.
    }
    return result;
  };

  try {
    for (;;) {
      const left = options.deadlineAt - options.now();
      if (left <= 0) return await stop({ ok: false, why: 'timeout', received: total });
      // A holder, not a `let`: an assignment inside the callback is invisible to narrowing.
      const clock: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
      const expired = new Promise<'expired'>((resolve) => {
        clock.timer = setTimeout(() => {
          resolve('expired');
        }, left);
      });
      const pending = reader.read();
      pending.catch(() => undefined);
      const step = await Promise.race([pending, expired]);
      if (clock.timer !== null) clearTimeout(clock.timer);
      if (step === 'expired') return await stop({ ok: false, why: 'timeout', received: total });
      if (step.done) break;
      chunks.push(step.value);
      total += step.value.length;
      if (total > options.maxBytes) {
        return await stop({ ok: false, why: 'too_large', received: total });
      }
    }
  } catch {
    return await stop({
      ok: false,
      why: options.now() >= options.deadlineAt ? 'timeout' : 'broken',
      received: total,
    });
  }
  return { ok: true, bytes: concat(chunks, total) };
}
