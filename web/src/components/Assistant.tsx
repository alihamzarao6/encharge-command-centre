/**
 * The live section: conversations on the left (a slide-in sheet on a phone), the thread and
 * the composer on the right. Reads go straight to Supabase under RLS as the signed-in user;
 * the one write — a turn — goes to the Edge Function, which owns the voice, the cap and
 * the history.
 *
 * A message that fails stays on screen as a failed bubble with the reason and a Retry that
 * resends the same text; it is never silently dropped. A 401 keeps the text and hands it
 * across the login screen (App.onSessionExpired).
 */
import type { Session } from '@supabase/supabase-js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type SyntheticEvent,
} from 'react';

import { CONVERSATION_TITLE_MAX_CHARS, type MemoryActor } from '../../../src/lib/memory/access.js';
import { streamTurn, type ChatFailure } from '../lib/chatApi.js';
import { webConfig } from '../lib/env.js';
import { loadDraft, saveDraft, takePending, type PendingDraft } from '../lib/draft.js';
import { callMemory, type MemoryRequest } from '../lib/memoryApi.js';
import { supabase, type AppUserRow, type ConversationListRow } from '../lib/supabase.js';
import { Composer } from './Composer.js';
import { ConversationList } from './ConversationList.js';
import { Thread, type LocalMessage } from './Thread.js';

interface Props {
  readonly session: Session;
  /** Stage 3 part 4: who is asking, so the list offers Delete only where the server allows it. */
  readonly staff: AppUserRow;
  /**
   * Stage 3 part 3: a conversation the Memory page asked to open, because a note came from
   * it. Read once when this section mounts; the shell clears it on any other navigation.
   */
  readonly openConversationId?: string | null;
  readonly onSessionExpired: (pending: PendingDraft | null) => Promise<void>;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let localCounter = 0;
function nextLocalId(): string {
  localCounter += 1;
  return `local-${String(localCounter)}`;
}

export function Assistant({
  session,
  staff,
  openConversationId,
  onSessionExpired,
}: Props): ReactElement {
  const [conversations, setConversations] = useState<ConversationListRow[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [threadState, setThreadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [draft, setDraft] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  // Stage 3 part 4: renaming and deleting a conversation. `managing` is the id being written
  // right now, so one slow rename never freezes the whole list; `notice` is the one sentence
  // the change earned, shown above the thread rather than in a toast that scrolls away.
  const [managing, setManaging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const pendingRestored = useRef(false);

  const actor: MemoryActor = useMemo(
    () => ({ userId: staff.user_id, isAdmin: staff.is_admin }),
    [staff.user_id, staff.is_admin],
  );

  const loadConversations = useCallback(async (): Promise<ConversationListRow[]> => {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, title, scope, user_id, last_active_at')
      .is('deleted_at', null)
      .order('last_active_at', { ascending: false })
      .limit(100);
    if (error !== null) {
      setListState('error');
      return [];
    }
    setConversations(data);
    setListState('ready');
    return data;
  }, []);

  const loadMessages = useCallback(async (conversationId: string): Promise<void> => {
    setThreadState('loading');
    const { data, error } = await supabase
      .from('messages')
      .select('id, conversation_id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: true })
      .limit(500);
    if (error !== null) {
      setThreadState('error');
      return;
    }
    setMessages(
      data
        .filter((row) => row.content !== null)
        .map((row) => ({
          localId: row.id,
          id: row.id,
          role: row.role === 'assistant' ? 'assistant' : 'user',
          content: row.content ?? '',
          status: 'saved',
        })),
    );
    setThreadState('idle');
  }, []);

  // First load: the list, then either the conversation the Memory page asked for or a
  // message that was mid-flight when the session expired. An explicit request wins; the
  // unsent draft is left where it is rather than consumed, so it survives for next time.
  useEffect(() => {
    void loadConversations();
    if (pendingRestored.current) return;
    pendingRestored.current = true;
    if (openConversationId !== undefined && openConversationId !== null) {
      setActiveId(openConversationId);
      setDraft(loadDraft(storage(), openConversationId));
      void loadMessages(openConversationId);
      return;
    }
    const pending = takePending(storage());
    if (pending !== null) {
      setActiveId(pending.conversationId);
      setDraft(pending.text);
      if (pending.conversationId !== null) void loadMessages(pending.conversationId);
    }
  }, [loadConversations, loadMessages, openConversationId]);

  const selectConversation = useCallback(
    (id: string | null): void => {
      saveDraft(storage(), activeId, draft);
      setActiveId(id);
      setSheetOpen(false);
      setDraft(loadDraft(storage(), id));
      if (id === null) {
        setMessages([]);
        setThreadState('idle');
      } else {
        void loadMessages(id);
      }
    },
    [activeId, draft, loadMessages],
  );

  const onDraftChange = useCallback(
    (text: string): void => {
      setDraft(text);
      saveDraft(storage(), activeId, text);
    },
    [activeId],
  );

  const send = useCallback(
    async (text: string, replaceLocalId: string | null): Promise<void> => {
      if (sending) return;
      const trimmed = text.trim();
      if (trimmed === '') return;
      setSending(true);
      setWaiting(true);
      const localId = replaceLocalId ?? nextLocalId();
      const userMessage: LocalMessage = {
        localId,
        id: null,
        role: 'user',
        content: trimmed,
        status: 'sending',
      };
      setMessages((current) =>
        replaceLocalId === null
          ? [...current, userMessage]
          : current.map((m) => (m.localId === replaceLocalId ? userMessage : m)),
      );
      if (replaceLocalId === null) {
        setDraft('');
        saveDraft(storage(), activeId, '');
      }

      // A fresh token: supabase-js refreshes it if it is about to expire.
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token ?? session.access_token;

      // The reply bubble appears with the first token and grows; Copy waits for `done`.
      const replyLocalId = `${localId}-reply`;
      let started = false;
      const outcome = await streamTurn(
        { chatUrl: webConfig.chatUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
        { accessToken, message: trimmed, conversationId: activeId },
        {
          onStart: (conversationId) => {
            if (activeId === null) setActiveId(conversationId);
          },
          onDelta: (text) => {
            setMessages((current) => {
              if (!started) {
                started = true;
                setWaiting(false);
                return [
                  ...current,
                  {
                    localId: replyLocalId,
                    id: null,
                    role: 'assistant',
                    content: text,
                    status: 'streaming',
                  },
                ];
              }
              return current.map((m) =>
                m.localId === replyLocalId ? { ...m, content: m.content + text } : m,
              );
            });
          },
        },
      );
      setWaiting(false);
      // Whatever happens next, the streaming bubble is replaced by a verdict.
      setMessages((current) => current.filter((m) => m.localId !== replyLocalId));

      if (outcome.kind === 'ok') {
        setMessages((current) => [
          ...current.map((m) =>
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
        ]);
        if (activeId === null) setActiveId(outcome.conversationId);
        void loadConversations();
        setSending(false);
        return;
      }

      if (outcome.failure === 'unauthenticated') {
        setSending(false);
        await onSessionExpired({ conversationId: activeId, text: trimmed });
        return;
      }

      const failed: ChatFailure = outcome;
      setMessages((current) =>
        current.map((m) => (m.localId === localId ? { ...m, status: 'failed', error: failed } : m)),
      );
      setSending(false);
    },
    [activeId, loadConversations, onSessionExpired, sending, session.access_token],
  );

  const retry = useCallback(
    (message: LocalMessage): void => {
      void send(message.content, message.localId);
    },
    [send],
  );

  const discardFailed = useCallback((localId: string): void => {
    setMessages((current) => current.filter((m) => m.localId !== localId));
  }, []);

  /** One conversation change, through the same verified endpoint every other write uses. */
  const manage = useCallback(
    async (request: MemoryRequest, conversationId: string): Promise<boolean> => {
      setManaging(conversationId);
      setNotice(null);
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token ?? session.access_token;
      const outcome = await callMemory(
        {
          memoryUrl: webConfig.memoryUrl,
          anonKey: webConfig.anonKey,
          fetch: fetch.bind(globalThis),
        },
        accessToken,
        request,
      );
      setManaging(null);
      if (outcome.kind === 'error') {
        if (outcome.failure === 'unauthenticated') {
          await onSessionExpired(null);
          return false;
        }
        setNotice(outcome.message);
        // Someone else got there first: the list on screen is describing a past.
        if (outcome.failure === 'stale') void loadConversations();
        return false;
      }
      return true;
    },
    [loadConversations, onSessionExpired, session.access_token],
  );

  const renameConversation = useCallback(
    async (conversationId: string, newTitle: string): Promise<void> => {
      const done = await manage(
        { action: 'rename_conversation', conversationId, title: newTitle },
        conversationId,
      );
      if (!done) return;
      await loadConversations();
    },
    [loadConversations, manage],
  );

  const deleteConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      const done = await manage({ action: 'delete_conversation', conversationId }, conversationId);
      if (!done) return;
      // Whatever was on screen is now describing rows that are gone.
      if (conversationId === activeId) {
        setActiveId(null);
        setMessages([]);
        setThreadState('idle');
      }
      setNotice(
        'Conversation deleted. Its messages are gone for good; anything you asked the assistant to remember is still on the Memory page.',
      );
      await loadConversations();
    },
    [activeId, loadConversations, manage],
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const title = active?.title ?? (activeId === null ? 'New conversation' : 'Conversation');

  const submitRename = (event: SyntheticEvent): void => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const field = form.elements.namedItem('thread-rename');
    const value = field instanceof HTMLInputElement ? field.value.trim() : '';
    if (value === '' || activeId === null) return;
    void renameConversation(activeId, value).then(() => {
      setRenaming(false);
    });
  };

  return (
    <div className="assistant">
      <ConversationList
        conversations={conversations}
        state={listState}
        activeId={activeId}
        actor={actor}
        busyId={managing}
        open={sheetOpen}
        onSelect={selectConversation}
        onClose={() => {
          setSheetOpen(false);
        }}
        onReload={() => {
          void loadConversations();
        }}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />
      <section className="thread-pane" aria-label="Assistant conversation">
        <div className="thread-pane__bar">
          <button
            className="button button--ghost thread-pane__menu"
            type="button"
            onClick={() => {
              setSheetOpen(true);
            }}
            aria-label="Open conversations"
          >
            ☰ Conversations
          </button>
          {renaming && activeId !== null ? (
            <form className="thread-pane__rename" onSubmit={submitRename}>
              <label className="sr-only" htmlFor="thread-rename">
                Name this conversation
              </label>
              <input
                id="thread-rename"
                name="thread-rename"
                className="field__input"
                defaultValue={active?.title ?? ''}
                maxLength={CONVERSATION_TITLE_MAX_CHARS}
                placeholder="e.g. Refinance ads for October"
                autoFocus
              />
              <button
                className="button button--primary button--small"
                type="submit"
                disabled={managing !== null}
              >
                Save
              </button>
              <button
                className="button button--small"
                type="button"
                onClick={() => {
                  setRenaming(false);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h1 className="thread-pane__title" title={title}>
                {title}
              </h1>
              {activeId !== null && (
                <button
                  className="button button--ghost button--small"
                  type="button"
                  onClick={() => {
                    setRenaming(true);
                  }}
                >
                  Rename
                </button>
              )}
            </>
          )}
          <button
            className="button button--ghost"
            type="button"
            onClick={() => {
              selectConversation(null);
            }}
          >
            + New
          </button>
        </div>
        {notice !== null && (
          <p className="notice thread-pane__notice" role="status">
            {notice}
          </p>
        )}
        <Thread
          messages={messages}
          state={threadState}
          waiting={waiting}
          onRetry={retry}
          onDiscard={discardFailed}
        />
        <Composer
          value={draft}
          disabled={sending}
          onChange={onDraftChange}
          onSend={() => {
            void send(draft, null);
          }}
        />
      </section>
    </div>
  );
}
