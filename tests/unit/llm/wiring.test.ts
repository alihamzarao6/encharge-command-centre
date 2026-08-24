/**
 * createChatDeps: the one place the environment becomes dependencies. Asserts that a
 * missing variable is a CONFIG error naming the variable (never its value), and that a
 * complete environment produces a wired ChatDeps without touching the network.
 */
import { describe, expect, it } from 'vitest';

import { createChatDeps } from '../../../src/lib/llm/wiring.js';
import { FAKE_KEY, capturingLogger } from './helpers.js';

const FULL_ENV = {
  SUPABASE_URL: 'http://stack.test',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-value',
  ANTHROPIC_API_KEY: FAKE_KEY,
  ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
  ANTHROPIC_MONTHLY_SPEND_CAP_USD: '50',
};

describe('createChatDeps', () => {
  it('refuses an incomplete Supabase environment, naming the missing variable only', () => {
    const { log } = capturingLogger();
    const result = createChatDeps({ ...FULL_ENV, SUPABASE_SERVICE_ROLE_KEY: '' }, log);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.context['missing']).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
    expect(JSON.stringify(result.error.toJSON())).not.toContain('service-role-value');
  });

  it('refuses a missing Anthropic cap with a CONFIG error that never contains the key', () => {
    const { log } = capturingLogger();
    const result = createChatDeps({ ...FULL_ENV, ANTHROPIC_MONTHLY_SPEND_CAP_USD: '' }, log);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('CONFIG');
    expect(result.error.message).toContain('ANTHROPIC_MONTHLY_SPEND_CAP_USD');
    expect(JSON.stringify(result.error.toJSON())).not.toContain(FAKE_KEY);
  });

  it('wires verify, claude and conversations from a complete environment', () => {
    const { log, lines } = capturingLogger();
    const result = createChatDeps(FULL_ENV, log);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.value.verify.getUserFromToken).toBe('function');
    expect(typeof result.value.claude.complete).toBe('function');
    expect(typeof result.value.conversations.appendTurn).toBe('function');
    expect(result.value.log).toBe(log);
    // Construction is silent and secret-free.
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
    expect(JSON.stringify(result.value)).not.toContain(FAKE_KEY);
  });
});
