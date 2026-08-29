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
 *
 * Part 5 adds the third thing, and the only one whose rule is different: WHO CAN SEE IT.
 * `canSetConversationPrivacy` is the author's alone — an administrator, who may delete
 * anything, may not share somebody's private conversation back to the team. The confirm step
 * carries the whole sentence (`MAKE_PRIVATE_CONFIRM`), including the half nobody would
 * guess: what the assistant LEARNS in a private conversation is still shared. A private row
 * also says so at a glance, so it never has to be opened to be recognised.
 */
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { canRemoveMemory, type MemoryActor } from '../../../src/lib/memory/access.js';
import { canSetConversationPrivacy } from '../../../src/lib/memory/privacy.js';
import {
  CONVERSATION_PREFIX_SEPARATOR,
  CONVERSATION_TITLE_MAX_CHARS,
} from '../../../src/lib/memory/naming.js';
import {
  ADMIN_PRIVATE_SECTION,
  CONVERSATION_FILTER_THRESHOLD,
  DELETE_CONVERSATION_CONFIRM,
  filterConversations,
  MAKE_PRIVATE_CONFIRM,
  MAKE_SHARED_CONFIRM,
  PRIVACY_STATE_LABEL,
  PRIVACY_TOGGLE_LABEL,
  type ConversationView,
} from '../lib/conversationsView.js';

interface Props {
  readonly conversations: readonly ConversationView[];
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
  /** Stage 3 part 5 (R27). Offered on the author's own rows only — an admin does not get it. */
  readonly onSetPrivacy: (id: string, isPrivate: boolean) => Promise<void>;
  /**
   * Stage 3 part 5, admin only: other people's private conversations. RLS does not return
   * them, so these arrive from the audited server path and are held by the parent.
   */
  readonly privateRows: readonly AdminPrivateRow[];
  readonly privateState: 'idle' | 'loading' | 'ready' | 'error';
  readonly onLoadPrivate: () => void;
  readonly onOpenPrivate: (id: string) => void;
}

/** One row of the admin listing, as the list needs it. No title — see privacy.ts. */
export interface AdminPrivateRow {
  readonly id: string;
  readonly author: string;
  readonly when: string;
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
  onSetPrivacy,
  privateRows,
  privateState,
  onLoadPrivate,
  onOpenPrivate,
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
              canDelete={canRemoveMemory({ authorId: c.authorId }, actor).allowed}
              canSetPrivacy={canSetConversationPrivacy({ authorId: c.authorId }, actor).allowed}
              busy={busyId === c.id}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
              onSetPrivacy={onSetPrivacy}
            />
          ))}
        </div>
        {actor.isAdmin && (
          <div className="convos__admin">
            <h3 className="convos__admin-title">{ADMIN_PRIVATE_SECTION.heading}</h3>
            <p className="muted convos__note">{ADMIN_PRIVATE_SECTION.hint}</p>
            {privateState === 'idle' && (
              <button
                className="button button--small button--block"
                type="button"
                onClick={onLoadPrivate}
              >
                Show them
              </button>
            )}
            {privateState === 'loading' && <p className="muted convos__note">Loading…</p>}
            {privateState === 'error' && (
              <p className="error convos__note">
                Couldn&apos;t load them.{' '}
                <button className="link" type="button" onClick={onLoadPrivate}>
                  Try again
                </button>
              </p>
            )}
            {privateState === 'ready' && privateRows.length === 0 && (
              <p className="muted convos__note">{ADMIN_PRIVATE_SECTION.empty}</p>
            )}
            {privateState === 'ready' &&
              privateRows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="convos__item convos__item--private"
                  onClick={() => {
                    onOpenPrivate(row.id);
                  }}
                >
                  <span className="convos__item-title">
                    {row.author}
                    {CONVERSATION_PREFIX_SEPARATOR}
                    {ADMIN_PRIVATE_SECTION.rowName}
                  </span>
                  <span className="convos__item-when">{row.when}</span>
                </button>
              ))}
          </div>
        )}
      </aside>
    </>
  );
}

type RowMode = 'view' | 'rename' | 'confirm' | 'privacy';

function ConversationRow({
  conversation,
  active,
  canDelete,
  canSetPrivacy,
  busy,
  onSelect,
  onRename,
  onDelete,
  onSetPrivacy,
}: {
  readonly conversation: ConversationView;
  readonly active: boolean;
  readonly canDelete: boolean;
  readonly canSetPrivacy: boolean;
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
  readonly onRename: (id: string, title: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
  readonly onSetPrivacy: (id: string, isPrivate: boolean) => Promise<void>;
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
        {/* The author's prefix is derived, not stored, and is not the renamer's to change —
            so it sits OUTSIDE the field, visibly fixed, rather than as editable text the
            server would only strip back off. */}
        <div className="convos__rename-row">
          {conversation.prefix !== null && (
            <span className="convos__rename-prefix" aria-hidden="true">
              {conversation.prefix}
              {CONVERSATION_PREFIX_SEPARATOR}
            </span>
          )}
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
        </div>
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
        <span className="convos__item-title">{conversation.displayName}</span>
        <span className="convos__item-when">
          {conversation.when}
          {conversation.isPrivate && (
            <>
              {' · '}
              <span className="convos__item-private">{PRIVACY_STATE_LABEL.user}</span>
            </>
          )}
        </span>
      </button>

      {mode === 'privacy' ? (
        <div className="notice convos__confirm" role="alert">
          <p>{conversation.isPrivate ? MAKE_SHARED_CONFIRM : MAKE_PRIVATE_CONFIRM}</p>
          <div className="mem__row">
            <button
              className="button button--primary button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                void onSetPrivacy(conversation.id, !conversation.isPrivate).then(() => {
                  setMode('view');
                });
              }}
            >
              {busy
                ? 'Saving…'
                : conversation.isPrivate
                  ? PRIVACY_TOGGLE_LABEL.makeShared
                  : PRIVACY_TOGGLE_LABEL.makePrivate}
            </button>
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('view');
              }}
            >
              Leave it as it is
            </button>
          </div>
        </div>
      ) : mode === 'confirm' ? (
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
          {/* Only the author (canSetConversationPrivacy — deliberately NOT canRemoveMemory,
              which widens to an admin). Everyone else sees the badge and no control.
              This is the copy that exists at EVERY width: the thread bar carries the same
              toggle from 768 up, because at 375 a fifth control in that bar collapses the
              conversation's title to nothing (styles.css, .thread-pane__privacy). */}
          {canSetPrivacy && (
            <button
              className="link convos__action"
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('privacy');
              }}
            >
              {conversation.isPrivate
                ? PRIVACY_TOGGLE_LABEL.makeShared
                : PRIVACY_TOGGLE_LABEL.makePrivate}
            </button>
          )}
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
