/** 
 * POST /functions/v1/chat — the deployed chat endpoint (Stage 2 part 4; deployed in part 6).
 *
 * Thin Deno adapter over src/lib/llm/chat.ts: parse the request, hand the bearer token and
 * body to handleChatTurn, write its status and body back. Every decision — who may call,
 * the spend cap, retries, what gets recorded — lives in the tested library, not here.
 *
 * Secrets (ANTHROPIC_API_KEY, SUPABASE_SERVICE_ROLE_KEY, the caps and model ids) are read
 * from the function's environment, set with `supabase secrets set` and re-read on every
 * invocation — a model or cap change needs no redeploy. Nothing here is ever served to a
 * browser as source: the client bundle (part 6) calls this URL and holds only the anon key.
 *
 * Import resolution: the library is written for Node's NodeNext resolution (`./x.js`
 * specifiers for `.ts` files). This adapter is validated with `supabase functions serve`
 * at part-6 deploy time (needs Docker), where the bundling strategy is settled — either
 * Deno's sloppy-imports flag in supabase/functions/chat/deno.json or an esbuild step that
 * writes a self-contained bundle next to this file. Not verifiable on a machine without
 * Docker, and stated as such in the part-4 report.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { handleChatTurn } from '../../../src/lib/llm/chat.js';
import { createChatDeps } from '../../../src/lib/llm/wiring.js';
import { logger } from '../../../src/lib/logger.js';

const CORS_HEADERS = {
  'access-control-allow-origin': Deno.env.get('CHAT_ALLOWED_ORIGIN') ?? '',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only.' } });
  }

  const deps = createChatDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('chat function misconfigured', { error: deps.error });
    return json(500, { error: { code: 'CONFIG', message: 'The chat service is misconfigured.' } });
  }

  let body: { message?: unknown; conversationId?: unknown } = {};
  try {
    body = (await request.json()) as { message?: unknown; conversationId?: unknown };
  } catch {
    return json(400, { error: { code: 'BAD_REQUEST', message: 'Body must be JSON.' } });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : null;

  const result = await handleChatTurn(deps.value, {
    token,
    message: body.message,
    conversationId: body.conversationId,
  });
  return json(result.status, result.body);
});
