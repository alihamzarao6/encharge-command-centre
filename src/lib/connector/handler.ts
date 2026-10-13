/**
 * The connector's endpoint (MCP connector, stage 1 — docs/MEMORY.md 13 Oct 2026). Runtime-
 * agnostic and it never throws: the Supabase Edge Function `connector` is a thin adapter
 * over `handleConnectorRequest`, exactly as `crm` is over `handleCrmRequest`.
 *
 * THIS IS ON THE PUBLIC INTERNET with a key as the only thing in front of the client's live
 * CRM, so every request is treated as hostile and refused as early and as cheaply as it can
 * be, in this order:
 *
 *   1. not a POST                          405   (GET and DELETE: this server opens no stream)
 *   2. anything in the query string        400   (a key in an address is a key in a log)
 *   3. a browser Origin not on the list    403
 *   4. no well-formed key in the header    401   — no database call has been made yet
 *   5. a body over the size limit          413
 *   6. THE KEY IS CHECKED IN THE DATABASE  401 / 429 / 503 — before ANYTHING about the body
 *      is answered, including that it was not JSON. An unauthenticated caller learns one
 *      thing from this endpoint: that it is not authenticated.
 *   7. only then: the protocol's own answers.
 *
 * Step 6 is one database call that also applies the rate limit, records the request and, for
 * a tool call, performs the read — as the key's user, under the mirror's row-level security
 * (store.ts, migration 20261013010000). If that call cannot be made, nothing is served.
 *
 * WHAT IS LOGGED: who (the key's public id), what (the method and the tool), the outcome,
 * the status, how long, how many records, how many bytes. WHAT IS NEVER LOGGED: the key, the
 * Authorization header, the address, an argument, a search's text, anything a tool returned.
 * The address is not even passed in — the adapter says only whether it had a query string.
 */
import type { Logger } from '../logger.js';
import type { Authenticator } from './auth.js';
import type { ConnectorConfig } from './config.js';
import {
  APP_CODE,
  CACHE_SCOPE,
  HEADERLESS_VERSION,
  LIST_TTL_MS,
  MAX_BATCH,
  RPC_CODE,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  SUPPORTED_VERSIONS,
  finishResult,
  isRecord,
  negotiateLegacyVersion,
  parseMessage,
  resolveVersion,
  rpcError,
  rpcResult,
  type Era,
  type HeaderReader,
  type JsonRpcId,
  type RpcRequest,
} from './protocol.js';
import type { ConnectorCallReply, ConnectorStore } from './store.js';
import {
  READ_FAILED_MESSAGE,
  TOOLS,
  isToolName,
  prepareCall,
  rateLimitMessage,
  sanitiseText,
  shapeToolReply,
  toolError,
  type PreparedCall,
  type StoreArgs,
  type ToolAnswer,
  type ToolName,
} from './tools.js';

export type BodyRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too_large' | 'unreadable' };

export interface ConnectorHttpRequest {
  readonly method: string;
  /** Whether the address carried a query string. The address itself is never handed over. */
  readonly hasQuery: boolean;
  readonly headers: HeaderReader;
  /** The body as text, or a refusal once it passes `maxBytes`. */
  readBody(maxBytes: number): Promise<BodyRead>;
}

export interface ConnectorHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface ConnectorDeps {
  readonly config: ConnectorConfig;
  readonly authenticator: Authenticator;
  readonly store: ConnectorStore;
  readonly log: Logger;
  readonly now?: () => number;
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** One sentence for every way a key can be wrong: which way it was is in our log only. */
export const UNAUTHORIZED_MESSAGE =
  'Not authorised. Send a Command Centre key in the Authorization header, as "Bearer <key>". If the key is right it may have been switched off: ask for a new one.';
export const UNAVAILABLE_MESSAGE =
  'The Command Centre cannot answer just now. Nothing is wrong with the request: try again in a minute.';
export const UNAVAILABLE_RETRY_SECONDS = 30;

/** What the record of calls may say a request was. Never the caller's own text. */
const KNOWN_METHODS: readonly string[] = [
  'initialize',
  'notifications/initialized',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
];

function ledgerMethod(method: string): string {
  return KNOWN_METHODS.includes(method) ? method : 'other';
}

function respond(
  status: number,
  body: object | null,
  extra: Readonly<Record<string, string>> = {},
): ConnectorHttpResponse {
  return {
    status,
    headers:
      body === null ? { 'cache-control': 'no-store', ...extra } : { ...BASE_HEADERS, ...extra },
    body: body === null ? null : JSON.stringify(body),
  };
}

function refusal(
  status: number,
  code: number,
  message: string,
  reason: string,
  extra: Readonly<Record<string, string>> = {},
  id: JsonRpcId | null = null,
  data: Readonly<Record<string, unknown>> = {},
): ConnectorHttpResponse {
  return respond(status, rpcError(id, code, message, { reason, ...data }), extra);
}

/** What one message comes to, once the key has been checked. */
interface Outcome {
  readonly status: number;
  /** Null: a notification, which is answered 202 with no body. */
  readonly body: object | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly outcome: string;
  readonly records: number;
}

type Granted = Extract<ConnectorCallReply, { readonly outcome: 'ok' | 'read_failed' }>;

/** One message, judged without I/O: what to record it as, what to read, how to answer. */
interface Plan {
  readonly method: string;
  readonly tool: ToolName | null;
  readonly args: StoreArgs | null;
  readonly era: Era | null;
  readonly version: string | null;
  /** A tool call: a rate-limit refusal is a result the model can read, not an HTTP 429. */
  readonly isToolCall: boolean;
  readonly id: JsonRpcId | null;
  finish(granted: Granted): Outcome;
}

function toolResult(era: Era, id: JsonRpcId, answer: ToolAnswer): Outcome {
  return {
    status: 200,
    body: rpcResult(
      id,
      finishResult(era, {
        content: [{ type: 'text', text: answer.text }],
        isError: answer.isError,
      }),
    ),
    outcome: answer.outcome,
    records: answer.records,
  };
}

function protocolError(
  id: JsonRpcId | null,
  status: number,
  code: number,
  message: string,
  outcome: string,
  data?: Readonly<Record<string, unknown>>,
): Outcome {
  return { status, body: rpcError(id, code, message, data), outcome, records: 0 };
}

function fixed(base: Omit<Plan, 'finish'>, outcome: Outcome): Plan {
  return { ...base, finish: () => outcome };
}

function planToolCall(base: Omit<Plan, 'finish'>, era: Era, request: RpcRequest): Plan {
  const invalidParams = (message: string, outcome: string): Plan =>
    fixed(base, protocolError(request.id, 200, RPC_CODE.invalidParams, message, outcome));

  const name = request.params['name'];
  if (typeof name !== 'string' || name === '') {
    return invalidParams('Invalid params: name is required.', 'invalid');
  }
  if (!isToolName(name)) {
    // Echoed cleaned and short: it is the caller's own text, on its way back to the caller.
    return invalidParams(`Unknown tool: ${sanitiseText(name, 64).text}`, 'unknown_tool');
  }
  const rawArgs = request.params['arguments'];
  if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
    return invalidParams('Invalid params: arguments must be an object.', 'invalid');
  }
  const prepared: PreparedCall = prepareCall(name, rawArgs);
  if (!prepared.ok) {
    // Counted and recorded as a request, but nothing is read.
    return fixed(base, toolResult(era, request.id, toolError('bad_arguments', prepared.message)));
  }
  return {
    ...base,
    tool: prepared.tool,
    args: prepared.args,
    finish: (granted) =>
      toolResult(
        era,
        request.id,
        granted.outcome === 'read_failed'
          ? toolError('read_failed', READ_FAILED_MESSAGE)
          : shapeToolReply(prepared, granted.data),
      ),
  };
}

function planRequest(base: Omit<Plan, 'finish'>, era: Era, request: RpcRequest): Plan {
  const result = (value: Readonly<Record<string, unknown>>): Plan =>
    fixed(base, {
      status: 200,
      body: rpcResult(request.id, finishResult(era, value)),
      outcome: 'ok',
      records: 0,
    });
  const notFound = (): Plan =>
    fixed(
      base,
      protocolError(
        request.id,
        // The current revision answers an unknown method 404; the earlier ones, in a 200.
        era === 'modern' ? 404 : 200,
        RPC_CODE.methodNotFound,
        'Method not found',
        'method_not_found',
      ),
    );

  switch (request.method) {
    case 'initialize': {
      const version = negotiateLegacyVersion(request.params['protocolVersion']);
      if (version === null) {
        return fixed(
          base,
          protocolError(
            request.id,
            200,
            RPC_CODE.invalidParams,
            'Invalid params: protocolVersion is required.',
            'invalid',
            { supported: SUPPORTED_VERSIONS },
          ),
        );
      }
      return result({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'ping':
      return era === 'legacy' ? result({}) : notFound();
    case 'server/discover':
      return era === 'modern'
        ? result({
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            instructions: SERVER_INSTRUCTIONS,
            ttlMs: LIST_TTL_MS,
            cacheScope: CACHE_SCOPE,
          })
        : notFound();
    case 'tools/list': {
      if (request.params['cursor'] !== undefined) {
        return fixed(
          base,
          protocolError(
            request.id,
            200,
            RPC_CODE.invalidParams,
            'Invalid params: the tool list is one page; send no cursor.',
            'invalid',
          ),
        );
      }
      return result(
        era === 'modern'
          ? { tools: TOOLS, ttlMs: LIST_TTL_MS, cacheScope: CACHE_SCOPE }
          : { tools: TOOLS },
      );
    }
    case 'tools/call':
      return planToolCall(base, era, request);
    default:
      return notFound();
  }
}

/** One parsed JSON value → the plan for it. Pure: no key has been checked yet. */
export function planMessage(headers: HeaderReader, raw: unknown, inBatch: boolean): Plan {
  const message = parseMessage(raw);
  if (message.kind === 'invalid') {
    return fixed(
      {
        method: 'invalid',
        tool: null,
        args: null,
        era: null,
        version: null,
        isToolCall: false,
        id: message.id,
      },
      protocolError(message.id, 400, message.code, message.message, 'invalid'),
    );
  }
  const id = message.kind === 'request' ? message.id : null;
  const base: Omit<Plan, 'finish'> = {
    method: ledgerMethod(message.method),
    tool: null,
    args: null,
    era: null,
    version: null,
    isToolCall: message.kind === 'request' && message.method === 'tools/call',
    id,
  };
  if (inBatch && message.method === 'initialize') {
    return fixed(
      base,
      protocolError(
        id,
        400,
        RPC_CODE.invalidRequest,
        'Invalid Request: initialize cannot be part of a batch.',
        'invalid',
      ),
    );
  }
  const resolved = resolveVersion(headers, message);
  if (!resolved.ok) {
    return fixed(
      base,
      protocolError(id, resolved.status, resolved.code, resolved.message, 'invalid', resolved.data),
    );
  }
  const placed = { ...base, era: resolved.era, version: resolved.version };
  if (message.kind === 'notification') {
    return fixed(placed, { status: 202, body: null, outcome: 'ok', records: 0 });
  }
  return planRequest(placed, resolved.era, message);
}

interface Checked {
  readonly kind: 'answered';
  readonly outcome: Outcome;
}
interface Refused {
  readonly kind: 'refused';
  readonly response: ConnectorHttpResponse;
  readonly outcome: string;
  readonly reason?: string;
}

interface LogEntry {
  readonly caller: string | null;
  readonly method: string;
  readonly tool: string | null;
  readonly outcome: string;
  readonly status: number;
  readonly records: number;
  readonly bytesOut: number;
  readonly era: Era | null;
  readonly version: string | null;
  readonly reason?: string;
}

const encoder = new TextEncoder();
const bytesOf = (body: string | null): number => (body === null ? 0 : encoder.encode(body).length);

export async function handleConnectorRequest(
  deps: ConnectorDeps,
  request: ConnectorHttpRequest,
): Promise<ConnectorHttpResponse> {
  const now = deps.now ?? Date.now;
  const started = now();
  const record = (entry: LogEntry): void => {
    deps.log.info('connector: request', { ...entry, durationMs: Math.max(0, now() - started) });
  };
  const early = (
    response: ConnectorHttpResponse,
    outcome: string,
    reason?: string,
  ): ConnectorHttpResponse => {
    record({
      caller: null,
      method: 'none',
      tool: null,
      outcome,
      status: response.status,
      records: 0,
      bytesOut: bytesOf(response.body),
      era: null,
      version: null,
      ...(reason === undefined ? {} : { reason }),
    });
    return response;
  };

  try {
    if (request.method.toUpperCase() !== 'POST') {
      return early(
        refusal(
          405,
          APP_CODE.methodNotAllowed,
          'Method not allowed. This endpoint answers POST only and opens no stream.',
          'method_not_allowed',
          { allow: 'POST' },
        ),
        'method_not_allowed',
      );
    }
    if (request.hasQuery) {
      return early(
        refusal(
          400,
          RPC_CODE.invalidRequest,
          'Invalid Request: this address takes no query parameters. The key goes in the Authorization header and never in the address — a key that was put in an address should be treated as exposed and replaced.',
          'query_not_allowed',
        ),
        'query_refused',
      );
    }
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== '' && !deps.config.allowedOrigins.includes(origin)) {
      return early(
        refusal(
          403,
          APP_CODE.originRefused,
          'Forbidden: this origin may not call this endpoint.',
          'origin_not_allowed',
        ),
        'origin_refused',
      );
    }

    const unauthorized = (): ConnectorHttpResponse =>
      refusal(401, APP_CODE.unauthorized, UNAUTHORIZED_MESSAGE, 'unauthorized', {
        'www-authenticate': deps.authenticator.challenge(),
      });

    const attempt = await deps.authenticator.authenticate(request.headers);
    if (!attempt.ok) return early(unauthorized(), 'unauthenticated', attempt.reason);
    const credential = attempt.credential;

    const body = await request.readBody(deps.config.maxBodyBytes);
    if (!body.ok && body.reason === 'too_large') {
      return early(refusal(413, APP_CODE.tooLarge, 'Request too large.', 'too_large'), 'too_large');
    }

    const logOutcome = (caller: string, plan: Plan, outcome: Outcome): void => {
      record({
        caller,
        method: plan.method,
        tool: plan.tool,
        outcome: outcome.outcome,
        status: outcome.status,
        records: outcome.records,
        bytesOut: outcome.body === null ? 0 : bytesOf(JSON.stringify(outcome.body)),
        era: plan.era,
        version: plan.version,
      });
    };

    /** The one database call for one message: the key, the limits, the record, the read. */
    const check = async (plan: Plan, inBatch: boolean): Promise<Checked | Refused> => {
      const reply = await deps.store.call({
        credential,
        method: plan.method,
        tool: plan.tool,
        args: plan.args,
        pipelineId: deps.config.pipelineId,
        perMinute: deps.config.perMinute,
        perDay: deps.config.perDay,
      });
      if (!reply.ok) {
        deps.log.error('connector: the database call failed', { error: reply.error });
        return {
          kind: 'refused',
          outcome: 'unavailable',
          response: refusal(
            503,
            APP_CODE.unavailable,
            UNAVAILABLE_MESSAGE,
            'unavailable',
            { 'retry-after': String(UNAVAILABLE_RETRY_SECONDS) },
            plan.id,
            { retry_after_seconds: UNAVAILABLE_RETRY_SECONDS },
          ),
        };
      }
      const value = reply.value;
      if (value.outcome === 'unauthenticated') {
        record({
          caller: value.keyId,
          method: plan.method,
          tool: null,
          outcome: 'unauthenticated',
          status: 401,
          records: 0,
          bytesOut: 0,
          era: plan.era,
          version: plan.version,
          reason: value.reason,
        });
        return { kind: 'refused', outcome: 'logged', response: unauthorized() };
      }
      if (value.outcome === 'rate_limited') {
        const message = rateLimitMessage(value.window, value.retryAfterSeconds);
        const data = { reason: 'rate_limited', retry_after_seconds: value.retryAfterSeconds };
        let outcome: Outcome;
        if (plan.isToolCall && plan.era !== null && plan.id !== null) {
          // A tool call's refusal is a result the model reads and can act on.
          outcome = toolResult(plan.era, plan.id, toolError('rate_limited', message));
        } else {
          outcome = {
            status: inBatch ? 200 : 429,
            body:
              plan.id === null && inBatch
                ? null
                : rpcError(plan.id, APP_CODE.rateLimited, message, data),
            headers: { 'retry-after': String(value.retryAfterSeconds) },
            outcome: 'rate_limited',
            records: 0,
          };
        }
        logOutcome(value.keyId, plan, outcome);
        return { kind: 'answered', outcome };
      }
      const outcome = plan.finish(value);
      logOutcome(value.keyId, plan, outcome);
      return { kind: 'answered', outcome };
    };

    const invalidPlan = (code: number, message: string): Plan =>
      fixed(
        {
          method: 'invalid',
          tool: null,
          args: null,
          era: null,
          version: null,
          isToolCall: false,
          id: null,
        },
        protocolError(null, 400, code, message, 'invalid'),
      );

    const single = async (plan: Plan): Promise<ConnectorHttpResponse> => {
      const checked = await check(plan, false);
      if (checked.kind === 'refused') {
        return checked.outcome === 'logged'
          ? checked.response
          : early(checked.response, checked.outcome);
      }
      return respond(checked.outcome.status, checked.outcome.body, checked.outcome.headers);
    };

    let parsed: unknown;
    try {
      if (!body.ok) throw new SyntaxError('unreadable');
      parsed = JSON.parse(body.text);
    } catch {
      return await single(invalidPlan(RPC_CODE.parseError, 'Parse error: the body is not JSON.'));
    }

    if (!Array.isArray(parsed)) return await single(planMessage(request.headers, parsed, false));

    // A batch: only from a client of the one revision that had batches.
    const named = request.headers.get('mcp-protocol-version')?.trim() ?? '';
    if (named !== '' && named !== HEADERLESS_VERSION) {
      return await single(
        invalidPlan(
          RPC_CODE.invalidRequest,
          'Invalid Request: this protocol version has no batches. Send one message per request.',
        ),
      );
    }
    if (parsed.length === 0 || parsed.length > MAX_BATCH) {
      return await single(
        invalidPlan(
          RPC_CODE.invalidRequest,
          `Invalid Request: a batch holds 1 to ${String(MAX_BATCH)} messages.`,
        ),
      );
    }
    const answers: object[] = [];
    for (const item of parsed) {
      const checked = await check(planMessage(request.headers, item, true), true);
      if (checked.kind === 'refused') {
        // The key or the database failed part-way: the whole request is refused, once.
        return checked.outcome === 'logged'
          ? checked.response
          : early(checked.response, checked.outcome);
      }
      if (checked.outcome.body !== null) answers.push(checked.outcome.body);
    }
    return answers.length === 0 ? respond(202, null) : respond(200, answers);
  } catch (caught: unknown) {
    // Nothing above is supposed to throw. If it does, it is a 503 with the cause logged.
    deps.log.error('connector: request threw', { error: caught });
    return refusal(503, APP_CODE.unavailable, UNAVAILABLE_MESSAGE, 'unavailable', {
      'retry-after': String(UNAVAILABLE_RETRY_SECONDS),
    });
  }
}
