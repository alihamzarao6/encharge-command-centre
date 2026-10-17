/**
 * The schema as the browser sees it (Milestone 5 part 4 moved it here from supabase.ts): row
 * shapes and the typed client, and nothing that runs. Kept apart from supabase.ts, which builds
 * the client from import.meta.env, so a module that only needs the TYPE of the client — the
 * settings page's reads, tested under Node — does not pull the browser environment in with it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// Every row shape lives in the view module that reasons over it — memoryView, usersView,
// conversationsView — none of which import anything that touches import.meta.env, so that
// logic is unit-testable under Node. supabase.ts re-exports all of them, because that is where
// the rest of the app expects a row type to come from.
import type { ConversationListRow } from './conversationsView.js';
import type { ConversationFileRow } from './filesApi.js';
import type { MemoryChunkRow, MemoryFactRow } from './memoryView.js';
import type {
  GhlContactFullRow,
  GhlCustomFieldRow,
  GhlNoteRow,
  GhlOpportunityDetailRow,
} from './leadDetailView.js';
import type { GhlFieldMapRow } from './leadsView.js';
import type { GhlPipelineRow, GhlStageRow, GhlSyncRunRow } from './overviewView.js';
import type { ConnectorKeyRow, LearnedSourceRow } from './settingsView.js';
import type { AppUserRow } from './usersView.js';

export type { AppUserRow, ConversationListRow, MemoryChunkRow, MemoryFactRow };

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- see WebDatabase */
export type MessageRow = {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  created_at: string;
  /** Milestone 5 part 5: on an assistant row, what reached the model from documents. Parsed, never trusted. */
  document_coverage: unknown;
};

/**
 * Milestone 5 part 5: a learned document, as the browser may see it — its name, for the note
 * under a reply. Part 4 (the settings page) selects the rest of what identifies it: its kind,
 * where it came from, who added it, when it was read, its pages and how far learning has got.
 */
export type KnowledgeSourceRow = Pick<LearnedSourceRow, 'id' | 'name'>;

/**
 * One `audit_log` row as the browser may read it (staff, every row — migration 20260824010500).
 * The settings page selects named keys out of before/after (settingsView.ts ACTIVITY_COLUMNS),
 * never the whole images.
 */
export type AuditLogRow = {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * Read-only view of the schema as the browser sees it — selects only. Rows are type
 * aliases, not interfaces: supabase-js needs index-signature compatibility, and an
 * interface here collapses every query result to `never`.
 */
export type WebDatabase = {
  public: {
    Tables: {
      // Insert/Update are typed only because supabase-js requires the shape; the anon role
      // has no INSERT/UPDATE privilege (migration 20260824010500_rls.sql revokes them).
      app_users: {
        Row: AppUserRow;
        Insert: Partial<AppUserRow>;
        Update: Partial<AppUserRow>;
        Relationships: [];
      };
      conversations: {
        Row: ConversationListRow & { deleted_at: string | null };
        Insert: Partial<ConversationListRow>;
        Update: Partial<ConversationListRow>;
        Relationships: [];
      };
      messages: {
        Row: MessageRow;
        Insert: Partial<MessageRow>;
        Update: Partial<MessageRow>;
        Relationships: [];
      };
      // Milestone 5 part 1: the files attached to a conversation — name, kind, size, page
      // count. Readable by whoever can read the conversation (migration 20261012010000). The
      // TEXT read out of a file is in another table that no browser session can read at all.
      conversation_files: {
        Row: ConversationFileRow;
        Insert: Partial<ConversationFileRow>;
        Update: Partial<ConversationFileRow>;
        Relationships: [];
      };
      // Milestone 5 part 5: learned documents. Readable by active staff for their names (migration
      // 20261017010000); the text is in knowledge_chunks, which no browser session can read.
      knowledge_sources: {
        Row: LearnedSourceRow;
        Insert: Partial<LearnedSourceRow>;
        Update: Partial<LearnedSourceRow>;
        Relationships: [];
      };
      // Milestone 5 part 4: a person's own connector keys — public id, name, state. Never the key
      // and never its digest, which is in a table no browser session can read (20261013010000).
      connector_keys: {
        Row: ConnectorKeyRow & { user_id: string };
        Insert: Partial<ConnectorKeyRow>;
        Update: Partial<ConnectorKeyRow>;
        Relationships: [];
      };
      // Milestone 5 part 4: the activity record. Readable by active staff; written only by the
      // database functions and the server's audit writer.
      audit_log: {
        Row: AuditLogRow;
        Insert: Partial<AuditLogRow>;
        Update: Partial<AuditLogRow>;
        Relationships: [];
      };
      memory_facts: {
        Row: MemoryFactRow;
        Insert: Partial<MemoryFactRow>;
        Update: Partial<MemoryFactRow>;
        Relationships: [];
      };
      memory_chunks: {
        Row: MemoryChunkRow;
        Insert: Partial<MemoryChunkRow>;
        Update: Partial<MemoryChunkRow>;
        Relationships: [];
      };
      // Milestone 4 part 1's mirror of GoHighLevel, read by the overview (part 2). SELECT for
      // active staff and nothing else (migration 20260912010000); refreshed only by the crm
      // endpoint, which holds the service role and the GoHighLevel token.
      ghl_pipelines: {
        Row: GhlPipelineRow;
        Insert: Partial<GhlPipelineRow>;
        Update: Partial<GhlPipelineRow>;
        Relationships: [];
      };
      ghl_stages: {
        Row: GhlStageRow;
        Insert: Partial<GhlStageRow>;
        Update: Partial<GhlStageRow>;
        Relationships: [];
      };
      // Part 4 widened the Row to every column the lead detail reads; the overview and the
      // leads screen still select their subsets.
      ghl_opportunities: {
        Row: GhlOpportunityDetailRow;
        Insert: Partial<GhlOpportunityDetailRow>;
        Update: Partial<GhlOpportunityDetailRow>;
        Relationships: [];
      };
      // Part 3 selects the contact's email, phone and form answers as well as the name the
      // overview selects; one Row type covers both selects.
      ghl_contacts: {
        Row: GhlContactFullRow;
        Insert: Partial<GhlContactFullRow>;
        Update: Partial<GhlContactFullRow>;
        Relationships: [];
      };
      // Part 4: the labels for a contact's custom-field ids, and the notes this app wrote
      // through to GoHighLevel (migration 20260924010000). SELECT for active staff only; every
      // write goes through the crm endpoint.
      ghl_custom_fields: {
        Row: GhlCustomFieldRow;
        Insert: Partial<GhlCustomFieldRow>;
        Update: Partial<GhlCustomFieldRow>;
        Relationships: [];
      };
      ghl_notes: {
        Row: GhlNoteRow;
        Insert: Partial<GhlNoteRow>;
        Update: Partial<GhlNoteRow>;
        Relationships: [];
      };
      // Seeded configuration (migration 20260824010400, seed.sql): which GoHighLevel
      // custom-field id holds `loan_balance` and `current_interest_rate`. Read-only for staff.
      ghl_field_map: {
        Row: GhlFieldMapRow;
        Insert: Partial<GhlFieldMapRow>;
        Update: Partial<GhlFieldMapRow>;
        Relationships: [];
      };
      ghl_sync_runs: {
        Row: GhlSyncRunRow;
        Insert: Partial<GhlSyncRunRow>;
        Update: Partial<GhlSyncRunRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type WebClient = SupabaseClient<WebDatabase>;
