/**
 * POST /functions/v1/settings — the settings page's endpoint (Milestone 5 part 4).
 *
 * Thin Deno adapter over src/lib/settings/page.ts, exactly as the admin function is over the
 * users page: parse the request, hand the bearer token and body to the tested library, write its
 * answer back. Every decision — who may call, who may forget what, what is logged — lives in the
 * library.
 *
 * SOURCE, not the deployed file. `npm run functions:bundle` writes the self-contained result to
 * supabase/functions/settings/index.ts, which is gitignored and is what `supabase functions
 * deploy settings` bundles.
 *
 * A CONNECTOR KEY leaves the process exactly once, in the body of the response to the
 * `create_key` that minted it, over TLS to the person it is for. `cache-control: no-store` on
 * every response, so it cannot sit in a proxy or a phone's back/forward cache. Nothing here logs
 * a body.
 *
 * CORS: the browser app is served from Vercel, a different origin, so the function answers the
 * preflight and echoes exactly one allowed origin — CHAT_ALLOWED_ORIGIN, the variable every
 * function of this app uses. Unset means no browser origin is allowed.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { handleSettingsRequest } from '../../lib/settings/page.js';
import { createSettingsPageDeps } from '../../lib/settings/wiring.js';
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

  const deps = createSettingsPageDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('settings function misconfigured', { error: deps.error });
    return json(500, {
      error: { code: 'CONFIG', message: 'Settings are misconfigured.', retryable: false },
    });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return json(400, {
      error: { code: 'BAD_REQUEST', message: 'Body must be JSON.', retryable: false },
    });
  }

  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice('bearer '.length).trim()
    : null;

  const result = await handleSettingsRequest(deps.value, { token, body });
  return json(result.status, result.body);
});
