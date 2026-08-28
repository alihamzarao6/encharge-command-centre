/**
 * The conversations list, and — since Stage 3 part 4 — the two things a person can do to a
 * conversation: name it and delete it.
 *
 * Naming matters more than it sounds. Nothing has ever generated a title, so every
 * conversation in this list reads "Untitled conversation" and they are told apart only by
 * date. At four conversations that is survivable; at fifty it is a wall. So renaming is one
 * tap from the row, a filter appears once the list is long enough to need one, and the count
 * is stated rather than guessed at from a scrollbar.
 *
 * Deleting is the destructive one and the confirm says exactly what it does, in the words of
 * the decision behind it (migration 20260828010000): the messages go for good, the notes the
 * assistant wrote about the conversation go with them, and the standing notes someone
 * deliberately asked it to remember stay — because those belong to the business, not to this
 * conversation. Who may delete is `canRemoveMemory`, the same function the server enforces
 * and the same one that guards removing a note (D52).
 */
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import {
  canRemoveMemory,
  CONVERSATION_TITLE_MAX_CHARS,
  type MemoryActor,
} from '../../../src/lib/memory/access.js';
import {
  CONVERSATION_FILTER_THRESHOLD,
  DELETE_CONVERSATION_CONFIRM,
  UNTITLED_CONVERSATION,
  filterConversations,
  formatWhen,
  type ConversationListRow,
} from '../lib/conversationsView.js';

interface Props {
  readonly conversations: readonly ConversationListRow[];
  readonly state: 'loading' | 'ready' | 'error';
  readonly activeId: string | null;
  readonly actor: MemoryActor;
  /** The conversation id currently being renamed or deleted, so only its row shows as busy. */
  readonly busyId: string | null;
  /** Phone only: the list is a sheet that slides over the thread. */
  readonly open: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onClose: () => void;
  readonly onReload: () => void;
  readonly onRename: (id: string, title: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

export function ConversationList({
  conversations,
  state,
  activeId,
  actor,
  busyId,
  open,
  onSelect,
  onClose,
  onReload,
  onRename,
  onDelete,
}: Props): ReactElement {
  const [query, setQuery] = useState('');
  const showFilter = conversations.length > CONVERSATION_FILTER_THRESHOLD;
  const shown = showFilter ? filterConversations(conversations, query) : conversations;

  return (
    <>
      {open && <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />}
      <aside className={`convos${open ? ' convos--open' : ''}`} aria-label="Conversations">
        <div className="convos__bar">
          <h2 className="convos__title">Conversations</h2>
          <button
            className="button button--ghost convos__close"
            type="button"
            onClick={onClose}
            aria-label="Close conversations"
          >
            ✕
          </button>
        </div>
        <button
          className="button button--primary button--block convos__new"
          type="button"
          onClick={() => {
            onSelect(null);
          }}
        >
          + New conversation
        </button>
        {showFilter && (
          <div className="convos__filter">
            <label className="sr-only" htmlFor="convos-filter">
              Find a conversation by name
            </label>
            <input
              id="convos-filter"
              className="field__input"
              type="search"
              value={query}
              placeholder={`Find among ${String(conversations.length)}…`}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
        )}
        <div className="convos__list" role="list">
          {state === 'loading' && <p className="muted convos__note">Loading…</p>}
          {state === 'error' && (
            <p className="error convos__note">
              Couldn't load conversations.{' '}
              <button className="link" type="button" onClick={onReload}>
                Try again
              </button>
            </p>
          )}
          {state === 'ready' && conversations.length === 0 && (
            <p className="muted convos__note">
              No conversations yet. Your first message starts one.
            </p>
          )}
          {state === 'ready' && conversations.length > 0 && shown.length === 0 && (
            <p className="muted convos__note">
              Nothing matches &ldquo;{query.trim()}&rdquo;. Conversations you have not named yet are
              found by date, not by name.
            </p>
          )}
          {shown.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              canDelete={canRemoveMemory({ authorId: c.user_id }, actor).allowed}
              busy={busyId === c.id}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      </aside>
    </>
  );
}

type RowMode = 'view' | 'rename' | 'confirm';

function ConversationRow({
  conversation,
  active,
  canDelete,
  busy,
  onSelect,
  onRename,
  onDelete,
}: {
  readonly conversation: ConversationListRow;
  readonly active: boolean;
  readonly canDelete: boolean;
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onRename: (id: string, title: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}): ReactElement {
  const [mode, setMode] = useState<RowMode>('view');
  const [draft, setDraft] = useState(conversation.title ?? '');

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed === '' || busy) return;
    void onRename(conversation.id, trimmed).then(() => {
      setMode('view');
    });
  };

  if (mode === 'rename') {
    return (
      <form className="convos__rename" onSubmit={submit} role="listitem">
        <label className="sr-only" htmlFor={`convos-rename-${conversation.id}`}>
          Name this conversation
        </label>
        <input
          id={`convos-rename-${conversation.id}`}
          className="field__input"
          value={draft}
          maxLength={CONVERSATION_TITLE_MAX_CHARS}
          placeholder="e.g. Refinance ads for October"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <div className="mem__row">
          <button
            className="button button--primary button--small"
            type="submit"
            disabled={busy || draft.trim() === ''}
          >
            {busy ? 'Saving…' : 'Save name'}
          </button>
          <button
            className="button button--small"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(conversation.title ?? '');
              setMode('view');
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={`convos__row${active ? ' convos__row--active' : ''}`} role="listitem">
      <button
        type="button"
        className={`convos__item${active ? ' convos__item--active' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          onSelect(conversation.id);
        }}
      >
        <span className="convos__item-title">{conversation.title ?? UNTITLED_CONVERSATION}</span>
        <span className="convos__item-when">{formatWhen(conversation.last_active_at)}</span>
      </button>

      {mode === 'confirm' ? (
        <div className="notice convos__confirm" role="alert">
          <p>{DELETE_CONVERSATION_CONFIRM}</p>
          <div className="mem__row">
            <button
              className="button button--small mem__danger"
              type="button"
              disabled={busy}
              onClick={() => {
                void onDelete(conversation.id).then(() => {
                  setMode('view');
                });
              }}
            >
              {busy ? 'Deleting…' : 'Delete it'}
            </button>
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('view');
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="convos__actions">
          <button
            className="link convos__action"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(conversation.title ?? '');
              setMode('rename');
            }}
          >
            Rename
          </button>
          {canDelete && (
            <button
              className="link convos__action convos__action--danger"
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('confirm');
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
