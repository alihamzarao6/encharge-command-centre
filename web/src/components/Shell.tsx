/**
 * The app shell (Milestone 4 part 2): brand header, a section nav, one live section, and the
 * assistant as a panel beside whatever the section is. On a phone the nav is a bottom tab
 * bar (thumb reach); from 768px it is a sidebar.
 *
 * DATA FIRST. The app opens on the overview — the client's numbers — not on a chat. The
 * Assistant keeps its full page (conversation history, memory, everything Milestone 3
 * signed off) at its own address, and ALSO opens as a docked panel from any other screen,
 * so a quick question does not mean leaving the numbers. Both surfaces read one thread
 * store (web/src/lib/thread.ts), created here once per sign-in and never per section.
 *
 * ROUTES. Each section has a path (web/src/lib/routes.ts); the section in state follows the
 * bar and the bar follows the section, through pushState and popstate, with no router
 * dependency. A refresh, a bookmark and the browser's Back button all do what they say.
 * Signing in never touches the path, so a deep link opened while signed out lands where it
 * pointed once the person is in.
 *
 * ONLY WHAT EXISTS is in the nav. The two placeholder entries for later milestones are gone:
 * an entry that opens a page saying "not yet" is a thing that does not work.
 */
import type { Session } from '@supabase/supabase-js';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';

import { streamTurn } from '../lib/chatApi.js';
import type { PendingDraft } from '../lib/draft.js';
import { webConfig } from '../lib/env.js';
import {
  DEFAULT_SECTION,
  isCanonicalPath,
  pathFor,
  sectionFor,
  type SectionId,
} from '../lib/routes.js';
import { supabase, type AppUserRow } from '../lib/supabase.js';
import { createThreadStore, type ThreadMessage } from '../lib/thread.js';
import { Assistant } from './Assistant.js';
import { AssistantPanel } from './AssistantPanel.js';
import { Memory } from './Memory.js';
import { Overview } from './Overview.js';
import { ThreadContext } from './ThreadContext.js';
import { Users } from './Users.js';

export type { SectionId };

export interface Section {
  readonly id: SectionId;
  readonly label: string;
}

export const SECTIONS: readonly Section[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'assistant', label: 'Assistant' },
  { id: 'memory', label: 'Memory' },
  { id: 'team', label: 'Team' },
];

const ICONS: Readonly<Record<SectionId, string>> = {
  overview: '📊',
  assistant: '💬',
  memory: '🧠',
  team: '👥',
};

interface Props {
  readonly session: Session;
  readonly staff: AppUserRow;
  readonly onSignOut: () => Promise<void>;
  readonly onSessionExpired: (pending: PendingDraft | null) => Promise<void>;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function sectionFromLocation(): SectionId {
  return typeof window === 'undefined' ? DEFAULT_SECTION : sectionFor(window.location.pathname);
}

/** The thread's saved messages, read under RLS as the signed-in person; null = could not. */
async function loadMessages(conversationId: string): Promise<readonly ThreadMessage[] | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, conversation_id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(500);
  if (error !== null) return null;
  return data
    .filter((row) => row.content !== null)
    .map((row) => ({
      localId: row.id,
      id: row.id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content ?? '',
      status: 'saved',
    }));
}

export function Shell({ session, staff, onSignOut, onSessionExpired }: Props): ReactElement {
  const [section, setSection] = useState<SectionId>(sectionFromLocation);
  /**
   * Set only when the Memory page asks to open the conversation a note came from, and
   * cleared by any ordinary navigation — otherwise leaving Memory and coming back to the
   * Assistant later would silently reopen a conversation nobody asked for this time.
   */
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const askButton = useRef<HTMLButtonElement>(null);

  // The store must not be rebuilt when the session refreshes its token or a callback is
  // re-created: that would throw away the thread. It reads the latest of both through refs.
  const latestSession = useRef(session);
  const latestExpired = useRef(onSessionExpired);
  useEffect(() => {
    latestSession.current = session;
    latestExpired.current = onSessionExpired;
  }, [session, onSessionExpired]);
  const [store] = useState(() =>
    createThreadStore({
      storage: storage(),
      loadMessages,
      streamTurn: (input, handlers) =>
        streamTurn(
          { chatUrl: webConfig.chatUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
          input,
          handlers,
        ),
      getAccessToken: async () => {
        // A fresh token: supabase-js refreshes it if it is about to expire.
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? latestSession.current.access_token;
      },
      onSessionExpired: (pending) => latestExpired.current(pending),
    }),
  );
  const thread = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  // The bar and the section agree: an unknown path is rewritten to the section it landed
  // on, and Back / Forward move the section without a reload.
  useEffect(() => {
    if (!isCanonicalPath(window.location.pathname)) {
      window.history.replaceState(null, '', pathFor(sectionFromLocation()));
    }
    const onPop = (): void => {
      setPendingConversationId(null);
      setSection(sectionFromLocation());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const navigate = useCallback((id: SectionId): void => {
    setSection((current) => {
      if (current !== id) window.history.pushState(null, '', pathFor(id));
      return id;
    });
    // The page IS the assistant: a panel beside it would be the same thread twice.
    if (id === 'assistant') setPanelOpen(false);
  }, []);

  const goTo = (id: SectionId): void => {
    setPendingConversationId(null);
    navigate(id);
  };
  const openConversation = (conversationId: string): void => {
    setPendingConversationId(conversationId);
    navigate('assistant');
  };
  const closePanel = (): void => {
    setPanelOpen(false);
    askButton.current?.focus();
  };
  const openFullPage = (): void => {
    setPendingConversationId(null);
    navigate('assistant');
  };

  const panelShown = panelOpen && section !== 'assistant';
  const replyWaiting = thread.unseenReply && !panelShown;

  return (
    <ThreadContext.Provider value={store}>
      <div className={`shell${panelShown ? ' shell--panel' : ''}`}>
        <header className="topbar">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              F
            </span>
            <div>
              <div className="brand__name">Fundd</div>
              <div className="brand__sub">Command Centre</div>
            </div>
          </div>
          <div className="topbar__user">
            {section !== 'assistant' && (
              <button
                ref={askButton}
                className={`button button--small topbar__ask${panelShown ? ' topbar__ask--open' : ''}`}
                type="button"
                aria-expanded={panelShown}
                {...(panelShown ? { 'aria-controls': 'assistant-panel' } : {})}
                onClick={() => {
                  setPanelOpen((open) => !open);
                }}
              >
                <span aria-hidden="true">💬</span> Ask
                {replyWaiting && (
                  <>
                    <span className="topbar__dot" aria-hidden="true" />
                    <span className="sr-only"> — a reply is waiting</span>
                  </>
                )}
              </button>
            )}
            <span className="topbar__email" title={staff.email}>
              {staff.email}
            </span>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void onSignOut();
              }}
            >
              Sign out
            </button>
          </div>
        </header>

        <nav className="nav" aria-label="Sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`nav__item${s.id === section ? ' nav__item--active' : ''}`}
              aria-current={s.id === section ? 'page' : undefined}
              onClick={() => {
                goTo(s.id);
              }}
            >
              <span className="nav__icon" aria-hidden="true">
                {ICONS[s.id]}
              </span>
              <span className="nav__label">{s.label}</span>
            </button>
          ))}
        </nav>

        <main className="main">
          {section === 'overview' && (
            <Overview session={session} onSessionExpired={() => onSessionExpired(null)} />
          )}
          {section === 'assistant' && (
            <Assistant
              session={session}
              staff={staff}
              openConversationId={pendingConversationId}
              onSessionExpired={onSessionExpired}
            />
          )}
          {section === 'memory' && (
            <Memory
              session={session}
              staff={staff}
              onOpenConversation={openConversation}
              onSessionExpired={() => onSessionExpired(null)}
            />
          )}
          {section === 'team' && (
            <Users
              session={session}
              staff={staff}
              onSessionExpired={() => onSessionExpired(null)}
            />
          )}
        </main>

        {panelShown && (
          <>
            <div className="panel-backdrop" aria-hidden="true" onClick={closePanel} />
            <AssistantPanel onClose={closePanel} onOpenFullPage={openFullPage} />
          </>
        )}
      </div>
    </ThreadContext.Provider>
  );
}
