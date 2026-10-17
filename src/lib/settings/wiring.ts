/**
 * Production wiring for the settings page's endpoint (Milestone 5 part 4). One function, used by
 * the Edge Function; the environment is passed in, never read implicitly.
 *
 * Deliberately narrow, like the users page: no Claude client, no Voyage. Forgetting a document
 * and switching a key off must keep working on a day when the model is down, the cap has tripped
 * or the embedding provider is refusing calls — that is exactly the day someone needs to. The
 * cap's configuration is read with the same loader the chat uses, so the number on the page is
 * the number the cap enforces; when it cannot be read, only the spending section says so.
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  supabaseVerifyDeps,
} from '../auth/clients.js';
import { ok, type ConfigError, type Result } from '../errors.js';
import { loadLlmConfig } from '../llm/config.js';
import { supabaseUsageStore } from '../llm/store.js';
import type { Logger } from '../logger.js';
import type { SettingsPageDeps } from './page.js';
import { createSettingsClient, supabaseSettingsStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

export function createSettingsPageDeps(
  env: Env,
  log: Logger,
): Result<SettingsPageDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const service = createServiceClient(supabase.value);
  const llm = loadLlmConfig(env);
  return ok({
    verify: supabaseVerifyDeps(service),
    store: supabaseSettingsStore(createSettingsClient(supabase.value)),
    usage: supabaseUsageStore(service),
    caps: llm.ok ? ok(llm.value.caps) : llm,
    log,
  });
}
