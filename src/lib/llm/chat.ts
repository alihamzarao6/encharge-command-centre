/**
 * One chat turn, server-side (Stage 2 part 4). Runtime-agnostic: the Supabase Edge Function
 * and the CLI runner both call `handleChatTurn` and map the returned status/body straight
 * onto their response. It never throws.
 *
 * Order matters, and each step is a gate the next one never runs without:
 *   1. verify the caller (part 3's verify.ts) — 401/403 before any database read for the
 *      cap and long before any Claude call: no spend on a stranger's request;
 *   2. validate the input (message length, conversation id shape);
 *   3. resolve or create the conversation — a user may continue a workspace-scoped
 *      conversation or their own private one, never another user's private one;
 *   4. load the earlier turns of THIS conversation (bounded, oldest first — TASKS 2.6.2a,
 *      part 6) so the second message remembers the first;
 *   5. call Claude (client.ts owns the cap, the retries and the api_usage row);
 *   6. write the user turn and the assistant turn to `messages` and touch the conversation.
 *
 * Stage 3 part 2 added step 4b: memory recall (facts + relevant earlier notes, and fact
 * capture on a "remember that…" message) goes BELOW the cache breakpoint as one uncached
 * system block, framed as data. It is on the reply's path because the context must be in
 * the request, but it is bounded by its own timeout and can only ever degrade to "no
 * memory this turn" — never to no reply. History is uncached input; the voice prefix stays
 * the cached part.
 *
 * An empty reply is an error, not a turn. Part 5 found Sonnet 5 spending the whole output
 * budget on adaptive thinking and returning no text (D39); the metered call is recorded by
 * client.ts, but nothing is saved to `messages` and the caller is told, so the interface
 * never renders a blank bubble.
 */
import { ensureError, type AppError, type Result } from '../errors.js';
import type { Logger } from '../logger.js';
import { verifyStaffAccess, type StaffIdentity, type VerifyDeps } from '../auth/verify.js';
import type { ClaudeClient, Completion, CompletionRequest, LlmError } from './client.js';
import type { TokenUsage } from './pricing.js';
import { buildSystemBlocks, type SystemBlock } from './prompt.js';
import type { RecallInput, RecallOutcome, RecallSummary } from '../memory/retrieve.js';

export interface ConversationRow {
  readonly id: string;
  readonly userId: string;
  readonly scope: 'user' | 'workspace';
  readonly title: string | null;
  readonly deletedAt: string | null;
}

/** One earlier turn of the current conversation, as sent back to Claude. */
export interface HistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * How much of the current conversation rides along with a turn. Both bounds apply; the
 * newest messages win. Characters, not tokens: the point is a hard ceiling on uncached
 * input that an operator can reason about, and the model's own context limit is far above
 * either default.
 */
export interface HistoryBounds {
  readonly maxMessages: number;
  readonly maxChars: number;
}

export const DEFAULT_HISTORY_BOUNDS: HistoryBounds = { maxMessages: 20, maxChars: 24_000 };

export interface AppendTurnInput {
  readonly conversation: ConversationRow;
  readonly userContent: string;
  readonly assistant: {
    readonly content: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface AppendedTurn {
  readonly userMessageId: string;
  readonly assistantMessageId: string;
}

export interface ConversationStore {
  get(conversationId: string): Promise<Result<ConversationRow | null>>;
  create(userId: string): Promise<Result<ConversationRow>>;
  /**
   * The last `limit` user/assistant messages of one conversation, OLDEST FIRST, content
   * only. Tool rows and null content are excluded at the source.
   */
  recentMessages(conversationId: string, limit: number): Promise<Result<readonly HistoryMessage[]>>;
  appendTurn(input: AppendTurnInput): Promise<Result<AppendedTurn>>;
}

export interface ChatDeps {
  readonly verify: VerifyDeps;
  readonly claude: ClaudeClient;
  readonly conversations: ConversationStore;
  readonly log: Logger;
  /** The system prompt; the argument is the recalled-memory block for below the breakpoint. */
  readonly systemBlocks?: (belowBreakpoint?: string) => readonly SystemBlock[];
  readonly maxMessageChars?: number;
  readonly history?: HistoryBounds;
  /**
   * Stage 3 part 2: what memory puts in front of Claude for this turn (facts, relevant
   * notes from earlier conversations, and the outcome of a "remember that…" request).
   * Runs ON the reply's path, before Claude, because the context has to be in the
   * request — but it is bounded by its own timeout, never throws, and a failure means
   * the turn goes without memory, not without a reply. Absent = no memory (no Voyage key).
   */
  readonly memory?: TurnMemory;
  /**
   * Stage 3 memory: runs after a turn is in `messages`, OFF the reply's path. It is
   * awaited by nobody here — its promise goes to `waitUntil` — and whatever it does or
   * fails to do cannot change the answer the user gets. Absent = no memory (no Voyage key).
   */
  readonly afterTurn?: (event: TurnSavedEvent) => Promise<void>;
  /**
   * Keeps background work alive after the response is sent: `EdgeRuntime.waitUntil` on
   * Supabase, nothing on Node (the process outlives the promise anyway). Default: the
   * promise is left to run, with rejections caught and logged.
   */
  readonly waitUntil?: (work: Promise<void>) => void;
}

export interface TurnMemory {
  recall(input: RecallInput): Promise<RecallOutcome>;
  /** Point a fact captured this turn at the user message that carried it. Best effort. */
  attachSource(factId: string, messageId: string): Promise<Result<void>>;
}

export interface TurnSavedEvent {
  readonly conversation: {
    readonly id: string;
    readonly userId: string;
    readonly scope: 'user' | 'workspace';
    readonly title: string | null;
  };
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  /** Rows the turn appended to `messages` — a user message and an assistant message. */
  readonly messagesAppended: number;
}

export interface ChatTurnInput {
  readonly token: string | null | undefined;
  readonly message: unknown;
  readonly conversationId?: unknown;
}

export interface ChatReply {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly reply: string;
  readonly model: string;
  readonly stopReason: string | null;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  /** What memory added to this turn — ids, similarities and sizes, never text. Absent when memory is off. */
  readonly memory?: RecallSummary;
}

export type ChatErrorStatus = 400 | 401 | 402 | 403 | 404 | 422 | 429 | 500 | 502 | 503 | 504;

/**
 * Apply the bounds to a history list (oldest first) and return what Claude will see.
 * Keeps the newest messages; then drops any leading assistant messages so the request
 * starts with a user turn, which the Messages API requires.
 */
export function boundHistory(
  history: readonly HistoryMessage[],
  bounds: HistoryBounds,
): readonly HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item === undefined) continue;
    if (kept.length >= bounds.maxMessages) break;
    if (chars + item.content.length > bounds.maxChars) break;
    chars += item.content.length;
    kept.unshift(item);
  }
  while (kept.length > 0 && kept[0]?.role !== 'user') {
    kept.shift();
  }
  return kept;
}

export interface ChatErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    /** Milliseconds the caller should wait, when the upstream said so. */
    readonly retryAfterMs?: number;
  };
}

export type ChatTurnResult =
  | { readonly status: 200; readonly body: ChatReply }
  | { readonly status: ChatErrorStatus; readonly body: ChatErrorBody };

export const DEFAULT_MAX_MESSAGE_CHARS = 8_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(
  status: ChatErrorStatus,
  code: string,
  message: string,
  retryable = false,
  retryAfterMs?: number,
): ChatTurnResult {
  return {
    status,
    body: {
      error: {
        code,
        message,
        retryable,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    },
  };
}

/** Infrastructure failure: we could not decide. Never a 403. */
function unavailable(error: AppError): ChatTurnResult {
  return failure(503, error.code, 'Service temporarily unavailable', true);
}

/**
 * Map a Claude-side failure onto a response. Messages are written for the operator and the
 * UI — they say WHICH failure it was and never carry upstream body text.
 */
export function mapLlmError(error: LlmError): ChatTurnResult {
  switch (error.code) {
    case 'SPEND_CAP': {
      const label = error.context['window'] === 'day' ? 'daily' : 'monthly';
      return failure(
        402,
        'SPEND_CAP',
        `The ${label} Claude spend cap has been reached. No request was sent. An admin can raise the cap in configuration.`,
      );
    }
    case 'RATE_LIMITED': {
      const retryAfter = error.context['retryAfterMs'];
      return failure(
        429,
        'RATE_LIMITED',
        'Claude is rate limiting requests. Try again shortly.',
        true,
        typeof retryAfter === 'number' ? retryAfter : undefined,
      );
    }
    case 'MODEL_REFUSAL':
      return failure(422, 'MODEL_REFUSAL', 'The model declined to answer this request.');
    case 'TIMEOUT':
      return failure(
        504,
        'TIMEOUT',
        'Claude did not answer in time. The turn was not saved.',
        true,
      );
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
      return failure(503, error.code, 'Claude is unreachable right now.', true);
    case 'HTTP_STATUS':
      return failure(502, 'UPSTREAM_ERROR', 'Claude returned an error.', error.retryable);
    case 'VALIDATION':
      return failure(502, 'BAD_UPSTREAM_RESPONSE', 'Claude returned an unreadable response.');
    case 'CONFIG':
      return failure(500, 'CONFIG', 'The Claude integration is misconfigured.');
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'CONFLICT':
    case 'UNKNOWN_THROWN':
    case 'INTERNAL':
      return failure(500, 'INTERNAL', 'Internal error.');
  }
}

export async function handleChatTurn(
  deps: ChatDeps,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  try {
    return await turn(deps, input);
  } catch (caught: unknown) {
    // Belt and braces: nothing below is supposed to throw. If it does, it is a 500 with
    // the cause logged, never an unhandled rejection in the runtime.
    deps.log.error('chat turn threw', { error: ensureError(caught) });
    return failure(500, 'INTERNAL', 'Internal error.');
  }
}

/** Everything settled before Claude is called: who, which conversation, what came before. */
interface PreparedTurn {
  readonly user: StaffIdentity;
  readonly conversation: ConversationRow;
  readonly history: readonly HistoryMessage[];
  readonly message: string;
  /** Null when memory is off. A degraded recall is still an outcome, never a refusal. */
  readonly recall: RecallOutcome | null;
}

type Prepared =
  | { readonly ok: true; readonly value: PreparedTurn }
  | { readonly ok: false; readonly result: ChatTurnResult };

function completionRequest(prepared: PreparedTurn, deps: ChatDeps): CompletionRequest {
  return {
    route: 'default',
    system: (deps.systemBlocks ?? buildSystemBlocks)(prepared.recall?.belowBreakpoint ?? undefined),
    messages: [...prepared.history, { role: 'user', content: prepared.message }],
    operation: 'chat.turn',
    userId: prepared.user.userId,
    conversationId: prepared.conversation.id,
  };
}

async function turn(deps: ChatDeps, input: ChatTurnInput): Promise<ChatTurnResult> {
  const prepared = await prepareTurn(deps, input);
  if (!prepared.ok) return prepared.result;

  // 5. Claude — the cap, the retries and the api_usage row live in client.ts.
  const completion = await deps.claude.complete(completionRequest(prepared.value, deps));
  if (!completion.ok) {
    return mapLlmError(completion.error);
  }
  return finishTurn(deps, prepared.value, completion.value);
}

async function prepareTurn(deps: ChatDeps, input: ChatTurnInput): Promise<Prepared> {
  const refuse = (result: ChatTurnResult): Prepared => ({ ok: false, result });
  const log = deps.log.child({ component: 'chat' });

  // 1. Who is asking — before anything else costs anything.
  const access = await verifyStaffAccess(deps.verify, input.token);
  if (!access.ok) {
    log.error('caller verification unavailable', { error: access.error });
    return refuse(unavailable(access.error));
  }
  if (access.value.kind === 'unauthenticated') {
    return refuse(failure(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
  }
  if (access.value.kind === 'forbidden') {
    return refuse(failure(403, 'FORBIDDEN', 'This account does not have access.'));
  }
  const user: StaffIdentity = access.value.user;

  // 2. The input.
  const maxChars = deps.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  if (typeof input.message !== 'string' || input.message.trim() === '') {
    return refuse(failure(400, 'BAD_REQUEST', 'message must be a non-empty string.'));
  }
  if (input.message.length > maxChars) {
    return refuse(failure(400, 'BAD_REQUEST', `message must be at most ${maxChars} characters.`));
  }
  const message = input.message;
  if (
    input.conversationId !== undefined &&
    input.conversationId !== null &&
    (typeof input.conversationId !== 'string' || !UUID.test(input.conversationId))
  ) {
    return refuse(failure(400, 'BAD_REQUEST', 'conversationId must be a UUID.'));
  }
  const requestedConversationId =
    typeof input.conversationId === 'string' ? input.conversationId : null;

  // 3. The conversation.
  let conversation: ConversationRow;
  if (requestedConversationId === null) {
    const created = await deps.conversations.create(user.userId);
    if (!created.ok) {
      log.error('conversation create failed', { error: created.error });
      return refuse(unavailable(created.error));
    }
    conversation = created.value;
  } else {
    const found = await deps.conversations.get(requestedConversationId);
    if (!found.ok) {
      log.error('conversation read failed', { error: found.error });
      return refuse(unavailable(found.error));
    }
    const row = found.value;
    const visible =
      row !== null &&
      row.deletedAt === null &&
      (row.scope === 'workspace' || row.userId === user.userId);
    if (!visible) {
      // Same answer for "does not exist" and "not yours": no existence oracle.
      return refuse(failure(404, 'NOT_FOUND', 'Conversation not found.'));
    }
    conversation = row;
  }

  // 4. What came before, in THIS conversation only. A conversation created a moment ago
  //    has nothing to load, and is not asked.
  const bounds = deps.history ?? DEFAULT_HISTORY_BOUNDS;
  let history: readonly HistoryMessage[] = [];
  if (requestedConversationId !== null && bounds.maxMessages > 0) {
    const recent = await deps.conversations.recentMessages(conversation.id, bounds.maxMessages);
    if (!recent.ok) {
      log.error('conversation history read failed', { error: recent.error });
      return refuse(unavailable(recent.error));
    }
    history = boundHistory(recent.value, bounds);
  }

  // 4b. Memory (Stage 3 part 2): facts, relevant earlier notes, and any "remember that…"
  //     in this message. Bounded by its own timeout; whatever it cannot do, the turn
  //     proceeds without. A thrown error here is a bug in the memory layer, not a reason
  //     to refuse the user.
  let recall: RecallOutcome | null = null;
  if (deps.memory !== undefined) {
    const previousUser = [...history].reverse().find((m) => m.role === 'user');
    try {
      recall = await deps.memory.recall({
        userId: user.userId,
        scope: conversation.scope,
        conversationId: requestedConversationId,
        historyMessages: history.length,
        message,
        previousUserMessage: previousUser?.content ?? null,
      });
    } catch (caught: unknown) {
      log.error('memory recall threw; turn proceeds without memory', {
        conversationId: conversation.id,
        error: ensureError(caught),
      });
    }
  }

  return { ok: true, value: { user, conversation, history, message, recall } };
}

/**
 * Step 7 (Stage 3): hand the saved turn to the memory hook without waiting for it. A hook
 * that throws synchronously, rejects, or takes a minute changes nothing about the reply —
 * the error is logged with ids only and the turn stays saved.
 */
function scheduleAfterTurn(deps: ChatDeps, event: TurnSavedEvent): void {
  if (deps.afterTurn === undefined) return;
  const log = deps.log.child({ component: 'chat' });
  let work: Promise<void>;
  try {
    work = deps.afterTurn(event);
  } catch (caught: unknown) {
    log.error('afterTurn hook threw', {
      conversationId: event.conversation.id,
      error: ensureError(caught),
    });
    return;
  }
  const guarded = work.catch((caught: unknown) => {
    log.error('afterTurn hook rejected', {
      conversationId: event.conversation.id,
      error: ensureError(caught),
    });
  });
  if (deps.waitUntil !== undefined) {
    deps.waitUntil(guarded);
  }
}

/** Step 6: refuse an empty reply, record the turn, answer. Shared by both paths. */
async function finishTurn(
  deps: ChatDeps,
  prepared: PreparedTurn,
  reply: Completion,
): Promise<ChatTurnResult> {
  const log = deps.log.child({ component: 'chat' });
  const { conversation, message } = prepared;
  if (reply.text.trim() === '') {
    // Metered (client.ts recorded the usage) but not a turn. Saying so precisely matters:
    // the user's message is not lost, and nothing blank is ever stored or shown.
    log.error('empty reply from Claude', {
      model: reply.model,
      stopReason: reply.stopReason,
      outputTokens: reply.usage.outputTokens,
    });
    return failure(
      502,
      'EMPTY_REPLY',
      'The assistant returned an empty reply. Nothing was saved. Please try again.',
      true,
    );
  }

  const appended = await deps.conversations.appendTurn({
    conversation,
    userContent: message,
    assistant: {
      content: reply.text,
      model: reply.model,
      inputTokens: reply.usage.inputTokens,
      outputTokens: reply.usage.outputTokens,
    },
  });
  if (!appended.ok) {
    // Spent and metered but not saved: say so precisely, so the user does not resend blind.
    log.error('turn not saved after a successful completion', { error: appended.error });
    return failure(
      503,
      'TURN_NOT_SAVED',
      'The reply was generated but could not be saved. Please try again.',
      true,
    );
  }

  // A fact captured before Claude was called now has its source message. Best effort: the
  // fact is already stored and current; a missing pointer is logged, never a failed turn.
  const recall = prepared.recall;
  if (
    deps.memory !== undefined &&
    recall?.savedFactId !== null &&
    recall?.savedFactId !== undefined
  ) {
    const attached = await deps.memory.attachSource(
      recall.savedFactId,
      appended.value.userMessageId,
    );
    if (!attached.ok) {
      log.error('fact source not attached', { factId: recall.savedFactId, error: attached.error });
    }
  }

  scheduleAfterTurn(deps, {
    conversation: {
      id: conversation.id,
      userId: conversation.userId,
      scope: conversation.scope,
      title: conversation.title,
    },
    userMessageId: appended.value.userMessageId,
    assistantMessageId: appended.value.assistantMessageId,
    messagesAppended: 2,
  });

  return {
    status: 200,
    body: {
      conversationId: conversation.id,
      userMessageId: appended.value.userMessageId,
      assistantMessageId: appended.value.assistantMessageId,
      reply: reply.text,
      model: reply.model,
      stopReason: reply.stopReason,
      usage: reply.usage,
      costUsd: reply.costUsd,
      ...(recall === null ? {} : { memory: recall.summary }),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Streaming (part 6). Same gates, same record, same answer — delivered as events.
// ---------------------------------------------------------------------------------------

export type ChatStreamEvent =
  /** The turn was admitted: the conversation it belongs to (new or existing). */
  | { readonly type: 'start'; readonly conversationId: string }
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done'; readonly reply: ChatReply }
  /**
   * The same status/body the JSON path would answer with, plus whatever text had already
   * arrived, so the interface can show it and say it is incomplete. Nothing was saved.
   */
  | {
      readonly type: 'error';
      readonly status: ChatErrorStatus;
      readonly body: ChatErrorBody;
      readonly partialText: string;
    };

export type ChatStreamSink = (event: ChatStreamEvent) => void;

const INTERNAL: ChatErrorBody = {
  error: { code: 'INTERNAL', message: 'Internal error.', retryable: false },
};

/**
 * One chat turn, streamed. Emits `start` once admitted, `delta` per text piece, then exactly
 * one of `done` / `error`. Falls back to `complete` (one `delta` with the whole reply) when
 * the client cannot stream. Never throws.
 */
export async function handleChatTurnStream(
  deps: ChatDeps,
  input: ChatTurnInput,
  emit: ChatStreamSink,
): Promise<void> {
  let partial = '';
  try {
    const prepared = await prepareTurn(deps, input);
    if (!prepared.ok) {
      if (prepared.result.status !== 200) {
        emit({
          type: 'error',
          status: prepared.result.status,
          body: prepared.result.body,
          partialText: '',
        });
      }
      return;
    }
    emit({ type: 'start', conversationId: prepared.value.conversation.id });

    const request = completionRequest(prepared.value, deps);
    const onText = (delta: string): void => {
      partial += delta;
      emit({ type: 'delta', text: delta });
    };
    let completion: Result<Completion, LlmError>;
    if (deps.claude.stream === undefined) {
      completion = await deps.claude.complete(request);
      if (completion.ok && completion.value.text !== '') onText(completion.value.text);
    } else {
      completion = await deps.claude.stream(request, onText);
    }

    if (!completion.ok) {
      const mapped = mapLlmError(completion.error);
      const fromError = completion.error.context['partialText'];
      emit({
        type: 'error',
        status: mapped.status === 200 ? 500 : mapped.status,
        body: mapped.status === 200 ? INTERNAL : mapped.body,
        partialText: typeof fromError === 'string' ? fromError : partial,
      });
      return;
    }
    const finished = await finishTurn(deps, prepared.value, completion.value);
    if (finished.status === 200) {
      emit({ type: 'done', reply: finished.body });
    } else {
      emit({ type: 'error', status: finished.status, body: finished.body, partialText: partial });
    }
  } catch (caught: unknown) {
    deps.log.error('chat stream threw', { error: ensureError(caught) });
    emit({ type: 'error', status: 500, body: INTERNAL, partialText: partial });
  }
}
