/**
 * The lead detail surface (Milestone 4 part 3, fixed decision 3): the address every card and
 * row opens, `/leads/<opportunity id>`, filled here with what this part already knows about
 * the lead and an honest note that the rest arrives in the next part. Not a half-built
 * detail view, and not a page that looks broken: the name, the stage and the arrival are
 * real, the sentence says what is coming, and Back returns to the view the lead was opened
 * from.
 *
 * Part 4 replaces the body with the contact, the opportunity and the form's answers field by
 * field, and the move-to-stage control.
 */
import type { ReactElement } from 'react';

import type { LeadsView } from '../lib/leadsView.js';

interface Props {
  readonly opportunityId: string;
  readonly state: 'loading' | 'ready' | 'error';
  readonly view: LeadsView | null;
  readonly onBack: () => void;
  readonly onRetry: () => void;
}

export function LeadDetail({ opportunityId, state, view, onBack, onRetry }: Props): ReactElement {
  const lead = view?.leads.find((l) => l.opportunityId === opportunityId) ?? null;
  const back = (
    <button type="button" className="button button--small lead__back" onClick={onBack}>
      ← Back to leads
    </button>
  );
  return (
    <section className="leads lead" aria-labelledby="lead-title">
      <div className="lead__bar">{back}</div>
      {state === 'loading' && view === null && (
        <div className="card lead__card" aria-busy="true">
          <h1 id="lead-title" className="overview__title">
            Loading…
          </h1>
        </div>
      )}
      {state === 'error' && view === null && (
        <div className="card lead__card" role="alert">
          <h1 id="lead-title" className="overview__title">
            Couldn&rsquo;t load this lead
          </h1>
          <p>The leads could not be read just now. Nothing is lost — try again.</p>
          <button className="button button--primary" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {view !== null && lead === null && (
        <div className="card lead__card">
          <h1 id="lead-title" className="overview__title">
            Not in the pipeline
          </h1>
          <p>
            No open lead with this address is in the Finance Pipeline right now. It may have been
            closed or removed in GoHighLevel since the last refresh, or the link may be wrong.
          </p>
        </div>
      )}
      {lead !== null && (
        <div className="card lead__card">
          <h1 id="lead-title" className="overview__title lead__name">
            {lead.name}
          </h1>
          <p className="muted lead__meta">
            <span className={lead.stageKind === 'stage' ? '' : 'lt__td--odd'}>
              {lead.stageName}
            </span>
            <span aria-hidden="true"> · </span>
            <span>Arrived {lead.arrived}</span>
          </p>
          {lead.loanBalance !== null && (
            <p className="lead__line">
              <span className="lead__label">Loan balance</span> {lead.loanBalance}
            </p>
          )}
          {lead.interestRate !== null && (
            <p className="lead__line">
              <span className="lead__label">Interest rate</span> {lead.interestRate}
            </p>
          )}
          <p className="notice lead__next" role="status">
            <strong>Lead detail is coming in the next part of this milestone.</strong> The contact,
            the opportunity and the form&rsquo;s answers will be here, field by field, with the
            control to move this lead to another stage. Nothing is broken — this screen is simply
            not built yet.
          </p>
        </div>
      )}
    </section>
  );
}
