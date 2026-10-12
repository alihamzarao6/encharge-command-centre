/**
 * Who may do what with an attached file (Milestone 5 part 1) — imported by the Edge Function
 * AND by the browser, so the interface offers a button exactly where the server will honour
 * it (the pattern `memory/access.ts` set).
 *
 * SEEING a file follows its conversation (D86): whoever can read the conversation can see
 * the file and the answers about it. The client's staff already work the same client files
 * in the CRM; locking a file to one person would be stricter than the business is.
 *
 * REMOVING is the rule every other removal in this app follows (D52): the person who added
 * it, or an administrator. Attaching adds; removing takes something away from everyone who
 * could see it.
 */
import { canRemoveMemory, type MemoryActor, type RemovalVerdict } from '../memory/access.js';

export interface ConversationVisibility {
  /** The conversation's author. */
  readonly conversationAuthorId: string;
  readonly scope: 'user' | 'workspace';
}

/** The same rule the chat applies to a turn: a shared conversation, or your own private one. */
export function canSeeConversationFiles(owned: ConversationVisibility, userId: string): boolean {
  return owned.scope === 'workspace' || owned.conversationAuthorId === userId;
}

export function canRemoveFile(
  file: { readonly uploadedBy: string },
  actor: MemoryActor,
): RemovalVerdict {
  return canRemoveMemory({ authorId: file.uploadedBy }, actor);
}

export const FILE_REMOVAL_DENIED_MESSAGE =
  'Only the person who attached this file, or an administrator, can remove it.';
