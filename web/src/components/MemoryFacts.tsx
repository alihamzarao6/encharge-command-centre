/**
 * Standing notes: the things someone told the assistant to keep, which it is given on every
 * turn. This is the half of memory a person is accountable for, so it comes first and it is
 * the half that can be added to, corrected and removed.
 *
 * Two words are used carefully and they are promises:
 *   "Forget" — not "delete". The note stops reaching the assistant from the next message on
 *   and moves to Removed notes, where its wording is still readable and can be brought back.
 *   Nothing is destroyed, and the page says so on the confirm step rather than in a tooltip.
 *   "Earlier wording" — every value a note has ever held, because a note that quietly
 *   changed is worse than one that visibly did.
 */
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import {
  MEMORY_NOTE_MAX_INPUT_CHARS,
  MEMORY_NOTE_MAX_VALUE_CHARS,
} from '../../../src/lib/memory/access.js';
import type { FactLists, MemoryFactView } from '../lib/memoryView.js';

export interface FactHandlers {
  readonly onAdd: (text: string) => Promise<void>;
  readonly onEdit: (factId: string, value: string) => Promise<void>;
  readonly onForget: (factId: string) => Promise<void>;
}

interface Props extends FactHandlers {
  readonly lists: FactLists;
  /** The id being written right now, or 'add' for the form. Everything else stays usable. */
  readonly busy: string | null;
}

/** The example is deliberately one the client would actually say. */
const PLACEHOLDER = 'e.g. Our posts always end with a direct call to action.';

export function AddNoteForm({
  busy,
  onAdd,
}: {
  readonly busy: boolean;
  readonly onAdd: (text: string) => Promise<void>;
}): ReactElement {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;
    void onAdd(trimmed).then(() => {
      setText('');
    });
  };

  if (!open) {
    return (
      <button
        className="button button--primary button--block mem__add-open"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        + Add a note
      </button>
    );
  }

  return (
    <form className="card mem__add" onSubmit={submit}>
      <label className="field__label" htmlFor="mem-add">
        Tell it something to remember
      </label>
      <textarea
        id="mem-add"
        className="field__input mem__textarea"
        value={text}
        maxLength={MEMORY_NOTE_MAX_INPUT_CHARS}
        placeholder={PLACEHOLDER}
        rows={3}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <p className="muted mem__hint">
        Write it as you would say it to a new team member. One thing per note. It is shared with
        everyone who uses the Command Centre.
      </p>
      <div className="mem__row">
        <button
          className="button button--primary"
          type="submit"
          disabled={busy || text.trim() === ''}
        >
          {busy ? 'Saving…' : 'Save note'}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setText('');
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

type CardMode = 'view' | 'edit' | 'confirm';

function FactCard({
  fact,
  history,
  busy,
  onEdit,
  onForget,
}: {
  readonly fact: MemoryFactView;
  readonly history: readonly MemoryFactView[];
  readonly busy: boolean;
  readonly onEdit: (factId: string, value: string) => Promise<void>;
  readonly onForget: (factId: string) => Promise<void>;
}): ReactElement {
  const [mode, setMode] = useState<CardMode>('view');
  const [draft, setDraft] = useState(fact.value);
  const [showHistory, setShowHistory] = useState(false);
  const earlier = history.filter((row) => row.id !== fact.id);
  const removed = fact.state === 'forgotten';

  const save = (value: string): void => {
    void onEdit(fact.id, value).then(() => {
      setMode('view');
    });
  };

  return (
    <li className={`card mem__card${removed ? ' mem__card--removed' : ''}`}>
      <div className="mem__card-head">
        <span className="badge">{fact.categoryLabel}</span>
        <span className="mem__topic">{fact.topic}</span>
      </div>

      {mode === 'edit' ? (
        <>
          <label className="sr-only" htmlFor={`mem-edit-${fact.id}`}>
            Reword this note
          </label>
          <textarea
            id={`mem-edit-${fact.id}`}
            className="field__input mem__textarea"
            value={draft}
            maxLength={MEMORY_NOTE_MAX_VALUE_CHARS}
            rows={3}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <div className="mem__row">
            <button
              className="button button--primary button--small"
              type="button"
              disabled={busy || draft.trim() === ''}
              onClick={() => {
                save(draft);
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(fact.value);
                setMode('view');
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <p className="mem__value">{fact.value}</p>
      )}

      <p className="muted mem__meta">
        {removed ? 'Removed' : 'Added'} by {fact.byYou ? 'you' : 'a teammate'} · {fact.statedOn}
      </p>

      {mode === 'confirm' && (
        <div className="notice mem__confirm" role="alert">
          <p>
            Forget this note? The assistant stops using it from your next message. It moves to
            Removed notes, where you can read it and add it back.
          </p>
          <div className="mem__row">
            <button
              className="button button--small mem__danger"
              type="button"
              disabled={busy}
              onClick={() => {
                void onForget(fact.id).then(() => {
                  setMode('view');
                });
              }}
            >
              {busy ? 'Forgetting…' : 'Forget it'}
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
      )}

      {mode === 'view' && (
        <div className="mem__row mem__actions">
          {removed ? (
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                save(fact.value);
              }}
            >
              Add it back
            </button>
          ) : (
            <button
              className="button button--small"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(fact.value);
                setMode('edit');
              }}
            >
              Edit
            </button>
          )}
          {earlier.length > 0 && (
            <button
              className="link mem__link"
              type="button"
              aria-expanded={showHistory}
              onClick={() => {
                setShowHistory((open) => !open);
              }}
            >
              {showHistory ? 'Hide earlier wording' : `Earlier wording (${String(earlier.length)})`}
            </button>
          )}
          {!removed && fact.canRemove && (
            <button
              className="link mem__link mem__link--danger"
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('confirm');
              }}
            >
              Forget
            </button>
          )}
        </div>
      )}

      {showHistory && (
        <div className="mem__history">
          <h3 className="mem__history-title">How this note has changed</h3>
          <ol className="mem__history-list">
            {history.map((row) => (
              <li key={row.id} className="mem__history-item">
                <span className="mem__history-when">{row.statedOn}</span>
                <span className="mem__history-value">{row.value}</span>
                <span className="mem__history-state">
                  {row.id === fact.id && !removed
                    ? 'in use now'
                    : row.state === 'forgotten'
                      ? 'removed'
                      : 'replaced'}
                </span>
                {row.id !== fact.id && (
                  <button
                    className="link mem__link"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      save(row.value);
                    }}
                  >
                    Use this wording again
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

export function MemoryFacts({ lists, busy, onAdd, onEdit, onForget }: Props): ReactElement {
  const [showRemoved, setShowRemoved] = useState(false);

  return (
    <div className="mem__pane">
      <AddNoteForm busy={busy === 'add'} onAdd={onAdd} />

      {lists.live.length === 0 ? (
        <p className="muted mem__none">
          No standing notes yet. Add one above, or say &ldquo;Remember that…&rdquo; in the
          Assistant.
        </p>
      ) : (
        <ul className="mem__list">
          {lists.live.map((fact) => (
            <FactCard
              key={fact.id}
              fact={fact}
              history={lists.history[fact.key] ?? [fact]}
              busy={busy === fact.id}
              onEdit={onEdit}
              onForget={onForget}
            />
          ))}
        </ul>
      )}

      {lists.forgotten.length > 0 && (
        <section className="mem__removed">
          <button
            className="link mem__link"
            type="button"
            aria-expanded={showRemoved}
            onClick={() => {
              setShowRemoved((open) => !open);
            }}
          >
            {showRemoved
              ? 'Hide removed notes'
              : `Removed notes (${String(lists.forgotten.length)})`}
          </button>
          {showRemoved && (
            <ul className="mem__list">
              {lists.forgotten.map((fact) => (
                <FactCard
                  key={fact.id}
                  fact={fact}
                  history={lists.history[fact.key] ?? [fact]}
                  busy={busy === fact.id}
                  onEdit={onEdit}
                  onForget={onForget}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
