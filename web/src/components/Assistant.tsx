/**
 * The Assistant's full page: conversations on the left (a slide-in sheet on a phone), the
 * thread and the composer on the right. Reads go straight to Supabase under RLS as the
 * signed-in user; the one write — a turn — goes to the Edge Function, which owns the voice,
 * the cap and the history.
 *
 * A message that fails stays on screen as a failed bubble with the reason and a Retry that
 * resends the same text; it is never silently dropped. A 401 keeps the text and hands it
 * across the login screen (App.onSessionExpired).
 *
 * Stage 3 part 5 (R27) adds two things to this section. The author's own privacy control,
 * in the list row and in the thread bar, with the whole sentence — including the half about
 * summaries still being shared — shown BEFORE the change, not after. And, for an
 * administrator only, a read-only view of somebody else's private conversation: its messages
 * do not come from PostgREST (RLS refuses them, deliberately) but from the memory endpoint,
 * which writes an audit row every time. There is no composer under it. An admin reads; they
 * do not join in.
 *
 * Milestone 4 part 2: the THREAD — which conversation is open, its messages, the turn in
 * flight, the draft — now lives in the shared store the shell provides (web/src/lib/thread.ts),
 * because the docked panel shows the same thread from any other screen. Everything else on
 * this page — the list, renaming, deleting, privacy, the administrator's views — is this
 * page's own and unchanged.
 */
import type { Session } from '@supabase/supabase-js';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type SyntheticEvent,
} from 'react';

import { canRenameConversation, type MemoryActor } from '../../../src/lib/memory/access.js';
import {
  conversationDisplayName,
  CONVERSATION_PREFIX_SEPARATOR,
  CONVERSATION_TITLE_MAX_CHARS,
} from '../../../src/lib/memory/naming.js';
import {
  buildConversationList,
  formatWhen,
  MAKE_PRIVATE_CONFIRM,
  MAKE_SHARED_CONFIRM,
  PRIVACY_EXPLANATION,
  PRIVACY_NOTICE,
  PRIVACY_TOGGLE_LABEL,
  SHARED_EXPLANATION,
} from '../lib/conversationsView.js';
import { webConfig } from '../lib/env.js';
import { loadOpenConversation, takePending, type PendingDraft } from '../lib/draft.js';
import { callMemory, type MemoryRequest, type MemoryReply } from '../lib/memoryApi.js';
import { supabase, type AppUserRow, type ConversationListRow } from '../lib/supabase.js';
import { Composer } from './Composer.js';
import { ConversationList, type AdminPrivateRow } from './ConversationList.js';
import { Thread, type LocalMessage } from './Thread.js';
import { useThreadState, useThreadStore } from './ThreadContext.js';

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

export function Assistant({
  session,
  staff,
  openConversationId,
  onSessionExpired,
}: Props): ReactElement {
  const store = useThreadStore();
  const thread = useThreadState();
  const { activeId, messages, threadState, sending, waiting, draft } = thread;

  const [conversations, setConversations] = useState<ConversationListRow[]>([]);
  /**
   * user_id -> email, for the author prefix every conversation is named with (part 4a).
   * Read under RLS from the roster policy part 4 widened (D56); a failure leaves the map
   * empty and the list shows bare names rather than nothing.
   */
  const [emailsById, setEmailsById] = useState<ReadonlyMap<string, string>>(new Map());
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sheetOpen, setSheetOpen] = useState(false);
  // Stage 3 part 4: renaming and deleting a conversation. `managing` is the id being written
  // right now, so one slow rename never freezes the whole list; `notice` is the one sentence
  // the change earned, shown above the thread rather than in a toast that scrolls away.
  const [managing, setManaging] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  // Stage 3 part 5 (R27), admin only. `adminRows` is the metadata listing (no titles);
  // `adminReading` is one conversation actually opened, which cost an audit row on the
  // server. Held here rather than in the list because the thread pane is what renders it.
  const [adminRows, setAdminRows] = useState<readonly AdminPrivateRow[]>([]);
  const [adminState, setAdminState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [adminReading, setAdminReading] = useState<{
    readonly conversationId: string;
    readonly name: string;
    readonly messages: readonly LocalMessage[];
  } | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);

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

  const loadRoster = useCallback(async (): Promise<void> => {
    const { data, error } = await supabase.from('app_users').select('user_id, email').limit(500);
    if (error !== null) return;
    setEmailsById(new Map(data.map((row): [string, string] => [row.user_id, row.email])));
  }, []);

  /**
   * First load, in priority order (D76):
   *
   *   1. a conversation the Memory page asked to open — an explicit request wins;
   *   2. a message that was in flight when the page went away, restored into the composer
   *      unless the server already saved it;
   *   3. WHERE YOU WERE. A phone browser evicts a backgrounded tab, and coming back reloads
   *      the page — so without this the person lands on "New conversation" and their thread
   *      looks lost. It was never lost; nothing was pointing at it.
   *
   * The decision is made once per sign-in, by whichever surface shows the thread first: if
   * the panel already opened a conversation, coming to this page shows that conversation.
   */
  useEffect(() => {
    void loadConversations();
    void loadRoster();

    if (openConversationId !== undefined && openConversationId !== null) {
      void store.open(openConversationId);
      return;
    }
    if (store.getState().initialised) return;

    const pending = takePending(storage());
    const remembered = loadOpenConversation(storage());
    const target = pending?.conversationId ?? remembered;
    if (target !== null) {
      void store.restore(target, pending);
      return;
    }
    // A turn that never reached the server has no conversation to go back to, but the words
    // are still the person's — put them back in the composer rather than losing them.
    if (pending !== null) store.adoptDraft(pending.text);
    else void store.open(null);
  }, [loadConversations, loadRoster, openConversationId, store]);

  // A turn saved from either surface changes the list's order and may add a row.
  useEffect(() => {
    if (thread.turnsSaved > 0) void loadConversations();
  }, [thread.turnsSaved, loadConversations]);

  // Whatever arrived is now on screen.
  useEffect(() => {
    store.markSeen();
  }, [store, messages]);

  const selectConversation = useCallback(
    (id: string | null): void => {
      // Leaving an administrator's read of someone else's private conversation. Nothing to
      // save and nothing to keep: the messages were never this person's to hold on to.
      setAdminReading(null);
      setPrivacyOpen(false);
      setSheetOpen(false);
      void store.open(id);
    },
    [store],
  );

  /**
   * One call to the verified endpoint every conversation change uses — and, since part 5,
   * the two admin READS as well, because a read that has to be audited cannot come from
   * PostgREST. Returns the reply rather than a boolean so the caller can use what came back.
   */
  const manage = useCallback(
    async (request: MemoryRequest, conversationId: string | null): Promise<MemoryReply | null> => {
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
          return null;
        }
        setNotice(outcome.message);
        // Someone else got there first: the list on screen is describing a past.
        if (outcome.failure === 'stale') void loadConversations();
        return null;
      }
      return outcome.reply;
    },
    [loadConversations, onSessionExpired, session.access_token],
  );

  const renameConversation = useCallback(
    async (conversationId: string, newTitle: string): Promise<void> => {
      const done = await manage(
        { action: 'rename_conversation', conversationId, title: newTitle },
        conversationId,
      );
      if (done === null) return;
      await loadConversations();
    },
    [loadConversations, manage],
  );

  const deleteConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      const done = await manage({ action: 'delete_conversation', conversationId }, conversationId);
      if (done === null) return;
      // Whatever was on screen is now describing rows that are gone.
      if (conversationId === activeId) store.clear();
      setNotice(
        'Conversation deleted. Its messages are gone for good; anything you asked the assistant to remember is still on the Memory page.',
      );
      await loadConversations();
    },
    [activeId, loadConversations, manage, store],
  );

  /**
   * R27. The author's own toggle, through the same verified endpoint. The list is reloaded
   * afterwards rather than patched in place: `scope` cascades to `messages` in the database,
   * so what is on screen after the change should be what the database actually holds.
   */
  const setPrivacy = useCallback(
    async (conversationId: string, isPrivate: boolean): Promise<void> => {
      const done = await manage(
        { action: 'set_conversation_privacy', conversationId, isPrivate },
        conversationId,
      );
      if (done === null) return;
      setNotice(isPrivate ? PRIVACY_NOTICE.nowPrivate : PRIVACY_NOTICE.nowShared);
      await loadConversations();
    },
    [loadConversations, manage],
  );

  /** Admin only: the metadata listing. No titles come back, by design. */
  const loadPrivate = useCallback(async (): Promise<void> => {
    setAdminState('loading');
    const reply = await manage({ action: 'admin_list_private' }, null);
    if (reply?.action !== 'admin_list_private') {
      setAdminState('error');
      return;
    }
    setAdminRows(
      reply.conversations.map((row) => ({
        id: row.id,
        author: row.authorEmail?.split('@')[0] ?? 'Someone',
        when: formatWhen(row.lastActiveAt),
      })),
    );
    setAdminState('ready');
  }, [manage]);

  /**
   * Admin only: open one. This is the call that writes CONVERSATION_ADMIN_READ, so it is
   * made once, deliberately, when a person taps a row — never on a list render.
   */
  const openPrivate = useCallback(
    async (conversationId: string): Promise<void> => {
      const reply = await manage(
        { action: 'admin_read_conversation', conversationId },
        conversationId,
      );
      if (reply?.action !== 'admin_read_conversation') return;
      setSheetOpen(false);
      store.clear();
      setAdminReading({
        conversationId,
        name: conversationDisplayName(reply.title, reply.authorEmail),
        messages: reply.messages.map((m) => ({
          localId: m.id,
          id: m.id,
          role: m.role,
          content: m.content,
          status: 'saved' as const,
        })),
      });
    },
    [manage, store],
  );

  const views = useMemo(
    () => buildConversationList(conversations, emailsById),
    [conversations, emailsById],
  );
  const active = views.find((c) => c.id === activeId) ?? null;
  // The header shows exactly what the list shows, prefix and all — a conversation must not
  // be called two different things one tap apart.
  const title =
    adminReading?.name ??
    active?.displayName ??
    (activeId === null ? 'New conversation' : 'Conversation');

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
        conversations={views}
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
        onSetPrivacy={setPrivacy}
        privateRows={adminRows}
        privateState={adminState}
        onLoadPrivate={() => {
          void loadPrivate();
        }}
        onOpenPrivate={(id) => {
          void openPrivate(id);
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
          {renaming && activeId !== null ? (
            <form className="thread-pane__rename" onSubmit={submitRename}>
              <label className="sr-only" htmlFor="thread-rename">
                Name this conversation
              </label>
              {active?.prefix != null && (
                <span className="thread-pane__rename-prefix" aria-hidden="true">
                  {active.prefix}
                  {CONVERSATION_PREFIX_SEPARATOR}
                </span>
              )}
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
              {/* D75: only the author renames. `active` is null for a brand-new conversation,
                  which has no name to change yet either. */}
              {adminReading === null &&
                active !== null &&
                canRenameConversation({ authorId: active.authorId }, actor).allowed && (
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
              {/* R27: the author's own control, in the thread as well as the list, because
                  this is where a person is when they realise the conversation should not
                  have been shared. */}
              {active !== null && active.authorId === actor.userId && (
                <button
                  className="button button--ghost button--small thread-pane__privacy"
                  type="button"
                  aria-expanded={privacyOpen}
                  onClick={() => {
                    setPrivacyOpen((open) => !open);
                  }}
                >
                  {active.isPrivate
                    ? PRIVACY_TOGGLE_LABEL.makeShared
                    : PRIVACY_TOGGLE_LABEL.makePrivate}
                </button>
              )}
            </>
          )}
          {/* While renaming, the bar belongs to the rename: at 375 px a prefix, a field, Save,
              Cancel AND "+ New" do not fit, and the one that must never be hard to reach is
              the one that saves. */}
          {!renaming && (
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                selectConversation(null);
              }}
            >
              + New
            </button>
          )}
        </div>
        {notice !== null && (
          <p className="notice thread-pane__notice" role="status">
            {notice}
          </p>
        )}
        {thread.notice !== null && (
          <p className="notice thread-pane__notice" role="status">
            {thread.notice}
          </p>
        )}
        {/* An administrator is reading somebody else's conversation. Say so, say it was
            recorded, and give one way out. Nothing here is editable and there is no
            composer below — an admin reads, and does not join in. */}
        {adminReading !== null && (
          <div className="notice thread-pane__notice" role="status">
            <p>
              You are reading a private conversation because you are an administrator. It belongs to
              the person who started it, and this has been recorded.
            </p>
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                selectConversation(null);
              }}
            >
              Close it
            </button>
          </div>
        )}
        {privacyOpen && active !== null && active.authorId === actor.userId && (
          <div className="notice thread-pane__notice" role="alert">
            <p>{active.isPrivate ? PRIVACY_EXPLANATION : SHARED_EXPLANATION}</p>
            <p>{active.isPrivate ? MAKE_SHARED_CONFIRM : MAKE_PRIVATE_CONFIRM}</p>
            <div className="mem__row">
              <button
                className="button button--primary button--small"
                type="button"
                disabled={managing !== null}
                onClick={() => {
                  void setPrivacy(active.id, !active.isPrivate).then(() => {
                    setPrivacyOpen(false);
                  });
                }}
              >
                {managing !== null
                  ? 'Saving…'
                  : active.isPrivate
                    ? PRIVACY_TOGGLE_LABEL.makeShared
                    : PRIVACY_TOGGLE_LABEL.makePrivate}
              </button>
              <button
                className="button button--small"
                type="button"
                disabled={managing !== null}
                onClick={() => {
                  setPrivacyOpen(false);
                }}
              >
                Leave it as it is
              </button>
            </div>
          </div>
        )}
        <Thread
          messages={adminReading === null ? messages : [...adminReading.messages]}
          state={adminReading === null ? threadState : 'idle'}
          waiting={adminReading === null && waiting}
          onRetry={store.retry}
          onDiscard={store.discard}
        />
        {adminReading === null && (
          <Composer
            value={draft}
            disabled={sending}
            onChange={store.setDraft}
            onSend={() => {
              void store.send(draft, null);
            }}
          />
        )}
      </section>
    </div>
  );
}
