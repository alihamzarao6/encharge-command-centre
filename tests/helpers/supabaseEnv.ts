/**
 * Environment resolution for the integration and security suites.
 *
 * These suites run against a real Supabase stack (local `supabase start`, or the CI
 * service started by the integration job) — never against the production project.
 * They need four values:
 *
 *   SUPABASE_URL              — API URL (local default http://127.0.0.1:54321)
 *   SUPABASE_ANON_KEY         — the public key an attacker would hold
 *   SUPABASE_SERVICE_ROLE_KEY — fixture setup only; local stack value, never production
 *   SUPABASE_DB_URL           — direct Postgres connection for catalog queries
 *
 * Get them from a running local stack with: npx supabase status -o env
 *
 * Behaviour when they are absent:
 *   - locally: the suites are SKIPPED (visible as skipped in the vitest output), because a
 *     machine without Docker cannot run the stack and a hard failure would block the unit
 *     suite for everyone.
 *   - in CI: the integration job sets REQUIRE_SUPABASE_TESTS=1, so a missing value is a
 *     loud failure, never a silent skip. A green CI therefore proves the suites ran.
 */

export interface SupabaseTestEnv {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly dbUrl: string;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

export function loadSupabaseTestEnv(): SupabaseTestEnv | null {
  try {
    // Node 24: populates process.env from .env without overriding already-set values.
    process.loadEnvFile();
  } catch {
    // No .env file — CI and fresh clones. Real env vars still apply.
  }

  const url = readEnv('SUPABASE_URL');
  const anonKey = readEnv('SUPABASE_ANON_KEY');
  const serviceRoleKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  const dbUrl = readEnv('SUPABASE_DB_URL');

  if (
    url === undefined ||
    anonKey === undefined ||
    serviceRoleKey === undefined ||
    dbUrl === undefined
  ) {
    if (process.env['REQUIRE_SUPABASE_TESTS'] === '1') {
      throw new Error(
        'REQUIRE_SUPABASE_TESTS=1 but SUPABASE_URL / SUPABASE_ANON_KEY / ' +
          'SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL are not all set. ' +
          'Start the stack (npx supabase start) and export `npx supabase status -o env`.',
      );
    }
    return null;
  }

  return { url, anonKey, serviceRoleKey, dbUrl };
}
