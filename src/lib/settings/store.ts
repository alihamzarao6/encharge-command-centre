/**
 * The settings page's writes, over Supabase (Milestone 5 part 4). Three database functions, all
 * executable by service_role only and all already deployed except the first:
 *
 *   forget_document       (migration 20261017020000) — a learned document and every copy of
 *                          it, in one transaction, with the permission check under its locks;
 *   issue_connector_key   (20261013010000) — the digest of a key minted HERE, never the key;
 *   revoke_connector_key  (20261013010000) — given the person's own id, only their own key.
 *
 * LISTS ARE NOT READ HERE. The browser selects `knowledge_sources`, `connector_keys`,
 * `audit_log` and the staff roster directly under row-level security, as the memory and users
 * pages do. The server reads for the page only what the browser must not or cannot:
 *
 *   the spend (page.ts) — the cap it is measured against is server configuration;
 *   how many conversations hold an answer from a document being forgotten — counted across
 *   EVERY conversation, private ones included, so it is the server's and only the number leaves
 *   (answers.ts). First every id the document goes by (`copiesOf`, read BEFORE the forget, which
 *   clears the content hash that finds the copies), then the answers that name one of them.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../auth/clients.js';
import { byteaHex, mapPostgrest, mapThrown } from '../connector/store.js';
import { AppError, err, ok, type Result } from '../errors.js';
import { conversationsHolding, type CitingAnswer, type DocumentIds } from './answers.js';

export type ForgetOutcome =
  | {
      readonly kind: 'forgotten';
      /** Learned copies forgotten (this one and any other copy of the same bytes). */
      readonly sources: number;
      /** Attachments that still held the text, removed. */
      readonly files: number;
      /** Passages and summary chunks deleted. */
      readonly chunks: number;
    }
  | { readonly kind: 'already' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_allowed' }
  | { readonly kind: 'not_staff' };

export type IssueOutcome =
  | { readonly kind: 'issued'; readonly keyId: string; readonly createdAt: string }
  | { readonly kind: 'not_staff' }
  | { readonly kind: 'too_many' }
  | { readonly kind: 'id_taken' };

export type RevokeOutcome =
  | { readonly kind: 'revoked'; readonly keyId: string; readonly revokedAt: string }
  | { readonly kind: 'already_revoked'; readonly keyId: string; readonly revokedAt: string }
  | { readonly kind: 'not_found' };

export interface SettingsStore {
  forgetDocument(sourceId: string, actor: string): Promise<Result<ForgetOutcome>>;
  issueKey(input: {
    readonly userId: string;
    readonly keyId: string;
    readonly digestHex: string;
    readonly label: string;
  }): Promise<Result<IssueOutcome>>;
  /** Only the person's own key: another person's key id answers `not_found`. */
  revokeKey(userId: string, keyId: string): Promise<Result<RevokeOutcome>>;
  /**
   * Every id the document goes by — this learned copy, every other learned copy of the same
   * bytes, and every attachment of them — or null when there is no such source. A copy already
   * forgotten has no hash left, so it stands for itself alone.
   */
  copiesOf(sourceId: string): Promise<Result<DocumentIds | null>>;
  /** Conversations still there with an answer that had the document in front of the model. */
  conversationsWithAnswers(ids: DocumentIds): Promise<Result<number>>;
}

/** Rows read per request, and how many requests one id may take before the count gives up. */
export const ANSWERS_PAGE_ROWS = 1000;
export const ANSWERS_MAX_PAGES = 10;

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style --
   Type aliases and mapped types, not interfaces: supabase-js matches a schema structurally
   against Record<string, unknown>, which an interface fails (the same reason as clients.ts). */
type SourceRow = {
  id: string;
  content_hash: string | null;
  file_id: string | null;
  status: string;
};
type FileRow = { id: string; content_hash: string | null; status: string };
type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  document_coverage: unknown;
};
type ConversationRow = { id: string; deleted_at: string | null };

type SettingsDatabase = {
  public: {
    Tables: {
      knowledge_sources: { Row: SourceRow; Insert: never; Update: never; Relationships: [] };
      conversation_files: { Row: FileRow; Insert: never; Update: never; Relationships: [] };
      messages: { Row: MessageRow; Insert: never; Update: never; Relationships: [] };
      conversations: { Row: ConversationRow; Insert: never; Update: never; Relationships: [] };
    };
    Views: { [_ in never]: never };
    Functions: {
      forget_document: {
        Args: { p_source_id: string; p_actor: string };
        Returns: { outcome: string; sources: number; files: number; chunks: number }[];
      };
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

export type SettingsClient = SupabaseClient<SettingsDatabase>;

export const SETTINGS_STORE_TIMEOUT_MS = 15_000;

export function createSettingsClient(config: SupabaseAuthConfig): SettingsClient {
  return createClient<SettingsDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? SETTINGS_STORE_TIMEOUT_MS) },
  });
}

/** The database's answer → the outcome, or null when it is not a shape this code knows. */
export function readForgetRow(row: unknown): ForgetOutcome | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  const count = (name: string): number | null => {
    const value = record[name];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
  };
  switch (record['outcome']) {
    case 'forgotten': {
      const sources = count('sources');
      const files = count('files');
      const chunks = count('chunks');
      if (sources === null || files === null || chunks === null) return null;
      return { kind: 'forgotten', sources, files, chunks };
    }
    case 'already':
      return { kind: 'already' };
    case 'not_found':
      return { kind: 'not_found' };
    case 'not_allowed':
      return { kind: 'not_allowed' };
    default:
      return null;
  }
}

export function supabaseSettingsStore(client: SettingsClient): SettingsStore {
  return {
    forgetDocument: async (sourceId, actor) => {
      try {
        const { data, error } = await client.rpc('forget_document', {
          p_source_id: sourceId,
          p_actor: actor,
        });
        if (error !== null) {
          if (error.code === 'KF001') return ok({ kind: 'not_staff' });
          return err(mapPostgrest(error, 'forget_document'));
        }
        const outcome = readForgetRow(data[0]);
        if (outcome === null) {
          return err(new AppError('INTERNAL', 'forget_document answered in an unexpected shape'));
        }
        return ok(outcome);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'forget_document'));
      }
    },
    issueKey: async (input) => {
      try {
        const { data, error } = await client.rpc('issue_connector_key', {
          p_user_id: input.userId,
          p_key_id: input.keyId,
          p_key_hash: byteaHex(input.digestHex),
          p_label: input.label,
          // Made from the page: by the person it is for (the terminal passes null).
          p_created_by: input.userId,
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
    revokeKey: async (userId, keyId) => {
      try {
        const { data, error } = await client.rpc('revoke_connector_key', {
          p_user_id: userId,
          p_key_id: keyId,
          p_revoked_by: userId,
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
    copiesOf: async (sourceId) => {
      try {
        const own = await client
          .from('knowledge_sources')
          .select('id, content_hash, file_id, status')
          .eq('id', sourceId)
          .limit(1);
        if (own.error !== null) return err(mapPostgrest(own.error, 'knowledge_sources.copiesOf'));
        const source = own.data[0];
        if (source === undefined) return ok(null);
        const sources = new Set([source.id]);
        const files = new Set(source.file_id === null ? [] : [source.file_id]);
        const hash = source.status === 'forgotten' ? null : source.content_hash;
        if (hash !== null) {
          const copies = await client
            .from('knowledge_sources')
            .select('id, content_hash, file_id, status')
            .eq('content_hash', hash)
            .neq('status', 'forgotten')
            .limit(ANSWERS_PAGE_ROWS);
          if (copies.error !== null) {
            return err(mapPostgrest(copies.error, 'knowledge_sources.copiesOf'));
          }
          for (const copy of copies.data) {
            sources.add(copy.id);
            if (copy.file_id !== null) files.add(copy.file_id);
          }
          const attached = await client
            .from('conversation_files')
            .select('id, content_hash, status')
            .eq('content_hash', hash)
            .limit(ANSWERS_PAGE_ROWS);
          if (attached.error !== null) {
            return err(mapPostgrest(attached.error, 'conversation_files.copiesOf'));
          }
          for (const file of attached.data) files.add(file.id);
        }
        return ok({ sources: [...sources], files: [...files] });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'knowledge_sources.copiesOf'));
      }
    },
    conversationsWithAnswers: async (ids) => {
      const op = 'messages.conversationsWithAnswers';
      try {
        const answers: CitingAnswer[] = [];
        const names = [
          ...ids.sources.map((id) => ({ source: id })),
          ...ids.files.map((id) => ({ file: id })),
        ];
        for (const name of names) {
          for (let page = 0; ; page += 1) {
            // A count that stopped short would tell him fewer conversations than there are.
            if (page === ANSWERS_MAX_PAGES) {
              return err(new AppError('INTERNAL', `${op}: too many answers to count`));
            }
            const from = page * ANSWERS_PAGE_ROWS;
            const { data, error } = await client
              .from('messages')
              .select('conversation_id, role, document_coverage')
              .eq('role', 'assistant')
              .contains('document_coverage', { documents: [name] })
              // A unique order, so a page boundary never skips or repeats a row.
              .order('id')
              .range(from, from + ANSWERS_PAGE_ROWS - 1);
            if (error !== null) return err(mapPostgrest(error, op));
            for (const row of data) {
              answers.push({
                conversationId: row.conversation_id,
                coverage: row.document_coverage,
              });
            }
            if (data.length < ANSWERS_PAGE_ROWS) break;
          }
        }
        const conversationIds = [...new Set(answers.map((a) => a.conversationId))];
        const alive = new Set<string>();
        for (let i = 0; i < conversationIds.length; i += 100) {
          const { data, error } = await client
            .from('conversations')
            .select('id, deleted_at')
            .in('id', conversationIds.slice(i, i + 100))
            .is('deleted_at', null);
          if (error !== null) return err(mapPostgrest(error, op));
          for (const row of data) alive.add(row.id);
        }
        return ok(conversationsHolding(answers, ids, alive));
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
  };
}
