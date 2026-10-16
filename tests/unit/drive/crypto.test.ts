/**
 * Sealing (src/lib/drive/crypto.ts, D124): a sealed token opens only with the right key AND
 * for the owner it was sealed for; nothing about the plaintext is visible in the seal; and the
 * key is refused unless it is exactly 32 bytes. PKCE against RFC 7636's own example.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SEALED_FOR,
  fromBase64Url,
  importSealKey,
  open,
  pkceChallenge,
  randomToken,
  seal,
  sha256Hex,
  toBase64Url,
} from '../../../src/lib/drive/crypto.js';

const KEY_A = toBase64Url(new Uint8Array(32).fill(7));
const KEY_B = toBase64Url(new Uint8Array(32).fill(9));
const TOKEN = '1//0gEXAMPLE-refresh-token-that-must-never-be-readable-from-the-database';

async function key(encoded: string): Promise<CryptoKey> {
  const imported = await importSealKey(encoded);
  if (!imported.ok) throw imported.error;
  return imported.value;
}

describe('seal and open', () => {
  it('opens what it sealed, for the same owner', async () => {
    const k = await key(KEY_A);
    const aad = SEALED_FOR.refreshToken('u1', 't1');
    const sealed = await seal(k, TOKEN, aad);
    const opened = await open(k, sealed, aad);
    expect(opened.ok && opened.value).toBe(TOKEN);
  });

  it('never shows the plaintext, and two seals of one token differ (fresh IV)', async () => {
    const k = await key(KEY_A);
    const aad = SEALED_FOR.refreshToken('u1', 't1');
    const one = await seal(k, TOKEN, aad);
    const two = await seal(k, TOKEN, aad);
    expect(one).not.toBe(two);
    for (const sealed of [one, two]) {
      expect(sealed).not.toContain(TOKEN);
      expect(sealed).not.toContain('refresh');
      expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,}$/);
    }
  });

  it('matches the shape the database insists on (drive_connections_sealed_check)', async () => {
    const k = await key(KEY_A);
    const sealed = await seal(k, TOKEN, SEALED_FOR.refreshToken('u1', 't1'));
    // The pattern and the length, as the migration checks them apart (PostgreSQL allows no
    // repetition count over 255 in a pattern).
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed.length).toBeGreaterThanOrEqual(60);
    expect(sealed.length).toBeLessThanOrEqual(8_100);
    // A code and a verifier, as the callback and connect_start seal them.
    const code = await seal(k, 'C'.repeat(73), SEALED_FOR.code('h'));
    expect(code.length).toBeGreaterThanOrEqual(40);
    const verifier = await seal(k, 'V'.repeat(64), SEALED_FOR.verifier('h'));
    expect(verifier.length).toBeGreaterThanOrEqual(60);
    expect(verifier.length).toBeLessThanOrEqual(2_100);
  });

  it('no pattern in the migration asks PostgreSQL for a repetition count over 255', () => {
    const sql = readFileSync(
      new URL('../../../supabase/migrations/20261016010000_drive.sql', import.meta.url),
      'utf8',
    );
    const counts = [...sql.matchAll(/\{(\d+)(?:,(\d+))?\}/g)].map((m) =>
      Math.max(Number(m[1]), Number(m[2] ?? 0)),
    );
    expect(counts.length).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(255);
  });

  it('does not open for another person or another token id (the associated data)', async () => {
    const k = await key(KEY_A);
    const sealed = await seal(k, TOKEN, SEALED_FOR.refreshToken('u1', 't1'));
    expect((await open(k, sealed, SEALED_FOR.refreshToken('u2', 't1'))).ok).toBe(false);
    expect((await open(k, sealed, SEALED_FOR.refreshToken('u1', 't2'))).ok).toBe(false);
    expect((await open(k, sealed, SEALED_FOR.code('anything'))).ok).toBe(false);
  });

  it('does not open with another key', async () => {
    const sealed = await seal(await key(KEY_A), TOKEN, 'x');
    expect((await open(await key(KEY_B), sealed, 'x')).ok).toBe(false);
  });

  it('does not open when any byte of the ciphertext or the IV changes', async () => {
    const k = await key(KEY_A);
    const sealed = await seal(k, TOKEN, 'x');
    const [version, iv, cipher] = sealed.split('.') as [string, string, string];
    // Flip one bit in each byte position, rather than a base64 character: the last character
    // of base64 can be padding bits alone, and changing it may change nothing at all.
    const bytes = fromBase64Url(cipher) ?? new Uint8Array(0);
    expect(bytes.length).toBeGreaterThan(16);
    for (const at of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const flipped = bytes.slice();
      flipped[at] = (flipped[at] ?? 0) ^ 1;
      expect((await open(k, `${version}.${iv}.${toBase64Url(flipped)}`, 'x')).ok).toBe(false);
    }
    const ivBytes = fromBase64Url(iv) ?? new Uint8Array(0);
    ivBytes[0] = (ivBytes[0] ?? 0) ^ 1;
    expect((await open(k, `${version}.${toBase64Url(ivBytes)}.${cipher}`, 'x')).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['wrong version', 'v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['two parts', 'v1.AAAAAAAAAAAAAAAA'],
    ['short IV', 'v1.AAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['not base64url', 'v1.!!!!!!!!!!!!!!!!.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['no tag', 'v1.AAAAAAAAAAAAAAAA.AAAA'],
  ])('refuses a malformed seal (%s) without throwing', async (_name, sealed) => {
    const opened = await open(await key(KEY_A), sealed, 'x');
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.message).toBe('a sealed value did not open');
  });
});

describe('importSealKey', () => {
  it('takes 32 bytes as base64, base64url, padded or not', async () => {
    const raw = new Uint8Array(32).fill(3);
    const standard = btoa(String.fromCharCode(...raw));
    for (const encoded of [standard, standard.replace(/=+$/, ''), toBase64Url(raw)]) {
      expect((await importSealKey(encoded)).ok).toBe(true);
    }
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['16 bytes', toBase64Url(new Uint8Array(16))],
    ['33 bytes', toBase64Url(new Uint8Array(33))],
    ['not base64', 'this is not a key at all'],
  ])('refuses a key that is %s, naming the variable and never the value', async (_n, encoded) => {
    const imported = await importSealKey(encoded);
    expect(imported.ok).toBe(false);
    if (!imported.ok) {
      expect(imported.error.code).toBe('CONFIG');
      expect(imported.error.message).toContain('DRIVE_TOKEN_KEY');
      if (encoded !== undefined && encoded !== '')
        expect(imported.error.message).not.toContain(encoded);
    }
  });
});

describe('randomness, hashing and PKCE', () => {
  it('makes base64url tokens of the asked length, never the same twice', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(randomToken(48)).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it('hashes to lowercase hex', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('computes the S256 challenge of RFC 7636 appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('round-trips base64url and refuses anything else', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 128]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(fromBase64Url('a+b/')).toBeNull();
  });
});
