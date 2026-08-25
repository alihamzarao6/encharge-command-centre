/**
 * A scripted Supabase for the browser tests. Intercepts every request the built app makes —
 * GoTrue (sign-in, session, sign-out), PostgREST (app_users, conversations, messages) and
 * the chat Edge Function — and answers from an in-memory script. Nothing leaves the
 * machine; the app cannot tell the difference because the URLs and shapes are the real ones.
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

export interface MockOptions {
  /** 'active' → app_users row readable; 'deactivated' → zero rows (RLS); 'banned' → GoTrue refuses. */
  account?: 'active' | 'deactivated' | 'banned' | 'wrong-password';
  conversations?: { id: string; title: string | null; last_active_at: string }[];
  messages?: Record<string, ScriptedMessage[]>;
  chat?: ChatScript;
}

export interface MockState {
  readonly chatCalls: { message: string; conversationId?: string; authorization: string | null }[];
  readonly anthropicCalls: number;
  signOuts: number;
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
  const conversations = options.conversations ?? [];
  const messages = options.messages ?? {};
  const state: MockState = { chatCalls: [], anthropicCalls: 0, signOuts: 0 };
  let chatCall = 0;

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
    if (path === '/rest/v1/app_users') {
      const rows =
        account === 'active'
          ? [{ user_id: USER_ID, email: EMAIL, role: 'staff', is_active: true, is_admin: false }]
          : [];
      await json(route, 200, rows);
      return;
    }
    if (path === '/rest/v1/conversations') {
      await json(
        route,
        200,
        conversations.map((c) => ({ ...c, scope: 'workspace', user_id: USER_ID })),
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
