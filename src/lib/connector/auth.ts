/**
 * Who is calling the connector (MCP connector, stage 1 — D102). Pure.
 *
 * THE SEAM FOR A SECOND WAY IN. The handler never sees a key: it asks an `Authenticator` to
 * read the request's headers and gets back a `Credential` or a refusal, and every 401 it
 * sends carries the challenge the authenticator supplies. Today there is one authenticator,
 * a bearer key. Grok's connector screen may turn out to want OAuth instead; adding it is a
 * second authenticator (verify an access token, name the grant it belongs to), a second
 * credential kind, and a challenge that points at the protected-resource metadata — the
 * handler, the tools and the rate limit do not change. docs/SECURITY.md says what else that
 * takes outside this file.
 *
 * What is decided here is only whether the header is the right SHAPE. Whether the key was
 * ever issued, is still live and belongs to an active member of staff is decided in the
 * database, in the same transaction as the read (`connector_call`).
 */
import { digestKey, parseKey } from './keys.js';

/** A bearer key, as far as this process ever holds it: its public id and its digest. */
export interface KeyCredential {
  readonly kind: 'key';
  readonly keyId: string;
  readonly digestHex: string;
}

export type Credential = KeyCredential;

export type HeaderRefusal = 'missing' | 'wrong_scheme' | 'empty' | 'malformed';

export type AuthAttempt =
  | { readonly ok: true; readonly credential: Credential }
  | { readonly ok: false; readonly reason: HeaderRefusal };

export interface HeaderReader {
  get(name: string): string | null;
}

export interface Authenticator {
  /** The `WWW-Authenticate` value for a 401 (RFC 6750). */
  challenge(): string;
  authenticate(headers: HeaderReader): Promise<AuthAttempt>;
}

export const BEARER_REALM = 'Fundd Command Centre';

const BEARER = /^bearer(?:\s+(.*))?$/i;

export function bearerKeyAuthenticator(): Authenticator {
  return {
    challenge: () => `Bearer realm="${BEARER_REALM}"`,
    authenticate: async (headers) => {
      const header = headers.get('authorization');
      if (header === null || header.trim() === '') return { ok: false, reason: 'missing' };
      const match = BEARER.exec(header.trim());
      if (match === null) return { ok: false, reason: 'wrong_scheme' };
      const token = (match[1] ?? '').trim();
      if (token === '') return { ok: false, reason: 'empty' };
      const parsed = parseKey(token);
      if (parsed === null) return { ok: false, reason: 'malformed' };
      return {
        ok: true,
        credential: { kind: 'key', keyId: parsed.keyId, digestHex: await digestKey(token) },
      };
    },
  };
}
