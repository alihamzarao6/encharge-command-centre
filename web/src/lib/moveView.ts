/**
 * Moving a lead, as the screen sees it (Milestone 4 part 4). Pure: the optimistic move over
 * the built view, the rollback, the one-at-a-time lock, and every sentence the board or the
 * detail says about a move — unit-tested without a browser.
 *
 * OPTIMISTIC WITH ROLLBACK (Part A decision 3): on a drop or a menu pick the card goes to
 * the new column at once and is marked "Saving…"; the server's answer either confirms it or
 * puts it back. A failed move must never look like a success, so every failure both moves
 * the card back AND says why in words.
 *
 * ONE MOVE IN FLIGHT AT A TIME. A second drag or pick while one is saving is refused with a
 * sentence rather than queued — that is also what makes a double-drop, a double-tap and a
 * drag released and repeated ONE move, not two. The request id is minted per gesture here
 * and sent with the move; the server keys the write on it.
 */
import type { CrmMoveReply, CrmOutcome } from './crmApi.js';
import { byNewest, type Lead, type LeadsView, type StageColumn } from './leadsView.js';

export interface PendingMove {
  readonly requestId: string;
  readonly opportunityId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  /** The lead exactly as it was, for the rollback. */
  readonly before: Lead;
}

/** A column's name for a stage id, in words a person would recognise. */
export function stageNameOf(view: LeadsView, stageId: string): string {
  const column = view.columns.find((c) => c.stageId === stageId);
  return column?.name ?? 'a stage not in the pipeline';
}

/**
 * The view with one lead shown in another stage — what the board renders the instant the
 * card is dropped, and what it keeps showing after a success until the re-read agrees. The
 * lead keeps its identity and its place in the newest-first order of its new column; nothing
 * else changes. Same stage in and out, or a stage the view does not list → the same view.
 * The ROLLBACK is dropping this override: the mirror's own view was never changed.
 */
export function applyMove(view: LeadsView, opportunityId: string, toStageId: string): LeadsView {
  const lead = view.leads.find((l) => l.opportunityId === opportunityId);
  if (lead === undefined || lead.stageId === toStageId) return view;
  const target = view.columns.find((c) => c.stageId === toStageId);
  if (target === undefined) return view;
  const moved: Lead = {
    ...lead,
    stageId: toStageId,
    stageName: target.name,
    stageKind: target.kind,
    stagePosition: target.number === null ? lead.stagePosition : Math.max(0, target.number - 1),
  };
  const columns: StageColumn[] = view.columns.map((c) => {
    if (c.stageId === lead.stageId) {
      return { ...c, leads: c.leads.filter((l) => l.opportunityId !== opportunityId) };
    }
    if (c.stageId === toStageId) {
      return { ...c, leads: [...c.leads, moved].sort(byNewest) };
    }
    return c;
  });
  return {
    ...view,
    leads: view.leads.map((l) => (l.opportunityId === opportunityId ? moved : l)),
    columns,
  };
}

export interface MoveMessage {
  readonly tone: 'ok' | 'warn';
  /** The sentence shown on screen, and read out by the live region. */
  readonly text: string;
  /** Re-read the mirror afterwards: the server said the world changed underneath. */
  readonly reread: boolean;
}

/**
 * What to say when the server answers. Written for the person holding the phone: the
 * lead's name, the stage in words, and — on any failure — that the lead is back where it
 * was. A 401 is the session, not GoHighLevel, and is handled by the caller before this.
 */
export function describeMoveOutcome(
  view: LeadsView,
  pending: PendingMove,
  outcome: CrmOutcome,
): MoveMessage {
  const name = pending.before.name;
  const to = stageNameOf(view, pending.toStageId);
  const from = stageNameOf(view, pending.fromStageId);
  if (outcome.kind === 'ok') {
    if (outcome.reply.action !== 'move') {
      return {
        tone: 'warn',
        text: `${name} was put back in ${from}: the answer was not a move.`,
        reread: true,
      };
    }
    return describeMoveReply(view, name, to, outcome.reply);
  }
  const back = `${name} is back in ${from}.`;
  switch (outcome.failure) {
    case 'refused':
    case 'unknown':
      return { tone: 'warn', text: `${outcome.message} ${back}`, reread: true };
    case 'failed':
    case 'retryable':
    case 'fatal':
    case 'cooldown':
    case 'running':
      return { tone: 'warn', text: `${outcome.message} ${back}`, reread: false };
    case 'forbidden':
      return { tone: 'warn', text: `${outcome.message} ${back}`, reread: false };
    case 'unauthenticated':
      return { tone: 'warn', text: `Your session has expired. ${back}`, reread: false };
  }
}

export function describeMoveReply(
  view: LeadsView,
  name: string,
  to: string,
  reply: CrmMoveReply,
): MoveMessage {
  const realFrom = stageNameOf(view, reply.fromStageId);
  if (!reply.changed) {
    return {
      tone: 'ok',
      text: `${name} was already in ${to} in GoHighLevel. Nothing to change.`,
      reread: reply.movedByOther,
    };
  }
  const parts: string[] = [`${name} moved to ${to}.`];
  if (reply.movedByOther) {
    parts.push(
      `Someone else had moved this lead to ${realFrom} since your screen loaded; it is now in ${to}.`,
    );
  }
  if (reply.landedAfterTimeout) {
    parts.push('GoHighLevel was slow to answer, but the move went through.');
  }
  if (!reply.mirrored) {
    parts.push('GoHighLevel has the change; this screen will catch up on the next refresh.');
  }
  return { tone: 'ok', text: parts.join(' '), reread: reply.movedByOther || !reply.mirrored };
}

/** The sentence for a gesture that is refused before any request. */
export const MOVE_BUSY = 'Wait for the current move to finish, then try again.';

/** "Move Alex Tran to…" — the accessible name of a card's move control. */
export function moveControlLabel(name: string): string {
  return `Move ${name} to another stage`;
}
