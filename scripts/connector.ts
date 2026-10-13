/**
 * Connector key CLI (MCP connector, stage 1) — the command an operator runs.
 *
 *   npm run connector -- issue rossb@fundd.com.au --label "Grok"
 *   npm run connector -- list
 *   npm run connector -- revoke <key-id>
 *
 * Thin wire-up only: parsing, the words printed and every decision live in
 * src/lib/connector (tested, coverage-gated). Runs server-side with the service role key
 * from .env against whichever project .env names — this file is never bundled for a browser
 * and is not part of the connector's own function.
 *
 * The key is written to stdout once, deliberately bypassing the logger: it is a hand-over to
 * the person at the terminal, not a log line. Nothing else prints it, stores it or sees it.
 */
import { loadSupabaseAuthConfig } from '../src/lib/auth/clients.js';
import {
  CONNECTOR_CLI_USAGE,
  formatIssueRefusal,
  formatIssued,
  formatList,
  formatRevoke,
  parseConnectorCommand,
} from '../src/lib/connector/cli.js';
import { loadConnectorConfig } from '../src/lib/connector/config.js';
import {
  createKeyAdminClient,
  issueKey,
  listKeys,
  revokeKey,
  supabaseKeyAdminStore,
} from '../src/lib/connector/keyAdmin.js';
import type { Result } from '../src/lib/errors.js';

function fail(message: string): never {
  process.stderr.write(`connector: ${message}\n`);
  process.exit(1);
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    return fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

try {
  // Populates process.env from .env without overriding already-set values (Node 24).
  process.loadEnvFile();
} catch {
  // No .env — fine if the variables are already exported.
}

const command = unwrap(parseConnectorCommand(process.argv.slice(2)));

if (command.kind === 'help') {
  process.stdout.write(CONNECTOR_CLI_USAGE);
  process.exit(0);
}

const store = supabaseKeyAdminStore(createKeyAdminClient(unwrap(loadSupabaseAuthConfig())));

switch (command.kind) {
  case 'issue': {
    // Read before the key is made, so a misconfigured address cannot follow a key that
    // has already been shown.
    const config = unwrap(loadConnectorConfig(process.env));
    const result = unwrap(await issueKey(store, { email: command.email, label: command.label }));
    if (result.kind !== 'issued') fail(formatIssueRefusal(result));
    process.stdout.write(formatIssued(result, config.publicUrl));
    break;
  }
  case 'list': {
    process.stdout.write(formatList(unwrap(await listKeys(store, { email: command.email }))));
    break;
  }
  case 'revoke': {
    const shown = formatRevoke(unwrap(await revokeKey(store, { keyId: command.keyId })));
    if (!shown.ok) fail(shown.text);
    process.stdout.write(shown.text);
    break;
  }
}
