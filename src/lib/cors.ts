/**
 * Which browser origins may call the Edge Functions. `CHAT_ALLOWED_ORIGIN` is a comma-separated
 * list (one entry still works, so a function deployed before the secret changes keeps serving
 * the old single origin). A response names exactly ONE origin — the caller's, when it is on the
 * list — because the CORS header cannot carry a list; anything else gets no header and the
 * browser refuses it. Runtime-neutral (Request, Response, Headers), so Deno runs what Node tests.
 */

/** An origin as the browser sends it: https (http only for localhost), no path, query or login. */
export function parseOrigin(raw: string | null): string | null {
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

/** The list, in order. An entry that is not an origin is dropped rather than trusted. */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const origin = parseOrigin(part.trim() === '' ? null : part.trim());
    if (origin !== null && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * The first entry: where a flow that leaves the app (Google's consent screen) sends the person
 * back. Null when the first entry is not a valid origin — a misconfiguration to report, not skip.
 */
export function primaryOrigin(raw: string | null): string | null {
  if (raw === null) return null;
  const first = raw.split(',')[0]?.trim() ?? '';
  return parseOrigin(first === '' ? null : first);
}

/** The caller's origin when it is on the list, otherwise null. */
export function allowedOriginFor(
  requestOrigin: string | null,
  allowed: readonly string[],
): string | null {
  if (requestOrigin === null) return null;
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

type Handler = (request: Request) => Promise<Response>;

/**
 * Wrap a function's handler so every response — preflight, JSON, stream, redirect — carries the
 * caller's origin when it is allowed and no origin header when it is not. The list is read per
 * request, so a changed secret applies without a code change.
 */
export function withAllowedOrigin(
  readAllowed: () => string | undefined,
  handler: Handler,
): Handler {
  return async (request: Request): Promise<Response> => {
    const response = await handler(request);
    const origin = allowedOriginFor(
      request.headers.get('origin'),
      parseAllowedOrigins(readAllowed()),
    );
    const headers = new Headers(response.headers);
    if (origin === null) headers.delete('access-control-allow-origin');
    else headers.set('access-control-allow-origin', origin);
    const vary = headers.get('vary') ?? '';
    if (
      !vary
        .toLowerCase()
        .split(/\s*,\s*/)
        .includes('origin')
    ) {
      headers.set('vary', vary === '' ? 'origin' : `${vary}, origin`);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
