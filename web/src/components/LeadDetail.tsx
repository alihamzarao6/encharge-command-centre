/**
 * The lead detail (Milestone 4 part 4): everything the mirror holds about one lead, laid out
 * to be read on a phone, with the control to move it and the notes. Replaces the part-3
 * placeholder at `/leads/<opportunity id>`.
 *
 * Every line traces to a column the part-1 sync wrote (web/src/lib/leadDetailView.ts says
 * which); a field GoHighLevel does not hold says "Not captured" — never a guess, never a
 * default (acceptance item 5). The move control is the same MoveMenu the cards carry; the
 * pick is the confirmation (D81), the screen moves the lead at once and says so, and a
 * failure says the lead is back where it was.
 *
 * NOTES write through to GoHighLevel as contact notes (Part A decision 4) and are listed
 * here newest first with who wrote each and when. A note that fails to save stays in the
 * box — the text is never lost — and the sentence says why.
 */
import type { ReactElement, SyntheticEvent } from 'react';

import { NOTE_MAX_LENGTH } from '../../../src/lib/crm/notes.js';
import type { LeadDetailState, LeadDetailView } from '../lib/leadDetailView.js';
import { NOT_CAPTURED, telHref } from '../lib/leadDetailView.js';
import { MoveMenu } from './MoveMenu.js';

export interface NoteDraftState {
  /** The text in the box; kept across a failure. */
  readonly text: string;
  readonly saving: boolean;
  /** A sentence to show under the box: why the last save failed, or that it saved. */
  readonly notice: { readonly tone: 'ok' | 'warn'; readonly text: string } | null;
}

interface Props {
  readonly opportunityId: string;
  readonly state: 'loading' | 'ready' | 'error';
  readonly detail: LeadDetailState | null;
  readonly onBack: () => void;
  readonly onRetry: () => void;
  /** Part 4: a stage pick. */
  readonly onMove: (fromStageId: string, toStageId: string) => void;
  readonly moving: boolean;
  /** The sentence for the last move, shown beside the stage. */
  readonly moveNotice: { readonly tone: 'ok' | 'warn'; readonly text: string } | null;
  /** Part 4: notes. */
  readonly note: NoteDraftState;
  readonly onNoteChange: (text: string) => void;
  readonly onNoteSubmit: () => void;
}

function Line({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): ReactElement {
  return (
    <div className="lead__line">
      <dt className="lead__label">{label}</dt>
      <dd className={`lead__value${value === null ? ' lead__value--none' : ''}`}>
        {value ?? NOT_CAPTURED}
      </dd>
    </div>
  );
}

function Ready({
  view,
  onMove,
  moving,
  moveNotice,
  note,
  onNoteChange,
  onNoteSubmit,
}: {
  readonly view: LeadDetailView;
} & Pick<
  Props,
  'onMove' | 'moving' | 'moveNotice' | 'note' | 'onNoteChange' | 'onNoteSubmit'
>): ReactElement {
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (note.saving) return;
    onNoteSubmit();
  };
  const remaining = NOTE_MAX_LENGTH - note.text.length;
  const canSave = note.text.trim() !== '' && remaining >= 0 && !note.saving;

  return (
    <>
      <div className="card lead__card">
        <h1 id="lead-title" className="overview__title lead__name">
          {view.name}
        </h1>
        <p className="muted lead__meta">
          <span>Arrived {view.arrived}</span>
          {view.inStageSince !== null && (
            <>
              <span aria-hidden="true"> · </span>
              <span>In this stage since {view.inStageSince}</span>
            </>
          )}
        </p>

        <div className="lead__stage">
          <label className="lead__stage-label" htmlFor="lead-stage">
            Stage
          </label>
          <div className="lead__stage-row">
            <span
              className={`lead__stage-now${view.stageKind === 'stage' ? '' : ' lt__td--odd'}`}
              data-stage-id={view.stageId}
            >
              {view.stageName}
            </span>
            {view.stageOptions.length > 0 && (
              <MoveMenu
                id="lead-stage"
                name={view.name}
                stageId={view.stageId}
                options={view.stageOptions}
                disabled={moving}
                onMove={(to) => {
                  onMove(view.stageId, to);
                }}
              />
            )}
            {moving && (
              <span className="lead__saving" role="status">
                Saving…
              </span>
            )}
          </div>
          {moveNotice !== null && (
            <p
              className={`lead__notice${moveNotice.tone === 'ok' ? ' lead__notice--ok' : ' notice'}`}
              data-tone={moveNotice.tone}
            >
              {moveNotice.text}
            </p>
          )}
        </div>
      </div>

      <section className="card lead__card" aria-labelledby="lead-contact">
        <h2 id="lead-contact" className="lead__h2">
          Contact
        </h2>
        {!view.contact.known && (
          <p className="notice">
            The contact behind this lead has not been synced from GoHighLevel. Refresh to read it.
          </p>
        )}
        {view.contact.known && (
          <dl className="lead__dl">
            <div className="lead__line">
              <dt className="lead__label">Phone</dt>
              <dd
                className={`lead__value${view.contact.phone === null ? ' lead__value--none' : ''}`}
              >
                {view.contact.phone === null ? (
                  NOT_CAPTURED
                ) : (
                  <a className="lead__link" href={telHref(view.contact.phone)}>
                    {view.contact.phone}
                  </a>
                )}
              </dd>
            </div>
            <div className="lead__line">
              <dt className="lead__label">Email</dt>
              <dd
                className={`lead__value${view.contact.email === null ? ' lead__value--none' : ''}`}
              >
                {view.contact.email === null ? (
                  NOT_CAPTURED
                ) : (
                  <a className="lead__link" href={`mailto:${view.contact.email}`}>
                    {view.contact.email}
                  </a>
                )}
              </dd>
            </div>
            {view.contact.dnd === true && (
              <div className="lead__line">
                <dt className="lead__label">Do not disturb</dt>
                <dd className="lead__value lead__value--warn">
                  On in GoHighLevel — this person asked not to be contacted
                </dd>
              </div>
            )}
            <Line label="Source" value={view.contact.source} />
            <Line
              label="Tags"
              value={view.contact.tags.length === 0 ? null : view.contact.tags.join(', ')}
            />
            <Line label="Contact added" value={view.contact.added} />
          </dl>
        )}
      </section>

      <section className="card lead__card" aria-labelledby="lead-answers">
        <h2 id="lead-answers" className="lead__h2">
          Form answers
        </h2>
        {!view.contact.known && (
          <p className="muted">Nothing to show until the contact is synced.</p>
        )}
        {view.contact.known && view.answers.length === 0 && (
          <p className="muted">No custom fields are mapped for this account.</p>
        )}
        {view.contact.known && view.answers.length > 0 && (
          <dl className="lead__dl">
            {view.answers.map((a) => (
              <div className="lead__line" key={a.fieldId} data-field-id={a.fieldId}>
                <dt className={`lead__label${a.unlabelled ? ' lead__label--id' : ''}`}>
                  {a.label}
                  {a.unlabelled && <span className="sr-only"> (field id)</span>}
                </dt>
                <dd className={`lead__value${a.value === null ? ' lead__value--none' : ''}`}>
                  {a.value ?? NOT_CAPTURED}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="card lead__card" aria-labelledby="lead-opportunity">
        <h2 id="lead-opportunity" className="lead__h2">
          Opportunity
        </h2>
        <dl className="lead__dl">
          {view.opportunity.map((line) => (
            <Line key={line.label} label={line.label} value={line.value} />
          ))}
        </dl>
        <p className="muted lead__ids">
          <span>Opportunity id {view.ids.opportunityId}</span>
          {view.ids.contactId !== null && (
            <>
              <span aria-hidden="true"> · </span>
              <span>Contact id {view.ids.contactId}</span>
            </>
          )}
        </p>
      </section>

      <section className="card lead__card" aria-labelledby="lead-notes">
        <h2 id="lead-notes" className="lead__h2">
          Notes
        </h2>
        <form className="lead__note-form" onSubmit={submit}>
          <label className="lead__note-label" htmlFor="lead-note">
            Latest update
          </label>
          <textarea
            id="lead-note"
            className="field__input lead__note-box"
            rows={3}
            placeholder="What happened? Saved to GoHighLevel as a note on the contact."
            value={note.text}
            maxLength={NOTE_MAX_LENGTH + 500}
            disabled={note.saving || !view.contact.known}
            onChange={(event) => {
              onNoteChange(event.currentTarget.value);
            }}
          />
          <div className="lead__note-row">
            <button
              type="submit"
              className="button button--primary"
              disabled={!canSave || !view.contact.known}
              aria-busy={note.saving}
            >
              {note.saving ? 'Saving…' : 'Add note'}
            </button>
            {remaining < 0 && (
              <span className="lead__note-count notice" role="status">
                {String(-remaining)} over the limit
              </span>
            )}
            {remaining >= 0 && remaining < 500 && (
              <span className="lead__note-count muted">{String(remaining)} left</span>
            )}
          </div>
          {!view.contact.known && (
            <p className="muted">A note needs the contact, which has not been synced yet.</p>
          )}
          {note.notice !== null && (
            <p
              className={`lead__notice${note.notice.tone === 'ok' ? ' lead__notice--ok' : ' notice'}`}
              role={note.notice.tone === 'ok' ? 'status' : 'alert'}
              data-tone={note.notice.tone}
            >
              {note.notice.text}
            </p>
          )}
        </form>
        {view.notes.length === 0 && <p className="muted">No notes from the app yet.</p>}
        {view.notes.length > 0 && (
          <ol className="lead__notes">
            {view.notes.map((n) => (
              <li key={n.id} className="lead__note" data-note-id={n.id}>
                <p className="lead__note-body">{n.body}</p>
                <p className="lead__note-meta muted">
                  <span className="lead__note-author">{n.author}</span>
                  <span aria-hidden="true"> · </span>
                  <time dateTime={n.at ?? undefined}>{n.when}</time>
                </p>
              </li>
            ))}
          </ol>
        )}
        <p className="muted lead__note-hint">
          Notes written directly in GoHighLevel are not shown here yet.
        </p>
      </section>
    </>
  );
}

export function LeadDetail({
  opportunityId,
  state,
  detail,
  onBack,
  onRetry,
  onMove,
  moving,
  moveNotice,
  note,
  onNoteChange,
  onNoteSubmit,
}: Props): ReactElement {
  const back = (
    <button type="button" className="button button--small lead__back" onClick={onBack}>
      ← Back to leads
    </button>
  );
  return (
    <section
      className="leads lead"
      aria-labelledby="lead-title"
      data-opportunity-id={opportunityId}
    >
      <div className="lead__bar">{back}</div>
      {state === 'loading' && detail === null && (
        <div className="card lead__card" aria-busy="true">
          <h1 id="lead-title" className="overview__title">
            Loading…
          </h1>
        </div>
      )}
      {state === 'error' && detail === null && (
        <div className="card lead__card" role="alert">
          <h1 id="lead-title" className="overview__title">
            Couldn&rsquo;t load this lead
          </h1>
          <p>The lead could not be read just now. Nothing is lost — try again.</p>
          <button className="button button--primary" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {detail?.kind === 'not-found' && (
        <div className="card lead__card">
          <h1 id="lead-title" className="overview__title">
            Not in the pipeline
          </h1>
          <p>
            No lead with this address is in the Finance Pipeline right now. It may never have been
            synced, or the link may be wrong.
          </p>
        </div>
      )}
      {detail?.kind === 'removed' && (
        <div className="card lead__card">
          <h1 id="lead-title" className="overview__title">
            {detail.name}
          </h1>
          <p className="notice">
            This lead is no longer in the Finance Pipeline in GoHighLevel — it was deleted, or moved
            to another pipeline. Nothing here can be changed.
          </p>
        </div>
      )}
      {detail?.kind === 'ready' && (
        <Ready
          view={detail}
          onMove={onMove}
          moving={moving}
          moveNotice={moveNotice}
          note={note}
          onNoteChange={onNoteChange}
          onNoteSubmit={onNoteSubmit}
        />
      )}
    </section>
  );
}
