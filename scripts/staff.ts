/**
 * Staff admin CLI (Stage 2 part 3) — the command an admin actually runs.
 *
 *   npm run staff -- add-user someone@fundd.com.au
 *
 * Thin wire-up only: parsing, wiring and every decision live in src/lib/auth (tested,
 * coverage-gated). Runs server-side with the service role key from .env — this file is
 * never bundled for a browser. Executed via tsx because Node's native type-stripping
 * cannot resolve this repo's NodeNext `.js` import specifiers.
 *
 * The generated password is written to stdout once, deliberately bypassing the logger:
 * it is a hand-over to the human admin, not a log line. Nothing else prints it, stores
 * it, or sees it (tests/security/auth.test.ts proves that against a real stack).
 */
import {
  attachSeededCredentials,
  createStaffUser,
  deactivateStaffUser,
  resetStaffPassword,
} from '../src/lib/auth/admin.js';
import type { CreatedStaffUser } from '../src/lib/auth/admin.js';
import { STAFF_CLI_USAGE, formatOneTimePassword, parseStaffCommand } from '../src/lib/auth/cli.js';
import {
  createAdminDeps,
  loadSupabaseAuthConfig,
  signInWithPassword,
} from '../src/lib/auth/clients.js';
import type { Result } from '../src/lib/errors.js';
import { logger } from '../src/lib/logger.js';

function fail(message: string): never {
  process.stderr.write(`staff: ${message}\n`);
  process.exit(1);
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    return fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function showPassword(created: CreatedStaffUser): void {
  process.stdout.write(formatOneTimePassword(created.email, created.generatedPassword));
}

async function adminToken(): Promise<string> {
  const email = process.env['STAFF_ADMIN_EMAIL'];
  const password = process.env['STAFF_ADMIN_PASSWORD'];
  if (email === undefined || email === '' || password === undefined || password === '') {
    return fail(
      'set STAFF_ADMIN_EMAIL and STAFF_ADMIN_PASSWORD in the environment (see `npm run staff -- help`)',
    );
  }
  const config = unwrap(loadSupabaseAuthConfig());
  const session = unwrap(await signInWithPassword(config, email, password));
  return session.accessToken;
}

try {
  // Populates process.env from .env without overriding already-set values (Node 24).
  process.loadEnvFile();
} catch {
  // No .env — fine if the variables are already exported.
}

const command = unwrap(parseStaffCommand(process.argv.slice(2)));

if (command.kind === 'help') {
  process.stdout.write(STAFF_CLI_USAGE);
  process.exit(0);
}

const deps = createAdminDeps(unwrap(loadSupabaseAuthConfig()), logger);

switch (command.kind) {
  case 'add-user': {
    const created = unwrap(await createStaffUser(deps, await adminToken(), command.email));
    process.stdout.write(`created staff user ${created.userId}\n`);
    showPassword(created);
    break;
  }
  case 'deactivate': {
    const result = unwrap(await deactivateStaffUser(deps, await adminToken(), command.email));
    process.stdout.write(
      result.alreadyInactive
        ? `already inactive: ${result.userId} (no change)\n`
        : `deactivated ${result.userId} — allowlist row and memory rows retained, auth account banned\n`,
    );
    break;
  }
  case 'reset-password': {
    const reset = unwrap(await resetStaffPassword(deps, await adminToken(), command.email));
    process.stdout.write(`password reset for ${reset.userId}\n`);
    showPassword(reset);
    break;
  }
  case 'bootstrap': {
    const attached = unwrap(await attachSeededCredentials(deps, command.who));
    process.stdout.write(`credentials attached to seeded account ${attached.userId}\n`);
    showPassword(attached);
    break;
  }
}
