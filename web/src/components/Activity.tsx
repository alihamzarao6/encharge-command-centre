/**
 * The activity record (Milestone 5 part 4, decision 7): who did what, newest first, from
 * `audit_log` — the trail Milestone 4 part 4 started with lead moves and every later part has
 * written to. Read-only and paged; read under RLS as the signed-in person, by action name, with
 * only named ids and kinds out of each row (settingsData.ts) — never a note's words.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { readActivity, readRoster } from '../lib/settingsData.js';
import {
  ACTIVITY_PAGE_SIZE,
  buildActivityList,
  EMPTY_TEXT,
  SECTION_TEXT,
  type ActivityView,
} from '../lib/settingsView.js';
import { supabase } from '../lib/supabase.js';
import { SettingsPager } from './SettingsPager.js';

interface Props {
  readonly viewerId: string;
  readonly onSessionExpired: () => Promise<void>;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly rows: readonly ActivityView[]; readonly total: number }
  | { readonly kind: 'error' };

export function Activity({ viewerId, onSessionExpired }: Props): ReactElement {
  const [page, setPage] = useState(1);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  // Held by reference: the shell hands a fresh function on every render, and a load that
  // depended on it would run again on every render.
  const expired = useRef(onSessionExpired);
  useEffect(() => {
    expired.current = onSessionExpired;
  }, [onSessionExpired]);

  const refresh = useCallback(
    async (target: number): Promise<void> => {
      setBusy(true);
      const [activity, emailsById] = await Promise.all([
        readActivity(supabase, target, ACTIVITY_PAGE_SIZE),
        readRoster(supabase),
      ]);
      setBusy(false);
      if (activity.kind === 'expired') {
        await expired.current();
        return;
      }
      if (activity.kind === 'unavailable') {
        setLoad({ kind: 'error' });
        return;
      }
      const { rows, total, stageNames, leadNames } = activity.value;
      setLoad({
        kind: 'ready',
        rows: buildActivityList(rows, { emailsById, viewerId, stageNames, leadNames }, Date.now()),
        total,
      });
    },
    [viewerId],
  );

  useEffect(() => {
    void refresh(page);
  }, [page, refresh]);

  return (
    <section
      id="activity"
      className="settings__section"
      aria-labelledby="activity-heading"
      data-testid="settings-activity"
    >
      <h2 id="activity-heading" className="settings__heading">
        Activity
      </h2>
      <p className="settings__intro">{SECTION_TEXT.activityIntro}</p>
      {load.kind === 'loading' && (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="settings__problem" data-testid="activity-error">
          <p>{SECTION_TEXT.unavailable}</p>
          <button type="button" className="button button--small" onClick={() => void refresh(page)}>
            Try again
          </button>
        </div>
      )}
      {load.kind === 'ready' && load.total === 0 && (
        <p className="settings__empty" data-testid="activity-empty">
          {EMPTY_TEXT.activity}
        </p>
      )}
      {load.kind === 'ready' && load.rows.length > 0 && (
        <ol className="activity__list" aria-label="Activity, newest first">
          {load.rows.map((row) => (
            <li key={row.id} className="activity__item" data-testid="activity-row">
              <p className="activity__what">
                <span className="activity__who" dir="auto">
                  {row.who}
                </span>{' '}
                <span dir="auto">{row.what}</span>
              </p>
              <p className="activity__when">
                <time dateTime={row.at}>{row.when}</time>
              </p>
            </li>
          ))}
        </ol>
      )}
      {load.kind === 'ready' && (
        <SettingsPager
          label="Activity"
          page={page}
          size={ACTIVITY_PAGE_SIZE}
          total={load.total}
          shown={load.rows.length}
          busy={busy}
          onPage={setPage}
        />
      )}
    </section>
  );
}
