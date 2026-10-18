/**
 * A forgotten document must not go on speaking from a conversation's history (18 Oct 2026, the
 * reviewer's follow-up to Milestone 5 part 4). Pure: the store (llm/store.ts) reads the rows and
 * asks the database what is forgotten; this decides what the model is shown.
 *
 * THE FAULT. Forgetting a document removes what was learned and every attachment's text, but not
 * what the assistant already SAID: its reply stays in `messages`, and the next turn in that
 * conversation is handed it as history. Measured live on 17 Oct: the model repeated the figures
 * out of its own earlier reply, and then — with no document in front of it and a rule that says
 * never to supply a figure a document does not show — called that correct earlier reply
 * "fabricated". Both halves are wrong.
 *
 * THE DECISION: the turn is KEPT IN ITS PLACE and its text is WITHHELD. An assistant reply that
 * was written with a now-forgotten document in front of the model is sent to the model as the
 * fixed sentence below, which names no document (the tombstone rule, D136), and a block of rules
 * (files/rules.ts, WITHDRAWN_REPLY_RULES) goes in the system prompt only on such a turn. Nothing
 * in `messages` changes: the person still sees every reply on screen.
 *   - Not dropped: a dropped pair makes the model deny it ever answered — "what did you tell me
 *     earlier?" gets "nothing", which is a different falsehood, and the user's own question in
 *     that pair is theirs to keep.
 *   - Not kept and labelled: the measured fault IS the model repeating the figures. Keeping the
 *     text would leave "do not present it as current" to the model's behaviour; withholding the
 *     text makes that half structural. The other half — never calling a correct reply fabricated
 *     — is a fact the rules state, and tests/unit/knowledge/withdrawn-live.test.ts holds the
 *     recorded replies to it.
 *
 * WHICH TURNS. `messages.document_coverage` (knowledge/coverage.ts) names, per assistant reply,
 * every document whose text reached the model — the attachment (`file`) and the learned copy
 * (`source`) — with a mode; `none` means nothing of it was sent. A reply is withdrawn when any
 * document it drew on is gone for good: the learned copy is `forgotten`, or the attachment was
 * removed by a person (an expired attachment keeps its learned copy, D135, so it is not gone).
 * That is enough for every turn since part 5 shipped (17 Oct 2026, 22:09 UTC). Turns from
 * part 1 (12 Oct) to then carry only `document_context = true` and name nothing; for those the
 * conversation decides: if any attachment of it was removed by a person, the reply is withdrawn.
 * A warning too many there is better than a figure that should be gone (the same choice as
 * settings/answers.ts).
 *
 * A failure to find out what is forgotten refuses the turn (the store returns the error, and
 * the chat answers 503 as it does for any history read failure): sending the history unlabelled
 * is the fault itself, and labelling every reply withdrawn would call documents removed that are
 * not.
 */
import type { Result } from '../errors.js';
import type { HistoryMessage } from '../llm/chat.js';

/**
 * What the model is shown in place of a withdrawn reply. Names nothing. The same shape as the
 * summariser's placeholder (memory/trigger.ts): the turn keeps its place, its words do not.
 */
export const WITHDRAWN_REPLY_STAND_IN =
  '[This reply has been withdrawn. It was written from a document that has since been removed from this app, and its text is not shown to you. The rules on withdrawn replies say what to do.]';

/** One stored message, as the store reads it. */
export interface HistoryRow {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** `messages.document_coverage`: null before Milestone 5 part 5, and on every user row. */
  readonly documentCoverage: unknown;
  /** `messages.document_context`: the turn was answered with a document in front of the model. */
  readonly documentContext: boolean;
}

/** The ids a history's replies drew on, for the store to ask about. */
export interface CitedDocuments {
  readonly sources: readonly string[];
  readonly files: readonly string[];
  /** A reply answered from a document before coverage was recorded: it names nothing. */
  readonly unnamed: boolean;
}

/** What the database says is gone, among what was asked about. */
export interface ForgottenDocuments {
  /** Learned copies with status `forgotten`, among the source ids asked about. */
  readonly sources: ReadonlySet<string>;
  /**
   * Attachments gone for good, among the file ids asked about: removed by a person, or whose
   * learned copy is forgotten.
   */
  readonly files: ReadonlySet<string>;
  /** The conversation has at least one attachment a person removed. */
  readonly anyRemovedHere: boolean;
}

export const NOTHING_FORGOTTEN: ForgottenDocuments = {
  sources: new Set<string>(),
  files: new Set<string>(),
  anyRemovedHere: false,
};

/** The store's question to the database. */
export interface WithdrawnLookup {
  forgotten(input: {
    readonly conversationId: string;
    readonly sources: readonly string[];
    readonly files: readonly string[];
  }): Promise<Result<ForgottenDocuments>>;
}

interface CitedEntry {
  readonly source: string | null;
  readonly file: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The documents a coverage record names with any mode but `none`. Read loosely, as
 * settings/answers.ts does: a later coverage version keeps `documents`, `source`, `file` and
 * `mode`, and an unreadable record names nothing (null).
 */
function citedIn(coverage: unknown): readonly CitedEntry[] | null {
  if (!isRecord(coverage) || !Array.isArray(coverage['documents'])) return null;
  const out: CitedEntry[] = [];
  for (const entry of coverage['documents']) {
    if (!isRecord(entry) || entry['mode'] === 'none') continue;
    const source = entry['source'];
    const file = entry['file'];
    const named = {
      source: typeof source === 'string' ? source : null,
      file: typeof file === 'string' ? file : null,
    };
    if (named.source !== null || named.file !== null) out.push(named);
  }
  return out;
}

/** Everything the replies in a history drew on. Empty when no reply involved a document. */
export function citedDocuments(rows: readonly HistoryRow[]): CitedDocuments {
  const sources = new Set<string>();
  const files = new Set<string>();
  let unnamed = false;
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    const cited = citedIn(row.documentCoverage);
    if (cited === null) {
      if (row.documentContext) unnamed = true;
      continue;
    }
    for (const entry of cited) {
      if (entry.source !== null) sources.add(entry.source);
      if (entry.file !== null) files.add(entry.file);
    }
  }
  return { sources: [...sources].sort(), files: [...files].sort(), unnamed };
}

/** Whether the store has anything to ask the database about. */
export function needsLookup(cited: CitedDocuments): boolean {
  return cited.unnamed || cited.sources.length > 0 || cited.files.length > 0;
}

/** Whether this reply drew on a document that is now gone. A user row never is. */
export function isWithdrawn(row: HistoryRow, forgotten: ForgottenDocuments): boolean {
  if (row.role !== 'assistant') return false;
  const cited = citedIn(row.documentCoverage);
  if (cited === null) return row.documentContext && forgotten.anyRemovedHere;
  return cited.some(
    (entry) =>
      (entry.source !== null && forgotten.sources.has(entry.source)) ||
      (entry.file !== null && forgotten.files.has(entry.file)),
  );
}

/** The history as the model is shown it: withdrawn replies stand in for themselves. */
export function withdrawHistory(
  rows: readonly HistoryRow[],
  forgotten: ForgottenDocuments,
): HistoryMessage[] {
  return rows.map((row) =>
    isWithdrawn(row, forgotten)
      ? { role: row.role, content: WITHDRAWN_REPLY_STAND_IN, withdrawn: true }
      : { role: row.role, content: row.content },
  );
}
