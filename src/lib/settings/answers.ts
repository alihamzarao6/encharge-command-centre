/**
 * How many conversations still hold an answer given from a document (Milestone 5 part 4, the
 * reviewer's follow-up of 18 Oct). Pure.
 *
 * Forgetting removes what the assistant learned and every attachment's text, but not what it
 * already SAID: an assistant reply written with the document in front of the model stays in its
 * conversation, and a later turn there is given that history. Until the chat engine labels or
 * drops such turns (its own item, its own brief), the page tells him how many conversations hold
 * one — a count, never which, since some are private and an administrator must not learn what is
 * in them.
 *
 * An answer "holds" the document when its coverage record (`messages.document_coverage`,
 * knowledge/coverage.ts) names one of the document's ids — an attachment of those bytes (`file`)
 * or a learned copy of them (`source`) — with any mode but `none`, which means nothing of it was
 * sent. A record this code cannot read is counted: it was found by containing one of the ids, and
 * a warning too many is better than a conversation he is not told about.
 */

/** Every id an answer could cite the document by: its learned copies and its attachments. */
export interface DocumentIds {
  readonly sources: readonly string[];
  readonly files: readonly string[];
}

/** One assistant reply that names one of the ids, as the database found it. */
export interface CitingAnswer {
  readonly conversationId: string;
  readonly coverage: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Whether this answer had some of the document in front of the model. */
export function heldTheDocument(coverage: unknown, ids: DocumentIds): boolean {
  if (!isRecord(coverage) || !Array.isArray(coverage['documents'])) return true;
  return coverage['documents'].some((entry: unknown) => {
    if (!isRecord(entry)) return false;
    const source = entry['source'];
    const file = entry['file'];
    const names =
      (typeof source === 'string' && ids.sources.includes(source)) ||
      (typeof file === 'string' && ids.files.includes(file));
    return names && entry['mode'] !== 'none';
  });
}

/** Distinct conversations, among those still there, with at least one answer that held it. */
export function conversationsHolding(
  answers: readonly CitingAnswer[],
  ids: DocumentIds,
  alive: ReadonlySet<string>,
): number {
  const holding = new Set<string>();
  for (const answer of answers) {
    if (alive.has(answer.conversationId) && heldTheDocument(answer.coverage, ids)) {
      holding.add(answer.conversationId);
    }
  }
  return holding.size;
}
