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
  readonly scope: 'user' | 'workspace';
  readonly summary: string;
  /** Who the work was aimed at (review, 27 Aug); null when the summariser found none. */
  readonly audience: string | null;
  readonly embedding: readonly number[];
  readonly range: MessageRange;
}

export interface ConversationRef {
  readonly id: string;
  readonly userId: string;
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
          embedding: JSON.stringify(input.embedding),
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
