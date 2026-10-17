/**
 * The browser's Supabase client: anon key + the signed-in user's session. Every read goes
 * through RLS as that user; every write goes through an Edge Function, which holds the
 * service role. Since Stage 3 part 4 that includes the staff roster: `app_users` is
 * readable by any active allowlisted member (migration 20260828010000) and writable by
 * nobody holding this key. The session persists in localStorage (survives a refresh and closing the
 * browser on a phone) and refreshes itself while the tab is open.
 */
import { createClient } from '@supabase/supabase-js';

import type { WebClient, WebDatabase } from './database.js';
import { webConfig } from './env.js';

// Every row type is defined in database.ts and re-exported here, where the rest of the app
// expects a row type to come from.
export type * from './database.js';

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
