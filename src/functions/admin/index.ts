/**
 * POST /functions/v1/admin — the Users page's write endpoint (Stage 3 part 4, FND-330).
 *
 * Thin Deno adapter over src/lib/auth/page.ts, exactly as the memory function is over
 * src/lib/memory/page.ts and the chat function over src/lib/llm/chat.ts: parse the request,
 * hand the bearer token and body to the tested library, write its answer back. Every
 * decision — who may call, who may be changed, what may leave the workspace without an
 * administrator, what lands in audit_log — lives in the library, which the CLI also uses, so
 * the browser and `npm run staff` cannot drift apart.
 *
 * There is no GET. The roster is a PostgREST select under RLS as the signed-in user
 * (migration 20260828010000 widened that policy from self-row-only to the whole roster);
 * this endpoint exists only because `authenticated` holds SELECT and nothing else, so
 * creating, deactivating, promoting or resetting has to come through a verified server path
 * holding the service role.
 *
 * SOURCE, not the deployed file. `npm run functions:bundle` writes the self-contained result
 * to supabase/functions/admin/index.ts, which is gitignored and is what `supabase start` /
 * `supabase functions deploy admin` bundle.
 *
 * THE ONE-TIME PASSWORD leaves the process exactly once, in the body of the response to the
 * create or reset that generated it, over TLS to the admin who asked. It is not logged here
 * (this file logs nothing but a config failure), not stored, and not recoverable.
 *
 * CORS: the browser app is served from Vercel, a different origin, so the function answers
 * the preflight and echoes exactly one allowed origin — CHAT_ALLOWED_ORIGIN, the same
 * variable the chat and memory functions use, because it names the one app all three serve.
 * Unset means no browser origin is allowed.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { handleUsersRequest, type UsersRequestBody } from '../../lib/auth/page.js';
import { createUsersPageDeps } from '../../lib/llm/wiring.js';
import { logger } from '../../lib/logger.js';

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
    headers: {
      'content-type': 'application/json',
      // A one-time password must not sit in a proxy or a phone's back/forward cache.
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
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

  const deps = createUsersPageDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('admin function misconfigured', { error: deps.error });
    return json(500, {
      error: { code: 'CONFIG', message: 'User management is misconfigured.', retryable: false },
    });
  }

  let body: UsersRequestBody = {};
  try {
    body = (await request.json()) as UsersRequestBody;
  } catch {
    return json(400, {
      error: { code: 'BAD_REQUEST', message: 'Body must be JSON.', retryable: false },
    });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : null;

  const result = await handleUsersRequest(deps.value, { token, body });
  return json(result.status, result.body);
});
