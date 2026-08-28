/**
 * supabase-js adapters for the auth module (Stage 2 part 3).
 *
 * Everything here is SERVER-SIDE. The service role key is taken from the environment of
 * the process (Edge Function, server route, or the admin CLI) and appears in no return
 * value, no log line (the logger redacts JWTs by pattern anyway) and no client-reachable
 * artefact — tests/security/secrets.test.ts scans for embedded keys.
 *
 * Rule 8 (timeouts / retries / breaker), applied with judgement rather than reflex:
 * every call goes through a fetch wrapper with a hard timeout; retries are deliberately
 * NOT applied because the writes here (create user, set password, ban) are not idempotent
 * at the transport level and rule 8 forbids blindly retrying non-idempotent writes; a
 * circuit breaker guards high-volume pipelines, not one-shot interactive admin commands.
 *
 * The Database type below is hand-written and minimal — the two tables this module touches
 * plus the three the Claude layer writes (part 4). Generated types would replace it.
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Result } from '../errors.js';
import { AppError, ConfigError, NetworkError, ensureError, err, ok } from '../errors.js';
import type {
  AdminDeps,
  AuditWriter,
  AuthAdminApi,
  SignInAt,
  StaffFlagChange,
  StaffStore,
} from './admin.js';
import type { Logger } from '../logger.js';
import type { StaffRow, VerifyDeps } from './verify.js';

// ---------------------------------------------------------------------------------------
// Minimal typed schema
// ---------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style --
   Type aliases, not interfaces: supabase-js matches the schema structurally against
   Record<string, unknown>, which interfaces fail (no implicit index signature) — the
   symptom is every Insert collapsing to never[]. The `[_ in never]: never` empties are
   the shape the Supabase type generator itself emits. */
type AppUsersRow = {
  user_id: string;
  email: string;
  role: string;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
};

// Stage 2 part 4: the three tables the Claude layer writes (src/lib/llm/store.ts).
type ApiUsageInsert = {
  provider: 'anthropic' | 'voyage' | 'ghl' | 'meta';
  operation: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  user_id: string | null;
  conversation_id: string | null;
};

type ConversationsRow = {
  id: string;
  user_id: string;
  scope: string;
  title: string | null;
  created_at: string;
  last_active_at: string;
  deleted_at: string | null;
};

type MessagesRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  scope: string;
  role: string;
  content: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
};

// Stage 3 part 1: memory_chunks (src/lib/memory/chunks.ts). The vector travels as its
// text form ('[0.1,…]') and the range as Postgres text ('[1,11)') — PostgREST casts both.
type MemoryChunksRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  scope: string;
  summary: string;
  audience: string | null;
  embedding: string | null;
  turn_range: string;
  created_at: string;
  // Stage 3 part 3: the tombstone a memory-page delete leaves (migration 20260827030000).
  // The row keeps its turn_range so the range is never re-summarised; everything that made
  // it memory (summary, audience, embedding) is destroyed by the same update.
  deleted_at: string | null;
  deleted_by: string | null;
};

type AuditLogInsert = {
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
};

/** memory_facts (Stage 3 part 2). Written only through the `upsert_memory_fact` function. */
type MemoryFactsRow = {
  id: string;
  user_id: string;
  scope: string;
  key: string;
  value: string | null;
  confidence: number | null;
  source_message_id: string | null;
  superseded_by: string | null;
  embedding: string | null;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      app_users: {
        Row: AppUsersRow;
        Insert: Omit<AppUsersRow, 'created_at'>;
        Update: Partial<Omit<AppUsersRow, 'created_at'>>;
        Relationships: [];
      };
      audit_log: {
        Row: AuditLogInsert & { id: string; created_at: string };
        Insert: AuditLogInsert;
        Update: Partial<AuditLogInsert>;
        Relationships: [];
      };
      api_usage: {
        Row: ApiUsageInsert & { id: string; created_at: string; units: number | null };
        Insert: Partial<ApiUsageInsert> & { provider: ApiUsageInsert['provider'] };
        Update: Partial<ApiUsageInsert>;
        Relationships: [];
      };
      conversations: {
        Row: ConversationsRow;
        Insert: Pick<ConversationsRow, 'user_id'> & Partial<Omit<ConversationsRow, 'user_id'>>;
        Update: Partial<ConversationsRow>;
        Relationships: [];
      };
      messages: {
        Row: MessagesRow;
        Insert: Pick<MessagesRow, 'conversation_id' | 'user_id' | 'scope' | 'role'> &
          Partial<Omit<MessagesRow, 'conversation_id' | 'user_id' | 'scope' | 'role'>>;
        Update: Partial<MessagesRow>;
        Relationships: [];
      };
      memory_chunks: {
        Row: MemoryChunksRow;
        Insert: Omit<MemoryChunksRow, 'id' | 'created_at' | 'deleted_at' | 'deleted_by'> &
          Partial<Pick<MemoryChunksRow, 'id' | 'created_at' | 'deleted_at' | 'deleted_by'>>;
        Update: Partial<MemoryChunksRow>;
        Relationships: [];
      };
      memory_facts: {
        Row: MemoryFactsRow;
        Insert: Omit<MemoryFactsRow, 'id' | 'created_at'> &
          Partial<Pick<MemoryFactsRow, 'id' | 'created_at'>>;
        Update: Partial<MemoryFactsRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    // Stage 3 part 2 (migration 20260827010000): the fact write path and the chunk search.
    // Stage 3 part 4 (migration 20260828010000): the two staff-flag writes that hold the
    // last-admin invariant under an advisory lock, and the one-transaction conversation
    // delete. All three are service_role-only by grant.
    Functions: {
      set_staff_active: {
        Args: { p_user_id: string; p_active: boolean };
        Returns: { changed: boolean; active_admins: number }[];
      };
      set_staff_admin: {
        Args: { p_user_id: string; p_is_admin: boolean };
        Returns: { changed: boolean; active_admins: number }[];
      };
      delete_conversation: {
        Args: { p_conversation_id: string; p_actor: string };
        Returns: {
          already: boolean;
          messages_deleted: number;
          chunks_tombstoned: number;
          facts_unlinked: number;
        }[];
      };
      upsert_memory_fact: {
        Args: {
          p_user_id: string;
          p_scope: string;
          p_key: string;
          p_value: string;
          p_confidence: number;
          p_source_message_id: string | null;
        };
        Returns: { id: string; superseded_id: string | null; outcome: string }[];
      };
      match_memory_chunks: {
        Args: {
          p_query: string;
          p_user_id: string;
          p_conversation_id: string | null;
          p_history_messages: number;
          p_limit: number;
          p_min_similarity: number;
        };
        Returns: {
          id: string;
          conversation_id: string;
          title: string | null;
          audience: string | null;
          summary: string;
          turn_range: string;
          created_at: string;
          similarity: number;
        }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type ServiceClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------------------
// Configuration and client construction
// ---------------------------------------------------------------------------------------

export interface SupabaseAuthConfig {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly timeoutMs?: number;
}

export const DEFAULT_AUTH_TIMEOUT_MS = 15_000;

/** Read the config from the process environment. Server-side processes only. */
export function loadSupabaseAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): Result<SupabaseAuthConfig, ConfigError> {
  const url = env['SUPABASE_URL'];
  const anonKey = env['SUPABASE_ANON_KEY'];
  const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  const missing = [
    ...(url === undefined || url.trim() === '' ? ['SUPABASE_URL'] : []),
    ...(anonKey === undefined || anonKey.trim() === '' ? ['SUPABASE_ANON_KEY'] : []),
    ...(serviceRoleKey === undefined || serviceRoleKey.trim() === ''
      ? ['SUPABASE_SERVICE_ROLE_KEY']
      : []),
  ];
  if (
    missing.length > 0 ||
    url === undefined ||
    anonKey === undefined ||
    serviceRoleKey === undefined
  ) {
    return err(new ConfigError('Supabase auth configuration incomplete', { context: { missing } }));
  }
  return ok({ url, anonKey, serviceRoleKey });
}

type FetchArgs = Parameters<typeof fetch>;

/** Hard deadline on every request; composes with any signal supabase-js passes. */
export function fetchWithTimeout(timeoutMs: number): (...args: FetchArgs) => Promise<Response> {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const upstream = init?.signal;
    const signal =
      upstream === undefined || upstream === null ? timeout : AbortSignal.any([upstream, timeout]);
    return fetch(input, { ...(init ?? {}), signal });
  };
}

export function createServiceClient(config: SupabaseAuthConfig): ServiceClient {
  return createClient<Database>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS) },
  });
}

export function createAnonClient(config: SupabaseAuthConfig): SupabaseClient<Database> {
  return createClient<Database>(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS) },
  });
}

// ---------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------

interface SupabaseErrorLike {
  readonly message: string;
  readonly code?: string | undefined;
  readonly status?: number | undefined;
}

function mapSupabaseError(error: SupabaseErrorLike, operation: string): AppError {
  if (error.code === 'email_exists' || error.code === '23505') {
    return new AppError('CONFLICT', `${operation}: identity already exists`, {
      context: { operation, supabaseCode: error.code },
    });
  }
  // Stage 3 part 4: set_staff_active / set_staff_admin raise 23514 for the two things they
  // refuse — leaving the workspace with no administrator, and promoting someone who cannot
  // sign in. They are authorization outcomes, not transport failures, and the sentence they
  // carry is the one written for the person (the SQL wording matches access.ts's intent).
  if (error.code === '23514') {
    const lastAdmin = error.message.includes('at least one active administrator');
    return new AppError(
      'FORBIDDEN',
      lastAdmin
        ? 'The Command Centre must always have at least one administrator. Make someone else an administrator first.'
        : 'This person no longer has access. Restore their access first.',
      { context: { operation, reason: lastAdmin ? 'last_admin' : 'inactive_target' } },
    );
  }
  return new AppError('HTTP_STATUS', `${operation}: ${error.message}`, {
    context: { operation, supabaseCode: error.code ?? null, status: error.status ?? null },
  });
}

function mapThrown(caught: unknown, operation: string): AppError {
  const cause = ensureError(caught);
  return new NetworkError(`${operation}: transport failure`, { context: { operation }, cause });
}

// ---------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------

const STAFF_COLUMNS = 'user_id, email, role, is_active, is_admin';

/** 5 pages × 200 = 1,000 auth accounts. See lastSignIns for why that is the right shape. */
const AUTH_USER_PAGE_LIMIT = 5;

export function supabaseVerifyDeps(client: ServiceClient): VerifyDeps {
  return {
    getUserFromToken: async (token) => {
      try {
        const { data, error } = await client.auth.getUser(token);
        if (error !== null) {
          // 4xx from GoTrue is an auth DECISION (expired, tampered, banned) → invalid
          // token. Anything else means the auth server could not be asked.
          if (error.status !== undefined && error.status >= 400 && error.status < 500) {
            return ok(null);
          }
          return err(mapSupabaseError(error, 'auth.getUser'));
        }
        return ok({ id: data.user.id, email: data.user.email ?? null });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'auth.getUser'));
      }
    },
    getStaffRow: async (userId) => getStaffRowBy(client, 'user_id', userId),
  };
}

async function getStaffRowBy(
  client: ServiceClient,
  column: 'user_id' | 'email',
  value: string,
): Promise<Result<StaffRow | null>> {
  try {
    // A plain array select instead of maybeSingle(): 0 rows is an ordinary empty array,
    // not a PostgREST error-code special case. limit(2) so a uniqueness violation would
    // surface here instead of being silently truncated.
    const { data, error } = await client
      .from('app_users')
      .select(STAFF_COLUMNS)
      .eq(column, value)
      .limit(2);
    if (error !== null) {
      return err(mapSupabaseError(error, `app_users.select.${column}`));
    }
    if (data.length > 1) {
      return err(
        new AppError('INTERNAL', `app_users.select.${column}: more than one row matched`, {
          context: { column },
        }),
      );
    }
    return ok(data[0] ?? null);
  } catch (caught: unknown) {
    return err(mapThrown(caught, `app_users.select.${column}`));
  }
}

/**
 * Both flag writes go through their database function rather than a plain UPDATE. The
 * function is where the last-admin invariant can actually hold: two admins demoting each
 * other at the same moment both read "two admins" under READ COMMITTED and both pass, so
 * the two writes take a shared advisory lock and the second one is refused (migration
 * 20260828010000). A plain UPDATE from here could not do that.
 */
async function staffFlagRpc(
  client: ServiceClient,
  operation: 'set_staff_active' | 'set_staff_admin',
  args: { p_user_id: string; p_active: boolean } | { p_user_id: string; p_is_admin: boolean },
): Promise<Result<StaffFlagChange>> {
  try {
    const { data, error } =
      operation === 'set_staff_active'
        ? await client.rpc(operation, args as { p_user_id: string; p_active: boolean })
        : await client.rpc(operation, args as { p_user_id: string; p_is_admin: boolean });
    if (error !== null) {
      return err(mapSupabaseError(error, operation));
    }
    const row = data[0];
    if (row === undefined) {
      return err(
        new AppError('INTERNAL', `${operation}: returned no row`, { context: { operation } }),
      );
    }
    return ok({ changed: row.changed, activeAdmins: row.active_admins });
  } catch (caught: unknown) {
    return err(mapThrown(caught, operation));
  }
}

export function supabaseStaffStore(client: ServiceClient): StaffStore {
  return {
    getByEmail: async (email) => getStaffRowBy(client, 'email', email),
    getById: async (userId) => getStaffRowBy(client, 'user_id', userId),
    insert: async (row) => {
      try {
        const { error } = await client.from('app_users').insert(row);
        if (error !== null) {
          return err(mapSupabaseError(error, 'app_users.insert'));
        }
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'app_users.insert'));
      }
    },
    setActive: async (userId, active) =>
      staffFlagRpc(client, 'set_staff_active', { p_user_id: userId, p_active: active }),
    setAdmin: async (userId, admin) =>
      staffFlagRpc(client, 'set_staff_admin', { p_user_id: userId, p_is_admin: admin }),
    list: async () => {
      try {
        // One workspace, tens of people: an unpaged read with a generous ceiling is honest
        // here, and a ceiling that is ever reached would be a different product.
        const { data, error } = await client
          .from('app_users')
          .select(STAFF_COLUMNS)
          .order('email', { ascending: true })
          .limit(1000);
        if (error !== null) {
          return err(mapSupabaseError(error, 'app_users.list'));
        }
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'app_users.list'));
      }
    },
  };
}

export function supabaseAuthAdminApi(client: ServiceClient): AuthAdminApi {
  return {
    createUser: async (email, password) => {
      try {
        const { data, error } = await client.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
        });
        if (error !== null) {
          return err(mapSupabaseError(error, 'auth.admin.createUser'));
        }
        return ok({ id: data.user.id, email: data.user.email ?? null });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'auth.admin.createUser'));
      }
    },
    setPassword: async (userId, password) => {
      try {
        const { error } = await client.auth.admin.updateUserById(userId, { password });
        if (error !== null) {
          return err(mapSupabaseError(error, 'auth.admin.setPassword'));
        }
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'auth.admin.setPassword'));
      }
    },
    setBanned: async (userId, banned) => {
      try {
        // '87600h' ≈ 10 years — GoTrue has no "indefinite", this is the conventional stand-in.
        const { error } = await client.auth.admin.updateUserById(userId, {
          ban_duration: banned ? '87600h' : 'none',
        });
        if (error !== null) {
          return err(mapSupabaseError(error, 'auth.admin.setBanned'));
        }
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'auth.admin.setBanned'));
      }
    },
    lastSignIns: async () => {
      try {
        const out: SignInAt[] = [];
        // Paged, with a hard ceiling: this is a brokerage's staff list, not a directory. If
        // the ceiling were ever reached the page would be showing a truncated roster, so it
        // is set an order of magnitude above the number the client has described (35).
        for (let page = 1; page <= AUTH_USER_PAGE_LIMIT; page += 1) {
          const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
          if (error !== null) {
            return err(mapSupabaseError(error, 'auth.admin.listUsers'));
          }
          for (const user of data.users) {
            out.push({ userId: user.id, lastSignInAt: user.last_sign_in_at ?? null });
          }
          if (data.users.length < 200) break;
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'auth.admin.listUsers'));
      }
    },
  };
}

export function supabaseAuditWriter(client: ServiceClient): AuditWriter {
  return {
    write: async (entry) => {
      try {
        const { error } = await client.from('audit_log').insert({
          actor: entry.actor,
          action: entry.action,
          entity_type: entry.entityType,
          entity_id: entry.entityId,
        });
        if (error !== null) {
          return err(mapSupabaseError(error, 'audit_log.insert'));
        }
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'audit_log.insert'));
      }
    },
  };
}

/** One-stop wiring for the CLI and (later) server routes. */
export function createAdminDeps(config: SupabaseAuthConfig, log: Logger): AdminDeps {
  const service = createServiceClient(config);
  return {
    verify: supabaseVerifyDeps(service),
    authAdmin: supabaseAuthAdminApi(service),
    staff: supabaseStaffStore(service),
    audit: supabaseAuditWriter(service),
    log,
  };
}

// ---------------------------------------------------------------------------------------
// Sign-in (CLI only — obtains the ADMIN caller's token; sessions in the eventual UI use
// the anon key client-side, never anything from this module)
// ---------------------------------------------------------------------------------------

export interface SignedIn {
  readonly accessToken: string;
  readonly userId: string;
}

export async function signInWithPassword(
  config: SupabaseAuthConfig,
  email: string,
  password: string,
): Promise<Result<SignedIn>> {
  const client = createAnonClient(config);
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error !== null) {
      return err(
        new AppError('UNAUTHENTICATED', 'sign-in refused', {
          context: { status: error.status ?? null, supabaseCode: error.code ?? null },
        }),
      );
    }
    return ok({ accessToken: data.session.access_token, userId: data.user.id });
  } catch (caught: unknown) {
    return err(mapThrown(caught, 'auth.signInWithPassword'));
  }
}
