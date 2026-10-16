/**
 * Production wiring for Google Drive (Milestone 5 part 3a): the one place the environment is
 * turned into the `drive` endpoint's dependencies. The environment is passed in, never read
 * implicitly — Deno.env on the Edge Function, process.env in a script, a literal in a test.
 *
 * Drive not set up (no Google values at all) is not an error: the endpoint answers `status`
 * with "unavailable" and refuses the rest in a sentence. Half set up is an error (config.ts).
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  supabaseVerifyDeps,
} from '../auth/clients.js';
import { ok, type ConfigError, type Result } from '../errors.js';
import { createHttpClient, type FetchLike, type HttpClient } from '../http.js';
import type { Logger } from '../logger.js';
import { loadDriveConfig } from './config.js';
import { createGoogleClient } from './google.js';
import type { DrivePageDeps } from './page.js';
import { createDriveServiceClient, supabaseDriveStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The HTTP client for Google, at module scope so a warm function keeps its circuit breakers
 * between requests: five failures in a row to one Google origin rests it for thirty seconds
 * rather than letting every request wait out its own timeout.
 */
let sharedHttp: HttpClient | null = null;

function googleHttp(log: Logger, fetchImpl?: FetchLike): HttpClient {
  if (fetchImpl !== undefined) {
    return createHttpClient({ fetch: fetchImpl, retries: 2, logger: log });
  }
  sharedHttp ??= createHttpClient({ retries: 2, logger: log });
  return sharedHttp;
}

export async function createDrivePageDeps(
  env: Env,
  log: Logger,
  runtime: { readonly fetch?: FetchLike } = {},
): Promise<Result<DrivePageDeps, ConfigError>> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const config = await loadDriveConfig(env);
  if (!config.ok) return config;

  const service = createServiceClient(supabase.value);
  const verify = supabaseVerifyDeps(service);
  if (config.value === null) return ok({ verify, drive: null, log });

  return ok({
    verify,
    drive: {
      config: config.value,
      google: createGoogleClient({
        config: config.value,
        http: googleHttp(log, runtime.fetch),
      }),
      store: supabaseDriveStore(createDriveServiceClient(supabase.value)),
    },
    log,
  });
}
