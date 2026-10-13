/**
 * Issuing, listing and revoking connector keys (MCP connector, stage 1). Used by
 * `npm run connector` and by nothing else: the connector's own function does not import this
 * file, so no request that arrives over the internet can reach it — managing keys is exactly
 * the administrative surface the connector was agreed not to have.
 *
 * A key is shown ONCE, here, at the moment it is made. What is kept is its SHA-256; there is
 * no way to show it again, to anyone, and `list` shows the public id and nothing more.
 *
 * A settings screen (Milestone 5 part 4) can use the same two database functions and the
 * same table without a migration: a signed-in person may already read their own rows under
 * row-level security. The digests are in a table of their own that no session can read.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../auth/clients.js';
import { AppError, err, ok, type Result } from '../errors.js';
import { isKeyId, mintKey, type RandomBytes } from './keys.js';
import { byteaHex, mapPostgrest, mapThrown } from './store.js';

export interface KeyRecord {
  readonly keyId: string;
  readonly userId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface StaffLookup {
  readonly userId: string;
  readonly email: string;
  readonly isActive: boolean;
}

export type StoredIssue =
  | { readonly kind: 'issued'; readonly keyId: string; readonly createdAt: string }
  | { readonly kind: 'not_staff' }
  | { readonly kind: 'too_many' }
  | { readonly kind: 'id_taken' };

export type StoredRevoke =
  | { readonly kind: 'revoked'; readonly keyId: string; readonly revokedAt: string }
  | { readonly kind: 'already_revoked'; readonly keyId: string; readonly revokedAt: string }
  | { readonly kind: 'not_found' };

export interface KeyAdminStore {
  findStaffByEmail(email: string): Promise<Result<StaffLookup | null>>;
  issue(input: {
    readonly userId: string;
    readonly keyId: string;
    readonly digestHex: string;
    readonly label: string;
  }): Promise<Result<StoredIssue>>;
  list(userId: string | null): Promise<Result<readonly KeyRecord[]>>;
  revoke(keyId: string): Promise<Result<StoredRevoke>>;
  emailsFor(userIds: readonly string[]): Promise<Result<ReadonlyMap<string, string>>>;
}

/** The most live keys one person may hold; the database enforces the same number. */
export const MAX_LIVE_KEYS = 5;
export const LABEL_MAX = 80;

export type IssueResult =
  | {
      readonly kind: 'issued';
      /** The whole key. Print it once; it is not kept and cannot be shown again. */
      readonly key: string;
      readonly keyId: string;
      readonly email: string;
      readonly label: string;
      readonly createdAt: string;
    }
  | { readonly kind: 'no_such_user'; readonly email: string }
  | { readonly kind: 'inactive_user'; readonly email: string }
  | { readonly kind: 'too_many'; readonly email: string }
  | { readonly kind: 'bad_label' };

function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email) ? email : null;
}

/**
 * Make a key for one member of staff. The key is minted here, its digest is stored, and the
 * key is returned to be shown once. A collision on the 12-character id (59 random bits) is
 * tried again with a new key rather than reported.
 */
export async function issueKey(
  store: KeyAdminStore,
  input: { readonly email: string; readonly label: string },
  random?: RandomBytes,
): Promise<Result<IssueResult>> {
  const email = normaliseEmail(input.email);
  if (email === null) return ok({ kind: 'no_such_user', email: input.email.trim() });
  const label = input.label.trim();
  // eslint-disable-next-line no-control-regex -- a label is one line of plain text
  if (label.length > LABEL_MAX || /[\u0000-\u001F\u007F]/.test(label)) {
    return ok({ kind: 'bad_label' });
  }
  const staff = await store.findStaffByEmail(email);
  if (!staff.ok) return err(staff.error);
  if (staff.value === null) return ok({ kind: 'no_such_user', email });
  if (!staff.value.isActive) return ok({ kind: 'inactive_user', email });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const minted = await mintKey(random);
    const stored = await store.issue({
      userId: staff.value.userId,
      keyId: minted.keyId,
      digestHex: minted.digestHex,
      label,
    });
    if (!stored.ok) return err(stored.error);
    switch (stored.value.kind) {
      case 'issued':
        return ok({
          kind: 'issued',
          key: minted.key,
          keyId: stored.value.keyId,
          email,
          label,
          createdAt: stored.value.createdAt,
        });
      case 'not_staff':
        return ok({ kind: 'inactive_user', email });
      case 'too_many':
        return ok({ kind: 'too_many', email });
      case 'id_taken':
        continue;
    }
  }
  return err(new AppError('INTERNAL', 'could not mint a key with an unused id'));
}

export interface ListedKey {
  readonly keyId: string;
  readonly email: string;
  readonly label: string;
  readonly state: 'live' | 'revoked';
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export type ListResult =
  | { readonly kind: 'listed'; readonly keys: readonly ListedKey[] }
  | { readonly kind: 'no_such_user'; readonly email: string };

/** Every key, or one person's: the public id, whose it is and when it was used. Never the key. */
export async function listKeys(
  store: KeyAdminStore,
  input: { readonly email: string | null },
): Promise<Result<ListResult>> {
  let userId: string | null = null;
  if (input.email !== null) {
    const email = normaliseEmail(input.email);
    if (email === null) return ok({ kind: 'no_such_user', email: input.email.trim() });
    const staff = await store.findStaffByEmail(email);
    if (!staff.ok) return err(staff.error);
    if (staff.value === null) return ok({ kind: 'no_such_user', email });
    userId = staff.value.userId;
  }
  const rows = await store.list(userId);
  if (!rows.ok) return err(rows.error);
  const emails = await store.emailsFor(rows.value.map((row) => row.userId));
  if (!emails.ok) return err(emails.error);
  return ok({
    kind: 'listed',
    keys: rows.value.map((row) => ({
      keyId: row.keyId,
      email: emails.value.get(row.userId) ?? '(no longer on the staff list)',
      label: row.label,
      state: row.revokedAt === null ? 'live' : 'revoked',
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    })),
  });
}

export type RevokeResult = StoredRevoke | { readonly kind: 'not_a_key_id' };

/**
 * Switch a key off, by its public id. Given a whole key by mistake, it is refused before it
 * goes anywhere: a key must not be typed into a terminal whose history is kept.
 */
export async function revokeKey(
  store: KeyAdminStore,
  input: { readonly keyId: string },
): Promise<Result<RevokeResult>> {
  const keyId = input.keyId.trim();
  if (!isKeyId(keyId)) return ok({ kind: 'not_a_key_id' });
  return store.revoke(keyId);
}

// ---------------------------------------------------------------------------------------
// The store over Supabase
// ---------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style --
   Type aliases and mapped types, not interfaces: supabase-js matches a schema structurally
   against Record<string, unknown>, which an interface fails (the same reason as clients.ts). */
type KeyRow = {
  id: string;
  key_id: string;
  user_id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type StaffRow = { user_id: string; email: string; is_active: boolean };

type KeyAdminDatabase = {
  public: {
    Tables: {
      connector_keys: { Row: KeyRow; Insert: never; Update: never; Relationships: [] };
      app_users: { Row: StaffRow; Insert: never; Update: never; Relationships: [] };
    };
    Views: { [_ in never]: never };
    Functions: {
      issue_connector_key: {
        Args: {
          p_user_id: string;
          p_key_id: string;
          p_key_hash: string;
          p_label: string;
          p_created_by: string | null;
        };
        Returns: { id: string; key_id: string; created_at: string }[];
      };
      revoke_connector_key: {
        Args: { p_user_id: string | null; p_key_id: string; p_revoked_by: string | null };
        Returns: { key_id: string; revoked_at: string; already: boolean }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type KeyAdminClient = SupabaseClient<KeyAdminDatabase>;

export const KEY_ADMIN_TIMEOUT_MS = 15_000;

export function createKeyAdminClient(config: SupabaseAuthConfig): KeyAdminClient {
  return createClient<KeyAdminDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? KEY_ADMIN_TIMEOUT_MS) },
  });
}

/** The digest is not in this table at all (connector_key_secrets): there is nothing to leave out. */
const KEY_COLUMNS = 'id, key_id, user_id, label, created_at, last_used_at, revoked_at';

function toRecord(row: KeyRow): KeyRecord {
  return {
    keyId: row.key_id,
    userId: row.user_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function supabaseKeyAdminStore(client: KeyAdminClient): KeyAdminStore {
  return {
    findStaffByEmail: async (email) => {
      try {
        const { data, error } = await client
          .from('app_users')
          .select('user_id, email, is_active')
          .eq('email', email)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'app_users.find'));
        const row = data[0];
        return ok(
          row === undefined
            ? null
            : { userId: row.user_id, email: row.email, isActive: row.is_active },
        );
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'app_users.find'));
      }
    },
    issue: async (input) => {
      try {
        const { data, error } = await client.rpc('issue_connector_key', {
          p_user_id: input.userId,
          p_key_id: input.keyId,
          p_key_hash: byteaHex(input.digestHex),
          p_label: input.label,
          p_created_by: null,
        });
        if (error !== null) {
          if (error.code === 'CK001') return ok({ kind: 'not_staff' });
          if (error.code === 'CK002') return ok({ kind: 'too_many' });
          if (error.code === 'CK003') return ok({ kind: 'id_taken' });
          return err(mapPostgrest(error, 'issue_connector_key'));
        }
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'issue_connector_key returned no row'));
        }
        return ok({ kind: 'issued', keyId: row.key_id, createdAt: row.created_at });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'issue_connector_key'));
      }
    },
    list: async (userId) => {
      try {
        const query = client
          .from('connector_keys')
          .select(KEY_COLUMNS)
          .order('created_at', { ascending: false })
          .limit(200);
        const { data, error } = await (userId === null ? query : query.eq('user_id', userId));
        if (error !== null) return err(mapPostgrest(error, 'connector_keys.list'));
        return ok(data.map(toRecord));
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'connector_keys.list'));
      }
    },
    revoke: async (keyId) => {
      try {
        const { data, error } = await client.rpc('revoke_connector_key', {
          p_user_id: null,
          p_key_id: keyId,
          p_revoked_by: null,
        });
        if (error !== null) return err(mapPostgrest(error, 'revoke_connector_key'));
        const row = data[0];
        if (row === undefined) return ok({ kind: 'not_found' });
        return ok({
          kind: row.already ? 'already_revoked' : 'revoked',
          keyId: row.key_id,
          revokedAt: row.revoked_at,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'revoke_connector_key'));
      }
    },
    emailsFor: async (userIds) => {
      if (userIds.length === 0) return ok(new Map());
      try {
        const { data, error } = await client
          .from('app_users')
          .select('user_id, email, is_active')
          .in('user_id', [...new Set(userIds)])
          .limit(500);
        if (error !== null) return err(mapPostgrest(error, 'app_users.emails'));
        return ok(new Map(data.map((row) => [row.user_id, row.email])));
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'app_users.emails'));
      }
    },
  };
}
