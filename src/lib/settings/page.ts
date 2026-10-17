/**
 * The settings page's server path (Milestone 5 part 4) — runtime-agnostic, never throws. The
 * Supabase Edge Function `settings` is a thin adapter over `handleSettingsRequest`, exactly as
 * the `admin` function is over the users page.
 *
 * Four actions. Everything else the page shows is read by the browser under row-level security:
 *
 *   forget_document — a learned document and every copy of it, at once and for good (decisions
 *                     4 and 5): every attachment still holding its text, every learned copy, its
 *                     passages and its summary. One database transaction (`forget_document`),
 *                     which also checks — under its locks — that the person added every copy or
 *                     is an administrator. Idempotent: the second tab is told it already went.
 *   create_key      — a connector key for the signed-in person, minted HERE from the platform's
 *                     random source. Its digest is stored; the key is in this one response body
 *                     and nowhere else, ever (decision 6) — not a log line, not a table, not a
 *                     later response. There is no way to show it again.
 *   revoke_key      — the signed-in person's own key, by its public id. Takes effect on the
 *                     connector's next call: every call reads the key's row inside
 *                     `connector_call`, and nothing caches it (measured in the report).
 *   spend           — the cap and what has been spent today and this month, from the SAME
 *                     configuration and the same sums the cap enforces (llm/client.ts), so the
 *                     page can never show a number the cap does not act on. Read-only
 *                     (decision 7): nothing here changes a cap.
 *
 * Order in every action: who is asking (401 / 403 before any work), then the input, then the
 * action. Infrastructure failures are 5xx with words; "could not decide" is never a 403.
 *
 * LOGGING: who, what, the outcome, counts and durations. Never a key — not a prefix, not a
 * digest; the public 12-character id is logged as `connector`, the name the connector's own log
 * lines use. Never a document's name or a word of its text: a document is its id. Never a key's
 * label (the person typed it): its length.
 */
import { z } from 'zod';

import { verifyStaffAccess, type VerifyDeps } from '../auth/verify.js';
import { isKeyId, mintKey, type RandomBytes } from '../connector/keys.js';
import { AppError, type ConfigError, type Result } from '../errors.js';
import type { UsageStore } from '../llm/client.js';
import { roundUsd } from '../llm/pricing.js';
import { utcDayStart, utcMonthStart, type SpendCaps } from '../llm/spend.js';
import type { Logger } from '../logger.js';
import { FORGET_REFUSED_MESSAGE, KEY_LABEL_MAX, MAX_LIVE_KEYS_PER_PERSON } from './access.js';
import type { SettingsStore } from './store.js';

// ---------------------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------------------

export type SettingsRequest =
  | { readonly action: 'forget_document'; readonly sourceId: string }
  | { readonly action: 'create_key'; readonly label: string }
  | { readonly action: 'revoke_key'; readonly keyId: string }
  | { readonly action: 'spend' };

export type SettingsReply =
  | {
      readonly action: 'forget_document';
      readonly outcome: 'forgotten' | 'already';
      readonly sourceId: string;
      readonly sources: number;
      readonly files: number;
      readonly chunks: number;
    }
  | {
      readonly action: 'create_key';
      readonly outcome: 'created';
      readonly keyId: string;
      readonly label: string;
      readonly createdAt: string;
      /** The whole key. In this one response, once. */
      readonly key: string;
    }
  | {
      readonly action: 'revoke_key';
      readonly outcome: 'revoked' | 'already';
      readonly keyId: string;
      readonly revokedAt: string;
    }
  | {
      readonly action: 'spend';
      readonly outcome: 'read';
      readonly capDailyUsd: number;
      readonly capMonthlyUsd: number;
      readonly warnFraction: number;
      readonly todayUsd: number;
      readonly monthUsd: number;
      /** The UTC instants the two windows started — the cap's own windows. */
      readonly dayStartedAt: string;
      readonly monthStartedAt: string;
      readonly asOf: string;
    };

export interface SettingsErrorBody {
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export type SettingsErrorStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

export type SettingsPageResult =
  | { readonly status: 200; readonly body: SettingsReply }
  | { readonly status: SettingsErrorStatus; readonly body: SettingsErrorBody };

export interface SettingsPageInput {
  readonly token: string | null | undefined;
  readonly body: unknown;
}

export interface SettingsPageDeps {
  readonly verify: VerifyDeps;
  readonly store: SettingsStore;
  readonly usage: Pick<UsageStore, 'spentSince'>;
  /** The cap's configuration, or why it could not be read. Only `spend` needs it. */
  readonly caps: Result<SpendCaps, ConfigError>;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly random?: RandomBytes;
}

export const SETTINGS_MESSAGES = {
  badRequest: 'That request was not understood. Refresh the page and try again.',
  unauthenticated: 'Your session has expired. Sign in again.',
  forbidden: 'This account does not have access to settings.',
  unavailable: "Couldn't reach the Command Centre's records just now. Try again in a moment.",
  forgetUnconfirmed:
    "Couldn't confirm that just now. Refresh the page: if the document is still listed, it was not forgotten — try again.",
  documentGone: 'That document is no longer in the list. Refresh to see what is learned now.',
  labelRequired: 'Give the key a name, so you can tell it apart later.',
  labelTooLong: `A key's name can be ${String(KEY_LABEL_MAX)} characters at most.`,
  labelBadCharacter: "A key's name is one line of plain text.",
  tooManyKeys: `You already have ${String(MAX_LIVE_KEYS_PER_PERSON)} keys switched on. Switch one off first.`,
  createUnconfirmed:
    "Couldn't confirm a key was made. If a key you never saw appears in the list, switch it off.",
  keyGone: 'That key is not one of yours, or it no longer exists. Refresh to see your keys.',
  revokeUnconfirmed:
    "Couldn't confirm that just now. Refresh the page and check the key's state — switching it off again is safe.",
  spendNotConfigured:
    'The spending cap is not set up on this Command Centre, so there is nothing to show.',
  internal: 'Something went wrong on our side. Try again.',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- a label is one line of plain text
const CONTROL = /[\u0000-\u001F\u007F]/;

const REQUEST = z.discriminatedUnion('action', [
  z.object({ action: z.literal('forget_document'), sourceId: z.string().regex(UUID) }).strict(),
  // The label is checked by hand below, so a refusal can say which rule it broke.
  z.object({ action: z.literal('create_key'), label: z.string().max(1000) }).strict(),
  z.object({ action: z.literal('revoke_key'), keyId: z.string().max(64) }).strict(),
  z.object({ action: z.literal('spend') }).strict(),
]);

function failure(
  status: SettingsErrorStatus,
  code: string,
  message: string,
  retryable = false,
): SettingsPageResult {
  return { status, body: { error: { code, message, retryable } } };
}

/** A store failure: transport problems are worth retrying; anything else is ours. */
function storeFailure(error: AppError, unconfirmed: string): SettingsPageResult {
  if (error.code === 'NETWORK' || error.code === 'TIMEOUT') {
    return failure(503, 'UNAVAILABLE', unconfirmed, true);
  }
  return failure(500, 'INTERNAL', SETTINGS_MESSAGES.internal, true);
}

interface Ctx {
  readonly deps: SettingsPageDeps;
  readonly userId: string;
  readonly log: Logger;
  readonly now: () => Date;
}

async function forgetDocument(ctx: Ctx, sourceId: string): Promise<SettingsPageResult> {
  const started = ctx.now().getTime();
  const result = await ctx.deps.store.forgetDocument(sourceId, ctx.userId);
  const durationMs = Math.max(0, ctx.now().getTime() - started);
  if (!result.ok) {
    ctx.log.error('settings: forget failed', {
      userId: ctx.userId,
      sourceId,
      durationMs,
      error: result.error,
    });
    return storeFailure(result.error, SETTINGS_MESSAGES.forgetUnconfirmed);
  }
  const outcome = result.value;
  ctx.log.info('settings: forget', {
    userId: ctx.userId,
    sourceId,
    outcome: outcome.kind,
    ...(outcome.kind === 'forgotten'
      ? { sources: outcome.sources, files: outcome.files, chunks: outcome.chunks }
      : {}),
    durationMs,
  });
  switch (outcome.kind) {
    case 'forgotten':
      return {
        status: 200,
        body: {
          action: 'forget_document',
          outcome: 'forgotten',
          sourceId,
          sources: outcome.sources,
          files: outcome.files,
          chunks: outcome.chunks,
        },
      };
    case 'already':
      return {
        status: 200,
        body: {
          action: 'forget_document',
          outcome: 'already',
          sourceId,
          sources: 0,
          files: 0,
          chunks: 0,
        },
      };
    case 'not_found':
      return failure(404, 'NOT_FOUND', SETTINGS_MESSAGES.documentGone);
    case 'not_allowed':
      return failure(403, 'NOT_YOURS', FORGET_REFUSED_MESSAGE);
    case 'not_staff':
      return failure(403, 'FORBIDDEN', SETTINGS_MESSAGES.forbidden);
  }
}

/** Characters as the database counts them (char_length): code points, not UTF-16 units. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

function checkLabel(raw: string): { ok: true; label: string } | { ok: false; message: string } {
  const label = raw.trim();
  if (label === '') return { ok: false, message: SETTINGS_MESSAGES.labelRequired };
  if (codePoints(label) > KEY_LABEL_MAX)
    return { ok: false, message: SETTINGS_MESSAGES.labelTooLong };
  if (CONTROL.test(label)) return { ok: false, message: SETTINGS_MESSAGES.labelBadCharacter };
  return { ok: true, label };
}

/** A collision on the 59-bit public id is tried again with a new key rather than reported. */
const MINT_ATTEMPTS = 3;

async function createKey(ctx: Ctx, rawLabel: string): Promise<SettingsPageResult> {
  const checked = checkLabel(rawLabel);
  if (!checked.ok) return failure(400, 'BAD_LABEL', checked.message);
  const { label } = checked;
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    const minted = await mintKey(ctx.deps.random);
    const stored = await ctx.deps.store.issueKey({
      userId: ctx.userId,
      keyId: minted.keyId,
      digestHex: minted.digestHex,
      label,
    });
    if (!stored.ok) {
      ctx.log.error('settings: connector key could not be created', {
        userId: ctx.userId,
        error: stored.error,
      });
      return storeFailure(stored.error, SETTINGS_MESSAGES.createUnconfirmed);
    }
    const value = stored.value;
    switch (value.kind) {
      case 'issued':
        ctx.log.info('settings: connector key created', {
          userId: ctx.userId,
          connector: value.keyId,
          labelLength: codePoints(label),
          outcome: 'created',
        });
        return {
          status: 200,
          body: {
            action: 'create_key',
            outcome: 'created',
            keyId: value.keyId,
            label,
            createdAt: value.createdAt,
            key: minted.key,
          },
        };
      case 'too_many':
        ctx.log.info('settings: connector key refused', {
          userId: ctx.userId,
          outcome: 'too_many',
        });
        return failure(409, 'TOO_MANY_KEYS', SETTINGS_MESSAGES.tooManyKeys);
      case 'not_staff':
        ctx.log.warn('settings: connector key refused', {
          userId: ctx.userId,
          outcome: 'not_staff',
        });
        return failure(403, 'FORBIDDEN', SETTINGS_MESSAGES.forbidden);
      case 'id_taken':
        continue;
    }
  }
  ctx.log.error('settings: connector key could not be created', {
    userId: ctx.userId,
    outcome: 'id_collisions',
  });
  return failure(500, 'INTERNAL', SETTINGS_MESSAGES.internal, true);
}

async function revokeKey(ctx: Ctx, keyId: string): Promise<SettingsPageResult> {
  if (!isKeyId(keyId)) return failure(400, 'BAD_REQUEST', SETTINGS_MESSAGES.badRequest);
  const result = await ctx.deps.store.revokeKey(ctx.userId, keyId);
  if (!result.ok) {
    ctx.log.error('settings: connector key could not be switched off', {
      userId: ctx.userId,
      connector: keyId,
      error: result.error,
    });
    return storeFailure(result.error, SETTINGS_MESSAGES.revokeUnconfirmed);
  }
  const value = result.value;
  ctx.log.info('settings: connector key switched off', {
    userId: ctx.userId,
    connector: keyId,
    outcome: value.kind,
  });
  switch (value.kind) {
    case 'revoked':
    case 'already_revoked':
      return {
        status: 200,
        body: {
          action: 'revoke_key',
          outcome: value.kind === 'revoked' ? 'revoked' : 'already',
          keyId: value.keyId,
          revokedAt: value.revokedAt,
        },
      };
    case 'not_found':
      return failure(404, 'NOT_FOUND', SETTINGS_MESSAGES.keyGone);
  }
}

async function readSpend(ctx: Ctx): Promise<SettingsPageResult> {
  const caps = ctx.deps.caps;
  if (!caps.ok) {
    ctx.log.error('settings: spend cap is not configured', { error: caps.error });
    return failure(503, 'NOT_CONFIGURED', SETTINGS_MESSAGES.spendNotConfigured);
  }
  const at = ctx.now();
  const dayStart = utcDayStart(at);
  const monthStart = utcMonthStart(at);
  const [day, month] = await Promise.all([
    ctx.deps.usage.spentSince('anthropic', dayStart),
    ctx.deps.usage.spentSince('anthropic', monthStart),
  ]);
  if (!day.ok || !month.ok) {
    const error = !day.ok ? day.error : !month.ok ? month.error : null;
    ctx.log.error('settings: spend could not be read', { userId: ctx.userId, error });
    return failure(503, 'UNAVAILABLE', SETTINGS_MESSAGES.unavailable, true);
  }
  ctx.log.info('settings: spend read', { userId: ctx.userId, outcome: 'read' });
  return {
    status: 200,
    body: {
      action: 'spend',
      outcome: 'read',
      capDailyUsd: caps.value.dailyUsd,
      capMonthlyUsd: caps.value.monthlyUsd,
      warnFraction: caps.value.warnFraction,
      todayUsd: roundUsd(day.value),
      monthUsd: roundUsd(month.value),
      dayStartedAt: dayStart.toISOString(),
      monthStartedAt: monthStart.toISOString(),
      asOf: at.toISOString(),
    },
  };
}

export async function handleSettingsRequest(
  deps: SettingsPageDeps,
  input: SettingsPageInput,
): Promise<SettingsPageResult> {
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  try {
    const access = await verifyStaffAccess(deps.verify, input.token);
    if (!access.ok) {
      log.error('settings: could not verify the caller', { error: access.error });
      return failure(503, 'UNAVAILABLE', SETTINGS_MESSAGES.unavailable, true);
    }
    const decision = access.value;
    if (decision.kind === 'unauthenticated') {
      return failure(401, 'UNAUTHENTICATED', SETTINGS_MESSAGES.unauthenticated);
    }
    if (decision.kind === 'forbidden') {
      log.warn('settings: refused', { reason: decision.reason });
      return failure(403, 'FORBIDDEN', SETTINGS_MESSAGES.forbidden);
    }

    const parsed = REQUEST.safeParse(input.body);
    if (!parsed.success) {
      log.info('settings: bad request', { userId: decision.user.userId });
      return failure(400, 'BAD_REQUEST', SETTINGS_MESSAGES.badRequest);
    }
    const ctx: Ctx = { deps, userId: decision.user.userId, log, now };
    const request = parsed.data;
    switch (request.action) {
      case 'forget_document':
        return await forgetDocument(ctx, request.sourceId.toLowerCase());
      case 'create_key':
        return await createKey(ctx, request.label);
      case 'revoke_key':
        return await revokeKey(ctx, request.keyId);
      case 'spend':
        return await readSpend(ctx);
    }
  } catch (caught: unknown) {
    log.error('settings: request threw', {
      error:
        caught instanceof AppError ? caught : new AppError('INTERNAL', 'settings request threw'),
    });
    return failure(500, 'INTERNAL', SETTINGS_MESSAGES.internal, true);
  }
}
