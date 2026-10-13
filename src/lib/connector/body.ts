/**
 * Reading a request body without trusting how big it says it is (MCP connector, stage 1).
 *
 * A real request is under 2 KiB. A `Content-Length` over the limit is refused before a byte
 * is read; a body that says nothing, or lies, is read in chunks and dropped the moment it
 * passes the limit, so nobody can make this process hold a megabyte to learn it is not
 * wanted.
 */
import type { BodyRead } from './handler.js';

export async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  maxBytes: number,
): Promise<BodyRead> {
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
  }
  if (stream === null) return { ok: true, text: '' };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // JSON-RPC messages are UTF-8; bytes that are not are not a message.
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
