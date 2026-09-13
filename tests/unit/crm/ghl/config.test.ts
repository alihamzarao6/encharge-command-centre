/**
 * GHL configuration (src/lib/crm/ghl/config.ts): the three required values, the defaults,
 * malformed numbers, the folder list, and the rule that an error names the variable and
 * never carries the token.
 */
import { describe, expect, it } from 'vitest';

import { GHL_DEFAULTS, hasGhlToken, loadGhlConfig } from '../../../../src/lib/crm/ghl/config.js';
import { FAKE_GHL_TOKEN, FINANCE_PIPELINE_ID, LOCATION_ID } from './helpers.js';

const REQUIRED = {
  GHL_PRIVATE_INTEGRATION_TOKEN: FAKE_GHL_TOKEN,
  GHL_LOCATION_ID: LOCATION_ID,
  GHL_PIPELINE_ID: FINANCE_PIPELINE_ID,
};

describe('loadGhlConfig', () => {
  it('needs the token, the location and the pipeline id; everything else has a default', () => {
    const result = loadGhlConfig(REQUIRED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      token: FAKE_GHL_TOKEN,
      baseUrl: 'https://services.leadconnectorhq.com',
      apiVersion: '2021-07-28',
      locationId: LOCATION_ID,
      pipelineId: FINANCE_PIPELINE_ID,
      customFieldFolderIds: [],
      timeoutMs: GHL_DEFAULTS.timeoutMs,
      retries: GHL_DEFAULTS.retries,
      pageSize: GHL_DEFAULTS.pageSize,
      maxPages: GHL_DEFAULTS.maxPages,
      maxContactsPerRun: GHL_DEFAULTS.maxContactsPerRun,
      staleRunAfterSeconds: GHL_DEFAULTS.staleRunAfterSeconds,
      rateLimitFloor: GHL_DEFAULTS.rateLimitFloor,
    });
  });

  it.each(['GHL_PRIVATE_INTEGRATION_TOKEN', 'GHL_LOCATION_ID', 'GHL_PIPELINE_ID'])(
    'a missing %s is a CONFIG error naming the variable',
    (name) => {
      const env: Record<string, string | undefined> = { ...REQUIRED, [name]: '   ' };
      const result = loadGhlConfig(env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CONFIG');
      expect(result.error.message).toContain(name);
      expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_GHL_TOKEN);
    },
  );

  it('the pipeline id is mandatory because the read must be scoped (R22, R25)', () => {
    const result = loadGhlConfig({ ...REQUIRED, GHL_PIPELINE_ID: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/exactly one pipeline/);
  });

  it('parses the folder list, trimming and dropping blanks', () => {
    const result = loadGhlConfig({
      ...REQUIRED,
      GHL_CUSTOM_FIELD_FOLDER_IDS: ' BEFyPDjs8dlcpRuz3ZcL , ,fA9zYqgDoZUUN5CKnb5G,',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.customFieldFolderIds).toEqual([
      'BEFyPDjs8dlcpRuz3ZcL',
      'fA9zYqgDoZUUN5CKnb5G',
    ]);
  });

  it('strips a trailing slash from the base URL and refuses a non-https one', () => {
    const ok = loadGhlConfig({ ...REQUIRED, GHL_API_BASE: 'https://ghl.test/' });
    expect(ok.ok && ok.value.baseUrl).toBe('https://ghl.test');
    const bad = loadGhlConfig({ ...REQUIRED, GHL_API_BASE: 'http://ghl.test' });
    expect(bad.ok).toBe(false);
  });

  it.each([
    ['GHL_TIMEOUT_MS', '0'],
    ['GHL_RETRIES', '9'],
    ['GHL_PAGE_SIZE', '101'],
    ['GHL_MAX_PAGES', '0'],
    ['GHL_MAX_CONTACTS_PER_RUN', 'lots'],
    ['GHL_STALE_RUN_AFTER_SECONDS', '5'],
    ['GHL_RATE_LIMIT_FLOOR', '-1'],
  ])('refuses a malformed %s with an error that never contains the token', (name, value) => {
    const result = loadGhlConfig({ ...REQUIRED, [name]: value });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.message).toContain(name);
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_GHL_TOKEN);
  });

  it('hasGhlToken reports presence without reading anything else', () => {
    expect(hasGhlToken({})).toBe(false);
    expect(hasGhlToken({ GHL_PRIVATE_INTEGRATION_TOKEN: ' ' })).toBe(false);
    expect(hasGhlToken({ GHL_PRIVATE_INTEGRATION_TOKEN: FAKE_GHL_TOKEN })).toBe(true);
  });
});
