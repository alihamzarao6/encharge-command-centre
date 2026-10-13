/**
 * The connector's key (MCP connector, stage 1 — docs/MEMORY.md 13 Oct 2026, D102). Pure.
 *
 *   fcc_<12-character id>_<43-character secret>      60 characters
 *
 * The id is PUBLIC: it is what a log line, `npm run connector -- list` and a settings screen
 * show, and how the row is found. The secret is 32 bytes from the platform's random source —
 * 256 bits — written in base64url. Nothing about the key is derived from anything else, so
 * there is nothing to guess and nothing to brute-force.
 *
 * What is stored is the SHA-256 of the whole key, and what crosses to the database on every
 * request is that digest: the key itself never leaves this process, so it cannot appear in
 * a database log or a query statistic. The comparison happens in the database, in constant
 * time (`connector_digest_equal`).
 *
 * The shape is checked here before anything else is, so a token that is not one of ours —
 * a Supabase session token pasted by mistake, an empty string, a megabyte of noise — is
 * refused without a database call.
 */

export const KEY_PREFIX = 'fcc_';
/** Lower-case letters and digits with the look-alikes (i, l, o, 0, 1) left out: 31 symbols. */
export const KEY_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const KEY_ID_LENGTH = 12;
export const KEY_SECRET_BYTES = 32;
/** base64url of 32 bytes, unpadded. */
export const KEY_SECRET_LENGTH = 43;
export const KEY_LENGTH = KEY_PREFIX.length + KEY_ID_LENGTH + 1 + KEY_SECRET_LENGTH;

const KEY_SHAPE = /^fcc_([a-hjkmnp-z2-9]{12})_([A-Za-z0-9_-]{43})$/;
const KEY_ID_SHAPE = /^[a-hjkmnp-z2-9]{12}$/;

export interface ParsedKey {
  /** The public id. Safe to log. */
  readonly keyId: string;
}

/** The public id of a well-formed key, or null. Says nothing about whether it was issued. */
export function parseKey(token: string): ParsedKey | null {
  if (token.length !== KEY_LENGTH) return null;
  const match = KEY_SHAPE.exec(token);
  const keyId = match?.[1];
  return keyId === undefined ? null : { keyId };
}

export function isKeyId(value: string): boolean {
  return KEY_ID_SHAPE.test(value);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of the whole key, as 64 hex characters: what is stored and what is compared. */
export async function digestKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return toHex(new Uint8Array(digest));
}

export type RandomBytes = (length: number) => Uint8Array;

const platformRandom: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/**
 * Twelve symbols chosen evenly. A byte's low five bits give 0–31; 31 is thrown away rather
 * than folded onto another symbol, so no symbol is likelier than another.
 */
function randomKeyId(random: RandomBytes): string {
  let id = '';
  while (id.length < KEY_ID_LENGTH) {
    for (const byte of random(KEY_ID_LENGTH * 2)) {
      const index = byte & 31;
      const symbol = KEY_ID_ALPHABET[index];
      if (symbol === undefined) continue;
      id += symbol;
      if (id.length === KEY_ID_LENGTH) break;
    }
  }
  return id;
}

export interface MintedKey {
  /** The whole key. Shown once to the person it is for, and held nowhere. */
  readonly key: string;
  readonly keyId: string;
  /** What is stored. */
  readonly digestHex: string;
}

export async function mintKey(random: RandomBytes = platformRandom): Promise<MintedKey> {
  const keyId = randomKeyId(random);
  const secret = toBase64Url(random(KEY_SECRET_BYTES));
  const key = `${KEY_PREFIX}${keyId}_${secret}`;
  return { key, keyId, digestHex: await digestKey(key) };
}
