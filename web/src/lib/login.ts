/**
 * What the login screen says. Three inputs matter to the person typing — wrong password,
 * unknown email, deactivated account — and the first two must read identically: an
 * attacker probing "is this email a staff account?" learns nothing from the difference.
 * A deactivated account is only distinguishable to someone holding its correct password,
 * and that person deserves to be told to call the admin rather than to keep retrying.
 */
export type LoginFailure = 'credentials' | 'deactivated' | 'unavailable' | 'invalid_input';

export const LOGIN_MESSAGES: Readonly<Record<LoginFailure, string>> = {
  credentials: 'The email or password is incorrect.',
  deactivated: 'This account has been deactivated. Contact your administrator.',
  unavailable: "Couldn't reach the sign-in service. Check your connection and try again.",
  invalid_input: 'Enter your email and password.',
};

export interface AuthErrorLike {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly message: string;
}

/** Map a GoTrue sign-in error to one of the three things the screen is allowed to say. */
export function classifyLoginError(error: AuthErrorLike): LoginFailure {
  if (error.code === 'user_banned') return 'deactivated';
  if (error.code === 'invalid_credentials' || error.status === 400) return 'credentials';
  if (error.status !== undefined && error.status >= 400 && error.status < 500) {
    return 'credentials';
  }
  return 'unavailable';
}

export function validateLoginInput(email: string, password: string): boolean {
  return email.trim() !== '' && password !== '';
}
