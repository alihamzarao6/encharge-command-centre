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
 *   4. call Claude (client.ts owns the cap, the retries and the api_usage row);
 *   5. write the user turn and the assistant turn to `messages` and touch the conversation.
 *
 * Deliberately NOT done here (Stage 3 owns memory; part 6 owns the interface): loading
 * earlier turns of the conversation into the request, semantic recall, streaming.
 * A turn is the message the user just sent plus the system prompt — nothing else.
 */
import { ensureError, type AppError, type Result } from '../errors.js';
import type { Logger } from '../logger.js';
import { verifyStaffAccess, type StaffIdentity, type VerifyDeps } from '../auth/verify.js';
import type { ClaudeClient, LlmError } from './client.js';
import type { TokenUsage } from './pricing.js';
import { buildSystemBlocks, type SystemBlock } from './prompt.js';

export interface ConversationRow {
  readonly id: string;
  readonly userId: string;
  readonly scope: 'user' | 'workspace';
  readonly deletedAt: string | null;
}

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
  appendTurn(input: AppendTurnInput): Promise<Result<AppendedTurn>>;
}

export interface ChatDeps {
  readonly verify: VerifyDeps;
  readonly claude: ClaudeClient;
  readonly conversations: ConversationStore;
  readonly log: Logger;
  readonly systemBlocks?: () => readonly SystemBlock[];
  readonly maxMessageChars?: number;
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
}

export type ChatErrorStatus = 400 | 401 | 402 | 403 | 404 | 422 | 429 | 500 | 502 | 503 | 504;

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

async function turn(deps: ChatDeps, input: ChatTurnInput): Promise<ChatTurnResult> {
  const log = deps.log.child({ component: 'chat' });

  // 1. Who is asking — before anything else costs anything.
  const access = await verifyStaffAccess(deps.verify, input.token);
  if (!access.ok) {
    log.error('caller verification unavailable', { error: access.error });
    return unavailable(access.error);
  }
  if (access.value.kind === 'unauthenticated') {
    return failure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  if (access.value.kind === 'forbidden') {
    return failure(403, 'FORBIDDEN', 'This account does not have access.');
  }
  const user: StaffIdentity = access.value.user;

  // 2. The input.
  const maxChars = deps.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  if (typeof input.message !== 'string' || input.message.trim() === '') {
    return failure(400, 'BAD_REQUEST', 'message must be a non-empty string.');
  }
  if (input.message.length > maxChars) {
    return failure(400, 'BAD_REQUEST', `message must be at most ${maxChars} characters.`);
  }
  const message = input.message;
  if (
    input.conversationId !== undefined &&
    input.conversationId !== null &&
    (typeof input.conversationId !== 'string' || !UUID.test(input.conversationId))
  ) {
    return failure(400, 'BAD_REQUEST', 'conversationId must be a UUID.');
  }
  const requestedConversationId =
    typeof input.conversationId === 'string' ? input.conversationId : null;

  // 3. The conversation.
  let conversation: ConversationRow;
  if (requestedConversationId === null) {
    const created = await deps.conversations.create(user.userId);
    if (!created.ok) {
      log.error('conversation create failed', { error: created.error });
      return unavailable(created.error);
    }
    conversation = created.value;
  } else {
    const found = await deps.conversations.get(requestedConversationId);
    if (!found.ok) {
      log.error('conversation read failed', { error: found.error });
      return unavailable(found.error);
    }
    const row = found.value;
    const visible =
      row !== null &&
      row.deletedAt === null &&
      (row.scope === 'workspace' || row.userId === user.userId);
    if (!visible) {
      // Same answer for "does not exist" and "not yours": no existence oracle.
      return failure(404, 'NOT_FOUND', 'Conversation not found.');
    }
    conversation = row;
  }

  // 4. Claude — the cap, the retries and the api_usage row live in client.ts.
  const system = (deps.systemBlocks ?? buildSystemBlocks)();
  const completion = await deps.claude.complete({
    route: 'default',
    system,
    messages: [{ role: 'user', content: message }],
    operation: 'chat.turn',
    userId: user.userId,
    conversationId: conversation.id,
  });
  if (!completion.ok) {
    return mapLlmError(completion.error);
  }
  const reply = completion.value;

  // 5. The turn, recorded.
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
    },
  };
}
