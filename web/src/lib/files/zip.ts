/**
 * Opening the zip container a .docx or .xlsx is (Milestone 5 part 1) — and nothing else.
 * Archives as such are refused (D83); this exists because Word and Excel files happen to be
 * zips of XML.
 *
 * Bounded on purpose. Only the entries asked for are inflated, never one inside another, and
 * the sizes the directory declares are checked BEFORE anything is inflated: a 40 KB file that
 * claims to unpack to 4 GB is refused without allocating a byte of it. fflate inflates into a
 * buffer of the declared size, so a file that lies about its size fails to inflate rather
 * than growing past the limit.
 */
import { unzipSync, type UnzipFileInfo } from 'fflate';

export interface ZipEntryInfo {
  readonly name: string;
  readonly compressedSize: number;
  readonly originalSize: number;
}

/** Everything read out of one container, in total. A phone has to hold it twice as text. */
export const MAX_UNZIPPED_BYTES = 80 * 1024 * 1024;
/** Honest spreadsheet XML compresses 10–30×. Past this, and large, it is not a document. */
export const MAX_COMPRESSION_RATIO = 300;
const RATIO_APPLIES_FROM_BYTES = 10 * 1024 * 1024;

export type ZipListing =
  | { readonly ok: true; readonly entries: readonly ZipEntryInfo[] }
  | { readonly ok: false; readonly reason: 'corrupt' };

function info(file: UnzipFileInfo): ZipEntryInfo {
  return { name: file.name, compressedSize: file.size, originalSize: file.originalSize };
}

/** The directory only: names and declared sizes. Inflates nothing. */
export function listZip(bytes: Uint8Array): ZipListing {
  const entries: ZipEntryInfo[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        entries.push(info(file));
        return false;
      },
    });
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  return { ok: true, entries };
}

export type ZipRead =
  | {
      readonly ok: true;
      readonly files: ReadonlyMap<string, Uint8Array>;
      /** Every entry's name, read or not — enough to say "this file contains macros". */
      readonly names: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'corrupt' | 'expands_too_far' | 'too_long' };

/** VBA lives in one binary part. Its presence is reported; it is never opened. */
export function hasMacros(names: readonly string[]): boolean {
  return names.some((name) => name.toLowerCase().endsWith('vbaproject.bin'));
}

export const MACROS_NOTE = 'This file contains macros. They were not run and were not read.';

/** True when the declared sizes are those of a decompression bomb rather than a document. */
export function looksLikeBomb(entry: ZipEntryInfo): boolean {
  return (
    entry.originalSize >= RATIO_APPLIES_FROM_BYTES &&
    entry.originalSize > Math.max(1, entry.compressedSize) * MAX_COMPRESSION_RATIO
  );
}

export function readZipEntries(bytes: Uint8Array, wanted: (name: string) => boolean): ZipRead {
  const listing = listZip(bytes);
  if (!listing.ok) return listing;
  const chosen = listing.entries.filter((entry) => wanted(entry.name));
  if (chosen.some(looksLikeBomb)) return { ok: false, reason: 'expands_too_far' };
  const total = chosen.reduce((sum, entry) => sum + entry.originalSize, 0);
  if (total > MAX_UNZIPPED_BYTES) return { ok: false, reason: 'too_long' };
  try {
    const names = new Set(chosen.map((entry) => entry.name));
    const out = unzipSync(bytes, { filter: (file) => names.has(file.name) });
    return {
      ok: true,
      files: new Map(Object.entries(out)),
      names: listing.entries.map((entry) => entry.name),
    };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

const UTF8 = new TextDecoder('utf-8');

/** An entry as text. OOXML parts are UTF-8 (or UTF-16 with a BOM, which Word never writes). */
export function entryText(files: ReadonlyMap<string, Uint8Array>, name: string): string | null {
  const bytes = files.get(name);
  return bytes === undefined ? null : UTF8.decode(bytes);
}
