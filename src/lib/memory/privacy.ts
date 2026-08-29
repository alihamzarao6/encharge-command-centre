/**
 * Who can see whose conversations (Stage 3 part 5, FND-340) — R27, answered by the client.
 *
 * He was shown three options and chose the second:
 *
 *     "Each person's chats are their own. Nobody sees anyone else's. You, as the owner, can
 *      see everybody's. What the assistant LEARNS still goes into the one shared brain, so
 *      the team still benefits from each other's work."
 *
 * Four rules come out of that sentence, and they are here rather than in a component for
 * the same reason `access.ts` and `naming.ts` are: they are decisions, both sides need
 * them, and a rule stated twice is a rule that will eventually disagree with itself. This
 * module therefore has NO imports — it is bundled into the browser, and nothing from here
 * may drag a store, a key or a prompt into the client bundle.
 *
 *   1. WORKSPACE IS THE RESTING STATE. Not a nudge, not a default someone can change for
 *      the whole team: the client was promised one shared brain, and a private default
 *      would starve it while looking like a feature. Private is the deliberate exception.
 *
 *   2. ONLY THE AUTHOR MAY FLIP IT — not an administrator. This is the one place in the
 *      system where admin is deliberately NOT the wider power, and the asymmetry is the
 *      point: an admin turning someone's private conversation back to workspace would
 *      publish that person's messages to the whole team with a single tap, having been
 *      asked by nobody. An admin can already READ any conversation through the audited
 *      path; that is oversight. Changing whose it is would be something else.
 *
 *   3. THE MESSAGES GO PRIVATE; WHAT THE ASSISTANT LEARNED DOES NOT. The summary it writes
 *      about a private conversation, and anything anyone asks it to remember there, stay
 *      workspace-scoped. That is exactly what he chose, and it is the half a staff member
 *      will NOT guess — hence rule 4.
 *
 *   4. THE SCREEN SAYS SO, IN THOSE WORDS, BEFORE AND AFTER. A privacy control that is
 *      quietly less private than it looks is worse than no control at all. The sentence is
 *      here, tested, and shown wherever the toggle is.
 */

/**
 * The two values `conversations.scope` may hold. Named here so the browser can reason about
 * privacy without importing the store layer.
 */
export type ConversationScope = 'user' | 'workspace';

/**
 * The scope everything the assistant LEARNS is stored at, whatever the conversation it was
 * learned in (R27, option two). Enforced in the database for `memory_chunks`
 * (`memory_chunks_scope_workspace`, migration 20260829010000) and passed explicitly by the
 * two write paths that could otherwise inherit a private conversation's scope:
 * `src/lib/memory/trigger.ts` (the summariser) and the fact capture in
 * `src/lib/memory/retrieve.ts`.
 *
 * It is a named constant rather than a literal at each site so that the day this becomes a
 * choice again, there is one place that has to change and one place to read to know it did.
 */
export const SHARED_MEMORY_SCOPE = 'workspace' as const;

/** The resting state of a new conversation. */
export const DEFAULT_CONVERSATION_SCOPE: ConversationScope = 'workspace';

export function isPrivateScope(scope: string): boolean {
  return scope === 'user';
}

/** The signed-in person and the conversation's author, as both sides know them. */
export interface PrivacyActor {
  readonly userId: string;
  readonly isAdmin: boolean;
}

export interface PrivacyOwned {
  readonly authorId: string;
}

export type PrivacyVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly because: 'not_author' };

/**
 * Rule 2. Deliberately NOT `canRemoveMemory` — that one widens to an admin, and this one
 * must not. Kept as its own function rather than a parameter on that one so the difference
 * is legible at every call site instead of hiding in a boolean.
 */
export function canSetConversationPrivacy(
  owned: PrivacyOwned,
  actor: PrivacyActor,
): PrivacyVerdict {
  return owned.authorId === actor.userId
    ? { allowed: true }
    : { allowed: false, because: 'not_author' };
}

/** What the server says when someone else's conversation is what was asked about. */
export const PRIVACY_DENIED_MESSAGE =
  'Only the person who started a conversation can change who sees it.';

/** What the server says when a non-admin asks for the admin view. */
export const ADMIN_ONLY_MESSAGE = 'Only an administrator can do that.';

// ---------------------------------------------------------------------------------------
// The words on the screen. Rule 4.
// ---------------------------------------------------------------------------------------

/** The control itself, in the list row and the thread bar. */
export const PRIVACY_TOGGLE_LABEL = {
  /** Shown when the conversation is currently shared; tapping makes it private. */
  makePrivate: 'Make it just mine',
  /** Shown when it is currently private; tapping shares it again. */
  makeShared: 'Share with the team',
} as const;

/** The one-word state, shown on the row so a private conversation is obvious at a glance. */
export const PRIVACY_STATE_LABEL = {
  user: 'Just you',
  workspace: 'Team',
} as const;

/**
 * THE SENTENCE. Shown next to the control while a conversation is private, and in the
 * confirm step before it becomes private, so nobody learns the second half afterwards.
 *
 * Every clause is a fact about a different table, in the same discipline as
 * DELETE_CONVERSATION_CONFIRM: messages go private (`messages`, by trigger and RLS), the
 * conversation note does not (`memory_chunks`, forced workspace), a standing note does not
 * (`memory_facts`, written at SHARED_MEMORY_SCOPE), and an administrator can still read it
 * (the audited server path). If any of those four stops being true, this sentence is a lie
 * and `tests/unit/memory/privacy.test.ts` is where that gets caught.
 */
export const PRIVACY_EXPLANATION =
  'Only you and an administrator can open this conversation or read what is said in it. ' +
  'What the assistant learns here is still shared: the short note it writes about this ' +
  'conversation, and anything you ask it to remember, go to the whole team as usual.';

/** Shown while a conversation is shared, so the resting state is stated rather than assumed. */
export const SHARED_EXPLANATION =
  'Anyone on the team can open this conversation and read it. That is the normal setting.';

/** After the change lands. Short, because the explanation above is still on screen. */
export const PRIVACY_NOTICE = {
  nowPrivate: 'This conversation is now just yours. Its notes are still shared with the team.',
  nowShared: 'This conversation is visible to the team again.',
} as const;

/** The admin view of other people's private conversations, labelled as what it is. */
export const ADMIN_PRIVATE_SECTION = {
  heading: 'Private conversations',
  /** Why an owner is being shown a list with no names in it. */
  hint:
    'These belong to the people who started them. You can open one because you are an ' +
    'administrator, and each time you do it is recorded. Names are not shown here — a ' +
    "conversation's name is the first thing someone said in it.",
  /** What a row is called, since the listing deliberately carries no title. */
  rowName: 'A private conversation',
  empty: 'Nobody has made a conversation private.',
} as const;

/**
 * The Memory page's chunk card when the note's conversation cannot be opened by the person
 * looking at it. It is not "removed" — the note is right there and it is shared on purpose.
 */
export const CHUNK_PRIVATE_SOURCE = {
  name: 'A private conversation',
  hint: 'The conversation this came from is private to the person who started it. The note itself is shared with the team.',
} as const;
