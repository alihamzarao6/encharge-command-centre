/**
 * Adapter tests for src/lib/auth/clients.ts against a stubbed global fetch serving
 * recorded GoTrue / PostgREST response shapes (TESTING.md: external APIs are never called
 * in unit tests). This is where the task-2.3.3 "expired token" and "tampered token" cases
 * are exercised through the real supabase-js parsing path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AUTH_TIMEOUT_MS,
  createAdminDeps,
  createServiceClient,
  fetchWithTimeout,
  loadSupabaseAuthConfig,
  signInWithPassword,
  supabaseAuditWriter,
  supabaseAuthAdminApi,
  supabaseStaffStore,
  supabaseVerifyDeps,
} from '../../../src/lib/auth/clients.js';
import type { SupabaseAuthConfig } from '../../../src/lib/auth/clients.js';
import { createLogger } from '../../../src/lib/logger.js';

const CONFIG: SupabaseAuthConfig = {
  url: 'http://stack.test',
  anonKey: 'anon-key',
  serviceRoleKey: 'service-key',
};

const USER_ID = '99999999-9999-4999-8999-999999999999';

const AUTH_USER = {
  id: USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'x@y.com',
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
};

const STAFF_ROW = {
  user_id: USER_ID,
  email: 'x@y.com',
  role: 'staff',
  is_active: true,
  is_admin: false,
};

type Handler = (url: URL, init: RequestInit) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const requests: { method: string; path: string; search: string; body: string }[] = [];

function stubFetch(handler: Handler): void {
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const request = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        search: url.search,
        body: typeof init?.body === 'string' ? init.body : '',
      };
      requests.push(request);
      const response = handler(url, init ?? {});
      if (response === undefined) {
        throw new Error(`unstubbed request: ${request.method} ${url.pathname}`);
      }
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  requests.length = 0;
});

describe('loadSupabaseAuthConfig', () => {
  it('names every missing variable', () => {
    const result = loadSupabaseAuthConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.context['missing']).toStrictEqual([
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]);
  });

  it('returns the config when complete', () => {
    const result = loadSupabaseAuthConfig({
      SUPABASE_URL: 'http://x',
      SUPABASE_ANON_KEY: 'a',
      SUPABASE_SERVICE_ROLE_KEY: 's',
    });
    expect(result).toStrictEqual({
      ok: true,
      value: { url: 'http://x', anonKey: 'a', serviceRoleKey: 's' },
    });
  });
});

describe('fetchWithTimeout', () => {
  it('passes the response through inside the deadline', async () => {
    stubFetch(() => json({ fine: true }));
    const response = await fetchWithTimeout(DEFAULT_AUTH_TIMEOUT_MS)('http://stack.test/ping', {});
    expect(await response.json()).toStrictEqual({ fine: true });
  });

  it('aborts a hung request at the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'),
            );
          });
        }),
    );
    await expect(fetchWithTimeout(20)('http://stack.test/hang', {})).rejects.toThrow();
  });
});

describe('supabaseVerifyDeps.getUserFromToken', () => {
  it('resolves a valid token to its user', async () => {
    stubFetch((url) => (url.pathname === '/auth/v1/user' ? json(AUTH_USER) : undefined));
    const deps = supabaseVerifyDeps(createServiceClient(CONFIG));
    const result = await deps.getUserFromToken('valid-jwt');
    expect(result).toStrictEqual({ ok: true, value: { id: USER_ID, email: 'x@y.com' } });
  });

  it('an EXPIRED token is an auth decision (ok(null)), not an infrastructure error', async () => {
    stubFetch(() =>
      json({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT: token is expired' }, 401),
    );
    const deps = supabaseVerifyDeps(createServiceClient(CONFIG));
    expect(await deps.getUserFromToken('expired-jwt')).toStrictEqual({ ok: true, value: null });
  });

  it('a TAMPERED token is an auth decision (ok(null))', async () => {
    stubFetch(() =>
      json(
        {
          code: 403,
          error_code: 'bad_jwt',
          msg: 'invalid JWT: unable to parse or verify signature',
        },
        403,
      ),
    );
    const deps = supabaseVerifyDeps(createServiceClient(CONFIG));
    expect(await deps.getUserFromToken('tampered-jwt')).toStrictEqual({ ok: true, value: null });
  });

  it('an auth-server failure is the error channel', async () => {
    stubFetch(() => json({ msg: 'internal error' }, 500));
    const deps = supabaseVerifyDeps(createServiceClient(CONFIG));
    const result = await deps.getUserFromToken('any');
    expect(result.ok).toBe(false);
  });
});

describe('supabaseStaffStore', () => {
  it('getByEmail: zero rows is null, one row is the row', async () => {
    let rows: unknown[] = [];
    stubFetch((url) => (url.pathname === '/rest/v1/app_users' ? json(rows) : undefined));
    const store = supabaseStaffStore(createServiceClient(CONFIG));

    expect(await store.getByEmail('x@y.com')).toStrictEqual({ ok: true, value: null });
    rows = [STAFF_ROW];
    expect(await store.getByEmail('x@y.com')).toStrictEqual({ ok: true, value: STAFF_ROW });
  });

  it('two matching rows is an INTERNAL error, never a silent first-row pick', async () => {
    stubFetch(() => json([STAFF_ROW, { ...STAFF_ROW, user_id: 'other' }]));
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    const result = await store.getById(USER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('INTERNAL');
  });

  it('insert maps a unique violation to CONFLICT', async () => {
    stubFetch(() => json({ code: '23505', message: 'duplicate key value' }, 409));
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    const result = await store.insert(STAFF_ROW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('CONFLICT');
  });

  it('insert succeeds on 2xx', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    expect((await store.insert(STAFF_ROW)).ok).toBe(true);
    expect(requests.find((r) => r.method === 'POST')?.body).toContain(USER_ID);
  });

  it('list reads the roster ordered by email', async () => {
    stubFetch((url) => (url.pathname === '/rest/v1/app_users' ? json([STAFF_ROW]) : undefined));
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    const result = await store.list();
    expect(result).toStrictEqual({ ok: true, value: [STAFF_ROW] });
    expect(requests[0]?.search).toContain('order=email');
  });

  // Stage 3 part 4: both flag writes go through their database function, not a PATCH — the
  // last-admin invariant needs an advisory lock and a PATCH cannot take one.
  it('setActive and setAdmin call their function and return changed + the admin count', async () => {
    stubFetch((url) =>
      url.pathname.startsWith('/rest/v1/rpc/set_staff_')
        ? json([{ changed: true, active_admins: 2 }])
        : undefined,
    );
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    expect(await store.setActive(USER_ID, false)).toStrictEqual({
      ok: true,
      value: { changed: true, activeAdmins: 2 },
    });
    expect(await store.setAdmin(USER_ID, true)).toStrictEqual({
      ok: true,
      value: { changed: true, activeAdmins: 2 },
    });
    expect(requests.map((r) => r.path)).toStrictEqual([
      '/rest/v1/rpc/set_staff_active',
      '/rest/v1/rpc/set_staff_admin',
    ]);
    expect(requests[0]?.body).toContain('"p_active":false');
    expect(requests[1]?.body).toContain('"p_is_admin":true');
  });

  it("maps the function's 23514 to a FORBIDDEN the interface can show as written", async () => {
    stubFetch(() =>
      json(
        { code: '23514', message: 'the workspace must keep at least one active administrator' },
        400,
      ),
    );
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    const result = await store.setAdmin(USER_ID, false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('FORBIDDEN');
    expect(result.error.context['reason']).toBe('last_admin');
    expect(result.error.message).toContain('at least one administrator');
  });

  it('maps the other 23514 — promoting someone who cannot sign in — to its own reason', async () => {
    stubFetch(() => json({ code: '23514', message: 'cannot promote a deactivated member' }, 400));
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    const result = await store.setAdmin(USER_ID, true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.context['reason']).toBe('inactive_target');
  });

  it('a function that returns no row is INTERNAL, never a silent success', async () => {
    stubFetch(() => json([]));
    const store = supabaseStaffStore(createServiceClient(CONFIG));
    const result = await store.setActive(USER_ID, true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('INTERNAL');
  });
});

describe('supabaseAuthAdminApi', () => {
  it('createUser returns the new identity', async () => {
    stubFetch((url, init) =>
      url.pathname === '/auth/v1/admin/users' && init.method === 'POST'
        ? json(AUTH_USER)
        : undefined,
    );
    const api = supabaseAuthAdminApi(createServiceClient(CONFIG));
    const result = await api.createUser('x@y.com', 'pw234567abcdefgh');
    expect(result).toStrictEqual({ ok: true, value: { id: USER_ID, email: 'x@y.com' } });
    const post = requests.find((r) => r.method === 'POST');
    expect(post?.body).toContain('"email_confirm":true');
  });

  it('createUser maps email_exists to CONFLICT', async () => {
    stubFetch(() =>
      json(
        {
          code: 422,
          error_code: 'email_exists',
          msg: 'A user with this email address has already been registered',
        },
        422,
      ),
    );
    const api = supabaseAuthAdminApi(createServiceClient(CONFIG));
    const result = await api.createUser('x@y.com', 'pw234567abcdefgh');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('CONFLICT');
  });

  it('setPassword and setBanned PUT to the admin user endpoint', async () => {
    stubFetch((url) =>
      url.pathname === `/auth/v1/admin/users/${USER_ID}` ? json(AUTH_USER) : undefined,
    );
    const api = supabaseAuthAdminApi(createServiceClient(CONFIG));
    expect((await api.setPassword(USER_ID, 'pw234567abcdefgh')).ok).toBe(true);
    expect((await api.setBanned(USER_ID, true)).ok).toBe(true);
    expect((await api.setBanned(USER_ID, false)).ok).toBe(true);
    const bodies = requests.filter((r) => r.method === 'PUT').map((r) => r.body);
    expect(bodies[1]).toContain('"ban_duration":"87600h"');
    expect(bodies[2]).toContain('"ban_duration":"none"');
  });
});

describe('supabaseAuditWriter', () => {
  it('writes the audit row', async () => {
    stubFetch((url) =>
      url.pathname === '/rest/v1/audit_log' ? new Response('', { status: 201 }) : undefined,
    );
    const audit = supabaseAuditWriter(createServiceClient(CONFIG));
    const result = await audit.write({
      actor: 'admin@x.com',
      action: 'USER_CREATED',
      entityType: 'app_users',
      entityId: USER_ID,
    });
    expect(result.ok).toBe(true);
    expect(requests[0]?.body).toContain('"action":"USER_CREATED"');
    expect(requests[0]?.body).toContain('"entity_type":"app_users"');
  });
});

describe('signInWithPassword', () => {
  it('returns the access token and user id on success', async () => {
    stubFetch((url) =>
      url.pathname === '/auth/v1/token'
        ? json({
            access_token: 'access-token-value',
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: 'refresh-token-value',
            user: AUTH_USER,
          })
        : undefined,
    );
    const result = await signInWithPassword(CONFIG, 'x@y.com', 'pw234567abcdefgh');
    expect(result).toStrictEqual({
      ok: true,
      value: { accessToken: 'access-token-value', userId: USER_ID },
    });
  });

  it('maps refused credentials to UNAUTHENTICATED', async () => {
    stubFetch(() =>
      json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400),
    );
    const result = await signInWithPassword(CONFIG, 'x@y.com', 'wrong');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('createAdminDeps', () => {
  it('wires every dependency against the service client', () => {
    const deps = createAdminDeps(CONFIG, createLogger({ level: 'silent' }));
    expect(typeof deps.verify.getUserFromToken).toBe('function');
    expect(typeof deps.authAdmin.createUser).toBe('function');
    expect(typeof deps.staff.insert).toBe('function');
    expect(typeof deps.audit.write).toBe('function');
  });
});
