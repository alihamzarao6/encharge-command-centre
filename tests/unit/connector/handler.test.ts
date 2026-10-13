/**
 * The connector's endpoint, request by request (MCP connector, stage 1 — the brief's Part C).
 *
 * Every request here is treated the way the endpoint must treat it: as hostile. The database
 * is a scripted store, so each test says exactly what the database would answer and asserts
 * what the endpoint then does — and, as often, what it must NOT have done: asked the
 * database at all, put anything in a log, or told an unauthenticated caller anything.
 *
 * What the database itself decides (whether a key is live, the limits, the pipeline, the
 * key's own user) is proved against a real database in tests/security/connector.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  UNAUTHORIZED_MESSAGE,
  UNAVAILABLE_MESSAGE,
  planMessage,
} from '../../../src/lib/connector/handler.js';
import { mintKey } from '../../../src/lib/connector/keys.js';
import {
  APP_CODE,
  LATEST_LEGACY_VERSION,
  META_SERVER_INFO,
  MODERN_VERSION,
  RPC_CODE,
  SERVER_INFO,
  SUPPORTED_VERSIONS,
} from '../../../src/lib/connector/protocol.js';
import {
  NEVER_SYNCED_MESSAGE,
  NOT_FOUND_MESSAGE,
  READ_FAILED_MESSAGE,
  TOOL_NAMES,
} from '../../../src/lib/connector/tools.js';
import { AppError, TimeoutError, err, ok } from '../../../src/lib/errors.js';
import {
  FRESH,
  PIPELINE,
  SUMMARY,
  databaseDown,
  errorOf,
  granted,
  harness,
  json,
  leadDetail,
  leadRow,
  listing,
  refusedKey,
  requestLines,
  resultOf,
  toolText,
} from './helpers.js';

const call = (name: string, args?: unknown, id: string | number = 7): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: args === undefined ? { name } : { name, arguments: args },
});
const LEGACY = { 'mcp-protocol-version': '2025-06-18' };

const EXAMPLE_ARGS: Readonly<Record<string, unknown>> = {
  pipeline_summary: {},
  list_leads: {},
  get_lead: { lead_id: 'op-1' },
  search_leads: { query: 'example' },
};

// ---------------------------------------------------------------------------------------
describe('authentication — who may ask at all', () => {
  it('no Authorization header: 401 with a challenge, and the database is never asked', async () => {
    const h = await harness();
    const response = await h.send({ body: JSON.stringify(call('pipeline_summary', {})) });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="Fundd Command Centre"');
    expect(errorOf(response)).toEqual({
      code: APP_CODE.unauthorized,
      message: UNAUTHORIZED_MESSAGE,
      data: { reason: 'unauthorized' },
    });
    expect(json(response)['id']).toBeNull();
    expect(h.store.calls).toHaveLength(0);
  });

  it.each([
    ['the scheme alone', 'Bearer'],
    ['an empty token', 'Bearer    '],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['a token with no scheme', 'not-a-scheme-at-all'],
    ['a token that is not one of ours', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc'],
    ['a key with a character too many', 'Bearer KEYx'],
    ['a key cut short', 'Bearer KEY-1'],
    ['two tokens', 'Bearer KEY KEY'],
    ['our prefix and nothing real', 'Bearer fcc_'],
  ])('%s: 401, the same body, no database call', async (_label, header) => {
    const h = await harness();
    const value = header.replace(/KEY-1/g, h.key.key.slice(0, -1)).replace(/KEY/g, h.key.key);
    const response = await h.send({
      headers: { authorization: value },
      body: JSON.stringify(call('pipeline_summary', {})),
    });
    expect(response.status).toBe(401);
    expect(errorOf(response).message).toBe(UNAUTHORIZED_MESSAGE);
    expect(h.store.calls).toHaveLength(0);
  });

  it.each([
    ['a well-formed key that was never issued', 'unknown_key'],
    ['a key whose secret is wrong', 'wrong_secret'],
    ['a key that was issued and then revoked', 'revoked'],
    ['a key whose user is no longer active', 'user_inactive'],
  ] as const)('%s: 401, and nothing in the answer says which', async (_label, reason) => {
    const missing = await (await harness()).send({ body: '{}' });
    const h = await harness(() =>
      refusedKey(reason, reason === 'unknown_key' ? null : 'aaaaaaaaaaaa'),
    );
    const response = await h.rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY);
    expect(response.status).toBe(401);
    // Byte for byte what a request with no header at all gets.
    expect(response.body).toBe(missing.body);
    expect(response.headers).toEqual(missing.headers);
    expect(response.body).not.toContain(reason);
    // Which it was is in the log, by the key's public id, for us.
    const line = requestLines(h.lines).at(-1);
    expect(line).toMatchObject({ outcome: 'unauthenticated', reason, status: 401 });
  });

  it('two keys for one user, one revoked and one live: each is answered on its own', async () => {
    const live = await mintKey();
    const h = await harness((input) =>
      input.credential.keyId === live.keyId
        ? granted(SUMMARY, live.keyId)
        : refusedKey('revoked', input.credential.keyId),
    );
    const refused = await h.rpc(call('pipeline_summary', {}), LEGACY);
    const served = await h.send({
      headers: { authorization: `Bearer ${live.key}`, ...LEGACY },
      body: JSON.stringify(call('pipeline_summary', {})),
    });
    expect(refused.status).toBe(401);
    expect(served.status).toBe(200);
    expect(toolText(served).isError).toBe(false);
  });

  it('the key in the query string: refused before anything reads it, and nothing is logged about the address', async () => {
    const h = await harness();
    const response = await h.send({
      hasQuery: true,
      headers: { authorization: `Bearer ${h.key.key}` },
      body: JSON.stringify(call('pipeline_summary', {})),
    });
    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatchObject({
      code: RPC_CODE.invalidRequest,
      data: { reason: 'query_not_allowed' },
    });
    expect(errorOf(response).message).toContain('never in the address');
    expect(h.store.calls).toHaveLength(0);
    // The handler is never given the address, so there is no address it could log.
    const line = requestLines(h.lines).at(-1) ?? {};
    expect(line).toMatchObject({ outcome: 'query_refused', caller: null });
    expect(Object.keys(line).sort()).toEqual(
      [
        'bytesOut',
        'caller',
        'durationMs',
        'era',
        'level',
        'method',
        'msg',
        'outcome',
        'records',
        'status',
        'tool',
        'ts',
        'version',
      ].sort(),
    );
  });

  it.each(TOOL_NAMES)('%s refuses a call with no key: nothing is read', async (tool) => {
    const h = await harness(() => granted(SUMMARY));
    const response = await h.send({
      headers: LEGACY,
      body: JSON.stringify(call(tool, EXAMPLE_ARGS[tool])),
    });
    expect(response.status).toBe(401);
    expect(h.store.calls).toHaveLength(0);
    expect(response.body).not.toContain('Finance Pipeline');
  });

  it.each(TOOL_NAMES)(
    '%s refuses a key the database does not accept: nothing of the pipeline is sent',
    async (tool) => {
      // The database refuses the key; were its refusal ignored, the scripted data would be sent.
      const h = await harness(() => refusedKey('wrong_secret', 'aaaaaaaaaaaa'));
      const response = await h.rpc(call(tool, EXAMPLE_ARGS[tool]), LEGACY);
      expect(response.status).toBe(401);
      expect(response.body).not.toContain('content');
    },
  );

  it('every request asks the database about the key before answering — the handshake included', async () => {
    const h = await harness(() => refusedKey('revoked', 'aaaaaaaaaaaa'));
    const messages: unknown[] = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', id: 4, method: 'no/such/method' },
      'not even a message',
    ];
    for (const message of messages) {
      const response = await h.rpc(message);
      expect(response.status, JSON.stringify(message)).toBe(401);
    }
    const garbage = await h.send({
      headers: { authorization: `Bearer ${h.key.key}` },
      body: '{not json',
    });
    expect(garbage.status).toBe(401);
    expect(h.store.calls).toHaveLength(messages.length + 1);
  });

  it('the database is given the digest of the key and its public id — never the key', async () => {
    const h = await harness(() => granted(SUMMARY));
    await h.rpc(call('pipeline_summary', {}), LEGACY);
    const sent = h.store.calls[0];
    expect(sent?.credential).toEqual({
      kind: 'key',
      keyId: h.key.keyId,
      digestHex: h.key.digestHex,
    });
    expect(JSON.stringify(sent)).not.toContain(h.key.key);
    expect(sent?.pipelineId).toBe(PIPELINE);
    expect(sent).toMatchObject({ perMinute: 30, perDay: 1_000 });
    // The read is never told whose it is: there is no user id to get wrong.
    expect(Object.keys(sent ?? {}).sort()).toEqual(
      ['args', 'credential', 'method', 'perDay', 'perMinute', 'pipelineId', 'tool'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------
describe('the address, the method and the origin', () => {
  it.each(['GET', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'])(
    '%s is 405: this server opens no stream',
    async (method) => {
      const h = await harness();
      const response = await h.send({ method, headers: { authorization: `Bearer ${h.key.key}` } });
      expect(response.status).toBe(405);
      expect(response.headers['allow']).toBe('POST');
      expect(errorOf(response).code).toBe(APP_CODE.methodNotAllowed);
      expect(h.store.calls).toHaveLength(0);
    },
  );

  it('a browser origin that is not on the list is 403, before the key is looked at', async () => {
    const h = await harness();
    const response = await h.rpc(call('pipeline_summary', {}), { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(errorOf(response)).toMatchObject({
      code: APP_CODE.originRefused,
      data: { reason: 'origin_not_allowed' },
    });
    expect(h.store.calls).toHaveLength(0);
  });

  it('an origin on the list is let through; no CORS header is ever sent', async () => {
    const h = await harness(() => granted(SUMMARY), { allowedOrigins: ['https://tools.example'] });
    const response = await h.rpc(call('pipeline_summary', {}), {
      origin: 'https://tools.example',
      ...LEGACY,
    });
    expect(response.status).toBe(200);
    expect(Object.keys(response.headers).some((name) => name.startsWith('access-control'))).toBe(
      false,
    );
    expect(response.headers).toMatchObject({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });
});

// ---------------------------------------------------------------------------------------
describe('the protocol — legacy clients, which open with initialize', () => {
  it('initialize: the version asked for when we speak it, our capabilities, who we are', async () => {
    const h = await harness();
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      const response = await h.rpc({
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      });
      expect(response.status).toBe(200);
      expect(json(response)['id']).toBe('init-1');
      const result = resultOf(response);
      expect(result).toMatchObject({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      expect(result['instructions']).toContain('Read-only');
      // A legacy result is the bare object: no resultType, no session id.
      expect(result).not.toHaveProperty('resultType');
      expect(Object.keys(response.headers)).not.toContain('mcp-session-id');
    }
  });

  it('a client that announces a version we do not implement is offered our newest of its era', async () => {
    const h = await harness();
    for (const version of ['1999-01-01', '2024-11-05', MODERN_VERSION, 'banana']) {
      const response = await h.rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version },
      });
      expect(resultOf(response)['protocolVersion'], version).toBe(LATEST_LEGACY_VERSION);
    }
    const none = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(errorOf(none)).toMatchObject({
      code: RPC_CODE.invalidParams,
      data: { supported: SUPPORTED_VERSIONS },
    });
  });

  it('on any later request an unsupported version is 400 with the list we do speak', async () => {
    const h = await harness();
    const response = await h.rpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      { 'mcp-protocol-version': '1999-01-01' },
    );
    expect(response.status).toBe(400);
    expect(errorOf(response)).toEqual({
      code: RPC_CODE.unsupportedVersion,
      message: 'Unsupported protocol version',
      data: { supported: SUPPORTED_VERSIONS, requested: '1999-01-01' },
    });
    expect(json(response)['id']).toBe(5);
  });

  it('notifications/initialized is accepted: 202 and no body', async () => {
    const h = await harness();
    const response = await h.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
    expect(h.store.calls[0]).toMatchObject({ method: 'notifications/initialized', tool: null });
  });

  it('ping answers {}; tools/list lists the four tools, always in the same order', async () => {
    const h = await harness();
    expect(resultOf(await h.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, LEGACY))).toEqual({});
    const first = resultOf(await h.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, LEGACY));
    const second = resultOf(
      await h.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    );
    expect(first).toEqual(second);
    expect(Object.keys(first)).toEqual(['tools']);
    expect((first['tools'] as { name: string }[]).map((tool) => tool.name)).toEqual([
      ...TOOL_NAMES,
    ]);
    const paged = await h.rpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { cursor: 'x' } },
      LEGACY,
    );
    expect(errorOf(paged).code).toBe(RPC_CODE.invalidParams);
  });

  it('a client that calls tools/call before initialize is simply served: the key is what was checked', async () => {
    const h = await harness(() => granted(SUMMARY));
    const response = await h.rpc(call('pipeline_summary', {}));
    expect(response.status).toBe(200);
    expect(toolText(response).isError).toBe(false);
    expect(h.store.calls).toHaveLength(1);
  });

  it('an unknown method is a JSON-RPC error in a 200, not a bare HTTP error', async () => {
    const h = await harness();
    for (const method of [
      'resources/list',
      'prompts/list',
      'server/discover',
      'tools/delete',
      'admin/users',
    ]) {
      const response = await h.rpc({ jsonrpc: '2.0', id: 9, method }, LEGACY);
      expect(response.status, method).toBe(200);
      expect(json(response)).toEqual({
        jsonrpc: '2.0',
        id: 9,
        error: { code: RPC_CODE.methodNotFound, message: 'Method not found' },
      });
    }
    // What was recorded is a fixed word, never the method the caller sent.
    expect(h.store.calls.map((sent) => sent.method)).toEqual([
      'other',
      'other',
      'server/discover',
      'other',
      'other',
    ]);
  });
});

// ---------------------------------------------------------------------------------------
describe('the protocol — the current revision, which has no handshake', () => {
  it('server/discover: the versions, the capabilities and who we are, marked complete', async () => {
    const h = await harness();
    const response = await h.modern('server/discover', {}, 'discover-1');
    expect(response.status).toBe(200);
    expect(json(response)['id']).toBe('discover-1');
    expect(resultOf(response)).toEqual({
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: expect.stringContaining('Read-only') as string,
      ttlMs: 3_600_000,
      cacheScope: 'private',
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    });
  });

  it('tools/list and tools/call carry resultType, and the list says how long it may be kept', async () => {
    const h = await harness(() => granted(SUMMARY));
    const list = resultOf(await h.modern('tools/list'));
    expect(list).toMatchObject({ resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'private' });
    expect((list['tools'] as unknown[]).length).toBe(4);
    const called = await h.modern('tools/call', { name: 'pipeline_summary', arguments: {} });
    expect(resultOf(called)).toMatchObject({
      resultType: 'complete',
      isError: false,
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    });
  });

  it('an unknown method is 404 with the JSON-RPC error; ping and initialize-era methods are not modern', async () => {
    const h = await harness();
    for (const method of ['ping', 'resources/list', 'subscriptions/listen']) {
      const response = await h.modern(method);
      expect(response.status, method).toBe(404);
      expect(errorOf(response)).toEqual({
        code: RPC_CODE.methodNotFound,
        message: 'Method not found',
      });
    }
  });

  it('a header that disagrees with the body is refused, not believed', async () => {
    const h = await harness();
    const meta = {
      'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const request = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_lead', arguments: { lead_id: 'op-1' }, _meta: meta },
    };
    const good = {
      'mcp-protocol-version': MODERN_VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'get_lead',
    };
    const cases: (readonly [string, Record<string, string>, unknown, number])[] = [
      [
        'Mcp-Method names another method',
        { ...good, 'mcp-method': 'tools/list' },
        request,
        RPC_CODE.headerMismatch,
      ],
      [
        'Mcp-Method is missing',
        { 'mcp-protocol-version': MODERN_VERSION, 'mcp-name': 'get_lead' },
        request,
        RPC_CODE.headerMismatch,
      ],
      [
        'Mcp-Name names another tool',
        { ...good, 'mcp-name': 'pipeline_summary' },
        request,
        RPC_CODE.headerMismatch,
      ],
      [
        'Mcp-Name is missing',
        { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call' },
        request,
        RPC_CODE.headerMismatch,
      ],
      [
        'Mcp-Name is broken base64',
        { ...good, 'mcp-name': '=?base64?!!!?=' },
        request,
        RPC_CODE.headerMismatch,
      ],
      [
        'the version in _meta is another version',
        good,
        {
          ...request,
          params: {
            ...request.params,
            _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2025-06-18' },
          },
        },
        RPC_CODE.headerMismatch,
      ],
      [
        'the version is only in the body',
        { 'mcp-method': 'tools/call', 'mcp-name': 'get_lead' },
        request,
        RPC_CODE.headerMismatch,
      ],
      [
        '_meta has no version',
        good,
        {
          ...request,
          params: {
            ...request.params,
            _meta: { 'io.modelcontextprotocol/clientCapabilities': {} },
          },
        },
        RPC_CODE.invalidParams,
      ],
      [
        '_meta has no client capabilities',
        good,
        {
          ...request,
          params: {
            ...request.params,
            _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_VERSION },
          },
        },
        RPC_CODE.invalidParams,
      ],
    ];
    for (const [label, headers, message, code] of cases) {
      const response = await h.rpc(message, headers);
      expect(response.status, label).toBe(400);
      expect(errorOf(response).code, label).toBe(code);
      expect(json(response)['id'], label).toBe(3);
    }
    // None of them read anything: the database was asked about the key and no tool.
    expect(h.store.calls.every((sent) => sent.tool === null)).toBe(true);
  });

  it('Mcp-Name may arrive base64-encoded and is decoded before it is compared', async () => {
    const h = await harness(() => granted(SUMMARY));
    const response = await h.rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'pipeline_summary',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
      {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': `=?base64?${btoa('pipeline_summary')}?=`,
      },
    );
    expect(response.status).toBe(200);
    expect(toolText(response).isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
describe('the protocol — what is not a request', () => {
  it('a body that is not JSON: a parse error, after the key', async () => {
    const h = await harness();
    for (const body of ['', '{not json', 'hello', '\u{0}', '{"jsonrpc":"2.0",']) {
      const response = await h.send({ headers: { authorization: `Bearer ${h.key.key}` }, body });
      expect(response.status, body).toBe(400);
      expect(json(response)).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_CODE.parseError, message: 'Parse error: the body is not JSON.' },
      });
    }
    expect(h.store.calls.map((sent) => sent.method)).toEqual(Array(5).fill('invalid'));
  });

  it('a body that could not be read as text is a parse error too', async () => {
    const h = await harness();
    const response = await h.send({
      headers: { authorization: `Bearer ${h.key.key}` },
      bodyRead: { ok: false, reason: 'unreadable' },
    });
    expect(errorOf(response).code).toBe(RPC_CODE.parseError);
  });

  it.each([
    ['a number', 42],
    ['a string', 'tools/list'],
    ['null', null],
    ['an empty object', {}],
    ['the wrong jsonrpc', { jsonrpc: '1.0', id: 1, method: 'tools/list' }],
    ['no method', { jsonrpc: '2.0', id: 1 }],
    ['a method that is not text', { jsonrpc: '2.0', id: 1, method: 7 }],
    ['a response, which this server never asked for', { jsonrpc: '2.0', id: 1, result: {} }],
    ['an id of null', { jsonrpc: '2.0', id: null, method: 'tools/list' }],
    ['an id that is a fraction', { jsonrpc: '2.0', id: 1.5, method: 'tools/list' }],
    ['an id that is an object', { jsonrpc: '2.0', id: { a: 1 }, method: 'tools/list' }],
  ])('valid JSON that is not JSON-RPC — %s: Invalid Request', async (_label, message) => {
    const h = await harness();
    const response = await h.rpc(message);
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe(RPC_CODE.invalidRequest);
  });

  it('params that are not an object are invalid params, matched to the request', async () => {
    const h = await harness();
    const response = await h.rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: ['get_lead'],
    });
    expect(errorOf(response).code).toBe(RPC_CODE.invalidParams);
    expect(json(response)['id']).toBe(4);
  });

  it('a missing id is a notification (202, nothing sent back); a duplicated id is the last one, as JSON has it', async () => {
    const h = await harness();
    const missing = await h.rpc({ jsonrpc: '2.0', method: 'tools/list' });
    expect(missing.status).toBe(202);
    expect(missing.body).toBeNull();
    const duplicated = await h.send({
      headers: { authorization: `Bearer ${h.key.key}` },
      body: '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}',
    });
    expect(json(duplicated)).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  it('a request far larger than any real one is 413 and is never parsed or sent to the database', async () => {
    const h = await harness();
    const huge = JSON.stringify(call('search_leads', { query: 'x'.repeat(200_000) }));
    const response = await h.rpc(JSON.parse(huge));
    expect(response.status).toBe(413);
    expect(errorOf(response)).toMatchObject({
      code: APP_CODE.tooLarge,
      data: { reason: 'too_large' },
    });
    expect(h.store.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
describe('a batch — only from a client of the one revision that had them', () => {
  const two = [
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ];

  it('with no version header: each message is checked and counted on its own, and answered in order', async () => {
    const h = await harness();
    const response = await h.rpc(two);
    expect(response.status).toBe(200);
    const answers = JSON.parse(response.body ?? '[]') as { id: string }[];
    expect(answers.map((answer) => answer.id)).toEqual(['a', 'b']);
    expect(h.store.calls.map((sent) => sent.method)).toEqual([
      'ping',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('notifications only: 202', async () => {
    const h = await harness();
    const response = await h.rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });

  it('a later revision has no batches: refused whole', async () => {
    const h = await harness();
    for (const version of ['2025-06-18', '2025-11-25', MODERN_VERSION]) {
      const response = await h.rpc(two, { 'mcp-protocol-version': version });
      expect(response.status, version).toBe(400);
      expect(errorOf(response).code).toBe(RPC_CODE.invalidRequest);
    }
    const explicit = await h.rpc(two, { 'mcp-protocol-version': '2025-03-26' });
    expect(explicit.status).toBe(200);
  });

  it('empty, or more than ten messages: refused whole, after the key', async () => {
    const h = await harness();
    const eleven = Array.from({ length: 11 }, (_unused, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'ping',
    }));
    for (const batch of [[], eleven]) {
      const response = await h.rpc(batch);
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe(RPC_CODE.invalidRequest);
    }
    expect(h.store.calls.map((sent) => sent.method)).toEqual(['invalid', 'invalid']);
  });

  it('initialize may not ride in a batch; a bad message is an error beside the good ones', async () => {
    const h = await harness();
    const response = await h.rpc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      42,
    ]);
    const answers = JSON.parse(response.body ?? '[]') as {
      id: unknown;
      error?: { code: number };
      result?: unknown;
    }[];
    expect(answers).toHaveLength(3);
    expect(answers[0]?.error?.code).toBe(RPC_CODE.invalidRequest);
    expect(answers[1]?.result).toEqual({});
    expect(answers[2]).toMatchObject({ id: null, error: { code: RPC_CODE.invalidRequest } });
  });

  it('a key the database refuses stops the batch at once: one 401, nothing more asked', async () => {
    const h = await harness(() => refusedKey('revoked', 'aaaaaaaaaaaa'));
    const response = await h.rpc(two);
    expect(response.status).toBe(401);
    expect(h.store.calls).toHaveLength(1);
  });

  it('the limit reached part-way: the refused message is an error in the list, the rest of the answer stands', async () => {
    let n = 0;
    const h = await harness(() => {
      n += 1;
      return n === 2
        ? ok({
            outcome: 'rate_limited',
            keyId: 'aaaaaaaaaaaa',
            window: 'minute',
            retryAfterSeconds: 9,
          })
        : granted(SUMMARY);
    });
    const response = await h.rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(response.status).toBe(200);
    const answers = JSON.parse(response.body ?? '[]') as { id: number; error?: { code: number } }[];
    expect(answers[1]).toMatchObject({ id: 2, error: { code: APP_CODE.rateLimited } });
  });
});

// ---------------------------------------------------------------------------------------
describe('tools/call — the four ways it can be wrong, told apart', () => {
  it('a tool that does not exist is a protocol error, and nothing is read', async () => {
    const h = await harness(() => granted(SUMMARY));
    for (const name of [
      'move_lead',
      'add_note',
      'delete_lead',
      'list_users',
      'issue_key',
      'PIPELINE_SUMMARY',
    ]) {
      const response = await h.rpc(call(name, {}), LEGACY);
      expect(response.status).toBe(200);
      expect(json(response)).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: RPC_CODE.invalidParams, message: `Unknown tool: ${name}` },
      });
    }
    expect(h.store.calls.every((sent) => sent.tool === null && sent.args === null)).toBe(true);
  });

  it('a tool name is echoed cleaned and short, whatever was sent', async () => {
    const h = await harness();
    const response = await h.rpc(call(`x\u{202E}${'y'.repeat(500)}`, {}), LEGACY);
    const message = errorOf(response).message;
    expect(message.length).toBeLessThanOrEqual('Unknown tool: '.length + 64);
    expect(message).not.toContain('\u{202E}');
  });

  it('a call with no name, or arguments that are not an object, is malformed', async () => {
    const h = await harness();
    const cases = [
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 5 } },
      call('get_lead', 'op-1'),
      call('get_lead', ['op-1']),
    ];
    for (const message of cases) {
      const response = await h.rpc(message, LEGACY);
      expect(errorOf(response).code).toBe(RPC_CODE.invalidParams);
    }
  });

  it.each([
    ['a missing argument', 'get_lead', {}, 'lead_id is required.'],
    ['a missing argument', 'search_leads', {}, 'query is required.'],
    [
      'an extra argument',
      'pipeline_summary',
      { colour: 'blue' },
      'Unknown argument: colour. pipeline_summary accepts no arguments.',
    ],
    [
      'an extra argument',
      'get_lead',
      { lead_id: 'op-1', include: 'all' },
      'Unknown argument: include. get_lead accepts lead_id.',
    ],
    ['the wrong type', 'list_leads', { limit: '20' }, 'limit must be a whole number from 1 to 50.'],
    ['the wrong type', 'get_lead', { lead_id: 12345 }, 'lead_id is not a lead id.'],
    [
      'the wrong type',
      'search_leads',
      { query: ['a', 'b'] },
      'query must be text of 2 to 100 characters',
    ],
    [
      'a nonsensical value',
      'list_leads',
      { limit: 0 },
      'limit must be a whole number from 1 to 50.',
    ],
    [
      'a nonsensical value',
      'list_leads',
      { limit: -5 },
      'limit must be a whole number from 1 to 50.',
    ],
    [
      'a nonsensical value',
      'list_leads',
      { limit: 2.5 },
      'limit must be a whole number from 1 to 50.',
    ],
    [
      'a nonsensical value',
      'list_leads',
      { status: 'purple' },
      'status must be one of: open, won, lost, abandoned, any.',
    ],
    ['a nonsensical value', 'list_leads', { stage_id: 'New Lead' }, 'stage_id is not a stage id.'],
    [
      'a nonsensical value',
      'list_leads',
      { cursor: 'not-a-cursor' },
      'cursor is not one this server issued.',
    ],
    [
      'a nonsensical value',
      'get_lead',
      { lead_id: '../../etc/passwd' },
      'lead_id is not a lead id.',
    ],
    ['a nonsensical value', 'get_lead', { lead_id: "x' or '1'='1" }, 'lead_id is not a lead id.'],
    [
      'a nonsensical value',
      'search_leads',
      { query: 'a' },
      'query must be text of 2 to 100 characters',
    ],
    [
      'a nonsensical value',
      'search_leads',
      { query: 'x'.repeat(101) },
      'query must be text of 2 to 100 characters',
    ],
    [
      'a nonsensical value',
      'search_leads',
      { query: 'ok', limit: 0 },
      'limit must be a whole number from 1 to 25.',
    ],
  ])(
    '%s — %s %j: a result the model can read and correct, and nothing is read',
    async (_label, tool, args, sentence) => {
      const h = await harness(() => granted(SUMMARY));
      const response = await h.rpc(call(tool, args), LEGACY);
      expect(response.status).toBe(200);
      const answer = toolText(response);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(sentence);
      // The request is counted (the key was checked) but no tool ran.
      expect(h.store.calls).toHaveLength(1);
      expect(h.store.calls[0]).toMatchObject({ method: 'tools/call', tool: null, args: null });
      expect(requestLines(h.lines).at(-1)).toMatchObject({ outcome: 'bad_arguments', tool: null });
    },
  );

  it('upstream failure with a good key: a result that says so and nothing about why', async () => {
    const h = await harness(() =>
      ok({ outcome: 'read_failed', keyId: 'aaaaaaaaaaaa', callId: 'c1' }),
    );
    const response = await h.rpc(call('pipeline_summary', {}), LEGACY);
    expect(response.status).toBe(200);
    expect(toolText(response)).toEqual({ isError: true, text: READ_FAILED_MESSAGE });
  });

  it('a reply from the database in a shape this code does not know is a failed read, not a partly-sent one', async () => {
    for (const data of [
      null,
      'rows',
      { outcome: 'ok' },
      { outcome: 'ok', leads: 'many' },
      { ...SUMMARY, stages: [{}] },
    ]) {
      const h = await harness(() => granted(data));
      const response = await h.rpc(call('pipeline_summary', {}), LEGACY);
      expect(toolText(response)).toEqual({ isError: true, text: READ_FAILED_MESSAGE });
    }
  });

  it('the four failures are four different answers', async () => {
    const auth = await (
      await harness(() => refusedKey('revoked', 'a'))
    ).rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY);
    const unknown = await (await harness()).rpc(call('move_lead', {}), LEGACY);
    const bad = await (await harness()).rpc(call('get_lead', {}), LEGACY);
    const upstream = await (
      await harness(databaseDown)
    ).rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY);
    expect([auth.status, unknown.status, bad.status, upstream.status]).toEqual([
      401, 200, 200, 503,
    ]);
    expect(errorOf(auth).code).toBe(APP_CODE.unauthorized);
    expect(errorOf(unknown).code).toBe(RPC_CODE.invalidParams);
    expect(toolText(bad).isError).toBe(true);
    expect(errorOf(upstream).code).toBe(APP_CODE.unavailable);
    // And none of them names a table, a function, a host or a library.
    for (const response of [auth, unknown, bad, upstream]) {
      expect(response.body).not.toMatch(/connector_|ghl_|supabase|postgres|sql|stack|\.ts\b/i);
    }
  });
});

// ---------------------------------------------------------------------------------------
describe('the data — what comes back, and what does not', () => {
  it('a lead id that is not in the pipeline: one sentence, whatever the reason', async () => {
    // The database answers the same for an id that never existed, one in another pipeline and
    // one that was removed (tests/security/connector.test.ts); this is what is then said.
    const h = await harness(() => granted({ outcome: 'not_found', records: 0, freshness: FRESH }));
    const response = await h.rpc(call('get_lead', { lead_id: 'op-other' }), LEGACY);
    expect(toolText(response)).toEqual({ isError: true, text: NOT_FOUND_MESSAGE });
    expect(NOT_FOUND_MESSAGE).not.toMatch(/another pipeline|exists|removed|deleted/i);
    expect(requestLines(h.lines).at(-1)).toMatchObject({ outcome: 'not_found', records: 0 });
  });

  it('paging past the end is an empty page, not an error', async () => {
    const h = await harness(() => granted(listing([], { total_matching: 10 })));
    const first = await (
      await harness(() =>
        granted(listing([leadRow(1), leadRow(2), leadRow(3)], { limit: 2, total_matching: 3 })),
      )
    ).rpc(call('list_leads', { limit: 2 }), LEGACY);
    const cursor = (JSON.parse(toolText(first).text) as { next_cursor: string }).next_cursor;
    expect(typeof cursor).toBe('string');
    const response = await h.rpc(call('list_leads', { cursor }), LEGACY);
    const answer = toolText(response);
    expect(answer.isError).toBe(false);
    expect(JSON.parse(answer.text)).toMatchObject({
      leads: [],
      returned: 0,
      next_cursor: null,
      total_matching: 10,
    });
    // The cursor reached the database as the last row's instant and id, exactly as stored.
    expect(h.store.calls[0]?.args).toMatchObject({
      has_cursor: true,
      after_id: 'op-2',
      after_created_at: '2026-10-10T04:38:29.968845+00:00',
    });
  });

  it('a page size above the cap is capped and says so; the database is asked for the cap', async () => {
    const rows = Array.from({ length: 51 }, (_unused, i) => leadRow(i));
    const h = await harness(() => granted(listing(rows, { limit: 50, total_matching: 400 })));
    const response = await h.rpc(call('list_leads', { limit: 5000 }), LEGACY);
    expect(h.store.calls[0]?.args).toMatchObject({ limit: 50 });
    const body = JSON.parse(toolText(response).text) as Record<string, unknown>;
    expect(body).toMatchObject({ returned: 50, limit: 50, total_matching: 400 });
    expect(body['note']).toBe('50 is the most one call returns; use next_cursor for the rest.');
    expect((body['leads'] as unknown[]).length).toBe(50);
    expect(typeof body['next_cursor']).toBe('string');
  });

  it('an empty pipeline is a valid answer: zeros and an empty list, not an error', async () => {
    const empty = {
      ...SUMMARY,
      by_status: {},
      new_last_7_days: 0,
      stages: SUMMARY.stages.map((stage) => ({ ...stage, open_leads: 0 })),
    };
    const summary = await (
      await harness(() => granted(empty))
    ).rpc(call('pipeline_summary', {}), LEGACY);
    expect(toolText(summary).isError).toBe(false);
    expect(JSON.parse(toolText(summary).text)).toMatchObject({
      open_leads: 0,
      new_open_leads_last_7_days: 0,
      leads_by_status: {},
    });
    const list = await (
      await harness(() => granted(listing([])))
    ).rpc(call('list_leads', {}), LEGACY);
    expect(JSON.parse(toolText(list).text)).toMatchObject({
      leads: [],
      returned: 0,
      total_matching: 0,
      next_cursor: null,
    });
    const search = await (
      await harness(() => granted(listing([], { limit: 10 })))
    ).rpc(call('search_leads', { query: 'nobody' }), LEGACY);
    expect(JSON.parse(toolText(search).text)).toMatchObject({
      leads: [],
      returned: 0,
      total_matching: 0,
    });
  });

  it('unicode and emoji survive; hidden characters do not; long values are cut and say so', async () => {
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    const hidden = `Zo\u{EB} \u{5F20}\u{4F1F} ${family}\u{202E}\u{200B}\u{E0049}\u{E0047}`;
    const detail = leadDetail({
      contact: {
        full_name: hidden,
        first_name: null,
        last_name: null,
        email: 'zoe@example.test',
        phone: '+61400000001',
        source: null,
        dnd: null,
        tags: Array.from({ length: 21 }, (_unused, i) => `tag-${String(i)}`),
        tags_total: 40,
        created_at: null,
        updated_at: null,
      },
      notes: [
        {
          note_id: 'n',
          body: '\u{1F3E0}'.repeat(1_500),
          body_length: 1_500,
          added_at: null,
          yours: true,
        },
      ],
      notes_total: 9,
      other_fields: [{ field_id: 'cf-x', label: null, value: 'y'.repeat(900) }],
      other_fields_total: 30,
    });
    const h = await harness(() => granted(detail));
    const text = toolText(await h.rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY)).text;
    const lead = (JSON.parse(text) as { lead: Record<string, unknown> }).lead;
    expect(lead['name']).toBe(`Zo\u{EB} \u{5F20}\u{4F1F} ${family}`);
    expect(text).not.toMatch(/[\u{202E}\u{200B}\u{E0000}-\u{E007F}]/u);
    const note = (lead['notes'] as { text: string }[])[0]?.text ?? '';
    expect(Array.from(note.split(' …[cut')[0] ?? '')).toHaveLength(1_000);
    expect(note).toContain('…[cut: 1500 characters in all]');
    // Cut on a whole character: no half of an emoji is left behind.
    expect(/\p{Cs}/u.test(note)).toBe(false);
    expect(lead).toMatchObject({ notes_not_shown: 8, other_fields_not_shown: 10 });
    expect((lead['contact'] as { tags: string[]; tags_not_shown: number }).tags).toHaveLength(20);
    expect((lead['contact'] as { tags_not_shown: number }).tags_not_shown).toBe(20);
    const other = (lead['other_fields'] as { label: string; value: string }[])[0];
    expect(other?.label).toBe('cf-x');
    expect(other?.value).toContain('…[cut: 900 characters in all]');
    expect(other?.value.length).toBeLessThan(560);
  });

  it('a stage in the data but not in the pipeline is shown as exactly that', async () => {
    const rows = [
      leadRow(1, { stage_id: 'st-ghost', stage_name: null, stage_known: false }),
      leadRow(2, { stage_id: 'st-old', stage_name: 'Old Stage', stage_removed: true }),
    ];
    const list = JSON.parse(
      toolText(
        await (await harness(() => granted(listing(rows)))).rpc(call('list_leads', {}), LEGACY),
      ).text,
    ) as {
      leads: { stage_id: string; stage: string }[];
    };
    expect(list.leads.map((lead) => [lead.stage_id, lead.stage])).toEqual([
      ['st-ghost', 'Stage not in the pipeline'],
      ['st-old', 'Old Stage (removed in GoHighLevel)'],
    ]);
    const summary = { ...SUMMARY, unknown_stages: [{ stage_id: 'st-ghost', open_leads: 4 }] };
    const stages = (
      JSON.parse(
        toolText(
          await (await harness(() => granted(summary))).rpc(call('pipeline_summary', {}), LEGACY),
        ).text,
      ) as {
        stages: unknown[];
      }
    ).stages;
    expect(stages.at(-1)).toEqual({
      stage_id: 'st-ghost',
      name: 'Stage not in the pipeline',
      open_leads: 4,
    });
    const one = leadDetail({ stage_id: 'st-ghost', stage: null });
    const lead = (
      JSON.parse(
        toolText(
          await (
            await harness(() => granted(one))
          ).rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY),
        ).text,
      ) as {
        lead: { stage: string; stage_id: string };
      }
    ).lead;
    expect(lead).toMatchObject({ stage_id: 'st-ghost', stage: 'Stage not in the pipeline' });
  });

  it('filtering by a stage id the pipeline does not have says so, instead of an unexplained empty list', async () => {
    const h = await harness(() => granted(listing([], { stage_exists: false })));
    const body = JSON.parse(
      toolText(await h.rpc(call('list_leads', { stage_id: 'st-typo' }), LEGACY)).text,
    ) as { note: string };
    expect(body.note).toBe(
      'No stage with that id is in this pipeline. pipeline_summary lists the stage ids.',
    );
  });

  it.each(TOOL_NAMES)(
    '%s: a mirror that has never synced is said out loud, not answered with silence',
    async (tool) => {
      const h = await harness(() =>
        granted({
          outcome: 'never_synced',
          records: 0,
          freshness: { ...FRESH, refreshed_at: null },
        }),
      );
      const response = await h.rpc(call(tool, EXAMPLE_ARGS[tool]), LEGACY);
      expect(toolText(response)).toEqual({ isError: true, text: NEVER_SYNCED_MESSAGE });
      expect(NEVER_SYNCED_MESSAGE).toContain('NOT an empty pipeline');
      expect(requestLines(h.lines).at(-1)).toMatchObject({ outcome: 'never_synced' });
    },
  );

  it('a mirror last synced days ago: every result says how old it is, and not to call it current', async () => {
    const old = {
      ...FRESH,
      refreshed_at: '2026-10-10T04:00:00+00:00',
      last_attempt_at: '2026-10-10T04:00:00+00:00',
    };
    const h = await harness((input) =>
      granted(
        input.tool === 'pipeline_summary'
          ? { ...SUMMARY, freshness: old }
          : listing([leadRow(1)], { freshness: old }),
      ),
    );
    for (const [tool, args] of [
      ['pipeline_summary', {}],
      ['list_leads', {}],
      ['search_leads', { query: 'first' }],
    ] as const) {
      const body = JSON.parse(toolText(await h.rpc(call(tool, args), LEGACY)).text) as {
        freshness: Record<string, string>;
      };
      expect(body.freshness).toEqual({
        refreshed_at: '2026-10-10T04:00:00Z',
        age: '3 days',
        state: 'old',
        note: 'This copy of the pipeline is 3 days old (10 Oct 2026, 12:00 pm Perth time). Do not present it as current. It is refreshed when someone presses Refresh in the Command Centre.',
      });
    }
  });

  it('a list never carries an email or a phone; one lead in full does', async () => {
    const withContact = leadRow(1, { email: 'lead1@example.test', phone: '+61400000001' });
    const list = toolText(
      await (
        await harness(() => granted(listing([withContact])))
      ).rpc(call('list_leads', {}), LEGACY),
    ).text;
    const search = toolText(
      await (
        await harness(() =>
          granted(listing([{ ...withContact, matched_on: ['email'] }], { limit: 10 })),
        )
      ).rpc(call('search_leads', { query: 'lead1@example' }), LEGACY),
    ).text;
    for (const text of [list, search]) {
      expect(text).not.toContain('lead1@example.test');
      expect(text).not.toContain('+61400000001');
    }
    expect(JSON.parse(search)).toMatchObject({
      leads: [{ lead_id: 'op-1', matched_on: ['email'] }],
    });
    const one = toolText(
      await (
        await harness(() => granted(leadDetail()))
      ).rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY),
    ).text;
    expect(JSON.parse(one)).toMatchObject({
      lead: { contact: { email: 'lead1@example.test', phone: '+61400000001' } },
    });
  });
});

// ---------------------------------------------------------------------------------------
describe('the run', () => {
  it('many calls at once on one key: each is asked of the database once and answered under its own id', async () => {
    const h = await harness(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      return granted(leadDetail({ lead_id: (input.args as { lead_id: string }).lead_id }));
    });
    const ids = Array.from({ length: 40 }, (_unused, i) => `op-${String(i)}`);
    const responses = await Promise.all(
      ids.map((id, i) => h.rpc(call('get_lead', { lead_id: id }, i), LEGACY)),
    );
    expect(h.store.calls).toHaveLength(40);
    responses.forEach((response, i) => {
      expect(json(response)['id']).toBe(i);
      expect(
        (JSON.parse(toolText(response).text) as { lead: { lead_id: string } }).lead.lead_id,
      ).toBe(ids[i]);
    });
  });

  it('the rate limit reached on a tool call: a clear result with how long to wait, not a hang', async () => {
    const h = await harness(() =>
      ok({
        outcome: 'rate_limited',
        keyId: 'aaaaaaaaaaaa',
        window: 'minute',
        retryAfterSeconds: 14,
      }),
    );
    const response = await h.rpc(call('list_leads', {}), LEGACY);
    expect(response.status).toBe(200);
    expect(toolText(response)).toEqual({
      isError: true,
      text: 'Too many requests in the last minute for this key. Nothing was read. Wait 14 seconds, then try again — and do not retry in a loop.',
    });
    expect(requestLines(h.lines).at(-1)).toMatchObject({
      outcome: 'rate_limited',
      caller: 'aaaaaaaaaaaa',
    });
  });

  it('the rate limit reached on anything else: 429 with Retry-After and an error his AI can tell apart', async () => {
    const h = await harness(() =>
      ok({
        outcome: 'rate_limited',
        keyId: 'aaaaaaaaaaaa',
        window: 'day',
        retryAfterSeconds: 7_200,
      }),
    );
    const response = await h.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, LEGACY);
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('7200');
    expect(json(response)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: APP_CODE.rateLimited,
        message:
          'This key has reached its limit of requests for one day. Nothing was read. It can be used again in about 2 hours.',
        data: { reason: 'rate_limited', retry_after_seconds: 7_200 },
      },
    });
  });

  it('the database unavailable mid-call: 503, nothing served, and the cause stays in our log', async () => {
    const h = await harness(databaseDown);
    for (const message of [
      call('pipeline_summary', {}),
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    ]) {
      const response = await h.rpc(message, LEGACY);
      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('30');
      expect(errorOf(response)).toMatchObject({
        code: APP_CODE.unavailable,
        message: UNAVAILABLE_MESSAGE,
        data: { reason: 'unavailable', retry_after_seconds: 30 },
      });
      expect(response.body).not.toContain('transport');
    }
    expect(h.lines.some((line) => line.includes('the database call failed'))).toBe(true);
  });

  it('a call that times out upstream, or a store that throws: the same 503', async () => {
    const timedOut = await harness(() => err(new TimeoutError('connector_call: timed out', 8_000)));
    expect((await timedOut.rpc(call('pipeline_summary', {}), LEGACY)).status).toBe(503);
    const threw = await harness(() => {
      throw new AppError('INTERNAL', 'boom');
    });
    const response = await threw.rpc(call('pipeline_summary', {}), LEGACY);
    expect(response.status).toBe(503);
    expect(response.body).not.toContain('boom');
    expect(threw.lines.some((line) => line.includes('request threw'))).toBe(true);
  });

  it('two keys used at once by different users: each request carries its own key and gets its own answer', async () => {
    const other = await mintKey();
    const h = await harness(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      return granted(
        leadDetail({ opportunity_name: `seen by ${input.credential.keyId}` }),
        input.credential.keyId,
      );
    });
    const send = (key: string, id: number): ReturnType<typeof h.send> =>
      h.send({
        headers: { authorization: `Bearer ${key}`, ...LEGACY },
        body: JSON.stringify(call('get_lead', { lead_id: 'op-1' }, id)),
      });
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, i) => send(i % 2 === 0 ? h.key.key : other.key, i)),
    );
    responses.forEach((response, i) => {
      const expected = i % 2 === 0 ? h.key.keyId : other.keyId;
      expect(
        (JSON.parse(toolText(response).text) as { lead: { opportunity_name: string } }).lead
          .opportunity_name,
      ).toBe(`seen by ${expected}`);
    });
    const digests = new Set(h.store.calls.map((sent) => sent.credential.digestHex));
    expect(digests).toEqual(new Set([h.key.digestHex, other.digestHex]));
  });
});

// ---------------------------------------------------------------------------------------
describe('what is logged, and what never is', () => {
  it('one line per request: who by public id, which tool, the outcome, how long, how many, how big', async () => {
    const h = await harness(() => granted(listing([leadRow(1), leadRow(2)]), 'bbbbbbbbbbbb'));
    const response = await h.rpc(call('list_leads', {}), LEGACY);
    const lines = requestLines(h.lines);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      caller: 'bbbbbbbbbbbb',
      method: 'tools/call',
      tool: 'list_leads',
      outcome: 'ok',
      status: 200,
      records: 2,
      era: 'legacy',
      version: '2025-06-18',
      bytesOut: new TextEncoder().encode(response.body ?? '').length,
    });
    expect(typeof lines[0]?.['durationMs']).toBe('number');
  });

  it("never the key, a lead's name, email, phone or note, or the text of a search", async () => {
    const h = await harness((input) =>
      granted(
        input.tool === 'get_lead'
          ? leadDetail()
          : listing([leadRow(1, { matched_on: ['name'] })], { limit: 10 }),
      ),
    );
    await h.rpc(call('get_lead', { lead_id: 'op-1' }), LEGACY);
    await h.rpc(call('search_leads', { query: 'Secret Surname 0400111222' }), LEGACY);
    await h.rpc(call('search_leads', { query: 'x' }), LEGACY);
    await h.rpc(call('nope', {}), LEGACY);
    const all = h.lines.join('\n');
    expect(all).not.toContain(h.key.key);
    expect(all).not.toContain(h.key.key.slice(-43));
    expect(all).not.toContain(h.key.digestHex);
    for (const secret of [
      'First1',
      'Example1',
      'lead1@example.test',
      '+61400000001',
      'Payslips received',
      'callback after 5pm',
      'Secret Surname',
      '0400111222',
      'Joondalup',
      'nope',
    ]) {
      expect(all, secret).not.toContain(secret);
    }
    // The public id is not redacted away: it is how a log line is tied to a key.
    expect(requestLines(h.lines)[0]?.['caller']).toBe('aaaaaaaaaaaa');
  });

  it('a refusal before the database is logged too, with no caller: the key was never checked', async () => {
    const h = await harness();
    await h.send({ body: '{}' });
    await h.send({ method: 'GET' });
    expect(
      requestLines(h.lines).map((line) => [line['outcome'], line['caller'], line['status']]),
    ).toEqual([
      ['unauthenticated', null, 401],
      ['method_not_allowed', null, 405],
    ]);
  });
});

// ---------------------------------------------------------------------------------------
describe('planMessage — judged before any key is checked', () => {
  const none = { get: (): null => null };

  it('a tool call is planned with its tool and its bounded arguments; everything else reads nothing', () => {
    const planned = planMessage(none, call('list_leads', { limit: 500, status: 'won' }), false);
    expect(planned).toMatchObject({
      method: 'tools/call',
      tool: 'list_leads',
      isToolCall: true,
      id: 7,
      era: 'legacy',
      version: '2025-03-26',
      args: { limit: 50, status: 'won', stage_id: null, has_cursor: false },
    });
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/cancelled' },
      call('get_lead', {}),
      call('drop_everything', {}),
      'nonsense',
    ]) {
      const plan = planMessage(none, message, false);
      expect(plan.tool).toBeNull();
      expect(plan.args).toBeNull();
    }
  });
});
