/**
 * supabase-js adapters for the Claude layer: api_usage (the cap's ledger) and the
 * conversations / messages pair. Server-side only — service role, the sanctioned write
 * path (SECURITY.md §4). Same discipline as auth/clients.ts: hard fetch timeout, no blind
 * retries of writes, every failure a typed Result.
 *
 * spentSince paginates. PostgREST caps a response at `max_rows` (1000 on the default
 * config); summing one page of a month with more calls than that would silently
 * under-count and the cap would be blind. Rows are fetched in pages until a short page.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';
import type { ServiceClient } from '../auth/clients.js';
import type {
  AppendTurnInput,
  AppendedTurn,
  ConversationRow,
  ConversationStore,
  HistoryMessage,
} from './chat.js';
import type { UsageRecord, UsageStore } from './client.js';
import { roundUsd } from './pricing.js';

const PAGE_SIZE = 1000;

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  // postgrest-js does not throw on a failed fetch; it returns `{ code: '', message:
  // 'TypeError: fetch failed' }`. That is a transport failure, and named as one.
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

export function supabaseUsageStore(client: ServiceClient): UsageStore {
  return {
    spentSince: async (provider, since) => {
      try {
        let total = 0;
        let offset = 0;
        for (;;) {
          const { data, error } = await client
            .from('api_usage')
            .select('cost_usd')
            .eq('provider', provider)
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);
          if (error !== null) {
            return err(mapPostgrest(error, 'api_usage.spentSince'));
          }
          for (const row of data) {
            total += row.cost_usd ?? 0;
          }
          if (data.length < PAGE_SIZE) {
            break;
          }
          offset += PAGE_SIZE;
        }
        return ok(roundUsd(total));
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'api_usage.spentSince'));
      }
    },
    record: async (row: UsageRecord) => {
      try {
        const { error } = await client.from('api_usage').insert({
          provider: row.provider,
          operation: row.operation,
          model: row.model,
          input_tokens: row.inputTokens,
          output_tokens: row.outputTokens,
          cache_read_tokens: row.cacheReadTokens,
          cache_write_tokens: row.cacheWriteTokens,
          cost_usd: row.costUsd,
          user_id: row.userId,
          conversation_id: row.conversationId,
        });
        if (error !== null) {
          return err(mapPostgrest(error, 'api_usage.insert'));
        }
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'api_usage.insert'));
      }
    },
  };
}

const CONVERSATION_COLUMNS = 'id, user_id, scope, title, deleted_at';

/**
 * A conversation's title is its first message, trimmed to one line. Set server-side on the
 * first turn so the list a phone shows is meaningful without a round trip, and never
 * overwritten afterwards.
 */
export const TITLE_MAX_CHARS = 80;

export function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TITLE_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Declared wider than the query's inferred type on purpose: the filter is belt-and-braces. */
function toHistoryMessage(row: { role: string; content: string | null }): HistoryMessage | null {
  if ((row.role !== 'user' && row.role !== 'assistant') || row.content === null) return null;
  return { role: row.role, content: row.content };
}

function toConversationRow(row: {
  id: string;
  user_id: string;
  scope: string;
  title: string | null;
  deleted_at: string | null;
}): Result<ConversationRow> {
  if (row.scope !== 'user' && row.scope !== 'workspace') {
    return err(
      new AppError('INTERNAL', 'conversations.scope outside its check constraint', {
        context: { conversationId: row.id },
      }),
    );
  }
  return ok({
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    title: row.title,
    deletedAt: row.deleted_at,
  });
}

export function supabaseConversationStore(client: ServiceClient): ConversationStore {
  return {
    get: async (conversationId) => {
      try {
        const { data, error } = await client
          .from('conversations')
          .select(CONVERSATION_COLUMNS)
          .eq('id', conversationId)
          .limit(1);
        if (error !== null) {
          return err(mapPostgrest(error, 'conversations.get'));
        }
        const row = data[0];
        return row === undefined ? ok(null) : toConversationRow(row);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversations.get'));
      }
    },
    create: async (userId, title) => {
      try {
        const { data, error } = await client
          .from('conversations')
          .insert(title === null ? { user_id: userId } : { user_id: userId, title })
          .select(CONVERSATION_COLUMNS)
          .single();
        if (error !== null) {
          return err(mapPostgrest(error, 'conversations.insert'));
        }
        return toConversationRow(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversations.insert'));
      }
    },
    recentMessages: async (conversationId, limit) => {
      try {
        // Newest first at the database so LIMIT keeps the right end; reversed here so the
        // request reads oldest first, the order Claude expects.
        const { data, error } = await client
          .from('messages')
          .select('role, content')
          .eq('conversation_id', conversationId)
          .in('role', ['user', 'assistant'])
          .not('content', 'is', null)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error !== null) {
          return err(mapPostgrest(error, 'messages.recent'));
        }
        const history: HistoryMessage[] = [];
        for (const row of data) {
          const item = toHistoryMessage(row);
          if (item !== null) history.unshift(item);
        }
        return ok(history);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'messages.recent'));
      }
    },
    appendTurn: async (input: AppendTurnInput) => {
      try {
        const base = {
          conversation_id: input.conversation.id,
          user_id: input.conversation.userId,
          scope: input.conversation.scope,
        };
        const userInsert = await client
          .from('messages')
          .insert({ ...base, role: 'user', content: input.userContent })
          .select('id')
          .single();
        if (userInsert.error !== null) {
          return err(mapPostgrest(userInsert.error, 'messages.insert.user'));
        }
        const assistantInsert = await client
          .from('messages')
          .insert({
            ...base,
            role: 'assistant',
            content: input.assistant.content,
            model: input.assistant.model,
            input_tokens: input.assistant.inputTokens,
            output_tokens: input.assistant.outputTokens,
          })
          .select('id')
          .single();
        if (assistantInsert.error !== null) {
          return err(mapPostgrest(assistantInsert.error, 'messages.insert.assistant'));
        }
        const touched = await client
          .from('conversations')
          .update({
            last_active_at: new Date().toISOString(),
            ...(input.conversation.title === null
              ? { title: titleFromMessage(input.userContent) }
              : {}),
          })
          .eq('id', input.conversation.id);
        if (touched.error !== null) {
          return err(mapPostgrest(touched.error, 'conversations.touch'));
        }
        return ok<AppendedTurn>({
          userMessageId: userInsert.data.id,
          assistantMessageId: assistantInsert.data.id,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'messages.appendTurn'));
      }
    },
  };
}
