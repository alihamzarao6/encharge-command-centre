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
/** Which conversation was on screen. See `saveOpenConversation`. */
export const OPEN_KEY = `${PREFIX}open`;
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

/** The turn finished (or failed visibly), so there is nothing left to recover. */
export function clearPending(storage: DraftStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(PENDING_KEY);
  } catch {
    // Storage unavailable: `takePending` will not find anything either.
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

// ---------------------------------------------------------------------------------------
// Which conversation is open (D76).
//
// A phone browser evicts a backgrounded tab whenever it feels like it. Coming back reloads
// the page, and every piece of React state goes with it — including which conversation was on
// screen, so the person landed on "New conversation" and their thread appeared to be gone.
// It was not gone; nothing was ever pointing at it.
//
// sessionStorage rather than localStorage, on purpose: this is "where I was a moment ago",
// not "my last conversation forever". Opening a new tab should start clean.
// ---------------------------------------------------------------------------------------

export function saveOpenConversation(
  storage: DraftStorage | null,
  conversationId: string | null,
): void {
  if (storage === null) return;
  try {
    if (conversationId === null) {
      storage.removeItem(OPEN_KEY);
    } else {
      storage.setItem(OPEN_KEY, conversationId);
    }
  } catch {
    // Storage unavailable: the app still works, it just forgets where it was.
  }
}

export function loadOpenConversation(storage: DraftStorage | null): string | null {
  if (storage === null) return null;
  try {
    const value = storage.getItem(OPEN_KEY);
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}
