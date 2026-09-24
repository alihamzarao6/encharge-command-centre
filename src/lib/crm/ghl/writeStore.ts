/**
 * supabase-js adapter for the write path's database side (Milestone 4 part 4): the three
 * functions migration 20260924010000 added and the two mirror reads a move needs first.
 * Server-side only — service role. Same discipline as store.ts: a hard fetch timeout, no
 * blind retries of writes, every failure a typed Result.
 *
 * Nothing here writes a mirror row directly: `finish_ghl_write` does, in one transaction
 * with the write record and the audit row.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../../auth/clients.js';
import { AppError, NetworkError, ensureError, err, ok } from '../../errors.js';
import type { OpportunityRow } from './map.js';
import type {
  BeginWriteInput,
  BeginWriteResult,
  FinishWriteInput,
  MirrorOpportunity,
  NoteRow,
  WriteStore,
} from './moves.js';
import { DEFAULT_STORE_TIMEOUT_MS } from './store.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- supabase-js schema shape (store.ts) */
type StageRow = { ghl_id: string; pipeline_ghl_id: string; removed_at: string | null };
type OpportunityMirrorRow = {
  ghl_id: string;
  pipeline_ghl_id: string;
  stage_ghl_id: string;
  contact_ghl_id: string | null;
  removed_at: string | null;
};

export type GhlWriteDatabase = {
  public: {
    Tables: {
      ghl_stages: {
        Row: StageRow;
        Insert: Partial<StageRow>;
        Update: Partial<StageRow>;
        Relationships: [];
      };
      ghl_opportunities: {
        Row: OpportunityMirrorRow;
        Insert: Partial<OpportunityMirrorRow>;
        Update: Partial<OpportunityMirrorRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      begin_ghl_write: {
        Args: {
          p_request_id: string;
          p_actor: string;
          p_kind: string;
          p_pipeline_ghl_id: string;
          p_opportunity_ghl_id: string;
          p_contact_ghl_id: string | null;
          p_screen_stage_ghl_id: string | null;
          p_to_stage_ghl_id: string | null;
        };
        Returns: {
          id: string;
          existing: boolean;
          status: string;
          from_stage_ghl_id: string | null;
          to_stage_ghl_id: string | null;
          error_code: string | null;
        }[];
      };
      finish_ghl_write: {
        Args: {
          p_id: string;
          p_status: string;
          p_ghl_status: number | null;
          p_error_code: string | null;
          p_duration_ms: number;
          p_from_stage_ghl_id: string | null;
          p_opportunity: OpportunityRow | null;
          p_note: NoteRow | null;
        };
        Returns: undefined;
      };
      mark_ghl_opportunity_removed: {
        Args: { p_ghl_id: string };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type GhlWriteServiceClient = SupabaseClient<GhlWriteDatabase>;

export function createGhlWriteServiceClient(config: SupabaseAuthConfig): GhlWriteServiceClient {
  return createClient<GhlWriteDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_STORE_TIMEOUT_MS) },
  });
}

const WRITE_STATUS_SCHEMA = z.enum([
  'in_flight',
  'success',
  'noop',
  'failed',
  'unknown',
  'mirror_failed',
]);

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, {
      context: { operation, detail: error.message },
    });
  }
  // 55006: finish on a write that is no longer in flight — a definite answer, never retried.
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

export function supabaseWriteStore(client: GhlWriteServiceClient): WriteStore {
  return {
    liveStageIds: async (pipelineId) => {
      try {
        const { data, error } = await client
          .from('ghl_stages')
          .select('ghl_id, pipeline_ghl_id, removed_at')
          .eq('pipeline_ghl_id', pipelineId)
          .is('removed_at', null)
          .limit(500);
        if (error !== null) return err(mapPostgrest(error, 'ghl_stages.select'));
        return ok(data.map((s) => s.ghl_id));
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'ghl_stages.select'));
      }
    },
    mirrorOpportunity: async (opportunityId) => {
      try {
        const { data, error } = await client
          .from('ghl_opportunities')
          .select('ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, removed_at')
          .eq('ghl_id', opportunityId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'ghl_opportunities.select'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const found: MirrorOpportunity = {
          pipelineId: row.pipeline_ghl_id,
          stageId: row.stage_ghl_id,
          contactId: row.contact_ghl_id,
          removedAt: row.removed_at,
        };
        return ok(found);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'ghl_opportunities.select'));
      }
    },
    beginWrite: async (input: BeginWriteInput) => {
      try {
        const { data, error } = await client.rpc('begin_ghl_write', {
          p_request_id: input.requestId,
          p_actor: input.actor,
          p_kind: input.kind,
          p_pipeline_ghl_id: input.pipelineId,
          p_opportunity_ghl_id: input.opportunityId,
          p_contact_ghl_id: input.contactId,
          p_screen_stage_ghl_id: input.screenStageId,
          p_to_stage_ghl_id: input.toStageId,
        });
        if (error !== null) return err(mapPostgrest(error, 'begin_ghl_write'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'begin_ghl_write returned no row'));
        }
        const status = WRITE_STATUS_SCHEMA.safeParse(row.status);
        if (!status.success) {
          return err(
            new AppError('INTERNAL', 'begin_ghl_write returned an unknown status', {
              context: { status: row.status },
            }),
          );
        }
        const result: BeginWriteResult = {
          id: row.id,
          existing: row.existing,
          status: status.data,
          fromStageId: row.from_stage_ghl_id,
          toStageId: row.to_stage_ghl_id,
          errorCode: row.error_code,
        };
        return ok(result);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'begin_ghl_write'));
      }
    },
    finishWrite: async (input: FinishWriteInput) => {
      try {
        const { error } = await client.rpc('finish_ghl_write', {
          p_id: input.id,
          p_status: input.status,
          p_ghl_status: input.ghlStatus,
          p_error_code: input.errorCode,
          p_duration_ms: input.durationMs,
          p_from_stage_ghl_id: input.fromStageId,
          p_opportunity: input.opportunity,
          p_note: input.note,
        });
        if (error !== null) return err(mapPostgrest(error, 'finish_ghl_write'));
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'finish_ghl_write'));
      }
    },
    markOpportunityRemoved: async (opportunityId) => {
      try {
        const { data, error } = await client.rpc('mark_ghl_opportunity_removed', {
          p_ghl_id: opportunityId,
        });
        if (error !== null) return err(mapPostgrest(error, 'mark_ghl_opportunity_removed'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'mark_ghl_opportunity_removed'));
      }
    },
  };
}
