/**
 * One call to the settings endpoint with the freshest session, and the sign-in screen when the
 * server says the session is over — shared by every section of the settings page so none of them
 * handles a 401 differently.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef } from 'react';

import { webConfig } from '../lib/env.js';
import { callSettings, type SettingsOutcome, type SettingsRequest } from '../lib/settingsApi.js';
import { supabase } from '../lib/supabase.js';

export type SettingsCall = (request: SettingsRequest) => Promise<SettingsOutcome>;

export function useSettingsCall(
  session: Session,
  onSessionExpired: () => Promise<void>,
): SettingsCall {
  const latest = useRef(session);
  const expired = useRef(onSessionExpired);
  useEffect(() => {
    latest.current = session;
    expired.current = onSessionExpired;
  }, [session, onSessionExpired]);

  return useCallback(async (request: SettingsRequest): Promise<SettingsOutcome> => {
    const { data } = await supabase.auth.getSession();
    const outcome = await callSettings(
      {
        settingsUrl: webConfig.settingsUrl,
        anonKey: webConfig.anonKey,
        fetch: fetch.bind(globalThis),
      },
      data.session?.access_token ?? latest.current.access_token,
      request,
    );
    if (outcome.kind === 'error' && outcome.failure === 'unauthenticated') {
      await expired.current();
    }
    return outcome;
  }, []);
}
