/**
 * Sealing a Google token so the database never holds a usable one (Milestone 5 part 3a, D124).
 *
 * AES-256-GCM through WebCrypto — present in Node and in the Edge runtime alike, so there is no
 * dependency. The key is 32 random bytes held only in the `drive` function's secrets
 * (`DRIVE_TOKEN_KEY`); the ciphertext is in the database. Neither alone opens anything.
 *
 * Every seal carries ASSOCIATED DATA naming what it belongs to — a person and a token id for a
 * refresh token, a connection attempt for a held code. The tag covers it, so a ciphertext
 * copied into another person's row, or another attempt's, does not open. Nothing here ever
 * returns or logs a plaintext except through `open`, to its caller.
 *
 * Format: `v1.<iv>.<ciphertext and tag>`, both base64url. A fresh 96-bit IV per seal.
 */
import { AppError, ConfigError, err, ok, type Result } from '../errors.js';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The key as the environment holds it: 32 bytes, base64 or base64url, padded or not. */
export async function importSealKey(
  encoded: string | undefined,
): Promise<Result<CryptoKey, ConfigError>> {
  const text = (encoded ?? '').trim().replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const raw = fromBase64Url(text);
  if (raw?.length !== KEY_BYTES) {
    // Says what is wrong with the VARIABLE, never what it holds.
    return err(new ConfigError('DRIVE_TOKEN_KEY must be 32 random bytes, base64-encoded'));
  }
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      raw.slice().buffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    return ok(key);
  } catch {
    return err(new ConfigError('DRIVE_TOKEN_KEY could not be used as an AES-256 key'));
  }
}

const encoder = new TextEncoder();

export async function seal(key: CryptoKey, plaintext: string, associated: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(associated) },
    key,
    encoder.encode(plaintext),
  );
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/**
 * The plaintext, or an error that says only that the seal did not open — never why in a way
 * that would help (wrong key, wrong owner and tampering all look the same to the caller).
 */
export async function open(
  key: CryptoKey,
  sealed: string,
  associated: string,
): Promise<Result<string>> {
  const failed = (): Result<string> => err(new AppError('INTERNAL', 'a sealed value did not open'));
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return failed();
  const iv = fromBase64Url(parts[1] ?? '');
  const cipher = fromBase64Url(parts[2] ?? '');
  if (iv?.length !== IV_BYTES || cipher === null || cipher.length < 17) return failed();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.slice().buffer, additionalData: encoder.encode(associated) },
      key,
      cipher.slice().buffer,
    );
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    return failed();
  }
}

/** What each kind of sealed value belongs to. Changing one of these strands every stored seal. */
export const SEALED_FOR = {
  refreshToken: (userId: string, tokenId: string): string => `drive-refresh:${userId}:${tokenId}`,
  verifier: (stateHash: string): string => `drive-verifier:${stateHash}`,
  code: (stateHash: string): string => `drive-code:${stateHash}`,
} as const;

/** `bytes` random bytes as base64url: a state value, a PKCE verifier. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}
