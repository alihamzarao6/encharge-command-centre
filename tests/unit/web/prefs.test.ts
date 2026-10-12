/**
 * What one browser remembers about how its person likes the screen arranged
 * (web/src/lib/prefs.ts). It is a convenience, so the rule under test is that nothing here
 * can break the screen: storage that is missing, empty, or throws leaves the default.
 */
import { describe, expect, it } from 'vitest';

import {
  PRIVATE_SECTION_KEY,
  browserPrefs,
  privateSectionOpen,
  rememberPrivateSection,
  type PrefStore,
} from '../../../web/src/lib/prefs.js';

function memory(initial: Record<string, string> = {}): PrefStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const broken: PrefStore = {
  getItem: () => {
    throw new Error('storage is blocked');
  },
  setItem: () => {
    throw new Error('storage is full');
  },
};

describe('the "Private conversations" section — open or folded away', () => {
  it('is open until somebody folds it away, so it is found the first time', () => {
    expect(privateSectionOpen(memory())).toBe(true);
    expect(privateSectionOpen(null)).toBe(true);
  });

  it('stays how it was left', () => {
    const store = memory();
    rememberPrivateSection(store, false);
    expect(store.data.get(PRIVATE_SECTION_KEY)).toBe('closed');
    expect(privateSectionOpen(store)).toBe(false);
    rememberPrivateSection(store, true);
    expect(store.data.get(PRIVATE_SECTION_KEY)).toBe('open');
    expect(privateSectionOpen(store)).toBe(true);
  });

  it('anything else found under the key means open', () => {
    expect(privateSectionOpen(memory({ [PRIVATE_SECTION_KEY]: '' }))).toBe(true);
    expect(privateSectionOpen(memory({ [PRIVATE_SECTION_KEY]: 'CLOSED' }))).toBe(true);
    expect(privateSectionOpen(memory({ [PRIVATE_SECTION_KEY]: '<script>' }))).toBe(true);
  });

  it('storage that throws, or is not there at all, changes nothing and breaks nothing', () => {
    expect(privateSectionOpen(broken)).toBe(true);
    expect(() => {
      rememberPrivateSection(broken, false);
    }).not.toThrow();
    expect(() => {
      rememberPrivateSection(null, false);
    }).not.toThrow();
  });

  it('outside a browser there is no storage to use', () => {
    expect(browserPrefs()).toBeNull();
  });
});
