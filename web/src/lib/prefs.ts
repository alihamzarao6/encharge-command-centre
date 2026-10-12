/**
 * Small things one person's browser remembers about how they like the screen arranged.
 * Never data: nothing here is read by the server, shared with anyone, or missed if it is
 * gone. Storage can be unavailable (a private window, blocked site data) and can throw on
 * read as well as on write, so every access is guarded and the screen works without it.
 */

/** The slice of `localStorage` this needs. */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PRIVATE_SECTION_KEY = 'fundd-command-centre-private-section';

/** This browser's own storage, or null where there is none to use. */
export function browserPrefs(): PrefStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Is the administrator's "Private conversations" section open? Open until the person folds
 * it away, so it is found the first time; after that it stays how they left it.
 */
export function privateSectionOpen(store: PrefStore | null): boolean {
  try {
    return store?.getItem(PRIVATE_SECTION_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function rememberPrivateSection(store: PrefStore | null, open: boolean): void {
  try {
    store?.setItem(PRIVATE_SECTION_KEY, open ? 'open' : 'closed');
  } catch {
    // Not remembered. The section still opens and closes for as long as the page is open.
  }
}
