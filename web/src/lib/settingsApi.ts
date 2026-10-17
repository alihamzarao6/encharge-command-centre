/**
 * The settings page's calls to its endpoint (Milestone 5 part 4): forget a document, make a
 * connector key, switch one off, read the spend. Every read of a LIST is a PostgREST select under
 * RLS (settingsData.ts) and never comes through here.
 *
 * Pure where it can be — the request shape, the reply reading, the words — so what the person is
 * told is unit-tested without a browser. Same error envelope as every other endpoint of this app.
 *
 * THE KEY. `create_key`'s reply is the only place a connector key ever reaches the browser. It is
 * handed to the component that shows it and to nothing else: not to a log (this file logs
 * nothing), not to storage, not to the URL. `readReply` checks its shape so a malformed reply is
 * an error rather than a half-shown key.
 */
import type { SpendReply } from './settingsView.js';

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
      readonly key: string;
    }
  | {
      readonly action: 'revoke_key';
      readonly outcome: 'revoked' | 'already';
      readonly keyId: string;
      readonly revokedAt: string;
    }
  | ({ readonly action: 'spend'; readonly outcome: 'read' } & SpendReply);

export type SettingsFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  /** Allowed in, but not allowed to forget THIS. */
  | 'notYours'
  /** It is no longer there (forgotten elsewhere, or not this person's key). */
  | 'gone'
  /** Refused for a reason the person can fix (a name, too many keys). */
  | 'refused'
  | 'retryable'
  | 'fatal';

export interface SettingsFailure {
  readonly kind: 'error';
  readonly failure: SettingsFailureKind;
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
}

export type SettingsOutcome =
  { readonly kind: 'ok'; readonly reply: SettingsReply } | SettingsFailure;

export const SETTINGS_CLIENT_TIMEOUT_MS = 30_000;

export const SETTINGS_CLIENT_MESSAGES = {
  sessionExpired: 'Your session has expired. Sign in again.',
  forbidden: 'This account does not have access to settings.',
  network:
    "Couldn't reach the Command Centre. Check your connection — then refresh to see whether it went through before trying again.",
  timeout:
    'That took too long to confirm. Refresh to see whether it went through before trying again.',
  unknown: 'Something went wrong on our side. Try again.',
} as const;

const KEY_SHAPE = /^fcc_[a-hjkmnp-z2-9]{12}_[A-Za-z0-9_-]{43}$/;
const KEY_ID_SHAPE = /^[a-hjkmnp-z2-9]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function money(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readSettingsReply(body: unknown): SettingsReply | null {
  if (!isRecord(body)) return null;
  const str = (name: string): string | null => {
    const value = body[name];
    return typeof value === 'string' ? value : null;
  };
  const action = str('action');
  const outcome = str('outcome');
  if (action === 'forget_document' && (outcome === 'forgotten' || outcome === 'already')) {
    const sourceId = str('sourceId');
    const sources = count(body['sources']);
    const files = count(body['files']);
    const chunks = count(body['chunks']);
    if (sourceId === null || sources === null || files === null || chunks === null) return null;
    return { action, outcome, sourceId, sources, files, chunks };
  }
  if (action === 'create_key' && outcome === 'created') {
    const keyId = str('keyId');
    const label = str('label');
    const createdAt = str('createdAt');
    const key = str('key');
    if (keyId === null || label === null || createdAt === null || key === null) return null;
    // The key must be a whole key, and the one it says it is: never half a key on screen.
    if (!KEY_SHAPE.test(key) || !KEY_ID_SHAPE.test(keyId) || !key.startsWith(`fcc_${keyId}_`)) {
      return null;
    }
    return { action, outcome, keyId, label, createdAt, key };
  }
  if (action === 'revoke_key' && (outcome === 'revoked' || outcome === 'already')) {
    const keyId = str('keyId');
    const revokedAt = str('revokedAt');
    if (keyId === null || revokedAt === null) return null;
    return { action, outcome, keyId, revokedAt };
  }
  if (action === 'spend' && outcome === 'read') {
    const capDailyUsd = money(body['capDailyUsd']);
    const capMonthlyUsd = money(body['capMonthlyUsd']);
    const warnFraction = money(body['warnFraction']);
    const todayUsd = money(body['todayUsd']);
    const monthUsd = money(body['monthUsd']);
    const dayStartedAt = str('dayStartedAt');
    const monthStartedAt = str('monthStartedAt');
    const asOf = str('asOf');
    if (
      capDailyUsd === null ||
      capMonthlyUsd === null ||
      warnFraction === null ||
      todayUsd === null ||
      monthUsd === null ||
      dayStartedAt === null ||
      monthStartedAt === null ||
      asOf === null
    ) {
      return null;
    }
    return {
      action,
      outcome,
      capDailyUsd,
      capMonthlyUsd,
      warnFraction,
      todayUsd,
      monthUsd,
      dayStartedAt,
      monthStartedAt,
      asOf,
    };
  }
  return null;
}

function failure(
  kind: SettingsFailureKind,
  message: string,
  code: string,
  status: number | null,
): SettingsFailure {
  return { kind: 'error', failure: kind, message, code, status };
}

function readError(body: unknown): { code: string; message: string; retryable: boolean } | null {
  if (!isRecord(body) || !isRecord(body['error'])) return null;
  const error = body['error'];
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') return null;
  return { code: error['code'], message: error['message'], retryable: error['retryable'] === true };
}

/**
 * A status and body become what the page should do and say. The server's sentences are written
 * for the person and are shown for everything they can act on; a bare 5xx never reads as "500".
 */
export function interpretSettingsResponse(status: number, body: unknown): SettingsOutcome {
  if (status === 200) {
    const reply = readSettingsReply(body);
    if (reply !== null) return { kind: 'ok', reply };
    return failure('retryable', SETTINGS_CLIENT_MESSAGES.unknown, 'BAD_RESPONSE', status);
  }
  const envelope = readError(body);
  const code = envelope?.code ?? `HTTP_${String(status)}`;
  switch (status) {
    case 401:
      return failure('unauthenticated', SETTINGS_CLIENT_MESSAGES.sessionExpired, code, status);
    case 403:
      return code === 'NOT_YOURS'
        ? failure('notYours', envelope?.message ?? SETTINGS_CLIENT_MESSAGES.forbidden, code, status)
        : failure('forbidden', SETTINGS_CLIENT_MESSAGES.forbidden, code, status);
    case 404:
      return failure('gone', envelope?.message ?? SETTINGS_CLIENT_MESSAGES.unknown, code, status);
    case 400:
    case 409:
      return failure(
        'refused',
        envelope?.message ?? SETTINGS_CLIENT_MESSAGES.unknown,
        code,
        status,
      );
    case 503:
      return failure(
        'retryable',
        envelope?.message ?? SETTINGS_CLIENT_MESSAGES.unknown,
        code,
        status,
      );
    default:
      return failure(
        envelope?.retryable === true ? 'retryable' : 'fatal',
        envelope?.message ?? SETTINGS_CLIENT_MESSAGES.unknown,
        code,
        status,
      );
  }
}

export interface SettingsDeps {
  readonly settingsUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}

/** One call. Never throws: a transport failure is an outcome with words, never a silent drop. */
export async function callSettings(
  deps: SettingsDeps,
  accessToken: string,
  request: SettingsRequest,
): Promise<SettingsOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? SETTINGS_CLIENT_TIMEOUT_MS);
  try {
    const response = await deps.fetch(deps.settingsUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        apikey: deps.anonKey,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
      cache: 'no-store',
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return interpretSettingsResponse(response.status, parsed);
  } catch (caught: unknown) {
    const aborted = caught instanceof Error && caught.name === 'AbortError';
    return failure(
      'retryable',
      aborted ? SETTINGS_CLIENT_MESSAGES.timeout : SETTINGS_CLIENT_MESSAGES.network,
      aborted ? 'CLIENT_TIMEOUT' : 'NETWORK',
      null,
    );
  } finally {
    clearTimeout(timer);
  }
}
