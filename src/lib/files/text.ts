/**
 * Cleaning what came out of a file before it is stored or shown to a model (Milestone 5
 * part 1). Pure. Used by the browser when it extracts and again by the server when it
 * receives — the server never assumes the browser did it.
 *
 * Two jobs:
 *
 *  1. A file NAME is attacker-reachable text that ends up on screen, in a database row and in
 *     a prompt. `sanitiseFileName` reduces it to a plain label: no path, no control or
 *     invisible characters, no markup-significant characters, bounded length. It is never
 *     used as a path — files are keyed by id — so a traversal has nowhere to go; this makes
 *     it inert as text too.
 *  2. Extracted TEXT keeps what a person can see and drops the standard hiding places for an
 *     injected instruction (SECURITY.md §3 layer 4): bidi overrides, zero-width spacing, the
 *     Unicode "tag" block, NULs and other control characters. Zero-width JOINERS are kept —
 *     emoji sequences and Persian or Indic text need them — and so is every visible script.
 */
import { FILE_LIMITS } from './limits.js';

// C0 controls (except tab, LF, CR), DEL, and C1 controls.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Bidi embeddings, overrides and isolates: text that renders in a different order to the
// order a model reads it in.
const BIDI = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}]/gu;
// Zero-width space, word joiner, BOM / zero-width no-break space, soft hyphen, Mongolian
// vowel separator, and the invisible operators. NOT U+200C / U+200D (the joiners).
const INVISIBLE = /[\u{200B}\u{2060}\u{FEFF}\u{AD}\u{180E}\u{2061}-\u{2064}]/gu;
// The "tag" block (U+E0000–U+E007F): invisible copies of ASCII, a known smuggling channel.
const TAG_BLOCK = /[\u{E0000}-\u{E007F}]/gu;
// Lone surrogates would make the JSON body invalid for some parsers.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripInvisible(value: string): string {
  return value
    .replace(LONE_SURROGATE, '')
    .replace(TAG_BLOCK, '')
    .replace(BIDI, '')
    .replace(INVISIBLE, '')
    .replace(CONTROL, '');
}

/**
 * Text as a person would read it off the page: invisible characters gone, line endings
 * normalised, trailing space trimmed per line, runs of blank lines collapsed to one.
 */
export function sanitiseExtractedText(value: string): string {
  const cleaned = stripInvisible(value.normalize('NFC')).replace(/\r\n?/g, '\n');
  const lines = cleaned.split('\n').map((line) => line.replace(/[ \t\u{A0}]+$/gu, ''));
  const out: string[] = [];
  let blank = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blank += 1;
      if (blank > 1) continue;
      out.push('');
    } else {
      blank = 0;
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

export const FALLBACK_FILE_NAME = 'file';

/**
 * A display label from whatever the browser reported as the file's name.
 * `../../etc/passwd` → `passwd`; `a\0b.pdf` → `ab.pdf`; `<img onerror=x>.pdf` →
 * `(img onerror=x).pdf`. The extension survives truncation so the label still says what it is.
 */
export function sanitiseFileName(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_FILE_NAME;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = stripInvisible(base.normalize('NFC'))
    .replace(/[\t\n\r]/g, ' ')
    .replace(/</g, '(')
    .replace(/>/g, ')')
    .replace(/["`]/g, "'")
    .replace(/&/g, '+')
    .replace(/\s+/g, ' ')
    .trim()
    // A name that is only dots is a directory reference, not a name.
    .replace(/^\.+$/, '');
  if (cleaned === '') return FALLBACK_FILE_NAME;
  const max = FILE_LIMITS.maxNameChars;
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 8 ? Array.from(cleaned.slice(dot)) : [];
  const keep = Math.max(1, max - extension.length - 1);
  return `${chars.slice(0, keep).join('')}…${extension.join('')}`;
}

/**
 * A display label from a web page's own title (Milestone 5 part 2). A title is text a
 * stranger wrote that ends up on screen, in a database row and in a prompt, exactly as a file
 * name does — but it is prose, not a path, so slashes stay ("Home loans / Rates") and it is
 * cut at a word where it can be. Empty or unusable → `fallback`, which is the page's host.
 */
export function sanitiseTitle(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = stripInvisible(raw.normalize('NFC'))
    .replace(/[\t\n\r]/g, ' ')
    .replace(/</g, '(')
    .replace(/>/g, ')')
    .replace(/["`]/g, "'")
    .replace(/&/g, '+')
    .replace(/\s+/g, ' ')
    .trim();
  if (meaningfulChars(cleaned) === 0) return fallback;
  const max = FILE_LIMITS.maxNameChars;
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The lowercase extension without the dot, or '' — a hint only; the bytes decide. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Characters that carry meaning to a reader: letters and digits of any script. */
export function meaningfulChars(value: string): number {
  return (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
}
