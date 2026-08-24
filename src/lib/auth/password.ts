/**
 * Staff password generation (Stage 2 part 3, FND-220).
 *
 * Every staff password is machine-generated — "admin adds an email, password gets
 * generated, they're in" is the promise on record. The generated value is returned to the
 * caller exactly once, handed to the person out of band, and exists nowhere else: never
 * stored, never logged, never in a table (proven by tests/security/auth.test.ts).
 *
 * Alphabet: letters and digits with the look-alikes removed (no 0/O, 1/l/I) because the
 * password is read aloud or retyped from a phone screen once, then lives in a password
 * manager. No symbols: they add little entropy at this length and break selection-by-
 * double-click and some mobile keyboards. 24 chars over 57 symbols ≈ 140 bits — far past
 * any online-guessing threat, and comfortably above the 12-char floor in config.toml.
 */
import { webcrypto } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export const STAFF_PASSWORD_LENGTH = 24;

/**
 * Cryptographically secure, uniform over ALPHABET (rejection sampling — a plain modulo
 * would bias the low end of the alphabet).
 */
export function generateStaffPassword(): string {
  const out: string[] = [];
  // Largest multiple of ALPHABET.length below 256; bytes at or above it are rejected.
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < STAFF_PASSWORD_LENGTH) {
    const bytes = new Uint8Array(STAFF_PASSWORD_LENGTH * 2);
    webcrypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limit && out.length < STAFF_PASSWORD_LENGTH) {
        out.push(ALPHABET[byte % ALPHABET.length] ?? '');
      }
    }
  }
  return out.join('');
}

/** Exposed for tests only: proves generated passwords stay inside the intended alphabet. */
export function isInPasswordAlphabet(value: string): boolean {
  for (const ch of value) {
    if (!ALPHABET.includes(ch)) {
      return false;
    }
  }
  return true;
}
