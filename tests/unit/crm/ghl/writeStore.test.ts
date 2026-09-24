/**
 * supabase-js adapter for the write path (src/lib/crm/ghl/writeStore.ts) against a stubbed
 * global fetch serving PostgREST-shaped responses: the two mirror reads, the three RPCs with
 * their arguments, the replay row from `begin_ghl_write`, the 55006 → CONFLICT mapping for a
 * second finish, an unknown status refused, and a transport failure typed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGhlWriteServiceClient,
  supabaseWriteStore,
} from '../../../../src/lib/crm/ghl/writeStore.js';
import { FINANCE_PIPELINE_ID } from './helpers.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };
const WRITE_ID = 'e0000000-0000-4000-8000-0000000000aa';
const REQUEST = 'd3b07384-d9a0-4f7b-8a5c-000000000001';
const ACTOR = 'aaaaaaaa-0000-4000-8000-000000000001';

interface Seen {
  method: string;
  path: string;
  query: string;
  body: string;
}

const seen: Seen[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stub(handler: (req: Seen) => Response | undefined): void {
  vi.stubGlobal(
    'fetch',
    (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const req: Seen = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        body: typeof init?.body === 'string' ? init.body : '',
      };
      seen.push(req);
      const response = handler(req);
      if (response === undefined) throw new Error(`unstubbed: ${req.method} ${req.path}`);
      return Promise.resolve(response);
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

function store(): ReturnType<typeof supabaseWriteStore> {
  return supabaseWriteStore(createGhlWriteServiceClient(CONFIG));
}

describe('the mirror reads', () => {
  it('liveStageIds selects the pipeline’s live stages and answers ids', async () => {
    stub((req) =>
      req.path === '/rest/v1/ghl_stages' ? json([{ ghl_id: 'a' }, { ghl_id: 'b' }]) : undefined,
    );
    const ids = await store().liveStageIds(FINANCE_PIPELINE_ID);
    expect(ids).toEqual({ ok: true, value: ['a', 'b'] });
    const q = seen[0]?.query ?? '';
    expect(q).toContain(`pipeline_ghl_id=eq.${FINANCE_PIPELINE_ID}`);
    expect(q).toContain('removed_at=is.null');
  });

  it('mirrorOpportunity answers the row, or null when the mirror has never seen it', async () => {
    stub((req) =>
      req.path === '/rest/v1/ghl_opportunities'
        ? json(
            req.query.includes('ghl_id=eq.known')
              ? [
                  {
                    ghl_id: 'known',
                    pipeline_ghl_id: FINANCE_PIPELINE_ID,
                    stage_ghl_id: 's1',
                    contact_ghl_id: 'c1',
                    removed_at: null,
                  },
                ]
              : [],
          )
        : undefined,
    );
    expect(await store().mirrorOpportunity('known')).toEqual({
      ok: true,
      value: { pipelineId: FINANCE_PIPELINE_ID, stageId: 's1', contactId: 'c1', removedAt: null },
    });
    expect(await store().mirrorOpportunity('unknown')).toEqual({ ok: true, value: null });
  });

  it('a PostgREST error and a transport failure are typed, never thrown', async () => {
    stub(() => json({ code: '42501', message: 'permission denied' }, 403));
    const denied = await store().liveStageIds(FINANCE_PIPELINE_ID);
    expect(!denied.ok && denied.error.code).toBe('HTTP_STATUS');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const down = await store().mirrorOpportunity('x');
    expect(!down.ok && down.error.code).toBe('NETWORK');
  });
});

describe('beginWrite', () => {
  it('calls begin_ghl_write with every argument and answers a new claim', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/begin_ghl_write'
        ? json([
            {
              id: WRITE_ID,
              existing: false,
              status: 'in_flight',
              from_stage_ghl_id: null,
              to_stage_ghl_id: 's2',
              error_code: null,
            },
          ])
        : undefined,
    );
    const begun = await store().beginWrite({
      requestId: REQUEST,
      actor: ACTOR,
      kind: 'stage_move',
      pipelineId: FINANCE_PIPELINE_ID,
      opportunityId: 'o1',
      contactId: 'c1',
      screenStageId: 's1',
      toStageId: 's2',
    });
    expect(begun).toEqual({
      ok: true,
      value: {
        id: WRITE_ID,
        existing: false,
        status: 'in_flight',
        fromStageId: null,
        toStageId: 's2',
        errorCode: null,
      },
    });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_request_id: REQUEST,
      p_actor: ACTOR,
      p_kind: 'stage_move',
      p_pipeline_ghl_id: FINANCE_PIPELINE_ID,
      p_opportunity_ghl_id: 'o1',
      p_contact_ghl_id: 'c1',
      p_screen_stage_ghl_id: 's1',
      p_to_stage_ghl_id: 's2',
    });
  });

  it('a replay comes back as the existing row; an unknown status and an empty answer are refused', async () => {
    stub(() =>
      json([
        {
          id: WRITE_ID,
          existing: true,
          status: 'success',
          from_stage_ghl_id: 's1',
          to_stage_ghl_id: 's2',
          error_code: null,
        },
      ]),
    );
    const replay = await store().beginWrite({
      requestId: REQUEST,
      actor: ACTOR,
      kind: 'stage_move',
      pipelineId: FINANCE_PIPELINE_ID,
      opportunityId: 'o1',
      contactId: null,
      screenStageId: null,
      toStageId: 's2',
    });
    expect(replay).toMatchObject({
      ok: true,
      value: { existing: true, status: 'success', fromStageId: 's1' },
    });

    stub(() => json([{ id: WRITE_ID, existing: false, status: 'weird' }]));
    const weird = await store().beginWrite({
      requestId: REQUEST,
      actor: ACTOR,
      kind: 'note',
      pipelineId: FINANCE_PIPELINE_ID,
      opportunityId: 'o1',
      contactId: null,
      screenStageId: null,
      toStageId: null,
    });
    expect(!weird.ok && weird.error.code).toBe('INTERNAL');

    stub(() => json([]));
    const empty = await store().beginWrite({
      requestId: REQUEST,
      actor: ACTOR,
      kind: 'note',
      pipelineId: FINANCE_PIPELINE_ID,
      opportunityId: 'o1',
      contactId: null,
      screenStageId: null,
      toStageId: null,
    });
    expect(!empty.ok && empty.error.code).toBe('INTERNAL');
  });
});

describe('finishWrite and markOpportunityRemoved', () => {
  it('calls finish_ghl_write with the row and the note exactly as given', async () => {
    stub((req) => (req.path === '/rest/v1/rpc/finish_ghl_write' ? json(null) : undefined));
    const row = {
      ghl_id: 'o1',
      stage_ghl_id: 's2',
      contact_ghl_id: 'c1',
      name: 'x',
      status: 'open' as const,
      monetary_value: 0,
      source: null,
      assigned_to: null,
      ghl_created_at: null,
      ghl_updated_at: null,
      last_stage_change_at: null,
      last_status_change_at: null,
      content_hash: 'h',
    };
    const done = await store().finishWrite({
      id: WRITE_ID,
      status: 'success',
      ghlStatus: 200,
      errorCode: null,
      durationMs: 812,
      fromStageId: 's1',
      opportunity: row,
      note: null,
    });
    expect(done).toEqual({ ok: true, value: undefined });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_id: WRITE_ID,
      p_status: 'success',
      p_ghl_status: 200,
      p_error_code: null,
      p_duration_ms: 812,
      p_from_stage_ghl_id: 's1',
      p_opportunity: row,
      p_note: null,
    });
  });

  it('55006 (already finished) is CONFLICT, a definite answer', async () => {
    stub(() => json({ code: '55006', message: 'ghl write already finished (success)' }, 400));
    const twice = await store().finishWrite({
      id: WRITE_ID,
      status: 'failed',
      ghlStatus: null,
      errorCode: 'X',
      durationMs: 1,
      fromStageId: null,
      opportunity: null,
      note: null,
    });
    expect(!twice.ok && twice.error.code).toBe('CONFLICT');
  });

  it('markOpportunityRemoved answers the function’s boolean', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/mark_ghl_opportunity_removed' ? json(true) : undefined,
    );
    expect(await store().markOpportunityRemoved('o1')).toEqual({ ok: true, value: true });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ p_ghl_id: 'o1' });
  });
});
