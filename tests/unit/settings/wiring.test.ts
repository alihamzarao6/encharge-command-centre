/**
 * The settings endpoint's wiring (Milestone 5 part 4): narrow on purpose — forgetting and keys
 * must keep working when the model's configuration is broken; only the spend says so.
 */
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../../src/lib/logger.js';
import { createSettingsPageDeps } from '../../../src/lib/settings/wiring.js';

const SUPABASE = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
};
const log = createLogger({ level: 'silent' });

describe('createSettingsPageDeps', () => {
  it('without the project it is a configuration error naming the variable', () => {
    const deps = createSettingsPageDeps({}, log);
    expect(deps.ok).toBe(false);
    if (!deps.ok) expect(deps.error.code).toBe('CONFIG');
  });

  it('with the cap configured, the spend reads the same caps the chat enforces', () => {
    const deps = createSettingsPageDeps(
      {
        ...SUPABASE,
        ANTHROPIC_API_KEY: 'test-key-not-real',
        ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
        ANTHROPIC_MONTHLY_SPEND_CAP_USD: '80',
      },
      log,
    );
    expect(deps.ok).toBe(true);
    if (deps.ok) {
      expect(deps.value.caps).toEqual({
        ok: true,
        value: { dailyUsd: 5, monthlyUsd: 80, warnFraction: 0.8 },
      });
    }
  });

  it('with no model configuration it still wires — only the spend is unavailable', () => {
    const deps = createSettingsPageDeps(SUPABASE, log);
    expect(deps.ok).toBe(true);
    if (deps.ok) expect(deps.value.caps.ok).toBe(false);
  });
});
