/**
 * What the user typed survives a session expiry and a reload. Kept per conversation in
 * sessionStorage (cleared when the tab closes — a draft is not a record) and, on a session
 * expiry, handed across the login screen through the same store.
 *
 * Storage is injected so this is testable without a browser, and every access is wrapped:
 * private browsing and storage quotas throw, and a draft is never worth a crash.
 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'fundd-draft:';
export const NEW_CONVERSATION_KEY = 'new';
export const PENDING_KEY = `${PREFIX}pending`;
export const MAX_DRAFT_CHARS = 8_000;

export function draftKey(conversationId: string | null): string {
  return `${PREFIX}${conversationId ?? NEW_CONVERSATION_KEY}`;
}

export function loadDraft(storage: DraftStorage | null, conversationId: string | null): string {
  if (storage === null) return '';
  try {
    return storage.getItem(draftKey(conversationId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(
  storage: DraftStorage | null,
  conversationId: string | null,
  text: string,
): void {
  if (storage === null) return;
  try {
    if (text.trim() === '') {
      storage.removeItem(draftKey(conversationId));
    } else {
      storage.setItem(draftKey(conversationId), text.slice(0, MAX_DRAFT_CHARS));
    }
  } catch {
    // Storage unavailable: the draft lives in the textarea only.
  }
}

/** A message that was being sent when the session expired: restored after sign-in. */
export interface PendingDraft {
  readonly conversationId: string | null;
  readonly text: string;
}

export function savePending(storage: DraftStorage | null, pending: PendingDraft): void {
  if (storage === null) return;
  try {
    storage.setItem(
      PENDING_KEY,
      JSON.stringify({
        conversationId: pending.conversationId,
        text: pending.text.slice(0, MAX_DRAFT_CHARS),
      }),
    );
  } catch {
    // As above.
  }
}

export function takePending(storage: DraftStorage | null): PendingDraft | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(PENDING_KEY);
    if (raw === null) return null;
    storage.removeItem(PENDING_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'text' in parsed &&
      typeof parsed.text === 'string' &&
      'conversationId' in parsed &&
      (typeof parsed.conversationId === 'string' || parsed.conversationId === null)
    ) {
      return { conversationId: parsed.conversationId, text: parsed.text };
    }
    return null;
  } catch {
    return null;
  }
}
