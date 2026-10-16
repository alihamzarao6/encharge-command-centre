/**
 * POST /functions/v1/files — attaching a file to a conversation (Milestone 5 part 1).
 *
 * Thin Deno adapter over src/lib/files/page.ts: parse the request, hand the bearer token and
 * body to the library, write its answer back. Every decision — who may attach, what is
 * refused, what a page costs, what is stored and for how long — lives in the tested library.
 *
 * What arrives here is never a file. The browser reads the file itself (D84) and sends TEXT,
 * page by page; for a photo or a scanned page it sends one JPEG of that page, which is passed
 * to the model, turned into text, and dropped. Nothing in this function writes bytes anywhere,
 * and nothing it logs contains a file's name or a word of its content.
 *
 * Milestone 5 part 2 adds the one action whose reply is not JSON: `fetch_page` returns the
 * bytes of a web page the person pointed at, for the browser to read with the same readers.
 * They are sent as an opaque download (`application/octet-stream`, `nosniff`) so no browser
 * ever renders them, with what was measured about them in the `x-page-meta` header. The
 * fetch itself runs here and nowhere else: the browser never contacts the site.
 *
 * SOURCE, not the deployed file: `npm run functions:bundle` writes the self-contained module
 * to supabase/functions/files/index.ts (gitignored), exactly as for chat, memory, admin, crm.
 * Same CORS rule as the others: one allowed origin, CHAT_ALLOWED_ORIGIN.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { encodePageMeta, PAGE_META_HEADER } from '../../lib/files/meta.js';
import { handleFilesRequest } from '../../lib/files/page.js';
import { createFilesPageDeps } from '../../lib/files/wiring.js';
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
    // A reply here can describe somebody's document (its size, its page count): never cached.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
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

  // Milestone 5 part 5: a new attachment is learned after the answer is sent. EdgeRuntime.waitUntil
  // keeps the isolate alive for it; without it the promise still runs, just without the guarantee
  // (the schedule picks up anything left).
  const waitUntil =
    typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function'
      ? (work: Promise<void>): void => {
          EdgeRuntime.waitUntil(work);
        }
      : undefined;
  // `Deno` is the DNS resolver the page guard checks every name with.
  const deps = createFilesPageDeps(Deno.env.toObject(), logger, { dns: Deno, waitUntil });
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('files function misconfigured', { error: deps.error });
    return json(500, {
      error: { code: 'CONFIG', message: 'The file service is misconfigured.', retryable: false },
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

  const result = await handleFilesRequest(deps.value, { token, body });
  if ('bytes' in result) {
    return new Response(result.bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment',
        'cache-control': 'no-store',
        [PAGE_META_HEADER]: encodePageMeta(result.body),
        'access-control-expose-headers': PAGE_META_HEADER,
        ...CORS_HEADERS,
      },
    });
  }
  return json(result.status, result.body);
});
