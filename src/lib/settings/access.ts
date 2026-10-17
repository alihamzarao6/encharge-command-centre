/**
 * Who may do what on the settings page (Milestone 5 part 4) — imported by the Edge Function AND
 * by the browser, so the page offers a button exactly where the server will honour it (the
 * pattern `memory/access.ts` set). No imports: nothing here may pull a store, a key or a client
 * into the bundle.
 *
 * FORGETTING A DOCUMENT is a removal, so it follows the rule every removal in this app follows
 * (D52): the person who added it, or an administrator. A learned document has COPIES — the same
 * file attached in another conversation, perhaps by somebody else, perhaps in their private
 * conversation — and forgetting takes every copy (it would still answer otherwise). So the person
 * must have added every copy: a member of staff who is not an administrator never removes a
 * colleague's attachment by forgetting their own. The database function `forget_document`
 * enforces the same rule under its locks; this is the polite refusal at the door.
 *
 * SEEING the list is not gated here: every active member of staff reads every learned document
 * (knowledge is the account's, part 5 decision 3), under the policy that already says so.
 *
 * CONNECTOR KEYS are each person's own. The list is their own rows (RLS), and creating and
 * switching off act only on the signed-in person's keys — there is no "any key" path from the
 * page; that stays the terminal's (`npm run connector -- revoke`).
 */

/** The signed-in person, as both sides know them. Same shape as memory's `MemoryActor`. */
export interface SettingsActor {
  readonly userId: string;
  readonly isAdmin: boolean;
}

/** A learned document as the rule needs it: who added it, and who added each other copy. */
export interface ForgettableDocument {
  /** Null when that account no longer exists. */
  readonly uploadedBy: string | null;
  /** The uploaders of the other learned copies of the same bytes that the browser can see. */
  readonly copyUploaders: readonly (string | null)[];
}

export type ForgetVerdict =
  | { readonly allowed: true; readonly because: 'added_every_copy' | 'admin' }
  | { readonly allowed: false; readonly because: 'not_added' | 'copy_added_by_someone_else' };

export function canForgetDocument(doc: ForgettableDocument, actor: SettingsActor): ForgetVerdict {
  if (actor.isAdmin) return { allowed: true, because: 'admin' };
  if (doc.uploadedBy !== actor.userId) return { allowed: false, because: 'not_added' };
  if (doc.copyUploaders.some((uploader) => uploader !== actor.userId)) {
    return { allowed: false, because: 'copy_added_by_someone_else' };
  }
  return { allowed: true, because: 'added_every_copy' };
}

/** One sentence each, written for the person holding the phone. */
export const FORGET_DENIED_MESSAGES = {
  not_added: 'Only the person who added this document, or an administrator, can forget it.',
  copy_added_by_someone_else:
    'Someone else added a copy of this document too, so only an administrator can forget it.',
} as const;

/** What the server says when it refuses, covering both cases (it does not say whose copy). */
export const FORGET_REFUSED_MESSAGE =
  'Only an administrator can forget this one: someone else added it, or a copy of it.';

/** Connector key labels, as the database holds them (`connector_keys.label`). */
export const KEY_LABEL_MAX = 80;
/** The most live keys one person may hold; the database enforces the same number (CK002). */
export const MAX_LIVE_KEYS_PER_PERSON = 5;
