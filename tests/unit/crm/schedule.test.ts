/**
 * The scheduler's credential and the "what changed" summary (src/lib/crm/schedule.ts).
 *
 * The credential's rule is fail closed: a function with no secret configured accepts
 * nothing, a secret too short to have been generated counts as not configured, and only the
 * exact value is accepted.
 */
import { describe, expect, it } from 'vitest';

import {
  SCHEDULE_SECRET_ENV,
  SCHEDULE_SECRET_HEADER,
  SCHEDULE_SECRET_MIN_LENGTH,
  SCHEDULED_SYNC_ACTION,
  changesOf,
  readScheduleSecret,
  scheduleSecretMatches,
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
    expect(SCHEDULE_SECRET_HEADER).toBe('x-crm-schedule-secret');
    expect(SCHEDULED_SYNC_ACTION).toBe('scheduled-sync');
  });
});

describe('comparing what was sent with what is held', () => {
  it('accepts the exact value', async () => {
    expect(await scheduleSecretMatches(SECRET, SECRET)).toBe(true);
  });

  it('refuses anything else: one character out, a prefix, a longer value, another case', async () => {
    expect(await scheduleSecretMatches(`${SECRET.slice(0, -1)}T`, SECRET)).toBe(false);
    expect(await scheduleSecretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(await scheduleSecretMatches(`${SECRET}S`, SECRET)).toBe(false);
    expect(await scheduleSecretMatches(SECRET.toLowerCase(), SECRET)).toBe(false);
    expect(await scheduleSecretMatches(` ${SECRET}`, SECRET)).toBe(false);
  });

  it('refuses when nothing was sent', async () => {
    expect(await scheduleSecretMatches(null, SECRET)).toBe(false);
    expect(await scheduleSecretMatches(undefined, SECRET)).toBe(false);
    expect(await scheduleSecretMatches('', SECRET)).toBe(false);
  });

  it('a function with no secret accepts nothing — not even nothing', async () => {
    expect(await scheduleSecretMatches('', null)).toBe(false);
    expect(await scheduleSecretMatches(null, null)).toBe(false);
    expect(await scheduleSecretMatches(undefined, undefined)).toBe(false);
    expect(await scheduleSecretMatches('', '')).toBe(false);
    expect(await scheduleSecretMatches(SECRET, null)).toBe(false);
  });

  it('a held value too short to be a secret matches nothing, itself included', async () => {
    const short = 'x'.repeat(SCHEDULE_SECRET_MIN_LENGTH - 1);
    expect(await scheduleSecretMatches(short, short)).toBe(false);
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
