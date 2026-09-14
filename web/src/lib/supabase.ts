/**
 * The browser's Supabase client: anon key + the signed-in user's session. Every read goes
 * through RLS as that user; every write goes through an Edge Function, which holds the
 * service role. Since Stage 3 part 4 that includes the staff roster: `app_users` is
 * readable by any active allowlisted member (migration 20260828010000) and writable by
 * nobody holding this key. The session persists in localStorage (survives a refresh and closing the
 * browser on a phone) and refreshes itself while the tab is open.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { webConfig } from './env.js';
// Every row shape lives in the view module that reasons over it — memoryView, usersView,
// conversationsView — none of which import anything that touches import.meta.env, so that
// logic is unit-testable under Node. Re-exported here because this is where the rest of the
// app expects a row type to come from.
import type { ConversationListRow } from './conversationsView.js';
import type { MemoryChunkRow, MemoryFactRow } from './memoryView.js';
import type { GhlContactDetailRow, GhlFieldMapRow } from './leadsView.js';
import type {
  GhlOpportunityRow,
  GhlPipelineRow,
  GhlStageRow,
  GhlSyncRunRow,
} from './overviewView.js';
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
      ghl_opportunities: {
        Row: GhlOpportunityRow;
        Insert: Partial<GhlOpportunityRow>;
        Update: Partial<GhlOpportunityRow>;
        Relationships: [];
      };
      // Part 3 selects the contact's email, phone and form answers as well as the name the
      // overview selects; one Row type covers both selects.
      ghl_contacts: {
        Row: GhlContactDetailRow;
        Insert: Partial<GhlContactDetailRow>;
        Update: Partial<GhlContactDetailRow>;
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

export const supabase: WebClient = createClient<WebDatabase>(
  webConfig.supabaseUrl,
  webConfig.anonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'fundd-command-centre-auth',
    },
  },
);
