/**
 * Connector keys (Milestone 5 part 4, decision 6): the signed-in person's own keys — made here,
 * listed here, switched off here. `npm run connector` keeps working beside it.
 *
 * THE KEY IS SHOWN ONCE. It arrives in the one reply that made it and is held in this
 * component's state until "Done" — not in storage, not in the address, not in a log, not in the
 * list (the list is `connector_keys`, which has no key and no digest to give). A refresh, a
 * second tab or coming back later shows the key's public id and nothing more, because there is
 * nothing more anywhere to show.
 *
 * Switching a key off takes effect on the connector's very next request: every request reads the
 * key's row inside `connector_call` and nothing caches it.
 */
import type { Session } from '@supabase/supabase-js';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type SyntheticEvent,
} from 'react';

import { KEY_LABEL_MAX, MAX_LIVE_KEYS_PER_PERSON } from '../../../src/lib/settings/access.js';
import { browserClipboardDeps, copyText } from '../lib/clipboard.js';
import { readKeys } from '../lib/settingsData.js';
import {
  buildKeyList,
  EMPTY_TEXT,
  KEY_SHOWN_ONCE_TEXT,
  revokeConfirmText,
  SECTION_TEXT,
  type KeyView,
} from '../lib/settingsView.js';
import { supabase } from '../lib/supabase.js';
import { useSettingsCall } from './useSettingsCall.js';

interface Props {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly keys: readonly KeyView[] }
  | { readonly kind: 'error' };

interface Notice {
  readonly text: string;
  readonly tone: 'ok' | 'problem';
}

interface Revealed {
  readonly key: string;
  readonly keyId: string;
  readonly label: string;
}

export function ConnectorKeys({ session, onSessionExpired }: Props): ReactElement {
  const call = useSettingsCall(session, onSessionExpired);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [label, setLabel] = useState('');
  // 'create' while a key is being made, else the public id of the key being switched off.
  const [busy, setBusy] = useState<
    { readonly what: 'create' } | { readonly what: 'revoke'; readonly keyId: string } | null
  >(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const revealHeading = useRef<HTMLHeadingElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Set by an action whose button is gone or changed: the result takes focus once it is on screen.
  const focusNotice = useRef(false);
  const expired = useRef(onSessionExpired);
  useEffect(() => {
    expired.current = onSessionExpired;
  }, [onSessionExpired]);
  useEffect(() => {
    if (notice !== null && focusNotice.current) {
      focusNotice.current = false;
      noticeRef.current?.focus();
    }
  }, [notice]);

  const refresh = useCallback(async (): Promise<void> => {
    const keys = await readKeys(supabase);
    if (keys.kind === 'expired') {
      await expired.current();
      return;
    }
    setLoad(
      keys.kind === 'ok'
        ? { kind: 'ready', keys: buildKeyList(keys.value, Date.now()) }
        : { kind: 'error' },
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (revealed !== null) revealHeading.current?.focus();
  }, [revealed]);

  useEffect(() => {
    if (confirming !== null) keepButton.current?.focus();
  }, [confirming]);

  const keys = load.kind === 'ready' ? load.keys : [];
  const live = keys.filter((key) => key.on).length;
  const full = live >= MAX_LIVE_KEYS_PER_PERSON;

  async function create(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null) return;
    setBusy({ what: 'create' });
    setNotice(null);
    setCopied(null);
    const outcome = await call({ action: 'create_key', label });
    setBusy(null);
    if (outcome.kind === 'ok' && outcome.reply.action === 'create_key') {
      setLabel('');
      setRevealed({
        key: outcome.reply.key,
        keyId: outcome.reply.keyId,
        label: outcome.reply.label,
      });
    } else if (outcome.kind === 'error' && outcome.failure !== 'unauthenticated') {
      setNotice({ tone: 'problem', text: outcome.message });
      focusNotice.current = true;
    }
    await refresh();
  }

  function done(): void {
    const id = revealed?.keyId ?? null;
    setRevealed(null);
    setCopied(null);
    setNotice({
      tone: 'ok',
      text: 'The key is no longer on screen. Its name and id stay in the list below.',
    });
    window.requestAnimationFrame(() => {
      (id === null ? null : document.getElementById(`revoke-${id}`))?.focus();
    });
  }

  async function revoke(key: KeyView): Promise<void> {
    setConfirming(null);
    setBusy({ what: 'revoke', keyId: key.keyId });
    setNotice(null);
    const outcome = await call({ action: 'revoke_key', keyId: key.keyId });
    setBusy(null);
    if (outcome.kind === 'ok' && outcome.reply.action === 'revoke_key') {
      setNotice({
        tone: 'ok',
        text:
          outcome.reply.outcome === 'revoked'
            ? `Switched off: “${key.label}”. Anything using it is refused from now on.`
            : `“${key.label}” was already switched off.`,
      });
    } else if (outcome.kind === 'error') {
      if (outcome.failure === 'unauthenticated') return;
      setNotice({ tone: 'problem', text: outcome.message });
    }
    focusNotice.current = true;
    await refresh();
  }

  return (
    <section
      id="keys"
      className="settings__section"
      aria-labelledby="keys-heading"
      data-testid="settings-keys"
    >
      <h2 id="keys-heading" className="settings__heading">
        Connector keys
      </h2>
      <p className="settings__intro">{SECTION_TEXT.keysIntro}</p>
      <div
        aria-live="polite"
        aria-atomic="true"
        tabIndex={-1}
        ref={noticeRef}
        className="settings__live"
      >
        {notice !== null && (
          <p
            className={`settings__notice settings__notice--${notice.tone}`}
            data-testid="keys-notice"
          >
            {notice.text}
          </p>
        )}
      </div>

      {revealed !== null && (
        <div
          className="keys__reveal"
          role="group"
          aria-labelledby="key-reveal-heading"
          data-testid="key-reveal"
        >
          <h3
            id="key-reveal-heading"
            className="keys__reveal-heading"
            tabIndex={-1}
            ref={revealHeading}
          >
            Your new key: “{revealed.label}”
          </h3>
          <p>{KEY_SHOWN_ONCE_TEXT}</p>
          <code className="keys__value" data-testid="key-value">
            {revealed.key}
          </code>
          <div className="settings__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                void copyText(browserClipboardDeps(), revealed.key).then((ok) => {
                  setCopied(ok ? 'yes' : 'no');
                });
              }}
            >
              Copy key
            </button>
            <button type="button" className="button" onClick={done}>
              Done — I have copied it
            </button>
          </div>
          <p aria-live="polite" className="keys__copied">
            {copied === 'yes'
              ? 'Copied.'
              : copied === 'no'
                ? "Couldn't copy it automatically — select the key above and copy it."
                : ''}
          </p>
        </div>
      )}

      <form className="keys__form" onSubmit={(event) => void create(event)}>
        <label className="field__label" htmlFor="key-label">
          Name for a new key
        </label>
        <div className="keys__form-row">
          <input
            id="key-label"
            className="field__input keys__input"
            type="text"
            value={label}
            maxLength={KEY_LABEL_MAX}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. Claude on my laptop"
            disabled={full || busy !== null}
            aria-describedby="key-label-hint"
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />
          <button
            type="submit"
            className="button button--primary"
            disabled={full || busy !== null || label.trim() === ''}
          >
            {busy?.what === 'create' ? 'Making…' : 'Make a key'}
          </button>
        </div>
        <p id="key-label-hint" className="settings__hint">
          {full
            ? `You have ${String(MAX_LIVE_KEYS_PER_PERSON)} keys switched on, the most one person may have. Switch one off to make another.`
            : 'A name you will recognise later — which tool, on which device.'}
        </p>
      </form>

      {load.kind === 'loading' && (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      )}
      {load.kind === 'error' && (
        <div className="settings__problem" data-testid="keys-error">
          <p>{SECTION_TEXT.unavailable}</p>
          <button type="button" className="button button--small" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {load.kind === 'ready' && keys.length === 0 && (
        <p className="settings__empty" data-testid="keys-empty">
          {EMPTY_TEXT.keys}
        </p>
      )}
      {keys.length > 0 && (
        <ul className="keys__list" aria-label="Your connector keys">
          {keys.map((key) => (
            <li
              key={key.keyId}
              className={`keys__item${key.on ? '' : ' keys__item--off'}`}
              data-testid="connector-key"
              data-state={key.on ? 'on' : 'off'}
            >
              <p className="keys__label" dir="auto">
                {key.label} <span className="keys__state">· {key.stateLabel}</span>
              </p>
              <p className="learned__meta">{key.detail}</p>
              {key.on &&
                (confirming === key.keyId ? (
                  <div
                    className="settings__confirm"
                    role="alert"
                    data-testid="revoke-confirm"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setConfirming(null);
                        window.requestAnimationFrame(() => {
                          document.getElementById(`revoke-${key.keyId}`)?.focus();
                        });
                      }
                    }}
                  >
                    <p>{revokeConfirmText(key)}</p>
                    <div className="settings__actions">
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => void revoke(key)}
                      >
                        Switch it off
                      </button>
                      <button
                        type="button"
                        className="button"
                        ref={keepButton}
                        onClick={() => {
                          setConfirming(null);
                          window.requestAnimationFrame(() => {
                            document.getElementById(`revoke-${key.keyId}`)?.focus();
                          });
                        }}
                      >
                        Keep it on
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="settings__actions">
                    <button
                      id={`revoke-${key.keyId}`}
                      type="button"
                      className="button button--small"
                      disabled={busy !== null}
                      aria-label={`Switch off ${key.label}`}
                      onClick={() => {
                        setNotice(null);
                        setConfirming(key.keyId);
                      }}
                    >
                      {busy?.what === 'revoke' && busy.keyId === key.keyId
                        ? 'Switching off…'
                        : 'Switch off'}
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
