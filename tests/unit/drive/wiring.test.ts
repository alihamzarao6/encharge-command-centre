/**
 * Production wiring for Drive (src/lib/drive/wiring.ts): not set up is a working endpoint that
 * says so; set up builds the Google client and the store; half set up is a configuration error.
 * Nothing here touches a network: the clients are built, never called.
 */
import { describe, expect, it } from 'vitest';

import { toBase64Url } from '../../../src/lib/drive/crypto.js';
import { createDrivePageDeps } from '../../../src/lib/drive/wiring.js';
import { createLogger } from '../../../src/lib/logger.js';
import { CLIENT_ID, CLIENT_SECRET } from './helpers.js';

const silent = createLogger({ level: 'silent' });
const SUPABASE = {
  SUPABASE_URL: 'https://mxdfptqdshdgdszizlbo.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key-for-tests',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-tests',
};
const DRIVE = {
  GOOGLE_DRIVE_CLIENT_ID: CLIENT_ID,
  GOOGLE_DRIVE_CLIENT_SECRET: CLIENT_SECRET,
  DRIVE_TOKEN_KEY: toBase64Url(new Uint8Array(32).fill(2)),
  CHAT_ALLOWED_ORIGIN: 'https://fundd-command-centre.vercel.app',
};

describe('createDrivePageDeps', () => {
  it('Drive not set up: the endpoint still works, and says so', async () => {
    const deps = await createDrivePageDeps(SUPABASE, silent);
    expect(deps.ok && deps.value.drive).toBeNull();
  });

  it('Drive set up: the Google client and the store are built', async () => {
    const deps = await createDrivePageDeps({ ...SUPABASE, ...DRIVE }, silent, {
      fetch: () => Promise.reject(new Error('no network in a unit test')),
    });
    expect(deps.ok).toBe(true);
    if (deps.ok && deps.value.drive !== null) {
      expect(deps.value.drive.config.redirectUri).toBe(
        'https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/drive/callback',
      );
      expect(typeof deps.value.drive.google.authorizeUrl).toBe('function');
      expect(typeof deps.value.drive.store.getConnection).toBe('function');
    }
  });

  it('builds with the shared HTTP client when no fetch is given', async () => {
    const one = await createDrivePageDeps({ ...SUPABASE, ...DRIVE }, silent);
    const two = await createDrivePageDeps({ ...SUPABASE, ...DRIVE }, silent);
    expect(one.ok && two.ok).toBe(true);
  });

  it('half set up is a configuration error naming the variable', async () => {
    const deps = await createDrivePageDeps(
      { ...SUPABASE, GOOGLE_DRIVE_CLIENT_ID: CLIENT_ID },
      silent,
    );
    expect(deps.ok).toBe(false);
    if (!deps.ok) expect(deps.error.message).toContain('GOOGLE_DRIVE_CLIENT_SECRET');
  });

  it('no Supabase configuration is a configuration error before anything else', async () => {
    const deps = await createDrivePageDeps(DRIVE, silent);
    expect(deps.ok).toBe(false);
  });
});
