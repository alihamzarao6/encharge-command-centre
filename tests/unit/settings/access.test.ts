/**
 * Who may forget a learned document (Milestone 5 part 4) — the rule both the page and the server
 * use. The database function `forget_document` enforces the same rule under its locks
 * (tests/security/settings.test.ts); this is what decides whether the button is offered at all.
 */
import { describe, expect, it } from 'vitest';

import { LABEL_MAX, MAX_LIVE_KEYS } from '../../../src/lib/connector/keyAdmin.js';
import {
  canForgetDocument,
  FORGET_DENIED_MESSAGES,
  KEY_LABEL_MAX,
  MAX_LIVE_KEYS_PER_PERSON,
} from '../../../src/lib/settings/access.js';

const ME = { userId: 'me', isAdmin: false };
const ADMIN = { userId: 'admin', isAdmin: true };

describe('canForgetDocument', () => {
  it('the person who added it, and every copy of it, may forget it', () => {
    expect(canForgetDocument({ uploadedBy: 'me', copyUploaders: [] }, ME)).toEqual({
      allowed: true,
      because: 'added_every_copy',
    });
    expect(canForgetDocument({ uploadedBy: 'me', copyUploaders: ['me', 'me'] }, ME).allowed).toBe(
      true,
    );
  });

  it('somebody else’s document is not theirs to forget', () => {
    expect(canForgetDocument({ uploadedBy: 'colleague', copyUploaders: [] }, ME)).toEqual({
      allowed: false,
      because: 'not_added',
    });
  });

  it('their own, but a colleague added a copy too (perhaps in a private conversation): not theirs alone', () => {
    expect(canForgetDocument({ uploadedBy: 'me', copyUploaders: ['colleague'] }, ME)).toEqual({
      allowed: false,
      because: 'copy_added_by_someone_else',
    });
  });

  it('a document whose uploader has left the team (null) is an administrator’s to forget', () => {
    expect(canForgetDocument({ uploadedBy: null, copyUploaders: [] }, ME).allowed).toBe(false);
    expect(canForgetDocument({ uploadedBy: 'me', copyUploaders: [null] }, ME).allowed).toBe(false);
    expect(canForgetDocument({ uploadedBy: null, copyUploaders: [null] }, ADMIN).allowed).toBe(
      true,
    );
  });

  it('an administrator may forget anything', () => {
    expect(
      canForgetDocument({ uploadedBy: 'colleague', copyUploaders: ['x', 'y'] }, ADMIN),
    ).toEqual({
      allowed: true,
      because: 'admin',
    });
  });

  it('every refusal has a sentence for the page', () => {
    expect(FORGET_DENIED_MESSAGES.not_added).toMatch(/administrator/);
    expect(FORGET_DENIED_MESSAGES.copy_added_by_someone_else).toMatch(/copy/);
  });
});

describe('the key limits are the database’s', () => {
  it('label length and live keys match what issue_connector_key enforces', () => {
    expect(KEY_LABEL_MAX).toBe(LABEL_MAX);
    expect(MAX_LIVE_KEYS_PER_PERSON).toBe(MAX_LIVE_KEYS);
  });
});
