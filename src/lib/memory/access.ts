/**
 * Who may remove something from memory (Stage 3 part 3, FND-320).
 *
 * Memory is one brain for the business (D33): a workspace note is asserted on every turn,
 * for every user, until someone removes it. That cuts both ways —
 *
 *   - a wrong note is expensive for everyone, so the person who spots it must not have to
 *     wait for an admin to be free before it stops going out;
 *   - a shared brain that anyone can empty is a shared brain that one careless tap degrades
 *     for everyone, and the client was promised the removing is HIS to do.
 *
 * The rule that satisfies both, and that people already understand from every other tool:
 * **anyone may add or correct; you may remove what you contributed; an admin may remove
 * anything.** Adding is additive and visible; correcting keeps the old value in the history
 * (append-only, D10); removing is the only operation that takes something away from
 * everybody, so it is the only one that is gated.
 *
 * Today there is one user and he is the admin, so the rule changes nothing for him. It
 * exists because part 4 adds staff, and retrofitting a permission after several people have
 * been deleting each other's notes is not a code change, it is an apology.
 *
 * This module is imported by BOTH sides: the Edge Function enforces it (the authority) and
 * the browser calls it to decide whether to render the button, so the interface can never
 * offer an action the server will refuse. It therefore has no imports at all — nothing from
 * here may drag a store, a key or a prompt into the client bundle.
 */

/** The signed-in person, as both sides know them. */
export interface MemoryActor {
  readonly userId: string;
  readonly isAdmin: boolean;
}

/** The row being acted on: `user_id` is its author (SCHEMA.md §4). */
export interface MemoryOwned {
  readonly authorId: string;
}

export type RemovalVerdict =
  | { readonly allowed: true; readonly because: 'author' | 'admin' }
  | { readonly allowed: false; readonly because: 'not_author' };

export function canRemoveMemory(owned: MemoryOwned, actor: MemoryActor): RemovalVerdict {
  if (owned.authorId === actor.userId) return { allowed: true, because: 'author' };
  if (actor.isAdmin) return { allowed: true, because: 'admin' };
  return { allowed: false, because: 'not_author' };
}

/** One sentence, written for the person holding the phone, not for a log. */
export const REMOVAL_DENIED_MESSAGE =
  'Only the person who added this, or an administrator, can remove it.';

/**
 * Stage 3 part 4: the same rule, applied to a whole conversation. Deleting one destroys its
 * messages for everybody, so it is the strongest case for the gate, not the weakest.
 */
export const CONVERSATION_DELETE_DENIED_MESSAGE =
  'Only the person who started this conversation, or an administrator, can delete it.';

/**
 * Renaming is the AUTHOR's, and nobody else's — not even an administrator (30 Aug, D75).
 *
 * D60 made naming open to every allowlisted member, on the reasoning that a name is a
 * correction rather than a removal and nothing had ever generated one. Both halves of that
 * have since stopped being true: part 4a auto-titles every conversation from its first
 * message, so a name is no longer missing, and part 4 put staff on the system, so the list is
 * full of other people's work. A conversation's name is how its author finds their own thread
 * again; letting a colleague rewrite it is not a correction, it is moving somebody else's
 * furniture.
 *
 * No admin exception, deliberately, and it is the one place that differs from
 * `canRemoveMemory`: deleting is a removal that an admin may need to make on the workspace's
 * behalf, whereas renaming somebody else's conversation is never something the business needs
 * an administrator to do.
 */
export function canRenameConversation(owned: MemoryOwned, actor: MemoryActor): RemovalVerdict {
  return owned.authorId === actor.userId
    ? { allowed: true, because: 'author' }
    : { allowed: false, because: 'not_author' };
}

export const CONVERSATION_RENAME_DENIED_MESSAGE =
  'Only the person who started this conversation can rename it.';

// ---------------------------------------------------------------------------------------
// The two limits both sides need. They live here for the same reason the rule above does:
// an interface that lets someone type 900 characters into a field the server caps at 400 is
// an interface that wastes their time and then blames them.
// ---------------------------------------------------------------------------------------

/** What a person may type into "add a note" before it is an essay, not a note. */
export const MEMORY_NOTE_MAX_INPUT_CHARS = 1_000;

/**
 * The longest a stored note may be. MIRRORS `FACT_VALUE_MAX_CHARS` in facts.ts, which is
 * the store's own limit; `tests/unit/memory/access.test.ts` asserts the two agree, so this
 * copy can never drift away from the thing it is a copy of. It is a copy rather than an
 * import because facts.ts reaches the database and this module is bundled into the browser.
 */
export const MEMORY_NOTE_MAX_VALUE_CHARS = 400;
