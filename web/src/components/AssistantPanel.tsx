/**
 * The assistant beside the numbers (Milestone 4 part 2): the SAME conversation the Assistant
 * page shows, in a panel that opens over or beside whatever screen the person is on, so a
 * quick question does not mean leaving the numbers. It reads the shared thread store; the
 * page reads the same store; there is nothing to keep in step.
 *
 * Deliberately less than the page: the current thread, a composer, "+ New" and a link to the
 * full page. Conversation history, renaming, privacy and the administrator's views live on
 * the page, which is one tap away and keeps every behaviour Milestone 3 signed off.
 *
 * Three shapes for three widths (Part A decision 5): a full-screen sheet on a phone, where a
 * docked column has no room to exist; a drawer over the content from 768; a docked column
 * beside the content from 1280. Reachable and dismissable by keyboard — Escape closes it and
 * focus goes back to the button that opened it (the shell owns that half).
 */
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';

import { Composer } from './Composer.js';
import { Thread } from './Thread.js';
import { useThreadState, useThreadStore } from './ThreadContext.js';

interface Props {
  readonly onClose: () => void;
  readonly onOpenFullPage: () => void;
}

export function AssistantPanel({ onClose, onOpenFullPage }: Props): ReactElement {
  const store = useThreadStore();
  const state = useThreadState();
  const panel = useRef<HTMLElement>(null);

  // Whatever arrived is now on screen.
  useEffect(() => {
    store.markSeen();
  }, [store, state.messages]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <aside
      id="assistant-panel"
      className="panel"
      aria-label="Assistant"
      ref={panel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="panel__bar">
        <h2 className="panel__title">Assistant</h2>
        <button
          className="button button--ghost button--small"
          type="button"
          onClick={() => {
            void store.open(null);
          }}
        >
          + New
        </button>
        <button
          className="button button--ghost button--small"
          type="button"
          onClick={onOpenFullPage}
        >
          Full page
        </button>
        <button
          className="button button--ghost panel__close"
          type="button"
          aria-label="Close assistant panel"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      {state.notice !== null && (
        <p className="notice thread-pane__notice" role="status">
          {state.notice}
        </p>
      )}
      <Thread
        messages={state.messages}
        state={state.threadState}
        waiting={state.waiting}
        onRetry={store.retry}
        onDiscard={store.discard}
        testId="panel-thread"
      />
      <Composer
        value={state.draft}
        disabled={state.sending}
        onChange={store.setDraft}
        onSend={() => {
          void store.send(state.draft, null);
        }}
        inputId="panel-composer"
        autoFocus
      />
    </aside>
  );
}
