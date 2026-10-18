/**
 * The settings page's backend, scripted (Milestone 5 part 4) — what the browser reads under RLS
 * for the page (`knowledge_sources` as a list, `connector_keys`, `audit_log`) and the `settings`
 * Edge Function. Installed by `installMock` (mock.ts) after its catch-all route, so it answers
 * first; a `knowledge_sources` lookup BY ID (the note under a reply) falls through to mock.ts.
 *
 * Faithful, from the browser's side, to src/lib/settings/page.ts and migration 20261017020000 on
 * what the interface depends on: forgetting takes every copy of the same bytes; a person who is
 * not an administrator may forget only what they added — every copy of it; the second press
 * answers "already"; a key is made for the signed-in person only, at most five switched on; it is
 * in one reply and in no list; a key that is not theirs is "not found". `connector_keys` returns
 * the signed-in person's own rows only, as its policy does.
 *
 * Every specs's default (no script): nothing learned, no keys, no activity, a calm spend — so a
 * suite that only visits /settings for something else (Drive) sees empty states, not errors.
 */
import type { Page, Route } from '@playwright/test';

import { E2E_SUPABASE_URL } from './playwright.config.js';

export interface ScriptedLearnedSource {
  id: string;
  name: string | null;
  kind: string;
  source_host: string | null;
  source_url: string | null;
  content_hash: string | null;
  uploaded_by: string | null;
  learned_at: string;
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  status: string;
  failure: string | null;
}

export interface ScriptedConnectorKey {
  id: string;
  key_id: string;
  user_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ScriptedAudit {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  opportunity?: string | null;
  from_stage?: string | null;
  to_stage?: string | null;
  connector?: string | null;
  file_kind?: string | null;
  file_source?: string | null;
}

export interface SettingsScript {
  sources?: ScriptedLearnedSource[];
  keys?: ScriptedConnectorKey[];
  activity?: ScriptedAudit[];
  /** The spend reply's numbers; default a calm day. */
  spend?: { todayUsd: number; monthUsd: number; capDailyUsd?: number; capMonthlyUsd?: number };
  /** Every read for the page and every settings call answer 503 until a test flips it. */
  unavailable?: boolean;
  /** How long a forget takes, so a test can act while one is in flight. */
  forgetDelayMs?: number;
  /**
   * How many conversations the server says still hold an answer from the document just
   * forgotten (null: it could not count them). Default 0.
   */
  answersHeldIn?: number | null;
}

export interface SettingsMockState {
  sources: ScriptedLearnedSource[];
  keys: ScriptedConnectorKey[];
  activity: ScriptedAudit[];
  /** Every POST to /functions/v1/settings, in order — the action and its body. */
  calls: Record<string, unknown>[];
  /** Every key this backend made, so a test can prove where it is NOT. */
  minted: string[];
  unavailable: boolean;
}

const KEY_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function pick(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'a';
  }
  return out;
}

function json(
  route: Route,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function failure(route: Route, status: number, code: string, message: string): Promise<void> {
  return json(route, status, { error: { code, message, retryable: status >= 500 } });
}

/** PostgREST's paging: `offset` and `limit` in the query, the total in content-range. */
function page(route: Route, url: URL, rows: readonly unknown[]): Promise<void> {
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? String(rows.length));
  const slice = rows.slice(offset, offset + limit);
  const range =
    slice.length === 0
      ? `*/${String(rows.length)}`
      : `${String(offset)}-${String(offset + slice.length - 1)}/${String(rows.length)}`;
  return json(route, 200, slice, { 'content-range': range });
}

function inList(url: URL, column: string): string[] | null {
  const raw = url.searchParams.get(column);
  if (!raw?.startsWith('in.(')) return null;
  return raw
    .slice(4, -1)
    .split(',')
    .map((value) => value.replace(/^"|"$/g, ''));
}

export function createSettingsState(script: SettingsScript = {}): SettingsMockState {
  return {
    // Copies: forgetting and switching off change rows, and a spec's fixtures are shared.
    sources: (script.sources ?? []).map((row) => ({ ...row })),
    keys: (script.keys ?? []).map((row) => ({ ...row })),
    activity: (script.activity ?? []).map((row) => ({ ...row })),
    calls: [],
    minted: [],
    unavailable: script.unavailable === true,
  };
}

export async function routeSettings(
  page_: Page,
  state: SettingsMockState,
  me: { readonly userId: string; readonly isAdmin: boolean },
  script: SettingsScript = {},
): Promise<void> {
  const base = E2E_SUPABASE_URL;

  await page_.route(`${base}/rest/v1/knowledge_sources*`, async (route) => {
    // A preflight, or a write PostgREST must refuse: mock.ts answers both, and records the write.
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    // The note under a reply asks by id: mock.ts answers that.
    if (url.searchParams.has('id')) {
      await route.fallback();
      return;
    }
    if (state.unavailable) {
      await json(route, 503, { code: 'PGRST002', message: 'scripted outage' });
      return;
    }
    let rows = state.sources.filter((s) => s.status !== 'forgotten');
    const hashes = inList(url, 'content_hash');
    const urls = inList(url, 'source_url');
    if (hashes !== null)
      rows = rows.filter((s) => s.content_hash !== null && hashes.includes(s.content_hash));
    if (urls !== null)
      rows = rows.filter((s) => s.source_url !== null && urls.includes(s.source_url));
    rows = [...rows].sort(
      (a, b) => b.learned_at.localeCompare(a.learned_at) || b.id.localeCompare(a.id),
    );
    await page(route, url, rows);
  });

  await page_.route(`${base}/rest/v1/connector_keys*`, async (route) => {
    // A preflight, or a write PostgREST must refuse: mock.ts answers both, and records the write.
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (state.unavailable) {
      await json(route, 503, { code: 'PGRST002', message: 'scripted outage' });
      return;
    }
    // The policy: your own rows, nobody else's.
    const own = state.keys
      .filter((k) => k.user_id === me.userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    await page(route, url, own);
  });

  await page_.route(`${base}/rest/v1/audit_log*`, async (route) => {
    // A preflight, or a write PostgREST must refuse: mock.ts answers both, and records the write.
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    if (state.unavailable) {
      await json(route, 503, { code: 'PGRST002', message: 'scripted outage' });
      return;
    }
    const actions = inList(url, 'action') ?? [];
    const rows = state.activity
      .filter((row) => actions.includes(row.action))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((row) => ({
        opportunity: null,
        from_stage: null,
        to_stage: null,
        connector: null,
        file_kind: null,
        file_source: null,
        ...row,
      }));
    await page(route, url, rows);
  });

  await page_.route(`${base}/functions/v1/settings`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fallback();
      return;
    }
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    state.calls.push(body);
    if (state.unavailable) {
      await failure(
        route,
        503,
        'UNAVAILABLE',
        "Couldn't reach the Command Centre's records just now. Try again in a moment.",
      );
      return;
    }
    switch (body['action']) {
      case 'spend': {
        const spend = script.spend ?? { todayUsd: 0.43, monthUsd: 12.35 };
        await json(route, 200, {
          action: 'spend',
          outcome: 'read',
          capDailyUsd: spend.capDailyUsd ?? 5,
          capMonthlyUsd: spend.capMonthlyUsd ?? 80,
          warnFraction: 0.8,
          todayUsd: spend.todayUsd,
          monthUsd: spend.monthUsd,
          dayStartedAt: '2026-10-17T00:00:00.000Z',
          monthStartedAt: '2026-10-01T00:00:00.000Z',
          asOf: new Date().toISOString(),
        });
        return;
      }
      case 'forget_document': {
        if (script.forgetDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, script.forgetDelayMs));
        }
        const target = state.sources.find((s) => s.id === body['sourceId']);
        if (target === undefined) {
          await failure(
            route,
            404,
            'NOT_FOUND',
            'That document is no longer in the list. Refresh to see what is learned now.',
          );
          return;
        }
        if (target.status === 'forgotten') {
          await json(route, 200, {
            action: 'forget_document',
            outcome: 'already',
            sourceId: target.id,
            sources: 0,
            files: 0,
            chunks: 0,
            conversationsWithAnswers: null,
          });
          return;
        }
        const copies = state.sources.filter(
          (s) =>
            s.status !== 'forgotten' &&
            (s.id === target.id ||
              (target.content_hash !== null && s.content_hash === target.content_hash)),
        );
        if (!me.isAdmin && copies.some((s) => s.uploaded_by !== me.userId)) {
          await failure(
            route,
            403,
            'NOT_YOURS',
            'Only an administrator can forget this one: someone else added it, or a copy of it.',
          );
          return;
        }
        let chunks = 0;
        for (const copy of copies) {
          chunks += copy.chunk_count;
          copy.status = 'forgotten';
          copy.name = null;
          copy.content_hash = null;
        }
        state.activity.push({
          id: `act-${String(state.activity.length + 1)}`,
          actor: me.userId,
          action: 'KNOWLEDGE_FORGOTTEN',
          entity_type: 'knowledge_sources',
          entity_id: target.id,
          created_at: new Date().toISOString(),
        });
        await json(route, 200, {
          action: 'forget_document',
          outcome: 'forgotten',
          sourceId: target.id,
          sources: copies.length,
          files: copies.length,
          chunks,
          conversationsWithAnswers: script.answersHeldIn === undefined ? 0 : script.answersHeldIn,
        });
        return;
      }
      case 'create_key': {
        const label = typeof body['label'] === 'string' ? body['label'].trim() : '';
        if (label === '') {
          await failure(
            route,
            400,
            'BAD_LABEL',
            'Give the key a name, so you can tell it apart later.',
          );
          return;
        }
        const live = state.keys.filter((k) => k.user_id === me.userId && k.revoked_at === null);
        if (live.length >= 5) {
          await failure(
            route,
            409,
            'TOO_MANY_KEYS',
            'You already have 5 keys switched on. Switch one off first.',
          );
          return;
        }
        const keyId = pick(KEY_ID_ALPHABET, 12);
        const key = `fcc_${keyId}_${pick(SECRET_ALPHABET, 43)}`;
        const createdAt = new Date().toISOString();
        state.minted.push(key);
        state.keys.push({
          id: `key-${keyId}`,
          key_id: keyId,
          user_id: me.userId,
          label,
          created_at: createdAt,
          last_used_at: null,
          revoked_at: null,
        });
        await json(route, 200, {
          action: 'create_key',
          outcome: 'created',
          keyId,
          label,
          createdAt,
          key,
        });
        return;
      }
      case 'revoke_key': {
        const target = state.keys.find(
          (k) => k.key_id === body['keyId'] && k.user_id === me.userId,
        );
        if (target === undefined) {
          await failure(
            route,
            404,
            'NOT_FOUND',
            'That key is not one of yours, or it no longer exists. Refresh to see your keys.',
          );
          return;
        }
        const already = target.revoked_at !== null;
        target.revoked_at ??= new Date().toISOString();
        await json(route, 200, {
          action: 'revoke_key',
          outcome: already ? 'already' : 'revoked',
          keyId: target.key_id,
          revokedAt: target.revoked_at,
        });
        return;
      }
      default:
        await failure(route, 400, 'BAD_REQUEST', 'That request was not understood.');
    }
  });
}
