/**
 * The browser's Supabase client: anon key + the signed-in user's session. Every read goes
 * through RLS as that user; every write goes through the Edge Function, which holds the
 * service role. The session persists in localStorage (survives a refresh and closing the
 * browser on a phone) and refreshes itself while the tab is open.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { webConfig } from './env.js';
// The two memory row shapes live in memoryView.ts, which imports nothing that touches
// import.meta.env — so the view logic over them is unit-testable under Node. Re-exported
// here because this is where the rest of the app expects a row type to come from.
import type { MemoryChunkRow, MemoryFactRow } from './memoryView.js';

export type { MemoryChunkRow, MemoryFactRow };

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- see WebDatabase */
export type AppUserRow = {
  user_id: string;
  email: string;
  role: string;
  is_active: boolean;
  is_admin: boolean;
};

export type ConversationListRow = {
  id: string;
  title: string | null;
  scope: string;
  user_id: string;
  last_active_at: string;
};

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
