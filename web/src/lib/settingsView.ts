/**
 * What the settings page says (Milestone 5 part 4). Pure: rows in, words out — no fetch, no
 * window, no `import.meta.env`, so every sentence the page shows is unit-tested under Node.
 *
 * Four sections and one slot, in this order on the page:
 *
 *   1. WHAT THE ASSISTANT HAS LEARNED — the headline requirement. He must recognise a document
 *      without opening it: its name, when it was read, who added it, how many pages, and whether
 *      it is finished being learned. Newest first (see DOCUMENT_ORDER). Forget is one confirmation
 *      in plain words that says exactly what will happen, and cannot be undone.
 *   2. CONNECTIONS — an empty slot that Milestone 5 part 3a fills (Google Drive). Not built here.
 *   3. CONNECTOR KEYS — the signed-in person's own; made here and shown once, switched off here.
 *   4. SPENDING — the cap and what has been spent, read-only.
 *   5. ACTIVITY — who did what, from `audit_log`, read-only and paged.
 *
 * Nothing here ever holds a document's text — the browser cannot read a word of it — and a key
 * exists only in the one reply that made it (page.ts on the server; ConnectorKeys.tsx holds it in
 * component state until "Done" and nowhere else).
 */
import {
  canForgetDocument,
  FORGET_DENIED_MESSAGES,
  type ForgetVerdict,
  type SettingsActor,
} from '../../../src/lib/settings/access.js';
import { KIND_LABEL, type FileKind } from '../../../src/lib/files/limits.js';
import { readWhen } from './filesView.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   row shapes are type aliases, as everywhere in web/src/lib: supabase-js needs index-signature
   compatibility, and an interface collapses a query result to `never`. */

/** A learned document as the browser may read it (migration 20261017010000: staff, every row). */
export type LearnedSourceRow = {
  id: string;
  name: string | null;
  kind: string;
  source_host: string | null;
  source_url: string | null;
  content_hash: string | null;
  uploaded_by: string | null;
  learned_at: string;
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  status: string;
  failure: string | null;
};

/** Another copy, or another read of the same address: just enough to say so. */
export type RelatedSourceRow = {
  id: string;
  content_hash: string | null;
  source_url: string | null;
  uploaded_by: string | null;
  learned_at: string;
};

/** A connector key as its owner may read it (migration 20261013010000: own rows only). */
export type ConnectorKeyRow = {
  id: string;
  key_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/**
 * One row of `audit_log`, as the page selects it: the event, who, when, and a few NAMED keys out
 * of before/after — ids, kinds and counts. Never the whole before/after: on some actions this
 * page does not list (the row-level triggers on memory_facts and app_users) they hold a note's
 * words or an address, and a column that is never selected cannot leak.
 */
export type ActivityRow = {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  opportunity: string | null;
  from_stage: string | null;
  to_stage: string | null;
  connector: string | null;
  file_kind: string | null;
  file_source: string | null;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

export const LEARNED_SOURCE_COLUMNS =
  'id, name, kind, source_host, source_url, content_hash, uploaded_by, learned_at, page_count, chunk_count, embedded_count, status, failure';
export const RELATED_SOURCE_COLUMNS = 'id, content_hash, source_url, uploaded_by, learned_at';
export const CONNECTOR_KEY_COLUMNS = 'id, key_id, label, created_at, last_used_at, revoked_at';
export const ACTIVITY_COLUMNS =
  'id, actor, action, entity_type, entity_id, created_at, opportunity:after->>opportunity_ghl_id, from_stage:before->>stage_ghl_id, to_stage:after->>stage_ghl_id, connector:after->>key_id, file_kind:after->>kind, file_source:after->>source';

/**
 * NEWEST FIRST, by when it was read (`learned_at`: a page's or Drive file's fetch time, an
 * upload's ready time), then by id so a page boundary never shows a row twice or skips one.
 *
 * Why this order and not by name or state: the document he is most likely to need to forget is
 * the one he just added by mistake — the wrong client's file, last month's sheet sent again, a
 * draft — and that is at the top. A document still being learned is necessarily recent, so it is
 * at the top too without a second sort. Two reads of the same rate page sit newest above older,
 * which is the order "which one is current" is answered in. Alphabetical would bury the mistake
 * of an hour ago among hundreds; by state would separate two reads of the same page.
 */
export const DOCUMENT_ORDER = [
  { column: 'learned_at', ascending: false },
  { column: 'id', ascending: false },
] as const;

export const DOCUMENTS_PAGE_SIZE = 25;
export const ACTIVITY_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------

export interface PageWindow {
  readonly from: number;
  readonly to: number;
}

/** The inclusive row range PostgREST's `range()` takes for a 1-based page. */
export function pageWindow(page: number, size: number): PageWindow {
  const safe = Math.max(1, Math.floor(page));
  return { from: (safe - 1) * size, to: safe * size - 1 };
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / size));
}

/** "Showing 26–50 of 312". Empty when there is nothing to show. */
export function pageSummary(page: number, size: number, total: number, shown: number): string {
  if (total <= 0 || shown <= 0) return '';
  const { from } = pageWindow(page, size);
  return `Showing ${String(from + 1)}–${String(from + shown)} of ${String(total)}`;
}

// ---------------------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------------------

export function personLabel(
  userId: string | null,
  emailsById: ReadonlyMap<string, string>,
  viewerId: string,
): string {
  if (userId === null) return 'someone no longer on the team';
  if (userId === viewerId) return 'you';
  return emailsById.get(userId) ?? 'someone no longer on the team';
}

/** At the start of a line: "You", "Someone no longer on the team" — an email exactly as it is. */
function whoLabel(text: string): string {
  return text.includes('@') || text === ''
    ? text
    : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// ---------------------------------------------------------------------------------------
// 1. Learned documents
// ---------------------------------------------------------------------------------------

export type DocumentState = 'learning' | 'learned' | 'failed';

export interface DocumentView {
  readonly id: string;
  /** The display name; never empty. */
  readonly name: string;
  readonly kindLabel: string;
  /** The site, for a web page. */
  readonly host: string | null;
  readonly added: string;
  readonly addedBy: string;
  readonly pagesLabel: string;
  readonly state: DocumentState;
  readonly stateLabel: string;
  /** Other learned copies of the same bytes (attached again, elsewhere). */
  readonly otherCopies: number;
  /** When another, different read of the same address was made, if there is one. */
  readonly otherReadOf: string | null;
  readonly verdict: ForgetVerdict;
  /** Why the button is not offered, in words; null when it is. */
  readonly deniedReason: string | null;
}

function kindLabel(kind: string): string {
  return kind in KIND_LABEL ? KIND_LABEL[kind as FileKind] : 'Document';
}

function pagesLabel(kind: string, pages: number): string {
  const unit = kind === 'xlsx' ? 'sheet' : 'page';
  return `${String(pages)} ${unit}${pages === 1 ? '' : 's'}`;
}

const FAILURE_WORDS: Readonly<Record<string, string>> = {
  text_gone: "Couldn't be learned: its text was gone before it could be",
  no_text: "Couldn't be learned: nothing in it could be read",
};

export function documentState(
  row: Pick<LearnedSourceRow, 'status' | 'failure' | 'chunk_count' | 'embedded_count'>,
): {
  readonly state: DocumentState;
  readonly label: string;
} {
  if (row.status === 'ready') return { state: 'learned', label: 'Learned' };
  if (row.status === 'failed') {
    return {
      state: 'failed',
      label: FAILURE_WORDS[row.failure ?? ''] ?? "Couldn't be learned",
    };
  }
  if (row.status === 'learning' && row.chunk_count > 0) {
    const percent = Math.min(99, Math.floor((row.embedded_count / row.chunk_count) * 100));
    return { state: 'learning', label: `Still being learned (${String(percent)}% done)` };
  }
  return { state: 'learning', label: 'Waiting to be learned' };
}

export function buildDocumentList(
  rows: readonly LearnedSourceRow[],
  related: readonly RelatedSourceRow[],
  emailsById: ReadonlyMap<string, string>,
  actor: SettingsActor,
  now: number,
  timeZone?: string,
): readonly DocumentView[] {
  return rows.map((row): DocumentView => {
    const copies = related.filter(
      (other) =>
        other.id !== row.id && row.content_hash !== null && other.content_hash === row.content_hash,
    );
    const otherReads = related
      .filter(
        (other) =>
          other.id !== row.id &&
          row.source_url !== null &&
          other.source_url === row.source_url &&
          other.content_hash !== row.content_hash,
      )
      .map((other) => other.learned_at)
      .sort()
      .reverse();
    const verdict = canForgetDocument(
      { uploadedBy: row.uploaded_by, copyUploaders: copies.map((copy) => copy.uploaded_by) },
      actor,
    );
    const { state, label } = documentState(row);
    const name = (row.name ?? '').trim();
    return {
      id: row.id,
      name: name === '' ? 'Untitled document' : name,
      kindLabel: kindLabel(row.kind),
      host: row.kind === 'html' ? row.source_host : null,
      added: readWhen(row.learned_at, now, timeZone),
      addedBy: personLabel(row.uploaded_by, emailsById, actor.userId),
      pagesLabel: pagesLabel(row.kind, row.page_count),
      state,
      stateLabel: label,
      otherCopies: copies.length,
      otherReadOf: otherReads[0] === undefined ? null : readWhen(otherReads[0], now, timeZone),
      verdict,
      deniedReason: verdict.allowed ? null : FORGET_DENIED_MESSAGES[verdict.because],
    };
  });
}

/** The one line under a document's name: what it is, when it was read and by whom, how long. */
export function documentMeta(doc: DocumentView): string {
  const what = doc.host === null ? doc.kindLabel : `${doc.kindLabel} from ${doc.host}`;
  return `${what} · added ${doc.added} by ${doc.addedBy} · ${doc.pagesLabel}`;
}

/**
 * The confirmation, in plain words, saying exactly what will happen (decision 4). Every
 * sentence is true for every document it can be shown for: what is deleted is listed by what
 * the database function deletes, and the one thing it does not touch — what was already said in
 * a conversation — is said too, so nobody believes an old answer was taken back.
 */
export function forgetConfirmText(doc: DocumentView): readonly string[] {
  const lines: string[] = [
    `Forget “${doc.name}”? The assistant stops using it straight away, everywhere: what it learned from it and any summary of it are deleted, and so is its text in every conversation it is attached to.`,
  ];
  if (doc.otherCopies > 0) {
    lines.push(
      `It was added ${String(doc.otherCopies + 1)} times. Every copy is forgotten together.`,
    );
  }
  if (doc.state === 'learning') {
    lines.push('It is still being learned. Learning stops and nothing more of it is kept.');
  }
  if (doc.otherReadOf !== null) {
    lines.push(
      `A different read of the same page, from ${doc.otherReadOf}, is also in this list and will be used instead. Forget that one too if it is also wrong.`,
    );
  }
  lines.push(
    "This can't be undone. Answers it has already given in existing conversations will still show what it said, and the assistant can read them there. Deleting those conversations is the only way to clear them.",
  );
  return lines;
}

export type ForgetReply =
  | {
      readonly outcome: 'forgotten';
      readonly files: number;
      readonly sources: number;
      /**
       * Conversations still holding an answer given from it — a number, never which (some are
       * private). Null: it could not be counted. Undefined: the server did not say.
       */
      readonly conversationsWithAnswers?: number | null;
    }
  | { readonly outcome: 'already' };

/**
 * What the assistant already said is not taken back by forgetting (the chat engine labelling
 * those turns is its own, later item). So the result says how many conversations still hold an
 * answer from it, and what clears them.
 */
export function answersHeldText(held: number | null | undefined): string {
  if (held === undefined) return '';
  if (held === null) {
    return " Couldn't count the conversations that still hold earlier answers from it: answers already given stay in their conversations until those are deleted.";
  }
  if (held === 0) return ' No conversation holds an earlier answer from it.';
  if (held === 1) {
    return ' 1 conversation still holds an earlier answer from it. Deleting that conversation is the only way to clear it.';
  }
  return ` ${String(held)} conversations still hold earlier answers from it. Deleting those conversations is the only way to clear them.`;
}

export function forgetResultText(name: string, reply: ForgetReply): string {
  if (reply.outcome === 'already') return `“${name}” had already been forgotten.`;
  const where =
    reply.files === 0
      ? ''
      : ` Its text was removed from ${String(reply.files)} conversation${reply.files === 1 ? '' : 's'}.`;
  return `Forgotten: “${name}”. The assistant can no longer use it.${where}${answersHeldText(reply.conversationsWithAnswers)}`;
}

// ---------------------------------------------------------------------------------------
// 3. Connector keys
// ---------------------------------------------------------------------------------------

export interface KeyView {
  readonly keyId: string;
  readonly label: string;
  readonly on: boolean;
  readonly stateLabel: string;
  readonly detail: string;
}

/** Switched-on keys first, then switched-off; newest first within each. */
export function buildKeyList(
  rows: readonly ConnectorKeyRow[],
  now: number,
  timeZone?: string,
): readonly KeyView[] {
  return [...rows]
    .sort((a, b) => {
      const onA = a.revoked_at === null ? 0 : 1;
      const onB = b.revoked_at === null ? 0 : 1;
      if (onA !== onB) return onA - onB;
      return b.created_at.localeCompare(a.created_at);
    })
    .map((row): KeyView => {
      const label = row.label.trim() === '' ? 'Unnamed key' : row.label.trim();
      const made = `made ${readWhen(row.created_at, now, timeZone)}`;
      const used =
        row.last_used_at === null
          ? 'never used'
          : `last used ${readWhen(row.last_used_at, now, timeZone)}`;
      if (row.revoked_at !== null) {
        return {
          keyId: row.key_id,
          label,
          on: false,
          stateLabel: 'Switched off',
          detail: `Key ${row.key_id} · ${made} · switched off ${readWhen(row.revoked_at, now, timeZone)}`,
        };
      }
      return {
        keyId: row.key_id,
        label,
        on: true,
        stateLabel: 'On',
        detail: `Key ${row.key_id} · ${made} · ${used}`,
      };
    });
}

export function revokeConfirmText(key: KeyView): string {
  return `Switch off “${key.label}”? Anything using this key is refused from its very next request. A switched-off key can't be switched back on — make a new one instead.`;
}

export const KEY_SHOWN_ONCE_TEXT =
  "Copy this key now. This is the only time it is shown: it isn't stored anywhere, so it can't be shown again. If you lose it, switch it off and make a new one.";

// ---------------------------------------------------------------------------------------
// 4. Spending
// ---------------------------------------------------------------------------------------

export interface SpendReply {
  readonly capDailyUsd: number;
  readonly capMonthlyUsd: number;
  readonly warnFraction: number;
  readonly todayUsd: number;
  readonly monthUsd: number;
  readonly dayStartedAt: string;
  readonly monthStartedAt: string;
  readonly asOf: string;
}

export type SpendTone = 'ok' | 'warn' | 'over';

export interface SpendLine {
  readonly label: string;
  readonly spent: string;
  readonly cap: string;
  readonly sentence: string;
  /** 0..1, for the meter. */
  readonly fraction: number;
  readonly tone: SpendTone;
}

export interface SpendView {
  readonly today: SpendLine;
  readonly month: SpendLine;
  readonly note: string;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return 'under $0.01';
  return `$${value.toFixed(2)}`;
}

function spendLine(label: string, spent: number, cap: number, warnFraction: number): SpendLine {
  const fraction = cap <= 0 ? (spent > 0 ? 1 : 0) : Math.min(1, Math.max(0, spent / cap));
  const tone: SpendTone =
    cap <= 0 || spent >= cap ? 'over' : spent >= cap * warnFraction ? 'warn' : 'ok';
  const left = Math.max(0, cap - spent);
  const sentence =
    tone === 'over'
      ? `${formatUsd(spent)} of ${formatUsd(cap)} — the cap is reached; the assistant refuses anything more until it resets.`
      : `${formatUsd(spent)} of ${formatUsd(cap)} — ${formatUsd(left)} left.`;
  return { label, spent: formatUsd(spent), cap: formatUsd(cap), sentence, fraction, tone };
}

/**
 * The cap's windows are UTC calendar days and months (llm/spend.ts) because the invoice is cut
 * in UTC. In Perth (UTC+8, no daylight saving) the day therefore turns over at 8:00 am.
 */
export function buildSpendView(reply: SpendReply, now: number, timeZone?: string): SpendView {
  return {
    today: spendLine('Today', reply.todayUsd, reply.capDailyUsd, reply.warnFraction),
    month: spendLine('This month', reply.monthUsd, reply.capMonthlyUsd, reply.warnFraction),
    note: `What the assistant's model has cost, against the caps that stop it. A day runs midnight to midnight UTC — 8:00 am to 8:00 am in Perth. Checked ${readWhen(reply.asOf, now, timeZone)}.`,
  };
}

// ---------------------------------------------------------------------------------------
// 5. Activity
// ---------------------------------------------------------------------------------------

/**
 * The events the record shows, by name — each one a person (or the app on a schedule) doing a
 * thing, written once by the code that did it. Left out on purpose: the row-level trigger rows
 * (`INSERT` / `UPDATE` / `DELETE`, actor `service_role`), which duplicate the events below and
 * whose before/after images carry the words of a note.
 */
export const ACTIVITY_ACTIONS = [
  'LEAD_STAGE_MOVED',
  'LEAD_NOTE_ADDED',
  'FILE_ATTACHED',
  'FILE_REMOVED',
  'FILE_EXPIRED',
  'FILE_REPLACED',
  'KNOWLEDGE_FORGOTTEN',
  'CONNECTOR_KEY_ISSUED',
  'CONNECTOR_KEY_REVOKED',
  'DRIVE_CONNECTED',
  'DRIVE_DISCONNECTED',
  'DRIVE_BROKEN',
  'USER_CREATED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_PROMOTED',
  'USER_DEMOTED',
  'PASSWORD_RESET',
  'CREDENTIALS_ATTACHED',
  'MEMORY_FACT_ADDED',
  'MEMORY_FACT_REPLACED',
  'MEMORY_FACT_EDITED',
  'MEMORY_FACT_RESTORED',
  'MEMORY_FACT_FORGOTTEN',
  'MEMORY_CHUNK_DELETED',
  'CONVERSATION_RENAMED',
  'CONVERSATION_DELETED',
  'CONVERSATION_MADE_PRIVATE',
  'CONVERSATION_MADE_SHARED',
  'CONVERSATION_ADMIN_READ',
] as const;

export interface ActivityContext {
  readonly emailsById: ReadonlyMap<string, string>;
  readonly viewerId: string;
  /** GoHighLevel stage id → its name, from the mirror. */
  readonly stageNames: ReadonlyMap<string, string>;
  /** GoHighLevel opportunity id → the lead's name, from the mirror. */
  readonly leadNames: ReadonlyMap<string, string>;
}

export interface ActivityView {
  readonly id: string;
  readonly who: string;
  readonly what: string;
  readonly when: string;
  /** The instant, for a `<time>` element. */
  readonly at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorLabel(actor: string, context: ActivityContext): string {
  if (actor === 'system') return 'The Command Centre';
  if (actor === 'terminal') return 'An operator, from the terminal';
  if (UUID.test(actor)) return personLabel(actor, context.emailsById, context.viewerId);
  return 'The Command Centre';
}

const FILE_KIND_WORDS: Readonly<Record<string, string>> = {
  pdf: 'a PDF',
  docx: 'a Word document',
  xlsx: 'an Excel workbook',
  csv: 'a CSV file',
  text: 'a text file',
  image: 'a photo',
  html: 'a web page',
};

function describeAction(row: ActivityRow, context: ActivityContext): string {
  const lead = (): string =>
    row.opportunity === null ? 'a lead' : (context.leadNames.get(row.opportunity) ?? 'a lead');
  const stage = (id: string | null): string =>
    id === null ? 'a stage' : (context.stageNames.get(id) ?? 'a stage');
  const subject = (): string =>
    row.entity_id === null
      ? 'a member of staff'
      : personLabel(row.entity_id, context.emailsById, context.viewerId);
  const key = row.connector === null ? '' : ` (${row.connector})`;
  switch (row.action) {
    case 'LEAD_STAGE_MOVED':
      return `moved ${lead()} from ${stage(row.from_stage)} to ${stage(row.to_stage)}`;
    case 'LEAD_NOTE_ADDED':
      return `added a note to ${lead()}`;
    case 'FILE_ATTACHED': {
      if (row.file_source === 'link') return 'read a web page into a conversation';
      const what = FILE_KIND_WORDS[row.file_kind ?? ''] ?? 'a file';
      return row.file_source === 'drive'
        ? `attached ${what} from Google Drive to a conversation`
        : `attached ${what} to a conversation`;
    }
    case 'FILE_REMOVED':
      return 'removed a file from a conversation';
    case 'FILE_EXPIRED':
      return "deleted a file's text after its 30 days were up";
    case 'FILE_REPLACED':
      return 'replaced an older read of a page with a newer one';
    case 'KNOWLEDGE_FORGOTTEN':
      return 'forgot a learned document';
    case 'CONNECTOR_KEY_ISSUED':
      return `made a connector key${key}`;
    case 'CONNECTOR_KEY_REVOKED':
      return `switched off a connector key${key}`;
    case 'DRIVE_CONNECTED':
      return 'connected Google Drive';
    case 'DRIVE_DISCONNECTED':
      return 'disconnected Google Drive';
    case 'DRIVE_BROKEN':
      return 'found a Google Drive connection had stopped working';
    case 'USER_CREATED':
      return `added ${subject()} to the team`;
    case 'USER_DEACTIVATED':
      return `switched off ${subject()}'s access`;
    case 'USER_REACTIVATED':
      return `switched ${subject()}'s access back on`;
    case 'USER_PROMOTED':
      return `made ${subject()} an administrator`;
    case 'USER_DEMOTED':
      return `stopped ${subject()} being an administrator`;
    case 'PASSWORD_RESET':
      return `reset ${subject()}'s password`;
    case 'CREDENTIALS_ATTACHED':
      return `set up sign-in for ${subject()}`;
    case 'MEMORY_FACT_ADDED':
      return 'added a note to memory';
    case 'MEMORY_FACT_REPLACED':
    case 'MEMORY_FACT_EDITED':
      return 'changed a note in memory';
    case 'MEMORY_FACT_RESTORED':
      return 'brought back a note in memory';
    case 'MEMORY_FACT_FORGOTTEN':
      return 'removed a note from memory';
    case 'MEMORY_CHUNK_DELETED':
      return 'deleted a conversation note from memory';
    case 'CONVERSATION_RENAMED':
      return 'renamed a conversation';
    case 'CONVERSATION_DELETED':
      return 'deleted a conversation';
    case 'CONVERSATION_MADE_PRIVATE':
      return 'made a conversation private';
    case 'CONVERSATION_MADE_SHARED':
      return 'shared a private conversation with the team';
    case 'CONVERSATION_ADMIN_READ':
      return "opened someone's private conversation, as an administrator";
    default:
      return 'made a change';
  }
}

export function buildActivityList(
  rows: readonly ActivityRow[],
  context: ActivityContext,
  now: number,
  timeZone?: string,
): readonly ActivityView[] {
  return rows.map((row) => ({
    id: row.id,
    who: whoLabel(actorLabel(row.actor, context)),
    what: describeAction(row, context),
    when: readWhen(row.created_at, now, timeZone),
    at: row.created_at,
  }));
}

// ---------------------------------------------------------------------------------------
// The three empty states: each says what to do, never a blank box.
// ---------------------------------------------------------------------------------------

export const EMPTY_TEXT = {
  documents:
    'Nothing learned yet. Attach a file or paste a link in the Assistant, and once it has been read it is learned and listed here — where you can also make it forget.',
  keys: 'No connector keys yet. Make one to let your own AI read your pipeline; you will see it once, to copy into that tool.',
  activity:
    'Nothing recorded yet. Moving a lead, attaching a file, forgetting a document or making a key each leaves a line here.',
} as const;

export const SECTION_TEXT = {
  documentsIntro:
    'Every document and page the assistant has read and can draw on, in any conversation. Forgetting one removes it everywhere, at once.',
  keysIntro:
    'Keys let an AI tool of your own read your Finance Pipeline (and nothing else) through the connector. These are your keys only.',
  spendIntro: "Read-only. Changing a cap isn't done from here.",
  activityIntro: 'Who did what, newest first. Read-only.',
  connectionsIntro: 'Services the Command Centre reads from on your behalf.',
  unavailable: "Couldn't load this just now. Check your connection and try again.",
} as const;
