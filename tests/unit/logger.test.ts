import { describe, expect, it } from 'vitest';

import { HttpStatusError, ValidationError } from '../../src/lib/errors.js';
import {
  REDACTED,
  createLogger,
  isSecretKey,
  parseLogLevel,
  redactString,
  serialiseForLog,
  type LogLevel,
} from '../../src/lib/logger.js';

// Fixture credentials: shaped like the real thing, not real. Built by concatenation so the
// repo's own secret scanner does not trip on its own test file.
const FAKE_ANTHROPIC = ['sk-ant-', 'api03-', 'A'.repeat(40)].join('');
const FAKE_PIT = ['pit-', '0123abcd-1111-2222-3333-444455556666'].join('');
const FAKE_JWT = ['eyJ', 'a'.repeat(20), '.', 'b'.repeat(20), '.', 'c'.repeat(20)].join('');
const FAKE_NOTION = ['secret_', 'Z'.repeat(30)].join('');

function capture(level: LogLevel = 'debug'): {
  lines: { level: string; record: Record<string, unknown> }[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: { level: string; record: Record<string, unknown> }[] = [];
  const logger = createLogger({
    level,
    name: 'test',
    clock: () => new Date('2026-08-23T00:00:00.000Z'),
    sink: (line, lineLevel) => {
      lines.push({ level: lineLevel, record: JSON.parse(line) as Record<string, unknown> });
    },
  });
  return { lines, logger };
}

describe('isSecretKey', () => {
  it.each([
    'password',
    'PASSWORD',
    'user_password',
    'passwd',
    'secret',
    'client_secret',
    'token',
    'refresh_token',
    'accessToken',
    'authorization',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'credential',
    'credentials',
    'key',
    'apiKey',
    'api_key',
    'x-api-key',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ANTHROPIC_API_KEY',
    'privateKey',
  ])('%s is a secret key', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(['user_id', 'email', 'status', 'url', 'message', 'count', 'conversationId', 'auth_ok'])(
    '%s is not a secret key',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );
});

describe('redactString', () => {
  it('redacts known credential shapes wherever they appear', () => {
    expect(redactString(`key=${FAKE_ANTHROPIC} sent`)).toBe(`key=${REDACTED} sent`);
    expect(redactString(`token ${FAKE_PIT}`)).toBe(`token ${REDACTED}`);
    expect(redactString(`jwt ${FAKE_JWT}.`)).toBe(`jwt ${REDACTED}.`);
    expect(redactString(`notion ${FAKE_NOTION}`)).toBe(`notion ${REDACTED}`);
    expect(redactString('Authorization: Bearer abcdefghijklmnop')).toBe(
      `Authorization: ${REDACTED}`,
    );
  });

  it('leaves ordinary text alone', () => {
    expect(redactString('GET https://example.com/path responded 200')).toBe(
      'GET https://example.com/path responded 200',
    );
  });
});

describe('serialiseForLog — redaction at the serialiser level', () => {
  it('redacts secret keys at the top level', () => {
    expect(serialiseForLog({ password: 'p', email: 'e' })).toEqual({
      password: REDACTED,
      email: 'e',
    });
  });

  it('redacts nested secret keys at any depth, including inside arrays', () => {
    const input = {
      request: {
        headers: { Authorization: 'Bearer x', 'content-type': 'json' },
        body: { user: { apiKey: 'k', name: 'n' } },
      },
      list: [{ token: 't', id: 1 }, { nested: { deeper: { secret: 's', keep: 'k' } } }],
    };
    expect(serialiseForLog(input)).toEqual({
      request: {
        headers: { Authorization: REDACTED, 'content-type': 'json' },
        body: { user: { apiKey: REDACTED, name: 'n' } },
      },
      list: [{ token: REDACTED, id: 1 }, { nested: { deeper: { secret: REDACTED, keep: 'k' } } }],
    });
  });

  it('redacts secret-shaped values even under innocent keys', () => {
    expect(serialiseForLog({ note: `use ${FAKE_ANTHROPIC} for calls` })).toEqual({
      note: `use ${REDACTED} for calls`,
    });
  });

  it('redacts secret keys inside Map entries', () => {
    const map = new Map<string, unknown>([
      ['token', 'abc'],
      ['id', 7],
    ]);
    expect(serialiseForLog(map)).toEqual({ token: REDACTED, id: 7 });
  });

  it('redacts secret query params and credentials in URL objects', () => {
    const url = new URL('https://user:pw@example.com/path?api_key=abc&page=2');
    expect(serialiseForLog(url)).toBe(
      `https://example.com/path?api_key=${encodeURIComponent(REDACTED)}&page=2`,
    );
  });

  it('serialises Error and AppError instances, redacting their context and fields', () => {
    const error = new HttpStatusError('failed', 503, {
      context: { url: 'https://x', authorization: 'Bearer abc' },
      cause: new Error(`root ${FAKE_ANTHROPIC}`),
    });
    const out = serialiseForLog({ err: error }) as { err: Record<string, unknown> };
    expect(out.err['name']).toBe('HttpStatusError');
    expect(out.err['code']).toBe('HTTP_STATUS');
    expect(out.err['message']).toBe('failed');
    expect(out.err['retryable']).toBe(true);
    expect(out.err['status']).toBe(503);
    expect(out.err['context']).toEqual({ url: 'https://x', authorization: REDACTED, status: 503 });
    expect(typeof out.err['stack']).toBe('string');
    expect(out.err['cause']).toMatchObject({ name: 'Error', message: `root ${REDACTED}` });
  });

  it('includes subclass fields like ValidationError.issues', () => {
    const out = serialiseForLog(
      new ValidationError('bad', [{ path: 'a', message: 'm' }]),
    ) as Record<string, unknown>;
    expect(out['issues']).toEqual([{ path: 'a', message: 'm' }]);
  });

  it('handles plain Errors without AppError fields', () => {
    const out = serialiseForLog(new RangeError('r')) as Record<string, unknown>;
    expect(out['name']).toBe('RangeError');
    expect(out['message']).toBe('r');
    expect(out['code']).toBeUndefined();
  });

  it('marks cycles instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(serialiseForLog(a)).toEqual({ name: 'a', self: '[Circular]' });
  });

  it('does not mark the same object reached twice on different branches as circular', () => {
    const shared = { v: 1 };
    expect(serialiseForLog({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it('stops at the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i += 1) {
      deep = { child: deep };
    }
    const text = JSON.stringify(serialiseForLog(deep));
    expect(text).toContain('[MaxDepth]');
    expect(text).not.toContain('leaf');
  });

  it('truncates very long strings so page bodies never land in a log', () => {
    const out = serialiseForLog('x'.repeat(5000)) as string;
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain('[truncated 3000 chars]');
  });

  it('caps long arrays', () => {
    const out = serialiseForLog(Array.from({ length: 250 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(201);
    expect(out[200]).toBe('[+50 more]');
  });

  it('converts the awkward primitives and built-ins to JSON-safe values', () => {
    const out = serialiseForLog({
      big: 10n,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      sym: Symbol('s'),
      fn: () => 1,
      date: new Date('2026-01-02T03:04:05.000Z'),
      badDate: new Date('not a date'),
      re: /ab+c/i,
      set: new Set([1, 2]),
      buf: new Uint8Array(4),
      undef: undefined,
      nul: null,
      bool: false,
    });
    expect(out).toEqual({
      big: '10n',
      nan: 'NaN',
      inf: 'Infinity',
      sym: 'Symbol(s)',
      fn: '[Function]',
      date: '2026-01-02T03:04:05.000Z',
      badDate: 'Invalid Date',
      re: '/ab+c/i',
      set: [1, 2],
      buf: '[Binary 4 bytes]',
      nul: null,
      bool: false,
    });
  });

  it('passes through null, undefined and primitives at the top level', () => {
    expect(serialiseForLog(null)).toBeNull();
    expect(serialiseForLog(undefined)).toBeUndefined();
    expect(serialiseForLog(3)).toBe(3);
    expect(serialiseForLog(true)).toBe(true);
    expect(serialiseForLog(Symbol('q'))).toBe('Symbol(q)');
    expect(serialiseForLog(5n)).toBe('5n');
    expect(serialiseForLog(() => 0)).toBe('[Function]');
  });
});

describe('createLogger', () => {
  it('writes one JSON line per call with ts, level, logger, msg and fields', () => {
    const { lines, logger } = capture();
    logger.info('hello', { user_id: 'u1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('info');
    expect(lines[0]?.record).toEqual({
      ts: '2026-08-23T00:00:00.000Z',
      level: 'info',
      logger: 'test',
      msg: 'hello',
      user_id: 'u1',
    });
  });

  it('omits the logger name when none is set', () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (line) => {
        lines.push(line);
      },
    });
    logger.info('x');
    expect(JSON.parse(lines[0] ?? '{}')).not.toHaveProperty('logger');
  });

  it('redacts nested secrets in fields and secret shapes in the message', () => {
    const { lines, logger } = capture();
    logger.error(`call failed with ${FAKE_ANTHROPIC}`, {
      request: { headers: { 'x-api-key': 'abc' } },
    });
    expect(lines[0]?.record['msg']).toBe(`call failed with ${REDACTED}`);
    expect(lines[0]?.record['request']).toEqual({ headers: { 'x-api-key': REDACTED } });
  });

  it('filters below the configured level and honours silent', () => {
    const { lines, logger } = capture('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);

    const silent = capture('silent');
    silent.logger.error('nothing');
    expect(silent.lines).toHaveLength(0);
  });

  it('exposes its level', () => {
    expect(capture('error').logger.level).toBe('error');
  });

  it('child loggers carry bindings and let per-call fields override them', () => {
    const { lines, logger } = capture();
    const child = logger.child({ component: 'http', origin: 'a' });
    child.info('one');
    child.child({ origin: 'b' }).info('two', { extra: 1 });
    expect(lines[0]?.record).toMatchObject({ component: 'http', origin: 'a', msg: 'one' });
    expect(lines[1]?.record).toMatchObject({ component: 'http', origin: 'b', extra: 1 });
    expect(lines[1]?.record['logger']).toBe('test');
  });

  it('does not let a field forge the reserved keys', () => {
    const { lines, logger } = capture();
    logger.info('real', { level: 'error', msg: 'forged', ts: 'x', logger: 'y' });
    expect(lines[0]?.record['level']).toBe('info');
    expect(lines[0]?.record['msg']).toBe('real');
    expect(lines[0]?.record['field_level']).toBe('error');
    expect(lines[0]?.record['field_msg']).toBe('forged');
  });

  it('serialises errors passed in fields', () => {
    const { lines, logger } = capture();
    logger.error('failed', { err: new HttpStatusError('nope', 500) });
    expect(lines[0]?.record['err']).toMatchObject({ name: 'HttpStatusError', status: 500 });
  });

  it('writes to stdout by default', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      createLogger({ level: 'info' }).info('to stdout');
    } finally {
      process.stdout.write = original;
    }
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? '{}')).toMatchObject({ msg: 'to stdout' });
  });
});

describe('parseLogLevel', () => {
  it('accepts known levels case-insensitively and falls back otherwise', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(' warn ')).toBe('warn');
    expect(parseLogLevel('silent')).toBe('silent');
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel(undefined, 'error')).toBe('error');
  });
});
