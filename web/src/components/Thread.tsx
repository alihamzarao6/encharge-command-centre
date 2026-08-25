import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { ChatFailure } from '../lib/chatApi.js';
import { browserClipboardDeps, copyText } from '../lib/clipboard.js';
import { splitNotes } from '../lib/notes.js';

export interface LocalMessage {
  readonly localId: string;
  readonly id: string | null;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /**
   * saved — on the server; sending — the user's message, in flight; streaming — the reply,
   * arriving; failed — the user's message, with the reason and (maybe) the partial reply.
   */
  readonly status: 'saved' | 'sending' | 'streaming' | 'failed';
  readonly error?: ChatFailure;
}

interface Props {
  readonly messages: readonly LocalMessage[];
  readonly state: 'idle' | 'loading' | 'error';
  /** A turn is in flight and no reply text has arrived yet. */
  readonly waiting: boolean;
  readonly onRetry: (message: LocalMessage) => void;
  readonly onDiscard: (localId: string) => void;
}

/** Honest progress: how long the wait has been, and a word when it is running long. */
function Progress(): ReactElement {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="bubble bubble--assistant bubble--progress" role="status" aria-live="polite">
      <span className="dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="bubble__progress-text">
        Writing… {seconds > 0 ? `${String(seconds)}s` : ''}
        {seconds >= 8 && <em> — longer pieces take 15–20 seconds</em>}
      </span>
    </div>
  );
}

/**
 * Copies the COPY, not the note: a trailing `Note:` line is the assistant talking to Ross
 * (VOICE.md), and it must not travel into Facebook with the post.
 */
function CopyButton({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}): ReactElement {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => {
      setState('idle');
    }, 1_800);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  return (
    <button
      type="button"
      className={`copy${state === 'copied' ? ' copy--done' : ''}`}
      data-copy-state={state}
      aria-label={label}
      onClick={() => {
        void copyText(browserClipboardDeps(), text).then((ok) => {
          setState(ok ? 'copied' : 'failed');
        });
      }}
    >
      {state === 'copied' ? '✓ Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

/** A reply: the copy, then any Note: lines set apart so they read as what they are. */
function AssistantContent({ content }: { readonly content: string }): ReactElement {
  const { copy, notes } = splitNotes(content);
  return (
    <>
      <div className="bubble__content">{copy === '' ? content : copy}</div>
      {notes.length > 0 && (
        <div className="bubble__notes" data-testid="notes">
          {notes.map((note, index) => (
            <p key={index}>
              <span className="bubble__notes-label">Note</span> {note}
            </p>
          ))}
        </div>
      )}
    </>
  );
}

export function Thread({ messages, state, waiting, onRetry, onDiscard }: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);

  // Scroll the thread container, never the page: the composer and the header stay put.
  useEffect(() => {
    const node = scroller.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [messages, waiting]);

  return (
    <div className="thread" ref={scroller} data-testid="thread">
      {state === 'loading' && <p className="muted thread__note">Loading conversation…</p>}
      {state === 'error' && (
        <p className="error thread__note">
          Couldn't load this conversation. Pick it again to retry.
        </p>
      )}
      {state === 'idle' && messages.length === 0 && !waiting && (
        <div className="empty">
          <h2 className="empty__title">What do you want to say?</h2>
          <p className="muted">
            Ask for a Facebook post, a Meta ad, a reply to a lead, or just talk it through. Every
            reply comes back in the Fundd voice and can be copied with one tap.
          </p>
        </div>
      )}
      {messages.map((m) => (
        <article
          key={m.localId}
          className={`bubble bubble--${m.role}${m.status === 'failed' ? ' bubble--failed' : ''}${m.status === 'sending' ? ' bubble--sending' : ''}${m.status === 'streaming' ? ' bubble--streaming' : ''}`}
          data-role={m.role}
          data-status={m.status}
          aria-live={m.status === 'streaming' ? 'polite' : undefined}
        >
          {m.role === 'assistant' && m.status === 'saved' ? (
            <AssistantContent content={m.content} />
          ) : (
            <div className="bubble__content">
              {m.content}
              {m.status === 'streaming' && <span className="caret" aria-hidden="true" />}
            </div>
          )}
          {m.status === 'saved' && (
            <div className="bubble__actions">
              <CopyButton
                text={m.role === 'assistant' ? splitNotes(m.content).copy : m.content}
                label={m.role === 'assistant' ? 'Copy reply' : 'Copy message'}
              />
            </div>
          )}
          {m.status === 'failed' && m.error !== undefined && (
            <div className="bubble__error" role="alert">
              <p>{m.error.message}</p>
              {m.error.partialText !== undefined && (
                <div className="bubble__partial" data-testid="partial">
                  <span className="bubble__partial-label">Incomplete reply — not saved</span>
                  <div className="bubble__content">{m.error.partialText}</div>
                </div>
              )}
              <div className="bubble__actions">
                {m.error.failure === 'retryable' && (
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => {
                      onRetry(m);
                    }}
                  >
                    Retry
                  </button>
                )}
                <CopyButton text={m.content} label="Copy message" />
                <button
                  type="button"
                  className="button button--small button--ghost"
                  onClick={() => {
                    onDiscard(m.localId);
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
      {waiting && <Progress />}
    </div>
  );
}
