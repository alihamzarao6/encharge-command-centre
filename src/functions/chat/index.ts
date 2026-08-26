/**
 * POST /functions/v1/chat — the deployed chat endpoint (Stage 2 part 4; deployed in part 6).
 *
 * Thin Deno adapter over src/lib/llm/chat.ts: parse the request, hand the bearer token and
 * body to the library, write its answer back. Every decision — who may call, the spend
 * cap, retries, history, what gets recorded — lives in the tested library, not here.
 *
 * Two answer shapes, chosen by the caller:
 *   - JSON (default): `handleChatTurn` → one status + body. The fallback the browser uses
 *     when a proxy or a flaky connection breaks the stream, and what the CLI uses.
 *   - Server-sent events, when the request says `Accept: text/event-stream`:
 *     `handleChatTurnStream` → `start`, `delta`…, then exactly one of `done` / `error`,
 *     each as `event: <type>\ndata: <json>`. The HTTP status is 200 as soon as the caller
 *     is verified (the headers must go before the first token), so an error after that
 *     travels as the `error` event, carrying the same status/body the JSON path would have
 *     answered with. Refusals decided BEFORE anything streams (401/403/400/402/404) still
 *     answer with their real HTTP status so the browser's plain-JSON handling applies.
 *
 * SOURCE, not the deployed file. `npm run functions:bundle` (scripts/bundle-functions.ts)
 * resolves the library's NodeNext `./x.js` specifiers with esbuild and writes the
 * self-contained result to supabase/functions/chat/index.ts, which is gitignored and is what
 * `supabase start` / `supabase functions deploy` bundle. The npm packages (supabase-js, zod)
 * stay external and are mapped to `npm:` specifiers by supabase/functions/chat/deno.json.
 *
 * Secrets (the Anthropic key, the service role key, the caps and model ids) are read
 * from the function's environment, set with `supabase secrets set` and re-read on every
 * invocation — a model or cap change needs no redeploy. Nothing here is ever served to a
 * browser as source: the client bundle (part 6) calls this URL and holds only the anon key.
 *
 * CORS: the browser app is served from a different origin (Vercel), so the function
 * answers the preflight and echoes exactly one allowed origin, CHAT_ALLOWED_ORIGIN.
 * Unset means no browser origin is allowed — the CLI runner still works, a page does not.
 */
/* eslint-disable -- Deno runtime file; type-checked by the Supabase CLI, not by the repo's tsc. */
// @ts-nocheck -- Deno globals (Deno.env, Deno.serve) are not in the Node tsconfig; see header.
import { handleChatTurn, handleChatTurnStream, type ChatStreamEvent } from '../../lib/llm/chat.js';
import { createChatDeps } from '../../lib/llm/wiring.js';
import { logger } from '../../lib/logger.js';
import { formatSseEvent } from '../../lib/sse.js';

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

function wantsStream(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/event-stream');
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only.' } });
  }

  // Stage 3: memory summarisation runs after the reply is sent. EdgeRuntime.waitUntil keeps
  // the isolate alive for it; without it (local `supabase functions serve` on an older
  // runtime) the promise still runs, just without the lifetime guarantee.
  const waitUntil =
    typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function'
      ? (work: Promise<void>): void => {
          EdgeRuntime.waitUntil(work);
        }
      : undefined;
  const deps = createChatDeps(Deno.env.toObject(), logger, waitUntil);
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
  const input = { token, message: body.message, conversationId: body.conversationId };

  if (!wantsStream(request)) {
    const result = await handleChatTurn(deps.value, input);
    return json(result.status, result.body);
  }

  // Streaming. The first event decides the HTTP status: a refusal before `start` is a
  // plain JSON answer with its real status; from `start` onwards it is a 200 event stream.
  const encoder = new TextEncoder();
  let first: ChatStreamEvent | null = null;
  let firstResolved: (event: ChatStreamEvent) => void = () => undefined;
  const firstEvent = new Promise<ChatStreamEvent>((resolve) => {
    firstResolved = resolve;
  });
  const queue: ChatStreamEvent[] = [];
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let finished = false;

  const push = (event: ChatStreamEvent): void => {
    if (controllerRef === null) {
      queue.push(event);
      return;
    }
    controllerRef.enqueue(encoder.encode(formatSseEvent(event.type, event)));
    if (event.type === 'done' || event.type === 'error') {
      finished = true;
      controllerRef.close();
    }
  };

  const run = handleChatTurnStream(deps.value, input, (event) => {
    if (first === null) {
      first = event;
      firstResolved(event);
      return;
    }
    push(event);
  }).catch((error: unknown) => {
    logger.error('chat stream handler threw', { error });
  });

  const opening = await firstEvent;
  if (opening.type === 'error') {
    await run;
    return json(opening.status, opening.body);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // A comment line flushes the headers through buffering proxies before the first token.
      controller.enqueue(encoder.encode(': open\n\n'));
      push(opening);
      for (const event of queue.splice(0)) push(event);
    },
    cancel() {
      finished = true;
    },
  });

  // Keep the handler alive until the turn is recorded, even if the client goes away.
  void run.then(() => {
    if (!finished && controllerRef !== null) {
      finished = true;
      controllerRef.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      ...CORS_HEADERS,
    },
  });
});
