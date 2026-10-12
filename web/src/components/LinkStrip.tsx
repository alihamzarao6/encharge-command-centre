/**
 * The links in the message being written, each with what can be done about it (Milestone 5
 * part 2, D94). It sits just above the message box and answers, before anything is sent, the
 * one question a link raises: has this page been read or not?
 *
 * Nothing here fetches anything. A page is read when the person presses "Read this page" —
 * and only then.
 *
 * An address is text a person pasted, and can be very long. It is shown shortened, cut with
 * an ellipsis rather than allowed to push the layout sideways, and given in full in the
 * `title`. What happened to a read is said in words beside it; the same words go through the
 * shell's live region when the read finishes (uploads.ts).
 */
import type { ReactElement } from 'react';

import { READ_AGAIN_LABEL, READ_PAGE_LABEL, type LinkOffer } from '../lib/filesView.js';

interface Props {
  readonly offers: readonly LinkOffer[];
  /** Links in the draft beyond the ones offered. */
  readonly more: number;
  readonly onRead: (url: string) => void;
  /** The message is on its way: nothing new is started. */
  readonly disabled: boolean;
}

const STATE_WORDS: Readonly<Record<LinkOffer['state'], string>> = {
  unread: 'Not read yet',
  refused: 'Will not be opened',
  reading: 'Reading…',
  read: 'Read',
  failed: 'Not read',
};

export function LinkStrip({ offers, more, onRead, disabled }: Props): ReactElement | null {
  if (offers.length === 0) return null;
  return (
    <ul className="links" aria-label="Links in this message" data-testid="link-strip">
      {offers.map((offer) => {
        const { link, state } = offer;
        const button =
          state === 'unread'
            ? READ_PAGE_LABEL
            : state === 'read'
              ? READ_AGAIN_LABEL
              : state === 'failed' && offer.retryable
                ? 'Try again'
                : null;
        return (
          <li key={link.url} className={`links__row links__row--${state}`} data-state={state}>
            <span className="links__icon" aria-hidden="true">
              🔗
            </span>
            <div className="links__body">
              <p className="links__address" title={link.url}>
                {link.display}
              </p>
              <p className="links__state">{offer.detail ?? STATE_WORDS[state]}</p>
            </div>
            {button !== null && (
              <button
                type="button"
                className={`button button--small${state === 'unread' ? ' button--primary' : ''} links__read`}
                // Two links in one message need telling apart by more than "Read this page".
                aria-label={`${button}: ${link.host}`}
                disabled={disabled}
                onClick={() => {
                  onRead(link.url);
                }}
              >
                {button}
              </button>
            )}
          </li>
        );
      })}
      {more > 0 && (
        <li className="links__more">
          {more === 1 ? 'One more link is' : `${String(more)} more links are`} in this message.
          Links are read a few at a time: read these first.
        </li>
      )}
    </ul>
  );
}
