/**
 * The knowledge drain's own credential (Milestone 5 part 5). The database's scheduler asks for
 * a drain every minute while a document is waiting to be learned: `pg_cron` runs
 * `dispatch_knowledge_drain()`, which POSTs to the `memory` Edge Function through `pg_net`
 * (migration 20261017010000). That caller is not a person and has no session.
 *
 * The scheme is the GoHighLevel schedule's (D111, src/lib/crm/schedule.ts) with its own secret
 * and its own action name, so neither secret opens the other's door: the secret lives in Vault
 * and in the function's environment and NEVER TRAVELS. The request carries a token — the second
 * it was made and the HMAC-SHA256 of "knowledge-drain:<that second>" — which the function
 * remakes with its own copy, compares in constant time, and refuses beyond two minutes either way.
 * Whoever could read pg_net's queue would hold, for two minutes, the ability to start the same
 * drain under the same lease. That is all.
 *
 * This is the only module that reads KNOWLEDGE_DRAIN_SECRET. Never logged, never returned.
 */

export const DRAIN_SECRET_ENV = 'KNOWLEDGE_DRAIN_SECRET';
export const DRAIN_TOKEN_HEADER = 'x-knowledge-drain-token';
export const DRAIN_ACTION = 'knowledge-drain';
/** 32 random bytes are 43 characters in base64url; anything shorter was not generated. */
export const DRAIN_SECRET_MIN_LENGTH = 32;
export const DRAIN_TOKEN_MAX_SKEW_SECONDS = 120;

type Env = Readonly<Record<string, string | undefined>>;

/** The configured secret, or null when it is unset or too short to be one. */
export function readDrainSecret(env: Env): string | null {
  const value = env[DRAIN_SECRET_ENV]?.trim() ?? '';
  return value.length >= DRAIN_SECRET_MIN_LENGTH ? value : null;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function signature(secret: string, atSeconds: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${DRAIN_ACTION}:${String(atSeconds)}`),
  );
  return toHex(new Uint8Array(signed));
}

/** The token for a second, as `dispatch_knowledge_drain()` makes it with pgcrypto. For tests. */
export async function drainTokenFor(secret: string, atSeconds: number): Promise<string> {
  return `${String(atSeconds)}.${await signature(secret, atSeconds)}`;
}

const TOKEN_SHAPE = /^(\d{1,12})\.([0-9a-f]{64})$/;

export type DrainTokenCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'not_configured' | 'nothing_sent' | 'malformed' | 'stale' | 'mismatch';
    };

/**
 * Is this the token the database would have made, with the secret this function holds, within
 * two minutes of now? An unconfigured function accepts nothing.
 */
export async function checkDrainToken(
  token: string | null | undefined,
  held: string | null | undefined,
  nowMs: number,
): Promise<DrainTokenCheck> {
  if (typeof held !== 'string' || held.length < DRAIN_SECRET_MIN_LENGTH) {
    return { ok: false, reason: 'not_configured' };
  }
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'nothing_sent' };
  const match = TOKEN_SHAPE.exec(token);
  const atText = match?.[1];
  const sent = match?.[2];
  if (atText === undefined || sent === undefined) return { ok: false, reason: 'malformed' };
  const atSeconds = Number(atText);
  if (Math.abs(nowMs / 1_000 - atSeconds) > DRAIN_TOKEN_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = await signature(held, atSeconds);
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= expected.charCodeAt(i) ^ sent.charCodeAt(i);
  }
  return difference === 0 ? { ok: true } : { ok: false, reason: 'mismatch' };
}
