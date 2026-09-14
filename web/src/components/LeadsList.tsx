/**
 * The leads list (Milestone 4 part 3): one row per lead, sortable and searchable, readable at
 * 375. The list exists to answer "where is that person" (search, the stage column and
 * filter) and "who came in this week" (newest first by default).
 *
 * A real table from 768 up, with the header buttons carrying `aria-sort`. At 375 the same
 * DOM stacks: each row becomes a block, the header row is hidden and every cell is labelled
 * by CSS from `data-label`; the explicit table roles keep it a table for a screen reader once
 * `display` stops being `table`. The sort select in the controls drives the same state.
 *
 * Rows render 100 at a time ("Show more"): the read is capped at 2,000 rows and a phone
 * should not lay out 2,000 rows to show the first ten. Past the cap the query must page —
 * stated in the report.
 */
import { useState, type ReactElement } from 'react';

import { PAGE_SIZE, type Lead, type LeadFilter, type LeadSort } from '../lib/leadsView.js';
import { formatCount } from '../lib/overviewView.js';
import { leadLinkProps } from './Board.js';

interface Props {
  readonly leads: readonly Lead[];
  readonly total: number;
  readonly filter: LeadFilter;
  readonly sort: LeadSort;
  readonly onSort: (sort: LeadSort) => void;
  readonly onOpen: (opportunityId: string) => void;
  readonly onClear: () => void;
}

type Column = 'name' | 'stage' | 'arrived';

function ariaSort(column: Column, sort: LeadSort): 'ascending' | 'descending' | 'none' {
  switch (column) {
    case 'name':
      return sort === 'name' ? 'ascending' : 'none';
    case 'stage':
      return sort === 'stage' ? 'ascending' : 'none';
    case 'arrived':
      return sort === 'newest' ? 'descending' : sort === 'oldest' ? 'ascending' : 'none';
  }
}

function nextSort(column: Column, sort: LeadSort): LeadSort {
  switch (column) {
    case 'name':
      return 'name';
    case 'stage':
      return 'stage';
    case 'arrived':
      return sort === 'newest' ? 'oldest' : 'newest';
  }
}

function Header({
  column,
  label,
  sort,
  onSort,
}: {
  readonly column: Column;
  readonly label: string;
  readonly sort: LeadSort;
  readonly onSort: (sort: LeadSort) => void;
}): ReactElement {
  const state = ariaSort(column, sort);
  return (
    <th role="columnheader" scope="col" aria-sort={state} className="lt__th">
      <button
        type="button"
        className={`lt__sort${state === 'none' ? '' : ' lt__sort--on'}`}
        onClick={() => {
          onSort(nextSort(column, sort));
        }}
      >
        {label}
        {state !== 'none' && (
          <span className="lt__arrow" aria-hidden="true">
            {state === 'ascending' ? ' ↑' : ' ↓'}
          </span>
        )}
      </button>
    </th>
  );
}

export function LeadsList({
  leads,
  total,
  filter,
  sort,
  onSort,
  onOpen,
  onClear,
}: Props): ReactElement {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const filtering = filter.query.trim() !== '' || filter.stageId !== null;
  const shown = leads.slice(0, limit);
  return (
    <div className="leads__body leads__body--list">
      {total === 0 && (
        <p className="muted leads__hint" role="status">
          No open leads in the pipeline right now.
        </p>
      )}
      {filtering && leads.length === 0 && total > 0 && (
        <p className="leads__hint" role="status">
          No leads match.{' '}
          <button type="button" className="link" onClick={onClear}>
            Clear the search
          </button>
        </p>
      )}
      {shown.length > 0 && (
        <div className="card lt__card">
          <table className="lt" role="table">
            <thead role="rowgroup" className="lt__head">
              <tr role="row">
                <Header column="name" label="Name" sort={sort} onSort={onSort} />
                <Header column="stage" label="Stage" sort={sort} onSort={onSort} />
                <Header column="arrived" label="Arrived" sort={sort} onSort={onSort} />
                <th role="columnheader" scope="col" className="lt__th">
                  Phone
                </th>
                <th role="columnheader" scope="col" className="lt__th">
                  Email
                </th>
                <th role="columnheader" scope="col" className="lt__th">
                  Loan balance
                </th>
                <th role="columnheader" scope="col" className="lt__th">
                  Rate
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {shown.map((lead) => (
                <tr
                  key={lead.opportunityId}
                  role="row"
                  className="lt__row"
                  data-opportunity-id={lead.opportunityId}
                >
                  <td role="cell" className="lt__td lt__td--name" data-label="Name">
                    <a className="lt__link" {...leadLinkProps(lead.opportunityId, onOpen)}>
                      {lead.name}
                    </a>
                    {!lead.contactKnown && (
                      <span className="lt__flag">contact details not synced</span>
                    )}
                  </td>
                  <td
                    role="cell"
                    className={`lt__td lt__td--stage${lead.stageKind === 'stage' ? '' : ' lt__td--odd'}`}
                    data-label="Stage"
                  >
                    {lead.stageName}
                  </td>
                  <td role="cell" className="lt__td lt__td--when" data-label="Arrived">
                    {lead.arrived}
                  </td>
                  <td role="cell" className="lt__td lt__td--labelled" data-label="Phone">
                    {lead.phone ?? <span className="lt__none">—</span>}
                  </td>
                  <td
                    role="cell"
                    className="lt__td lt__td--labelled lt__td--email"
                    data-label="Email"
                  >
                    {lead.email ?? <span className="lt__none">—</span>}
                  </td>
                  <td role="cell" className="lt__td lt__td--labelled" data-label="Loan balance">
                    {lead.loanBalance ?? <span className="lt__none">—</span>}
                  </td>
                  <td role="cell" className="lt__td lt__td--labelled" data-label="Rate">
                    {lead.interestRate ?? <span className="lt__none">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {leads.length > shown.length && (
            <div className="lt__more">
              <p className="muted">
                Showing {formatCount(shown.length)} of {formatCount(leads.length)}
              </p>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  setLimit((n) => n + PAGE_SIZE);
                }}
              >
                Show {formatCount(Math.min(PAGE_SIZE, leads.length - shown.length))} more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
