/**
 * Production wiring for reading files (Milestone 5 part 1): the one place the environment is
 * turned into the files endpoint's dependencies, and the chat path's view of attached files.
 * The environment is passed in, never read implicitly — Deno.env on the Edge Function,
 * process.env in a script, a literal in a test.
 *
 * The endpoint needs Claude (a page image is read by the model) and so needs the same caps
 * and the same ledger as the chat: the client built here is the same wrapper, pointed at the
 * same `api_usage`, so a page read counts against the same daily and monthly limit as a turn.
 * A model with no price is refused here, at wiring, exactly as it would be at the call.
 */
import {
  createServiceClient,
  loadSupabaseAuthConfig,
  supabaseVerifyDeps,
  type SupabaseAuthConfig,
} from '../auth/clients.js';
import { ok, type ConfigError, type Result } from '../errors.js';
import { createHttpClient } from '../http.js';
import { createClaudeClient } from '../llm/client.js';
import { loadLlmConfig } from '../llm/config.js';
import { pricingFor } from '../llm/pricing.js';
import { supabaseConversationStore, supabaseUsageStore } from '../llm/store.js';
import type { Logger } from '../logger.js';
import type { FilesConfig } from './config.js';
import { loadFilesConfig } from './config.js';
import { createTurnDocuments, type TurnDocuments } from './context.js';
import type { FilesPageDeps } from './page.js';
import { createFilesServiceClient, supabaseFileStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

export function createFilesPageDeps(env: Env, log: Logger): Result<FilesPageDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const llm = loadLlmConfig(env);
  if (!llm.ok) return llm;
  const config = loadFilesConfig(env);
  if (!config.ok) return config;

  const visionModel =
    config.value.visionRoute === 'fast' ? llm.value.models.fast : llm.value.models.default;
  const visionPricing = pricingFor(llm.value.pricing, visionModel);
  if (!visionPricing.ok) return visionPricing;

  const service = createServiceClient(supabase.value);
  const usage = supabaseUsageStore(service);
  const claude = createClaudeClient({
    config: llm.value,
    // client.ts owns the retry policy (only provably-unbilled failures); http.ts adds none.
    http: createHttpClient({ timeoutMs: llm.value.timeoutMs, retries: 0, logger: log }),
    usage,
    log,
  });

  return ok({
    verify: supabaseVerifyDeps(service),
    conversations: supabaseConversationStore(service),
    files: supabaseFileStore(createFilesServiceClient(supabase.value)),
    vision: {
      claude,
      route: config.value.visionRoute,
      maxTokens: config.value.visionMaxTokens,
      log,
    },
    usage,
    caps: llm.value.caps,
    visionPricing: visionPricing.value,
    config: config.value,
    log,
  });
}

/** The chat path's half: the attached files of a conversation, as the block a turn reads. */
export function createChatDocuments(
  supabase: SupabaseAuthConfig,
  config: FilesConfig,
): TurnDocuments {
  return createTurnDocuments(
    supabaseFileStore(createFilesServiceClient(supabase)),
    config.contextMaxChars,
  );
}
