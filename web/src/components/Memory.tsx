/**
 * The Memory page (Stage 3 part 3). What the assistant knows, who put it there, and how to
 * take it back out.
 *
 * The page is two lists, not one, and the order is the argument: STANDING NOTES are things a
 * person deliberately told it to keep and are given to it on every single turn; CONVERSATION
 * NOTES are summaries it wrote by itself and are only used when they happen to be relevant.
 * Showing them as one list would be technically honest and practically useless — it would say
 * these carry the same weight, when only the first kind is anyone's fault.
 *
 * Reads go straight to Supabase under RLS as the signed-in user (workspace rows plus their
 * own private ones); the one thing that changes memory — add, edit, forget, delete — goes to
 * the memory Edge Function, which verifies the caller and writes the audit row. The browser
 * has SELECT and nothing else, so this is not a convention, it is the only thing that works.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import type { MemoryActor } from '../../../src/lib/memory/access.js';
import { webConfig } from '../lib/env.js';
import { callMemory, type MemoryOutcome, type MemoryRequest } from '../lib/memoryApi.js';
import {
  buildChunkList,
  buildFactLists,
  categoryLabel,
  topicLabel,
  type FactLists,
  type MemoryChunkView,
} from '../lib/memoryView.js';
import { supabase, type AppUserRow } from '../lib/supabase.js';
import { MemoryChunks } from './MemoryChunks.js';
import { AddNoteForm, MemoryFacts } from './MemoryFacts.js';

interface Props {
  readonly session: Session;
  readonly staff: AppUserRow;
  readonly onOpenConversation: (conversationId: string) => void;
  readonly onSessionExpired: () => Promise<void>;
}

type Tab = 'notes' | 'conversations';
type Banner = { readonly tone: 'ok' | 'warn'; readonly text: string } | null;

/** Every fact the caller may read, in any state — the history needs the superseded ones. */
const FACT_LIMIT = 500;
const CHUNK_PAGE = 50;

const EMPTY_LISTS: FactLists = { live: [], forgotten: [], history: {} };

export function Memory({
  session,
  staff,
  onOpenConversation,
  onSessionExpired,
}: Props): ReactElement {
  // Stable identity: `load` closes over it, and a fresh object every render would make the
  // first-load effect re-fetch forever.
  const actor: MemoryActor = useMemo(
    () => ({ userId: staff.user_id, isAdmin: staff.is_admin }),
    [staff.user_id, staff.is_admin],
  );
  const [tab, setTab] = useState<Tab>('notes');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [lists, setLists] = useState<FactLists>(EMPTY_LISTS);
  const [chunks, setChunks] = useState<readonly MemoryChunkView[]>([]);
  const [chunkLimit, setChunkLimit] = useState(CHUNK_PAGE);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  const load = useCallback(
    async (limit: number): Promise<void> => {
      const [facts, notes, conversations] = await Promise.all([
        supabase
          .from('memory_facts')
          .select('id, user_id, scope, key, value, superseded_by, created_at')
          .order('created_at', { ascending: false })
          .limit(FACT_LIMIT),
        supabase
          .from('memory_chunks')
          .select('id, conversation_id, user_id, scope, summary, audience, created_at, deleted_at')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase.from('conversations').select('id, title').is('deleted_at', null).limit(200),
      ]);
      if (facts.error !== null || notes.error !== null || conversations.error !== null) {
        setState('error');
        return;
      }
      const titles = new Map<string, string | null>(
        conversations.data.map((row): [string, string | null] => [row.id, row.title]),
      );
      setLists(buildFactLists(facts.data, actor));
      setChunks(buildChunkList(notes.data, titles, actor));
      setHasMore(notes.data.length >= limit);
      setState('ready');
    },
    [actor],
  );

  useEffect(() => {
    void load(chunkLimit);
  }, [chunkLimit, load]);

  /** One write, with the session refreshed first and the outcome turned into one sentence. */
  const run = useCallback(
    async (request: MemoryRequest, key: string): Promise<MemoryOutcome> => {
      setBusy(key);
      setBanner(null);
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
      setBusy(null);
      if (outcome.kind === 'error') {
        if (outcome.failure === 'unauthenticated') {
          await onSessionExpired();
          return outcome;
        }
        setBanner({ tone: 'warn', text: outcome.message });
        // Someone else changed it, or it is already gone: the page is showing a stale copy.
        if (outcome.failure === 'stale') await load(chunkLimit);
        return outcome;
      }
      await load(chunkLimit);
      return outcome;
    },
    [chunkLimit, load, onSessionExpired, session.access_token],
  );

  const onAdd = useCallback(
    async (text: string): Promise<void> => {
      const outcome = await run({ action: 'add', text }, 'add');
      if (outcome.kind !== 'ok') return;
      const reply = outcome.reply;
      if (reply.action !== 'add') return;
      if (reply.outcome === 'declined') {
        setBanner({ tone: 'warn', text: `Not kept as a standing note — ${reply.reason}.` });
        return;
      }
      if (reply.outcome === 'unchanged') {
        setBanner({ tone: 'ok', text: 'It already remembers exactly that. Nothing changed.' });
        return;
      }
      setBanner({
        tone: 'ok',
        text: `Saved under ${categoryLabel(reply.key)} · ${topicLabel(reply.key)}${
          reply.replaced ? ', replacing what it held before' : ''
        }. It will use this from your next message.`,
      });
    },
    [run],
  );

  const onEdit = useCallback(
    async (factId: string, value: string): Promise<void> => {
      // Bringing a removed note back is the same request as a reword — the row it targets
      // was forgotten, so the upsert has no live row to supersede — but it is a different
      // thing to have just done, and the sentence should say which.
      const restoring = lists.forgotten.some((fact) => fact.id === factId);
      const outcome = await run({ action: 'edit', factId, value }, factId);
      if (outcome.kind !== 'ok') return;
      const reply = outcome.reply;
      if (reply.action !== 'edit') return;
      if (reply.outcome === 'declined') {
        setBanner({ tone: 'warn', text: `Not saved — ${reply.reason}.` });
        return;
      }
      if (reply.outcome === 'unchanged') {
        setBanner({ tone: 'ok', text: 'That is already the wording. Nothing changed.' });
        return;
      }
      setBanner({
        tone: 'ok',
        text: restoring
          ? 'Back in use. The assistant has it again from your next message.'
          : 'Updated. The earlier wording is kept under this note.',
      });
    },
    [lists.forgotten, run],
  );

  const onForget = useCallback(
    async (factId: string): Promise<void> => {
      const outcome = await run({ action: 'forget', factId }, factId);
      if (outcome.kind !== 'ok') return;
      setBanner({
        tone: 'ok',
        text: 'Forgotten. It is in Removed notes if you want it back.',
      });
    },
    [run],
  );

  const onDeleteChunk = useCallback(
    async (chunkId: string): Promise<void> => {
      const outcome = await run({ action: 'delete_chunk', chunkId }, chunkId);
      if (outcome.kind !== 'ok') return;
      setBanner({ tone: 'ok', text: 'Deleted. That note is gone and will not be used again.' });
    },
    [run],
  );

  const nothingYet = state === 'ready' && lists.live.length === 0 && chunks.length === 0;

  return (
    <section className="mem" aria-labelledby="mem-title">
      <div className="mem__bar">
        <h1 id="mem-title" className="mem__title">
          Memory
        </h1>
        <button
          className="button button--ghost button--small"
          type="button"
          onClick={() => {
            void load(chunkLimit);
          }}
        >
          Refresh
        </button>
      </div>

      {banner !== null && (
        <p className={banner.tone === 'ok' ? 'mem__banner' : 'notice mem__banner'} role="status">
          {banner.text}
        </p>
      )}

      {state === 'loading' && <p className="muted mem__none">Loading…</p>}
      {state === 'error' && (
        <p className="error mem__none" role="alert">
          Couldn&rsquo;t load what the assistant remembers.{' '}
          <button
            className="link"
            type="button"
            onClick={() => {
              void load(chunkLimit);
            }}
          >
            Try again
          </button>
        </p>
      )}

      {nothingYet && (
        <div className="card mem__empty">
          <h2 className="mem__empty-title">It hasn&rsquo;t been taught anything yet</h2>
          <p>
            Memory is shared: whatever anyone teaches the assistant, everyone gets. It fills up two
            ways.
          </p>
          <ol className="mem__empty-list">
            <li>
              <strong>You tell it.</strong> In the Assistant, start a message with{' '}
              <em>&ldquo;Remember that…&rdquo;</em> — for example,{' '}
              <em>
                &ldquo;Remember that our posts always end with a direct call to action.&rdquo;
              </em>{' '}
              It saves that as a standing note and says so in its reply. You can also add one here.
            </li>
            <li>
              <strong>It notices.</strong> Every ten messages or so it writes itself a short note
              about what the conversation was for, so a later conversation can pick it up. Those
              appear under <strong>From conversations</strong>.
            </li>
          </ol>
          <p className="muted">
            Everything it remembers is shown on this page, and anything on this page can be
            corrected or taken back out.
          </p>
          <AddNoteForm busy={busy === 'add'} onAdd={onAdd} />
        </div>
      )}

      {state === 'ready' && !nothingYet && (
        <>
          <div className="mem__tabs" role="tablist" aria-label="What the assistant remembers">
            <button
              id="mem-tab-notes"
              role="tab"
              type="button"
              aria-selected={tab === 'notes'}
              aria-controls="mem-panel-notes"
              className={`mem__tab${tab === 'notes' ? ' mem__tab--active' : ''}`}
              onClick={() => {
                setTab('notes');
              }}
            >
              You told it <span className="mem__count">{lists.live.length}</span>
            </button>
            <button
              id="mem-tab-conversations"
              role="tab"
              type="button"
              aria-selected={tab === 'conversations'}
              aria-controls="mem-panel-conversations"
              className={`mem__tab${tab === 'conversations' ? ' mem__tab--active' : ''}`}
              onClick={() => {
                setTab('conversations');
              }}
            >
              From conversations <span className="mem__count">{chunks.length}</span>
            </button>
          </div>

          {tab === 'notes' ? (
            <div id="mem-panel-notes" role="tabpanel" aria-labelledby="mem-tab-notes">
              <p className="muted mem__hint">
                Things someone asked the assistant to keep. It is given all of these on every
                message.
              </p>
              <MemoryFacts
                lists={lists}
                busy={busy}
                onAdd={onAdd}
                onEdit={onEdit}
                onForget={onForget}
              />
            </div>
          ) : (
            <div
              id="mem-panel-conversations"
              role="tabpanel"
              aria-labelledby="mem-tab-conversations"
            >
              <MemoryChunks
                chunks={chunks}
                busy={busy}
                hasMore={hasMore}
                onShowMore={() => {
                  setChunkLimit((limit) => limit + CHUNK_PAGE);
                }}
                onOpenConversation={onOpenConversation}
                onDelete={onDeleteChunk}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
