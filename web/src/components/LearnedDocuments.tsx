/**
 * What the assistant has learned (Milestone 5 part 4, the headline requirement): every document
 * and page it can draw on, newest first, and a way to make it forget one — at once, everywhere,
 * for good.
 *
 * The list is read under RLS as the signed-in person (every member of staff sees every learned
 * document — knowledge is the account's). Forgetting goes to the settings endpoint, which runs
 * one database transaction; the button is offered only where that transaction will agree
 * (`canForgetDocument`, shared with the server), and where it is not, the row says why.
 *
 * ACCESSIBILITY. The confirmation is a short-lived `role="alert"` (the Drive section's pattern),
 * so a screen reader speaks what will happen; focus goes to "Keep it", the safe choice; Escape
 * keeps it too and returns focus to the row's button. The result is spoken from this section's
 * own live region (never a second role="status") and focus moves to it, because the button that
 * had it is gone with the row.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { SettingsActor } from '../../../src/lib/settings/access.js';
import { readDocuments, readRoster } from '../lib/settingsData.js';
import {
  buildDocumentList,
  documentMeta,
  DOCUMENTS_PAGE_SIZE,
  EMPTY_TEXT,
  forgetConfirmText,
  forgetResultText,
  SECTION_TEXT,
  type DocumentView,
} from '../lib/settingsView.js';
import { supabase } from '../lib/supabase.js';
import { SettingsPager } from './SettingsPager.js';
import { useSettingsCall } from './useSettingsCall.js';

interface Props {
  readonly session: Session;
  readonly actor: SettingsActor;
  readonly onSessionExpired: () => Promise<void>;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly docs: readonly DocumentView[]; readonly total: number }
  | { readonly kind: 'error' };

interface Notice {
  readonly text: string;
  readonly tone: 'ok' | 'problem';
}

export function LearnedDocuments({ session, actor, onSessionExpired }: Props): ReactElement {
  const call = useSettingsCall(session, onSessionExpired);
  const [page, setPage] = useState(1);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Set by an action whose button is gone or changed: the result takes focus once it is on screen.
  const focusNotice = useRef(false);
  const returnTo = useRef<string | null>(null);
  const expired = useRef(onSessionExpired);
  useEffect(() => {
    expired.current = onSessionExpired;
  }, [onSessionExpired]);
  useEffect(() => {
    if (notice !== null && focusNotice.current) {
      focusNotice.current = false;
      noticeRef.current?.focus();
    }
  }, [notice]);

  const refresh = useCallback(
    async (target: number): Promise<void> => {
      setLoad((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
      const [documents, roster] = await Promise.all([
        readDocuments(supabase, target, DOCUMENTS_PAGE_SIZE),
        readRoster(supabase),
      ]);
      if (documents.kind === 'expired') {
        await expired.current();
        return;
      }
      if (documents.kind === 'unavailable') {
        setLoad({ kind: 'error' });
        return;
      }
      const { rows, related, total } = documents.value;
      // A page emptied by forgetting its last row: step back rather than show a blank page.
      if (rows.length === 0 && target > 1) {
        setPage(target - 1);
        return;
      }
      setLoad({
        kind: 'ready',
        docs: buildDocumentList(rows, related, roster, actor, Date.now()),
        total,
      });
    },
    [actor],
  );

  useEffect(() => {
    void refresh(page);
  }, [page, refresh]);

  useEffect(() => {
    if (confirming !== null) keepButton.current?.focus();
  }, [confirming]);

  const docs = useMemo(() => (load.kind === 'ready' ? load.docs : []), [load]);

  function cancel(): void {
    const back = returnTo.current;
    setConfirming(null);
    if (back !== null) {
      window.requestAnimationFrame(() => {
        document.getElementById(`forget-${back}`)?.focus();
      });
    }
  }

  async function forget(doc: DocumentView): Promise<void> {
    setConfirming(null);
    setBusy(doc.id);
    setNotice(null);
    const outcome = await call({ action: 'forget_document', sourceId: doc.id });
    setBusy(null);
    if (outcome.kind === 'ok' && outcome.reply.action === 'forget_document') {
      setNotice({
        tone: 'ok',
        text: forgetResultText(
          doc.name,
          outcome.reply.outcome === 'forgotten'
            ? {
                outcome: 'forgotten',
                files: outcome.reply.files,
                sources: outcome.reply.sources,
                ...(outcome.reply.conversationsWithAnswers === undefined
                  ? {}
                  : { conversationsWithAnswers: outcome.reply.conversationsWithAnswers }),
              }
            : { outcome: 'already' },
        ),
      });
    } else if (outcome.kind === 'error') {
      if (outcome.failure === 'unauthenticated') return;
      setNotice({ tone: 'problem', text: outcome.message });
    }
    focusNotice.current = true;
    await refresh(page);
  }

  return (
    <section
      id="learned"
      className="settings__section"
      aria-labelledby="learned-heading"
      data-testid="settings-documents"
    >
      <h2 id="learned-heading" className="settings__heading">
        What the assistant has learned
      </h2>
      <p className="settings__intro">{SECTION_TEXT.documentsIntro}</p>
      {/* Spoken once when a forget ends; never a second role="status". */}
      <div
        aria-live="polite"
        aria-atomic="true"
        tabIndex={-1}
        ref={noticeRef}
        className="settings__live"
      >
        {notice !== null && (
          <p
            className={`settings__notice settings__notice--${notice.tone}`}
            data-testid="documents-notice"
          >
            {notice.text}
          </p>
        )}
      </div>

      {load.kind === 'loading' && (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="settings__problem" data-testid="documents-error">
          <p>{SECTION_TEXT.unavailable}</p>
          <button type="button" className="button button--small" onClick={() => void refresh(page)}>
            Try again
          </button>
        </div>
      )}
      {load.kind === 'ready' && load.total === 0 && (
        <p className="settings__empty" data-testid="documents-empty">
          {EMPTY_TEXT.documents}
        </p>
      )}

      {docs.length > 0 && (
        <ul className="learned__list" aria-label="Learned documents">
          {docs.map((doc) => (
            <li key={doc.id} className="learned__item" data-testid="learned-document">
              <p className="learned__name" dir="auto">
                {doc.name}
              </p>
              <p className="learned__meta">{documentMeta(doc)}</p>
              <p className={`learned__state learned__state--${doc.state}`}>{doc.stateLabel}</p>
              {doc.otherCopies > 0 && (
                <p className="learned__meta">
                  Added {String(doc.otherCopies + 1)} times — every copy is forgotten together.
                </p>
              )}
              {confirming === doc.id ? (
                <div
                  className="settings__confirm"
                  role="alert"
                  data-testid="forget-confirm"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancel();
                    }
                  }}
                >
                  {forgetConfirmText(doc).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  <div className="settings__actions">
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => void forget(doc)}
                    >
                      Forget it
                    </button>
                    <button type="button" className="button" ref={keepButton} onClick={cancel}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : doc.verdict.allowed ? (
                <div className="settings__actions">
                  <button
                    id={`forget-${doc.id}`}
                    type="button"
                    className="button button--small"
                    disabled={busy !== null}
                    aria-label={`Forget ${doc.name}`}
                    onClick={() => {
                      returnTo.current = doc.id;
                      setNotice(null);
                      setConfirming(doc.id);
                    }}
                  >
                    {busy === doc.id ? 'Forgetting…' : 'Forget'}
                  </button>
                </div>
              ) : (
                <p className="learned__denied">{doc.deniedReason}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {load.kind === 'ready' && (
        <SettingsPager
          label="Learned documents"
          page={page}
          size={DOCUMENTS_PAGE_SIZE}
          total={load.total}
          shown={docs.length}
          busy={busy !== null}
          onPage={(next) => {
            setConfirming(null);
            setPage(next);
          }}
        />
      )}
    </section>
  );
}
