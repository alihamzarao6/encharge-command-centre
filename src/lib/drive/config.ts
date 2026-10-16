/**
 * Configuration for Google Drive (Milestone 5 part 3a) — read from the SERVER environment of
 * the `drive` function. Nothing here ever reaches a browser.
 *
 * Three states, kept apart on purpose:
 *   - none of the three Google values set → Drive is NOT SET UP (null). The page says so in a
 *     sentence; it is the honest state of a Command Centre before the OAuth client exists.
 *   - all three set and well formed → configured.
 *   - anything in between, or a malformed value → a CONFIG error that names the VARIABLE,
 *     never its value: somebody set it, and got it wrong.
 */
import { ConfigError, err, ok, type Result } from '../errors.js';
import { importSealKey } from './crypto.js';

export interface DriveConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Opens the sealed tokens; held only in this function's secrets (D124). */
  readonly sealKey: CryptoKey;
  /** The `drive` function's `/callback`, exactly as registered on the OAuth client. */
  readonly redirectUri: string;
  readonly responseMode: 'form_post' | 'query';
  /** The app, where a person lands back after Google. */
  readonly appOrigin: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET = /^[\x21-\x7E]{10,200}$/;

function present(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

/** An https origin, or http on this machine for a developer's stack. No path, no query. */
export function parseOrigin(raw: string | null): string | null {
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

export async function loadDriveConfig(env: Env): Promise<Result<DriveConfig | null, ConfigError>> {
  const clientId = present(env, 'GOOGLE_DRIVE_CLIENT_ID');
  const clientSecret = present(env, 'GOOGLE_DRIVE_CLIENT_SECRET');
  const key = present(env, 'DRIVE_TOKEN_KEY');
  if (clientId === null && clientSecret === null && key === null) return ok(null);
  if (clientId === null || clientSecret === null || key === null) {
    const missing = [
      clientId === null ? 'GOOGLE_DRIVE_CLIENT_ID' : null,
      clientSecret === null ? 'GOOGLE_DRIVE_CLIENT_SECRET' : null,
      key === null ? 'DRIVE_TOKEN_KEY' : null,
    ].filter((name): name is string => name !== null);
    return err(
      new ConfigError(`Google Drive is half set up: ${missing.join(', ')} missing`, {
        context: { missing },
      }),
    );
  }
  if (!CLIENT_ID.test(clientId)) {
    return err(new ConfigError('GOOGLE_DRIVE_CLIENT_ID is not a Google OAuth client id'));
  }
  if (!CLIENT_SECRET.test(clientSecret)) {
    return err(new ConfigError('GOOGLE_DRIVE_CLIENT_SECRET is not a Google OAuth client secret'));
  }
  const sealKey = await importSealKey(key);
  if (!sealKey.ok) return sealKey;

  const appOrigin = parseOrigin(present(env, 'CHAT_ALLOWED_ORIGIN'));
  if (appOrigin === null) {
    return err(new ConfigError('CHAT_ALLOWED_ORIGIN must be the app origin (https://…)'));
  }

  const supabaseUrl = present(env, 'SUPABASE_URL');
  const fallbackRedirect =
    supabaseUrl === null ? null : `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/drive/callback`;
  const redirectUri = present(env, 'DRIVE_REDIRECT_URI') ?? fallbackRedirect;
  let redirect: URL | null;
  try {
    redirect = redirectUri === null ? null : new URL(redirectUri);
  } catch {
    redirect = null;
  }
  const localRedirect = redirect?.hostname === 'localhost' || redirect?.hostname === '127.0.0.1';
  if (
    redirect === null ||
    !(redirect.protocol === 'https:' || (redirect.protocol === 'http:' && localRedirect)) ||
    redirect.search !== '' ||
    redirect.hash !== '' ||
    !redirect.pathname.endsWith('/callback')
  ) {
    return err(
      new ConfigError("DRIVE_REDIRECT_URI must be the drive function's https …/callback address"),
    );
  }

  const mode = present(env, 'DRIVE_RESPONSE_MODE');
  if (mode !== null && mode !== 'form_post' && mode !== 'query') {
    return err(new ConfigError('DRIVE_RESPONSE_MODE must be "form_post" or "query"'));
  }

  return ok({
    clientId,
    clientSecret,
    sealKey: sealKey.value,
    redirectUri: redirect.href,
    responseMode: mode === 'query' ? 'query' : 'form_post',
    appOrigin,
  });
}
