/**
 * Production wiring for the connector endpoint (MCP connector, stage 1). The Edge Function
 * calls this once per request; every setting is read here, at request time, from the
 * environment — never bundled.
 *
 * What is wired is all there is: a key check and one database function. There is no
 * GoHighLevel client here, no token and no write path — the connector reads the mirror the
 * app already keeps, through the database, as the key's user.
 */
import { loadSupabaseAuthConfig } from '../auth/clients.js';
import { ok, type ConfigError, type Result } from '../errors.js';
import type { Logger } from '../logger.js';
import { bearerKeyAuthenticator } from './auth.js';
import { loadConnectorConfig } from './config.js';
import type { ConnectorDeps } from './handler.js';
import { createConnectorServiceClient, supabaseConnectorStore } from './store.js';

type Env = Readonly<Record<string, string | undefined>>;

export function createConnectorDeps(env: Env, log: Logger): Result<ConnectorDeps, ConfigError> {
  const supabase = loadSupabaseAuthConfig(env);
  if (!supabase.ok) return supabase;
  const config = loadConnectorConfig(env);
  if (!config.ok) return config;
  return ok({
    config: config.value,
    authenticator: bearerKeyAuthenticator(),
    store: supabaseConnectorStore(
      createConnectorServiceClient(supabase.value, config.value.timeoutMs),
    ),
    log,
  });
}
