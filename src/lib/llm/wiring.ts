/**
 * Production wiring for the chat path. One function, called by the Supabase Edge Function
 * (supabase/functions/chat) and by the CLI runner (scripts/chat.ts), so both run the same
 * code and there is exactly one place where the environment is turned into dependencies.
 *
 * The environment is passed in, never read implicitly: on Deno it is Deno.env, on Node it
 * is process.env, and in tests it is a literal.
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  supabaseVerifyDeps,
} from '../auth/clients.js';
import { ok, type ConfigError, type Result } from '../errors.js';
import { createHttpClient } from '../http.js';
import type { Logger } from '../logger.js';
import type { ChatDeps } from './chat.js';
import { createClaudeClient } from './client.js';
import { loadLlmConfig } from './config.js';
import { supabaseConversationStore, supabaseUsageStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

export function createChatDeps(env: Env, log: Logger): Result<ChatDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const llm = loadLlmConfig(env);
  if (!llm.ok) return llm;

  const service = createServiceClient(supabase.value);
  const http = createHttpClient({
    timeoutMs: llm.value.timeoutMs,
    // client.ts owns the retry policy (only provably-unbilled failures); http.ts must not
    // add a second layer on top.
    retries: 0,
    logger: log,
  });
  const claude = createClaudeClient({
    config: llm.value,
    http,
    usage: supabaseUsageStore(service),
    log,
  });

  return ok({
    verify: supabaseVerifyDeps(service),
    claude,
    conversations: supabaseConversationStore(service),
    log,
  });
}
