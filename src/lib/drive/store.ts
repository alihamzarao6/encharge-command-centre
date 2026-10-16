/**
 * supabase-js adapter for Google Drive connections and reads (Milestone 5 part 3a): the
 * functions migration 20261016010000 added and the one read the endpoint needs. Server-side
 * only — service role; no browser can read any of these tables (each one's policy is false).
 *
 * The database decides what must not be decided twice: whether a connection attempt is still
 * open and whose it is, whether the row changed under a Connect, whether a person has read too
 * much this minute. Its answers (SQLSTATE DV001, DV002, DR001, and 23503 for a read with no
 * connection behind it) become a `reason` the endpoint maps to a sentence.
 *
 * What is sealed stays sealed here: this module moves ciphertext, never a token.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../auth/clients.js';
import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- supabase-js schema shape (auth/clients.ts) */
type ConnectionDbRow = {
  user_id: string;
  token_id: string;
  google_account_id: string;
  google_email: string;
  refresh_token_sealed: string;
  granted_scope: string;
  status: string;
  broken_reason: string | null;
  broken_at: string | null;
  connected_at: string;
  last_used_at: string | null;
};

export type DriveDatabase = {
  public: {
    Tables: {
      drive_connections: {
        Row: ConnectionDbRow;
        Insert: Partial<ConnectionDbRow>;
        Update: Partial<ConnectionDbRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      create_drive_oauth_state: {
        Args: {
          p_user_id: string;
          p_state_hash: string;
          p_verifier_sealed: string;
          p_ttl_seconds: number;
          p_max_open: number;
        };
        Returns: string;
      };
      return_drive_oauth_state: {
        Args: { p_state_hash: string; p_code_sealed: string | null; p_error: string | null };
        Returns: { id: string; user_id: string }[];
      };
      take_drive_oauth_state: {
        Args: { p_id: string; p_user_id: string };
        Returns: {
          outcome: string;
          state_hash: string | null;
          verifier_sealed: string | null;
          code_sealed: string | null;
          callback_error: string | null;
        }[];
      };
      save_drive_connection: {
        Args: {
          p_user_id: string;
          p_expected_token_id: string | null;
          p_token_id: string;
          p_account_id: string;
          p_email: string;
          p_refresh_sealed: string;
          p_scope: string;
        };
        Returns: { replaced: boolean; same_account: boolean }[];
      };
      mark_drive_connection_broken: {
        Args: { p_user_id: string; p_token_id: string; p_reason: string };
        Returns: boolean;
      };
      delete_drive_connection: {
        Args: { p_user_id: string; p_token_id: string };
        Returns: boolean;
      };
      claim_drive_read: {
        Args: { p_id: string; p_user_id: string; p_drive_file_id: string; p_per_minute: number };
        Returns: { claimed: boolean; existing: boolean }[];
      };
      complete_drive_read: {
        Args: {
          p_id: string;
          p_user_id: string;
          p_status: string;
          p_outcome: string | null;
          p_name: string | null;
          p_google_mime: string | null;
          p_exported_as: string | null;
          p_byte_size: number | null;
          p_content_hash: string | null;
          p_modified_at: string | null;
          p_duration_ms: number | null;
        };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type DriveServiceClient = SupabaseClient<DriveDatabase>;

export const DEFAULT_DRIVE_STORE_TIMEOUT_MS = 15_000;

export function createDriveServiceClient(config: SupabaseAuthConfig): DriveServiceClient {
  return createClient<DriveDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_DRIVE_STORE_TIMEOUT_MS) },
  });
}

export interface DriveConnectionRecord {
  readonly userId: string;
  readonly tokenId: string;
  readonly googleAccountId: string;
  readonly googleEmail: string;
  readonly refreshTokenSealed: string;
  readonly grantedScope: string;
  readonly status: 'active' | 'broken';
  readonly brokenReason: string | null;
  readonly brokenAt: string | null;
  readonly connectedAt: string;
  readonly lastUsedAt: string | null;
}

export type TakenAttempt =
  | {
      readonly outcome: 'ok';
      readonly stateHash: string;
      readonly verifierSealed: string;
      readonly codeSealed: string;
    }
  /** Google sent an error instead of a code; `error` is its code (`access_denied`). */
  | { readonly outcome: 'declined'; readonly error: string }
  | { readonly outcome: 'wrong_user' | 'expired' | 'not_returned' | 'missing' };

export interface SaveConnectionInput {
  readonly userId: string;
  /** The token the caller saw before it started; null when it saw no connection. */
  readonly expectedTokenId: string | null;
  readonly tokenId: string;
  readonly googleAccountId: string;
  readonly googleEmail: string;
  readonly refreshTokenSealed: string;
  readonly grantedScope: string;
}

export interface CompleteReadInput {
  readonly id: string;
  readonly userId: string;
  readonly status: 'fetched' | 'refused' | 'failed';
  /** A reason code. Never a sentence. */
  readonly outcome: string | null;
  readonly name?: string | null;
  readonly googleMime?: string | null;
  readonly exportedAs?: string | null;
  readonly byteSize?: number | null;
  readonly contentHash?: string | null;
  readonly modifiedAt?: string | null;
  readonly durationMs?: number | null;
}

/** Why the database refused. Read by the endpoint to choose a status and a sentence. */
export type DriveStoreReason =
  /** Too many connection attempts open for this person. */
  | 'too_many_attempts'
  /** The connection changed between the caller's read and its write. */
  | 'changed'
  /** Too many reads this minute. */
  | 'too_many_reads'
  /** A read was claimed with no connection behind it. */
  | 'not_connected';

const REASON_BY_SQLSTATE: Readonly<Record<string, DriveStoreReason>> = {
  DV001: 'too_many_attempts',
  DV002: 'changed',
  DR001: 'too_many_reads',
  '23503': 'not_connected',
};

export function driveStoreReason(error: AppError): DriveStoreReason | null {
  const reason = error.context['reason'];
  return typeof reason === 'string' &&
    Object.values(REASON_BY_SQLSTATE).includes(reason as DriveStoreReason)
    ? (reason as DriveStoreReason)
    : null;
}

export interface DriveStore {
  getConnection(userId: string): Promise<Result<DriveConnectionRecord | null>>;
  createAttempt(input: {
    readonly userId: string;
    readonly stateHash: string;
    readonly verifierSealed: string;
    readonly ttlSeconds: number;
    readonly maxOpen: number;
  }): Promise<Result<string>>;
  /** The callback. Null when there is no fresh, unreturned attempt for that state. */
  returnAttempt(input: {
    readonly stateHash: string;
    readonly codeSealed: string | null;
    readonly error: string | null;
  }): Promise<Result<{ readonly id: string; readonly userId: string } | null>>;
  takeAttempt(id: string, userId: string): Promise<Result<TakenAttempt>>;
  saveConnection(
    input: SaveConnectionInput,
  ): Promise<Result<{ readonly replaced: boolean; readonly sameAccount: boolean }>>;
  markBroken(userId: string, tokenId: string, reason: string): Promise<Result<boolean>>;
  deleteConnection(userId: string, tokenId: string): Promise<Result<boolean>>;
  /** One id reads one file, once: `claimed: false` for an id already used. */
  claimRead(input: {
    readonly id: string;
    readonly userId: string;
    readonly driveFileId: string;
    readonly perMinute: number;
  }): Promise<Result<{ readonly claimed: boolean }>>;
  completeRead(input: CompleteReadInput): Promise<Result<boolean>>;
}

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, { context: { operation } });
  }
  const reason = Object.hasOwn(REASON_BY_SQLSTATE, error.code)
    ? REASON_BY_SQLSTATE[error.code]
    : undefined;
  if (reason !== undefined) {
    // A definite answer from the database. The Postgres message is not kept: ids only, and the
    // reason says everything a caller acts on.
    return new AppError('CONFLICT', `${operation}: ${reason}`, {
      context: { operation, reason, supabaseCode: error.code },
    });
  }
  return new AppError('HTTP_STATUS', `${operation}: database error ${error.code}`, {
    context: { operation, supabaseCode: error.code },
  });
}

function mapThrown(caught: unknown, operation: string): AppError {
  return new NetworkError(`${operation}: transport failure`, {
    context: { operation },
    cause: ensureError(caught),
  });
}

const CONNECTION_COLUMNS =
  'user_id, token_id, google_account_id, google_email, refresh_token_sealed, granted_scope, status, broken_reason, broken_at, connected_at, last_used_at';

function toConnection(row: ConnectionDbRow): Result<DriveConnectionRecord> {
  if (row.status !== 'active' && row.status !== 'broken') {
    return err(new AppError('INTERNAL', 'drive_connections row outside its check constraints'));
  }
  return ok({
    userId: row.user_id,
    tokenId: row.token_id,
    googleAccountId: row.google_account_id,
    googleEmail: row.google_email,
    refreshTokenSealed: row.refresh_token_sealed,
    grantedScope: row.granted_scope,
    status: row.status,
    brokenReason: row.broken_reason,
    brokenAt: row.broken_at,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
  });
}

const TAKEN = new Set(['wrong_user', 'expired', 'not_returned', 'missing']);

export function supabaseDriveStore(client: DriveServiceClient): DriveStore {
  return {
    getConnection: async (userId) => {
      try {
        const { data, error } = await client
          .from('drive_connections')
          .select(CONNECTION_COLUMNS)
          .eq('user_id', userId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'drive_connections.get'));
        const row = data[0];
        return row === undefined ? ok(null) : toConnection(row);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'drive_connections.get'));
      }
    },

    createAttempt: async (input) => {
      try {
        const { data, error } = await client.rpc('create_drive_oauth_state', {
          p_user_id: input.userId,
          p_state_hash: input.stateHash,
          p_verifier_sealed: input.verifierSealed,
          p_ttl_seconds: input.ttlSeconds,
          p_max_open: input.maxOpen,
        });
        if (error !== null) return err(mapPostgrest(error, 'create_drive_oauth_state'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'create_drive_oauth_state'));
      }
    },

    returnAttempt: async (input) => {
      try {
        const { data, error } = await client.rpc('return_drive_oauth_state', {
          p_state_hash: input.stateHash,
          p_code_sealed: input.codeSealed,
          p_error: input.error,
        });
        if (error !== null) return err(mapPostgrest(error, 'return_drive_oauth_state'));
        const row = data[0];
        return ok(row === undefined ? null : { id: row.id, userId: row.user_id });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'return_drive_oauth_state'));
      }
    },

    takeAttempt: async (id, userId) => {
      try {
        const { data, error } = await client.rpc('take_drive_oauth_state', {
          p_id: id,
          p_user_id: userId,
        });
        if (error !== null) return err(mapPostgrest(error, 'take_drive_oauth_state'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'take_drive_oauth_state returned no row'));
        }
        if (row.outcome === 'ok') {
          if (row.state_hash === null || row.verifier_sealed === null || row.code_sealed === null) {
            return err(new AppError('INTERNAL', 'take_drive_oauth_state: ok without its parts'));
          }
          return ok({
            outcome: 'ok',
            stateHash: row.state_hash,
            verifierSealed: row.verifier_sealed,
            codeSealed: row.code_sealed,
          });
        }
        if (row.outcome === 'declined') {
          return ok({ outcome: 'declined', error: row.callback_error ?? 'no_code' });
        }
        if (TAKEN.has(row.outcome)) {
          return ok({
            outcome: row.outcome as 'wrong_user' | 'expired' | 'not_returned' | 'missing',
          });
        }
        return err(new AppError('INTERNAL', 'take_drive_oauth_state: unknown outcome'));
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'take_drive_oauth_state'));
      }
    },

    saveConnection: async (input) => {
      try {
        const { data, error } = await client.rpc('save_drive_connection', {
          p_user_id: input.userId,
          p_expected_token_id: input.expectedTokenId,
          p_token_id: input.tokenId,
          p_account_id: input.googleAccountId,
          p_email: input.googleEmail,
          p_refresh_sealed: input.refreshTokenSealed,
          p_scope: input.grantedScope,
        });
        if (error !== null) return err(mapPostgrest(error, 'save_drive_connection'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'save_drive_connection returned no row'));
        }
        return ok({ replaced: row.replaced, sameAccount: row.same_account });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'save_drive_connection'));
      }
    },

    markBroken: async (userId, tokenId, reason) => {
      try {
        const { data, error } = await client.rpc('mark_drive_connection_broken', {
          p_user_id: userId,
          p_token_id: tokenId,
          p_reason: reason,
        });
        if (error !== null) return err(mapPostgrest(error, 'mark_drive_connection_broken'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'mark_drive_connection_broken'));
      }
    },

    deleteConnection: async (userId, tokenId) => {
      try {
        const { data, error } = await client.rpc('delete_drive_connection', {
          p_user_id: userId,
          p_token_id: tokenId,
        });
        if (error !== null) return err(mapPostgrest(error, 'delete_drive_connection'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'delete_drive_connection'));
      }
    },

    claimRead: async (input) => {
      try {
        const { data, error } = await client.rpc('claim_drive_read', {
          p_id: input.id,
          p_user_id: input.userId,
          p_drive_file_id: input.driveFileId,
          p_per_minute: input.perMinute,
        });
        if (error !== null) return err(mapPostgrest(error, 'claim_drive_read'));
        const row = data[0];
        if (row === undefined)
          return err(new AppError('INTERNAL', 'claim_drive_read returned no row'));
        return ok({ claimed: row.claimed });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'claim_drive_read'));
      }
    },

    completeRead: async (input) => {
      try {
        const { data, error } = await client.rpc('complete_drive_read', {
          p_id: input.id,
          p_user_id: input.userId,
          p_status: input.status,
          p_outcome: input.outcome,
          p_name: input.name ?? null,
          p_google_mime: input.googleMime ?? null,
          p_exported_as: input.exportedAs ?? null,
          p_byte_size: input.byteSize ?? null,
          p_content_hash: input.contentHash ?? null,
          p_modified_at: input.modifiedAt ?? null,
          p_duration_ms: input.durationMs ?? null,
        });
        if (error !== null) return err(mapPostgrest(error, 'complete_drive_read'));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'complete_drive_read'));
      }
    },
  };
}
