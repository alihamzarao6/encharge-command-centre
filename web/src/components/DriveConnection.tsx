/**
 * The Google Drive section of Settings (Milestone 5 part 3a): connect, see that it is connected
 * (to which account, and whether it still works), disconnect. Self-contained — it takes the
 * session and nothing else from the page around it — so Milestone 5 part 4's settings screen
 * places it as it is.
 *
 * Connecting leaves the app: Google's consent screen is a full page (it is the one that works on
 * a phone, where pop-ups are blocked). Google sends him back to /settings, and this section then
 * FINISHES the connection with his own signed-in session — the step that alone turns Google's
 * code into a connection (D123). The address bar is cleaned at once, so a refresh or a shared
 * screenshot carries nothing.
 *
 * Every state is said in words, never only by a colour or the presence of a button: a person
 * using a screen reader hears the headline, and the result of a connect or a disconnect is put
 * in this section's own live region (not a second role="status").
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import {
  callDrive,
  type DriveOutcome,
  type DriveReplyFor,
  type DriveRequest,
  type DriveStatus,
} from '../lib/driveApi.js';
import {
  DISCONNECT_CONFIRM_TEXT,
  DRIVE_SECTION_TEXT,
  STALE_RETURN_TEXT,
  parseReturn,
  returnMessage,
  sectionView,
} from '../lib/driveView.js';
import { webConfig } from '../lib/env.js';
import { supabase } from '../lib/supabase.js';

interface Props {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: DriveStatus }
  | { readonly kind: 'error' };

interface Notice {
  readonly text: string;
  readonly tone: 'ok' | 'problem';
}

/** Read the return from Google once, and take it out of the address bar straight away. */
function takeReturn(): ReturnType<typeof parseReturn> {
  if (typeof window === 'undefined') return { kind: 'none' };
  const found = parseReturn(window.location.search);
  if (found.kind !== 'none') {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return found;
}

/**
 * The return from Google is finished ONCE per page load, however many times the section mounts:
 * an attempt can be taken only once, and React's development mode runs every effect twice — a
 * second finish would answer "stale" over a connection that had just worked.
 */
let returning: Promise<Notice | null> | null = null;

export function DriveConnection({ session, onSessionExpired }: Props): ReactElement {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const latest = useRef(session);
  const expired = useRef(onSessionExpired);
  useEffect(() => {
    latest.current = session;
    expired.current = onSessionExpired;
  }, [session, onSessionExpired]);
  const keepButton = useRef<HTMLButtonElement>(null);

  const call = useCallback(
    async <R extends DriveRequest>(
      request: R,
    ): Promise<DriveOutcome<DriveReplyFor<R['action']>>> => {
      const { data } = await supabase.auth.getSession();
      const outcome = await callDrive(
        { driveUrl: webConfig.driveUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
        data.session?.access_token ?? latest.current.access_token,
        request,
      );
      if (outcome.kind === 'error' && outcome.failure === 'unauthenticated')
        await expired.current();
      return outcome;
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setLoad({ kind: 'loading' });
    const outcome = await call({ action: 'status' });
    setLoad(outcome.kind === 'ok' ? { kind: 'ready', status: outcome.reply } : { kind: 'error' });
  }, [call]);

  useEffect(() => {
    let cancelled = false;
    returning ??= (async (): Promise<Notice | null> => {
      const back = takeReturn();
      if (back.kind === 'stale') return { text: STALE_RETURN_TEXT, tone: 'problem' };
      if (back.kind !== 'returned') return null;
      const finished = await call({ action: 'connect_finish', attempt: back.attempt });
      if (finished.kind !== 'ok') return { text: finished.message, tone: 'problem' };
      const said = returnMessage(finished.reply.outcome, finished.reply.message);
      return {
        text: finished.reply.note === null ? said.text : `${said.text} ${finished.reply.note}`,
        tone: said.tone,
      };
    })();
    void returning.then(async (said) => {
      if (cancelled) return;
      // Shown by this mount; the next visit to Settings starts clean.
      returning = null;
      if (said !== null) setNotice(said);
      await refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [call, refresh]);

  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);

  async function connect(): Promise<void> {
    setBusy('connect');
    setNotice(null);
    const started = await call({ action: 'connect_start' });
    if (started.kind === 'error') {
      setBusy(null);
      setNotice({ text: started.message, tone: 'problem' });
      return;
    }
    // A full-page visit to Google's own consent screen. Nothing is kept here meanwhile.
    window.location.assign(started.reply.authorizeUrl);
  }

  async function disconnect(): Promise<void> {
    setBusy('disconnect');
    setConfirming(false);
    const done = await call({ action: 'disconnect' });
    setBusy(null);
    if (done.kind === 'error') {
      setNotice({ text: done.message, tone: 'problem' });
    } else {
      setNotice({ text: done.reply.message, tone: done.reply.disconnected ? 'ok' : 'problem' });
    }
    await refresh();
  }

  const view = load.kind === 'ready' ? sectionView(load.status, Date.now()) : null;

  return (
    <section
      className="settings__section"
      aria-labelledby="drive-heading"
      data-testid="drive-connection"
    >
      <h2 id="drive-heading" className="settings__heading">
        {DRIVE_SECTION_TEXT.title}
      </h2>
      {/* Spoken once when a connect or disconnect ends; never a second role="status". */}
      <div aria-live="polite" aria-atomic="true">
        {notice !== null && (
          <p className={`drive__notice drive__notice--${notice.tone}`} data-testid="drive-notice">
            {notice.text}
          </p>
        )}
      </div>

      {load.kind === 'loading' && (
        <p className="muted" aria-busy="true" data-testid="drive-loading">
          {DRIVE_SECTION_TEXT.checking}
        </p>
      )}
      {load.kind === 'error' && (
        <div className="drive__state drive__state--problem">
          <p className="drive__headline">{DRIVE_SECTION_TEXT.error}</p>
          <button type="button" className="button button--small" onClick={() => void refresh()}>
            {DRIVE_SECTION_TEXT.retry}
          </button>
        </div>
      )}
      {view !== null && (
        <div
          className={`drive__state drive__state--${view.tone}`}
          data-testid="drive-state"
          data-state={load.kind === 'ready' ? load.status.state : ''}
        >
          <p className="drive__headline" data-testid="drive-headline">
            {view.headline}
          </p>
          <p className="drive__detail">{view.detail}</p>

          {confirming ? (
            <div className="drive__confirm" role="alert" data-testid="drive-confirm">
              <p>{DISCONNECT_CONFIRM_TEXT}</p>
              <div className="drive__actions">
                <button
                  type="button"
                  className="button button--small button--danger"
                  onClick={() => void disconnect()}
                >
                  {DRIVE_SECTION_TEXT.confirmDisconnect}
                </button>
                <button
                  ref={keepButton}
                  type="button"
                  className="button button--small"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {DRIVE_SECTION_TEXT.keep}
                </button>
              </div>
            </div>
          ) : (
            view.actions.length > 0 && (
              <div className="drive__actions">
                {view.actions.map((action) =>
                  action === 'disconnect' ? (
                    <button
                      key={action}
                      type="button"
                      className="button button--small"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirming(true);
                      }}
                    >
                      {busy === 'disconnect' ? 'Disconnecting…' : DRIVE_SECTION_TEXT.disconnect}
                    </button>
                  ) : (
                    <button
                      key={action}
                      type="button"
                      className="button button--small button--primary"
                      disabled={busy !== null}
                      onClick={() => void connect()}
                    >
                      {busy === 'connect'
                        ? DRIVE_SECTION_TEXT.leaving
                        : action === 'reconnect'
                          ? DRIVE_SECTION_TEXT.reconnect
                          : DRIVE_SECTION_TEXT.connect}
                    </button>
                  ),
                )}
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}
