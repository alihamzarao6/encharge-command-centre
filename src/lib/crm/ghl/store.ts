/**
 * supabase-js adapter for the sync's three database functions (Milestone 4 part 1).
 * Server-side only — service role, the sanctioned write path (SECURITY.md §4). Same
 * discipline as llm/store.ts: a hard fetch timeout, no blind retries of writes, every
 * failure a typed Result.
 *
 * The write phase is one RPC (`apply_ghl_snapshot`) so the database applies the whole
 * snapshot in one transaction; this module never issues a row-level write itself.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../../auth/clients.js';
import { AppError, NetworkError, ensureError, err, ok, type Result } from '../../errors.js';
import type { Snapshot } from './map.js';
import type { ApplyCounts, GhlSyncStore } from './sync.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style --
   Type aliases, not interfaces: supabase-js matches the schema structurally (see
   auth/clients.ts for the full reasoning). */
type SyncRunRow = {
  id: string;
  pipeline_ghl_id: string;
  trigger: string;
  triggered_by: string | null;
  status: string;
  started_at: string;
  applied_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  requests: number | null;
  pages_fetched: number | null;
  opportunities_fetched: number | null;
  opportunities_rejected: number | null;
  contacts_fetched: number | null;
  contacts_failed: number | null;
  contacts_rejected: number | null;
  contacts_missing: number | null;
  custom_fields_fetched: number | null;
  stages_seen: number | null;
  stages_added: number | null;
  stages_updated: number | null;
  stages_removed: number | null;
  opportunities_inserted: number | null;
  opportunities_updated: number | null;
  opportunities_unchanged: number | null;
  opportunities_removed: number | null;
  contacts_inserted: number | null;
  contacts_updated: number | null;
  contacts_unchanged: number | null;
  contacts_removed: number | null;
  custom_fields_seen: number | null;
  custom_fields_removed: number | null;
  error_code: string | null;
  error: string | null;
  errors: unknown;
};

export type GhlDatabase = {
  public: {
    Tables: {
      ghl_sync_runs: {
        Row: SyncRunRow;
        Insert: Partial<SyncRunRow> & Pick<SyncRunRow, 'pipeline_ghl_id' | 'trigger'>;
        Update: Partial<SyncRunRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      begin_ghl_sync_run: {
        Args: {
          p_pipeline_ghl_id: string;
          p_trigger: string;
          p_triggered_by: string | null;
          p_stale_after_seconds: number;
        };
        Returns: { id: string; stale_marked: number }[];
      };
      apply_ghl_snapshot: {
        Args: { p_run_id: string; p_snapshot: unknown };
        Returns: unknown;
      };
      finish_ghl_sync_run: {
        Args: {
          p_run_id: string;
          p_status: string;
          p_error_code: string | null;
          p_error: string | null;
          p_errors: unknown;
          p_counts: unknown;
        };
        Returns: undefined;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type GhlServiceClient = SupabaseClient<GhlDatabase>;

export const DEFAULT_STORE_TIMEOUT_MS = 30_000;

export function createGhlServiceClient(config: SupabaseAuthConfig): GhlServiceClient {
  return createClient<GhlDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS) },
  });
}

const APPLY_COUNTS_SCHEMA = z.object({
  stages_seen: z.number().int(),
  stages_added: z.number().int(),
  stages_updated: z.number().int(),
  stages_removed: z.number().int(),
  opportunities_inserted: z.number().int(),
  opportunities_updated: z.number().int(),
  opportunities_unchanged: z.number().int(),
  opportunities_removed: z.number().int(),
  contacts_inserted: z.number().int(),
  contacts_updated: z.number().int(),
  contacts_unchanged: z.number().int(),
  contacts_removed: z.number().int(),
  custom_fields_seen: z.number().int(),
  custom_fields_removed: z.number().int(),
});

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, {
      context: { operation, detail: error.message },
    });
  }
  // 55006 object_in_use: begin_ghl_sync_run's "already running", and apply/finish on a
  // run that is no longer running. A definite answer, never retried.
  if (error.code === '55006') {
    return new AppError('CONFLICT', `${operation}: ${error.message}`, {
      context: { operation, supabaseCode: error.code },
    });
  }
  return new AppError('HTTP_STATUS', `${operation}: ${error.message}`, {
    context: { operation, supabaseCode: error.code },
  });
}

function mapThrown(caught: unknown, operation: string): AppError {
  return new NetworkError(`${operation}: transport failure`, {
    context: { operation },
    cause: ensureError(caught),
  });
}

export function supabaseGhlSyncStore(client: GhlServiceClient): GhlSyncStore {
  return {
    beginRun: async (input) => {
      try {
        const { data, error } = await client.rpc('begin_ghl_sync_run', {
          p_pipeline_ghl_id: input.pipelineId,
          p_trigger: input.trigger,
          p_triggered_by: input.triggeredBy,
          p_stale_after_seconds: input.staleAfterSeconds,
        });
        if (error !== null) return err(mapPostgrest(error, 'begin_ghl_sync_run'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'begin_ghl_sync_run returned no row'));
        }
        return ok({ runId: row.id, staleMarked: row.stale_marked });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'begin_ghl_sync_run'));
      }
    },
    applySnapshot: async (runId, snapshot: Snapshot) => {
      try {
        const { data, error } = await client.rpc('apply_ghl_snapshot', {
          p_run_id: runId,
          p_snapshot: snapshot,
        });
        if (error !== null) return err(mapPostgrest(error, 'apply_ghl_snapshot'));
        const parsed = APPLY_COUNTS_SCHEMA.safeParse(data);
        if (!parsed.success) {
          return err(
            new AppError('INTERNAL', 'apply_ghl_snapshot returned counts of an unexpected shape', {
              context: { issues: parsed.error.issues.length },
            }),
          );
        }
        const counts: ApplyCounts = parsed.data;
        return ok(counts);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'apply_ghl_snapshot'));
      }
    },
    finishRun: async (input) => {
      try {
        const { error } = await client.rpc('finish_ghl_sync_run', {
          p_run_id: input.runId,
          p_status: input.status,
          p_error_code: input.errorCode,
          p_error: input.error,
          p_errors: input.errors,
          p_counts: input.counts,
        });
        if (error !== null) return err(mapPostgrest(error, 'finish_ghl_sync_run'));
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'finish_ghl_sync_run'));
      }
    },
  };
}

export type SyncRunRecord = SyncRunRow;

/** Recent runs, newest first — what `npm run crm -- runs` prints. */
export async function listGhlSyncRuns(
  client: GhlServiceClient,
  limit: number,
): Promise<Result<readonly SyncRunRecord[]>> {
  try {
    const { data, error } = await client
      .from('ghl_sync_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 100)));
    if (error !== null) return err(mapPostgrest(error, 'ghl_sync_runs.list'));
    return ok(data);
  } catch (caught: unknown) {
    return err(mapThrown(caught, 'ghl_sync_runs.list'));
  }
}
