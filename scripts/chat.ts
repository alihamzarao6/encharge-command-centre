/**
 * Chat runner (Stage 2 part 4) — sends ONE real message through the production path from
 * a terminal, so the end-to-end turn can be exercised before part 6 ships an interface.
 *
 *   npm run chat -- "What can you help with?"
 *   npm run chat -- --conversation <uuid> "And a follow-up"
 *
 * Credentials come from the environment only (never argv — shell history):
 *   CHAT_EMAIL / CHAT_PASSWORD   the staff account to sign in as (falls back to
 *                                STAFF_ADMIN_EMAIL / STAFF_ADMIN_PASSWORD)
 *   SUPABASE_*, ANTHROPIC_*      the same server-side variables the Edge Function uses.
 *
 * To trip the cap deliberately:  ANTHROPIC_DAILY_SPEND_CAP_USD=0 npm run chat -- "hi"
 *
 * Thin wire-up only: every decision lives in src/lib/llm (tested, coverage-gated). The
 * response is printed as JSON to stdout — it contains no secret; the API key is used by
 * client.ts for one header and is never part of any result.
 */
import { signInWithPassword, loadSupabaseAuthConfig } from '../src/lib/auth/clients.js';
import { handleChatTurn } from '../src/lib/llm/chat.js';
import { createChatDeps } from '../src/lib/llm/wiring.js';
import { logger } from '../src/lib/logger.js';

function fail(message: string): never {
  process.stderr.write(`chat: ${message}\n`);
  process.exit(1);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function parseArgs(argv: readonly string[]): { message: string; conversationId: string | null } {
  let conversationId: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--conversation') {
      const next = argv[i + 1];
      if (next === undefined) fail('--conversation needs a value');
      conversationId = next;
      i += 1;
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  const message = rest.join(' ').trim();
  if (message === '') {
    fail('usage: npm run chat -- [--conversation <uuid>] "<message>"');
  }
  return { message, conversationId };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — rely on the real environment.
  }

  const { message, conversationId } = parseArgs(process.argv.slice(2));

  const email = readEnv('CHAT_EMAIL') ?? readEnv('STAFF_ADMIN_EMAIL');
  const password = readEnv('CHAT_PASSWORD') ?? readEnv('STAFF_ADMIN_PASSWORD');
  if (email === undefined || password === undefined) {
    fail('set CHAT_EMAIL and CHAT_PASSWORD (or STAFF_ADMIN_EMAIL / STAFF_ADMIN_PASSWORD)');
  }

  const supabase = loadSupabaseAuthConfig();
  if (!supabase.ok) fail(`${supabase.error.code}: ${supabase.error.message}`);
  const session = await signInWithPassword(supabase.value, email, password);
  if (!session.ok) fail(`${session.error.code}: ${session.error.message}`);

  const deps = createChatDeps(process.env, logger);
  if (!deps.ok) fail(`${deps.error.code}: ${deps.error.message}`);

  const result = await handleChatTurn(deps.value, {
    token: session.value.accessToken,
    message,
    conversationId,
  });
  process.stdout.write(
    `${JSON.stringify({ status: result.status, body: result.body }, null, 2)}\n`,
  );
  process.exit(result.status === 200 ? 0 : 2);
}

main().catch((caught: unknown) => {
  fail(caught instanceof Error ? caught.message : String(caught));
});
