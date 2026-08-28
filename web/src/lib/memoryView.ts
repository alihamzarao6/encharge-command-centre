/**
 * Turning memory rows into what the page shows. Pure, so the decisions that matter — what
 * counts as live, what counts as forgotten, which history belongs to which note, who is
 * offered a Remove button — are unit-tested without a browser.
 *
 * Nothing here decides anything the server does not decide again: `canRemoveMemory` is the
 * SAME function the memory Edge Function enforces (src/lib/memory/access.ts), imported
 * rather than restated, so the interface can never offer an action the server will refuse
 * and the rule can never drift between the two. Everything else here is presentation.
 *
 * Ids, similarity scores and embeddings are deliberately not part of any view: they are how
 * the thing works, not what the client is being asked to judge. Ids travel only as the
 * argument of a write.
 */
import { canRemoveMemory, type MemoryActor } from '../../../src/lib/memory/access.js';
import { conversationDisplayName } from '../../../src/lib/memory/naming.js';

/**
 * Stage 3 part 3: what the memory page selects. Both tables are read directly under RLS
 * (`scope = 'workspace' or user_id = auth.uid()`, and-ed with the app_users allowlist), the
 * same way conversations and messages are; every CHANGE goes through the memory Edge
 * Function, because `authenticated` holds SELECT and nothing else.
 *
 * `embedding` is deliberately absent: the page never selects it and has no use for it, and
 * a vector on screen is a debugging tool, not a memory the client can act on.
 */
/* eslint-disable @typescript-eslint/consistent-type-definitions --
   Type aliases, not interfaces: these two shapes are used as `Row` types in supabase.ts's
   WebDatabase, and supabase-js matches a schema structurally against Record<string, unknown>,
   which an interface fails (no implicit index signature) — every query result then collapses
   to `never`. Same reason as the block in supabase.ts. */
export type MemoryFactRow = {
  id: string;
  user_id: string;
  scope: string;
  key: string;
  value: string | null;
  /**
   * null = live. Equal to the row's own id = a person forgot it without replacing it.
   * Any other id = a newer value replaced it (append-only with supersede).
   */
  superseded_by: string | null;
  created_at: string;
};

export type MemoryChunkRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  scope: string;
  summary: string;
  audience: string | null;
  created_at: string;
  deleted_at: string | null;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

/**
 * The six categories the extractor may use (D44). Shown as a word a person would use, not
 * as the stored slug — `process:reply-length` is a key, "How it works" is a heading.
 */
export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  writing: 'Writing',
  audience: 'Audience',
  business: 'Business',
  offer: 'Offers',
  process: 'How it works',
  personal: 'About you',
};

export const CATEGORY_ORDER: readonly string[] = [
  'writing',
  'audience',
  'business',
  'offer',
  'process',
  'personal',
];

export function categoryOf(key: string): string {
  return key.split(':')[0] ?? '';
}

export function categoryLabel(key: string): string {
  return CATEGORY_LABELS[categoryOf(key)] ?? 'Note';
}

/** `writing:finance-content-framework` → "Finance content framework". */
export function topicLabel(key: string): string {
  const slug = key.slice(key.indexOf(':') + 1).trim();
  if (slug === '' || !key.includes(':')) return key;
  const words = slug.replace(/-+/g, ' ').trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Australia/Perth',
});

export function formatMemoryDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMAT.format(date);
}

/**
 * Three states, and the whole append-only design is readable from one column:
 *   live      — `superseded_by` is null: this is what the assistant is told;
 *   forgotten — `superseded_by` is the row's OWN id: a person removed it, nothing replaced it;
 *   replaced  — `superseded_by` is another row: a newer value took over.
 */
export type FactState = 'live' | 'forgotten' | 'replaced';

export function factState(row: Pick<MemoryFactRow, 'id' | 'superseded_by'>): FactState {
  if (row.superseded_by === null) return 'live';
  return row.superseded_by === row.id ? 'forgotten' : 'replaced';
}

export interface MemoryFactView {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly topic: string;
  readonly state: FactState;
  readonly statedOn: string;
  readonly byYou: boolean;
  readonly canRemove: boolean;
}

export interface FactLists {
  /** What the assistant is working from right now, newest first. */
  readonly live: readonly MemoryFactView[];
  /** Removed, kept so the removal is visible and can be undone. Newest first. */
  readonly forgotten: readonly MemoryFactView[];
  /** Every value a note has ever held, oldest first, keyed by the note's key. */
  readonly history: Readonly<Record<string, readonly MemoryFactView[]>>;
}

function toFactView(row: MemoryFactRow, actor: MemoryActor): MemoryFactView {
  return {
    id: row.id,
    key: row.key,
    value: row.value ?? '',
    category: categoryOf(row.key),
    categoryLabel: categoryLabel(row.key),
    topic: topicLabel(row.key),
    state: factState(row),
    statedOn: formatMemoryDate(row.created_at),
    byYou: row.user_id === actor.userId,
    canRemove: canRemoveMemory({ authorId: row.user_id }, actor).allowed,
  };
}

/**
 * `rows` is every fact the caller may read, in any state (RLS has already decided which
 * those are). A note with no live row is one somebody forgot; its most recent row is what
 * "Removed notes" shows, and the older ones stay in its history.
 */
export function buildFactLists(rows: readonly MemoryFactRow[], actor: MemoryActor): FactLists {
  const byCreated = [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const live: MemoryFactView[] = [];
  const forgotten: MemoryFactView[] = [];
  const history: Record<string, MemoryFactView[]> = {};
  const liveKeys = new Set(byCreated.filter((r) => r.superseded_by === null).map((r) => r.key));
  const seenForgottenKey = new Set<string>();

  for (const row of byCreated) {
    const view = toFactView(row, actor);
    (history[row.key] ??= []).unshift(view); // oldest first
    if (view.state === 'live') {
      live.push(view);
      continue;
    }
    // Only the newest removed value of a key that has no live row, so a note edited three
    // times and then removed appears once, not four times.
    if (view.state === 'forgotten' && !liveKeys.has(row.key) && !seenForgottenKey.has(row.key)) {
      seenForgottenKey.add(row.key);
      forgotten.push(view);
    }
  }
  return { live, forgotten, history };
}

export interface MemoryChunkView {
  readonly id: string;
  readonly conversationId: string;
  /**
   * The conversation this note came from, named the way the conversations list names it —
   * `ross — Meta ad about offsets` (part 4a). Null when that conversation is gone, so the
   * page can say so instead of showing a dangling name.
   */
  readonly conversationName: string | null;
  readonly audience: string | null;
  readonly summary: string;
  readonly preview: string;
  readonly when: string;
  readonly byYou: boolean;
  readonly canRemove: boolean;
}

export const CHUNK_PREVIEW_CHARS = 150;

/**
 * One line for the list; the whole note is one tap away. Never cuts mid-word, and never
 * leaves the punctuation of the sentence it cut into ("blunter.…" reads like a typo).
 */
export function chunkPreview(summary: string, max = CHUNK_PREVIEW_CHARS): string {
  const text = summary.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** One conversation, as the chunk list needs it: what it is called and who wrote it. */
export interface ChunkSource {
  readonly title: string | null;
  readonly authorEmail: string | null;
}

export function buildChunkList(
  rows: readonly MemoryChunkRow[],
  sources: ReadonlyMap<string, ChunkSource>,
  actor: MemoryActor,
): readonly MemoryChunkView[] {
  return rows
    .filter((row) => row.deleted_at === null)
    .map((row) => {
      const source = sources.get(row.conversation_id);
      return {
        id: row.id,
        conversationId: row.conversation_id,
        conversationName:
          source === undefined ? null : conversationDisplayName(source.title, source.authorEmail),
        audience: row.audience,
        summary: row.summary,
        preview: chunkPreview(row.summary),
        when: formatMemoryDate(row.created_at),
        byYou: row.user_id === actor.userId,
        canRemove: canRemoveMemory({ authorId: row.user_id }, actor).allowed,
      };
    });
}
