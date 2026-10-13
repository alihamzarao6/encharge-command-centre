/**
 * The connector's key and the header it arrives in (MCP connector, stage 1 — D102).
 *
 * No key is written in this file: each is minted when the test runs.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BEARER_REALM, bearerKeyAuthenticator } from '../../../src/lib/connector/auth.js';
import {
  KEY_ID_ALPHABET,
  KEY_ID_LENGTH,
  KEY_LENGTH,
  KEY_PREFIX,
  KEY_SECRET_BYTES,
  KEY_SECRET_LENGTH,
  digestKey,
  isKeyId,
  mintKey,
  parseKey,
  type RandomBytes,
} from '../../../src/lib/connector/keys.js';
import { REDACTED, redactString } from '../../../src/lib/logger.js';

const headers = (
  values: Readonly<Record<string, string>>,
): { get(name: string): string | null } => ({
  get: (name) => values[name.toLowerCase()] ?? null,
});

describe('a minted key', () => {
  it('is the prefix, a 12-character public id, and 43 characters of secret: 60 in all', async () => {
    const minted = await mintKey();
    expect(minted.key).toHaveLength(KEY_LENGTH);
    expect(KEY_LENGTH).toBe(60);
    expect(minted.key.startsWith(`${KEY_PREFIX}${minted.keyId}_`)).toBe(true);
    expect(minted.keyId).toHaveLength(KEY_ID_LENGTH);
    expect(minted.keyId).toMatch(new RegExp('^[' + KEY_ID_ALPHABET + ']{12}$'));
    const secret = minted.key.slice(KEY_PREFIX.length + KEY_ID_LENGTH + 1);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).toHaveLength(KEY_SECRET_LENGTH);
    // 43 base64url characters are exactly 32 bytes: 256 bits.
    expect(Buffer.from(secret, 'base64url')).toHaveLength(KEY_SECRET_BYTES);
  });

  it('what is stored is the SHA-256 of the whole key, and nothing shorter', async () => {
    const minted = await mintKey();
    expect(minted.digestHex).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.digestHex).toBe(createHash('sha256').update(minted.key, 'utf8').digest('hex'));
    expect(await digestKey(minted.key)).toBe(minted.digestHex);
    // One character different is a different digest entirely.
    const other = `${minted.key.slice(0, -1)}${minted.key.endsWith('A') ? 'B' : 'A'}`;
    expect(await digestKey(other)).not.toBe(minted.digestHex);
  });

  it('no two are alike, and the secret is all of the randomness it was given', async () => {
    const many = await Promise.all(Array.from({ length: 200 }, () => mintKey()));
    expect(new Set(many.map((minted) => minted.key)).size).toBe(200);
    expect(new Set(many.map((minted) => minted.keyId)).size).toBe(200);
    expect(new Set(many.map((minted) => minted.digestHex)).size).toBe(200);
    // Given known bytes, the secret is those bytes — nothing derived, nothing truncated.
    const fixed: RandomBytes = (length) =>
      Uint8Array.from({ length }, (_unused, i) => (i * 7 + 3) % 256);
    const a = await mintKey(fixed);
    const b = await mintKey(fixed);
    expect(a.key).toBe(b.key);
    const secret = Buffer.from(a.key.slice(-KEY_SECRET_LENGTH), 'base64url');
    expect([...secret]).toEqual([...fixed(KEY_SECRET_BYTES)]);
  });

  it('the id uses every symbol evenly: a byte that would fall outside the alphabet is thrown away', async () => {
    // Every byte is 31, the one value in 0–31 with no symbol; then a run that has them all.
    let call = 0;
    const skewed: RandomBytes = (length) => {
      call += 1;
      return call === 1
        ? new Uint8Array(length).fill(31)
        : Uint8Array.from({ length }, (_unused, i) => i % 31);
    };
    const minted = await mintKey(skewed);
    expect(minted.keyId).toBe(KEY_ID_ALPHABET.slice(0, KEY_ID_LENGTH));
    expect(KEY_ID_ALPHABET).toHaveLength(31);
    expect(KEY_ID_ALPHABET).not.toMatch(/[ilo01]/);
  });
});

describe('parseKey — is this the shape of one of ours', () => {
  it('a minted key parses to its public id; anything else is not a key', async () => {
    const minted = await mintKey();
    expect(parseKey(minted.key)).toEqual({ keyId: minted.keyId });
    const id = minted.keyId;
    const secret = minted.key.slice(-KEY_SECRET_LENGTH);
    for (const notOne of [
      '',
      'fcc_',
      minted.key.slice(0, -1),
      `${minted.key}A`,
      ` ${minted.key}`,
      minted.key.toUpperCase(),
      `xcc_${id}_${secret}`,
      `fcc_${id}-${secret}`,
      `fcc_${id.slice(0, -1)}i_${secret}`,
      `fcc_${id}_${secret.slice(0, -1)}=`,
      `fcc_${id}_${secret.slice(0, -1)}/`,
      'x'.repeat(KEY_LENGTH),
      'x'.repeat(1_000_000),
    ]) {
      expect(parseKey(notOne), notOne.slice(0, 24)).toBeNull();
    }
    expect(isKeyId(id)).toBe(true);
    expect(isKeyId(minted.key)).toBe(false);
    expect(isKeyId('short')).toBe(false);
  });
});

describe('the bearer header', () => {
  const authenticator = bearerKeyAuthenticator();

  it('a key in the Authorization header becomes its public id and its digest — the key goes no further', async () => {
    const minted = await mintKey();
    for (const value of [
      `Bearer ${minted.key}`,
      `bearer ${minted.key}`,
      `BEARER   ${minted.key}  `,
    ]) {
      const attempt = await authenticator.authenticate(headers({ authorization: value }));
      expect(attempt).toEqual({
        ok: true,
        credential: { kind: 'key', keyId: minted.keyId, digestHex: minted.digestHex },
      });
      expect(JSON.stringify(attempt)).not.toContain(minted.key);
    }
  });

  it('says which way a header is wrong, for the log', async () => {
    const minted = await mintKey();
    const cases: (readonly [Readonly<Record<string, string>>, string])[] = [
      [{}, 'missing'],
      [{ authorization: '' }, 'missing'],
      [{ authorization: '   ' }, 'missing'],
      [{ authorization: 'Bearer' }, 'empty'],
      [{ authorization: 'Bearer   ' }, 'empty'],
      [{ authorization: `Basic ${minted.key}` }, 'wrong_scheme'],
      [{ authorization: minted.key }, 'wrong_scheme'],
      [{ authorization: `Token ${minted.key}` }, 'wrong_scheme'],
      [{ authorization: 'Bearer something-else' }, 'malformed'],
      [{ authorization: `Bearer ${minted.key} ${minted.key}` }, 'malformed'],
      [{ authorization: `Bearer ${minted.key}, Bearer ${minted.key}` }, 'malformed'],
      // A key offered anywhere but the Authorization header is not looked at.
      [{ 'x-api-key': minted.key }, 'missing'],
    ];
    for (const [given, reason] of cases) {
      expect(
        await authenticator.authenticate(headers(given)),
        JSON.stringify(given).slice(0, 40),
      ).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('challenges with the Bearer scheme and a realm, and nothing about the server', () => {
    expect(authenticator.challenge()).toBe(`Bearer realm="${BEARER_REALM}"`);
  });
});

describe('a key that reaches a log line anyway', () => {
  it('is redacted wherever it appears; its public id alone is not', async () => {
    const minted = await mintKey();
    expect(redactString(`key=${minted.key} end`)).toBe(`key=${REDACTED} end`);
    expect(redactString(`https://x.test/mcp?key=${minted.key}`)).not.toContain(
      minted.key.slice(-20),
    );
    expect(redactString(`Authorization: Bearer ${minted.key}`)).not.toContain(
      minted.key.slice(-20),
    );
    expect(redactString(`caller ${minted.keyId}`)).toBe(`caller ${minted.keyId}`);
  });
});
