/**
 * The scheduler's credential and the "what changed" summary (src/lib/crm/schedule.ts).
 *
 * The credential's rule is fail closed: a function with no secret configured accepts
 * nothing, a secret too short to have been generated counts as not configured, and only a
 * token signed with the exact secret, within two minutes, is accepted. The secret itself is
 * never sent.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SCHEDULE_SECRET_ENV,
  SCHEDULE_SECRET_MIN_LENGTH,
  SCHEDULE_TOKEN_HEADER,
  SCHEDULE_TOKEN_MAX_SKEW_SECONDS,
  SCHEDULED_SYNC_ACTION,
  changesOf,
  checkScheduleToken,
  readScheduleSecret,
  scheduleTokenFor,
} from '../../../src/lib/crm/schedule.js';
import { ZERO_APPLY } from './ghl/helpers.js';

// Fake by construction: a repeated letter, the length of 32 random bytes in base64url.
const SECRET = 'S'.repeat(43);

describe('reading the secret from the environment', () => {
  it('returns it when it is long enough to have been generated', () => {
    expect(readScheduleSecret({ [SCHEDULE_SECRET_ENV]: SECRET })).toBe(SECRET);
    expect(readScheduleSecret({ [SCHEDULE_SECRET_ENV]: `  ${SECRET}\n` })).toBe(SECRET);
  });

  it('unset, blank or too short is "not configured", never a weak secret', () => {
    expect(readScheduleSecret({})).toBeNull();
    expect(readScheduleSecret({ [SCHEDULE_SECRET_ENV]: '' })).toBeNull();
    expect(readScheduleSecret({ [SCHEDULE_SECRET_ENV]: '   ' })).toBeNull();
    expect(
      readScheduleSecret({ [SCHEDULE_SECRET_ENV]: 'x'.repeat(SCHEDULE_SECRET_MIN_LENGTH - 1) }),
    ).toBeNull();
    expect(
      readScheduleSecret({ [SCHEDULE_SECRET_ENV]: 'x'.repeat(SCHEDULE_SECRET_MIN_LENGTH) }),
    ).not.toBeNull();
  });

  it('the names are the ones the migration and the runbook use', () => {
    expect(SCHEDULE_SECRET_ENV).toBe('CRM_SCHEDULE_SECRET');
    expect(SCHEDULE_TOKEN_HEADER).toBe('x-crm-schedule-token');
    expect(SCHEDULED_SYNC_ACTION).toBe('scheduled-sync');
    expect(SCHEDULE_TOKEN_MAX_SKEW_SECONDS).toBe(120);
  });
});

// The database makes the token in SQL (pgcrypto's hmac); this module checks it. Both must be
// plain HMAC-SHA256 over "scheduled-sync:<second>" — checked against Node's own HMAC here, and
// against the database's own token in tests/integration/ghl-schedule.test.ts.
describe('the token the scheduler sends instead of its secret', () => {
  const AT = 1_792_020_180;
  const NOW = AT * 1_000;

  it('is the second and the HMAC-SHA256 of "scheduled-sync:<second>", keyed with the secret', async () => {
    const reference = createHmac('sha256', SECRET)
      .update(`scheduled-sync:${String(AT)}`)
      .digest('hex');
    expect(await scheduleTokenFor(SECRET, AT)).toBe(`${String(AT)}.${reference}`);
  });

  it('holds nothing of the secret', async () => {
    const token = await scheduleTokenFor(SECRET, AT);
    expect(token).not.toContain(SECRET);
    expect(token).not.toContain(SECRET.slice(0, 8));
  });

  it('is accepted with the same secret, within two minutes either way', async () => {
    const token = await scheduleTokenFor(SECRET, AT);
    expect(await checkScheduleToken(token, SECRET, NOW)).toEqual({ ok: true });
    expect(await checkScheduleToken(token, SECRET, NOW + 120_000)).toEqual({ ok: true });
    expect(await checkScheduleToken(token, SECRET, NOW - 120_000)).toEqual({ ok: true });
  });

  it('is refused once it is more than two minutes old, or from more than two minutes ahead', async () => {
    const token = await scheduleTokenFor(SECRET, AT);
    expect(await checkScheduleToken(token, SECRET, NOW + 121_000)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(await checkScheduleToken(token, SECRET, NOW - 121_000)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('is refused when signed with another secret, or when its second was changed', async () => {
    const other = await scheduleTokenFor('T'.repeat(43), AT);
    expect(await checkScheduleToken(other, SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' });
    const signature = (await scheduleTokenFor(SECRET, AT)).split('.')[1] ?? '';
    // A captured signature moved to a fresh second does not verify.
    expect(await checkScheduleToken(`${String(AT + 60)}.${signature}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('anything that is not a token is malformed, and nothing at all is nothing sent', async () => {
    for (const bad of [SECRET, `${String(AT)}.`, `${String(AT)}.XYZ`, `x.${'a'.repeat(64)}`, ' ']) {
      expect(await checkScheduleToken(bad, SECRET, NOW), bad).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
    const upper = (await scheduleTokenFor(SECRET, AT)).toUpperCase();
    expect((await checkScheduleToken(upper, SECRET, NOW)).ok).toBe(false);
    expect(await checkScheduleToken(null, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'nothing_sent',
    });
    expect(await checkScheduleToken(undefined, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'nothing_sent',
    });
    expect(await checkScheduleToken('', SECRET, NOW)).toEqual({
      ok: false,
      reason: 'nothing_sent',
    });
  });

  it('a function with no secret, or one too short to be a secret, accepts nothing', async () => {
    const short = 'x'.repeat(SCHEDULE_SECRET_MIN_LENGTH - 1);
    const token = await scheduleTokenFor(SECRET, AT);
    for (const held of [null, undefined, '', short]) {
      expect(await checkScheduleToken(token, held, NOW)).toEqual({
        ok: false,
        reason: 'not_configured',
      });
    }
  });
});

describe('what a run changed', () => {
  it('nothing moved in GoHighLevel → zero, with every part zero', () => {
    expect(changesOf({ ...ZERO_APPLY, opportunities_unchanged: 9, contacts_unchanged: 9 })).toEqual(
      {
        opportunities: { inserted: 0, updated: 0, removed: 0 },
        contacts: { inserted: 0, updated: 0, removed: 0 },
        stages: { added: 0, updated: 0, removed: 0 },
        customFieldsRemoved: 0,
        total: 0,
      },
    );
  });

  it('counts every row inserted, changed or marked removed, and nothing that stayed', () => {
    const changes = changesOf({
      stages_seen: 10,
      stages_added: 1,
      stages_updated: 2,
      stages_removed: 3,
      opportunities_inserted: 4,
      opportunities_updated: 5,
      opportunities_unchanged: 100,
      opportunities_removed: 6,
      contacts_inserted: 7,
      contacts_updated: 8,
      contacts_unchanged: 200,
      contacts_removed: 9,
      custom_fields_seen: 57,
      custom_fields_removed: 10,
    });
    expect(changes.opportunities).toEqual({ inserted: 4, updated: 5, removed: 6 });
    expect(changes.contacts).toEqual({ inserted: 7, updated: 8, removed: 9 });
    expect(changes.stages).toEqual({ added: 1, updated: 2, removed: 3 });
    expect(changes.customFieldsRemoved).toBe(10);
    expect(changes.total).toBe(55);
  });
});
