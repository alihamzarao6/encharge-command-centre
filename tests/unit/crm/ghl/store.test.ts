/**
 * supabase-js adapter (src/lib/crm/ghl/store.ts) against a stubbed global fetch serving
 * PostgREST-shaped responses: the three RPCs, the 55006 → CONFLICT mapping that makes a
 * second concurrent run a definite refusal, a transport failure, and the counts shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGhlServiceClient,
  listGhlSyncRuns,
  supabaseGhlSyncStore,
} from '../../../../src/lib/crm/ghl/store.js';
import type { Snapshot } from '../../../../src/lib/crm/ghl/map.js';
import { FINANCE_PIPELINE_ID, RUN_ID, ZERO_APPLY } from './helpers.js';

const CONFIG = { url: 'http://stack.test', anonKey: 'anon', serviceRoleKey: 'service' };

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

const SNAPSHOT: Snapshot = {
  pipeline: {
    ghl_id: FINANCE_PIPELINE_ID,
    name: 'Finance Pipeline',
    location_id: 'loc',
    ghl_updated_at: null,
  },
  stages: [],
  opportunities_complete: true,
  opportunities: [],
  contacts: [],
  custom_fields_complete: true,
  custom_fields: [],
};

describe('beginRun', () => {
  it('calls begin_ghl_sync_run with the inputs and returns the run id', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/begin_ghl_sync_run'
        ? json([{ id: RUN_ID, stale_marked: 1 }])
        : undefined,
    );
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const result = await store.beginRun({
      pipelineId: FINANCE_PIPELINE_ID,
      trigger: 'cli',
      triggeredBy: null,
      staleAfterSeconds: 900,
    });
    expect(result).toEqual({ ok: true, value: { runId: RUN_ID, staleMarked: 1 } });
    expect(seen[0]?.method).toBe('POST');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_pipeline_ghl_id: FINANCE_PIPELINE_ID,
      p_trigger: 'cli',
      p_triggered_by: null,
      p_stale_after_seconds: 900,
    });
  });

  it('maps SQLSTATE 55006 (a run already in progress) to CONFLICT', async () => {
    stub(() =>
      json(
        {
          code: '55006',
          message: 'a GoHighLevel sync is already running',
          details: null,
          hint: null,
        },
        400,
      ),
    );
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const result = await store.beginRun({
      pipelineId: FINANCE_PIPELINE_ID,
      trigger: 'cli',
      triggeredBy: null,
      staleAfterSeconds: 900,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFLICT');
  });

  it('an empty result is INTERNAL, and a thrown fetch is NETWORK', async () => {
    stub(() => json([]));
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const empty = await store.beginRun({
      pipelineId: FINANCE_PIPELINE_ID,
      trigger: 'cli',
      triggeredBy: null,
      staleAfterSeconds: 900,
    });
    expect(!empty.ok && empty.error.code).toBe('INTERNAL');

    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const down = await store.beginRun({
      pipelineId: FINANCE_PIPELINE_ID,
      trigger: 'cli',
      triggeredBy: null,
      staleAfterSeconds: 900,
    });
    expect(!down.ok && down.error.code).toBe('NETWORK');
  });
});

describe('applySnapshot', () => {
  it('sends the snapshot as p_snapshot and parses the counts', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/apply_ghl_snapshot'
        ? json({ ...ZERO_APPLY, stages_seen: 10 })
        : undefined,
    );
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const result = await store.applySnapshot(RUN_ID, SNAPSHOT);
    expect(result).toEqual({ ok: true, value: { ...ZERO_APPLY, stages_seen: 10 } });
    const body = JSON.parse(seen[0]?.body ?? '{}') as { p_run_id: string; p_snapshot: Snapshot };
    expect(body.p_run_id).toBe(RUN_ID);
    expect(body.p_snapshot).toEqual(SNAPSHOT);
  });

  it('counts of the wrong shape are INTERNAL; a database error is HTTP_STATUS', async () => {
    stub(() => json({ stages_seen: 'ten' }));
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const bad = await store.applySnapshot(RUN_ID, SNAPSHOT);
    expect(!bad.ok && bad.error.code).toBe('INTERNAL');

    stub(() =>
      json(
        { code: '22023', message: 'snapshot has no pipeline id', details: null, hint: null },
        400,
      ),
    );
    const refused = await store.applySnapshot(RUN_ID, SNAPSHOT);
    expect(!refused.ok && refused.error.code).toBe('HTTP_STATUS');
  });
});

describe('finishRun', () => {
  it('sends status, errors and the fetch counts', async () => {
    stub((req) =>
      req.path === '/rest/v1/rpc/finish_ghl_sync_run'
        ? new Response(null, { status: 204 })
        : undefined,
    );
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const counts = {
      requests: 5,
      pages_fetched: 1,
      opportunities_fetched: 4,
      opportunities_rejected: 0,
      contacts_fetched: 2,
      contacts_failed: 0,
      contacts_rejected: 0,
      contacts_missing: 0,
      custom_fields_fetched: 14,
    };
    const result = await store.finishRun({
      runId: RUN_ID,
      status: 'success',
      errorCode: null,
      error: null,
      errors: [{ kind: 'contact', id: 'C1', code: 'NOT_FOUND' }],
      counts,
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      p_run_id: RUN_ID,
      p_status: 'success',
      p_error_code: null,
      p_error: null,
      p_errors: [{ kind: 'contact', id: 'C1', code: 'NOT_FOUND' }],
      p_counts: counts,
    });
  });

  it('a run that is no longer running is CONFLICT', async () => {
    stub(() =>
      json({ code: '55006', message: 'run is not running', details: null, hint: null }, 400),
    );
    const store = supabaseGhlSyncStore(createGhlServiceClient(CONFIG));
    const result = await store.finishRun({
      runId: RUN_ID,
      status: 'failed',
      errorCode: 'X',
      error: 'x',
      errors: [],
      counts: {
        requests: 0,
        pages_fetched: 0,
        opportunities_fetched: 0,
        opportunities_rejected: 0,
        contacts_fetched: 0,
        contacts_failed: 0,
        contacts_rejected: 0,
        contacts_missing: 0,
        custom_fields_fetched: 0,
      },
    });
    expect(!result.ok && result.error.code).toBe('CONFLICT');
  });
});

describe('listGhlSyncRuns', () => {
  it('reads newest first with a bounded limit', async () => {
    stub((req) =>
      req.path === '/rest/v1/ghl_sync_runs'
        ? json([{ id: RUN_ID, pipeline_ghl_id: FINANCE_PIPELINE_ID, status: 'success' }])
        : undefined,
    );
    const result = await listGhlSyncRuns(createGhlServiceClient(CONFIG), 500);
    expect(result.ok && result.value[0]?.id).toBe(RUN_ID);
    expect(seen[0]?.query).toContain('order=started_at.desc');
    expect(seen[0]?.query).toContain('limit=100');
  });
});
