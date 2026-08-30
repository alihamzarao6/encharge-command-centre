/**
 * memory_chunks store (Stage 3 part 1): the read side the policy needs (how many messages,
 * what is covered, the messages of one range) and the one write — a chunk with its
 * summary, its embedding and its pointer. Server-side only, service role, the same
 * discipline as llm/store.ts: hard fetch timeout, no blind retry of writes, typed Results.
 *
 * Idempotency is the database's: `memory_chunks_no_overlap` (migration 20260826010000)
 * refuses a range that overlaps an existing chunk of the same conversation, and the store
 * reports that as `'exists'` rather than an error — the second writer in a race loses
 * quietly and the data stays right. The policy layer reads coverage first so the normal
 * path never even attempts a duplicate (and never pays for one).
 *
 * The raw message text is NOT stored again (guardrail): a chunk is a summary plus a range.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';
import type { ServiceClient } from '../auth/clients.js';
import {
  formatInt4Range,
  nextUncoveredOrdinal,
  parseInt4Range,
  type MessageRange,
} from './policy.js';

export interface ChunkCoverage {
  /** Every row of the conversation, any role. */
  readonly messageCount: number;
  /** First ordinal no chunk covers. */
  readonly nextOrdinal: number;
  readonly ranges: readonly MessageRange[];
}

/** One message row with its ordinal. `content` is null for tool rows. */
export interface OrdinalMessage {
  readonly ordinal: number;
  readonly role: string;
  readonly content: string | null;
  readonly createdAt: Date;
}

export interface ChunkInsert {
  readonly conversationId: string;
  readonly userId: string;
  /**
   * Always `SHARED_MEMORY_SCOPE` since Stage 3 part 5 (R27) — a chunk of a private
   * conversation is still workspace memory. The database says so too (the chunk trigger
   * forces it and `memory_chunks_scope_workspace` refuses anything else); the field stays
   * on the insert so the application states its intent rather than relying on being
   * corrected. Do NOT wire `ConversationRef.scope` back into this.
   */
  readonly scope: 'user' | 'workspace';
  readonly summary: string;
  /** Who the work was aimed at (review, 27 Aug); null when the summariser found none. */
  readonly audience: string | null;
  /**
   * NULL when the embedding call failed (Stage 3 part 5b, D70). The note is still worth
   * keeping — it cost a Haiku call — and the row's `turn_range` marks the range covered, so
   * the same text is never summarised and charged for twice. `match_memory_chunks` ignores a
   * null embedding, so an unembedded chunk is simply not retrievable yet;
   * `backfillChunkEmbeddings` fills it in later.
   */
  readonly embedding: readonly number[] | null;
  readonly range: MessageRange;
}

/** A chunk that is waiting for its embedding, with everything needed to rebuild the header. */
export interface ChunkAwaitingEmbedding {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  /** The conversation's title, for the embedded header (summarise.ts `embeddingText`). */
  readonly title: string | null;
  readonly summary: string;
  readonly audience: string | null;
  readonly range: MessageRange;
}

export interface ConversationRef {
  readonly id: string;
  readonly userId: string;
  /**
   * The CONVERSATION's own scope — whether its author made it private. Read and validated
   * against the check constraint, and deliberately NOT what a chunk of it is written at
   * (R27): see `ChunkInsert.scope`.
   */
  readonly scope: 'user' | 'workspace';
  /** Embedded as the chunk's header (summarise.ts); null for an untitled conversation. */
  readonly title: string | null;
}

export interface ChunkStore {
  coverage(conversationId: string): Promise<Result<ChunkCoverage>>;
  /** Messages with ordinals in [range.lo, range.hi), in ordinal order. */
  messagesInRange(
    conversationId: string,
    range: MessageRange,
  ): Promise<Result<readonly OrdinalMessage[]>>;
  insertChunk(input: ChunkInsert): Promise<Result<'inserted' | 'exists'>>;
  /**
   * Chunks that were kept without an embedding, oldest first — `embedding is null` AND
   * `deleted_at is null`, which distinguishes them from a tombstone (part 3), whose
   * embedding is also null but which has a `deleted_at` and must never come back.
   */
  chunksNeedingEmbedding(limit: number): Promise<Result<readonly ChunkAwaitingEmbedding[]>>;
  /**
   * Attach an embedding to a chunk that has none. Guarded on BOTH `embedding is null` and
   * `deleted_at is null`, so a chunk somebody deleted between the read and this write is
   * never silently re-embedded, and a second backfill of the same row is a no-op.
   */
  setChunkEmbedding(
    chunkId: string,
    embedding: readonly number[],
  ): Promise<Result<'embedded' | 'already'>>;
  /** Live conversations last active at or before `staleBefore`, most recent first. */
  idleConversations(staleBefore: Date, limit: number): Promise<Result<readonly ConversationRef[]>>;
}

/** Postgres exclusion_violation — the no-overlap constraint did its job. */
const EXCLUSION_VIOLATION = '23P01';

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, {
      context: { operation, detail: error.message },
    });
  }
  return new AppError('HTTP_STATUS', `${operation}: ${error.message}`, {
    context: { operation, supabaseCode: error.code },
  });
}

function mapThrown(caught: unknown, operation: string): AppError {
  return new NetworkError(`${operation}: transport failure`, {
    context: { operation },
    cause: ensureError(caught),
  });
}

function toScope(value: string, conversationId: string): Result<'user' | 'workspace'> {
  if (value === 'user' || value === 'workspace') return ok(value);
  return err(
    new AppError('INTERNAL', 'conversations.scope outside its check constraint', {
      context: { conversationId },
    }),
  );
}

export function supabaseChunkStore(client: ServiceClient): ChunkStore {
  return {
    coverage: async (conversationId) => {
      try {
        const counted = await client
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversationId);
        if (counted.error !== null) return err(mapPostgrest(counted.error, 'messages.count'));
        const chunks = await client
          .from('memory_chunks')
          .select('turn_range')
          .eq('conversation_id', conversationId);
        if (chunks.error !== null) return err(mapPostgrest(chunks.error, 'memory_chunks.ranges'));
        const ranges: MessageRange[] = [];
        for (const row of chunks.data) {
          const parsed = parseInt4Range(row.turn_range);
          if (!parsed.ok) return err(parsed.error);
          ranges.push(parsed.value);
        }
        return ok({
          messageCount: counted.count ?? 0,
          nextOrdinal: nextUncoveredOrdinal(ranges),
          ranges,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_chunks.coverage'));
      }
    },
    messagesInRange: async (conversationId, range) => {
      try {
        if (range.hi <= range.lo) return ok([]);
        // Ordinal = 1-based position in (created_at, id) order — the same order every
        // reader of this conversation uses, so a range always names the same rows.
        const { data, error } = await client
          .from('messages')
          .select('role, content, created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(range.lo - 1, range.hi - 2);
        if (error !== null) return err(mapPostgrest(error, 'messages.range'));
        return ok(
          data.map((row, i) => ({
            ordinal: range.lo + i,
            role: row.role,
            content: row.content,
            createdAt: new Date(row.created_at),
          })),
        );
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'messages.range'));
      }
    },
    insertChunk: async (input) => {
      try {
        const { error } = await client.from('memory_chunks').insert({
          conversation_id: input.conversationId,
          user_id: input.userId,
          scope: input.scope,
          summary: input.summary,
          audience: input.audience,
          // pgvector accepts the JSON array form on input; PostgREST forwards it as text.
          embedding: input.embedding === null ? null : JSON.stringify(input.embedding),
          turn_range: formatInt4Range(input.range),
        });
        if (error !== null) {
          if (error.code === EXCLUSION_VIOLATION) return ok('exists');
          return err(mapPostgrest(error, 'memory_chunks.insert'));
        }
        return ok('inserted');
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_chunks.insert'));
      }
    },
    chunksNeedingEmbedding: async (limit) => {
      try {
        const { data, error } = await client
          .from('memory_chunks')
          .select('id, conversation_id, user_id, summary, audience, turn_range')
          .is('embedding', null)
          .is('deleted_at', null)
          .order('created_at', { ascending: true })
          .limit(limit);
        if (error !== null) return err(mapPostgrest(error, 'memory_chunks.needingEmbedding'));
        if (data.length === 0) return ok([]);

        // One read for every parent title rather than one per chunk: a backlog is a backlog
        // precisely because several chunks are waiting at once.
        const titles = await client
          .from('conversations')
          .select('id, title')
          .in('id', [...new Set(data.map((row) => row.conversation_id))]);
        const byId = new Map<string, string | null>(
          titles.error === null ? titles.data.map((row) => [row.id, row.title]) : [],
        );

        const out: ChunkAwaitingEmbedding[] = [];
        for (const row of data) {
          const range = parseInt4Range(row.turn_range);
          if (!range.ok) return err(range.error);
          out.push({
            id: row.id,
            conversationId: row.conversation_id,
            userId: row.user_id,
            title: byId.get(row.conversation_id) ?? null,
            summary: row.summary,
            audience: row.audience,
            range: range.value,
          });
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_chunks.needingEmbedding'));
      }
    },
    setChunkEmbedding: async (chunkId, embedding) => {
      try {
        const { data, error } = await client
          .from('memory_chunks')
          .update({ embedding: JSON.stringify(embedding) })
          .eq('id', chunkId)
          .is('embedding', null)
          .is('deleted_at', null)
          .select('id');
        if (error !== null) return err(mapPostgrest(error, 'memory_chunks.setEmbedding'));
        return ok(data.length === 0 ? 'already' : 'embedded');
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_chunks.setEmbedding'));
      }
    },
    idleConversations: async (staleBefore, limit) => {
      try {
        const { data, error } = await client
          .from('conversations')
          .select('id, user_id, scope, title')
          .is('deleted_at', null)
          .lte('last_active_at', staleBefore.toISOString())
          .order('last_active_at', { ascending: false })
          .limit(limit);
        if (error !== null) return err(mapPostgrest(error, 'conversations.idle'));
        const out: ConversationRef[] = [];
        for (const row of data) {
          const scope = toScope(row.scope, row.id);
          if (!scope.ok) return err(scope.error);
          out.push({ id: row.id, userId: row.user_id, scope: scope.value, title: row.title });
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversations.idle'));
      }
    },
  };
}
