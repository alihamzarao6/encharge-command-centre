/**
 * Dragging a card between columns (Milestone 4 part 4), with Pointer Events and no library
 * (Part A: dnd-kit and pragmatic-drag-and-drop were considered; one list-to-list move does
 * not need a first UI dependency). Framework-free so it is testable by attaching it to a
 * plain element; Board.tsx attaches it to each card in an effect.
 *
 * How a drag begins depends on the pointer. A mouse drags after 6px of movement. A finger
 * needs a 300 ms press-and-hold first, because on a phone the same gesture is how the board
 * is swiped sideways — a finger that moves before the hold is a scroll, and the drag never
 * starts. A drag can also be cancelled with Escape or by the browser (pointercancel), and a
 * card released outside every column is a cancel, not a drop.
 *
 * What it does NOT do: change any data. It reports `onDrop(opportunityId, stageId)` and the
 * board decides. It does not move the real card either — a ghost copy follows the pointer,
 * the real card dims in place, and React re-renders the columns when the board says so. The
 * ghost's short snap on drop is skipped when the person prefers reduced motion.
 *
 * The move control (a <select>) inside a card is never a drag handle: a press on it is left
 * to the control. A click that follows a real drag is swallowed so the drop does not also
 * open the lead.
 */
export interface DragHandlers {
  readonly onDragStart: (opportunityId: string) => void;
  readonly onDragOver: (opportunityId: string, stageId: string | null) => void;
  readonly onDrop: (opportunityId: string, stageId: string | null) => void;
  readonly onDragCancel: (opportunityId: string) => void;
}

export interface DragOptions {
  readonly opportunityId: string;
  /** Asked at pointerdown: false while a move is saving, so a second drag never begins. */
  readonly enabled: () => boolean;
  readonly handlers: DragHandlers;
  /** Press-and-hold before a touch drag begins. */
  readonly holdMs?: number;
  /** Pointer travel before a mouse drag begins, or a touch hold is abandoned as a scroll. */
  readonly thresholdPx?: number;
  readonly reducedMotion?: () => boolean;
  /** Used for the target hit test and the edge auto-scroll; defaults to the document. */
  readonly document?: Document;
}

export const DRAG_HOLD_MS = 300;
export const DRAG_THRESHOLD_PX = 6;
export const DRAG_SNAP_MS = 150;
/** Pixels from the board's edge within which dragging scrolls it sideways. */
const EDGE_PX = 48;
const EDGE_STEP_PX = 14;

export const GHOST_CLASS = 'lead-card--ghost';
export const DRAGGING_CLASS = 'lead-card--dragging';
export const OVER_CLASS = 'board__col--over';

/** Selectors that are controls in their own right: a press on them never starts a drag. */
const CONTROL = 'select, button, input, textarea, option, label';

/** The stage id under a point, or null when the point is not over any column's list. */
export function dropTargetAt(doc: Document, x: number, y: number): string | null {
  const stack = doc.elementsFromPoint(x, y);
  for (const element of stack) {
    if (element.classList.contains(GHOST_CLASS)) continue;
    const target = element.closest<HTMLElement>('[data-drop-target]');
    if (target !== null) return target.dataset['dropTarget'] ?? null;
    const column = element.closest<HTMLElement>('[data-stage-id]');
    if (column !== null) return column.dataset['stageId'] ?? null;
  }
  return null;
}

function columnFor(doc: Document, stageId: string | null): HTMLElement | null {
  if (stageId === null) return null;
  const columns = Array.from(doc.querySelectorAll<HTMLElement>('[data-stage-id]'));
  return columns.find((c) => c.dataset['stageId'] === stageId) ?? null;
}

export function attachDrag(card: HTMLElement, options: DragOptions): () => void {
  const doc = options.document ?? card.ownerDocument;
  const holdMs = options.holdMs ?? DRAG_HOLD_MS;
  const threshold = options.thresholdPx ?? DRAG_THRESHOLD_PX;
  const { opportunityId, handlers } = options;

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let armed = false;
  let dragging = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let edgeTimer: ReturnType<typeof setInterval> | null = null;
  let ghost: HTMLElement | null = null;
  let ghostLeft = 0;
  let ghostTop = 0;
  let overStage: string | null = null;
  let overColumn: HTMLElement | null = null;
  let lastX = 0;
  let lastY = 0;
  let suppressClick = false;
  let snapWas: string | null = null;

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  };
  const clearEdge = (): void => {
    if (edgeTimer !== null) clearInterval(edgeTimer);
    edgeTimer = null;
  };

  const setOver = (stageId: string | null): void => {
    if (stageId === overStage) return;
    overColumn?.classList.remove(OVER_CLASS);
    overStage = stageId;
    overColumn = columnFor(doc, stageId);
    overColumn?.classList.add(OVER_CLASS);
    handlers.onDragOver(opportunityId, stageId);
  };

  const positionGhost = (x: number, y: number): void => {
    if (ghost === null) return;
    ghost.style.transform = `translate(${String(x - startX)}px, ${String(y - startY)}px)`;
  };

  const removeGhost = (snapTo: HTMLElement | null): void => {
    const g = ghost;
    ghost = null;
    if (g === null) return;
    const reduced = options.reducedMotion?.() ?? false;
    if (snapTo === null || reduced) {
      g.remove();
      return;
    }
    // The ghost sits at the card's original box and is moved by a transform; snapping it to
    // the target is one more transform relative to that box.
    const rect = snapTo.getBoundingClientRect();
    g.style.transition = `transform ${String(DRAG_SNAP_MS)}ms ease-out, opacity ${String(DRAG_SNAP_MS)}ms ease-out`;
    g.style.opacity = '0';
    g.style.transform = `translate(${String(rect.left - ghostLeft)}px, ${String(rect.top - ghostTop)}px)`;
    setTimeout(() => {
      g.remove();
    }, DRAG_SNAP_MS + 20);
  };

  const scrollEdges = (): void => {
    const board = card.closest<HTMLElement>('.board');
    if (board === null) return;
    const rect = board.getBoundingClientRect();
    if (lastX < rect.left + EDGE_PX) board.scrollBy({ left: -EDGE_STEP_PX });
    else if (lastX > rect.right - EDGE_PX) board.scrollBy({ left: EDGE_STEP_PX });
  };

  const finish = (): void => {
    clearHold();
    clearEdge();
    overColumn?.classList.remove(OVER_CLASS);
    overColumn = null;
    overStage = null;
    card.classList.remove(DRAGGING_CLASS);
    doc.body.classList.remove('is-dragging');
    if (snapWas !== null) {
      const board = card.closest<HTMLElement>('.board');
      if (board !== null) board.style.scrollSnapType = snapWas;
      snapWas = null;
    }
    if (pointerId !== null && card.hasPointerCapture(pointerId)) {
      card.releasePointerCapture(pointerId);
    }
    pointerId = null;
    armed = false;
    dragging = false;
    doc.removeEventListener('keydown', onKey);
  };

  const begin = (x: number, y: number): void => {
    dragging = true;
    suppressClick = true;
    if (pointerId !== null) card.setPointerCapture(pointerId);
    const rect = card.getBoundingClientRect();
    const g = card.cloneNode(true) as HTMLElement;
    g.classList.add(GHOST_CLASS);
    g.classList.remove(DRAGGING_CLASS);
    g.setAttribute('aria-hidden', 'true');
    ghostLeft = rect.left;
    ghostTop = rect.top;
    g.style.position = 'fixed';
    g.style.left = `${String(rect.left)}px`;
    g.style.top = `${String(rect.top)}px`;
    g.style.width = `${String(rect.width)}px`;
    g.style.pointerEvents = 'none';
    g.style.zIndex = '1000';
    doc.body.appendChild(g);
    ghost = g;
    card.classList.add(DRAGGING_CLASS);
    doc.body.classList.add('is-dragging');
    // Scroll-snap fights the edge auto-scroll (every step snaps back to a column start), so
    // it is off for the duration of the drag and restored on release.
    const board = card.closest<HTMLElement>('.board');
    if (board !== null) {
      snapWas = board.style.scrollSnapType;
      board.style.scrollSnapType = 'none';
    }
    handlers.onDragStart(opportunityId);
    positionGhost(x, y);
    setOver(dropTargetAt(doc, x, y));
    edgeTimer = setInterval(scrollEdges, 50);
  };

  const cancel = (): void => {
    const was = dragging;
    removeGhost(card);
    finish();
    if (was) handlers.onDragCancel(opportunityId);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && pointerId !== null) cancel();
  };

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || pointerId !== null) return;
    if (!options.enabled()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target !== null && target.closest(CONTROL) !== null) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    lastX = startX;
    lastY = startY;
    suppressClick = false;
    doc.addEventListener('keydown', onKey);
    if (event.pointerType === 'mouse') {
      armed = true;
    } else {
      armed = false;
      holdTimer = setTimeout(() => {
        holdTimer = null;
        armed = true;
        begin(lastX, lastY);
      }, holdMs);
    }
  };

  const onMove = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    lastX = event.clientX;
    lastY = event.clientY;
    const travelled = Math.hypot(lastX - startX, lastY - startY);
    if (!dragging) {
      if (armed) {
        if (travelled >= threshold) begin(lastX, lastY);
      } else if (travelled >= threshold + 2) {
        // A finger that moves before the hold is a scroll: let the board have it.
        clearHold();
        finish();
      }
      return;
    }
    event.preventDefault();
    positionGhost(lastX, lastY);
    setOver(dropTargetAt(doc, lastX, lastY));
  };

  const onUp = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    if (!dragging) {
      finish();
      return;
    }
    const stageId = dropTargetAt(doc, event.clientX, event.clientY);
    removeGhost(columnFor(doc, stageId) ?? card);
    finish();
    handlers.onDrop(opportunityId, stageId);
  };

  const onCancel = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    cancel();
  };

  const onClick = (event: MouseEvent): void => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  // An <a> is natively draggable: without this Chrome starts an HTML5 drag on the link and
  // cancels the pointer events mid-gesture (observed in the browser suite).
  const onNativeDrag = (event: Event): void => {
    event.preventDefault();
  };
  card.addEventListener('dragstart', onNativeDrag);
  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onCancel);
  card.addEventListener('click', onClick, true);

  return () => {
    cancel();
    card.removeEventListener('dragstart', onNativeDrag);
    card.removeEventListener('pointerdown', onDown);
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerup', onUp);
    card.removeEventListener('pointercancel', onCancel);
    card.removeEventListener('click', onClick, true);
  };
}
