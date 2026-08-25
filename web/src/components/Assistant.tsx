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
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { streamTurn, type ChatFailure } from '../lib/chatApi.js';
import { webConfig } from '../lib/env.js';
import { loadDraft, saveDraft, takePending, type PendingDraft } from '../lib/draft.js';
import { supabase, type ConversationListRow } from '../lib/supabase.js';
import { Composer } from './Composer.js';
import { ConversationList } from './ConversationList.js';
import { Thread, type LocalMessage } from './Thread.js';

interface Props {
  readonly session: Session;
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

export function Assistant({ session, onSessionExpired }: Props): ReactElement {
  const [conversations, setConversations] = useState<ConversationListRow[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [threadState, setThreadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [draft, setDraft] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const pendingRestored = useRef(false);

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

  // First load: the list, then a message that was mid-flight when the session expired.
  useEffect(() => {
    void loadConversations();
    if (!pendingRestored.current) {
      pendingRestored.current = true;
      const pending = takePending(storage());
      if (pending !== null) {
        setActiveId(pending.conversationId);
        setDraft(pending.text);
        if (pending.conversationId !== null) void loadMessages(pending.conversationId);
      }
    }
  }, [loadConversations, loadMessages]);

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

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const title = active?.title ?? (activeId === null ? 'New conversation' : 'Conversation');

  return (
    <div className="assistant">
      <ConversationList
        conversations={conversations}
        state={listState}
        activeId={activeId}
        open={sheetOpen}
        onSelect={selectConversation}
        onClose={() => {
          setSheetOpen(false);
        }}
        onReload={() => {
          void loadConversations();
        }}
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
          <h1 className="thread-pane__title" title={title}>
            {title}
          </h1>
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
