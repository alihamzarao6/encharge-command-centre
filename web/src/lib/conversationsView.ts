/**
 * The pure parts of the conversations list (Stage 3 part 4): how a row is dated and named,
 * when the list stops being scannable and needs a filter, what that filter matches, and the
 * exact sentence the delete confirm says.
 *
 * Here rather than in the component for the same reason `memoryView.ts` exists: these are
 * decisions, and decisions get tested. The confirm text in particular is a PROMISE about
 * what a delete does to four tables (migration 20260828010000) — if the two ever drift, the
 * client is being told something untrue at the moment he taps.
 *
 * **Part 4a: every row is named for its AUTHOR** — `ross — Meta ad about offsets`. The
 * prefix is derived here at render time from the roster the page already reads
 * (`src/lib/memory/naming.ts`, the same module the server uses), never stored, and never
 * part of what a rename edits.
 */
import {
  conversationDisplayName,
  conversationPrefix,
  UNTITLED_CONVERSATION,
} from '../../../src/lib/memory/naming.js';

/**
 * One `conversations` row as the browser reads it under RLS. Declared HERE, and re-exported
 * by supabase.ts, so this module stays testable under Node — supabase.ts reaches
 * `import.meta.env`, which does not exist outside a Vite build.
 */
/* eslint-disable @typescript-eslint/consistent-type-definitions --
   A type alias, not an interface: see the same block in supabase.ts. */
export type ConversationListRow = {
  id: string;
  title: string | null;
  scope: string;
  user_id: string;
  last_active_at: string;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

/** A row as it is shown. `title` stays raw because that is what a rename edits. */
export interface ConversationView {
  readonly id: string;
  /** The stored title, or null — what the rename field is pre-filled with. */
  readonly title: string | null;
  /** `ross — Meta ad about offsets`. What the list, the header and a chunk card show. */
  readonly displayName: string;
  /** The author's email local part, shown beside the rename field so it reads as fixed. */
  readonly prefix: string | null;
  readonly authorId: string;
  readonly when: string;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Australia/Perth',
});

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date);
}

/**
 * Rows plus the roster become what is on screen. `emailsById` is `app_users` as the page
 * already reads it — part 4 widened that policy to the whole roster (D56), which is exactly
 * what makes an author-prefixed list possible without a second server call.
 *
 * An author missing from the roster degrades to no prefix rather than to a broken one: their
 * conversation is still listed, still openable, still theirs.
 */
export function buildConversationList(
  rows: readonly ConversationListRow[],
  emailsById: ReadonlyMap<string, string>,
): readonly ConversationView[] {
  return rows.map((row) => {
    const email = emailsById.get(row.user_id) ?? null;
    return {
      id: row.id,
      title: row.title,
      displayName: conversationDisplayName(row.title, email),
      prefix: conversationPrefix(email),
      authorId: row.user_id,
      when: formatWhen(row.last_active_at),
    };
  });
}

/**
 * Long enough that scanning stops working and searching starts. Deliberately low: an unnamed
 * list is far harder to scan than a named one, so the filter is most useful exactly when it
 * looks least necessary.
 */
export const CONVERSATION_FILTER_THRESHOLD = 10;

/**
 * Matches the DISPLAYED name, which since part 4a includes the author — so typing a
 * colleague's name finds their conversations, which is the first thing anyone will try on a
 * list of fifty. Never the messages: they are not loaded, and pretending otherwise would lie.
 */
export function filterConversations(
  conversations: readonly ConversationView[],
  query: string,
): readonly ConversationView[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return conversations;
  return conversations.filter((c) => c.displayName.toLowerCase().includes(needle));
}

/** What a person reads before they tap. Every clause is a fact about a different table. */
export const DELETE_CONVERSATION_CONFIRM =
  'Delete this conversation? Its messages are removed for good and cannot be brought back, and so are the notes the assistant wrote about it. Standing notes — the things someone asked it to remember — are kept, and you can remove those on the Memory page.';

export { UNTITLED_CONVERSATION };
