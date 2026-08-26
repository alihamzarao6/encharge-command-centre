/**
 * The logger knows the Voyage key shape (Stage 3 part 1): redacted by value wherever it
 * appears, and by key name when it travels under `authorization`.
 */
import { describe, expect, it } from 'vitest';

import { REDACTED, redactString, serialiseForLog } from '../../../src/lib/logger.js';
import { FAKE_VOYAGE_KEY } from './helpers.js';

describe('Voyage key redaction', () => {
  it('redacts the pa- shape inside any string', () => {
    expect(redactString(`voyage ${FAKE_VOYAGE_KEY} sent`)).toBe(`voyage ${REDACTED} sent`);
  });

  it('redacts the bearer header value and the authorization key', () => {
    expect(redactString(`Authorization: Bearer ${FAKE_VOYAGE_KEY}`)).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(serialiseForLog({ headers: { authorization: `Bearer ${FAKE_VOYAGE_KEY}` } })).toEqual({
      headers: { authorization: REDACTED },
    });
  });

  it('leaves short pa- words alone (a hyphenated word is not a key)', () => {
    expect(redactString('pa-rent pa-1234')).toBe('pa-rent pa-1234');
  });
});
