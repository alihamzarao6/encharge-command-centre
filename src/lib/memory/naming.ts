/**
 * What a conversation is CALLED (Stage 3 part 4a) — derived, never stored whole.
 *
 * Conversations are workspace-scoped by default (D33), so since part 4 put staff on the
 * system every allowlisted member sees everyone's conversations in one list. With one user
 * that was invisible. With twenty brokers it is a wall of "Untitled conversation" that
 * nobody can attribute. So a conversation's display name carries its AUTHOR:
 *
 *     ross — Meta ad about offsets
 *
 * Three rules, and each is a consequence of the last:
 *
 *   1. The prefix comes from the AUTHOR, not the viewer. It says whose conversation this is,
 *      which is the whole point; a viewer-relative "you" would make the same row read
 *      differently to two people looking at the same list.
 *   2. It is DERIVED at display time from `app_users.email`, never written into
 *      `conversations.title`. If someone's email changes the label follows it on the next
 *      read, no row is wrong in the meantime, and no backfill is owed for the conversations
 *      that already exist. A stored prefix would be four kinds of stale.
 *   3. Renaming therefore edits only the part AFTER the prefix. The interface never puts the
 *      prefix in the input, and `stripConversationPrefix` is applied server-side as well, so
 *      a title can never come to contain its own prefix and render as "ross — ross — …".
 *
 * This module has NO imports: it is bundled into the browser (the list, the thread header
 * and the memory page's chunk cards all name conversations) and enforced on the server
 * (`src/lib/memory/page.ts` rename, `src/lib/llm/chat.ts` auto-title). One function, both
 * sides — the same discipline as `access.ts`.
 */

/**
 * The longest a conversation's stored title may be. Short on purpose: it is read in a list
 * on a 375 px screen, where anything longer is truncated and therefore not a name but a
 * paragraph. The derived prefix sits OUTSIDE this limit — it is not the person's to spend.
 *
 * *(Moved here from access.ts in part 4a: it belongs with the rest of naming, and access.ts
 * is about who may do what.)*
 */
export const CONVERSATION_TITLE_MAX_CHARS = 80;

/** Between the author and the name. An em dash with spaces, not a colon: it reads as an attribution, not a label. */
export const CONVERSATION_PREFIX_SEPARATOR = ' — ';

/** What a conversation nobody has named is called. */
export const UNTITLED_CONVERSATION = 'Untitled conversation';

/**
 * The author's email local part — `rossb@fundd.com.au` → `rossb`. Null when there is no
 * usable email, in which case the conversation shows its bare name rather than a broken
 * prefix: an author whose allowlist row cannot be read is a display problem, not a reason
 * to hide the conversation.
 */
export function conversationPrefix(authorEmail: string | null | undefined): string | null {
  if (typeof authorEmail !== 'string') return null;
  const local = authorEmail.trim().split('@')[0]?.trim() ?? '';
  return local === '' ? null : local;
}

/** What the list, the thread header and a chunk card all show. */
export function conversationDisplayName(
  title: string | null | undefined,
  authorEmail: string | null | undefined,
): string {
  const name =
    typeof title === 'string' && title.trim() !== '' ? title.trim() : UNTITLED_CONVERSATION;
  const prefix = conversationPrefix(authorEmail);
  return prefix === null ? name : `${prefix}${CONVERSATION_PREFIX_SEPARATOR}${name}`;
}

/**
 * Remove a leading prefix the author's own name would produce, so what gets STORED is only
 * ever the part a person typed. Loops, because a client that submitted an already-prefixed
 * title twice would otherwise leave one layer behind. Case-insensitive on the prefix only —
 * a title that legitimately begins with some other word and a dash is left alone.
 */
export function stripConversationPrefix(
  title: string,
  authorEmail: string | null | undefined,
): string {
  const prefix = conversationPrefix(authorEmail);
  let out = title.trim();
  if (prefix === null) return out;
  // Matched by pattern rather than by exact string: trimming has already eaten any trailing
  // space, and a person retyping the prefix will not reproduce its spacing exactly.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`^${escaped}\\s*—\\s*`, 'iu');
  // Bounded: each pass removes at least the prefix, and the test fails on an empty string.
  while (marker.test(out)) {
    out = out.replace(marker, '').trim();
  }
  return out;
}

/**
 * A name for a brand-new conversation, taken from the first thing the person said
 * (Stage 3 part 4a). Every conversation ever created has `title` null because nothing
 * generated one, which made renaming a chore rather than a correction — you had to name
 * everything before the list meant anything.
 *
 * Deliberately literal: the first sentence, or a clean cut on a word boundary. It is not
 * summarised and it costs nothing — no model call for something a person can fix in one tap,
 * and a wrong-but-cheap label he corrects beats a right-but-paid one he never looks at.
 *
 * Returns null when there is nothing usable, in which case the conversation stays untitled
 * and the list says so.
 */
export function titleFromFirstMessage(message: string): string | null {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;

  // A sentence that fits is the best possible name — it is exactly what he asked for.
  const sentence = /^(.{1,80}?)[.!?](\s|$)/.exec(flat)?.[1]?.trim();
  const candidate = sentence !== undefined && sentence !== '' ? sentence : flat;
  if (candidate.length <= CONVERSATION_TITLE_MAX_CHARS) {
    return trimTail(candidate);
  }

  // Otherwise cut on a word boundary, never mid-word, and never leave the punctuation of
  // the clause it cut into ("shorter,…" reads like a typo).
  const cut = candidate.slice(0, CONVERSATION_TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > CONVERSATION_TITLE_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  return trimTail(kept);
}

function trimTail(value: string): string | null {
  const out = value.replace(/[\s.,;:!?-]+$/, '').trim();
  return out === '' ? null : out;
}
