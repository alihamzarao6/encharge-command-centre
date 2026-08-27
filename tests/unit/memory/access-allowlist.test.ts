/**
 * Found on the part-2 review (27 Aug 2026): the client's own positioning line — "independent
 * broker with access to 40+ lenders" — tripped the part-1 access-claim check ("with access"),
 * costing a retry on the live Meta-ad conversation and, on a second hit, the sentence
 * itself. Access TO lenders, a panel, products or rates is positioning, not permission.
 */
import { describe, expect, it } from 'vitest';

import { accessClaim, stripAccessClaims } from '../../../src/lib/memory/summarise.js';

describe('accessClaim allows access-to-the-market phrasing', () => {
  it.each([
    'The assistant positioned Fundd as an independent broker with access to 40+ lenders who handle the full process.',
    'Independent access to a panel of 40+ lenders was the first pillar in the draft.',
    'The user said the business has access to the whole market, not one bank.',
    'The post emphasised access to products and rates the banks do not offer.',
  ])('passes: %s', (text) => {
    expect(accessClaim(text)).toBeNull();
    expect(stripAccessClaims(text).removed).toBe(0);
  });

  it.each([
    'Mia now has access to the account and may make requests on his behalf.',
    'The user said his assistant has full access.',
    'Sam was given access to approve drafts.',
    'Mia should receive the same treatment as the user for draft requests.',
  ])('still catches: %s', (text) => {
    expect(accessClaim(text)).not.toBeNull();
  });
});
