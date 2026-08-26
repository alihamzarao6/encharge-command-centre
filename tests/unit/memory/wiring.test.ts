/**
 * Wiring of the memory hook (src/lib/llm/wiring.ts, Stage 3 part 1): present with a Voyage
 * key, absent — and loudly so — without one, refused when misconfigured, secret-free.
 */
import { describe, expect, it } from 'vitest';

import { createChatDeps } from '../../../src/lib/llm/wiring.js';
import { FAKE_KEY, capturingLogger } from '../llm/helpers.js';
import { FAKE_VOYAGE_KEY } from './helpers.js';

const BASE_ENV = {
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
  ANTHROPIC_API_KEY: FAKE_KEY,
  ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
  ANTHROPIC_MONTHLY_SPEND_CAP_USD: '50',
};

describe('createChatDeps and the memory hook', () => {
  it('without VOYAGE_API_KEY: no afterTurn, chat still wired, a warning names the variable', () => {
    const { log, lines } = capturingLogger();
    const result = createChatDeps(BASE_ENV, log);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.afterTurn).toBeUndefined();
    expect(typeof result.value.claude.complete).toBe('function');
    expect(
      lines.some((l) => l.includes('memory layer disabled') && l.includes('VOYAGE_API_KEY')),
    ).toBe(true);
  });

  it('with VOYAGE_API_KEY: afterTurn and waitUntil are wired; no key in logs or the object', () => {
    const { log, lines } = capturingLogger();
    const waitUntil = (): void => undefined;
    const result = createChatDeps({ ...BASE_ENV, VOYAGE_API_KEY: FAKE_VOYAGE_KEY }, log, waitUntil);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.afterTurn).toBe('function');
    expect(result.value.waitUntil).toBe(waitUntil);
    expect(lines.join('\n')).not.toContain(FAKE_VOYAGE_KEY);
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
    expect(JSON.stringify(result.value)).not.toContain(FAKE_VOYAGE_KEY);
  });

  it('a present but malformed Voyage cap is a CONFIG error naming the variable, never the key', () => {
    const { log } = capturingLogger();
    const result = createChatDeps(
      { ...BASE_ENV, VOYAGE_API_KEY: FAKE_VOYAGE_KEY, VOYAGE_DAILY_SPEND_CAP_USD: 'lots' },
      log,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.message).toContain('VOYAGE_DAILY_SPEND_CAP_USD');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_VOYAGE_KEY);
  });
});
