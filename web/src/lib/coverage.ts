/**
 * The note under an answer that says what the assistant actually had (Milestone 5 part 5,
 * fixed decision 7). Pure: the coverage record the server returned with the reply (or stored
 * with it) in, the sentences to show out.
 *
 * Said only when something was partial, missing or still being learned — nothing at all when
 * every document went in whole. Plain words, in the message area beside the answer it affected,
 * and never a cause the app cannot vouch for: the reasons below are the only ones there are.
 * Every sentence names the real limit (a fixed amount of document text per question, chosen by
 * how well each part matches), says what to do if it helps, and invents no setting.
 *
 * Names are looked up, never stored with the record: a document removed since is "a document
 * that has since been removed".
 */
import {
  DOCUMENT_COVERAGE,
  coverageNeedsNote,
  type CoverageDocument,
  type DocumentCoverage,
} from '../../../src/lib/knowledge/coverage.js';

export { coverageNeedsNote, type DocumentCoverage };

export const REMOVED_DOCUMENT_NAME = 'a document that has since been removed';

export const SEARCH_FAILED_TEXT =
  "The assistant couldn't search the documents it has learned for this answer — the search wasn't available just now. Ask again in a minute.";

/** The record as it came from the server or the database, or null when it is not one. */
export function parseCoverage(value: unknown): DocumentCoverage | null {
  const parsed = DOCUMENT_COVERAGE.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Display names by id, from whatever shape the reply carried. */
export function parseNames(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(value)) {
    if (typeof name === 'string' && name.trim() !== '') out[id] = name;
  }
  return out;
}

/** The ids whose names the note needs: learned sources and attachments not shown whole. */
export function coverageIds(coverage: DocumentCoverage | null | undefined): {
  readonly sources: readonly string[];
  readonly files: readonly string[];
} {
  const sources = new Set<string>();
  const files = new Set<string>();
  for (const doc of coverage?.documents ?? []) {
    if (doc.mode === 'whole') continue;
    if (doc.file !== undefined) files.add(doc.file);
    else if (doc.source !== undefined) sources.add(doc.source);
  }
  return { sources: [...sources], files: [...files] };
}

/** "3–5, 8, 14" */
export function pageRanges(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (sorted[i + 1] === end + 1) {
      i += 1;
      end = sorted[i] ?? end;
    }
    runs.push(start === end ? String(start) : `${String(start)}–${String(end)}`);
    i += 1;
  }
  return runs.join(', ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;

/** "14 Oct 2026", in Perth, like everything else the app dates for the client. */
export function perthDay(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'an unknown date';
  const local = new Date(at + PERTH_OFFSET_MS);
  return `${String(local.getUTCDate())} ${MONTHS[local.getUTCMonth()] ?? ''} ${String(local.getUTCFullYear())}`;
}

function nameOf(doc: CoverageDocument, names: Readonly<Record<string, string>>): string {
  const id = doc.file ?? doc.source;
  const name = id === undefined ? undefined : names[id];
  return name === undefined ? REMOVED_DOCUMENT_NAME : `“${name}”`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function noun(doc: CoverageDocument, plural: boolean): string {
  const base = doc.kind === 'pdf' || doc.kind === 'image' ? 'page' : 'part';
  return plural ? `${base}s` : base;
}

/** "pages 3–5 and 8 of its 33 pages" */
function which(doc: CoverageDocument): string {
  const count = doc.shownCount ?? doc.pages.length;
  const listed = pageRanges(doc.pages);
  const more = doc.shownCount !== undefined && doc.shownCount > doc.pages.length ? ' and more' : '';
  return `${noun(doc, count !== 1)} ${listed}${more} of its ${String(doc.total)} ${noun(doc, doc.total !== 1)}`;
}

/** "all 33 pages", "pages 1–7, 15–21" — what a summary that reached the model covered; null for none. */
function summaryCovers(doc: CoverageDocument): string | null {
  const runs = doc.summary ?? [];
  if (runs.length === 0) return null;
  const covered = runs.reduce((n, r) => n + Math.max(0, r.to - r.from + 1), 0);
  if (covered >= doc.total) return `all ${String(doc.total)} ${noun(doc, doc.total !== 1)}`;
  const listed = runs
    .map((r) => (r.from === r.to ? String(r.from) : `${String(r.from)}–${String(r.to)}`))
    .join(', ');
  return `${noun(doc, covered !== 1)} ${listed}`;
}

/** One sentence (or two) for one document, or null when it went in whole. */
export function documentLine(
  doc: CoverageDocument,
  names: Readonly<Record<string, string>>,
): string | null {
  const name = nameOf(doc, names);
  switch (doc.mode) {
    case 'whole':
      return null;
    case 'none':
      return `Nothing in ${name} matched this question closely enough, so none of it reached the assistant for this answer. Ask about the specific topic you need from it to bring that part in.`;
    case 'opening': {
      // On the free Voyage plan this is the common case (17 Oct: 5 of 9 rapid follow-ups), so
      // the note says first, plainly, what was seen — and only then why.
      const shown = doc.shownCount ?? doc.pages.length;
      const saw = `This answer saw only the opening ${noun(doc, shown !== 1)} of ${name} (${which(doc)}), not the parts that match your question`;
      switch (doc.reason) {
        case 'search_failed':
          return `${saw}: the search that picks those wasn't available just now. Ask again in a minute.`;
        case 'learning':
          return `${saw}: it is still being learned. Ask again in a few minutes for an answer drawn from all of it.`;
        case 'not_learned':
        case undefined:
          return `${saw}: it couldn't be searched.`;
      }
      return null;
    }
    case 'part': {
      const summarised = summaryCovers(doc);
      // Pages seen in full, beside a summary: "and on pages 2–3 in full".
      const inFull =
        doc.pages.length === 0
          ? null
          : `${noun(doc, (doc.shownCount ?? doc.pages.length) !== 1)} ${pageRanges(doc.pages)} in full`;
      if (doc.origin === 'learned') {
        const when = doc.learnedAt === undefined ? '' : `, added ${perthDay(doc.learnedAt)}`;
        const where =
          doc.sameConversation === true
            ? ' earlier in this conversation'
            : ' in another conversation';
        const newer =
          doc.newerVersionAt === undefined
            ? ''
            : ` A newer document, from ${perthDay(doc.newerVersionAt)}, covers the same ground.`;
        const what =
          summarised === null
            ? which(doc)
            : `a summary of ${summarised}, written by the app when it was learned${inFull === null ? '' : `, and ${inFull}`}`;
        return `Also drew on ${name}${when}${where}: ${what}.${newer}`;
      }
      if (summarised !== null) {
        return inFull === null
          ? `This answer drew on a summary of ${summarised} of ${name}, written by the app when it was learned, not on its full text. Ask about a specific part to see it in full.`
          : `This answer drew on a summary of ${summarised} of ${name}, written by the app when it was learned, and on ${inFull}.`;
      }
      if (doc.learning !== undefined) {
        return `${capitalise(name)} is still being learned (${String(doc.learning.done)} of ${String(doc.learning.total)} sections so far), so this answer drew only on ${which(doc)}. Ask again in a few minutes for an answer drawn from all of it.`;
      }
      return `Only part of ${name} reached the assistant for this answer: ${which(doc)}. Each question gets the parts that best match it, up to a fixed amount — ask about the specific topic you need to bring other parts in.`;
    }
  }
}

/** Every sentence of the note, in the order the documents were given. Empty = no note. */
export function coverageLines(
  coverage: DocumentCoverage | null | undefined,
  names: Readonly<Record<string, string>>,
): readonly string[] {
  if (!coverageNeedsNote(coverage) || coverage === null || coverage === undefined) return [];
  const lines = coverage.documents
    .map((doc) => documentLine(doc, names))
    .filter((line): line is string => line !== null);
  const searchSaid = coverage.documents.some((doc) => doc.reason === 'search_failed');
  if (coverage.searchFailed === true && !searchSaid) lines.push(SEARCH_FAILED_TEXT);
  return lines;
}
