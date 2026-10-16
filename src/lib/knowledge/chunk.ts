/**
 * Cutting a document into the pieces that are embedded and retrieved (Milestone 5 part 5).
 * Pure.
 *
 * A chunk is about 1,500 characters — a few paragraphs of a transcript, one table of a rate
 * sheet — because that is roughly the size of the passage a question is about: small enough
 * that a match means the passage is relevant, big enough to carry its own context. Each one
 * overlaps the one before by about 200 characters, so a sentence that straddles a cut is
 * whole in one of them.
 *
 * A chunk never crosses a page. Every excerpt can then be cited by the page the reader can
 * find it on, and the page's own provenance (read from an image, partly legible) travels with
 * it. The cut falls at the best boundary near the target: a blank line, then a line break,
 * then the end of a sentence (including 。！？ for scripts without spaces), then a space, and
 * only then mid-word — never inside a surrogate pair. Text with no spaces at all (Chinese,
 * Japanese, Thai) is therefore cut at the size limit, cleanly.
 *
 * Offsets are kept: `content` is exactly `page.slice(charStart, charEnd)`. That is what lets
 * two neighbouring chunks be joined later without repeating their overlap.
 */
import type { ExtractionMethod, Legibility } from '../files/limits.js';

/** Bump whenever the rules below change: chunks are copied between twins only within one version. */
export const CHUNKER_VERSION = 'c4-1500-200';

export const CHUNK_TARGET_CHARS = 1_500;
export const CHUNK_MAX_CHARS = 1_800;
export const CHUNK_OVERLAP_CHARS = 200;
/** No boundary is looked for before this far into a chunk. */
const CHUNK_MIN_CUT = 1_000;

export interface ChunkablePage {
  readonly pageNo: number;
  readonly label: string;
  readonly content: string;
  readonly method: ExtractionMethod;
  readonly legibility: Legibility;
}

export interface DocumentChunk {
  /** 1..N in document order, across pages. */
  readonly ordinal: number;
  readonly pageNo: number;
  readonly pageLabel: string;
  readonly method: ExtractionMethod;
  readonly legibility: Legibility;
  readonly charStart: number;
  readonly charEnd: number;
  readonly content: string;
  /** The section in force ("Week 3"), or two where a chunk crosses into the next; null when the document names none. */
  readonly section: string | null;
}

const WHITESPACE = /\s/u;
const HAS_WORDS = /[\p{L}\p{N}]/u;

function isWhitespace(text: string, at: number): boolean {
  return WHITESPACE.test(text.charAt(at));
}

/** A cut at `at` would split a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff;
}

function skipWhitespace(text: string, from: number, limit: number): number {
  let at = from;
  while (at < limit && isWhitespace(text, at)) at += 1;
  return at;
}

function trimEnd(text: string, start: number, end: number): number {
  let at = end;
  while (at > start && isWhitespace(text, at - 1)) at -= 1;
  return at;
}

type Boundary = (text: string, at: number) => boolean;

const PARAGRAPH: Boundary = (text, at) =>
  text.charAt(at - 1) === '\n' && text.charAt(at - 2) === '\n';
const LINE: Boundary = (text, at) => text.charAt(at - 1) === '\n';
const SENTENCE: Boundary = (text, at) =>
  /[.!?。！？]/u.test(text.charAt(at - 1)) &&
  (at >= text.length || isWhitespace(text, at) || /[。！？]/u.test(text.charAt(at - 1)));
const SPACE: Boundary = (text, at) => isWhitespace(text, at - 1) || isWhitespace(text, at);

/**
 * Where to end a chunk that starts at `start`: the boundary of the strongest kind found in
 * [start + MIN, start + MAX], the one nearest the target; failing all of them, MAX itself.
 */
export function findCut(text: string, start: number): number {
  const lo = start + CHUNK_MIN_CUT;
  const hi = Math.min(text.length, start + CHUNK_MAX_CHARS);
  const target = start + CHUNK_TARGET_CHARS;
  for (const boundary of [PARAGRAPH, LINE, SENTENCE, SPACE]) {
    let best = -1;
    for (let at = lo; at <= hi; at += 1) {
      if (!boundary(text, at)) continue;
      if (best === -1 || Math.abs(at - target) < Math.abs(best - target)) best = at;
    }
    if (best !== -1 && !splitsPair(text, best)) return best;
  }
  return splitsPair(text, hi) ? hi - 1 : hi;
}

/** Where the next chunk starts: `overlap` back from the cut, moved forward to a word's start. */
function nextStart(text: string, start: number, cut: number): number {
  let at = Math.max(start + 1, cut - CHUNK_OVERLAP_CHARS);
  // Forward to just after a space, so the overlap does not open mid-word; within the overlap.
  let probe = at;
  while (probe < cut && !isWhitespace(text, probe - 1)) probe += 1;
  if (probe < cut) at = probe;
  if (splitsPair(text, at)) at += 1;
  return at;
}

function chunkPage(page: ChunkablePage, firstOrdinal: number): Omit<DocumentChunk, 'section'>[] {
  const text = page.content;
  const out: Omit<DocumentChunk, 'section'>[] = [];
  if (!HAS_WORDS.test(text)) return out;
  let start = skipWhitespace(text, 0, text.length);
  while (start < text.length) {
    const finalPiece = text.length - start <= CHUNK_MAX_CHARS;
    const cut = finalPiece ? text.length : findCut(text, start);
    const end = trimEnd(text, start, cut);
    if (end > start && HAS_WORDS.test(text.slice(start, end))) {
      out.push({
        ordinal: firstOrdinal + out.length,
        pageNo: page.pageNo,
        pageLabel: page.label,
        method: page.method,
        legibility: page.legibility,
        charStart: start,
        charEnd: end,
        content: text.slice(start, end),
      });
    }
    if (finalPiece) break;
    start = skipWhitespace(text, nextStart(text, start, cut), text.length);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Sections. A course says "Welcome to week one" once, on the first page of the week, and then
// talks about the week's topic for three pages without naming it again. Measured on a 33-page
// transcript (17 Oct): "week three main points" found pages 33, 32 and 3 — week three is pages
// 7 to 9 — because nothing in pages 8 and 9 says they are week three. So the chunker carries a
// section forward: from where a document INTRODUCES "Week three" (a heading line, "welcome to
// week three", "week three is about…") every chunk is labelled with it until the next one, and
// the label goes into the embedded header and the page heading the model reads. Only the kind
// and the number are kept ("Week 3"), never the surrounding text.
// ---------------------------------------------------------------------------------------

const SECTION_KINDS =
  'week|module|lesson|chapter|session|unit|part|section|step|phase|stage|class|day|topic';
const SECTION_NUMBERS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\\d{1,3}|[ivx]{1,5}';
const SECTION_PATTERNS: readonly RegExp[] = [
  // A heading line: "Week 1", "WEEK ONE: Pipeline", "## Module 3 — Leads", "- Lesson IV". The
  // line must END soon after the number, and the number must not run on ("day twenty-one"): a
  // PDF wraps prose at any word, so "day twenty-one gets the highest reply rate…" can start a
  // line without being a heading (measured on a 33-page transcript, 17 Oct).
  new RegExp(
    `(?:^|\\n)[ \\t]*(?:#{1,6}[ \\t]*|[-*•][ \\t]+)?(${SECTION_KINDS})[ \\t]+(${SECTION_NUMBERS})(?![-\\w])(?=[ \\t]*(?:\\n|$|(?:[:.–—]|-[ \\t])[^\\n]{0,60}(?:\\n|$)))`,
    'giu',
  ),
  // Introduced in a sentence: "welcome to week one", "let's move on to module two".
  new RegExp(
    `\\b(?:welcome(?: back)? to|this is|let'?s (?:start|begin|kick off|get into|get started with|move on to|move to|dive into)|moving on to|on to|onto|now for|starting)\\s+(?:the\\s+)?(${SECTION_KINDS})\\s+(${SECTION_NUMBERS})(?![-\\w])`,
    'giu',
  ),
  // Named as the subject: "Week three is all about referral partners."
  new RegExp(
    `(?:^|[.!?]\\s+|\\n)(${SECTION_KINDS})\\s+(${SECTION_NUMBERS})(?![-\\w])\\s+(?:is (?:all )?about|covers|focuses on|is where)\\b`,
    'giu',
  ),
];
/** A marker this close to a chunk's start opens it: the section before it does not apply. */
const SECTION_OPENS_WITHIN = 120;

interface SectionMarker {
  readonly pageNo: number;
  readonly offset: number;
  readonly label: string;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};
const ROMAN: Readonly<Record<string, number>> = { i: 1, v: 5, x: 10 };

/** "three" → 3, "IV" → 4, "12" → 12. */
function sectionNumber(raw: string): number | null {
  const word = raw.toLowerCase();
  const named = NUMBER_WORDS[word];
  if (named !== undefined) return named;
  if (/^\d+$/.test(word)) return Number(word);
  let total = 0;
  for (let i = 0; i < word.length; i += 1) {
    const value = ROMAN[word.charAt(i)] ?? 0;
    const next = ROMAN[word.charAt(i + 1)] ?? 0;
    total += value < next ? -value : value;
  }
  return total > 0 ? total : null;
}

/**
 * One spelling for one section: "week three", "Week 3" and "WEEK III" are all "Week 3", so the
 * section a person names can be matched to the section a document introduced however either
 * wrote it.
 */
function sectionLabel(kind: string, number: string): string {
  const k = kind.toLowerCase();
  const n = sectionNumber(number);
  return `${k.charAt(0).toUpperCase()}${k.slice(1)} ${n === null ? number : String(n)}`;
}

const NAMED_SECTION = new RegExp(
  `(?:\\b(a|an|the|this|that|such|very|quite|too|so|pretty|really|since|from)\\s+)?\\b(${SECTION_KINDS}|weak)\\s+(${SECTION_NUMBERS})(?![-\\w])`,
  'giu',
);
/** "a weak one", "a very weak one": English. "break down weak one": the client's own typo. */
const NOT_A_TYPO_AFTER = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'such',
  'very',
  'quite',
  'too',
  'so',
  'pretty',
  'really',
]);

/**
 * The sections a QUESTION names, in the same spelling as a chunk's: "break down week one" →
 * ["Week 1"]. Here any mention counts — the person is asking for it. Normally the search rewrite
 * has already fixed "weak one"; when it could not run (it timed out on 1 turn in 16, 17 Oct) the
 * words as typed are all there is, and the client's question was "break down weak one".
 */
export function sectionsNamedIn(text: string): readonly string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(NAMED_SECTION)) {
    const before = match[1]?.toLowerCase();
    const kind = match[2]?.toLowerCase();
    const number = match[3];
    if (kind === undefined || number === undefined) continue;
    // A question's "I" is the person, not a roman numeral: "which part I need".
    if (number.toLowerCase() === 'i') continue;
    if (kind === 'day' && (before === 'since' || before === 'from') && /^one$/iu.test(number))
      continue;
    if (kind === 'weak' && before !== undefined && NOT_A_TYPO_AFTER.has(before)) continue;
    out.add(sectionLabel(kind === 'weak' ? 'week' : kind, number));
  }
  return [...out].slice(0, 4);
}

/** Every section a page introduces, with where. "In week one we said…" is a reference, not one. */
export function sectionMarkers(
  page: Pick<ChunkablePage, 'pageNo' | 'content'>,
): readonly SectionMarker[] {
  const found = new Map<number, SectionMarker>();
  for (const pattern of SECTION_PATTERNS) {
    for (const match of page.content.matchAll(pattern)) {
      const kind = match[1];
      const number = match[2];
      if (kind === undefined || number === undefined) continue;
      const offset = match.index + match[0].search(/\S/u);
      if (!found.has(offset))
        found.set(offset, { pageNo: page.pageNo, offset, label: sectionLabel(kind, number) });
    }
  }
  return [...found.values()].sort((a, b) => a.offset - b.offset);
}

/** The section(s) a chunk belongs to: the one in force where it starts, and any it introduces. */
function sectionOf(
  chunk: Pick<DocumentChunk, 'pageNo' | 'charStart' | 'charEnd'>,
  markers: readonly SectionMarker[],
): string | null {
  let current: SectionMarker | null = null;
  const within: SectionMarker[] = [];
  for (const marker of markers) {
    const before =
      marker.pageNo < chunk.pageNo ||
      (marker.pageNo === chunk.pageNo && marker.offset < chunk.charStart);
    if (before) current = marker;
    else if (marker.pageNo === chunk.pageNo && marker.offset < chunk.charEnd) within.push(marker);
  }
  const opensAtStart =
    within[0] !== undefined && within[0].offset - chunk.charStart <= SECTION_OPENS_WITHIN;
  const labels = [
    ...(current === null || opensAtStart ? [] : [current.label]),
    ...within.map((m) => m.label),
  ];
  const unique = [...new Set(labels)].slice(0, 2);
  return unique.length === 0 ? null : unique.join(', ');
}

const NAME_SECTION = new RegExp(
  `(?<![\\p{L}\\p{N}])(${SECTION_KINDS})[ -]?(${SECTION_NUMBERS})(?![\\p{L}\\p{N}]|-\\d)`,
  'giu',
);

/**
 * The section a document's NAME gives it: "Week_1_-_Transcript_Timestamps (1).pdf" is week one.
 * Measured 17 Oct on the client's real transcript: 33 pages of prose that never introduce their
 * week the way a heading would, so without its name nothing in it said "Week 1". Narrow on
 * purpose — exactly one kind and number in the name, as whole words; nothing from
 * "Document (1).pdf" or a scanner's date ("Day 14-10-2026" is not day 14).
 *
 * A name is UNTRUSTED: whoever made the file chose it, and names arrive from Drive picks too.
 * Only the kind (one of SECTION_KINDS) and the number (canonicalised to digits) are kept, so the
 * label can say nothing a name might try to say; it reaches the model only inside the wrapper,
 * defanged, like any page heading.
 */
export function sectionFromName(name: string): string | null {
  const stem = name
    .replace(/\.[\p{L}\p{N}]{1,5}$/u, '')
    .replace(/\s*\(\d{1,3}\)/gu, ' ')
    .replace(/[_.]+/gu, ' ');
  const labels = new Set<string>();
  for (const match of stem.matchAll(NAME_SECTION)) {
    const kind = match[1];
    const number = match[2];
    if (kind === undefined || number === undefined || number.toLowerCase() === 'i') continue;
    labels.add(sectionLabel(kind, number));
  }
  const [only] = labels;
  return labels.size === 1 && only !== undefined ? only : null;
}

/**
 * Every page, in page order, into chunks numbered across the document, each with its section:
 * the sections its text introduces, or — only when it introduces none — the one its name gives.
 */
export function chunkPages(
  pages: readonly ChunkablePage[],
  documentName?: string,
): readonly DocumentChunk[] {
  const ordered = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  const markers = ordered.flatMap((page) => sectionMarkers(page));
  const fromName =
    markers.length === 0 && documentName !== undefined ? sectionFromName(documentName) : null;
  const out: DocumentChunk[] = [];
  for (const page of ordered) {
    for (const chunk of chunkPage(page, out.length + 1)) {
      out.push({ ...chunk, section: fromName ?? sectionOf(chunk, markers) });
    }
  }
  return out;
}

/**
 * What is embedded for a chunk: the document's name, the page's label and the section above
 * the text, so "the transcript, week one" can find a passage that says neither. The header is
 * rebuilt from stored columns, so a chunk embedded late matches what it would have on the day.
 */
export function embeddingText(
  documentName: string,
  chunk: Pick<DocumentChunk, 'pageLabel' | 'content' | 'section'>,
): string {
  const section = chunk.section == null || chunk.section === '' ? '' : ` · ${chunk.section}`;
  return `${documentName} · ${chunk.pageLabel}${section}\n${chunk.content}`;
}
