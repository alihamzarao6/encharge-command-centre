/**
 * What reached the model, per answer (Milestone 5 part 5, fixed decision 7). The server
 * builds it on every turn that involved a document, returns it with the reply and stores it on
 * the assistant row (`messages.document_coverage`); the browser shows a plain note under the
 * reply when anything was partial, missing or still being learned — and nothing when every
 * document went in whole.
 *
 * Ids and numbers only. A name is never stored here: a document a person removes must name
 * nothing afterwards (the tombstone rule), so the screen looks the name up when it shows the
 * note, and a removed document reads as "a document since removed".
 *
 * Shared by the server (src/lib) and the browser (web/src), so both validate the same shape.
 */
import { z } from 'zod';

import { FILE_KINDS } from '../files/limits.js';

export const COVERAGE_VERSION = 1;

/** Page numbers kept per document. A long list is cut and its length kept in `shownCount`. */
export const MAX_COVERAGE_PAGES = 120;
export const MAX_COVERAGE_DOCUMENTS = 20;
/** Runs of summarised pages kept per document. */
export const MAX_SUMMARY_RUNS = 60;

const DOCUMENT = z.object({
  /** The conversation's attachment (this conversation's files). */
  file: z.uuid().optional(),
  /** The learned document. */
  source: z.uuid().optional(),
  /** `attached`: one of this conversation's files. `learned`: from earlier, anywhere. */
  origin: z.enum(['attached', 'learned']),
  kind: z.enum(FILE_KINDS),
  /**
   * whole:   all of it reached the model.
   * part:    excerpts chosen by meaning, from `pages`.
   * none:    nothing in it matched the question closely enough; none of it was sent.
   * opening: its opening pages, NOT chosen for the question (`reason` says why).
   */
  mode: z.enum(['whole', 'part', 'none', 'opening']),
  pages: z.array(z.number().int().min(1)).max(MAX_COVERAGE_PAGES),
  /** How many pages had text shown, when `pages` had to be cut. */
  shownCount: z.number().int().min(0).optional(),
  /** Pages (or parts) the document has. */
  total: z.number().int().min(0),
  /** Still being learned: chunks embedded so far, of how many. */
  learning: z.object({ done: z.number().int().min(0), total: z.number().int().min(1) }).optional(),
  reason: z.enum(['learning', 'search_failed', 'not_learned']).optional(),
  /** When the document was read or attached (ISO). */
  learnedAt: z.string().max(40).optional(),
  /** The newest date of a document that holds a near-identical passage (ISO). */
  newerVersionAt: z.string().max(40).optional(),
  /** The learned document came from this same conversation (an attachment since expired). */
  sameConversation: z.literal(true).optional(),
  /**
   * The pages its summary covered, as runs, when a summary written while it was learned reached
   * the model (summarise.ts). `pages` stays the pages shown in FULL.
   */
  summary: z
    .array(z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }))
    .max(MAX_SUMMARY_RUNS)
    .optional(),
});

export const DOCUMENT_COVERAGE = z.object({
  v: z.literal(COVERAGE_VERSION),
  documents: z.array(DOCUMENT).max(MAX_COVERAGE_DOCUMENTS),
  /** The search over learned documents could not run for this answer. */
  searchFailed: z.literal(true).optional(),
});

export type CoverageDocument = z.infer<typeof DOCUMENT>;
export type DocumentCoverage = z.infer<typeof DOCUMENT_COVERAGE>;

/** True when the note under a reply has something to say. Whole documents alone say nothing. */
export function coverageNeedsNote(coverage: DocumentCoverage | null | undefined): boolean {
  if (coverage === null || coverage === undefined) return false;
  if (coverage.searchFailed === true) return true;
  return coverage.documents.some((doc) => doc.mode !== 'whole');
}

/** Summarised page ranges as stored: sorted, touching or overlapping runs joined, cut to the limit. */
export function summaryRuns(
  ranges: readonly { readonly from: number; readonly to: number }[],
): { from: number; to: number }[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: Math.max(r.from, r.to) });
  }
  return out.slice(0, MAX_SUMMARY_RUNS);
}

/** Pages as stored: ascending, unique, cut to the limit with the true count kept. */
export function coveragePages(
  pages: readonly number[],
): Pick<CoverageDocument, 'pages' | 'shownCount'> {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length <= MAX_COVERAGE_PAGES) return { pages: sorted };
  return { pages: sorted.slice(0, MAX_COVERAGE_PAGES), shownCount: sorted.length };
}
