/**
 * One hook for every screen that shows the GoHighLevel mirror (Milestone 4 part 3): the
 * overview and the leads screen read different columns and build different views, but
 * everything around the read is the same and must stay the same — a refresh from either
 * screen behaves identically (Part C), so the behaviour lives once, here:
 *
 *   - the read, with a 401 sending the person to login and a failed re-read keeping whatever
 *     was already on screen (only a first read with nothing to show is the error state);
 *   - the clock: "12 minutes ago" recomputed every minute; every second while a cooldown is
 *     counting down, so the button's re-enabling is never a surprise;
 *   - a re-read when the tab becomes visible, and a 4-second poll while a run is in progress;
 *   - Refresh: the POST to the crm endpoint, the banner for its answer, the re-read after it,
 *     and the cooldown (src/lib/crm/cooldown.ts) computed from the run rows so the
 *     button is disabled BEFORE the server would refuse — and the server's own refusal shown
 *     in its words when the browser did not know (a colleague refreshed a moment ago).
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cooldownRemainingMs } from '../../../src/lib/crm/cooldown.js';
import { callCrm, type CrmOutcome } from '../lib/crmApi.js';
import { webConfig } from '../lib/env.js';
import { formatCount, type SyncState } from '../lib/overviewView.js';
import { supabase } from '../lib/supabase.js';

export type MirrorRead<TInput> =
  | { readonly kind: 'ok'; readonly input: TInput }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'error' };

export interface MirrorViewBase {
  readonly kind: 'not-set-up' | 'ready';
  readonly sync: SyncState;
}

export type Banner = { readonly tone: 'ok' | 'warn'; readonly text: string } | null;

export interface MirrorOptions<TInput, TView extends MirrorViewBase> {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
  readonly read: () => Promise<MirrorRead<TInput>>;
  readonly build: (input: TInput, nowMs: number) => TView;
  /** What the banner says when a read fails: names what could not be read. */
  readonly readFailedMessage: string;
}

export interface Mirror<TView> {
  readonly state: 'loading' | 'ready' | 'error';
  readonly view: TView | null;
  readonly banner: Banner;
  readonly setBanner: (banner: Banner) => void;
  readonly retry: () => void;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  /** Milliseconds until Refresh may be pressed again; 0 when it may. */
  readonly cooldownMs: number;
  /** A run is in progress (from the run rows), so Refresh is disabled and the rows are polled. */
  readonly running: boolean;
}

/** How often the run row is re-read while a refresh is in progress. */
export const POLL_MS = 4_000;
/** How often "x minutes ago" is recomputed while the screen is open. */
export const TICK_MS = 60_000;
/** The cooldown countdown's own tick, only while it is counting. */
const COUNTDOWN_MS = 1_000;

export function refreshBanner(outcome: CrmOutcome): Banner {
  if (outcome.kind === 'ok') {
    const { reply } = outcome;
    if (reply.status === 'partial') {
      return {
        tone: 'warn',
        text: `Refreshed, but ${formatCount(reply.contactsUnread)} contact${reply.contactsUnread === 1 ? '' : 's'} could not be read from GoHighLevel. Their leads are counted; their names may be out of date.`,
      };
    }
    return {
      tone: 'ok',
      text: `Refreshed from GoHighLevel: ${formatCount(reply.opportunitiesFetched)} open lead${reply.opportunitiesFetched === 1 ? '' : 's'} read.`,
    };
  }
  return { tone: 'warn', text: outcome.message };
}

function cooldownOf(sync: SyncState, nowMs: number): number {
  const last = sync.lastRun;
  return cooldownRemainingMs(
    last === null ? null : { started_at: last.startedAt, finished_at: last.finishedAt },
    nowMs,
  );
}

export function useMirror<TInput, TView extends MirrorViewBase>(
  options: MirrorOptions<TInput, TView>,
): Mirror<TView> {
  const { session, onSessionExpired, read, build, readFailedMessage } = options;
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [input, setInput] = useState<TInput | null>(null);
  const [view, setView] = useState<TView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const answer = await read();
    if (!alive.current) return;
    if (answer.kind === 'unauthenticated') {
      await onSessionExpired();
      return;
    }
    if (answer.kind === 'error') {
      // Whatever was on screen stays: a failed re-read must not blank a screen that was fine
      // a second ago. Only a first read with nothing to show is the error state.
      setState((current) => (current === 'ready' ? current : 'error'));
      setBanner({ tone: 'warn', text: readFailedMessage });
      return;
    }
    const at = Date.now();
    setInput(answer.input);
    setView(build(answer.input, at));
    setNow(at);
    setState('ready');
  }, [read, build, onSessionExpired, readFailedMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  // The input is unchanged, the clock is not: rebuild on every tick.
  useEffect(() => {
    if (input !== null) setView(build(input, now));
  }, [input, now, build]);

  const cooldownMs = view === null ? 0 : cooldownOf(view.sync, now);
  const counting = cooldownMs > 0;
  useEffect(() => {
    const timer = setInterval(
      () => {
        setNow(Date.now());
      },
      counting ? COUNTDOWN_MS : TICK_MS,
    );
    return () => {
      clearInterval(timer);
    };
  }, [counting]);

  // Coming back to the tab re-reads: a refresh from elsewhere lands without a tap here.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // While a run is in progress the run row is polled until it is not.
  const running = view?.sync.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running, load]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setBanner(null);
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token ?? session.access_token;
    const outcome = await callCrm(
      { crmUrl: webConfig.crmUrl, anonKey: webConfig.anonKey, fetch: fetch.bind(globalThis) },
      accessToken,
      { action: 'sync' },
    );
    if (!alive.current) return;
    setRefreshing(false);
    if (outcome.kind === 'error' && outcome.failure === 'unauthenticated') {
      await onSessionExpired();
      return;
    }
    setBanner(refreshBanner(outcome));
    // Whatever the answer, the run rows now say what happened; read them back — after a
    // cooldown refusal that is what disables the button for the rest of the window.
    await load();
  }, [load, onSessionExpired, refreshing, session.access_token]);

  const retry = useCallback((): void => {
    setState('loading');
    setBanner(null);
    void load();
  }, [load]);

  return {
    state,
    view,
    banner,
    setBanner,
    retry,
    refreshing,
    refresh: () => {
      void refresh();
    },
    cooldownMs,
    running,
  };
}
