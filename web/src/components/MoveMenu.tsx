/**
 * The plain "move to stage" control (Milestone 4 part 4, fixed decision 2): a native
 * <select> listing the pipeline's live stages, on every card and in the lead detail. Not a
 * fallback for the drag — on a phone it is the control the client will actually use (the
 * iOS picker, one tap), and it is the only way a keyboard or a screen reader can move a
 * lead. Picking a stage IS the confirmation (D81): no dialog.
 *
 * Controlled by the parent: the value is the lead's current stage, and a pick calls
 * `onMove` once. While a move is saving the control is disabled, so a second pick — a
 * double-tap, an impatient re-pick — is one move, not two. 16px so iOS Safari does not zoom.
 */
import type { ReactElement } from 'react';

import type { StageOption } from '../lib/leadDetailView.js';
import { moveControlLabel } from '../lib/moveView.js';

interface Props {
  readonly name: string;
  readonly stageId: string;
  readonly options: readonly StageOption[];
  readonly disabled: boolean;
  readonly onMove: (toStageId: string) => void;
  /** Smaller, for a card; the detail uses the full field. */
  readonly compact?: boolean;
  readonly id?: string;
}

export function MoveMenu({
  name,
  stageId,
  options,
  disabled,
  onMove,
  compact = false,
  id,
}: Props): ReactElement {
  // A stage the pipeline no longer lists (removed / unknown) is shown as the current choice
  // so the control never lies about where the lead is; every live stage is a target.
  const listed = options.some((o) => o.stageId === stageId);
  return (
    <label className={`move${compact ? ' move--compact' : ''}`}>
      <span className="sr-only">{moveControlLabel(name)}</span>
      <select
        id={id}
        className="field__input move__select"
        value={stageId}
        disabled={disabled}
        aria-busy={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next !== '' && next !== stageId) onMove(next);
        }}
      >
        {!listed && <option value={stageId}>Current stage (not in the pipeline)</option>}
        {options.map((o) => (
          <option key={o.stageId} value={o.stageId}>
            {String(o.number)}. {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
