import { describe, expect, it } from 'vitest';

import {
  STAFF_PASSWORD_LENGTH,
  generateStaffPassword,
  isInPasswordAlphabet,
} from '../../../src/lib/auth/password.js';

describe('generateStaffPassword', () => {
  it('produces the documented length', () => {
    expect(generateStaffPassword()).toHaveLength(STAFF_PASSWORD_LENGTH);
    expect(STAFF_PASSWORD_LENGTH).toBeGreaterThanOrEqual(24);
  });

  it('stays inside the unambiguous alphabet (no 0/O, 1/l/I, no symbols)', () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generateStaffPassword();
      expect(isInPasswordAlphabet(password)).toBe(true);
      expect(password).not.toMatch(/[0O1lI]/);
      expect(password).toMatch(/^[A-Za-z2-9]+$/);
    }
  });

  it('never repeats across many generations (collision would mean broken randomness)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(generateStaffPassword());
    }
    expect(seen.size).toBe(500);
  });

  it('draws from the whole alphabet, not a biased corner of it', () => {
    // 200 × 24 = 4800 draws over 57 symbols ≈ 84 expected per symbol; requiring ≥ 30
    // distinct symbols only catches gross bias, deliberately loose to stay deterministic.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      for (const ch of generateStaffPassword()) {
        seen.add(ch);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });

  it('isInPasswordAlphabet rejects look-alike characters', () => {
    expect(isInPasswordAlphabet('O0Il1')).toBe(false);
    expect(isInPasswordAlphabet('abc23XYZ')).toBe(true);
  });
});
