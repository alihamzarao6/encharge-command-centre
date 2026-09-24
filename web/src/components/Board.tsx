/**
 * The pipeline board (Milestone 4 part 3): one column per stage in the pipeline's own order,
 * the count in every heading, an empty column shown rather than hidden, and a card per lead,
 * newest first. The board scrolls sideways inside its own box and each column scrolls its
 * own cards; the page never scrolls.
 *
 * PART 4: A CARD MOVES. Two ways, neither a fallback (fixed decision 2): drag a card into
 * another column (web/src/lib/drag.ts — Pointer Events, no library; a mouse drags after 6px,
 * a finger after a 300 ms hold so the board can still be swiped), or pick a stage from the
 * "Move to" control on the card (MoveMenu — keyboard, screen reader and the iOS picker). The
 * drop or the pick is the confirmation (D81). Both call one `onMove`; the screen (Leads.tsx)
 * moves the card at once, sends the write, and puts it back in words if it fails.
 *
 * While ONE move is saving the board refuses a second: the saving card is marked and its
 * control disabled, every other card's drag is refused with a sentence, and a card dropped
 * back into its own column or outside every column is no move at all. The column a drag is
 * over is highlighted by the drag helper (`board__col--over`), never by React state.
 *
 * A stage is distinguishable without colour: its number and its name are in the heading, and
 * a removed or unknown stage says so in words.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';

import { attachDrag } from '../lib/drag.js';
import type { StageOption } from '../lib/leadDetailView.js';
import {
  PAGE_SIZE,
  filterLeads,
  type Lead,
  type LeadFilter,
  type StageColumn,
} from '../lib/leadsView.js';
import { formatCount } from '../lib/overviewView.js';
import { leadsPath } from '../lib/routes.js';
import { MoveMenu } from './MoveMenu.js';

export interface MoveInFlight {
  readonly opportunityId: string;
  readonly toStageId: string;
}

interface Props {
  readonly columns: readonly StageColumn[];
  readonly filter: LeadFilter;
  readonly total: number;
  readonly onOpen: (opportunityId: string) => void;
  readonly onClear: () => void;
  /** Part 4: the live stages for the move control; empty when moves are not possible. */
  readonly stageOptions: readonly StageOption[];
  /** Part 4: a drop or a pick. `fromStageId` is the stage the card was shown in. */
  readonly onMove: (
    opportunityId: string,
    fromStageId: string,
    toStageId: string,
    via: 'drag' | 'menu',
  ) => void;
  /** The one move saving right now, or null. */
  readonly moving: MoveInFlight | null;
  /** A gesture refused because a move is in flight; the screen says so. */
  readonly onBusy: () => void;
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

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface CardProps {
  readonly lead: Lead;
  readonly onOpen: (opportunityId: string) => void;
  readonly stageOptions: readonly StageOption[];
  readonly onMove: Props['onMove'];
  readonly saving: boolean;
  readonly locked: boolean;
  readonly onBusy: () => void;
}

export function LeadCard({
  lead,
  onOpen,
  stageOptions,
  onMove,
  saving,
  locked,
  onBusy,
}: CardProps): ReactElement {
  const noDetails = lead.email === null && lead.phone === null;
  const ref = useRef<HTMLDivElement>(null);
  // The handlers change on every render; the drag helper reads the latest through a ref so
  // it is attached once per card, not once per render.
  const latest = useRef({ onMove, onBusy, locked, stageId: lead.stageId });
  latest.current = { onMove, onBusy, locked, stageId: lead.stageId };

  useEffect(() => {
    const card = ref.current;
    if (card === null || stageOptions.length === 0) return;
    return attachDrag(card, {
      opportunityId: lead.opportunityId,
      enabled: () => {
        if (latest.current.locked) {
          latest.current.onBusy();
          return false;
        }
        return true;
      },
      reducedMotion: prefersReducedMotion,
      handlers: {
        onDragStart: () => undefined,
        onDragOver: () => undefined,
        onDragCancel: () => undefined,
        onDrop: (id, stageId) => {
          // Outside every column, or back where it came from: no move, no request.
          if (stageId === null || stageId === latest.current.stageId) return;
          latest.current.onMove(id, latest.current.stageId, stageId, 'drag');
        },
      },
    });
  }, [lead.opportunityId, stageOptions.length]);

  return (
    <div
      ref={ref}
      className={`lead-card${saving ? ' lead-card--saving' : ''}`}
      aria-busy={saving}
      data-saving={saving ? 'true' : undefined}
    >
      <a
        className="lead-card__link"
        draggable={false}
        {...leadLinkProps(lead.opportunityId, onOpen)}
      >
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
      {stageOptions.length > 0 && (
        <div className="lead-card__foot">
          <MoveMenu
            compact
            name={lead.name}
            stageId={lead.stageId}
            options={stageOptions}
            disabled={locked}
            onMove={(to) => {
              onMove(lead.opportunityId, lead.stageId, to, 'menu');
            }}
          />
          {saving && (
            <span className="lead-card__saving" role="status">
              Saving…
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Column({
  column,
  filter,
  onOpen,
  stageOptions,
  onMove,
  moving,
  onBusy,
}: {
  readonly column: StageColumn;
  readonly filter: LeadFilter;
  readonly onOpen: (opportunityId: string) => void;
  readonly stageOptions: readonly StageOption[];
  readonly onMove: Props['onMove'];
  readonly moving: MoveInFlight | null;
  readonly onBusy: () => void;
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
            <LeadCard
              lead={lead}
              onOpen={onOpen}
              stageOptions={stageOptions}
              onMove={onMove}
              saving={moving?.opportunityId === lead.opportunityId}
              locked={moving !== null}
              onBusy={onBusy}
            />
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

export function Board({
  columns,
  filter,
  total,
  onOpen,
  onClear,
  stageOptions,
  onMove,
  moving,
  onBusy,
}: Props): ReactElement {
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
        className={`board${moving !== null ? ' board--busy' : ''}`}
        role="region"
        aria-label="Pipeline board"
        tabIndex={0}
        onKeyDown={onKey}
      >
        {columns.map((column) => (
          <Column
            key={column.stageId}
            column={column}
            filter={filter}
            onOpen={onOpen}
            stageOptions={stageOptions}
            onMove={onMove}
            moving={moving}
            onBusy={onBusy}
          />
        ))}
      </div>
    </div>
  );
}
