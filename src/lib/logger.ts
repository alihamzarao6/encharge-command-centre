/**
 * Structured JSON logger with secret redaction at the serialiser level.
 *
 * Every log line passes through `serialiseForLog`, which redacts by key name (nested, any
 * depth) and by value pattern (known key prefixes) before anything is written. Call sites
 * cannot opt out, so a new field added anywhere in the codebase gets the same protection as
 * the first one — the point of CLAUDE.md rule 19/20 and SECURITY.md §4.
 *
 * What it refuses to do: log full page bodies or unbounded strings (truncated), follow
 * cycles (marked), or recurse forever (depth-limited).
 */

import { AppError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every line it writes. */
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string, level: Exclude<LogLevel, 'silent'>) => void;

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly name?: string;
  readonly sink?: LogSink;
  readonly clock?: () => Date;
  readonly bindings?: LogFields;
}

export const REDACTED = '[REDACTED]';

/**
 * Key fragments that mark a value as secret. Matched case-insensitively against the key with
 * separators removed, so `x-api-key`, `apiKey`, `SERVICE_ROLE_KEY`, `Authorization` and
 * `refresh_token` all match. Over-redaction is the safe direction: a `keyboard_layout`
 * field that gets redacted costs a moment of debugging; a leaked key costs the client money.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'credential',
  'key',
];

/**
 * Value patterns for credentials the project actually handles. Redacted wherever they
 * appear in a string — including inside a message or a URL — regardless of the key.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bpit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // GoHighLevel PIT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT (Supabase keys)
  /\b(?:secret|ntn)_[A-Za-z0-9]{16,}\b/g, // Notion
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // Authorization header values
];

const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 200;

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Produce a JSON-safe, redacted copy of any value. Pure; never throws. This is the single
 * choke point for everything the logger writes.
 */
export function serialiseForLog(value: unknown): unknown {
  return serialiseInner(value, 0, new WeakSet());
}

function serialiseInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case 'string':
      return truncate(redactString(value));
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function]';
    case 'object':
      return serialiseObject(value, depth, seen);
    case 'undefined':
      return undefined;
    default:
      return '[Unknown]';
  }
}

function serialiseObject(value: object, depth: number, seen: WeakSet<object>): unknown {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (value instanceof URL) {
    return truncate(redactString(stripUrlSecrets(value)));
  }
  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      return serialiseError(value, depth, seen);
    }
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item: unknown) => serialiseInner(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`);
      }
      return items;
    }
    if (value instanceof Map) {
      return serialiseEntries([...value.entries()], depth, seen);
    }
    if (value instanceof Set) {
      return [...value.values()].map((item: unknown) => serialiseInner(item, depth + 1, seen));
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return `[Binary ${value.byteLength} bytes]`;
    }
    return serialiseEntries(Object.entries(value), depth, seen);
  } finally {
    seen.delete(value);
  }
}

function serialiseEntries(
  entries: readonly (readonly [unknown, unknown])[],
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = typeof rawKey === 'string' ? rawKey : String(rawKey);
    if (rawValue === undefined) {
      continue;
    }
    out[key] = isSecretKey(key) ? REDACTED : serialiseInner(rawValue, depth + 1, seen);
  }
  return out;
}

function serialiseError(error: Error, depth: number, seen: WeakSet<object>): unknown {
  const base: Record<string, unknown> = {
    name: error.name,
    message: truncate(redactString(error.message)),
  };
  if (typeof error.stack === 'string') {
    base['stack'] = truncate(redactString(error.stack));
  }
  if (error instanceof AppError) {
    base['code'] = error.code;
    base['retryable'] = error.retryable;
    base['context'] = serialiseEntries(Object.entries(error.context), depth, seen);
    // Subclass-specific enumerable fields (status, issues, timeoutMs …), redacted like any other.
    for (const [key, value] of Object.entries(error)) {
      if (!(key in base) && key !== 'code' && key !== 'retryable' && key !== 'context') {
        base[key] = isSecretKey(key) ? REDACTED : serialiseInner(value, depth + 1, seen);
      }
    }
  }
  if (error.cause !== undefined) {
    base['cause'] = serialiseInner(error.cause, depth + 1, seen);
  }
  return base;
}

function stripUrlSecrets(url: URL): string {
  const copy = new URL(url.toString());
  copy.username = '';
  copy.password = '';
  for (const key of [...copy.searchParams.keys()]) {
    if (isSecretKey(key)) {
      copy.searchParams.set(key, REDACTED);
    }
  }
  return copy.toString();
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`
    : value;
}

// ---------------------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------------------

const defaultSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value === undefined) {
    return fallback;
  }
  const lowered = value.trim().toLowerCase();
  return isLogLevel(lowered) ? lowered : fallback;
}

function isLogLevel(value: string): value is LogLevel {
  return Object.hasOwn(LEVEL_ORDER, value);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? ((): Date => new Date());
  const bindings: LogFields = options.bindings ?? {};
  const name = options.name;

  const write = (lineLevel: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) {
      return;
    }
    const record: Record<string, unknown> = {
      ts: clock().toISOString(),
      level: lineLevel,
      ...(name === undefined ? {} : { logger: name }),
      msg: truncate(redactString(msg)),
    };
    const payload = serialiseForLog({ ...bindings, ...(fields ?? {}) });
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(payload)) {
        // Reserved keys stay reserved so a field named `level` cannot forge a line's severity.
        if (key === 'ts' || key === 'level' || key === 'msg' || key === 'logger') {
          record[`field_${key}`] = value;
        } else {
          record[key] = value;
        }
      }
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        ts: record['ts'],
        level: lineLevel,
        msg: '[unserialisable log record]',
      });
    }
    sink(line, lineLevel);
  };

  const logger: Logger = {
    level,
    debug: (msg, fields) => {
      write('debug', msg, fields);
    },
    info: (msg, fields) => {
      write('info', msg, fields);
    },
    warn: (msg, fields) => {
      write('warn', msg, fields);
    },
    error: (msg, fields) => {
      write('error', msg, fields);
    },
    child: (childBindings) =>
      createLogger({
        level,
        sink,
        clock,
        bindings: { ...bindings, ...childBindings },
        ...(name === undefined ? {} : { name }),
      }),
  };
  return logger;
}

/** Process-wide default. Level comes from LOG_LEVEL; everything else is the default. */
export const logger: Logger = createLogger({
  level: parseLogLevel(process.env['LOG_LEVEL']),
  name: 'encharge',
});
