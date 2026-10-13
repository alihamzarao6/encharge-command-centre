/**
 * Shared pieces for the connector's unit tests: a scripted store in place of the database, a
 * request builder, and keys minted at run time.
 *
 * NO KEY IS WRITTEN DOWN ANYWHERE IN THESE TESTS. Every key is made by `mintKey` when the
 * test runs, so there is no key-shaped literal in the repository for a scanner — or a person
 * — to find, and no fixture that could be mistaken for a real one.
 */
import { bearerKeyAuthenticator } from '../../../src/lib/connector/auth.js';
import type { ConnectorConfig } from '../../../src/lib/connector/config.js';
import {
  handleConnectorRequest,
  type BodyRead,
  type ConnectorDeps,
  type ConnectorHttpResponse,
} from '../../../src/lib/connector/handler.js';
import { mintKey, type MintedKey } from '../../../src/lib/connector/keys.js';
import { MODERN_VERSION } from '../../../src/lib/connector/protocol.js';
import type {
  ConnectorCallInput,
  ConnectorCallReply,
  ConnectorStore,
} from '../../../src/lib/connector/store.js';
import { AppError, err, ok, type Result } from '../../../src/lib/errors.js';
import { capturingLogger } from '../llm/helpers.js';

export const PIPELINE = 'PIPE_FINANCE';

export const CONFIG: ConnectorConfig = {
  pipelineId: PIPELINE,
  publicUrl: 'https://connector.example.test/mcp',
  allowedOrigins: [],
  perMinute: 30,
  perDay: 1_000,
  timeoutMs: 8_000,
  maxBodyBytes: 64 * 1024,
};

export type Script = (
  input: ConnectorCallInput,
) => Result<ConnectorCallReply> | Promise<Result<ConnectorCallReply>>;

export interface FakeStore extends ConnectorStore {
  readonly calls: ConnectorCallInput[];
}

/** A store that answers from a script and remembers what it was asked. */
export function fakeStore(script: Script): FakeStore {
  const calls: ConnectorCallInput[] = [];
  return {
    calls,
    call: async (input) => {
      calls.push(input);
      return script(input);
    },
  };
}

export const granted = (data: unknown = null, keyId = 'aaaaaaaaaaaa'): Result<ConnectorCallReply> =>
  ok({ outcome: 'ok', keyId, callId: 'c0000000-0000-4000-8000-000000000001', data });

export const refusedKey = (
  reason: 'unknown_key' | 'wrong_secret' | 'revoked' | 'user_inactive',
  keyId: string | null = null,
): Result<ConnectorCallReply> => ok({ outcome: 'unauthenticated', reason, keyId });

export const databaseDown = (): Result<ConnectorCallReply> =>
  err(new AppError('NETWORK', 'connector_call: transport failure', { retryable: true }));

export interface Sent {
  readonly method?: string;
  readonly hasQuery?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodyRead?: BodyRead;
}

export interface Harness {
  readonly key: MintedKey;
  readonly store: FakeStore;
  readonly lines: string[];
  readonly deps: ConnectorDeps;
  send(sent: Sent): Promise<ConnectorHttpResponse>;
  /** POST one JSON value with the key. */
  rpc(message: unknown, headers?: Readonly<Record<string, string>>): Promise<ConnectorHttpResponse>;
  /** A modern (2026-07-28) request: `_meta` and the three headers filled in to match. */
  modern(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    id?: string | number,
  ): Promise<ConnectorHttpResponse>;
}

export async function harness(
  script: Script = () => granted(),
  config: Partial<ConnectorConfig> = {},
): Promise<Harness> {
  const key = await mintKey();
  const store = fakeStore(script);
  const { log, lines } = capturingLogger();
  const deps: ConnectorDeps = {
    config: { ...CONFIG, ...config },
    authenticator: bearerKeyAuthenticator(),
    store,
    log,
  };
  const send = (sent: Sent): Promise<ConnectorHttpResponse> => {
    const lower = new Map(
      Object.entries(sent.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return handleConnectorRequest(deps, {
      method: sent.method ?? 'POST',
      hasQuery: sent.hasQuery ?? false,
      headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
      readBody: (maxBytes) => {
        if (sent.bodyRead !== undefined) return Promise.resolve(sent.bodyRead);
        const text = sent.body ?? '';
        return Promise.resolve(
          new TextEncoder().encode(text).length > maxBytes
            ? { ok: false, reason: 'too_large' }
            : { ok: true, text },
        );
      },
    });
  };
  const rpc: Harness['rpc'] = (message, headers = {}) =>
    send({
      headers: { authorization: `Bearer ${key.key}`, ...headers },
      body: JSON.stringify(message),
    });
  const modern: Harness['modern'] = (method, params = {}, id = 1) => {
    const name = typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {};
    return rpc(
      {
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, ...name },
    );
  };
  return { key, store, lines, deps, send, rpc, modern };
}

export function json(response: ConnectorHttpResponse): Record<string, unknown> {
  if (response.body === null) throw new Error('the response has no body');
  return JSON.parse(response.body) as Record<string, unknown>;
}

export function errorOf(response: ConnectorHttpResponse): {
  code: number;
  message: string;
  data?: Record<string, unknown>;
} {
  const error = json(response)['error'];
  if (typeof error !== 'object' || error === null) throw new Error('the response is not an error');
  return error as { code: number; message: string; data?: Record<string, unknown> };
}

export function resultOf(response: ConnectorHttpResponse): Record<string, unknown> {
  const result = json(response)['result'];
  if (typeof result !== 'object' || result === null)
    throw new Error('the response is not a result');
  return result as Record<string, unknown>;
}

/** The one text block of a tool result, and whether it is an error. */
export function toolText(response: ConnectorHttpResponse): { text: string; isError: boolean } {
  const result = resultOf(response);
  const content = result['content'] as { type: string; text: string }[];
  return { text: content[0]?.text ?? '', isError: result['isError'] === true };
}

/** The log lines about requests, parsed. */
export function requestLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['msg'] === 'connector: request');
}

// --- What the database returns, in the shapes the migration builds -----------------------

export const FRESH = {
  refreshed_at: '2026-10-13T04:00:00+00:00',
  read_at: '2026-10-13T04:12:00+00:00',
  last_attempt_status: 'success',
  last_attempt_at: '2026-10-13T04:00:00+00:00',
};

export function leadRow(
  n: number,
  over: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    lead_id: `op-${String(n)}`,
    name: `First${String(n)} Example${String(n)}`,
    stage_id: 'st-new',
    stage_name: 'New Lead',
    stage_known: true,
    stage_removed: false,
    status: 'open',
    created_at: `2026-10-${String(12 - (n % 10)).padStart(2, '0')}T04:38:29.968845+00:00`,
    last_stage_change_at: null,
    ...over,
  };
}

export function listing(
  rows: readonly Record<string, unknown>[],
  over: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    outcome: 'ok',
    records: rows.length,
    freshness: FRESH,
    limit: 20,
    total_matching: rows.length,
    stage_exists: null,
    leads: rows,
    ...over,
  };
}

export const SUMMARY = {
  outcome: 'ok',
  records: 2,
  freshness: FRESH,
  pipeline: { id: PIPELINE, name: 'Finance Pipeline' },
  by_status: { open: 3, won: 1 },
  new_last_7_days: 2,
  stages: [
    { stage_id: 'st-new', name: 'New Lead', position: 0, removed: false, open_leads: 2 },
    {
      stage_id: 'st-booked',
      name: 'Appointment Booked',
      position: 1,
      removed: false,
      open_leads: 1,
    },
  ],
  unknown_stages: [],
};

export function leadDetail(over: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    outcome: 'ok',
    records: 1,
    freshness: FRESH,
    lead: {
      lead_id: 'op-1',
      opportunity_name: 'Opportunity 1',
      status: 'open',
      monetary_value: 0,
      source: 'meta_vsl_lp',
      assigned_to: null,
      created_at: '2026-10-12T04:38:29.968845+00:00',
      updated_at: null,
      last_stage_change_at: '2026-10-13T03:38:29+00:00',
      last_status_change_at: null,
      stage_id: 'st-new',
      stage: { id: 'st-new', name: 'New Lead', position: 0, removed: false },
      contact: {
        full_name: 'First1 Example1',
        first_name: 'First1',
        last_name: 'Example1',
        email: 'lead1@example.test',
        phone: '+61400000001',
        source: 'meta_vsl_lp',
        dnd: false,
        tags: ['refi', 'perth'],
        tags_total: 2,
        created_at: '2026-10-12T04:38:29+00:00',
        updated_at: null,
      },
      form_answers: [
        {
          internal_field: 'annual_income',
          field_id: 'cf-income',
          label: 'Annual Income',
          value: null,
        },
        {
          internal_field: 'loan_amount',
          field_id: 'cf-amount',
          label: 'Loan Amount',
          value: 451000,
        },
        {
          internal_field: 'loan_type',
          field_id: 'cf-type',
          label: 'Loan Type',
          value: 'Refinance',
        },
      ],
      other_fields: [{ field_id: 'cf-extra', label: 'Preferred Suburb', value: 'Joondalup' }],
      other_fields_total: 1,
      notes: [
        {
          note_id: 'nt-2',
          body: 'Payslips received.',
          body_length: 18,
          added_at: '2026-10-13T03:38:29+00:00',
          yours: false,
        },
        {
          note_id: 'nt-1',
          body: 'Called, wants a callback after 5pm.',
          body_length: 35,
          added_at: '2026-10-13T02:38:29+00:00',
          yours: true,
        },
      ],
      notes_total: 2,
      ...over,
    },
  };
}
