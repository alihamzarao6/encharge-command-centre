/**
 * Shapes of the voice conformance fixtures (tests/fixtures/voice/). Parsing only — no file
 * access here, so this stays pure and Deno-safe; the CLI and the test suite read the files
 * and hand the JSON in.
 *
 * A recorded response carries the prompt version and hash it was generated against. The
 * suite refuses a response recorded against a different prompt: passing checks over stale
 * output would say nothing about the prompt that is actually deployed.
 */
import { z } from 'zod';

import { ValidationError, err, ok, type Result } from '../errors.js';
import { ALL_CHECK_IDS, type VoicePrompt } from './conformance.js';

const CheckIdSchema = z.enum(ALL_CHECK_IDS as [string, ...string[]]);

const PromptSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  format: z.enum([
    'positioning',
    'facebook_post',
    'meta_ad',
    'google_ad',
    'lead_reply',
    'refusal',
    'chat',
  ]),
  message: z.string().min(1),
  checks: z.array(CheckIdSchema).min(1),
});

export const PromptFileSchema = z.object({
  description: z.string(),
  prompts: z.array(PromptSchema).min(1),
});

export const RecordedResponseSchema = z.object({
  promptId: z.string(),
  promptVersion: z.string(),
  promptHash: z.string(),
  model: z.string(),
  requestId: z.string().nullable(),
  recordedAt: z.string(),
  stopReason: z.string().nullable(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
  }),
  costUsd: z.number().nonnegative(),
  text: z.string(),
});

export type RecordedResponse = z.infer<typeof RecordedResponseSchema>;

function issues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function parsePromptFile(json: unknown): Result<readonly VoicePrompt[], ValidationError> {
  const parsed = PromptFileSchema.safeParse(json);
  if (!parsed.success) {
    return err(new ValidationError('voice prompts file is malformed', issues(parsed.error)));
  }
  const ids = parsed.data.prompts.map((p) => p.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    return err(
      new ValidationError('voice prompts file has duplicate ids', [
        { path: 'prompts', message: `duplicate: ${[...new Set(duplicates)].join(', ')}` },
      ]),
    );
  }
  // The enum above is built from ALL_CHECK_IDS, so the cast narrows to what was validated.
  return ok(parsed.data.prompts as readonly VoicePrompt[]);
}

export function parseRecordedResponse(json: unknown): Result<RecordedResponse, ValidationError> {
  const parsed = RecordedResponseSchema.safeParse(json);
  return parsed.success
    ? ok(parsed.data)
    : err(new ValidationError('recorded voice response is malformed', issues(parsed.error)));
}
