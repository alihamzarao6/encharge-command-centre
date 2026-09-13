/**
 * The app's routes (Milestone 4 part 2). Pure: a path becomes a section and a section becomes
 * a path, and nothing here touches the window.
 *
 * Until this part the app had ONE url. Every path was rewritten to index.html (vercel.json)
 * and the section lived in React state, so a bookmark, a refresh or a link from a message
 * always opened the same screen. Now that the Assistant is no longer that screen it needs an
 * address of its own, and so does everything else — a person who has bookmarked `/` lands on
 * the overview, which is the point of the milestone, and the Assistant is one tap away in the
 * navigation and one address away in the bar.
 *
 * Unknown paths land on the overview rather than a "not found" page: nothing has ever been
 * linked that could now be missing, and a broken-looking page is worse than the right one.
 */
export type SectionId = 'overview' | 'assistant' | 'memory' | 'team';

export const DEFAULT_SECTION: SectionId = 'overview';

const PATHS: Readonly<Record<SectionId, string>> = {
  overview: '/',
  assistant: '/assistant',
  memory: '/memory',
  team: '/team',
};

export function pathFor(section: SectionId): string {
  return PATHS[section];
}

/** Trailing slashes and letter case are forgiven; anything else unknown is the overview. */
export function sectionFor(pathname: string): SectionId {
  const clean = pathname.trim().toLowerCase().replace(/\/+$/, '');
  if (clean === '' || clean === '/') return 'overview';
  for (const id of Object.keys(PATHS) as SectionId[]) {
    if (PATHS[id] === clean) return id;
  }
  return DEFAULT_SECTION;
}

/** True when the path names a section exactly, so an app can decide whether to rewrite it. */
export function isCanonicalPath(pathname: string): boolean {
  return Object.values(PATHS).includes(pathname);
}
