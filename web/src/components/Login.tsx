import type { Session } from '@supabase/supabase-js';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { LOGIN_MESSAGES, classifyLoginError, validateLoginInput } from '../lib/login.js';
import { supabase } from '../lib/supabase.js';

interface Props {
  readonly notice: string | null;
  readonly onSignedIn: (session: Session) => Promise<void>;
}

export function Login({ notice, onSignedIn }: Props): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (!validateLoginInput(email, password)) {
      setError(LOGIN_MESSAGES.invalid_input);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError !== null) {
        setError(LOGIN_MESSAGES[classifyLoginError(authError)]);
        return;
      }
      await onSignedIn(data.session);
    } catch {
      setError(LOGIN_MESSAGES.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen screen--centre login">
      <form
        className="card login__card"
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true">
            F
          </span>
          <div>
            <div className="brand__name">Fundd</div>
            <div className="brand__sub">Command Centre</div>
          </div>
        </div>
        <h1 className="login__title">Sign in</h1>
        {notice !== null && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <label className="field">
          <span className="field__label">Email</span>
          <input
            className="field__input"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            disabled={busy}
          />
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button button--primary button--block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted login__help">
          Staff accounts are created by an administrator. There is no self-service sign-up.
        </p>
      </form>
    </div>
  );
}
