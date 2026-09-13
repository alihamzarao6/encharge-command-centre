/**
 * GoHighLevel configuration (Milestone 4 part 1) — SERVER environment only.
 *
 * This is the only module in the repository that reads GHL_PRIVATE_INTEGRATION_TOKEN and
 * the only one that names the GHL origin (tests/security/ghl.test.ts asserts both, the
 * same rule as the Anthropic and Voyage keys). The token is held in the returned config
 * and used by client.ts to set one request header; it is never logged (the logger redacts
 * `Authorization` by key name and the `pit-` shape by pattern), never returned to a
 * caller, never part of an error message.
 *
 * Everything an operator might change without a redeploy is here: the pipeline this
 * system mirrors (BY ID — R22/R25: the location is shared, nothing is read account-wide,
 * and the name is not to be trusted), the custom-field folders whose definitions are kept
 * even when no contact carries a value, timeouts, retries and the run caps that turn "too
 * big" into a loud refusal instead of a silent truncation.
 */
import { ConfigError, err, ok, type Result } from '../../errors.js';

export interface GhlConfig {
  readonly token: string;
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly locationId: string;
  /** The ONE pipeline this system reads. Verified against the pipelines list before any sync. */
  readonly pipelineId: string;
  /** Custom-field folders (GHL `parentId`) whose definitions are mirrored even when unused. */
  readonly customFieldFolderIds: readonly string[];
  readonly timeoutMs: number;
  /** Retries after the first attempt, GET only — http.ts never retries a write. */
  readonly retries: number;
  /** Opportunities per page. GHL's documented maximum is 100. */
  readonly pageSize: number;
  /** Hard cap on pages per run. Reaching it fails the run rather than truncating. */
  readonly maxPages: number;
  /** Hard cap on distinct contacts fetched per run. Same posture. */
  readonly maxContactsPerRun: number;
  /** A run still `running` after this long is treated as interrupted and marked failed. */
  readonly staleRunAfterSeconds: number;
  /** When GHL's remaining-requests header drops to this, wait out the window before continuing. */
  readonly rateLimitFloor: number;
}

export const GHL_API_BASE_URL = 'https://services.leadconnectorhq.com';
export const GHL_API_VERSION = '2021-07-28';

export const GHL_DEFAULTS = {
  timeoutMs: 20_000,
  retries: 3,
  pageSize: 100,
  maxPages: 50,
  maxContactsPerRun: 2_000,
  staleRunAfterSeconds: 15 * 60,
  rateLimitFloor: 5,
} as const;

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function readNumber(
  env: Env,
  name: string,
  fallback: number,
  predicate: (n: number) => boolean,
  requirement: string,
): Result<number, ConfigError> {
  const raw = read(env, name);
  if (raw === undefined) return ok(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || !predicate(value)) {
    return err(new ConfigError(`${name} must be ${requirement}`, { context: { name } }));
  }
  return ok(value);
}

const positiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;

/** True when the environment carries a GHL token at all. */
export function hasGhlToken(env: Env): boolean {
  return read(env, 'GHL_PRIVATE_INTEGRATION_TOKEN') !== undefined;
}

export function loadGhlConfig(env: Env = process.env): Result<GhlConfig, ConfigError> {
  const token = read(env, 'GHL_PRIVATE_INTEGRATION_TOKEN');
  if (token === undefined) {
    return err(
      new ConfigError('GHL_PRIVATE_INTEGRATION_TOKEN is required (server environment only)'),
    );
  }
  const locationId = read(env, 'GHL_LOCATION_ID');
  if (locationId === undefined) {
    return err(new ConfigError('GHL_LOCATION_ID is required'));
  }
  const pipelineId = read(env, 'GHL_PIPELINE_ID');
  if (pipelineId === undefined) {
    return err(
      new ConfigError(
        'GHL_PIPELINE_ID is required: the sync reads exactly one pipeline, by id (R22, R25)',
      ),
    );
  }
  const baseUrl = read(env, 'GHL_API_BASE') ?? GHL_API_BASE_URL;
  if (!baseUrl.startsWith('https://')) {
    return err(new ConfigError('GHL_API_BASE must be an https URL'));
  }
  const timeoutMs = readNumber(
    env,
    'GHL_TIMEOUT_MS',
    GHL_DEFAULTS.timeoutMs,
    positiveInt,
    'a positive integer',
  );
  if (!timeoutMs.ok) return timeoutMs;
  const retries = readNumber(
    env,
    'GHL_RETRIES',
    GHL_DEFAULTS.retries,
    (n) => Number.isInteger(n) && n >= 0 && n <= 5,
    'an integer from 0 to 5',
  );
  if (!retries.ok) return retries;
  const pageSize = readNumber(
    env,
    'GHL_PAGE_SIZE',
    GHL_DEFAULTS.pageSize,
    (n) => Number.isInteger(n) && n >= 1 && n <= 100,
    'an integer from 1 to 100',
  );
  if (!pageSize.ok) return pageSize;
  const maxPages = readNumber(
    env,
    'GHL_MAX_PAGES',
    GHL_DEFAULTS.maxPages,
    (n) => Number.isInteger(n) && n >= 1 && n <= 1_000,
    'an integer from 1 to 1000',
  );
  if (!maxPages.ok) return maxPages;
  const maxContacts = readNumber(
    env,
    'GHL_MAX_CONTACTS_PER_RUN',
    GHL_DEFAULTS.maxContactsPerRun,
    (n) => Number.isInteger(n) && n >= 1 && n <= 100_000,
    'an integer from 1 to 100000',
  );
  if (!maxContacts.ok) return maxContacts;
  const stale = readNumber(
    env,
    'GHL_STALE_RUN_AFTER_SECONDS',
    GHL_DEFAULTS.staleRunAfterSeconds,
    (n) => Number.isInteger(n) && n >= 60,
    'an integer >= 60',
  );
  if (!stale.ok) return stale;
  const floor = readNumber(
    env,
    'GHL_RATE_LIMIT_FLOOR',
    GHL_DEFAULTS.rateLimitFloor,
    (n) => Number.isInteger(n) && n >= 0 && n <= 50,
    'an integer from 0 to 50',
  );
  if (!floor.ok) return floor;

  const folders = (read(env, 'GHL_CUSTOM_FIELD_FOLDER_IDS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  return ok({
    token,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiVersion: read(env, 'GHL_API_VERSION') ?? GHL_API_VERSION,
    locationId,
    pipelineId,
    customFieldFolderIds: folders,
    timeoutMs: timeoutMs.value,
    retries: retries.value,
    pageSize: pageSize.value,
    maxPages: maxPages.value,
    maxContactsPerRun: maxContacts.value,
    staleRunAfterSeconds: stale.value,
    rateLimitFloor: floor.value,
  });
}
