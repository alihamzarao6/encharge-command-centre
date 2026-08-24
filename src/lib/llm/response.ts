/**
 * Messages API response parsing. Claude output never lands anywhere unvalidated
 * (CLAUDE.md rule 13): the body is parsed against a Zod schema and the typed result is all
 * the rest of the code sees. Unknown content-block types are tolerated (loose objects) so a
 * new block type does not break a chat turn; unknown TOP-LEVEL shapes are refused.
 */
import { z } from 'zod';

import { ValidationError, err, ok, type Result } from '../errors.js';
import type { TokenUsage } from './pricing.js';

const nonNegInt = z.number().int().nonnegative();

const ContentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

export const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_details: z
    .object({
      category: z.string().nullable().optional(),
      explanation: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  content: z.array(ContentBlock),
  usage: z.object({
    input_tokens: nonNegInt,
    output_tokens: nonNegInt,
    cache_creation_input_tokens: nonNegInt.nullable().optional(),
    cache_read_input_tokens: nonNegInt.nullable().optional(),
  }),
});

export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export interface ParsedMessage {
  readonly id: string;
  readonly model: string;
  readonly stopReason: string | null;
  readonly refusalCategory: string | null;
  readonly text: string;
  readonly usage: TokenUsage;
}

export function parseMessageResponse(body: unknown): Result<ParsedMessage, ValidationError> {
  const result = MessageResponseSchema.safeParse(body);
  if (!result.success) {
    return err(
      new ValidationError(
        'Anthropic response did not match the Messages API schema',
        result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      ),
    );
  }
  const message = result.data;
  return ok({
    id: message.id,
    model: message.model,
    stopReason: message.stop_reason,
    refusalCategory:
      message.stop_reason === 'refusal' ? (message.stop_details?.category ?? null) : null,
    text: message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join(''),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  });
}

/** Anthropic's error envelope: `{ type: "error", error: { type, message } }`. */
const ErrorEnvelope = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string(), message: z.string() }),
});

export interface ApiErrorInfo {
  readonly type: string;
  readonly message: string;
}

/** Best-effort read of the error envelope; null when the body is not one. */
export function parseErrorEnvelope(bodyText: string): ApiErrorInfo | null {
  try {
    const parsed = ErrorEnvelope.safeParse(JSON.parse(bodyText));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}
