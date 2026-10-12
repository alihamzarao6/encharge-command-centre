/**
 * What a file IS, decided from its bytes (Milestone 5 part 1, D83). The extension is a hint
 * for one question only — "is this text a CSV?" — because a comma-separated file and a
 * paragraph of prose are both just text. For everything else the name is not consulted: a
 * JPEG called `statement.pdf` is read as a picture, a program called `payslip.pdf` is refused
 * as a program.
 *
 * Milestone 5 part 2: bytes that are a web page are read as one ONLY when the server fetched
 * them from a link the person asked to have read (`fromLink`). The same bytes chosen from a
 * device are refused as before (D83). An SVG is refused either way.
 */
import { refusal, type FileKind, type Refusal } from '../../../../src/lib/files/limits.js';
import { extensionOf } from '../../../../src/lib/files/text.js';
import { listZip } from './zip.js';

export type ImageMediaType =
  'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'image/avif';

export type Sniffed =
  | {
      readonly ok: true;
      readonly kind: FileKind;
      readonly mediaType: ImageMediaType | null;
      /** A sentence for the person when the name and the content disagreed. */
      readonly note: string | null;
    }
  | { readonly ok: false; readonly kind: FileKind | null; readonly refusal: Refusal };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < Math.min(to, bytes.length); i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

const EXTENSION_KIND: Readonly<Record<string, FileKind>> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  heic: 'image',
  heif: 'image',
  html: 'html',
  htm: 'html',
};

const KIND_NOUN: Readonly<Record<FileKind, string>> = {
  pdf: 'a PDF',
  docx: 'a Word document',
  xlsx: 'an Excel workbook',
  csv: 'a CSV file',
  text: 'a text file',
  image: 'a picture',
  html: 'a web page',
};

function found(kind: FileKind, name: string, mediaType: ImageMediaType | null = null): Sniffed {
  const extension = extensionOf(name);
  const claimed = Object.hasOwn(EXTENSION_KIND, extension) ? EXTENSION_KIND[extension] : undefined;
  const note =
    claimed !== undefined && claimed !== kind
      ? `This file is named .${extension} but is really ${KIND_NOUN[kind]}, so it was read as ${KIND_NOUN[kind]}.`
      : null;
  return { ok: true, kind, mediaType, note };
}

function refuse(code: Parameters<typeof refusal>[0], kind: FileKind | null = null): Sniffed {
  return { ok: false, kind, refusal: refusal(code) };
}

/** True when the first bytes read as text: no NULs, and nothing that is not a character. */
function looksLikeText(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return true;
  const sample = bytes.subarray(0, 8192);
  let odd = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) odd += 1;
  }
  return odd <= sample.length / 100;
}

function sniffZip(bytes: Uint8Array, name: string): Sniffed {
  const listing = listZip(bytes);
  if (!listing.ok) return refuse('corrupt');
  const names = listing.entries.map((entry) => entry.name);
  if (names.includes('word/document.xml')) return found('docx', name);
  if (names.includes('xl/workbook.xml')) return found('xlsx', name);
  if (names.some((entry) => entry.startsWith('ppt/'))) return refuse('presentation');
  return refuse('archive');
}

/** Tags that open a page. A page of prose that mentions one in passing does not start with it. */
const HTML_START =
  /^(?:<!--[\s\S]*?-->\s*)*<(?:!doctype html|html|head|body|title|meta|link|div|p|h[1-6]|table|section|article|main|header|nav|span|ul|ol|form|center|font|br|img|a|script|style)\b/;

function sniffText(bytes: Uint8Array, name: string, hint: SniffHint): Sniffed {
  // The UTF-8 byte order mark reads as three Latin-1 characters here; drop it either way.
  const head = ascii(bytes, 0, 2048)
    .replace(/^(?:\u{EF}\u{BB}\u{BF}|\u{FF}\u{FE}|\u{FE}\u{FF})/u, '')
    // UTF-16 text reads here with a NUL between every letter.
    .split(String.fromCharCode(0))
    .join('')
    .trimStart();
  const lower = head.toLowerCase();
  if (lower.startsWith('#!')) return refuse('executable');
  const svg = lower.startsWith('<svg') || (lower.startsWith('<?xml') && lower.includes('<svg'));
  const page =
    lower.startsWith('<!doctype html') || lower.startsWith('<html') || lower.includes('<script');
  if (hint.fromLink === true && !svg) {
    // What the server said it is counts for a page with no doctype, and for nothing else.
    const saysHtml = /\b(?:text\/html|application\/xhtml\+xml)\b/.test(hint.contentType ?? '');
    const xhtml = lower.startsWith('<?xml') && lower.includes('<html');
    if (page || xhtml || HTML_START.test(lower) || (saysHtml && lower.includes('<'))) {
      return found('html', name);
    }
  }
  if (svg || page) return refuse('active_content');
  if (lower.startsWith('{\\rtf')) return refuse('unsupported');
  const extension = extensionOf(name);
  const delimited = extension === 'csv' || extension === 'tsv' || extension === 'tab';
  return found(delimited ? 'csv' : 'text', name);
}

export interface SniffHint {
  /** The server fetched these bytes from a link. */
  readonly fromLink?: boolean;
  readonly contentType?: string | null;
}

export function sniff(bytes: Uint8Array, name: string, hint: SniffHint = {}): Sniffed {
  if (bytes.length === 0) return refuse('empty');

  // PDF: the header may sit a little way in (the spec allows leading junk, and mail systems
  // add it).
  if (ascii(bytes, 0, 1024).includes('%PDF-')) return found('pdf', name);

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return sniffZip(bytes, name);
  }
  // OLE2 compound file: every legacy Office format, and every password-protected modern one.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return refuse('legacy_office');
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return found('image', name, 'image/jpeg');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return found('image', name, 'image/png');
  }
  const six = ascii(bytes, 0, 6);
  if (six === 'GIF87a' || six === 'GIF89a') return found('image', name, 'image/gif');
  if (ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 12);
    if (form === 'WEBP') return found('image', name, 'image/webp');
    return refuse(form === 'WAVE' || form === 'AVI ' ? 'media' : 'unsupported');
  }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return found('image', name, 'image/heic');
    if (AVIF_BRANDS.has(brand)) return found('image', name, 'image/avif');
    return refuse('media');
  }

  // Archives that are not Office containers.
  if (
    ascii(bytes, 0, 4) === 'Rar!' ||
    startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWith(bytes, [0x1f, 0x8b]) ||
    ascii(bytes, 0, 3) === 'BZh' ||
    startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
    ascii(bytes, 257, 262) === 'ustar'
  ) {
    return refuse('archive');
  }

  // Programs: Windows, Linux, macOS.
  if (
    ascii(bytes, 0, 2) === 'MZ' ||
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])
  ) {
    return refuse('executable');
  }

  if (
    ascii(bytes, 0, 3) === 'ID3' ||
    ascii(bytes, 0, 4) === 'OggS' ||
    ascii(bytes, 0, 4) === 'fLaC' ||
    startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) ||
    startsWith(bytes, [0xff, 0xfb]) ||
    startsWith(bytes, [0xff, 0xf3])
  ) {
    return refuse('media');
  }

  if (looksLikeText(bytes)) return sniffText(bytes, name, hint);
  return refuse('unsupported');
}
