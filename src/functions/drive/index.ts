/**
 * /functions/v1/drive — Google Drive (Milestone 5 part 3a).
 *
 * Thin Deno adapter over src/lib/drive/page.ts. Two kinds of request arrive:
 *
 *   POST (JSON, with the person's session)  status · connect_start · connect_finish ·
 *        disconnect · read_file · picked. Same CORS rule as the other functions: one allowed
 *        origin, CHAT_ALLOWED_ORIGIN. `read_file` answers with the file's BYTES as an opaque
 *        download, with what was measured about them in `x-drive-meta` — the files
 *        function's `fetch_page` pattern.
 *   GET or POST …/callback  Google, coming back from its consent screen as a top-level
 *        navigation with no session. Answered with a redirect to the app and nothing else; the
 *        code is sealed and held, never exchanged here (D123). With `response_mode=form_post`
 *        the code arrives in the body, so it is in no URL and no request log.
 *
 * SOURCE, not the deployed file: `npm run functions:bundle` writes the self-contained module to
 * supabase/functions/drive/index.ts (gitignored). Deployed with --no-verify-jwt, like the
 * others: the callback carries no session, and every other action verifies its own.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { DRIVE_META_HEADER, encodeDriveMeta } from '../../lib/drive/meta.js';
import { handleDriveCallback, handleDriveRequest } from '../../lib/drive/page.js';
import { createDrivePageDeps } from '../../lib/drive/wiring.js';
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
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}

/** The callback's parameters, from the query (GET) or the form body (form_post). */
async function callbackParams(request: Request, url: URL): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  for (const [name, value] of url.searchParams) params[name] = value;
  if (request.method === 'POST') {
    try {
      const text = await request.text();
      if (text.length <= 16_384) {
        for (const [name, value] of new URLSearchParams(text)) params[name] = value;
      }
    } catch {
      // An unreadable body: the handler treats it as no state, and nothing changes.
    }
  }
  return params;
}

Deno.serve(async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const isCallback = url.pathname.endsWith('/callback');

  if (!isCallback && request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const deps = await createDrivePageDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('drive function misconfigured', { error: deps.error });
    return isCallback
      ? new Response('Google Drive is set up wrongly on this Command Centre.', { status: 500 })
      : json(500, {
          error: {
            code: 'CONFIG',
            message: 'The Drive service is misconfigured.',
            retryable: false,
          },
        });
  }

  if (isCallback) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response(null, { status: 405 });
    }
    const result = await handleDriveCallback(deps.value, await callbackParams(request, url));
    if (result.status === 404) return new Response('Not found.', { status: 404 });
    return new Response(null, {
      status: 303,
      headers: {
        location: result.location,
        'cache-control': 'no-store',
        // The callback's own address may hold a code (query mode): never sent onward.
        'referrer-policy': 'no-referrer',
      },
    });
  }

  if (request.method !== 'POST') {
    return json(405, {
      error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only.', retryable: false },
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

  const result = await handleDriveRequest(deps.value, { token, body });
  if ('bytes' in result) {
    return new Response(result.bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment',
        'cache-control': 'no-store',
        [DRIVE_META_HEADER]: encodeDriveMeta(result.body),
        'access-control-expose-headers': DRIVE_META_HEADER,
        ...CORS_HEADERS,
      },
    });
  }
  return json(result.status, result.body);
});
