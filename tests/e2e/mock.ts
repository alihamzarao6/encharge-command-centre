/**
 * A scripted Supabase for the browser tests. Intercepts every request the built app makes —
 * GoTrue (sign-in, session, sign-out), PostgREST (app_users, conversations, messages,
 * memory_facts, memory_chunks) and the three Edge Functions — and answers from an in-memory
 * script. Nothing leaves the machine; the app cannot tell the difference because the URLs and
 * shapes are the real ones.
 *
 * PostgREST is READ-ONLY here, as it is in production: any non-GET is recorded in
 * `postgrestWrites` and answered 403 / 42501, so a test can assert that the interface changes
 * memory only through the verified server path.
 */
import type { Page, Route } from '@playwright/test';

import { E2E_SUPABASE_URL } from './playwright.config.js';

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const EMAIL = 'ross.test@example.com';
export const PASSWORD = 'correct-horse';
export const CONV_ID = 'c0000000-0000-4000-8000-000000000001';

/** A structurally valid JWT (three base64url parts) whose payload says `authenticated`. */
export function fakeAccessToken(): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: USER_ID,
    email: EMAIL,
    role: 'authenticated',
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.e2e-signature-not-real`;
}

export interface ScriptedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ChatScript {
  /**
   * Called per POST /functions/v1/chat; returns status + body (a plain JSON answer), or
   * `{ sse: [...] }` — an event stream, as the deployed function writes it. The mock honours
   * the request's Accept header like the function does: an `sse` script answered to a
   * caller that did not ask for a stream is served as JSON of its final event.
   */
  respond: (
    request: { message: string; conversationId?: string },
    call: number,
  ) =>
    | { status: number; body: unknown }
    | { sse: { event: string; data: unknown }[]; truncate?: boolean };
}

export function sseDone(
  reply: string,
  call: number,
  conversationId = CONV_ID,
): { event: string; data: unknown }[] {
  const pieces = reply.match(/.{1,6}/gs) ?? [];
  return [
    { event: 'start', data: { type: 'start', conversationId } },
    ...pieces.map((text) => ({ event: 'delta', data: { type: 'delta', text } })),
    {
      event: 'done',
      data: {
        type: 'done',
        reply: {
          conversationId,
          userMessageId: `u-${String(call)}`,
          assistantMessageId: `a-${String(call)}`,
          reply,
          model: 'claude-sonnet-5',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.001,
        },
      },
    },
  ];
}

/** Stage 3 part 3: the two memory tables the page selects, and the rows it starts with. */
export interface ScriptedFact {
  id: string;
  user_id: string;
  scope: string;
  key: string;
  value: string | null;
  superseded_by: string | null;
  created_at: string;
}

export interface ScriptedChunk {
  id: string;
  conversation_id: string;
  user_id: string;
  scope: string;
  summary: string;
  audience: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** Stage 3 part 4: a colleague on the roster the users page lists. */
export interface ScriptedStaff {
  user_id: string;
  email: string;
  role: string;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

export interface MockOptions {
  /** 'active' → app_users row readable; 'deactivated' → zero rows (RLS); 'banned' → GoTrue refuses. */
  account?: 'active' | 'deactivated' | 'banned' | 'wrong-password';
  admin?: boolean;
  /** Everyone BESIDES the signed-in user. Their own row is always present when active. */
  roster?: ScriptedStaff[];
  /** Force one status/body from the admin endpoint instead of the faithful default. */
  adminFailure?: { status: number; body: unknown };
  conversations?: { id: string; title: string | null; last_active_at: string; user_id?: string }[];
  messages?: Record<string, ScriptedMessage[]>;
  chat?: ChatScript;
  facts?: ScriptedFact[];
  chunks?: ScriptedChunk[];
  /** Force one status/body from the memory endpoint instead of the faithful default. */
  memoryFailure?: { status: number; body: unknown };
}

export interface MockState {
  readonly chatCalls: { message: string; conversationId?: string; authorization: string | null }[];
  readonly anthropicCalls: number;
  signOuts: number;
  /** Every POST to /functions/v1/memory — the only sanctioned way memory changes. */
  readonly memoryCalls: { body: Record<string, unknown>; authorization: string | null }[];
  /** Every POST to /functions/v1/admin — the only sanctioned way an account changes. */
  readonly adminCalls: { body: Record<string, unknown>; authorization: string | null }[];
  /** Any non-GET/HEAD request to PostgREST. This must stay empty in every test. */
  readonly postgrestWrites: { method: string; path: string }[];
  readonly facts: ScriptedFact[];
  readonly chunks: ScriptedChunk[];
  readonly staff: ScriptedStaff[];
  readonly conversations: {
    id: string;
    title: string | null;
    last_active_at: string;
    user_id?: string;
    deleted_at?: string | null;
  }[];
  /** Every password the scripted admin endpoint has generated, so a test can look for leaks. */
  readonly issuedPasswords: string[];
}

function json(
  route: Route,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', ...extra },
    body: JSON.stringify(body),
  });
}

function sessionBody(): unknown {
  const token = fakeAccessToken();
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e-refresh',
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: EMAIL,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: '2026-08-01T00:00:00Z',
    },
  };
}

export async function installMock(page: Page, options: MockOptions = {}): Promise<MockState> {
  const account = options.account ?? 'active';
  const messages = options.messages ?? {};
  const me: ScriptedStaff = {
    user_id: USER_ID,
    email: EMAIL,
    role: 'staff',
    is_active: true,
    is_admin: options.admin === true,
    created_at: '2026-08-01T02:00:00Z',
  };
  const state: MockState = {
    chatCalls: [],
    anthropicCalls: 0,
    signOuts: 0,
    memoryCalls: [],
    adminCalls: [],
    postgrestWrites: [],
    facts: [...(options.facts ?? [])],
    chunks: [...(options.chunks ?? [])],
    staff: [me, ...(options.roster ?? [])],
    conversations: (options.conversations ?? []).map((c) => ({ deleted_at: null, ...c })),
    issuedPasswords: [],
  };
  let chatCall = 0;
  let newRow = 0;
  let newPerson = 0;

  // The assertion behind Part C item 2 and PHASE-ACCEPTANCE item 6: the browser never
  // talks to Anthropic. Any request there is counted and refused.
  await page.route('https://api.anthropic.com/**', async (route) => {
    (state as { anthropicCalls: number }).anthropicCalls += 1;
    await route.abort();
  });

  await page.route(`${E2E_SUPABASE_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        },
      });
      return;
    }

    // ---- GoTrue ----
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (account === 'wrong-password') {
        await json(route, 400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        });
        return;
      }
      if (account === 'banned') {
        await json(route, 403, { code: 403, error_code: 'user_banned', msg: 'User is banned' });
        return;
      }
      await json(route, 200, sessionBody());
      return;
    }
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      await json(route, 200, sessionBody());
      return;
    }
    if (path === '/auth/v1/user') {
      await json(route, 200, (sessionBody() as { user: unknown }).user);
      return;
    }
    if (path === '/auth/v1/logout') {
      state.signOuts += 1;
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return;
    }

    // ---- PostgREST (selects only; the browser has no write privilege) ----
    // Part C item 6: the page must never write through PostgREST. Anything but a read is
    // recorded and refused exactly as the privilege layer would refuse it (42501).
    if (path.startsWith('/rest/v1/') && method !== 'GET' && method !== 'HEAD') {
      state.postgrestWrites.push({ method, path });
      await json(route, 403, {
        code: '42501',
        message: `permission denied for table ${path.replace('/rest/v1/', '')}`,
      });
      return;
    }

    if (path === '/rest/v1/app_users') {
      // A deactivated account reads ZERO rows — including its own. That is RLS, and it is
      // what App.tsx's sign-in check depends on (migration 20260828010000 kept it true).
      // An active one reads the whole roster: that is the part-4 widening, and nothing more.
      const single = url.search.includes(`user_id=eq.${USER_ID}`);
      const rows = account !== 'active' ? [] : single ? [me] : state.staff;
      await json(route, 200, rows);
      return;
    }
    if (path === '/rest/v1/conversations') {
      await json(
        route,
        200,
        state.conversations
          .filter((c) => (c.deleted_at ?? null) === null)
          .map((c) => ({
            id: c.id,
            title: c.title,
            last_active_at: c.last_active_at,
            scope: 'workspace',
            user_id: c.user_id ?? USER_ID,
          })),
      );
      return;
    }
    if (path === '/rest/v1/messages') {
      const match = /conversation_id=eq\.([^&]+)/.exec(url.search);
      const id = match?.[1] ?? '';
      await json(
        route,
        200,
        (messages[id] ?? []).map((m) => ({ ...m, conversation_id: id })),
      );
      return;
    }

    if (path === '/rest/v1/memory_facts') {
      await json(route, 200, state.facts);
      return;
    }
    if (path === '/rest/v1/memory_chunks') {
      const live = url.search.includes('deleted_at=is.null');
      await json(
        route,
        200,
        live ? state.chunks.filter((c) => c.deleted_at === null) : state.chunks,
      );
      return;
    }

    // ---- the memory Edge Function (Stage 3 part 3) ----
    // Faithful to src/lib/memory/page.ts on the parts the interface depends on: append-only
    // with supersede, a self-reference for "forgotten", a tombstone for a deleted summary.
    if (path === '/functions/v1/memory' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.memoryCalls.push({
        body,
        authorization: request.headers()['authorization'] ?? null,
      });
      if (options.memoryFailure !== undefined) {
        await json(route, options.memoryFailure.status, options.memoryFailure.body);
        return;
      }
      const now = new Date().toISOString();
      const action = body['action'];
      if (action === 'add' || action === 'edit') {
        const existing =
          action === 'edit' ? state.facts.find((f) => f.id === body['factId']) : undefined;
        const key = existing?.key ?? 'writing:added-from-the-page';
        const value = String(action === 'edit' ? body['value'] : body['text']).trim();
        const live = state.facts.find((f) => f.key === key && f.superseded_by === null);
        newRow += 1;
        const id = `new-fact-${String(newRow)}`;
        // A live row is superseded; a forgotten row keeps its self-reference and the new
        // row simply becomes live again under the same key — that is "add it back".
        if (live !== undefined) live.superseded_by = id;
        state.facts.push({
          id,
          user_id: USER_ID,
          scope: 'workspace',
          key,
          value,
          superseded_by: null,
          created_at: now,
        });
        await json(route, 200, {
          action,
          outcome: 'saved',
          factId: id,
          key,
          value,
          replaced: live !== undefined,
        });
        return;
      }
      if (action === 'forget') {
        const row = state.facts.find((f) => f.id === body['factId']);
        if (row === undefined) {
          await json(route, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'That note is no longer there.',
              retryable: false,
            },
          });
          return;
        }
        row.superseded_by = row.id;
        await json(route, 200, { action: 'forget', outcome: 'forgotten', factId: row.id });
        return;
      }
      if (action === 'rename_conversation') {
        const row = state.conversations.find((c) => c.id === body['conversationId']);
        if (row === undefined) {
          await json(route, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'That conversation is no longer there.',
              retryable: false,
            },
          });
          return;
        }
        const title = String(body['title']).trim();
        const unchanged = row.title === title;
        row.title = title;
        await json(route, 200, {
          action,
          outcome: unchanged ? 'unchanged' : 'renamed',
          conversationId: row.id,
          title,
        });
        return;
      }
      if (action === 'delete_conversation') {
        const row = state.conversations.find((c) => c.id === body['conversationId']);
        const already = row === undefined || (row.deleted_at ?? null) !== null;
        // Faithful to the transaction: the conversation is soft-deleted, its conversation
        // notes are tombstoned, and standing notes are untouched.
        let tombstoned = 0;
        if (row !== undefined && !already) {
          row.deleted_at = now;
          for (const chunk of state.chunks) {
            if (chunk.conversation_id === row.id && chunk.deleted_at === null) {
              chunk.deleted_at = now;
              chunk.summary = '(removed from memory by a user)';
              chunk.audience = null;
              tombstoned += 1;
            }
          }
        }
        await json(route, 200, {
          action,
          outcome: already ? 'already' : 'deleted',
          conversationId: String(body['conversationId']),
          messagesDeleted: already ? 0 : 2,
          chunksTombstoned: tombstoned,
        });
        return;
      }
      if (action === 'delete_chunk') {
        const row = state.chunks.find((c) => c.id === body['chunkId']);
        if (row !== undefined) row.deleted_at = now;
        await json(route, 200, {
          action: 'delete_chunk',
          outcome: 'deleted',
          chunkId: String(body['chunkId']),
        });
        return;
      }
      await json(route, 400, {
        error: { code: 'BAD_REQUEST', message: 'unknown action', retryable: false },
      });
      return;
    }

    // ---- the admin Edge Function (Stage 3 part 4) ----
    // Faithful to src/lib/auth/page.ts on everything the interface depends on: admin-only,
    // a one-time password returned exactly once, idempotent flag writes, and the refusals
    // that keep the workspace from reaching zero administrators.
    if (path === '/functions/v1/admin' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.adminCalls.push({
        body,
        authorization: request.headers()['authorization'] ?? null,
      });
      if (options.adminFailure !== undefined) {
        await json(route, options.adminFailure.status, options.adminFailure.body);
        return;
      }
      const refuse = (status: number, code: string, message: string): Promise<void> =>
        json(route, status, { error: { code, message, retryable: false } });

      if (!me.is_admin) {
        await refuse(403, 'NOT_ADMIN', 'Only an administrator can add or change people.');
        return;
      }
      const action = body['action'];
      const activeAdmins = (): number =>
        state.staff.filter((u) => u.is_active && u.is_admin).length;

      if (action === 'sign_ins') {
        await json(route, 200, {
          action,
          signIns: state.staff.map((u) => ({
            userId: u.user_id,
            lastSignInAt: u.user_id === USER_ID ? '2026-08-27T01:00:00Z' : null,
          })),
        });
        return;
      }
      if (action === 'create') {
        const raw = body['email'];
        const email = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
        if (email === '') {
          await refuse(400, 'BAD_REQUEST', 'Enter their email address.');
          return;
        }
        if (state.staff.some((u) => u.email === email)) {
          await refuse(
            409,
            'ALREADY_EXISTS',
            'Someone with that email address is already on the list. Look for them below — they may just need their access restored.',
          );
          return;
        }
        newPerson += 1;
        const userId = `e2e00000-0000-4000-8000-00000000000${String(newPerson)}`;
        const password = `Zx7Kp2Qm9Rt4Vn6Ws8Yb3Hd${String(newPerson)}`.slice(0, 24);
        state.issuedPasswords.push(password);
        state.staff.push({
          user_id: userId,
          email,
          role: 'staff',
          is_active: true,
          is_admin: false,
          created_at: new Date().toISOString(),
        });
        await json(route, 200, { action, userId, email, oneTimePassword: password });
        return;
      }

      const target = state.staff.find((u) => u.user_id === body['userId']);
      if (target === undefined) {
        await refuse(400, 'BAD_REQUEST', 'userId must be a UUID.');
        return;
      }
      if (action === 'reset_password') {
        if (!target.is_active) {
          await refuse(
            403,
            'INACTIVE_TARGET',
            'This person no longer has access. Restore their access first.',
          );
          return;
        }
        const password = `Nq5Jw8Ct3Fy6Lm2Pd9Sb4Kg${String(state.issuedPasswords.length + 1)}`.slice(
          0,
          24,
        );
        state.issuedPasswords.push(password);
        await json(route, 200, {
          action,
          userId: target.user_id,
          email: target.email,
          oneTimePassword: password,
        });
        return;
      }
      if (
        action === 'deactivate' ||
        action === 'reactivate' ||
        action === 'promote' ||
        action === 'demote'
      ) {
        if (action === 'deactivate' && target.user_id === USER_ID) {
          await refuse(
            403,
            'SELF_DEACTIVATION',
            'You cannot remove your own access. Ask another administrator to do it for you.',
          );
          return;
        }
        if (action === 'demote' && target.user_id === USER_ID) {
          await refuse(
            403,
            'SELF_DEMOTION',
            'You cannot remove your own administrator rights. Ask another administrator to do it.',
          );
          return;
        }
        const removesAnAdmin =
          (action === 'deactivate' || action === 'demote') && target.is_admin && target.is_active;
        if (removesAnAdmin && activeAdmins() <= 1) {
          await refuse(
            403,
            'LAST_ADMIN',
            'The Command Centre must always have at least one administrator. Make someone else an administrator first.',
          );
          return;
        }
        if (action === 'promote' && !target.is_active) {
          await refuse(
            403,
            'INACTIVE_TARGET',
            'This person no longer has access. Restore their access first.',
          );
          return;
        }
        const before =
          action === 'promote' || action === 'demote' ? target.is_admin : target.is_active;
        const after = action === 'promote' || action === 'reactivate';
        if (action === 'promote' || action === 'demote') target.is_admin = after;
        else target.is_active = after;
        await json(route, 200, {
          action,
          outcome: before === after ? 'unchanged' : 'changed',
          userId: target.user_id,
          email: target.email,
          activeAdmins: activeAdmins(),
        });
        return;
      }
      await refuse(400, 'BAD_REQUEST', 'action must be one of create, deactivate, …');
      return;
    }

    // ---- the chat Edge Function ----
    if (path === '/functions/v1/chat' && method === 'POST') {
      const body = request.postDataJSON() as { message: string; conversationId?: string };
      state.chatCalls.push({ ...body, authorization: request.headers()['authorization'] ?? null });
      const script = options.chat ?? {
        respond: (input, call) => ({
          status: 200,
          body: {
            conversationId: input.conversationId ?? CONV_ID,
            userMessageId: `u-${String(call)}`,
            assistantMessageId: `a-${String(call)}`,
            reply: `Reply ${String(call)} to: ${input.message}`,
            model: 'claude-sonnet-5',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.001,
          },
        }),
      };
      chatCall += 1;
      const answer = script.respond(body, chatCall);
      const wantsStream = (request.headers()['accept'] ?? '').includes('text/event-stream');
      if ('sse' in answer) {
        if (!wantsStream) {
          const last = answer.sse.at(-1)?.data as
            { reply?: unknown; status?: number; body?: unknown } | undefined;
          if (last?.reply !== undefined) await json(route, 200, last.reply);
          else await json(route, last?.status ?? 500, last?.body ?? {});
          return;
        }
        const text = answer.sse
          .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
          .join('');
        const bytes =
          answer.truncate === true ? text.slice(0, Math.floor(text.length * 0.6)) : text;
        await route.fulfill({
          status: 200,
          headers: {
            'access-control-allow-origin': '*',
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          },
          body: `: open\n\n${bytes}`,
        });
        return;
      }
      await json(route, answer.status, answer.body);
      return;
    }

    await json(route, 404, { message: `unmocked ${method} ${path}` });
  });

  return state;
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A stored session, as supabase-js writes it — a refresh on a phone starts from here. */
export async function seedStoredSession(page: Page): Promise<void> {
  const session = sessionBody();
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: 'fundd-command-centre-auth', value: JSON.stringify(session) },
  );
}
