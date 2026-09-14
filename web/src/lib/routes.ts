/**
 * The app's routes (Milestone 4 part 2; the leads addresses added in part 3). Pure: a path
 * becomes a section and a section becomes a path, and nothing here touches the window.
 *
 * Until part 2 the app had ONE url. Every path was rewritten to index.html (vercel.json)
 * and the section lived in React state, so a bookmark, a refresh or a link from a message
 * always opened the same screen. Now that the Assistant is no longer that screen it needs an
 * address of its own, and so does everything else — a person who has bookmarked `/` lands on
 * the overview, which is the point of the milestone, and the Assistant is one tap away in the
 * navigation and one address away in the bar.
 *
 * Part 3: the leads screen has three shapes and each has an address — `/leads` (the
 * remembered view), `/leads/board`, `/leads/list` — and every lead has one, `/leads/<id>`,
 * so a deep link opened while signed out lands on that lead once the person is in, and the
 * browser's Back button returns from a lead to the view it was opened from. The two words
 * `board` and `list` are reserved: GoHighLevel ids are 20 alphanumerics and never those.
 *
 * Unknown paths land on the overview rather than a "not found" page: nothing has ever been
 * linked that could now be missing, and a broken-looking page is worse than the right one.
 */
export type SectionId = 'overview' | 'leads' | 'assistant' | 'memory' | 'team';

export const DEFAULT_SECTION: SectionId = 'overview';

const PATHS: Readonly<Record<SectionId, string>> = {
  overview: '/',
  leads: '/leads',
  assistant: '/assistant',
  memory: '/memory',
  team: '/team',
};

export type LeadsView = 'board' | 'list';

export type LeadsRoute =
  | { readonly kind: 'index' }
  | { readonly kind: 'view'; readonly view: LeadsView }
  | { readonly kind: 'lead'; readonly opportunityId: string };

/** What a GoHighLevel id looks like, generously: nothing that could be a path trick. */
const OPPORTUNITY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function pathFor(section: SectionId): string {
  return PATHS[section];
}

export function leadsPath(route: LeadsRoute): string {
  switch (route.kind) {
    case 'index':
      return PATHS.leads;
    case 'view':
      return `${PATHS.leads}/${route.view}`;
    case 'lead':
      return `${PATHS.leads}/${route.opportunityId}`;
  }
}

function clean(pathname: string): string {
  return pathname.trim().replace(/\/+$/, '');
}

/**
 * The leads part of a path, or null when the path is not under /leads. The id keeps its
 * case (GoHighLevel ids are case-sensitive); the view words do not need to.
 */
export function leadsRouteFor(pathname: string): LeadsRoute | null {
  const path = clean(pathname);
  if (path.toLowerCase() === PATHS.leads) return { kind: 'index' };
  if (!path.toLowerCase().startsWith(`${PATHS.leads}/`)) return null;
  const rest = path.slice(PATHS.leads.length + 1);
  if (rest.includes('/')) return null;
  const word = rest.toLowerCase();
  if (word === 'board' || word === 'list') return { kind: 'view', view: word };
  if (OPPORTUNITY_ID.test(rest)) return { kind: 'lead', opportunityId: rest };
  return null;
}

/** Trailing slashes and letter case are forgiven; anything else unknown is the overview. */
export function sectionFor(pathname: string): SectionId {
  const path = clean(pathname).toLowerCase();
  if (path === '' || path === '/') return 'overview';
  for (const id of Object.keys(PATHS) as SectionId[]) {
    if (PATHS[id] === path) return id;
  }
  if (leadsRouteFor(pathname) !== null) return 'leads';
  return DEFAULT_SECTION;
}

/** True when the path names a section exactly, so an app can decide whether to rewrite it. */
export function isCanonicalPath(pathname: string): boolean {
  if (Object.values(PATHS).includes(pathname)) return true;
  const leads = leadsRouteFor(pathname);
  return leads !== null && leadsPath(leads) === pathname;
}
