/**
 * The knowledge store in memory (Milestone 5 part 5) — the database's functions from migration
 * 20261017010000, restated in TypeScript, for the two places that cannot reach a database with
 * pgvector: the terminal (`npm run knowledge`, which learns a real document with real Voyage and
 * answers with the real model on this machine) and the unit tests of the drain and of retrieval.
 *
 * It is a STAND-IN, and says so wherever it is used. Its rules are the migration's, line for
 * line: a source is retrievable elsewhere only when ready; the newest ready copy of an address
 * or of the same bytes wins; this conversation's long attachments are searched even while
 * learning; the files that went in whole are not searched again; the caller must be active
 * staff; the search is exact cosine; forgetting takes every copy of the bytes and cannot be
 * undone by a batch in flight; nothing of a document is embedded while its summary is pending;
 * neighbours are passages, never summaries. tests/unit/knowledge/retrieval.test.ts and ingest.test.ts hold it
 * to the same cases as tests/integration/knowledge.test.ts holds the SQL, so a change to one
 * without the other fails somewhere.
 */
import { err, ok, AppError, type Result } from '../errors.js';
import type { FileKind } from '../files/limits.js';
import type { ChunkablePage } from './chunk.js';
import type {
  AttachOutcome,
  BatchChunk,
  ChunkKind,
  ChunkMethod,
  EmbedBatch,
  FileLearning,
  KnowledgeStore,
  MatchedChunk,
  MatchParams,
  NeighbourChunk,
  PassageRow,
  PendingSource,
  SourceStatus,
  SummarySource,
  SummaryStatus,
} from './store.js';

export interface LocalAttachment {
  readonly fileId: string;
  readonly conversationId: string;
  readonly uploadedBy: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly contentHash: string;
  readonly sourceUrl?: string;
  readonly sourceHost?: string;
  /** ISO: a page's fetch time, an upload's ready time. */
  readonly learnedAt: string;
  readonly pages: readonly ChunkablePage[];
}

interface LocalSource {
  id: string;
  fileId: string | null;
  conversationId: string | null;
  kind: FileKind;
  name: string | null;
  contentHash: string | null;
  sourceHost: string | null;
  versionKey: string | null;
  learnedAt: string;
  pageCount: number;
  chunkCount: number;
  embeddedCount: number;
  chunkerVersion: string | null;
  status: SourceStatus;
  summaryStatus: SummaryStatus;
  summaryAttempts: number;
  createdOrder: number;
  readyAt: number | null;
}

interface LocalChunk {
  readonly ordinal: number;
  readonly chunkKind: ChunkKind;
  readonly pageNo: number;
  readonly pageTo: number | null;
  readonly pageLabel: string;
  readonly method: ChunkMethod;
  readonly legibility: NeighbourChunk['legibility'];
  readonly charStart: number;
  readonly charEnd: number;
  readonly content: string;
  readonly section: string | null;
  embedding: readonly number[] | null;
}

function asNeighbour(sourceId: string, c: LocalChunk): NeighbourChunk {
  return {
    sourceId,
    ordinal: c.ordinal,
    chunkKind: c.chunkKind,
    pageNo: c.pageNo,
    pageTo: c.pageTo,
    pageLabel: c.pageLabel,
    method: c.method,
    legibility: c.legibility,
    charStart: c.charStart,
    charEnd: c.charEnd,
    content: c.content,
    section: c.section,
  };
}

export interface LocalKnowledgeStore extends KnowledgeStore {
  /** The trigger on `conversation_files` becoming ready: one pending source. */
  attach(attachment: LocalAttachment): string;
  /** The text of an attachment is purged (30 days, or a day for a page). Knowledge stays. */
  expire(fileId: string): void;
  /** A person removes the file: every copy of its bytes is forgotten. */
  remove(fileId: string): void;
  /** The conversation is deleted: its attachment rows go, the knowledge stays. */
  deleteConversation(conversationId: string): void;
  activate(userId: string, active: boolean): void;
  status(sourceId: string): LocalSourceView | null;
  readonly sources: () => readonly LocalSourceView[];
}

export interface LocalSourceView {
  readonly id: string;
  readonly fileId: string | null;
  readonly status: SourceStatus;
  readonly name: string | null;
  readonly chunkCount: number;
  readonly embeddedCount: number;
  readonly summaryStatus: SummaryStatus;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** (learned_at, id) ordering, as the SQL compares the row pair. */
function newer(a: LocalSource, b: LocalSource): boolean {
  const ta = Date.parse(a.learnedAt);
  const tb = Date.parse(b.learnedAt);
  return ta !== tb ? ta > tb : a.id > b.id;
}

export function createLocalKnowledgeStore(
  options: { readonly activeStaff?: readonly string[]; readonly newId?: () => string } = {},
): LocalKnowledgeStore {
  const sources = new Map<string, LocalSource>();
  const chunks = new Map<string, LocalChunk[]>();
  const files = new Map<string, LocalAttachment & { live: boolean; textGone: boolean }>();
  const staff = new Set(options.activeStaff ?? []);
  let order = 0;
  let lease: { holder: string; until: number } | null = null;
  let cooldownUntil = 0;
  const newId = options.newId ?? (() => crypto.randomUUID());

  const view = (s: LocalSource): LocalSourceView => ({
    id: s.id,
    fileId: s.fileId,
    status: s.status,
    name: s.name,
    chunkCount: s.chunkCount,
    embeddedCount: s.embeddedCount,
    summaryStatus: s.summaryStatus,
  });

  const forget = (sourceId: string | null, hash: string | null): number => {
    let count = 0;
    for (const s of sources.values()) {
      if (s.status === 'forgotten') continue;
      if (s.id !== sourceId && (hash === null || s.contentHash !== hash)) continue;
      chunks.delete(s.id);
      Object.assign(s, {
        status: 'forgotten' as const,
        name: null,
        contentHash: null,
        sourceHost: null,
        versionKey: null,
        chunkCount: 0,
        embeddedCount: 0,
      });
      count += 1;
    }
    return count;
  };

  const store: LocalKnowledgeStore = {
    attach: (a) => {
      files.set(a.fileId, { ...a, live: true, textGone: false });
      const existing = [...sources.values()].find((s) => s.fileId === a.fileId);
      if (existing !== undefined) return existing.id;
      const id = newId();
      order += 1;
      sources.set(id, {
        id,
        fileId: a.fileId,
        conversationId: a.conversationId,
        kind: a.kind,
        name: a.name,
        contentHash: a.contentHash,
        sourceHost: a.sourceHost ?? null,
        versionKey: a.sourceUrl ?? `sha:${a.contentHash}`,
        learnedAt: a.learnedAt,
        pageCount: a.pages.length,
        chunkCount: 0,
        embeddedCount: 0,
        chunkerVersion: null,
        status: 'pending',
        summaryStatus: 'none',
        summaryAttempts: 0,
        createdOrder: order,
        readyAt: null,
      });
      return id;
    },
    expire: (fileId) => {
      const f = files.get(fileId);
      if (f !== undefined) Object.assign(f, { live: false, textGone: true });
    },
    remove: (fileId) => {
      const f = files.get(fileId);
      if (!f?.live) return;
      Object.assign(f, { live: false, textGone: true });
      const source = [...sources.values()].find((s) => s.fileId === fileId);
      forget(source?.id ?? null, f.contentHash);
    },
    deleteConversation: (conversationId) => {
      for (const [id, f] of files) {
        if (f.conversationId !== conversationId) continue;
        files.delete(id);
        for (const s of sources.values()) if (s.fileId === id) s.fileId = null;
      }
    },
    activate: (userId, active) => {
      if (active) staff.add(userId);
      else staff.delete(userId);
    },
    status: (sourceId) => {
      const s = sources.get(sourceId);
      return s === undefined ? null : view(s);
    },
    sources: () => [...sources.values()].sort((a, b) => a.createdOrder - b.createdOrder).map(view),

    sourceForFile: (fileId) => {
      const s = [...sources.values()].find((x) => x.fileId === fileId);
      return Promise.resolve(
        ok(
          s === undefined
            ? null
            : { id: s.id, fileId: s.fileId, name: s.name ?? '', status: s.status },
        ),
      );
    },
    sourcesForFiles: (fileIds) => {
      const out: FileLearning[] = [];
      for (const s of sources.values()) {
        if (s.fileId === null || !fileIds.includes(s.fileId)) continue;
        out.push({
          fileId: s.fileId,
          sourceId: s.id,
          status: s.status,
          chunkCount: s.chunkCount,
          embeddedCount: s.embeddedCount,
        });
      }
      return Promise.resolve(ok(out));
    },
    pendingSources: (limit) => {
      const pending = [...sources.values()]
        .filter((s) => s.status === 'pending')
        .sort((a, b) => a.createdOrder - b.createdOrder)
        .slice(0, limit)
        .map((s): PendingSource => ({ id: s.id, fileId: s.fileId, name: s.name ?? '' }));
      return Promise.resolve(ok(pending));
    },
    copyFromTwin: (sourceId, version) => {
      const s = sources.get(sourceId);
      if (s?.status !== 'pending') return Promise.resolve(ok(false));
      const twin = [...sources.values()]
        .filter(
          (t) =>
            t.status === 'ready' &&
            t.id !== sourceId &&
            t.contentHash === s.contentHash &&
            t.chunkerVersion === version,
        )
        .sort((a, b) => (b.readyAt ?? 0) - (a.readyAt ?? 0))[0];
      if (twin === undefined) return Promise.resolve(ok(false));
      chunks.set(
        sourceId,
        (chunks.get(twin.id) ?? []).map((c) => ({ ...c })),
      );
      Object.assign(s, {
        status: 'ready',
        chunkCount: twin.chunkCount,
        embeddedCount: twin.chunkCount,
        chunkerVersion: version,
        summaryStatus: twin.summaryStatus,
        readyAt: Date.now(),
      });
      return Promise.resolve(ok(true));
    },
    pagesOfFile: (fileId) => {
      const f = files.get(fileId);
      if (f === undefined || !f.live || f.textGone || f.pages.length === 0)
        return Promise.resolve(ok(null));
      return Promise.resolve(ok(f.pages));
    },
    capture: (sourceId, version, captured, summarise) => {
      const s = sources.get(sourceId);
      if (s === undefined) return Promise.resolve(err(new AppError('INTERNAL', 'no such source')));
      if (s.status !== 'pending')
        return Promise.resolve(ok({ status: s.status, chunkCount: s.chunkCount }));
      if (captured.length === 0)
        return Promise.resolve(err(new AppError('HTTP_STATUS', 'needs a chunk')));
      chunks.set(
        sourceId,
        captured.map((c): LocalChunk => ({
          ...c,
          chunkKind: 'passage',
          pageTo: null,
          embedding: null,
        })),
      );
      Object.assign(s, {
        status: 'learning',
        chunkCount: captured.length,
        chunkerVersion: version,
        summaryStatus: summarise ? 'pending' : 'none',
      });
      return Promise.resolve(ok({ status: 'learning' as const, chunkCount: captured.length }));
    },
    fail: (sourceId) => {
      const s = sources.get(sourceId);
      if (s?.status !== 'pending') return Promise.resolve(ok(false));
      s.status = 'failed';
      return Promise.resolve(ok(true));
    },
    summaryPending: (limit) =>
      Promise.resolve(
        ok(
          [...sources.values()]
            .filter(
              (x) => x.status === 'learning' && x.summaryStatus === 'pending' && x.name !== null,
            )
            .sort((a, b) => a.createdOrder - b.createdOrder)
            .slice(0, limit)
            .map((x): SummarySource => ({
              id: x.id,
              name: x.name ?? '',
              kind: x.kind,
              pageCount: x.pageCount,
            })),
        ),
      ),
    passagesOf: (sourceId) =>
      Promise.resolve(
        ok(
          (chunks.get(sourceId) ?? [])
            .filter((c) => c.chunkKind === 'passage')
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((c): PassageRow => ({
              ordinal: c.ordinal,
              pageNo: c.pageNo,
              pageLabel: c.pageLabel,
              charStart: c.charStart,
              charEnd: c.charEnd,
              content: c.content,
              section: c.section,
            })),
        ),
      ),
    addSummaries: (sourceId, summaries) => {
      const s = sources.get(sourceId);
      if (s === undefined) return Promise.resolve(err(new AppError('INTERNAL', 'no such source')));
      if (s.status !== 'learning' || s.summaryStatus !== 'pending') {
        return Promise.resolve(
          ok({ status: s.status, chunkCount: s.chunkCount, summaryStatus: s.summaryStatus }),
        );
      }
      if (summaries.length === 0)
        return Promise.resolve(err(new AppError('HTTP_STATUS', 'needs a summary')));
      const list = chunks.get(sourceId) ?? [];
      const base = s.chunkCount;
      for (const summary of summaries) {
        list.push({
          ordinal: base + summary.position,
          chunkKind: 'summary',
          pageNo: summary.pageNo,
          pageTo: summary.pageTo,
          pageLabel: summary.pageLabel,
          method: 'model_summary',
          legibility: 'full',
          charStart: 0,
          charEnd: summary.content.length,
          content: summary.content,
          section: summary.section,
          embedding: null,
        });
      }
      chunks.set(sourceId, list);
      s.chunkCount = list.length;
      s.summaryStatus = 'done';
      return Promise.resolve(
        ok({ status: s.status, chunkCount: s.chunkCount, summaryStatus: s.summaryStatus }),
      );
    },
    failSummary: (sourceId, maxAttempts) => {
      const s = sources.get(sourceId);
      if (s?.status !== 'learning' || s.summaryStatus !== 'pending')
        return Promise.resolve(ok('unchanged' as const));
      s.summaryAttempts = Math.min(s.summaryAttempts + 1, 20);
      if (s.summaryAttempts >= Math.max(maxAttempts, 1)) s.summaryStatus = 'failed';
      return Promise.resolve(ok(s.summaryStatus));
    },
    summariesOf: (sourceId) => {
      const s = sources.get(sourceId);
      if (s === undefined || (s.status !== 'learning' && s.status !== 'ready'))
        return Promise.resolve(ok([]));
      return Promise.resolve(
        ok(
          (chunks.get(sourceId) ?? [])
            .filter((c) => c.chunkKind === 'summary')
            .sort((a, b) => a.pageNo - b.pageNo || a.ordinal - b.ordinal)
            .map((c) => asNeighbour(sourceId, c)),
        ),
      );
    },
    nextBatch: (maxChars, maxInputs, header) => {
      const s = [...sources.values()]
        .filter((x) => x.status === 'learning' && x.summaryStatus !== 'pending')
        .sort((a, b) => a.createdOrder - b.createdOrder)[0];
      if (s?.name == null) return Promise.resolve(ok(null));
      const name = s.name;
      const waiting = (chunks.get(s.id) ?? [])
        .filter((c) => c.embedding === null)
        .slice(0, maxInputs);
      const picked: BatchChunk[] = [];
      let chars = 0;
      for (const c of waiting) {
        const chunk = {
          ordinal: c.ordinal,
          pageLabel: c.pageLabel,
          section: c.section,
          content: c.content,
        };
        const size = header(name, chunk).length;
        if (picked.length > 0 && chars + size > maxChars) break;
        picked.push(chunk);
        chars += size;
      }
      if (picked.length === 0) return Promise.resolve(ok(null));
      const batch: EmbedBatch = {
        sourceId: s.id,
        sourceName: name,
        chunks: picked,
        waiting: s.chunkCount - s.embeddedCount,
      };
      return Promise.resolve(ok(batch));
    },
    attachEmbeddings: (sourceId, embeddings) => {
      const s = sources.get(sourceId);
      if (s === undefined) return Promise.resolve(err(new AppError('INTERNAL', 'no such source')));
      if (s.status !== 'learning') {
        const outcome: AttachOutcome = {
          status: s.status,
          embeddedCount: s.embeddedCount,
          chunkCount: s.chunkCount,
        };
        return Promise.resolve(ok(outcome));
      }
      const list = chunks.get(sourceId) ?? [];
      for (const e of embeddings) {
        const c = list.find((x) => x.ordinal === e.ordinal);
        if (c?.embedding === null) c.embedding = e.vector;
      }
      s.embeddedCount = list.filter((c) => c.embedding !== null).length;
      if (s.embeddedCount === s.chunkCount) {
        s.status = 'ready';
        s.readyAt = Date.now();
      }
      return Promise.resolve(
        ok({ status: s.status, embeddedCount: s.embeddedCount, chunkCount: s.chunkCount }),
      );
    },
    claimDrain: (holder, leaseSeconds) => {
      const now = Date.now();
      if (cooldownUntil > now)
        return Promise.resolve(ok({ claimed: false, waitMs: cooldownUntil - now }));
      if (lease !== null && lease.until > now && lease.holder !== holder) {
        return Promise.resolve(ok({ claimed: false, waitMs: lease.until - now }));
      }
      lease = { holder, until: now + leaseSeconds * 1_000 };
      return Promise.resolve(ok({ claimed: true, waitMs: 0 }));
    },
    releaseDrain: (holder, _outcome, cooldownSeconds) => {
      if (lease?.holder !== holder) return Promise.resolve(ok(false));
      lease = null;
      if (cooldownSeconds > 0) cooldownUntil = Date.now() + cooldownSeconds * 1_000;
      return Promise.resolve(ok(true));
    },
    forget: (sourceId) => {
      const s = sources.get(sourceId);
      return Promise.resolve(ok(forget(sourceId, s?.contentHash ?? null)));
    },
    match: (query, params: MatchParams) => {
      if (!staff.has(params.userId)) return Promise.resolve(ok([]));
      const all = [...sources.values()];
      const here = all.filter(
        (s) =>
          (s.status === 'learning' || s.status === 'ready') &&
          s.fileId !== null &&
          params.attachedFileIds.includes(s.fileId),
      );
      const whole = params.excludeFileIds
        .map((id) => files.get(id))
        .filter((f): f is NonNullable<typeof f> => f !== undefined)
        .map((f) => ({ hash: f.contentHash, key: f.sourceUrl ?? `sha:${f.contentHash}` }));
      const learned = !params.includeLearned
        ? []
        : all.filter(
            (s) =>
              s.status === 'ready' &&
              !all.some(
                (n) =>
                  n.status === 'ready' &&
                  n.id !== s.id &&
                  (n.versionKey === s.versionKey || n.contentHash === s.contentHash) &&
                  newer(n, s),
              ) &&
              !here.some((a) => a.versionKey === s.versionKey || a.contentHash === s.contentHash) &&
              !whole.some((w) => w.key === s.versionKey || w.hash === s.contentHash) &&
              (s.fileId === null || !params.excludeFileIds.includes(s.fileId)),
          );
      const eligible = [
        ...here.map((s) => ({ s, attached: true })),
        ...learned.map((s) => ({ s, attached: false })),
      ];
      const scored: {
        s: LocalSource;
        attached: boolean;
        c: LocalChunk;
        distance: number;
        named: boolean;
      }[] = [];
      for (const { s, attached } of eligible) {
        for (const c of chunks.get(s.id) ?? []) {
          if (c.embedding === null) continue;
          const similarity = cosineSimilarity(c.embedding, query);
          // A section the question named is taken whatever its similarity, as the SQL does.
          const named =
            c.section?.split(', ').some((label) => params.sections.includes(label)) === true;
          const floor = attached ? params.attachedMinSimilarity : params.minSimilarity;
          if (!named && similarity < floor) continue;
          scored.push({ s, attached, c, distance: 1 - similarity, named });
        }
      }
      scored.sort(
        (a, b) =>
          Number(b.named) - Number(a.named) ||
          a.distance - b.distance ||
          a.s.id.localeCompare(b.s.id) ||
          a.c.ordinal - b.c.ordinal,
      );
      const nearest = scored.slice(0, Math.max(params.limit, 0));
      const out: MatchedChunk[] = [];
      for (const n of nearest) {
        if (n.s.name === null) continue;
        let twin: string | null = null;
        for (const o of nearest) {
          if (o.s.id === n.s.id || Date.parse(o.s.learnedAt) <= Date.parse(n.s.learnedAt)) continue;
          if (
            n.c.embedding !== null &&
            o.c.embedding !== null &&
            1 - cosineSimilarity(o.c.embedding, n.c.embedding) <= 0.06
          ) {
            if (twin === null || Date.parse(o.s.learnedAt) > Date.parse(twin)) twin = o.s.learnedAt;
          }
        }
        out.push({
          sourceId: n.s.id,
          ordinal: n.c.ordinal,
          chunkKind: n.c.chunkKind,
          pageNo: n.c.pageNo,
          pageTo: n.c.pageTo,
          pageLabel: n.c.pageLabel,
          method: n.c.method,
          legibility: n.c.legibility,
          charStart: n.c.charStart,
          charEnd: n.c.charEnd,
          content: n.c.content,
          section: n.c.section,
          similarity: 1 - n.distance,
          attached: n.attached,
          sourceStatus: n.s.status === 'learning' ? 'learning' : 'ready',
          fileId: n.s.fileId,
          conversationId: n.s.conversationId,
          name: n.s.name,
          kind: n.s.kind,
          sourceHost: n.s.sourceHost,
          learnedAt: n.s.learnedAt,
          pageCount: n.s.pageCount,
          chunkCount: n.s.chunkCount,
          embeddedCount: n.s.embeddedCount,
          newerTwinLearnedAt: twin,
          named: n.named,
        });
      }
      return Promise.resolve(ok(out));
    },
    neighbours: (sourceId, ordinals) => {
      const s = sources.get(sourceId);
      if (s === undefined || (s.status !== 'learning' && s.status !== 'ready'))
        return Promise.resolve(ok([]));
      const out: NeighbourChunk[] = (chunks.get(sourceId) ?? [])
        .filter((c) => c.chunkKind === 'passage' && ordinals.includes(c.ordinal))
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => asNeighbour(sourceId, c));
      return Promise.resolve(ok(out));
    },
    anyReady: () => Promise.resolve(ok([...sources.values()].some((s) => s.status === 'ready'))),
    recentNames: (limit) =>
      Promise.resolve(
        ok(
          [...sources.values()]
            .filter((s) => (s.status === 'ready' || s.status === 'learning') && s.name !== null)
            .sort((a, b) => Date.parse(b.learnedAt) - Date.parse(a.learnedAt))
            .slice(0, limit)
            .map((s) => s.name ?? ''),
        ),
      ),
  };
  return store;
}

/** Narrowing helper for tests and the terminal: the store's answer, or throw. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
