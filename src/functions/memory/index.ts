/**
 * POST /functions/v1/memory — the memory page's write endpoint (Stage 3 part 3, FND-320).
 *
 * Thin Deno adapter over src/lib/memory/page.ts, exactly as the chat function is over
 * src/lib/llm/chat.ts: parse the request, hand the bearer token and body to the tested
 * library, write its answer back. Every decision — who may call, who may remove, what the
 * extractor is allowed to store, what lands in audit_log — lives in the library.
 *
 * There is no GET. Reading memory is a PostgREST select under RLS as the signed-in user
 * (page.ts's header says why); this endpoint exists only because `authenticated` holds
 * SELECT and nothing else, so a change has to come through a verified server path.
 *
 * SOURCE, not the deployed file. `npm run functions:bundle` writes the self-contained
 * result to supabase/functions/memory/index.ts, which is gitignored and is what
 * `supabase start` / `supabase functions deploy memory` bundle.
 *
 * Secrets (the Anthropic key, the service role key, the caps) are read from the function's
 * environment on every invocation. Nothing here reaches a browser: the client bundle calls
 * this URL holding only the anon key and the user's own session.
 *
 * CORS: the browser app is served from Vercel, a different origin, so the function answers
 * the preflight and echoes exactly one allowed origin — CHAT_ALLOWED_ORIGIN, the same
 * variable the chat function uses, because it names the one app both functions serve.
 * Unset means no browser origin is allowed.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { createMemoryPageDeps } from '../../lib/llm/wiring.js';
import { logger } from '../../lib/logger.js';
import { handleMemoryRequest, type MemoryRequestBody } from '../../lib/memory/page.js';

const CORS_HEADERS = {
  'access-control-allow-origin': Deno.env.get('CHAT_ALLOWED_ORIGIN') ?? '',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, accept',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-max-age': '86400',
  vary: 'origin',
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
    return json(405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only.', retryable: false },
    });
  }

  const deps = createMemoryPageDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('memory function misconfigured', { error: deps.error });
    return json(500, {
      error: { code: 'CONFIG', message: 'The memory service is misconfigured.', retryable: false },
    });
  }

  let body: MemoryRequestBody = {};
  try {
    body = (await request.json()) as MemoryRequestBody;
  } catch {
    return json(400, {
      error: { code: 'BAD_REQUEST', message: 'Body must be JSON.', retryable: false },
    });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : null;

  const result = await handleMemoryRequest(deps.value, { token, body });
  return json(result.status, result.body);
});
