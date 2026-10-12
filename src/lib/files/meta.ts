/**
 * The header a fetched page travels with (Milestone 5 part 2) — imported by the Edge Function
 * that writes it and by the browser that reads it, so the two cannot drift.
 *
 * `fetch_page` answers with the page's BYTES as the body. What the server measured about them
 * (which fetch this was, the host that answered, the size, the SHA-256) rides in one response
 * header as base64url of UTF-8 JSON: a header value must be plain ASCII, and a file name taken
 * from an address need not be. Nothing in it is the page's own words.
 */

export const PAGE_META_HEADER = 'x-page-meta';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

export function encodePageMeta(meta: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(meta)));
}

/** The decoded object, or null when the header is missing, damaged or not an object. */
export function decodePageMeta(header: string | null): Readonly<Record<string, unknown>> | null {
  if (header === null || header === '' || header.length > 8_192) return null;
  const bytes = fromBase64Url(header);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}
