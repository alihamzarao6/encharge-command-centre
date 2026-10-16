/**
 * Which learned passages go in front of the model for this question, within the budget
 * (Milestone 5 part 5). Pure. Replaces part 1's word matching (files/select.ts, D88) — what is
 * chosen now is chosen by MEANING: the database ranks every eligible chunk by cosine similarity
 * to the question's embedding (match_knowledge_chunks), and this module spends the budget.
 *
 *   1. Best first. A chunk that does not fit is skipped so a smaller one still can.
 *   2. Then the chunks either side of the ones chosen, best anchor first, while there is room:
 *      a passage that answers "break down week one" rarely starts and ends inside one chunk.
 *   3. Grouped by document, in document order; chunks of one page that touch or overlap are
 *      joined by their stored offsets, so the overlap is not said twice; a gap is marked […].
 *   4. This conversation's own attachments first, then what was learned elsewhere — newest
 *      document first, so when two documents disagree the more recent one is read first.
 *
 * Nothing here decides whether something is relevant enough: the similarity floor is applied
 * in the database, and below it nothing is sent at all (never the first pages posing as a match).
 *
 * A SUMMARY (summarise.ts) is chosen like a passage but is never joined to one, never has
 * neighbours, and is read before the document's own text; what it covers is counted apart from
 * the pages shown in full, so neither the model nor the screen mistakes one for the other.
 */
import type { FileKind } from '../files/limits.js';
import type { ChunkKind, MatchedChunk, NeighbourChunk } from './store.js';

/** Allowance per chunk for its page heading and the line breaks around it. */
export const CHUNK_OVERHEAD_CHARS = 40;
/** Allowance per document for its opening tag and attributes. */
export const DOCUMENT_OVERHEAD_CHARS = 600;

export type ExcerptChunk = NeighbourChunk & { readonly similarity?: number };

export interface Passage {
  readonly kind: ChunkKind;
  readonly pageNo: number;
  /** A summary's last page; null for the document's own text. */
  readonly pageTo: number | null;
  readonly pageLabel: string;
  readonly method: NeighbourChunk['method'];
  readonly legibility: NeighbourChunk['legibility'];
  /** The section its first chunk was labelled with ("Week three"), or null. */
  readonly section: string | null;
  readonly text: string;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
}

export interface ExcerptDocument {
  readonly sourceId: string;
  readonly fileId: string | null;
  readonly conversationId: string | null;
  readonly attached: boolean;
  readonly status: 'learning' | 'ready';
  readonly name: string;
  readonly kind: FileKind;
  readonly sourceHost: string | null;
  readonly learnedAt: string;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly embeddedCount: number;
  /** The newest date of a document that holds a near-identical passage, if any. */
  readonly newerTwinLearnedAt: string | null;
  readonly bestSimilarity: number;
  readonly passages: readonly Passage[];
  /** Page numbers with at least some of their own text shown, ascending. */
  readonly pagesShown: readonly number[];
  /** The page runs a summary of it covered, when one was shown. */
  readonly summaryRuns: readonly { readonly from: number; readonly to: number }[];
}

function key(sourceId: string, ordinal: number): string {
  return `${sourceId}#${String(ordinal)}`;
}

function chunkCost(chunk: Pick<NeighbourChunk, 'content'>): number {
  return chunk.content.length + CHUNK_OVERHEAD_CHARS;
}

export interface Picked {
  readonly chunks: readonly MatchedChunk[];
  readonly used: number;
}

/**
 * Step 1: best first, skipping what does not fit. When the question names a section and some
 * document has it, that section is the answer's material and nothing else is: "break down week
 * one" otherwise took week one and then filled the budget with other weeks matched at 0.2–0.29
 * (measured 17 Oct), doubling the cost and listing pages on screen he never asked about.
 * Neighbours (step 2) still add the text either side of it.
 */
export function pickChunks(candidates: readonly MatchedChunk[], budgetChars: number): Picked {
  const pool = candidates.some((c) => c.named) ? candidates.filter((c) => c.named) : candidates;
  const sorted = [...pool].sort(
    (a, b) =>
      b.similarity - a.similarity || a.sourceId.localeCompare(b.sourceId) || a.ordinal - b.ordinal,
  );
  const picked: MatchedChunk[] = [];
  const sources = new Set<string>();
  let used = 0;
  for (const chunk of sorted) {
    const cost = chunkCost(chunk) + (sources.has(chunk.sourceId) ? 0 : DOCUMENT_OVERHEAD_CHARS);
    if (used + cost > budgetChars) continue;
    picked.push(chunk);
    sources.add(chunk.sourceId);
    used += cost;
  }
  return { chunks: picked, used };
}

/** Step 2a: which neighbours to fetch, per document. Never past either end of the document. */
export function neighbourWants(
  picked: readonly MatchedChunk[],
  reach: number,
): ReadonlyMap<string, readonly number[]> {
  if (reach <= 0) return new Map();
  const have = new Set(picked.map((chunk) => key(chunk.sourceId, chunk.ordinal)));
  const wants = new Map<string, Set<number>>();
  for (const chunk of picked) {
    // A summary is whole on its own; its ordinal's neighbours are not its neighbours.
    if (chunk.chunkKind !== 'passage') continue;
    for (let step = 1; step <= reach; step += 1) {
      for (const ordinal of [chunk.ordinal - step, chunk.ordinal + step]) {
        if (ordinal < 1 || ordinal > chunk.chunkCount) continue;
        if (have.has(key(chunk.sourceId, ordinal))) continue;
        const set = wants.get(chunk.sourceId) ?? new Set<number>();
        set.add(ordinal);
        wants.set(chunk.sourceId, set);
      }
    }
  }
  return new Map([...wants].map(([source, set]) => [source, [...set].sort((a, b) => a - b)]));
}

/**
 * Step 2b: add fetched neighbours while there is room, nearest to the best anchor first. A
 * neighbour of a learning document that is not embedded yet is still text the person
 * attached here, so it may be shown beside its embedded neighbour.
 */
export function addNeighbours(
  picked: Picked,
  fetched: readonly NeighbourChunk[],
  budgetChars: number,
): readonly ExcerptChunk[] {
  const out: ExcerptChunk[] = [...picked.chunks];
  const have = new Set(out.map((chunk) => key(chunk.sourceId, chunk.ordinal)));
  const anchors = picked.chunks
    .filter((chunk) => chunk.chunkKind === 'passage')
    .sort((a, b) => b.similarity - a.similarity);
  const byKey = new Map(fetched.map((chunk) => [key(chunk.sourceId, chunk.ordinal), chunk]));
  let used = picked.used;
  for (const anchor of anchors) {
    for (const ordinal of [
      anchor.ordinal - 1,
      anchor.ordinal + 1,
      anchor.ordinal - 2,
      anchor.ordinal + 2,
    ]) {
      const k = key(anchor.sourceId, ordinal);
      const neighbour = byKey.get(k);
      if (neighbour === undefined || have.has(k)) continue;
      const cost = chunkCost(neighbour);
      if (used + cost > budgetChars) continue;
      out.push(neighbour);
      have.add(k);
      used += cost;
    }
  }
  return out;
}

/**
 * Step 3: one document's chunks, in order, into passages. Chunks of the same page with
 * consecutive ordinals are joined: where the second begins inside the first (the overlap), only
 * its new part is added; where there is a gap of whitespace, a line break stands for it.
 */
export function mergePassages(chunks: readonly ExcerptChunk[]): readonly Passage[] {
  const summaries: Passage[] = chunks
    .filter((chunk) => chunk.chunkKind === 'summary')
    .sort((a, b) => a.pageNo - b.pageNo || a.ordinal - b.ordinal)
    .map((chunk) => ({
      kind: 'summary',
      pageNo: chunk.pageNo,
      pageTo: chunk.pageTo,
      pageLabel: chunk.pageLabel,
      method: chunk.method,
      legibility: chunk.legibility,
      section: chunk.section,
      text: chunk.content,
      firstOrdinal: chunk.ordinal,
      lastOrdinal: chunk.ordinal,
    }));
  const sorted = chunks
    .filter((chunk) => chunk.chunkKind === 'passage')
    .sort((a, b) => a.ordinal - b.ordinal);
  const out: Passage[] = [];
  // Where on its page the last passage ends, so the next chunk's overlap can be cut off.
  let lastEnd = 0;
  for (const chunk of sorted) {
    const last = out[out.length - 1];
    if (last?.pageNo === chunk.pageNo && chunk.ordinal === last.lastOrdinal + 1) {
      const overlap = lastEnd - chunk.charStart;
      const added =
        overlap >= chunk.content.length
          ? ''
          : overlap > 0
            ? chunk.content.slice(overlap)
            : `\n${chunk.content}`;
      out[out.length - 1] = { ...last, text: `${last.text}${added}`, lastOrdinal: chunk.ordinal };
      lastEnd = Math.max(lastEnd, chunk.charEnd);
      continue;
    }
    out.push({
      kind: 'passage',
      pageNo: chunk.pageNo,
      pageTo: null,
      pageLabel: chunk.pageLabel,
      method: chunk.method,
      legibility: chunk.legibility,
      section: chunk.section,
      text: chunk.content,
      firstOrdinal: chunk.ordinal,
      lastOrdinal: chunk.ordinal,
    });
    lastEnd = chunk.charEnd;
  }
  // The overview first, then the document's own words.
  return [...summaries, ...out];
}

function maxDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Step 3 and 4: the chosen chunks as documents, in the order the model should read them. */
export function groupDocuments(
  chosen: readonly ExcerptChunk[],
  matched: readonly MatchedChunk[],
): readonly ExcerptDocument[] {
  const meta = new Map<string, MatchedChunk>();
  const best = new Map<string, number>();
  const twin = new Map<string, string | null>();
  for (const chunk of matched) {
    if (!meta.has(chunk.sourceId)) meta.set(chunk.sourceId, chunk);
    best.set(chunk.sourceId, Math.max(best.get(chunk.sourceId) ?? -1, chunk.similarity));
  }
  const bySource = new Map<string, ExcerptChunk[]>();
  for (const chunk of chosen) {
    const list = bySource.get(chunk.sourceId) ?? [];
    list.push(chunk);
    bySource.set(chunk.sourceId, list);
    const matchedChunk = matched.find(
      (m) => m.sourceId === chunk.sourceId && m.ordinal === chunk.ordinal,
    );
    if (matchedChunk !== undefined) {
      twin.set(
        chunk.sourceId,
        maxDate(twin.get(chunk.sourceId) ?? null, matchedChunk.newerTwinLearnedAt),
      );
    }
  }
  const documents: ExcerptDocument[] = [];
  for (const [sourceId, chunks] of bySource) {
    const info = meta.get(sourceId);
    if (info === undefined) continue;
    const passages = mergePassages(chunks);
    documents.push({
      sourceId,
      fileId: info.fileId,
      conversationId: info.conversationId,
      attached: info.attached,
      status: info.sourceStatus,
      name: info.name,
      kind: info.kind,
      sourceHost: info.sourceHost,
      learnedAt: info.learnedAt,
      pageCount: info.pageCount,
      chunkCount: info.chunkCount,
      embeddedCount: info.embeddedCount,
      newerTwinLearnedAt: twin.get(sourceId) ?? null,
      bestSimilarity: best.get(sourceId) ?? 0,
      passages,
      pagesShown: [
        ...new Set(passages.filter((p) => p.kind === 'passage').map((p) => p.pageNo)),
      ].sort((a, b) => a - b),
      summaryRuns: passages
        .filter((p) => p.kind === 'summary')
        .map((p) => ({ from: p.pageNo, to: p.pageTo ?? p.pageNo })),
    });
  }
  return documents.sort((a, b) => {
    if (a.attached !== b.attached) return a.attached ? -1 : 1;
    if (a.attached) return b.bestSimilarity - a.bestSimilarity;
    return Date.parse(b.learnedAt) - Date.parse(a.learnedAt) || b.bestSimilarity - a.bestSimilarity;
  });
}

/** "3–5, 8, 14" — page numbers as a person reads them. */
export function describePages(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const page of sorted) {
    if (start !== undefined && prev !== undefined && page === prev + 1) {
      prev = page;
      continue;
    }
    if (start !== undefined && prev !== undefined) {
      runs.push(start === prev ? String(start) : `${String(start)}–${String(prev)}`);
    }
    start = page;
    prev = page;
  }
  if (start !== undefined && prev !== undefined) {
    runs.push(start === prev ? String(start) : `${String(start)}–${String(prev)}`);
  }
  return runs.join(', ');
}
