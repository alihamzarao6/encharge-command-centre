/**
 * Durable facts (Stage 3 part 2, FND-310): what the user has told the assistant to keep
 * for good. The table is append-only with supersede (D10, SCHEMA.md §4): a new value for
 * a live key inserts a new row and points the old one's `superseded_by` at it, so the
 * history of what he said is never lost and "current" is one predicate,
 * `superseded_by is null`. The swap is done by the database function `upsert_memory_fact`
 * (migration 20260827010000) in one transaction under a per-note advisory lock — the
 * partial unique indexes would refuse two live rows for one note, and two callers racing on
 * the same note must end with one live row that supersedes the other, not an error.
 *
 * IDENTITY IS PER SCOPE (migration 20260827040000, D54): a **workspace** note is unique by
 * `key` alone, whoever wrote it — the business has one answer, and two people each holding a
 * live `writing:tone` would mean the model is handed both, every turn, contradicting itself.
 * A **user** note is unique by `(user_id, key)`. `upsert_memory_fact` locks and looks up by
 * the same shape, so `userId` on an upsert is the AUTHOR of the new row, not part of the
 * note's identity at workspace scope.
 *
 * The KEY is `<category>:<slug>` — a controlled category and a free slug (see
 * FACT_CATEGORIES). A wholly free string would let "tone" and "writing style" become two
 * facts that contradict each other forever; a closed vocabulary would refuse the useful
 * thing he actually says. The extractor (capture.ts) is shown the live keys and told to
 * reuse one when the new statement is about the same subject; the format is enforced
 * here AND by the table's check constraint.
 *
 * Server-side only, service role, same discipline as chunks.ts: hard fetch timeout, no
 * blind retry of writes (the function is idempotent on identical input — 'unchanged' —
 * but a retried supersede would supersede twice), typed Results.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import {
  AppError,
  NetworkError,
  ValidationError,
  ensureError,
  err,
  ok,
  type Result,
} from '../errors.js';
import type { ServiceClient } from '../auth/clients.js';

export type MemoryScope = 'user' | 'workspace';

export const FACT_CATEGORIES = [
  'writing',
  'audience',
  'business',
  'offer',
  'process',
  'personal',
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/** Mirrors `memory_facts_key_format` in the migration. */
export const FACT_KEY_PATTERN =
  /^(writing|audience|business|offer|process|personal):[a-z0-9]+(-[a-z0-9]+)*$/;
export const FACT_KEY_MAX_CHARS = 72;
export const FACT_VALUE_MAX_CHARS = 400;

export interface FactRow {
  readonly id: string;
  readonly userId: string;
  readonly scope: MemoryScope;
  readonly key: string;
  readonly value: string;
  readonly confidence: number | null;
  readonly sourceMessageId: string | null;
  readonly supersededBy: string | null;
  readonly createdAt: Date;
}

export interface FactUpsert {
  readonly userId: string;
  readonly scope: MemoryScope;
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
  readonly sourceMessageId: string | null;
}

export type FactOutcome = 'inserted' | 'superseded' | 'unchanged';

export interface FactWritten {
  readonly id: string;
  readonly supersededId: string | null;
  readonly outcome: FactOutcome;
}

export interface FactStore {
  /**
   * Live facts this user may read, newest first: every workspace fact plus their own
   * private ones — the RLS rule, restated because the caller is service_role.
   */
  currentFacts(userId: string, limit: number): Promise<Result<readonly FactRow[]>>;
  upsert(input: FactUpsert): Promise<Result<FactWritten>>;
  /** Best-effort back-fill once the message that carried the fact is saved. */
  setSource(factId: string, messageId: string): Promise<Result<void>>;
}

/** Slug rules: lowercase, digits and single hyphens, from any free text. */
export function slugify(text: string, maxChars = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug.slice(0, maxChars).replace(/-+$/, '');
}

export function isFactCategory(value: string): value is FactCategory {
  return (FACT_CATEGORIES as readonly string[]).includes(value);
}

export function factKey(category: FactCategory, topic: string): Result<string, ValidationError> {
  const key = `${category}:${slugify(topic)}`;
  return validateFactKey(key);
}

export function validateFactKey(key: string): Result<string, ValidationError> {
  if (key.length > FACT_KEY_MAX_CHARS || !FACT_KEY_PATTERN.test(key)) {
    return err(
      new ValidationError('fact key is malformed', [
        { path: 'key', message: `expected <category>:<slug>, got ${key.slice(0, 80)}` },
      ]),
    );
  }
  return ok(key);
}

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

function toScope(value: string, id: string): Result<MemoryScope> {
  if (value === 'user' || value === 'workspace') return ok(value);
  return err(
    new AppError('INTERNAL', 'memory_facts.scope outside its check constraint', {
      context: { factId: id },
    }),
  );
}

function toOutcome(value: string, id: string): Result<FactOutcome> {
  if (value === 'inserted' || value === 'superseded' || value === 'unchanged') return ok(value);
  return err(
    new AppError('INTERNAL', 'upsert_memory_fact returned an unknown outcome', {
      context: { factId: id },
    }),
  );
}

export function supabaseFactStore(client: ServiceClient): FactStore {
  return {
    currentFacts: async (userId, limit) => {
      try {
        const { data, error } = await client
          .from('memory_facts')
          .select(
            'id, user_id, scope, key, value, confidence, source_message_id, superseded_by, created_at',
          )
          .is('superseded_by', null)
          .or(`scope.eq.workspace,user_id.eq.${userId}`)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (error !== null) return err(mapPostgrest(error, 'memory_facts.current'));
        const out: FactRow[] = [];
        for (const row of data) {
          const scope = toScope(row.scope, row.id);
          if (!scope.ok) return err(scope.error);
          if (row.value === null) continue; // NOT NULL from this migration; belt and braces.
          out.push({
            id: row.id,
            userId: row.user_id,
            scope: scope.value,
            key: row.key,
            value: row.value,
            confidence: row.confidence,
            sourceMessageId: row.source_message_id,
            supersededBy: row.superseded_by,
            createdAt: new Date(row.created_at),
          });
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_facts.current'));
      }
    },
    upsert: async (input) => {
      const key = validateFactKey(input.key);
      if (!key.ok) return key;
      if (input.value.trim() === '' || input.value.length > FACT_VALUE_MAX_CHARS) {
        return err(
          new ValidationError('fact value is empty or too long', [
            { path: 'value', message: `1 to ${FACT_VALUE_MAX_CHARS} characters` },
          ]),
        );
      }
      try {
        const { data, error } = await client.rpc('upsert_memory_fact', {
          p_user_id: input.userId,
          p_scope: input.scope,
          p_key: key.value,
          p_value: input.value.trim(),
          p_confidence: input.confidence,
          p_source_message_id: input.sourceMessageId,
        });
        if (error !== null) return err(mapPostgrest(error, 'memory_facts.upsert'));
        const row = data[0];
        if (row === undefined) {
          return err(new AppError('INTERNAL', 'upsert_memory_fact returned no row'));
        }
        const outcome = toOutcome(row.outcome, row.id);
        if (!outcome.ok) return err(outcome.error);
        return ok({ id: row.id, supersededId: row.superseded_id, outcome: outcome.value });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_facts.upsert'));
      }
    },
    setSource: async (factId, messageId) => {
      try {
        const { error } = await client
          .from('memory_facts')
          .update({ source_message_id: messageId })
          .eq('id', factId)
          .is('source_message_id', null);
        if (error !== null) return err(mapPostgrest(error, 'memory_facts.setSource'));
        return ok(undefined);
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_facts.setSource'));
      }
    },
  };
}
