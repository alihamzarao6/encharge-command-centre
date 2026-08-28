/**
 * The pure parts of the conversations list (Stage 3 part 4): how a row is dated, when the
 * list stops being scannable and needs a filter, what that filter matches, and the exact
 * sentence the delete confirm says.
 *
 * Here rather than in the component for the same reason `memoryView.ts` exists: these are
 * decisions, and decisions get tested. The confirm text in particular is a PROMISE about
 * what a delete does to four tables (migration 20260828010000) — if the two ever drift, the
 * client is being told something untrue at the moment he taps.
 */
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
 * Long enough that scanning stops working and searching starts. Deliberately low: nothing
 * has ever generated a title, so an unnamed list is far harder to scan than a named one and
 * the filter is most useful exactly when it looks least necessary.
 */
export const CONVERSATION_FILTER_THRESHOLD = 10;

/** Matches on the name only — the messages are not loaded, and pretending otherwise would lie. */
export function filterConversations(
  conversations: readonly ConversationListRow[],
  query: string,
): readonly ConversationListRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return conversations;
  return conversations.filter((c) => (c.title ?? '').toLowerCase().includes(needle));
}

/** What a person reads before they tap. Every clause is a fact about a different table. */
export const DELETE_CONVERSATION_CONFIRM =
  'Delete this conversation? Its messages are removed for good and cannot be brought back, and so are the notes the assistant wrote about it. Standing notes — the things someone asked it to remember — are kept, and you can remove those on the Memory page.';

export const UNTITLED_CONVERSATION = 'Untitled conversation';
