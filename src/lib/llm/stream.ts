/**
 * Anthropic Messages streaming, reduced to what the turn needs. The API sends
 * `message_start` (model, input/cache usage), `content_block_delta` (text pieces),
 * `message_delta` (stop reason, the FINAL output token count), `message_stop`, `ping`, and
 * `error`. This reducer folds them into one state that client.ts turns into the same
 * Completion + api_usage row the non-streaming path produces.
 *
 * Token counts come from the wire, never from counting characters: `message_start` carries
 * input_tokens and the cache figures, `message_delta` carries output_tokens. Only when the
 * stream dies before `message_delta` is the output estimated (from the text received), and
 * that row is labelled `:partial` so the ledger says so.
 */
import { z } from 'zod';

import type { SseEvent } from '../sse.js';
import { estimateInputTokens, type TokenUsage } from './pricing.js';

const Usage = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
});

const MessageStart = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    model: z.string(),
    usage: Usage,
  }),
});

const ContentBlockDelta = z.object({
  type: z.literal('content_block_delta'),
  delta: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text_delta'), text: z.string() }),
    z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
    z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
    z.object({ type: z.literal('signature_delta'), signature: z.string() }),
    z.object({ type: z.literal('citations_delta') }),
  ]),
});

const MessageDelta = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.string().nullable().optional(),
    stop_details: z.object({ category: z.string().optional() }).nullable().optional(),
  }),
  usage: Usage.optional(),
});

const ErrorEvent = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string(), message: z.string() }),
});

export interface StreamState {
  readonly requestId: string | null;
  readonly model: string | null;
  readonly text: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** From message_delta. null until the API has said the final number. */
  readonly outputTokens: number | null;
  readonly stopReason: string | null;
  readonly refusalCategory: string | null;
  /** message_stop seen: the reply is complete. */
  readonly complete: boolean;
  /** The API sent an error event mid-stream. */
  readonly apiError: { readonly type: string; readonly message: string } | null;
}

export const INITIAL_STREAM_STATE: StreamState = {
  requestId: null,
  model: null,
  text: '',
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: null,
  stopReason: null,
  refusalCategory: null,
  complete: false,
  apiError: null,
};

export interface StreamStep {
  readonly state: StreamState;
  /** New text this event contributed, for the consumer to forward. */
  readonly textDelta: string;
  /** An event this reducer does not understand; logged, never fatal. */
  readonly ignored: boolean;
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Fold one SSE event into the state. Unknown or malformed events leave it unchanged. */
export function applyAnthropicEvent(state: StreamState, event: SseEvent): StreamStep {
  const payload = parseData(event.data);
  switch (event.event) {
    case 'message_start': {
      const parsed = MessageStart.safeParse(payload);
      if (!parsed.success) return { state, textDelta: '', ignored: true };
      const usage = parsed.data.message.usage;
      return {
        state: {
          ...state,
          requestId: parsed.data.message.id,
          model: parsed.data.message.model,
          inputTokens: usage.input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        },
        textDelta: '',
        ignored: false,
      };
    }
    case 'content_block_delta': {
      const parsed = ContentBlockDelta.safeParse(payload);
      if (!parsed.success) return { state, textDelta: '', ignored: true };
      if (parsed.data.delta.type !== 'text_delta') {
        return { state, textDelta: '', ignored: false };
      }
      const textDelta = parsed.data.delta.text;
      return { state: { ...state, text: state.text + textDelta }, textDelta, ignored: false };
    }
    case 'message_delta': {
      const parsed = MessageDelta.safeParse(payload);
      if (!parsed.success) return { state, textDelta: '', ignored: true };
      const stopReason = parsed.data.delta.stop_reason ?? state.stopReason;
      return {
        state: {
          ...state,
          stopReason,
          refusalCategory:
            stopReason === 'refusal' ? (parsed.data.delta.stop_details?.category ?? null) : null,
          outputTokens: parsed.data.usage?.output_tokens ?? state.outputTokens,
          // A usage block on message_delta may also restate input_tokens; prefer it.
          inputTokens: parsed.data.usage?.input_tokens ?? state.inputTokens,
        },
        textDelta: '',
        ignored: false,
      };
    }
    case 'message_stop':
      return { state: { ...state, complete: true }, textDelta: '', ignored: false };
    case 'error': {
      const parsed = ErrorEvent.safeParse(payload);
      if (!parsed.success) return { state, textDelta: '', ignored: true };
      return {
        state: { ...state, apiError: parsed.data.error },
        textDelta: '',
        ignored: false,
      };
    }
    case 'ping':
    case 'content_block_start':
    case 'content_block_stop':
      return { state, textDelta: '', ignored: false };
    default:
      return { state, textDelta: '', ignored: true };
  }
}

/**
 * The usage a completed stream is billed at. Requires message_delta to have arrived;
 * callers use `partialUsage` otherwise.
 */
export function finalUsage(state: StreamState): TokenUsage | null {
  if (state.outputTokens === null) return null;
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
  };
}

/**
 * What a stream that died mid-reply consumed: real input figures from message_start,
 * output estimated from the text that arrived (generous — rounded up), so the cap counts
 * money that was almost certainly spent rather than ignoring it.
 */
export function partialUsage(state: StreamState, fallbackInputTokens: number): TokenUsage {
  return {
    inputTokens: state.model === null ? fallbackInputTokens : state.inputTokens,
    outputTokens: Math.max(state.outputTokens ?? 0, estimateInputTokens(state.text.length)),
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
  };
}
