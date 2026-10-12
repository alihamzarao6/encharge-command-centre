/**
 * Reading the links in a draft (Milestone 5 part 2, D94) — the React end of it, shared by
 * the Assistant page and the docked panel so the two cannot behave differently.
 *
 * Three things happen here and nowhere else:
 *
 *  - "Read this page": the link joins the upload queue (uploads.ts). If the message was
 *    nothing but that link, the link is taken out of the box once the page is in: the page
 *    is now in the conversation, and the box is free for the question.
 *  - "Read it, then send": the links are read and, only if every one of them was read, the
 *    message is sent. If one was not, nothing is sent — the reason is on screen beside the
 *    link — because a message sent without the page it asks about gets an answer about a
 *    page the assistant never saw.
 *  - Nothing else. A link is never read because it was typed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { linkOffers, type LinkOffer } from '../lib/filesView.js';
import { findLinks, onlyLinks, withoutLink } from '../lib/links.js';
import type { LinkOutcome } from '../lib/uploads.js';
import { useAttachments } from './UploadsContext.js';

export interface ComposerLinks {
  readonly offers: readonly LinkOffer[];
  readonly more: number;
  readonly onRead: (url: string) => void;
  /** Read these, and send the message once every one of them is in. */
  readonly onReadThenSend: (urls: readonly string[]) => void;
  /** A message that was held back because a page it needed could not be read. */
  readonly notSent: string | null;
}

export const NOT_SENT_NOTE =
  'The message was not sent, because the page could not be read. The reason is beside the link. You can send it without the page, or try the page again.';

const settled = (outcome: LinkOutcome): boolean => outcome === 'attached' || outcome === 'already';

export function useLinkReading(args: {
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  readonly send: (text: string) => void;
}): ComposerLinks {
  const { draft, setDraft, send } = args;
  const { store, state } = useAttachments();
  const [notSent, setNotSent] = useState<string | null>(null);

  // What the box holds when a read finishes, not when it was started: he may have typed on.
  const latest = useRef({ draft, setDraft, send });
  useEffect(() => {
    latest.current = { draft, setDraft, send };
  }, [draft, setDraft, send]);

  // A held-back message is yesterday's news once the words change.
  useEffect(() => {
    setNotSent(null);
  }, [draft]);

  const { offers, more } = useMemo(() => linkOffers(draft, state, Date.now()), [draft, state]);

  /** Take a link that has been read out of a box that holds nothing else. */
  const tidy = useCallback((url: string): void => {
    const now = latest.current;
    const link = findLinks(now.draft).find((entry) => entry.url === url);
    if (link !== undefined && onlyLinks(now.draft)) now.setDraft(withoutLink(now.draft, link));
  }, []);

  const onRead = useCallback(
    (url: string): void => {
      void store.addLink(url).then((outcome) => {
        if (settled(outcome)) tidy(url);
      });
    },
    [store, tidy],
  );

  const onReadThenSend = useCallback(
    (urls: readonly string[]): void => {
      setNotSent(null);
      void Promise.all(urls.map((url) => store.addLink(url))).then((outcomes) => {
        if (!outcomes.every(settled)) {
          // Stopping it himself needs no explaining; a page that would not read does.
          if (outcomes.includes('failed')) setNotSent(NOT_SENT_NOTE);
          return;
        }
        const now = latest.current;
        if (onlyLinks(now.draft)) {
          // Nothing but links: the pages are in, and there is no question to send yet.
          now.setDraft('');
          return;
        }
        now.send(now.draft);
      });
    },
    [store],
  );

  return { offers, more, onRead, onReadThenSend, notSent };
}
