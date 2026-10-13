/**
 * The connector's one call to the database (MCP connector, stage 1). Everything a request
 * does goes through `connector_call`: the key check, the limits, the record of the call and
 * the read happen in one transaction there (migration 20261013010000).
 *
 * WHAT THIS MODULE CANNOT DO is as deliberate as what it can. Its client is typed with ONE
 * function and NO tables, so the request path cannot name a table of the mirror, the staff
 * list, the audit log or anything else: a tool's rows come back from the function, already
 * filtered by the key's own user's row-level security and by the one pipeline id. It never
 * passes a user id — the database finds the user from the key. Issuing and revoking keys
 * live in keyAdmin.ts, which the function does not import.
 * tests/security/connector.test.ts holds all of that.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../auth/clients.js';
import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';
import type { Credential } from './auth.js';

export interface ConnectorCallInput {
  readonly credential: Credential;
  /** One of the methods this server knows, or 'other' / 'invalid'. Never the caller's text. */
  readonly method: string;
  readonly tool: string | null;
  readonly args: Readonly<Record<string, unknown>> | null;
  readonly pipelineId: string;
  readonly perMinute: number;
  readonly perDay: number;
}

export type RefusalReason = 'unknown_key' | 'wrong_secret' | 'revoked' | 'user_inactive';

export type ConnectorCallReply =
  | {
      readonly outcome: 'unauthenticated';
      readonly reason: RefusalReason;
      readonly keyId: string | null;
    }
  | {
      readonly outcome: 'rate_limited';
      readonly keyId: string;
      readonly window: 'minute' | 'day';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly outcome: 'ok';
      readonly keyId: string;
      readonly callId: string;
      readonly data: unknown;
    }
  | { readonly outcome: 'read_failed'; readonly keyId: string; readonly callId: string };

export interface ConnectorStore {
  call(input: ConnectorCallInput): Promise<Result<ConnectorCallReply>>;
}

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style --
   Type aliases and mapped types, not interfaces: supabase-js matches a schema structurally
   against Record<string, unknown>, which an interface fails (the same reason as clients.ts). */
export type ConnectorDatabase = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: {
      connector_call: {
        Args: {
          p_key_id: string;
          p_key_hash: string;
          p_method: string;
          p_tool: string | null;
          p_args: unknown;
          p_pipeline_ghl_id: string;
          p_per_minute: number;
          p_per_day: number;
        };
        Returns: unknown;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type ConnectorServiceClient = SupabaseClient<ConnectorDatabase>;

export function createConnectorServiceClient(
  config: SupabaseAuthConfig,
  timeoutMs: number,
): ConnectorServiceClient {
  return createClient<ConnectorDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(timeoutMs) },
  });
}

/** A 32-byte digest as PostgREST takes a bytea: `\x` and 64 hex characters. */
export function byteaHex(digestHex: string): string {
  return `\\x${digestHex}`;
}

const REPLY = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('unauthenticated'),
    reason: z.enum(['unknown_key', 'wrong_secret', 'revoked', 'user_inactive']),
    key_id: z.string().optional(),
  }),
  z.object({
    outcome: z.literal('rate_limited'),
    key_id: z.string(),
    window: z.enum(['minute', 'day']),
    retry_after_seconds: z.number().int().min(1),
  }),
  z.object({
    outcome: z.literal('ok'),
    key_id: z.string(),
    call_id: z.string(),
    data: z.unknown(),
  }),
  z.object({
    outcome: z.literal('read_failed'),
    key_id: z.string(),
    call_id: z.string(),
  }),
]);

/** What the database answered → the reply, or null when it is not a shape this code knows. */
export function parseCallReply(raw: unknown): ConnectorCallReply | null {
  const parsed = REPLY.safeParse(raw);
  if (!parsed.success) return null;
  const reply = parsed.data;
  switch (reply.outcome) {
    case 'unauthenticated':
      return { outcome: 'unauthenticated', reason: reply.reason, keyId: reply.key_id ?? null };
    case 'rate_limited':
      return {
        outcome: 'rate_limited',
        keyId: reply.key_id,
        window: reply.window,
        retryAfterSeconds: reply.retry_after_seconds,
      };
    case 'ok':
      return { outcome: 'ok', keyId: reply.key_id, callId: reply.call_id, data: reply.data };
    case 'read_failed':
      return { outcome: 'read_failed', keyId: reply.key_id, callId: reply.call_id };
  }
}

export function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, { context: { operation } });
  }
  // The message is the database's own and may name a column or a value: the code is enough.
  return new AppError('HTTP_STATUS', `${operation}: database error`, {
    context: { operation, supabaseCode: error.code },
  });
}

export function mapThrown(caught: unknown, operation: string): AppError {
  return new NetworkError(`${operation}: transport failure`, {
    context: { operation },
    cause: ensureError(caught),
  });
}

export function supabaseConnectorStore(client: ConnectorServiceClient): ConnectorStore {
  return {
    call: async (input) => {
      try {
        const { data, error } = await client.rpc('connector_call', {
          p_key_id: input.credential.keyId,
          p_key_hash: byteaHex(input.credential.digestHex),
          p_method: input.method,
          p_tool: input.tool,
          p_args: input.args,
          p_pipeline_ghl_id: input.pipelineId,
          p_per_minute: input.perMinute,
          p_per_day: input.perDay,
        });
        if (error !== null) return err(mapPostgrest(error, 'connector_call'));
        const reply = parseCallReply(data);
        if (reply === null) {
          return err(new AppError('INTERNAL', 'connector_call answered in an unexpected shape'));
        }
        return ok(reply);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'connector_call'));
      }
    },
  };
}
