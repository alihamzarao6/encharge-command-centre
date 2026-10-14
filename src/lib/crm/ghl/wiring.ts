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
import { readScheduleSecret } from '../schedule.js';
import { createGhlClient } from './client.js';
import { loadGhlConfig } from './config.js';
import { addNote, moveLead } from './moves.js';
import type { CrmPageDeps } from './page.js';
import { createGhlServiceClient, listGhlSyncRuns, supabaseGhlSyncStore } from './store.js';
import { runGhlSync } from './sync.js';
import { createGhlWriteClient } from './write.js';
import { createGhlWriteServiceClient, supabaseWriteStore } from './writeStore.js';

type Env = Readonly<Record<string, string | undefined>>;

export function createCrmPageDeps(env: Env, log: Logger): Result<CrmPageDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const ghl = loadGhlConfig(env);
  if (!ghl.ok) return ghl;
  const config = ghl.value;
  const service = createGhlServiceClient(supabase.value);
  const store = supabaseGhlSyncStore(service);
  const http = createHttpClient({ timeoutMs: config.timeoutMs, logger: log });
  const client = createGhlClient({ config, http, log });
  // Part 4: the write client and the write store share the http client (one breaker per
  // origin) and the service credentials; moves.ts orders the calls.
  const write = createGhlWriteClient({ config, http, log });
  const writeStore = supabaseWriteStore(createGhlWriteServiceClient(supabase.value));
  const moveDeps = { config, write, store: writeStore, log };
  return ok({
    verify: supabaseVerifyDeps(createServiceClient(supabase.value)),
    runSync: (options) => runGhlSync({ client, store, config, log }, options),
    move: (actor, request) => moveLead(moveDeps, actor, request),
    note: (actor, request) => addNote(moveDeps, actor, request),
    // The newest run of any status: what the cooldown (part 3, item 10) is measured from.
    latestRun: async () => {
      const runs = await listGhlSyncRuns(service, 1);
      if (!runs.ok) return runs;
      const newest = runs.value[0];
      return ok(
        newest === undefined
          ? null
          : { started_at: newest.started_at, finished_at: newest.finished_at },
      );
    },
    log,
    // The scheduler's credential, read at request time like every other secret here.
    scheduleSecret: readScheduleSecret(env),
  });
}
