/**
 * Session state machine for the whole app.
 *
 *   loading   → the stored session is being read (a refresh on a phone lands here)
 *   signedOut → the login screen, with an optional notice (expired, deactivated)
 *   ready     → a verified, active staff member: the dashboard shell
 *
 * "Verified" means two things, both required: GoTrue accepted the credentials AND the
 * app_users row for that user is readable under RLS (only active allowlisted rows are —
 * migration 20260824010500_rls.sql). A valid Supabase Auth account that is deactivated or
 * simply not on the allowlist gets zero rows here and is signed out with a message, and
 * even if it somehow reached the chat endpoint the server would answer 403 (chat.ts).
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { Login } from './components/Login.js';
import { Shell } from './components/Shell.js';
import { savePending, type PendingDraft } from './lib/draft.js';
import { LOGIN_MESSAGES } from './lib/login.js';
import { MESSAGES } from './lib/chatApi.js';
import { supabase, type AppUserRow } from './lib/supabase.js';

type AppState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'signedOut'; readonly notice: string | null }
  | { readonly kind: 'ready'; readonly session: Session; readonly staff: AppUserRow };

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function verifyStaff(session: Session): Promise<AppUserRow | 'refused' | 'unavailable'> {
  const { data, error } = await supabase
    .from('app_users')
    .select('user_id, email, role, is_active, is_admin, created_at')
    .eq('user_id', session.user.id)
    .limit(1);
  if (error !== null) return 'unavailable';
  const row = data[0];
  if (row?.is_active !== true) return 'refused';
  return row;
}

export function App(): ReactElement {
  const [state, setState] = useState<AppState>({ kind: 'loading' });

  const admit = useCallback(async (session: Session | null): Promise<void> => {
    if (session === null) {
      setState((current) =>
        current.kind === 'signedOut' ? current : { kind: 'signedOut', notice: null },
      );
      return;
    }
    const staff = await verifyStaff(session);
    if (staff === 'refused') {
      await supabase.auth.signOut();
      setState({ kind: 'signedOut', notice: LOGIN_MESSAGES.deactivated });
      return;
    }
    if (staff === 'unavailable') {
      await supabase.auth.signOut();
      setState({ kind: 'signedOut', notice: LOGIN_MESSAGES.unavailable });
      return;
    }
    setState({ kind: 'ready', session, staff });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) void admit(data.session);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setState((current) =>
          current.kind === 'signedOut' ? current : { kind: 'signedOut', notice: null },
        );
      } else if (event === 'TOKEN_REFRESHED' && session !== null) {
        setState((current) => (current.kind === 'ready' ? { ...current, session } : current));
      }
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [admit]);

  const onSignedIn = useCallback(
    async (session: Session): Promise<void> => {
      await admit(session);
    },
    [admit],
  );

  const onSignOut = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut();
    setState({ kind: 'signedOut', notice: null });
  }, []);

  /** The server said 401 mid-conversation: keep the message, go to login, restore after. */
  const onSessionExpired = useCallback(async (pending: PendingDraft | null): Promise<void> => {
    if (pending !== null) savePending(sessionStorageOrNull(), pending);
    await supabase.auth.signOut();
    setState({ kind: 'signedOut', notice: MESSAGES.sessionExpired });
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="screen screen--centre" aria-busy="true">
        <p className="muted">Loading…</p>
      </div>
    );
  }
  if (state.kind === 'signedOut') {
    return <Login notice={state.notice} onSignedIn={onSignedIn} />;
  }
  return (
    <Shell
      session={state.session}
      staff={state.staff}
      onSignOut={onSignOut}
      onSessionExpired={onSessionExpired}
    />
  );
}
