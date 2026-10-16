/**
 * Drive's configuration (src/lib/drive/config.ts): not set up, set up, or set up wrongly — and
 * a wrong value is named by its VARIABLE, never echoed.
 */
import { describe, expect, it } from 'vitest';

import { loadDriveConfig, parseOrigin } from '../../../src/lib/drive/config.js';
import { toBase64Url } from '../../../src/lib/drive/crypto.js';
import { CLIENT_ID, CLIENT_SECRET } from './helpers.js';

const KEY = toBase64Url(new Uint8Array(32).fill(1));
const BASE = {
  GOOGLE_DRIVE_CLIENT_ID: CLIENT_ID,
  GOOGLE_DRIVE_CLIENT_SECRET: CLIENT_SECRET,
  DRIVE_TOKEN_KEY: KEY,
  CHAT_ALLOWED_ORIGIN: 'https://fundd-command-centre.vercel.app',
  SUPABASE_URL: 'https://mxdfptqdshdgdszizlbo.supabase.co',
};

describe('loadDriveConfig', () => {
  it('none of the three Google values: Drive is simply not set up', async () => {
    expect(await loadDriveConfig({ SUPABASE_URL: BASE.SUPABASE_URL })).toEqual({
      ok: true,
      value: null,
    });
  });

  it('all three: configured, with the callback derived from the project and form_post by default', async () => {
    const config = await loadDriveConfig(BASE);
    expect(config.ok).toBe(true);
    if (!config.ok || config.value === null) return;
    expect(config.value).toMatchObject({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: 'https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/drive/callback',
      responseMode: 'form_post',
      appOrigin: 'https://fundd-command-centre.vercel.app',
    });
  });

  it('takes an explicit callback and query mode', async () => {
    const config = await loadDriveConfig({
      ...BASE,
      DRIVE_REDIRECT_URI: 'http://127.0.0.1:54321/functions/v1/drive/callback',
      DRIVE_RESPONSE_MODE: 'query',
    });
    expect(config.ok && config.value?.redirectUri).toBe(
      'http://127.0.0.1:54321/functions/v1/drive/callback',
    );
    expect(config.ok && config.value?.responseMode).toBe('query');
  });

  it.each([
    ['GOOGLE_DRIVE_CLIENT_ID'],
    ['GOOGLE_DRIVE_CLIENT_SECRET'],
    ['DRIVE_TOKEN_KEY'],
  ] as const)(
    'half set up (no %s) is a configuration error naming what is missing',
    async (missing) => {
      const env: Record<string, string> = { ...BASE };
      env[missing] = '';
      const config = await loadDriveConfig(env);
      expect(config.ok).toBe(false);
      if (!config.ok) expect(config.error.message).toContain(missing);
    },
  );

  it.each([
    ['a client id that is not one', { GOOGLE_DRIVE_CLIENT_ID: 'my-app' }, 'GOOGLE_DRIVE_CLIENT_ID'],
    [
      'a secret with a space',
      { GOOGLE_DRIVE_CLIENT_SECRET: 'has a space in it' },
      'GOOGLE_DRIVE_CLIENT_SECRET',
    ],
    ['a short key', { DRIVE_TOKEN_KEY: toBase64Url(new Uint8Array(8)) }, 'DRIVE_TOKEN_KEY'],
    ['an http app origin', { CHAT_ALLOWED_ORIGIN: 'http://fundd.example' }, 'CHAT_ALLOWED_ORIGIN'],
    [
      'an app origin with a path',
      { CHAT_ALLOWED_ORIGIN: 'https://fundd.example/app' },
      'CHAT_ALLOWED_ORIGIN',
    ],
    ['no app origin', { CHAT_ALLOWED_ORIGIN: '' }, 'CHAT_ALLOWED_ORIGIN'],
    [
      'a callback that is not the callback',
      { DRIVE_REDIRECT_URI: 'https://x.supabase.co/functions/v1/drive' },
      'DRIVE_REDIRECT_URI',
    ],
    [
      'an http callback elsewhere',
      { DRIVE_REDIRECT_URI: 'http://x.example/callback' },
      'DRIVE_REDIRECT_URI',
    ],
    [
      'a callback with a query',
      { DRIVE_REDIRECT_URI: 'https://x.example/callback?a=1' },
      'DRIVE_REDIRECT_URI',
    ],
    ['no project and no callback', { SUPABASE_URL: '' }, 'DRIVE_REDIRECT_URI'],
    ['an unknown response mode', { DRIVE_RESPONSE_MODE: 'fragment' }, 'DRIVE_RESPONSE_MODE'],
  ])('%s is refused by name', async (_name, change, variable) => {
    const config = await loadDriveConfig({ ...BASE, ...change });
    expect(config.ok).toBe(false);
    if (!config.ok) {
      expect(config.error.code).toBe('CONFIG');
      expect(config.error.message).toContain(variable);
      expect(config.error.message).not.toContain(CLIENT_SECRET);
    }
  });
});

describe('parseOrigin', () => {
  it.each([
    ['https://fundd-command-centre.vercel.app', 'https://fundd-command-centre.vercel.app'],
    ['https://fundd-command-centre.vercel.app/', 'https://fundd-command-centre.vercel.app'],
    ['http://localhost:5173', 'http://localhost:5173'],
  ])('%s → %s', (raw, origin) => {
    expect(parseOrigin(raw)).toBe(origin);
  });

  it.each(['not a url', 'ftp://x.example', 'https://u:p@x.example', 'https://x.example/#a', null])(
    'refuses %s',
    (raw) => {
      expect(parseOrigin(raw)).toBeNull();
    },
  );
});
