/**
 * GoHighLevel API client (Milestone 4 part 1). READ-ONLY: every method issues a GET and
 * nothing else — there is no code path here that can create, modify or delete anything
 * in the client's live CRM. Writes arrive in part 4 as a separate, audited module.
 *
 * What every call gets, from src/lib/http.ts (CLAUDE.md rule 8): a timeout, retry with
 * exponential backoff and jitter on 429 / 5xx / timeouts / transport failures (GET is
 * idempotent, so retrying is safe), a cap on retries, and a per-origin circuit breaker.
 * On top of that, this module:
 *
 *   - paces itself on GHL's own rate-limit headers (100 requests per 10-second window on
 *     this account, read from `x-ratelimit-*` on 12 Sep 2026): when the remaining count
 *     drops to the configured floor it waits out the window instead of provoking a 429;
 *   - validates every response against src/lib/crm/ghl/types.ts and rejects — logs and
 *     counts, never writes — any record that does not match; a malformed envelope fails
 *     the whole call;
 *   - turns a 401 into a LOUD, unambiguous UNAUTHENTICATED error. An expired Anthropic
 *     key once sat unnoticed until the client reported it; a dead GHL token must be
 *     visible in the logs on the first request and must never be mistaken for "no data";
 *   - pages opportunities to exhaustion on the `startAfterId` / `startAfter` cursor, with
 *     a hard cap that fails the run rather than truncating it, and refuses any record
 *     that names a pipeline other than the one requested (R22/R25: never another
 *     business's data, even if GHL offered it).
 *
 * The token is set as one request header and appears nowhere else.
 */
import {
  AppError,
  HttpStatusError,
  ValidationError,
  err,
  ok,
  type Result,
  type ValidationIssue,
} from '../../errors.js';
import {
  parseJsonBody,
  parseRetryAfterMs,
  type HttpClient,
  type HttpResponse,
} from '../../http.js';
import { RateLimitedError } from '../../llm/errors.js';
import type { Logger } from '../../logger.js';
import type { GhlConfig } from './config.js';
import {
  CONTACT_RESPONSE_SCHEMA,
  CUSTOM_FIELD_DEFINITION_SCHEMA,
  CUSTOM_FIELDS_RESPONSE_SCHEMA,
  OPPORTUNITY_PAGE_SCHEMA,
  OPPORTUNITY_SCHEMA,
  PIPELINES_RESPONSE_SCHEMA,
  type GhlContact,
  type GhlCustomFieldDefinition,
  type GhlOpportunity,
  type GhlPipeline,
} from './types.js';

export interface RejectedRecord {
  /** The record's id when it could be read, so the log names the object without its contents. */
  readonly id: string | null;
  readonly reason: string;
}

export interface OpportunityListing {
  readonly opportunities: readonly GhlOpportunity[];
  readonly pages: number;
  /** GHL's own `meta.total` from the first page, when it gave one. */
  readonly total: number | null;
  readonly rejected: readonly RejectedRecord[];
}

export interface CustomFieldListing {
  readonly definitions: readonly GhlCustomFieldDefinition[];
  readonly rejected: readonly RejectedRecord[];
}

export interface GhlClient {
  getPipelines(): Promise<Result<readonly GhlPipeline[]>>;
  listOpportunities(pipelineId: string): Promise<Result<OpportunityListing>>;
  /** `null` when GHL answers 404 — the contact was deleted or merged away. */
  getContact(contactId: string): Promise<Result<GhlContact | null>>;
  getCustomFields(): Promise<Result<CustomFieldListing>>;
  /** HTTP requests made so far, including retries. Recorded on the run. */
  requestsMade(): number;
}

export interface GhlClientDeps {
  readonly config: GhlConfig;
  readonly http: HttpClient;
  readonly log: Logger;
  /** Injected so the rate-limit pause is testable without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The message a dead token produces. Grep for it in the logs. */
export const GHL_TOKEN_REJECTED_MESSAGE =
  'GoHighLevel rejected the token (401): it is revoked, expired or wrong. This is NOT an empty pipeline — no data was read.';

/** The one place the token is used. The returned object is never logged. */
export function buildGhlHeaders(config: GhlConfig): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${config.token}`,
    version: config.apiVersion,
    accept: 'application/json',
  };
}

function zodIssues(issues: readonly { path: PropertyKey[]; message: string }[]): ValidationIssue[] {
  return issues
    .slice(0, 10)
    .map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

function idOf(record: unknown): string | null {
  if (typeof record === 'object' && record !== null && 'id' in record) {
    const id: unknown = record.id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export function createGhlClient(deps: GhlClientDeps): GhlClient {
  const { config, http } = deps;
  const log = deps.log.child({ component: 'ghl' });
  const sleep = deps.sleep ?? defaultSleep;
  let requests = 0;

  /**
   * One GET. Failures come back typed: UNAUTHENTICATED (401), FORBIDDEN (403),
   * RATE_LIMITED (429 after the retries), HTTP_STATUS (anything else, including 404 —
   * callers that expect a 404 check the status), TIMEOUT / NETWORK / CIRCUIT_OPEN.
   */
  const get = async (
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<Result<HttpResponse>> => {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await http.request(url.toString(), {
      method: 'GET',
      headers: buildGhlHeaders(config),
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    });

    if (!response.ok) {
      requests += 1;
      const failure = response.error;
      if (failure instanceof HttpStatusError) {
        requests += Math.max(0, numberOf(failure.context['attempt']) - 1);
        if (failure.status === 401) {
          const rejected = new AppError('UNAUTHENTICATED', GHL_TOKEN_REJECTED_MESSAGE, {
            context: { status: 401, path, alert: 'ghl_token_rejected' },
          });
          log.error(GHL_TOKEN_REJECTED_MESSAGE, { path, alert: 'ghl_token_rejected' });
          return err(rejected);
        }
        if (failure.status === 403) {
          const forbidden = new AppError(
            'FORBIDDEN',
            'GoHighLevel refused the request (403): the token lacks a scope, or the location id is wrong',
            { context: { status: 403, path } },
          );
          log.error('GoHighLevel refused the request (403)', { path });
          return err(forbidden);
        }
        if (failure.status === 429) {
          const retryAfter = failure.context['retryAfter'];
          const retryAfterMs = parseRetryAfterMs(
            typeof retryAfter === 'string' ? retryAfter : null,
            () => Date.now(),
          );
          log.error('GoHighLevel rate limit still in force after retries', {
            path,
            retryAfterMs,
            attempts: failure.context['attempt'],
          });
          return err(new RateLimitedError(retryAfterMs, { context: { provider: 'ghl', path } }));
        }
        if (failure.status !== 404) {
          log.error('GoHighLevel error response', {
            path,
            status: failure.status,
            attempts: failure.context['attempt'],
          });
        }
        return err(
          new HttpStatusError(`GoHighLevel responded ${failure.status}`, failure.status, {
            context: { provider: 'ghl', path, attempts: failure.context['attempt'] },
          }),
        );
      }
      log.error('GoHighLevel call failed', { path, code: failure.code });
      return err(failure);
    }

    requests += response.value.attempts;
    await paceOnHeaders(response.value);
    log.debug('ghl request', {
      path,
      status: response.value.status,
      attempts: response.value.attempts,
      remaining: response.value.headers.get('x-ratelimit-remaining'),
    });
    return ok(response.value);
  };

  /** GHL says how many requests are left in the current window; stay under it. */
  const paceOnHeaders = async (response: HttpResponse): Promise<void> => {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const interval = Number(response.headers.get('x-ratelimit-interval-milliseconds'));
    if (
      Number.isFinite(remaining) &&
      Number.isFinite(interval) &&
      interval > 0 &&
      remaining <= config.rateLimitFloor
    ) {
      log.info('ghl rate-limit window nearly spent; pausing', { remaining, waitMs: interval });
      await sleep(interval);
    }
  };

  const getJson = async (
    path: string,
    query: Readonly<Record<string, string>>,
  ): Promise<Result<unknown>> => {
    const response = await get(path, query);
    if (!response.ok) return response;
    const json = parseJsonBody(response.value);
    if (!json.ok) {
      log.error('GoHighLevel returned a body that is not JSON', { path });
      return err(json.error);
    }
    return ok(json.value);
  };

  const getPipelines = async (): Promise<Result<readonly GhlPipeline[]>> => {
    const json = await getJson('/opportunities/pipelines', { locationId: config.locationId });
    if (!json.ok) return json;
    const parsed = PIPELINES_RESPONSE_SCHEMA.safeParse(json.value);
    if (!parsed.success) {
      log.error('pipelines response did not match the expected shape; nothing read', {
        issues: parsed.error.issues.length,
      });
      return err(
        new ValidationError(
          'GoHighLevel pipelines response did not match the expected shape',
          zodIssues(parsed.error.issues),
        ),
      );
    }
    return ok(parsed.data.pipelines);
  };

  const listOpportunities = async (pipelineId: string): Promise<Result<OpportunityListing>> => {
    const byId = new Map<string, GhlOpportunity>();
    const rejected: RejectedRecord[] = [];
    let total: number | null = null;
    let cursor: { startAfterId: string; startAfter: number } | null = null;
    let pages = 0;

    for (;;) {
      if (pages >= config.maxPages) {
        log.error('pipeline exceeds the page cap; refusing to truncate', {
          pipelineId,
          pages,
          maxPages: config.maxPages,
          pageSize: config.pageSize,
        });
        return err(
          new AppError(
            'INTERNAL',
            `GoHighLevel pipeline has more than ${config.maxPages} pages of ${config.pageSize}; raise GHL_MAX_PAGES or revisit the sync design`,
            { context: { reason: 'LIMIT', pipelineId, maxPages: config.maxPages } },
          ),
        );
      }
      const query: Record<string, string> = {
        location_id: config.locationId,
        pipeline_id: pipelineId,
        limit: String(config.pageSize),
      };
      if (cursor !== null) {
        query['startAfterId'] = cursor.startAfterId;
        query['startAfter'] = String(cursor.startAfter);
      }
      const json = await getJson('/opportunities/search', query);
      if (!json.ok) return json;
      pages += 1;

      const page = OPPORTUNITY_PAGE_SCHEMA.safeParse(json.value);
      if (!page.success) {
        log.error('opportunities page did not match the expected envelope; run aborted', {
          pipelineId,
          page: pages,
          issues: page.error.issues.length,
        });
        return err(
          new ValidationError(
            'GoHighLevel opportunities page did not match the expected shape',
            zodIssues(page.error.issues),
            { context: { page: pages } },
          ),
        );
      }
      if (total === null && typeof page.data.meta?.total === 'number') total = page.data.meta.total;

      for (const record of page.data.opportunities) {
        const parsed = OPPORTUNITY_SCHEMA.safeParse(record);
        if (!parsed.success) {
          const id = idOf(record);
          rejected.push({ id, reason: 'shape' });
          log.warn('opportunity rejected: shape mismatch', {
            opportunityId: id,
            issues: zodIssues(parsed.error.issues),
          });
          continue;
        }
        if (parsed.data.pipelineId !== pipelineId) {
          // Never hold another pipeline's record, whatever the search returned.
          rejected.push({ id: parsed.data.id, reason: 'wrong_pipeline' });
          log.warn('opportunity rejected: belongs to another pipeline', {
            opportunityId: parsed.data.id,
            pipelineId: parsed.data.pipelineId,
          });
          continue;
        }
        if (!byId.has(parsed.data.id)) byId.set(parsed.data.id, parsed.data);
      }

      const count = page.data.opportunities.length;
      const nextId = page.data.meta?.startAfterId;
      const nextAfter = page.data.meta?.startAfter;
      const hasCursor =
        typeof nextId === 'string' && nextId !== '' && typeof nextAfter === 'number';
      if (count === 0 || count < config.pageSize || !hasCursor) break;
      if (cursor !== null && cursor.startAfterId === nextId) {
        // The same cursor twice would loop forever; stop and let the total check speak.
        log.warn('opportunities cursor did not advance; stopping pagination', { page: pages });
        break;
      }
      cursor = { startAfterId: nextId, startAfter: nextAfter };
    }

    const opportunities = [...byId.values()];
    if (total !== null && opportunities.length + rejected.length < total) {
      log.warn('fetched fewer opportunities than GHL reported in total', {
        pipelineId,
        fetched: opportunities.length,
        rejected: rejected.length,
        total,
      });
    }
    return ok({ opportunities, pages, total, rejected });
  };

  const getContact = async (contactId: string): Promise<Result<GhlContact | null>> => {
    const json = await getJson(`/contacts/${encodeURIComponent(contactId)}`, {});
    if (!json.ok) {
      if (json.error instanceof HttpStatusError && json.error.status === 404) {
        log.warn('contact not found in GoHighLevel (404)', { contactId });
        return ok(null);
      }
      return json;
    }
    const parsed = CONTACT_RESPONSE_SCHEMA.safeParse(json.value);
    if (!parsed.success) {
      log.warn('contact rejected: shape mismatch', {
        contactId,
        issues: zodIssues(parsed.error.issues),
      });
      return err(
        new ValidationError(
          'GoHighLevel contact did not match the expected shape',
          zodIssues(parsed.error.issues),
          { context: { contactId } },
        ),
      );
    }
    return ok(parsed.data.contact);
  };

  const getCustomFields = async (): Promise<Result<CustomFieldListing>> => {
    const json = await getJson(
      `/locations/${encodeURIComponent(config.locationId)}/customFields`,
      {},
    );
    if (!json.ok) return json;
    const envelope = CUSTOM_FIELDS_RESPONSE_SCHEMA.safeParse(json.value);
    if (!envelope.success) {
      log.error('custom fields response did not match the expected envelope', {
        issues: envelope.error.issues.length,
      });
      return err(
        new ValidationError(
          'GoHighLevel custom fields response did not match the expected shape',
          zodIssues(envelope.error.issues),
        ),
      );
    }
    const definitions: GhlCustomFieldDefinition[] = [];
    const rejected: RejectedRecord[] = [];
    for (const record of envelope.data.customFields) {
      const parsed = CUSTOM_FIELD_DEFINITION_SCHEMA.safeParse(record);
      if (!parsed.success) {
        const id = idOf(record);
        rejected.push({ id, reason: 'shape' });
        log.warn('custom field definition rejected: shape mismatch', {
          fieldId: id,
          issues: zodIssues(parsed.error.issues),
        });
        continue;
      }
      definitions.push(parsed.data);
    }
    return ok({ definitions, rejected });
  };

  return {
    getPipelines,
    listOpportunities,
    getContact,
    getCustomFields,
    requestsMade: () => requests,
  };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
