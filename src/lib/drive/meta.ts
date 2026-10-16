/**
 * The header a file read from Drive travels with (Milestone 5 part 3a) — imported by the Edge
 * Function that writes it and by the browser that reads it. The same encoding as a fetched
 * page's (files/meta.ts): base64url of UTF-8 JSON, because a header must be plain ASCII and a
 * Drive file's name need not be. Nothing in it is the file's content.
 */
import { decodePageMeta, encodePageMeta } from '../files/meta.js';

export const DRIVE_META_HEADER = 'x-drive-meta';

export function encodeDriveMeta(meta: unknown): string {
  return encodePageMeta(meta);
}

export function decodeDriveMeta(header: string | null): Readonly<Record<string, unknown>> | null {
  return decodePageMeta(header);
}
