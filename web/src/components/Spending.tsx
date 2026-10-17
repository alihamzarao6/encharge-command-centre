/**
 * Spending (Milestone 5 part 4, decision 7): the cap, today's spend and the month's — read-only.
 * The numbers come from the settings endpoint, which reads them with the same configuration and
 * the same sums the cap enforces (llm/client.ts); the page never computes a cap of its own.
 * Changing a cap is a later decision and nothing here offers it.
 */
import type { Session } from '@supabase/supabase-js';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import {
  buildSpendView,
  SECTION_TEXT,
  type SpendLine,
  type SpendView,
} from '../lib/settingsView.js';
import { useSettingsCall } from './useSettingsCall.js';

interface Props {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: SpendView }
  | { readonly kind: 'error'; readonly message: string };

function Line({ line }: { readonly line: SpendLine }): ReactElement {
  return (
    <div className={`spend__line spend__line--${line.tone}`} data-testid="spend-line">
      <p className="spend__label">{line.label}</p>
      <meter
        className="spend__meter"
        min={0}
        max={1}
        low={0.5}
        high={0.8}
        optimum={0}
        value={line.fraction}
        aria-label={`${line.label}: ${line.spent} of ${line.cap}`}
      />
      <p className="spend__sentence">{line.sentence}</p>
    </div>
  );
}

export function Spending({ session, onSessionExpired }: Props): ReactElement {
  const call = useSettingsCall(session, onSessionExpired);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const refresh = useCallback(async (): Promise<void> => {
    setLoad({ kind: 'loading' });
    const outcome = await call({ action: 'spend' });
    if (outcome.kind === 'ok' && outcome.reply.action === 'spend') {
      setLoad({ kind: 'ready', view: buildSpendView(outcome.reply, Date.now()) });
    } else if (outcome.kind === 'error' && outcome.failure !== 'unauthenticated') {
      setLoad({ kind: 'error', message: outcome.message });
    }
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section
      id="spending"
      className="settings__section"
      aria-labelledby="spending-heading"
      data-testid="settings-spending"
    >
      <h2 id="spending-heading" className="settings__heading">
        Spending
      </h2>
      <p className="settings__intro">{SECTION_TEXT.spendIntro}</p>
      {load.kind === 'loading' && (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="settings__problem" data-testid="spending-error">
          <p>{load.message}</p>
          <button type="button" className="button button--small" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {load.kind === 'ready' && (
        <>
          <Line line={load.view.today} />
          <Line line={load.view.month} />
          <p className="settings__hint">{load.view.note}</p>
        </>
      )}
    </section>
  );
}
