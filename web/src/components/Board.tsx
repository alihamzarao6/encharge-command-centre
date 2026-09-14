/**
 * The pipeline board (Milestone 4 part 3): one column per stage in the pipeline's own order,
 * the count in every heading, an empty column shown rather than hidden, and a card per lead,
 * newest first. The board scrolls sideways inside its own box and each column scrolls its
 * own cards; the page never scrolls.
 *
 * DRAG-READY, NOTHING DRAGS. Each column's list carries `data-stage-id` and
 * `data-drop-target`, each card `data-opportunity-id`, and React keys are the GoHighLevel
 * ids — so part 4 can add the drag, the plain "move to stage" control the phone and the
 * keyboard need, and the write to GoHighLevel behind both, without changing the shapes here.
 * There is deliberately no control on a card that could change a stage in this part.
 *
 * A stage is distinguishable without colour: its number and its name are in the heading, and
 * a removed or unknown stage says so in words.
 */
import { useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';

import {
  PAGE_SIZE,
  filterLeads,
  type Lead,
  type LeadFilter,
  type StageColumn,
} from '../lib/leadsView.js';
import { formatCount } from '../lib/overviewView.js';
import { leadsPath } from '../lib/routes.js';

interface Props {
  readonly columns: readonly StageColumn[];
  readonly filter: LeadFilter;
  readonly total: number;
  readonly onOpen: (opportunityId: string) => void;
  readonly onClear: () => void;
}

/** A plain link (Back, middle-click and "copy address" all work); a left click stays in-app. */
export function leadLinkProps(
  opportunityId: string,
  onOpen: (opportunityId: string) => void,
): { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void } {
  return {
    href: leadsPath({ kind: 'lead', opportunityId }),
    onClick: (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(opportunityId);
    },
  };
}

export function LeadCard({
  lead,
  onOpen,
}: {
  readonly lead: Lead;
  readonly onOpen: (opportunityId: string) => void;
}): ReactElement {
  const noDetails = lead.email === null && lead.phone === null;
  return (
    <a className="lead-card" {...leadLinkProps(lead.opportunityId, onOpen)}>
      <span className="lead-card__name">{lead.name}</span>
      <span className="lead-card__meta muted">
        <span className="lead-card__when">{lead.arrived}</span>
        {lead.loanBalance !== null && (
          <>
            <span aria-hidden="true"> · </span>
            <span className="lead-card__balance">
              <span className="sr-only">loan balance </span>
              {lead.loanBalance}
            </span>
          </>
        )}
      </span>
      {!lead.contactKnown && <span className="lead-card__flag">contact details not synced</span>}
      {lead.contactKnown && noDetails && (
        <span className="lead-card__flag">no phone or email on file</span>
      )}
    </a>
  );
}

function Column({
  column,
  filter,
  onOpen,
}: {
  readonly column: StageColumn;
  readonly filter: LeadFilter;
  readonly onOpen: (opportunityId: string) => void;
}): ReactElement {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const filtering = filter.query.trim() !== '' || filter.stageId !== null;
  const leads = filtering ? filterLeads(column.leads, filter) : column.leads;
  const shown = leads.slice(0, limit);
  const headingId = `col-${column.stageId}`;
  return (
    <section
      className={`board__col${column.kind === 'stage' ? '' : ' board__col--odd'}`}
      aria-labelledby={headingId}
      data-stage-id={column.stageId}
    >
      <h2 id={headingId} className="board__head">
        {column.number !== null && (
          <span className="board__num" aria-hidden="true">
            {column.number}
          </span>
        )}
        <span className="board__name">
          {column.number !== null && <span className="sr-only">Stage {column.number}: </span>}
          {column.name}
          {column.kind === 'unknown-stage' && (
            <span className="sr-only"> — stage id {column.stageId}</span>
          )}
        </span>
        <span className="board__count">
          {filtering && leads.length !== column.leads.length
            ? `${formatCount(leads.length)} of ${formatCount(column.leads.length)}`
            : formatCount(column.leads.length)}
          <span className="sr-only"> lead{column.leads.length === 1 ? '' : 's'}</span>
        </span>
      </h2>
      <ol className="board__cards" data-drop-target={column.stageId}>
        {shown.map((lead) => (
          <li
            key={lead.opportunityId}
            className="board__item"
            data-opportunity-id={lead.opportunityId}
          >
            <LeadCard lead={lead} onOpen={onOpen} />
          </li>
        ))}
      </ol>
      {leads.length === 0 && (
        <p className="board__empty muted">{filtering ? 'No matches' : 'No leads'}</p>
      )}
      {leads.length > shown.length && (
        <button
          type="button"
          className="button button--small board__more"
          onClick={() => {
            setLimit((n) => n + PAGE_SIZE);
          }}
        >
          Show {formatCount(Math.min(PAGE_SIZE, leads.length - shown.length))} more
        </button>
      )}
    </section>
  );
}

export function Board({ columns, filter, total, onOpen, onClear }: Props): ReactElement {
  const filtering = filter.query.trim() !== '' || filter.stageId !== null;
  const matching = filtering
    ? columns.reduce((n, c) => n + filterLeads(c.leads, filter).length, 0)
    : total;
  // Arrow keys move between columns when the board itself has focus, for a keyboard user
  // who would otherwise tab through every card to reach the tenth stage.
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    event.currentTarget.scrollBy({ left: event.key === 'ArrowRight' ? 280 : -280 });
  };
  return (
    <div className="leads__body">
      {total === 0 && (
        <p className="muted leads__hint" role="status">
          No open leads in the pipeline right now.
        </p>
      )}
      {filtering && matching === 0 && total > 0 && (
        <p className="leads__hint" role="status">
          No leads match.{' '}
          <button type="button" className="link" onClick={onClear}>
            Clear the search
          </button>
        </p>
      )}
      <div
        className="board"
        role="region"
        aria-label="Pipeline board"
        tabIndex={0}
        onKeyDown={onKey}
      >
        {columns.map((column) => (
          <Column key={column.stageId} column={column} filter={filter} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
