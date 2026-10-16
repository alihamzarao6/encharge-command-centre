/**
 * The calls this part makes to Google (Milestone 5 part 3a): the OAuth token endpoint (turn a
 * code into tokens, refresh, revoke), Drive's `about` (which account), `files.get` (what a file
 * is) and the file's content (downloaded, or exported per formats.ts).
 *
 * CLAUDE.md rule 8, as http.ts gives it: a timeout on every call, retry with exponential
 * backoff and jitter on transient answers, a circuit breaker per origin. On top of that, a
 * 403 that Drive documents as "you are going too fast" is retried here too — http.ts treats a
 * 403 as a definite answer, and for Drive it sometimes is not. Turning a CODE into tokens is
 * never retried: a code is single-use, and a retry after a lost answer could only fail.
 *
 * Every failure is a `GoogleFailure` kind the endpoint maps to a sentence. No token, code or
 * secret is ever put into one, into a log line, or into a thrown error: requests carry them in
 * a header or a form body, which http.ts never logs, and Google's error bodies are read only
 * for their reason code.
 */
import { z } from 'zod';

import type { Result } from '../errors.js';
import { err, ok } from '../errors.js';
import type { HttpClient, HttpError, OpenResponse } from '../http.js';
import type { DriveFileMeta, ReadPlan } from './formats.js';
import { DRIVE_FILE_SCOPE, DRIVE_LIMITS } from './limits.js';
import { readCapped } from './stream.js';

export const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
} as const;

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Our callback: the `drive` Edge Function's `/callback`. Registered on the OAuth client. */
  readonly redirectUri: string;
  /** `form_post` keeps the code out of every URL, and so out of the platform's request log. */
  readonly responseMode: 'form_post' | 'query';
}

export type GoogleFailure =
  /** The token endpoint said the grant is gone: revoked, lapsed, or a code already used. */
  | { readonly kind: 'grant_invalid' }
  /** Drive refused a token the token endpoint had just issued: access removed in between. */
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'not_found' }
  /** Not opened through this app, or not his to read. */
  | { readonly kind: 'no_access' }
  | { readonly kind: 'download_blocked' }
  | { readonly kind: 'export_too_large' }
  | { readonly kind: 'domain_policy' }
  /** Still too fast after the retries. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'too_large'; readonly received: number }
  /** Our side is wrong: the client id, secret or redirect address Google has does not match. */
  | { readonly kind: 'client_config' }
  | { readonly kind: 'bad_response' };

export interface TokenGrant {
  readonly accessToken: string;
  /** Present when Google granted lasting (offline) access. */
  readonly refreshToken: string | null;
  readonly scope: string;
}

export interface DriveAccount {
  readonly email: string;
  /** Stable for the account, whatever address it uses (D125, D126). */
  readonly permissionId: string;
}

export interface FileContent {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

export interface GoogleClient {
  authorizeUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    /** Extra authorization parameters (the picking step's, when it is built). */
    readonly extra?: Readonly<Record<string, string>>;
  }): string;
  exchangeCode(code: string, verifier: string): Promise<Result<TokenGrant, GoogleFailure>>;
  refresh(refreshToken: string): Promise<Result<{ readonly accessToken: string }, GoogleFailure>>;
  revoke(token: string): Promise<Result<'revoked' | 'already_gone', GoogleFailure>>;
  about(accessToken: string): Promise<Result<DriveAccount, GoogleFailure>>;
  getFile(accessToken: string, fileId: string): Promise<Result<DriveFileMeta, GoogleFailure>>;
  readContent(
    accessToken: string,
    fileId: string,
    plan: Extract<ReadPlan, { kind: 'export' | 'download' }>,
  ): Promise<Result<FileContent, GoogleFailure>>;
}

export interface GoogleDeps {
  readonly config: GoogleConfig;
  /** Small JSON answers: timeouts, retries and the breaker (http.ts). */
  readonly http: HttpClient;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

/** Drive's reasons for a 403 that mean "slow down", not "no". */
const BUSY_REASONS: ReadonlySet<string> = new Set([
  'userRateLimitExceeded',
  'rateLimitExceeded',
  'sharingRateLimitExceeded',
  'dailyLimitExceeded',
]);

/** The reason code inside a Google error body, if one is visible. Never the message. */
export function googleReason(error: HttpError): string | null {
  const snippet = error.context['bodySnippet'];
  if (typeof snippet !== 'string') return null;
  const drive = /"reason"\s*:\s*"([A-Za-z_]{1,64})"/.exec(snippet);
  if (drive?.[1] !== undefined) return drive[1];
  const oauth = /"error"\s*:\s*"([a-z_]{1,64})"/.exec(snippet);
  return oauth?.[1] ?? null;
}

/** A failed Drive call, as a kind. */
export function driveFailure(error: HttpError): GoogleFailure {
  if (error.code === 'TIMEOUT') return { kind: 'timeout' };
  if (error.code === 'NETWORK' || error.code === 'CIRCUIT_OPEN') return { kind: 'unreachable' };
  const status = typeof error.context['status'] === 'number' ? error.context['status'] : 0;
  const reason = googleReason(error);
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 404 || status === 400) return { kind: 'not_found' };
  if (status === 429) return { kind: 'busy' };
  if (status === 403) {
    if (reason !== null && BUSY_REASONS.has(reason)) return { kind: 'busy' };
    if (reason === 'exportSizeLimitExceeded') return { kind: 'export_too_large' };
    if (reason === 'domainPolicy') return { kind: 'domain_policy' };
    if (reason === 'cannotDownloadFile' || reason === 'cannotDownloadAbusiveFile') {
      return { kind: 'download_blocked' };
    }
    return { kind: 'no_access' };
  }
  if (status >= 500) return { kind: 'unreachable' };
  return { kind: 'bad_response' };
}

/** A failed token-endpoint call, as a kind. */
export function tokenFailure(error: HttpError): GoogleFailure {
  if (error.code === 'TIMEOUT') return { kind: 'timeout' };
  if (error.code !== 'HTTP_STATUS') return { kind: 'unreachable' };
  const status = typeof error.context['status'] === 'number' ? error.context['status'] : 0;
  const reason = googleReason(error);
  if (reason === 'invalid_grant') return { kind: 'grant_invalid' };
  if (
    reason === 'invalid_client' ||
    reason === 'unauthorized_client' ||
    reason === 'redirect_uri_mismatch' ||
    status === 401
  ) {
    return { kind: 'client_config' };
  }
  if (status === 429) return { kind: 'busy' };
  if (status >= 500) return { kind: 'unreachable' };
  return { kind: 'bad_response' };
}

const TOKEN_REPLY = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const ABOUT_REPLY = z.object({
  user: z.object({
    emailAddress: z.string().min(3).max(320),
    permissionId: z.string().min(1).max(128),
  }),
});

const FILE_REPLY = z.object({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string().min(1).max(160),
  size: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  modifiedTime: z.string().optional(),
  trashed: z.boolean().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
  shortcutDetails: z
    .object({ targetId: z.string().optional(), targetMimeType: z.string().optional() })
    .optional(),
});

/** Each scope Google granted. The string is space-separated. */
export function grantedScopes(scope: string): readonly string[] {
  return scope.split(/\s+/).filter((piece) => piece !== '');
}

/**
 * Is what Google granted exactly the one scope this part may hold? `missing`: he unticked it
 * on Google's screen (granular consent). `wider`: anything more — never accepted, whatever it
 * is (the brief's decision 1).
 */
export function checkGrantedScope(scope: string): 'ok' | 'missing' | 'wider' {
  const scopes = grantedScopes(scope);
  if (!scopes.includes(DRIVE_FILE_SCOPE)) return 'missing';
  return scopes.every((piece) => piece === DRIVE_FILE_SCOPE) ? 'ok' : 'wider';
}

function form(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' } as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createGoogleClient(deps: GoogleDeps): GoogleClient {
  const { config, http } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? ((): number => Math.random());

  /** Equal jitter over an exponential cap: [cap/2, cap). */
  const backoff = (attempt: number): number => {
    const cap = Math.min(4_000, 500 * 2 ** attempt);
    return Math.round(cap / 2 + (random() * cap) / 2);
  };

  /**
   * Retries a Drive call whose failure may be different in a moment — by default only "busy"
   * (a 403 reason, or a 429 after http.ts's own retries) — while the deadline allows.
   */
  const busyRetry = async <T>(
    call: () => Promise<Result<T, GoogleFailure>>,
    deadlineAt: number,
    retryOn: (failure: GoogleFailure) => boolean = (failure) => failure.kind === 'busy',
  ): Promise<Result<T, GoogleFailure>> => {
    let result = await call();
    for (let attempt = 0; attempt < DRIVE_LIMITS.busyRetries; attempt += 1) {
      if (result.ok || !retryOn(result.error)) return result;
      const wait = backoff(attempt);
      if (now() + wait >= deadlineAt) return result;
      await sleep(wait);
      result = await call();
    }
    return result;
  };

  const driveJson = async (
    url: string,
    accessToken: string,
  ): Promise<Result<unknown, GoogleFailure>> => {
    const answer = await http.request(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      timeoutMs: DRIVE_LIMITS.metadataTimeoutMs,
    });
    if (!answer.ok) return err(driveFailure(answer.error));
    try {
      return ok(JSON.parse(answer.value.bodyText) as unknown);
    } catch {
      return err({ kind: 'bad_response' });
    }
  };

  return {
    authorizeUrl: ({ state, codeChallenge, extra }) => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: DRIVE_FILE_SCOPE,
        // Lasting access, asked for every time: Google returns a refresh token only when the
        // consent screen was shown, and a connection with no refresh token dies in an hour.
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(config.responseMode === 'form_post' ? { response_mode: 'form_post' } : {}),
        ...(extra ?? {}),
      });
      return `${GOOGLE_ENDPOINTS.authorize}?${params.toString()}`;
    },

    exchangeCode: async (code, verifier) => {
      const answer = await http.request(GOOGLE_ENDPOINTS.token, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
        }),
        // A code works once. Retrying after a lost answer can only be refused.
        idempotent: false,
        timeoutMs: DRIVE_LIMITS.metadataTimeoutMs,
      });
      if (!answer.ok) return err(tokenFailure(answer.error));
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer.value.bodyText);
      } catch {
        return err({ kind: 'bad_response' });
      }
      const reply = TOKEN_REPLY.safeParse(parsed);
      if (!reply.success) return err({ kind: 'bad_response' });
      return ok({
        accessToken: reply.data.access_token,
        refreshToken: reply.data.refresh_token ?? null,
        scope: reply.data.scope ?? '',
      });
    },

    refresh: async (refreshToken) => {
      const answer = await http.request(GOOGLE_ENDPOINTS.token, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        // Asking for a fresh access token twice gives two tokens and changes nothing else.
        idempotent: true,
        timeoutMs: DRIVE_LIMITS.metadataTimeoutMs,
      });
      if (!answer.ok) return err(tokenFailure(answer.error));
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer.value.bodyText);
      } catch {
        return err({ kind: 'bad_response' });
      }
      const reply = TOKEN_REPLY.safeParse(parsed);
      return reply.success
        ? ok({ accessToken: reply.data.access_token })
        : err({ kind: 'bad_response' });
    },

    revoke: async (token) => {
      const answer = await http.request(GOOGLE_ENDPOINTS.revoke, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: form({ token }),
        // Revoking twice: the second is told the token is already gone, which is the outcome.
        idempotent: true,
        timeoutMs: DRIVE_LIMITS.metadataTimeoutMs,
      });
      if (answer.ok) return ok('revoked');
      const reason = googleReason(answer.error);
      const status = answer.error.context['status'];
      if (status === 400 && (reason === 'invalid_token' || reason === 'invalid_grant')) {
        return ok('already_gone');
      }
      return err(tokenFailure(answer.error));
    },

    about: async (accessToken) => {
      const deadlineAt = now() + DRIVE_LIMITS.metadataTimeoutMs * 3;
      const body = await busyRetry(
        () =>
          driveJson(
            `${GOOGLE_ENDPOINTS.drive}/about?fields=${encodeURIComponent('user(emailAddress,permissionId)')}`,
            accessToken,
          ),
        deadlineAt,
      );
      if (!body.ok) return body;
      const reply = ABOUT_REPLY.safeParse(body.value);
      return reply.success
        ? ok({ email: reply.data.user.emailAddress, permissionId: reply.data.user.permissionId })
        : err({ kind: 'bad_response' });
    },

    getFile: async (accessToken, fileId) => {
      const fields =
        'id,name,mimeType,size,modifiedTime,trashed,capabilities/canDownload,shortcutDetails/targetId,shortcutDetails/targetMimeType';
      const url = `${GOOGLE_ENDPOINTS.drive}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(fields)}`;
      const deadlineAt = now() + DRIVE_LIMITS.metadataTimeoutMs * 3;
      const body = await busyRetry(() => driveJson(url, accessToken), deadlineAt);
      if (!body.ok) return body;
      const reply = FILE_REPLY.safeParse(body.value);
      if (!reply.success) return err({ kind: 'bad_response' });
      const data = reply.data;
      return ok({
        id: data.id,
        name: data.name,
        mimeType: data.mimeType,
        size: data.size === undefined ? null : Number(data.size),
        modifiedTime: data.modifiedTime ?? null,
        trashed: data.trashed === true,
        canDownload: data.capabilities?.canDownload !== false,
        shortcutTargetId: data.shortcutDetails?.targetId ?? null,
        shortcutTargetMimeType: data.shortcutDetails?.targetMimeType ?? null,
      });
    },

    readContent: async (accessToken, fileId, plan) => {
      const url =
        plan.kind === 'export'
          ? `${GOOGLE_ENDPOINTS.drive}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(plan.format.mimeType)}`
          : `${GOOGLE_ENDPOINTS.drive}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const deadlineAt = now() + DRIVE_LIMITS.contentTotalMs;

      const openOnce = async (): Promise<Result<OpenResponse, GoogleFailure>> => {
        const left = deadlineAt - now();
        if (left <= 0) return err({ kind: 'timeout' });
        const opened = await http.open(url, {
          headers: { authorization: `Bearer ${accessToken}` },
          timeoutMs: Math.min(DRIVE_LIMITS.contentFirstByteMs, left),
        });
        return opened.ok ? ok(opened.value) : err(driveFailure(opened.error));
      };

      // `open` makes one attempt, so the retry is here: a 429, a 403 "slow down", a 5xx or a
      // dropped connection may be different in a moment, and this is a GET, so it is safe.
      // A first byte that never came is not retried: Google may still be preparing an export,
      // and asking again starts that over.
      const opened = await busyRetry(
        openOnce,
        deadlineAt,
        (failure) => failure.kind === 'busy' || failure.kind === 'unreachable',
      );
      if (!opened.ok) return opened;

      const declared = Number(opened.value.headers.get('content-length') ?? '');
      const read = await readCapped(opened.value.body, {
        maxBytes: DRIVE_LIMITS.maxBytes,
        deadlineAt,
        now,
        declaredLength: Number.isFinite(declared) && declared > 0 ? declared : null,
      });
      if (!read.ok) {
        if (read.why === 'too_large') return err({ kind: 'too_large', received: read.received });
        return err({ kind: read.why === 'timeout' ? 'timeout' : 'unreachable' });
      }
      const contentType = opened.value.headers.get('content-type');
      return ok({
        bytes: read.bytes,
        contentType:
          contentType === null ? null : (contentType.split(';')[0] ?? '').trim().toLowerCase(),
      });
    },
  };
}
