/**
 * Which browser origins may call the Edge Functions (src/lib/cors.ts): a list in one variable,
 * one origin per response, and nothing for a caller that is not on it.
 */
import { describe, expect, it } from 'vitest';

import {
  allowedOriginFor,
  parseAllowedOrigins,
  parseOrigin,
  primaryOrigin,
  withAllowedOrigin,
} from '../../src/lib/cors.js';

const PRIMARY = 'https://command.enchargecapital.com.au';
const TESTING = 'https://fundd-command-centre.vercel.app';
const CLIENT_VERCEL = 'https://ross-command-center-eta.vercel.app';
const LIST = `${PRIMARY}/, ${TESTING}/,${CLIENT_VERCEL}`;

describe('parseOrigin', () => {
  it.each([
    ['https://command.enchargecapital.com.au/', PRIMARY],
    ['https://command.enchargecapital.com.au', PRIMARY],
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173'],
  ])('%s → %s', (raw, origin) => {
    expect(parseOrigin(raw)).toBe(origin);
  });

  it.each([
    ['http on a real host', 'http://command.enchargecapital.com.au'],
    ['a path', 'https://fundd.example/app'],
    ['a query', 'https://fundd.example/?a=1'],
    ['a fragment', 'https://fundd.example/#x'],
    ['a login', 'https://user:pw@fundd.example'],
    ['not a URL', 'fundd.example'],
    ['another scheme', 'ftp://fundd.example'],
  ])('refuses %s', (_name, raw) => {
    expect(parseOrigin(raw)).toBeNull();
  });

  it('null stays null', () => {
    expect(parseOrigin(null)).toBeNull();
  });
});

describe('parseAllowedOrigins', () => {
  it('reads a comma-separated list in order, trailing slashes and spaces tolerated', () => {
    expect(parseAllowedOrigins(LIST)).toEqual([PRIMARY, TESTING, CLIENT_VERCEL]);
  });

  it('one entry — the format before the list — still works', () => {
    expect(parseAllowedOrigins(TESTING)).toEqual([TESTING]);
  });

  it('drops an entry that is not an origin instead of trusting it, and duplicates', () => {
    expect(parseAllowedOrigins(`*, ${PRIMARY}, ,https://x.example/path, ${PRIMARY}/`)).toEqual([
      PRIMARY,
    ]);
  });

  it('unset or empty allows nobody', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('')).toEqual([]);
  });
});

describe('primaryOrigin', () => {
  it('is the first entry', () => {
    expect(primaryOrigin(LIST)).toBe(PRIMARY);
    expect(primaryOrigin(TESTING)).toBe(TESTING);
  });

  it('is null when the first entry is not an origin, rather than silently using the second', () => {
    expect(primaryOrigin(`fundd.example, ${PRIMARY}`)).toBeNull();
    expect(primaryOrigin('')).toBeNull();
    expect(primaryOrigin(null)).toBeNull();
  });
});

describe('allowedOriginFor', () => {
  const allowed = parseAllowedOrigins(LIST);

  it('echoes the caller when it is on the list', () => {
    for (const origin of [PRIMARY, TESTING, CLIENT_VERCEL]) {
      expect(allowedOriginFor(origin, allowed)).toBe(origin);
    }
  });

  it('nothing for anyone else, for a lookalike, or for no Origin at all', () => {
    expect(allowedOriginFor('https://evil.example', allowed)).toBeNull();
    expect(allowedOriginFor(`${PRIMARY}.evil.example`, allowed)).toBeNull();
    expect(allowedOriginFor('http://command.enchargecapital.com.au', allowed)).toBeNull();
    expect(allowedOriginFor(null, allowed)).toBeNull();
  });
});

describe('withAllowedOrigin', () => {
  const request = (origin?: string): Request =>
    new Request('https://x.supabase.co/functions/v1/chat', {
      method: 'POST',
      headers: origin === undefined ? {} : { origin },
    });
  const inner = (response: Response) => (): Promise<Response> => Promise.resolve(response);

  it('sets the caller’s origin on an allowed request and keeps status, body and headers', async () => {
    const wrapped = withAllowedOrigin(
      () => LIST,
      inner(
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json', vary: 'origin' },
        }),
      ),
    );
    const response = await wrapped(request(TESTING));
    expect(response.status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe(TESTING);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('vary')).toBe('origin');
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('removes any origin header the handler set when the caller is not allowed', async () => {
    const wrapped = withAllowedOrigin(
      () => LIST,
      inner(new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } })),
    );
    const response = await wrapped(request('https://evil.example'));
    expect(response.status).toBe(204);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('adds Vary: origin so a cache never serves one domain’s answer to another', async () => {
    const wrapped = withAllowedOrigin(
      () => LIST,
      inner(new Response('x', { headers: { vary: 'accept' } })),
    );
    expect((await wrapped(request(PRIMARY))).headers.get('vary')).toBe('accept, origin');
  });

  it('passes a stream through untouched', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\n\n'));
        controller.close();
      },
    });
    const wrapped = withAllowedOrigin(
      () => LIST,
      inner(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
    );
    const response = await wrapped(request(PRIMARY));
    expect(await response.text()).toBe('event: a\n\n');
  });

  it('keeps a redirect’s status and location', async () => {
    const wrapped = withAllowedOrigin(
      () => LIST,
      inner(new Response(null, { status: 303, headers: { location: `${PRIMARY}/settings` } })),
    );
    const response = await wrapped(request());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${PRIMARY}/settings`);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('reads the list on every request, so a changed secret applies at once', async () => {
    let raw: string | undefined = TESTING;
    const wrapped = withAllowedOrigin(
      () => raw,
      () => Promise.resolve(new Response('x')),
    );
    const before = await wrapped(request(PRIMARY));
    expect(before.headers.has('access-control-allow-origin')).toBe(false);
    raw = LIST;
    const after = await wrapped(request(PRIMARY));
    expect(after.headers.get('access-control-allow-origin')).toBe(PRIMARY);
  });
});
