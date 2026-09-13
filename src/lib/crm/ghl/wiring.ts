/**
 * Production wiring for the crm endpoint (Milestone 4 part 2): the same client, store and
 * sync the CLI runs (`npm run crm -- sync`), behind the same caller verification the admin
 * and memory endpoints use. The Edge Function calls this once per request; the token is read
 * here, at request time, from the environment — never bundled.
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  supabaseVerifyDeps,
} from '../../auth/clients.js';
import { ok, type ConfigError, type Result } from '../../errors.js';
import { createHttpClient } from '../../http.js';
import type { Logger } from '../../logger.js';
import { createGhlClient } from './client.js';
import { loadGhlConfig } from './config.js';
import type { CrmPageDeps } from './page.js';
import { createGhlServiceClient, supabaseGhlSyncStore } from './store.js';
import { runGhlSync } from './sync.js';

type Env = Readonly<Record<string, string | undefined>>;

export function createCrmPageDeps(env: Env, log: Logger): Result<CrmPageDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const ghl = loadGhlConfig(env);
  if (!ghl.ok) return ghl;
  const config = ghl.value;
  const store = supabaseGhlSyncStore(createGhlServiceClient(supabase.value));
  const http = createHttpClient({ timeoutMs: config.timeoutMs, logger: log });
  const client = createGhlClient({ config, http, log });
  return ok({
    verify: supabaseVerifyDeps(createServiceClient(supabase.value)),
    runSync: (options) => runGhlSync({ client, store, config, log }, options),
    log,
  });
}
