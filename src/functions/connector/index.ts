/**
 * POST /functions/v1/connector — the Command Centre as a connector the client's own AI can
 * reach (MCP connector, stage 1). Served to the outside at the public path `/mcp` by the
 * rewrite in vercel.json.
 *
 * Thin Deno adapter over src/lib/connector/handler.ts, exactly as the crm function is over
 * src/lib/crm/ghl/page.ts: hand the request to the tested library, write its answer back.
 * Every decision — who may call, what a tool returns, what is logged — lives in the library.
 *
 * WHAT IS HANDED OVER, and what is not. The library is told whether the address carried a
 * query string; it is never given the address, so it cannot log one. It is given the headers
 * and a body reader that stops at the size limit.
 *
 * NO CORS, on purpose. Nothing here answers a preflight or names an allowed origin: this
 * endpoint is for a server calling a server. A browser page cannot use it, which is one
 * fewer way for a key to end up in one.
 *
 * verify_jwt is off (supabase/config.toml): the bearer token on these requests is a
 * connector key, not a Supabase session, and the library checks it.
 *
 * SOURCE, not the deployed file. `npm run functions:bundle` writes the self-contained result
 * to supabase/functions/connector/index.ts, which is gitignored and is what `supabase start`
 * / `supabase functions deploy connector` bundle.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { readBodyCapped } from '../../lib/connector/body.js';
import { handleConnectorRequest } from '../../lib/connector/handler.js';
import { APP_CODE } from '../../lib/connector/protocol.js';
import { createConnectorDeps } from '../../lib/connector/wiring.js';
import { logger } from '../../lib/logger.js';

Deno.serve(async (request: Request): Promise<Response> => {
  const deps = createConnectorDeps(Deno.env.toObject(), logger);
  if (!deps.ok) {
    // Config errors name the missing VARIABLE, never a value.
    logger.error('connector function misconfigured', { error: deps.error });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: APP_CODE.unavailable,
          message: 'The Command Centre cannot answer just now.',
          data: { reason: 'unavailable' },
        },
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'retry-after': '60',
        },
      },
    );
  }

  let hasQuery = true;
  try {
    hasQuery = new URL(request.url).search !== '';
  } catch {
    // An address that cannot be parsed is treated as one that carries something it should not.
  }

  const result = await handleConnectorRequest(deps.value, {
    method: request.method,
    hasQuery,
    headers: request.headers,
    readBody: (maxBytes) =>
      readBodyCapped(request.body, request.headers.get('content-length'), maxBytes),
  });
  return new Response(result.body, { status: result.status, headers: result.headers });
});
