/**
 * POST /functions/v1/crm — the overview's refresh endpoint (Milestone 4 part 2).
 *
 * Thin Deno adapter over src/lib/crm/ghl/page.ts, exactly as the admin function is over
 * src/lib/auth/page.ts: parse the request, hand the bearer token and body to the tested
 * library, write its answer back. The decision of who may call, and everything the sync
 * does, lives in the library, which the CLI also uses — so the browser and
 * `npm run crm -- sync` cannot drift apart.
 *
 * There is no GET. The mirror tables are a PostgREST select under RLS as the signed-in
 * person; this endpoint exists only because refreshing them means reading GoHighLevel, and
 * the GoHighLevel token is read by one server-side module and never leaves it.
 *
 * SOURCE, not the deployed file. `npm run functions:bundle` writes the self-contained result
 * to supabase/functions/crm/index.ts, which is gitignored and is what `supabase start` /
 * `supabase functions deploy crm` bundle.
 *
 * CORS: the browser app is served from Vercel, a different origin, so the function answers
 * the preflight and echoes exactly one allowed origin — CHAT_ALLOWED_ORIGIN, the same
 * variable the chat, memory and admin functions use. Unset means no browser origin is
 * allowed.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { handleCrmRequest, type CrmRequestBody } from '../../lib/crm/ghl/page.js';
import { createCrmPageDeps } from '../../lib/crm/ghl/wiring.js';
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

  const deps = createCrmPageDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('crm function misconfigured', { error: deps.error });
    return json(500, {
      error: { code: 'CONFIG', message: 'The refresh is misconfigured.', retryable: false },
    });
  }

  let body: CrmRequestBody = {};
  try {
    body = (await request.json()) as CrmRequestBody;
  } catch {
    return json(400, {
      error: { code: 'BAD_REQUEST', message: 'Body must be JSON.', retryable: false },
    });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : null;

  const result = await handleCrmRequest(deps.value, { token, body });
  return json(result.status, result.body);
});
