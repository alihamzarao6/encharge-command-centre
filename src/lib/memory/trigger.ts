/**
 * The summarisation trigger (Stage 3 part 1): what runs AFTER a turn is saved, off the
 * reply's critical path, and what the sweep and the CLI flush call.
 *
 * `summariseConversation` is the whole unit of work for one conversation:
 *   read coverage → plan ranges (policy.ts) → for each range: read the messages, summarise
 *   (summarise.ts, Haiku, under the Anthropic cap), embed (embed.ts, Voyage, under its own
 *   cap), insert the chunk (chunks.ts, refused by the database if it already exists).
 * A failure at any step stops the loop for this conversation — a later range must never
 * be written while an earlier one is missing, because coverage is "the highest bound
 * written" and the gap would never be revisited. Nothing is retried here beyond what the
 * clients do; the next turn or the sweep simply plans the same range again.
 *
 * `createAfterTurnHook` wraps that as the chat's `afterTurn` dependency: it never throws,
 * never rejects, logs every outcome with ids only. The chat handler hands its promise to
 * `waitUntil` (EdgeRuntime.waitUntil on Supabase; a void on Node) so the user's reply is
 * sent first and the work finishes behind it. If it fails or is slow the user does not
 * notice — guardrail, and Part C item 8.
 */
import { ensureError, type AppError, type Result } from '../errors.js';
import type { ClaudeClient } from '../llm/client.js';
import type { Logger } from '../logger.js';
import type { MemoryPolicyConfig } from './config.js';
import type { ChunkStore, ConversationRef, OrdinalMessage } from './chunks.js';
import type { Embedder } from './embed.js';
import { planChunks, type MessageRange } from './policy.js';
import { SHARED_MEMORY_SCOPE } from './privacy.js';
import {
  embeddingText,
  perthDate,
  summariseMessages,
  type TranscriptMessage,
} from './summarise.js';

export const EMBED_OPERATION = 'memory.embed';

export interface MemoryDeps {
  readonly claude: ClaudeClient;
  readonly embedder: Embedder;
  readonly chunks: ChunkStore;
  readonly policy: MemoryPolicyConfig;
  readonly log: Logger;
  readonly now?: () => Date;
}

export interface SummariseOptions {
  /** Messages the triggering turn just appended (2 for a chat turn, 0 for a sweep/flush). */
  readonly freshMessages: number;
  /** Whole uncovered tail now, regardless of age (the CLI flush). */
  readonly force?: boolean;
}

export interface ChunkOutcome {
  readonly range: MessageRange;
  readonly result: 'inserted' | 'exists' | 'failed';
  readonly summaryChars?: number;
  readonly summaryCostUsd?: number;
  readonly embedCostUsd?: number;
  readonly error?: AppError;
}

export interface SummariseOutcome {
  readonly conversationId: string;
  readonly messageCount: number;
  readonly nextOrdinalBefore: number;
  readonly planned: readonly MessageRange[];
  readonly chunks: readonly ChunkOutcome[];
}

/** What the chat handler reports once a turn is in `messages`. */
export interface TurnSavedEvent {
  readonly conversation: ConversationRef;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  /** Rows the turn appended — the policy's `freshMessages`. */
  readonly messagesAppended: number;
}

export type AfterTurnHook = (event: TurnSavedEvent) => Promise<void>;

function toTranscript(messages: readonly OrdinalMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    if (
      (m.role === 'user' || m.role === 'assistant') &&
      m.content !== null &&
      m.content.trim() !== ''
    ) {
      out.push({ ordinal: m.ordinal, role: m.role, content: m.content });
    }
  }
  return out;
}

export async function summariseConversation(
  deps: MemoryDeps,
  conversation: ConversationRef,
  options: SummariseOptions,
): Promise<Result<SummariseOutcome>> {
  const log = deps.log.child({ component: 'memory', conversationId: conversation.id });
  const now = deps.now ?? ((): Date => new Date());

  const coverage = await deps.chunks.coverage(conversation.id);
  if (!coverage.ok) {
    log.error('coverage read failed', { error: coverage.error });
    return coverage;
  }
  const { messageCount, nextOrdinal } = coverage.value;
  const base: Omit<SummariseOutcome, 'planned' | 'chunks'> = {
    conversationId: conversation.id,
    messageCount,
    nextOrdinalBefore: nextOrdinal,
  };
  if (nextOrdinal > messageCount) {
    return { ok: true, value: { ...base, planned: [], chunks: [] } };
  }

  // One bounded read of the uncovered tail. If the tail is longer than one trigger can
  // consume, the idle rule cannot apply this time anyway (the tail is not finished), so
  // the newest-settled timestamp is only computed when the whole tail was read.
  const readLimit = deps.policy.chunkMessages * deps.policy.maxChunksPerTrigger;
  const tailHi = Math.min(messageCount, nextOrdinal + readLimit - 1) + 1;
  const tail = await deps.chunks.messagesInRange(conversation.id, { lo: nextOrdinal, hi: tailHi });
  if (!tail.ok) {
    log.error('tail read failed', { error: tail.error });
    return tail;
  }
  const wholeTailRead = tailHi === messageCount + 1;
  const settledEnd = messageCount - Math.max(0, options.freshMessages);
  const newestSettled = wholeTailRead
    ? (tail.value.find((m) => m.ordinal === settledEnd) ?? null)
    : null;

  const planned = planChunks(deps.policy, {
    messageCount,
    nextOrdinal,
    freshMessages: options.freshMessages,
    newestSettledAt: newestSettled === null ? null : newestSettled.createdAt,
    now: now(),
    ...(options.force === true ? { force: true } : {}),
  });
  const chunks: ChunkOutcome[] = [];
  for (const range of planned) {
    const outcome = await writeOne(deps, conversation, range, tail.value, log);
    chunks.push(outcome);
    if (outcome.result === 'failed') break;
  }
  if (planned.length > 0) {
    log.info('summarisation run', {
      messageCount,
      nextOrdinalBefore: nextOrdinal,
      planned: planned.length,
      inserted: chunks.filter((c) => c.result === 'inserted').length,
      exists: chunks.filter((c) => c.result === 'exists').length,
      failed: chunks.filter((c) => c.result === 'failed').length,
    });
  }
  return { ok: true, value: { ...base, planned, chunks } };
}

async function writeOne(
  deps: MemoryDeps,
  conversation: ConversationRef,
  range: MessageRange,
  tail: readonly OrdinalMessage[],
  log: Logger,
): Promise<ChunkOutcome> {
  const inRange = tail.filter((m) => m.ordinal >= range.lo && m.ordinal < range.hi);
  const transcript = toTranscript(inRange);
  // The Voyage cap is checked first, against the largest summary that could be stored: a
  // refused embedding must not cost a Haiku call it can never use.
  const budget = await deps.embedder.checkBudget(deps.policy.summaryMaxChars);
  if (!budget.ok) {
    log.error('voyage budget refused; range left uncovered, nothing spent', {
      range,
      error: budget.error,
    });
    return { range, result: 'failed', error: budget.error };
  }
  const summary = await summariseMessages(
    deps.claude,
    {
      messages: transcript,
      range,
      maxChars: deps.policy.summaryMaxChars,
      userId: conversation.userId,
      conversationId: conversation.id,
    },
    log,
  );
  if (!summary.ok) {
    log.error('summarise failed; range left uncovered', { range, error: summary.error });
    return { range, result: 'failed', error: summary.error };
  }
  const newest = inRange.reduce<Date | null>(
    (latest, m) => (latest === null || m.createdAt > latest ? m.createdAt : latest),
    null,
  );
  const embedded = await deps.embedder.embed({
    texts: [
      embeddingText(
        {
          title: conversation.title,
          date: perthDate(newest ?? (deps.now ?? (() => new Date()))()),
          audience: summary.value.audience,
        },
        summary.value.text,
      ),
    ],
    inputType: 'document',
    operation: EMBED_OPERATION,
    userId: conversation.userId,
    conversationId: conversation.id,
  });
  if (!embedded.ok) {
    log.error('embed failed; range left uncovered', { range, error: embedded.error });
    return {
      range,
      result: 'failed',
      summaryCostUsd: summary.value.costUsd,
      error: embedded.error,
    };
  }
  const vector = embedded.value.vectors[0];
  if (vector === undefined) {
    return { range, result: 'failed', summaryCostUsd: summary.value.costUsd };
  }
  const inserted = await deps.chunks.insertChunk({
    conversationId: conversation.id,
    userId: conversation.userId,
    // NOT `conversation.scope` (Stage 3 part 5, R27): what the assistant learns is shared
    // even when the conversation is private. The database says the same thing — the chunk
    // trigger forces it and `memory_chunks_scope_workspace` refuses anything else — but the
    // application states its intent rather than relying on a trigger to correct it.
    scope: SHARED_MEMORY_SCOPE,
    summary: summary.value.text,
    audience: summary.value.audience,
    embedding: vector,
    range,
  });
  if (!inserted.ok) {
    log.error('chunk insert failed', { range, error: inserted.error });
    return {
      range,
      result: 'failed',
      summaryCostUsd: summary.value.costUsd,
      embedCostUsd: embedded.value.costUsd,
      error: inserted.error,
    };
  }
  return {
    range,
    result: inserted.value,
    summaryChars: summary.value.text.length,
    summaryCostUsd: summary.value.costUsd,
    embedCostUsd: embedded.value.costUsd,
  };
}

/** The chat's `afterTurn`: never throws, never rejects. */
export function createAfterTurnHook(deps: MemoryDeps): AfterTurnHook {
  return async (event) => {
    try {
      await summariseConversation(deps, event.conversation, {
        freshMessages: event.messagesAppended,
      });
    } catch (caught: unknown) {
      deps.log.error('memory hook threw', {
        conversationId: event.conversation.id,
        error: ensureError(caught),
      });
    }
  };
}

export interface SweepOutcome {
  readonly candidates: number;
  readonly outcomes: readonly SummariseOutcome[];
}

/**
 * Conversations idle for longer than the policy's window get their tail summarised.
 * Meant for a scheduler (part 5); usable now from `npm run memory -- sweep`.
 */
export async function sweepIdleConversations(
  deps: MemoryDeps,
  limit: number,
): Promise<Result<SweepOutcome>> {
  const now = deps.now ?? ((): Date => new Date());
  const staleBefore = new Date(now().getTime() - deps.policy.idleHours * 3_600_000);
  const idle = await deps.chunks.idleConversations(staleBefore, limit);
  if (!idle.ok) return idle;
  const outcomes: SummariseOutcome[] = [];
  for (const conversation of idle.value) {
    const outcome = await summariseConversation(deps, conversation, { freshMessages: 0 });
    if (outcome.ok) outcomes.push(outcome.value);
  }
  return { ok: true, value: { candidates: idle.value.length, outcomes } };
}
