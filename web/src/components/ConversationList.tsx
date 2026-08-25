import type { ConversationListRow } from '../lib/supabase.js';
import type { ReactElement } from 'react';

interface Props {
  readonly conversations: readonly ConversationListRow[];
  readonly state: 'loading' | 'ready' | 'error';
  readonly activeId: string | null;
  /** Phone only: the list is a sheet that slides over the thread. */
  readonly open: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onClose: () => void;
  readonly onReload: () => void;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Australia/Perth',
});

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date);
}

export function ConversationList({
  conversations,
  state,
  activeId,
  open,
  onSelect,
  onClose,
  onReload,
}: Props): ReactElement {
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
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              role="listitem"
              className={`convos__item${c.id === activeId ? ' convos__item--active' : ''}`}
              aria-current={c.id === activeId ? 'true' : undefined}
              onClick={() => {
                onSelect(c.id);
              }}
            >
              <span className="convos__item-title">{c.title ?? 'Untitled conversation'}</span>
              <span className="convos__item-when">{formatWhen(c.last_active_at)}</span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
