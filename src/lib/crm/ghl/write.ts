/**
 * GoHighLevel WRITE client (Milestone 4 part 4) — the only module in the repository that
 * sends anything but a GET to GoHighLevel. Three calls, each confirmed against the live
 * account with a test opportunity on 24 Sep 2026 (MEMORY.md):
 *
 *   getOpportunity  GET  /opportunities/{id}                   → the live record, or null on 404
 *   updateStage     PUT  /opportunities/{id} {pipelineId, pipelineStageId}
 *   createNote      POST /contacts/{contactId}/notes {body}
 *
 * What every write gets, and what it deliberately does NOT get:
 *
 *   - ONE attempt at the HTTP layer. src/lib/http.ts retries only idempotent requests and a
 *     PUT / POST is not declared idempotent here, so a timeout, a dropped connection or a
 *     5xx comes back as exactly that and the caller (moves.ts) decides — by re-READING the
 *     opportunity, never by sending the write again (CLAUDE.md rule 8).
 *   - The one exception is 429: GoHighLevel refused the request, so nothing was applied and
 *     sending it again is safe. Waited out (Retry-After, capped) and retried up to
 *     WRITE_RATE_LIMIT_RETRIES times, then reported as RATE_LIMITED.
 *   - The configured pipeline id in every stage write, so the request itself says which
 *     pipeline it belongs to; the caller has already checked the opportunity is in it (R22,
 *     R25). GoHighLevel refuses a stage from another pipeline with
 *     OPPORTUNITY_STAGE_ID_INVALID regardless — observed live — and that refusal is typed here.
 *   - The same rate-limit pacing as the read client: when `x-ratelimit-remaining` reaches the
 *     floor the next request waits out the window.
 *   - Every response validated against types.ts before it is trusted; the `contact`
 *     sub-object GoHighLevel returns on an opportunity (name, email) is stripped by the
 *     schema and never logged.
 *
 * The token is set as one request header and appears nowhere else.
 */
import { AppError, HttpStatusError, ValidationError, err, ok, type Result } from '../../errors.js';
import {
  parseJsonBody,
  parseRetryAfterMs,
  type HttpClient,
  type HttpResponse,
} from '../../http.js';
import { RateLimitedError } from '../../llm/errors.js';
import type { Logger } from '../../logger.js';
import { GHL_TOKEN_REJECTED_MESSAGE, buildGhlHeaders, rateLimitWaitMs } from './client.js';
import type { GhlConfig } from './config.js';
import {
  GHL_ERROR_BODY_SCHEMA,
  NOTE_RESPONSE_SCHEMA,
  OPPORTUNITY_RESPONSE_SCHEMA,
  type GhlNote,
  type GhlOpportunity,
} from './types.js';

/** Retries of a write after a 429 only. Every other failure is one attempt. */
export const WRITE_RATE_LIMIT_RETRIES = 2;
/** Longest a 429 is waited out before giving up; the window is 10 s on this account. */
export const WRITE_RATE_LIMIT_MAX_WAIT_MS = 12_000;

/**
 * A definite "no" from GoHighLevel to a write: nothing was applied, retrying cannot help.
 *   STAGE_INVALID          400 OPPORTUNITY_STAGE_ID_INVALID — not a stage of this pipeline
 *   OPPORTUNITY_NOT_FOUND  404 — deleted, or never existed
 *   CONTACT_NOT_FOUND      400 on a note — the contact is gone
 *   NOTE_REJECTED          422 — GoHighLevel refused the body (empty)
 */
export type WriteRefusal =
  'STAGE_INVALID' | 'OPPORTUNITY_NOT_FOUND' | 'CONTACT_NOT_FOUND' | 'NOTE_REJECTED';

export class GhlWriteRefusedError extends AppError {
  readonly reason: WriteRefusal;
  readonly status: number;
  constructor(reason: WriteRefusal, status: number, message: string) {
    super('CONFLICT', message, { retryable: false, context: { reason, status } });
    this.name = 'GhlWriteRefusedError';
    this.reason = reason;
    this.status = status;
  }
}

export interface StageUpdate {
  readonly opportunity: GhlOpportunity;
  readonly status: number;
  /** Requests it took, including any 429 retries. */
  readonly attempts: number;
}

export interface GhlWriteClient {
  /** `null` when GoHighLevel answers 404 — deleted since the mirror last saw it. */
  getOpportunity(opportunityId: string): Promise<Result<GhlOpportunity | null>>;
  updateStage(opportunityId: string, stageId: string): Promise<Result<StageUpdate>>;
  createNote(contactId: string, body: string): Promise<Result<GhlNote>>;
  requestsMade(): number;
}

export interface GhlWriteClientDeps {
  readonly config: GhlConfig;
  readonly http: HttpClient;
  readonly log: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function issues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): {
  path: string;
  message: string;
}[] {
  return error.issues
    .slice(0, 10)
    .map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/**
 * GoHighLevel's `code` / `error` from an error body, or null when there is none. http.ts
 * keeps a 500-character snippet of an error body, and the stage refusal lists every valid
 * stage id before its `code`, so a truncated snippet is expected: the whole body is parsed
 * when it can be, and the two fields are read by pattern when it cannot.
 */
export function readGhlErrorCode(bodyText: string): { code: string | null; error: string | null } {
  try {
    const parsed = GHL_ERROR_BODY_SCHEMA.safeParse(JSON.parse(bodyText));
    if (parsed.success) return { code: parsed.data.code ?? null, error: parsed.data.error ?? null };
  } catch {
    // Truncated or not JSON: fall through to the pattern.
  }
  // No closing quote required: the snippet may end inside the code itself.
  const code = /"code"\s*:\s*"([A-Z0-9_]+)/.exec(bodyText)?.[1] ?? null;
  const error = /"error"\s*:\s*"([^"]*)"/.exec(bodyText)?.[1] ?? null;
  return { code, error };
}

/**
 * The stage refusal, as GoHighLevel writes it: 400 with `OPPORTUNITY_STAGE_ID_INVALID` after
 * a message that lists every valid stage id — which is why the code may be cut off in the
 * snippet, and why the message's own opening words are accepted as the same answer.
 */
export function isStageInvalid(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const { code } = readGhlErrorCode(bodyText);
  if (code !== null && 'OPPORTUNITY_STAGE_ID_INVALID'.startsWith(code)) return true;
  return bodyText.includes('stageId must be one of');
}

/** The body snippet http.ts kept on a status error, or an empty string. */
function snippetOf(failure: HttpStatusError): string {
  const raw = failure.context['bodySnippet'];
  return typeof raw === 'string' ? raw : '';
}

export function createGhlWriteClient(deps: GhlWriteClientDeps): GhlWriteClient {
  const { config, http } = deps;
  const log = deps.log.child({ component: 'ghl-write' });
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let requests = 0;

  /**
   * One request, one attempt (plus 429 waits). Failures typed: UNAUTHENTICATED (401),
   * FORBIDDEN (403), RATE_LIMITED (429 after the waits), HttpStatusError for anything else
   * non-2xx (the caller reads `status` and the body's `code`), TIMEOUT / NETWORK /
   * CIRCUIT_OPEN from http.ts.
   */
  const send = async (
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Result<HttpResponse & { readonly attempts: number }>> => {
    const url = `${config.baseUrl}${path}`;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      requests += 1;
      const response = await http.request(url, {
        method,
        headers: {
          ...buildGhlHeaders(config),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        timeoutMs: config.timeoutMs,
        // Rule 8: a write is sent once. GET is idempotent by method and may retry.
        retries: method === 'GET' ? config.retries : 0,
        idempotent: method === 'GET',
      });

      if (response.ok) {
        const wait = rateLimitWaitMs(response.value, config.rateLimitFloor);
        if (wait > 0) {
          log.info('ghl rate-limit window nearly spent; pausing', { waitMs: wait, path });
          await sleep(wait);
        }
        log.debug('ghl write request', { method, path, status: response.value.status, attempts });
        return ok({ ...response.value, attempts });
      }

      const failure = response.error;
      if (failure instanceof HttpStatusError) {
        if (failure.status === 401) {
          log.error(GHL_TOKEN_REJECTED_MESSAGE, { method, path, alert: 'ghl_token_rejected' });
          return err(
            new AppError('UNAUTHENTICATED', GHL_TOKEN_REJECTED_MESSAGE, {
              context: { status: 401, path, alert: 'ghl_token_rejected' },
            }),
          );
        }
        if (failure.status === 403) {
          log.error('GoHighLevel refused the write (403)', { method, path });
          return err(
            new AppError(
              'FORBIDDEN',
              'GoHighLevel refused the request (403): the token lacks a scope, or the location id is wrong',
              { context: { status: 403, path } },
            ),
          );
        }
        if (failure.status === 429) {
          const header = failure.context['retryAfter'];
          const retryAfter = parseRetryAfterMs(typeof header === 'string' ? header : null, now);
          const wait = Math.min(retryAfter ?? 1_000, WRITE_RATE_LIMIT_MAX_WAIT_MS);
          if (attempts <= WRITE_RATE_LIMIT_RETRIES) {
            log.warn('GoHighLevel rate-limited the write; waiting, then retrying', {
              method,
              path,
              waitMs: wait,
              attempt: attempts,
            });
            await sleep(wait);
            continue;
          }
          log.error('GoHighLevel rate limit still in force after retries', { method, path });
          return err(new RateLimitedError(retryAfter, { context: { provider: 'ghl', path } }));
        }
        log.warn('GoHighLevel answered the write with an error status', {
          method,
          path,
          status: failure.status,
        });
        return err(failure);
      }
      log.error('GoHighLevel write call failed', { method, path, code: failure.code });
      return err(failure);
    }
  };

  const getOpportunity = async (opportunityId: string): Promise<Result<GhlOpportunity | null>> => {
    const path = `/opportunities/${encodeURIComponent(opportunityId)}`;
    const response = await send('GET', path);
    if (!response.ok) {
      if (response.error instanceof HttpStatusError && response.error.status === 404) {
        log.warn('opportunity not found in GoHighLevel (404)', { opportunityId });
        return ok(null);
      }
      return response;
    }
    return parseOpportunity(response.value, opportunityId);
  };

  const parseOpportunity = (
    response: HttpResponse,
    opportunityId: string,
  ): Result<GhlOpportunity> => {
    const json = parseJsonBody(response);
    if (!json.ok) {
      log.error('GoHighLevel opportunity body is not JSON', { opportunityId });
      return err(json.error);
    }
    const parsed = OPPORTUNITY_RESPONSE_SCHEMA.safeParse(json.value);
    if (!parsed.success) {
      log.error('opportunity response did not match the expected shape', {
        opportunityId,
        issues: issues(parsed.error),
      });
      return err(
        new ValidationError(
          'GoHighLevel opportunity response did not match the expected shape',
          issues(parsed.error),
          { context: { opportunityId } },
        ),
      );
    }
    return ok(parsed.data.opportunity);
  };

  const updateStage = async (
    opportunityId: string,
    stageId: string,
  ): Promise<Result<StageUpdate>> => {
    const path = `/opportunities/${encodeURIComponent(opportunityId)}`;
    const response = await send('PUT', path, {
      pipelineId: config.pipelineId,
      pipelineStageId: stageId,
    });
    if (!response.ok) {
      const failure = response.error;
      if (failure instanceof HttpStatusError) {
        const snippet = snippetOf(failure);
        const { code } = readGhlErrorCode(snippet);
        if (failure.status === 404 || code === 'OPPORTUNITY_NOT_FOUND') {
          return err(
            new GhlWriteRefusedError(
              'OPPORTUNITY_NOT_FOUND',
              failure.status,
              'GoHighLevel has no opportunity with this id',
            ),
          );
        }
        if (isStageInvalid(failure.status, snippet)) {
          return err(
            new GhlWriteRefusedError(
              'STAGE_INVALID',
              400,
              'GoHighLevel refused the stage: it is not a stage of this pipeline',
            ),
          );
        }
      }
      return err(failure);
    }
    const opportunity = parseOpportunity(response.value, opportunityId);
    if (!opportunity.ok) return opportunity;
    return ok({
      opportunity: opportunity.value,
      status: response.value.status,
      attempts: response.value.attempts,
    });
  };

  const createNote = async (contactId: string, body: string): Promise<Result<GhlNote>> => {
    const path = `/contacts/${encodeURIComponent(contactId)}/notes`;
    const response = await send('POST', path, { body });
    if (!response.ok) {
      const failure = response.error;
      if (failure instanceof HttpStatusError) {
        const text = snippetOf(failure);
        const { error } = readGhlErrorCode(text);
        if (failure.status === 422) {
          return err(
            new GhlWriteRefusedError('NOTE_REJECTED', 422, 'GoHighLevel refused the note body'),
          );
        }
        if (
          failure.status === 404 ||
          (failure.status === 400 && (error ?? '').toLowerCase().includes('not found'))
        ) {
          return err(
            new GhlWriteRefusedError(
              'CONTACT_NOT_FOUND',
              failure.status,
              'GoHighLevel has no contact with this id',
            ),
          );
        }
      }
      return err(failure);
    }
    const json = parseJsonBody(response.value);
    if (!json.ok) {
      log.error('GoHighLevel note body is not JSON', { contactId });
      return err(json.error);
    }
    const parsed = NOTE_RESPONSE_SCHEMA.safeParse(json.value);
    if (!parsed.success) {
      log.error('note response did not match the expected shape', {
        contactId,
        issues: issues(parsed.error),
      });
      return err(
        new ValidationError(
          'GoHighLevel note response did not match the expected shape',
          issues(parsed.error),
          { context: { contactId } },
        ),
      );
    }
    return ok(parsed.data.note);
  };

  return { getOpportunity, updateStage, createNote, requestsMade: () => requests };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
