/**
 * One conversation, two surfaces (Milestone 4 part 2).
 *
 * The Assistant page and the docked panel show the SAME thread: the same conversation id,
 * the same messages, the same turn in flight, the same unsent draft. Rather than two copies
 * of that state kept in step by hand, there is one store — framework-free, subscribable —
 * that both surfaces read through `useSyncExternalStore`. A message sent from the panel is
 * in the page's thread before the reply has finished arriving, and the other way round,
 * because there is only one thread to be in.
 *
 * The store outlives any one screen: it is created when the shell mounts (once per sign-in)
 * and not when a section does, so navigating from the overview to Memory and back with the
 * panel open keeps the conversation, and a reply that arrives while the person is on another
 * screen lands here and waits. `unseenReply` is how the shell knows to say so.
 *
 * What moved here from Assistant.tsx moved unchanged in behaviour: the D76 in-flight record,
 * the streaming bubble, the failed bubble with Retry, the 401 that hands the draft across the
 * login screen. The server side of a turn is untouched — this part re-places the chat
 * surface; it does not change how chat works.
 */
import type { ChatFailure, ChatOutcome, StreamHandlers, TurnInput } from './chatApi.js';
import {
  clearPending,
  loadDraft,
  saveDraft,
  saveOpenConversation,
  savePending,
  type DraftStorage,
  type PendingDraft,
} from './draft.js';

export interface ThreadMessage {
  readonly localId: string;
  readonly id: string | null;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /**
   * saved — on the server; sending — the user's message, in flight; streaming — the reply,
   * arriving; failed — the user's message, with the reason and (maybe) the partial reply.
   */
  readonly status: 'saved' | 'sending' | 'streaming' | 'failed';
  readonly error?: ChatFailure;
}

export interface ThreadState {
  readonly activeId: string | null;
  readonly messages: readonly ThreadMessage[];
  readonly threadState: 'idle' | 'loading' | 'error';
  /** A turn is in flight. */
  readonly sending: boolean;
  /** A turn is in flight and no reply text has arrived yet. */
  readonly waiting: boolean;
  readonly draft: string;
  /** Bumped when a turn was saved on the server: the page reloads its conversation list. */
  readonly turnsSaved: number;
  /** One sentence about a restored draft, shown above the thread until dismissed. */
  readonly notice: string | null;
  /** A reply (or a failure) landed while no surface was showing the thread. */
  readonly unseenReply: boolean;
  /** The D76 first-load decision has been made once for this sign-in. */
  readonly initialised: boolean;
}

export interface ThreadDeps {
  readonly storage: DraftStorage | null;
  /** The thread's saved messages, or null when they could not be read. */
  readonly loadMessages: (conversationId: string) => Promise<readonly ThreadMessage[] | null>;
  readonly streamTurn: (input: TurnInput, handlers: StreamHandlers) => Promise<ChatOutcome>;
  /** A fresh token: supabase-js refreshes it if it is about to expire. */
  readonly getAccessToken: () => Promise<string>;
  readonly onSessionExpired: (pending: PendingDraft | null) => Promise<void>;
}

/** Function-typed properties rather than methods: every one is passed around unbound. */
export interface ThreadStore {
  readonly getState: () => ThreadState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Select a conversation (or a new one); the previous draft is kept under its own key. */
  readonly open: (conversationId: string | null) => Promise<void>;
  /** Reopen after the page came back, and work out what happened to a turn in flight. */
  readonly restore: (conversationId: string, pending: PendingDraft | null) => Promise<void>;
  /** Take a draft for a conversation that never reached the server. */
  readonly adoptDraft: (text: string) => void;
  readonly setDraft: (text: string) => void;
  readonly send: (text: string, replaceLocalId: string | null) => Promise<void>;
  readonly retry: (message: ThreadMessage) => void;
  readonly discard: (localId: string) => void;
  /** The thread on screen is gone (deleted) or handed over (an admin's read): show nothing. */
  readonly clear: () => void;
  readonly clearNotice: () => void;
  /** A surface showing the thread has seen whatever arrived. */
  readonly markSeen: () => void;
}

export const LEFT_MID_SEND_NOTICE =
  'You left before that message finished sending, so it was not saved. It is back in the box — send it again when you are ready.';

let localCounter = 0;
function nextLocalId(): string {
  localCounter += 1;
  return `local-${String(localCounter)}`;
}

const INITIAL: ThreadState = {
  activeId: null,
  messages: [],
  threadState: 'idle',
  sending: false,
  waiting: false,
  draft: '',
  turnsSaved: 0,
  notice: null,
  unseenReply: false,
  initialised: false,
};

export function createThreadStore(deps: ThreadDeps): ThreadStore {
  let state: ThreadState = INITIAL;
  const listeners = new Set<() => void>();

  const set = (
    patch: Partial<ThreadState> | ((current: ThreadState) => Partial<ThreadState>),
  ): void => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  /** Returns what it put on screen, so a caller can ask whether a given turn survived. */
  const load = async (conversationId: string): Promise<readonly ThreadMessage[]> => {
    set({ threadState: 'loading' });
    const loaded = await deps.loadMessages(conversationId);
    // The person may have moved on while the read was in flight.
    if (state.activeId !== conversationId) return [];
    if (loaded === null) {
      set({ threadState: 'error' });
      return [];
    }
    set({ messages: loaded, threadState: 'idle' });
    return loaded;
  };

  const open = async (conversationId: string | null): Promise<void> => {
    saveDraft(deps.storage, state.activeId, state.draft);
    saveOpenConversation(deps.storage, conversationId);
    set({
      activeId: conversationId,
      draft: loadDraft(deps.storage, conversationId),
      messages: [],
      threadState: 'idle',
      initialised: true,
    });
    if (conversationId !== null) await load(conversationId);
  };

  const restore = async (conversationId: string, pending: PendingDraft | null): Promise<void> => {
    set({ activeId: conversationId, messages: [], initialised: true });
    const saved = await load(conversationId);
    if (pending === null || pending.text.trim() === '') {
      set({ draft: loadDraft(deps.storage, conversationId) });
      return;
    }
    // The fetch itself is gone — a discarded page takes its network with it — but the
    // SERVER may well have finished and saved the turn. Only if the sent text is nowhere in
    // the thread was it genuinely lost, and then the words go back into the composer.
    const landed = saved.some((m) => m.role === 'user' && m.content.trim() === pending.text.trim());
    if (landed) {
      set({ draft: loadDraft(deps.storage, conversationId) });
      return;
    }
    set({ draft: pending.text, notice: LEFT_MID_SEND_NOTICE });
  };

  const send = async (text: string, replaceLocalId: string | null): Promise<void> => {
    if (state.sending) return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    const activeId = state.activeId;
    // D76: record the turn as in flight BEFORE it leaves. Cleared on every completion path.
    savePending(deps.storage, { conversationId: activeId, text: trimmed });
    const localId = replaceLocalId ?? nextLocalId();
    const userMessage: ThreadMessage = {
      localId,
      id: null,
      role: 'user',
      content: trimmed,
      status: 'sending',
    };
    // A surface that has sent a turn has made the first-load decision: the page must not
    // later "restore where you were" over a thread that is live in memory.
    set((current) => ({
      sending: true,
      waiting: true,
      unseenReply: false,
      initialised: true,
      messages:
        replaceLocalId === null
          ? [...current.messages, userMessage]
          : current.messages.map((m) => (m.localId === replaceLocalId ? userMessage : m)),
      ...(replaceLocalId === null ? { draft: '' } : {}),
    }));
    if (replaceLocalId === null) saveDraft(deps.storage, activeId, '');

    const accessToken = await deps.getAccessToken();
    const replyLocalId = `${localId}-reply`;
    let started = false;
    const outcome = await deps.streamTurn(
      { accessToken, message: trimmed, conversationId: activeId },
      {
        onStart: (conversationId) => {
          // The earliest moment a NEW conversation has an id: persisting it here is what
          // makes a first message survive the page being discarded mid-answer.
          saveOpenConversation(deps.storage, conversationId);
          if (state.activeId === null) set({ activeId: conversationId });
        },
        onDelta: (delta) => {
          if (!started) {
            started = true;
            set((current) => ({
              waiting: false,
              messages: [
                ...current.messages,
                {
                  localId: replyLocalId,
                  id: null,
                  role: 'assistant',
                  content: delta,
                  status: 'streaming',
                },
              ],
            }));
            return;
          }
          set((current) => ({
            messages: current.messages.map((m) =>
              m.localId === replyLocalId ? { ...m, content: m.content + delta } : m,
            ),
          }));
        },
      },
    );

    // Whatever happens next, the streaming bubble is replaced by a verdict.
    const withoutStream = (messages: readonly ThreadMessage[]): ThreadMessage[] =>
      messages.filter((m) => m.localId !== replyLocalId);

    if (outcome.kind === 'ok') {
      set((current) => ({
        waiting: false,
        sending: false,
        unseenReply: true,
        turnsSaved: current.turnsSaved + 1,
        activeId: current.activeId ?? outcome.conversationId,
        messages: [
          ...withoutStream(current.messages).map((m) =>
            m.localId === localId
              ? { ...m, id: outcome.userMessageId, status: 'saved' as const }
              : m,
          ),
          {
            localId: outcome.assistantMessageId,
            id: outcome.assistantMessageId,
            role: 'assistant',
            content: outcome.reply,
            status: 'saved',
          },
        ],
      }));
      clearPending(deps.storage);
      return;
    }

    if (outcome.failure === 'unauthenticated') {
      set((current) => ({
        waiting: false,
        sending: false,
        messages: withoutStream(current.messages),
      }));
      await deps.onSessionExpired({ conversationId: activeId, text: trimmed });
      return;
    }

    const failed: ChatFailure = outcome;
    set((current) => ({
      waiting: false,
      sending: false,
      unseenReply: true,
      messages: withoutStream(current.messages).map((m) =>
        m.localId === localId ? { ...m, status: 'failed', error: failed } : m,
      ),
    }));
    // The failure is on screen as a bubble with a Retry, so the text is not lost and the
    // in-flight record would only duplicate it on the next load.
    clearPending(deps.storage);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    restore,
    adoptDraft: (text) => {
      set({ draft: text, initialised: true });
    },
    setDraft: (text) => {
      set({ draft: text });
      saveDraft(deps.storage, state.activeId, text);
    },
    send,
    retry: (message) => {
      void send(message.content, message.localId);
    },
    discard: (localId) => {
      set((current) => ({ messages: current.messages.filter((m) => m.localId !== localId) }));
    },
    clear: () => {
      set({ activeId: null, messages: [], threadState: 'idle', initialised: true });
    },
    clearNotice: () => {
      set({ notice: null });
    },
    markSeen: () => {
      if (state.unseenReply) set({ unseenReply: false });
    },
  };
}
