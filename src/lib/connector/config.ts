/**
 * The connector's settings (MCP connector, stage 1). The only module that reads them.
 *
 * THE PUBLIC ADDRESS IS ONE SETTING. The address the client types into his AI is
 * `CONNECTOR_PUBLIC_URL`. Until his own domain exists it is unset, and the address is the
 * function's own URL on the Supabase project. When the domain lands it is set to
 * `https://<his domain>/mcp` — the path the rewrite in vercel.json already serves on every
 * domain of the web project — and nothing in the code changes.
 *
 * WHAT IS NOT READ HERE. The connector knows which pipeline it may read (`GHL_PIPELINE_ID`,
 * the same variable the sync uses) and nothing else about GoHighLevel: not the token, not
 * the location, not the API's address. It cannot call GoHighLevel because it does not hold
 * what a call would need (tests/security/connector.test.ts).
 */
import { ConfigError, err, ok, type Result } from '../errors.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface ConnectorConfig {
  /** The ONE pipeline a tool may read. An id, never a name (R22, R25). */
  readonly pipelineId: string;
  /** The address the client gives his AI. */
  readonly publicUrl: string;
  /** Browser origins allowed to call. Empty: a request that carries an Origin is refused. */
  readonly allowedOrigins: readonly string[];
  readonly perMinute: number;
  readonly perDay: number;
  /** Deadline on the one database call a request makes. */
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
}

export const CONNECTOR_DEFAULTS = {
  /** One call every two seconds: more than a person's question needs, less than a loop asks. */
  perMinute: 30,
  /** What a runaway agent can take in a day, bounded. */
  perDay: 1_000,
  timeoutMs: 8_000,
  /** A real request is under 2 KiB. */
  maxBodyBytes: 64 * 1024,
} as const;

export const FUNCTION_PATH = '/functions/v1/connector';

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readInt(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Result<number, ConfigError> {
  const raw = read(env, name);
  if (raw === undefined) return ok(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return err(
      new ConfigError(`${name} must be a whole number from ${String(min)} to ${String(max)}`),
    );
  }
  return ok(value);
}

/** An https address with no query, no fragment and no credentials, without a trailing slash. */
function publicAddress(raw: string, name: string): Result<string, ConfigError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(new ConfigError(`${name} must be an https address`));
  }
  if (
    url.protocol !== 'https:' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return err(
      new ConfigError(`${name} must be an https address with no query, fragment or credentials`),
    );
  }
  return ok(`${url.origin}${url.pathname.replace(/\/+$/, '')}`);
}

function origins(raw: string | undefined): Result<readonly string[], ConfigError> {
  if (raw === undefined) return ok([]);
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (candidate === '') continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return err(
        new ConfigError('CONNECTOR_ALLOWED_ORIGINS must be a comma-separated list of origins'),
      );
    }
    if (url.origin === 'null' || url.origin !== candidate.replace(/\/+$/, '')) {
      return err(
        new ConfigError('CONNECTOR_ALLOWED_ORIGINS entries must be origins: scheme://host[:port]'),
      );
    }
    out.push(url.origin);
  }
  return ok(out);
}

export function loadConnectorConfig(env: Env): Result<ConnectorConfig, ConfigError> {
  const pipelineId = read(env, 'GHL_PIPELINE_ID');
  if (pipelineId === undefined) {
    return err(
      new ConfigError(
        'GHL_PIPELINE_ID is required: the connector reads exactly one pipeline, by id',
      ),
    );
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pipelineId)) {
    return err(new ConfigError('GHL_PIPELINE_ID is not a GoHighLevel id'));
  }

  const configured = read(env, 'CONNECTOR_PUBLIC_URL');
  const supabaseUrl = read(env, 'SUPABASE_URL');
  let publicUrl: Result<string, ConfigError>;
  if (configured !== undefined) {
    publicUrl = publicAddress(configured, 'CONNECTOR_PUBLIC_URL');
  } else if (supabaseUrl !== undefined) {
    // Until the client's domain exists: the function's own address. A local stack is http.
    publicUrl = ok(`${supabaseUrl.replace(/\/+$/, '')}${FUNCTION_PATH}`);
  } else {
    publicUrl = err(new ConfigError('CONNECTOR_PUBLIC_URL or SUPABASE_URL is required'));
  }
  if (!publicUrl.ok) return publicUrl;

  const allowedOrigins = origins(read(env, 'CONNECTOR_ALLOWED_ORIGINS'));
  if (!allowedOrigins.ok) return allowedOrigins;
  const perMinute = readInt(env, 'CONNECTOR_RATE_PER_MINUTE', CONNECTOR_DEFAULTS.perMinute, 1, 120);
  if (!perMinute.ok) return perMinute;
  const perDay = readInt(env, 'CONNECTOR_RATE_PER_DAY', CONNECTOR_DEFAULTS.perDay, 1, 10_000);
  if (!perDay.ok) return perDay;
  const timeoutMs = readInt(
    env,
    'CONNECTOR_TIMEOUT_MS',
    CONNECTOR_DEFAULTS.timeoutMs,
    1_000,
    30_000,
  );
  if (!timeoutMs.ok) return timeoutMs;

  return ok({
    pipelineId,
    publicUrl: publicUrl.value,
    allowedOrigins: allowedOrigins.value,
    perMinute: perMinute.value,
    perDay: perDay.value,
    timeoutMs: timeoutMs.value,
    maxBodyBytes: CONNECTOR_DEFAULTS.maxBodyBytes,
  });
}
