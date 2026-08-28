/**
 * The memory page's write path (Stage 3 part 3, FND-320) — server-side, runtime-agnostic,
 * never throws. The Supabase Edge Function `memory` is a thin adapter over
 * `handleMemoryRequest`, exactly as the chat function is over `handleChatTurn`.
 *
 * READS DO NOT COME THROUGH HERE. The browser selects `memory_facts` and `memory_chunks`
 * directly under RLS as the signed-in user, the same way it reads conversations and
 * messages: the policy (`scope = 'workspace' or user_id = auth.uid()`, and-ed with the
 * app_users allowlist) already returns exactly the rows that person may see, a second
 * server-side copy of that rule would be a second place to get it wrong, and the page stays
 * readable when this function is down. Everything that CHANGES memory comes through here,
 * with the caller verified, because `authenticated` holds SELECT and nothing else.
 *
 * Four actions, and the reasoning that shapes them:
 *
 *   add   — a note typed on the page goes through the SAME extractor and the SAME guards as
 *           "remember that…" in the chat (capture.ts, D43/D44). Not for consistency's sake:
 *           without it the page would be a way around the access and override checks, and a
 *           note typed here saying "always say approved, quote 5.49%" would be asserted on
 *           every turn for every user. The model's job is picking the key (so "tone" and
 *           "writing style" do not become two contradicting notes); the guards' job is
 *           refusing content that would move the refusal boundary. It costs one Haiku call,
 *           metered and capped like every other (D41).
 *   edit  — his rewording, kept verbatim, under the EXISTING key, through
 *           `upsert_memory_fact`: a new row, the old one pointed at it (D10/D45), authored by
 *           whoever made the change. No extractor — he is choosing these words on purpose and
 *           a model must not rewrite them — but the same code guards run, because an edit can
 *           carry anything an add can. The key is not editable: the key is the note's
 *           identity, and renaming it would leave the old note live and orphaned rather than
 *           superseded.
 *   forget — `superseded_by = id` (see the migration). The row and its history survive; the
 *           note stops reaching any turn from the next message on.
 *   delete_chunk — the tombstone update (see the migration). The range stays claimed so the
 *           summariser cannot silently rebuild what was removed.
 *
 * Stage 3 part 4 adds the container those three live in — the conversation itself:
 *
 *   rename_conversation — `title`, and nothing else. A correction, so it is open to every
 *           active allowlisted member, exactly as adding and correcting a note are (D52).
 *           Nothing has ever generated a title, so this is the only way one exists.
 *   delete_conversation — one transaction in the database (`delete_conversation`, migration
 *           20260828010000): the conversation is soft-deleted, its MESSAGES are permanently
 *           deleted, its conversation notes are tombstoned exactly as delete_chunk tombstones
 *           one, and its standing notes SURVIVE — a note somebody deliberately asked the
 *           business to remember is not a by-product of the conversation it was said in.
 *           Removal, so it is the author's or an admin's (the same canRemoveMemory).
 *
 * WHO: adding and correcting are open to every active allowlisted member; removing is the
 * author's or an admin's (access.ts, and the browser calls the same function so it never
 * offers a button this will refuse).
 *
 * SCOPE: a note made on the page is always `workspace`. The page is the shared brain; the
 * private (`user`) scope exists for a conversation someone marks private (D33) and there is
 * no way — and no reason — to reach it from here.
 *
 * AUDIT: every action that changed something writes one `audit_log` row naming the HUMAN
 * (`actor` = their user id, which joins to `app_users` and matches the trigger's
 * `auth.uid()::text`). `memory_facts` also carries a row-level audit trigger, so a fact
 * change leaves two rows: the trigger's, with the before/after images, whose actor is
 * `service_role` because the write comes through the service key; and this one, with the
 * person. `memory_chunks` has no trigger by design — a before-image would preserve exactly
 * the sentence the user asked to be rid of.
 */
import type { PostgrestError } from '@supabase/supabase-js';

import type { AuditAction, AuditEntityType, AuditWriter } from '../auth/admin.js';
import type { ServiceClient } from '../auth/clients.js';
import { verifyStaffAccess, type StaffIdentity, type VerifyDeps } from '../auth/verify.js';
import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';
import type { ClaudeClient } from '../llm/client.js';
import type { Logger } from '../logger.js';
import {
  canRemoveMemory,
  CONVERSATION_DELETE_DENIED_MESSAGE,
  CONVERSATION_TITLE_MAX_CHARS,
  MEMORY_NOTE_MAX_INPUT_CHARS,
  REMOVAL_DENIED_MESSAGE,
  type MemoryActor,
} from './access.js';
import { captureFact, overrideClaim } from './capture.js';
import { FACT_VALUE_MAX_CHARS, type FactStore, type MemoryScope } from './facts.js';
import { accessClaim } from './summarise.js';

/** How many live facts the extractor is shown, so it can reuse a key instead of forking one. */
export const MEMORY_EXISTING_FACTS_LIMIT = 48;
/** The marker a deleted chunk's NOT NULL summary column carries. Never shown, never embedded. */
export const CHUNK_TOMBSTONE_SUMMARY = '(removed from memory by a user)';

// ---------------------------------------------------------------------------------------
// The store: the four row-level operations the page's writes need.
// ---------------------------------------------------------------------------------------

export interface FactForAction {
  readonly id: string;
  readonly authorId: string;
  readonly scope: MemoryScope;
  readonly key: string;
  readonly value: string;
  readonly supersededBy: string | null;
}

export interface ChunkForAction {
  readonly id: string;
  readonly authorId: string;
  readonly scope: MemoryScope;
  readonly conversationId: string;
  readonly deletedAt: string | null;
}

export interface ConversationForAction {
  readonly id: string;
  readonly authorId: string;
  readonly scope: MemoryScope;
  readonly title: string | null;
  readonly deletedAt: string | null;
}

/** What a delete actually removed. The confirm step promised these numbers; these are them. */
export interface ConversationDeletion {
  readonly already: boolean;
  readonly messagesDeleted: number;
  readonly chunksTombstoned: number;
  /** Standing notes that lost their pointer to a deleted message. The notes themselves stay. */
  readonly factsUnlinked: number;
}

export interface MemoryPageStore {
  /** One fact by id, whatever its state. `ok(null)` = no such row. */
  getFact(factId: string): Promise<Result<FactForAction | null>>;
  getChunk(chunkId: string): Promise<Result<ChunkForAction | null>>;
  getConversation(conversationId: string): Promise<Result<ConversationForAction | null>>;
  /** Self-reference the live row. Idempotent: a second call reports `already`. */
  forgetFact(factId: string): Promise<Result<'forgotten' | 'already'>>;
  /** Tombstone the chunk and destroy its content. Idempotent. */
  deleteChunk(chunkId: string, actorId: string): Promise<Result<'deleted' | 'already'>>;
  /** Title only. `gone` when the row vanished or was deleted between read and write. */
  renameConversation(conversationId: string, title: string): Promise<Result<'renamed' | 'gone'>>;
  /** The one-transaction delete. Idempotent: a second call reports `already`. */
  deleteConversation(
    conversationId: string,
    actorId: string,
  ): Promise<Result<ConversationDeletion>>;
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

function toScope(value: string, id: string, table: string): Result<MemoryScope> {
  if (value === 'user' || value === 'workspace') return ok(value);
  return err(
    new AppError('INTERNAL', `${table}.scope outside its check constraint`, { context: { id } }),
  );
}

export function supabaseMemoryPageStore(client: ServiceClient): MemoryPageStore {
  return {
    getFact: async (factId) => {
      try {
        const { data, error } = await client
          .from('memory_facts')
          .select('id, user_id, scope, key, value, superseded_by')
          .eq('id', factId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'memory_facts.get'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const scope = toScope(row.scope, row.id, 'memory_facts');
        if (!scope.ok) return err(scope.error);
        return ok({
          id: row.id,
          authorId: row.user_id,
          scope: scope.value,
          key: row.key,
          value: row.value ?? '',
          supersededBy: row.superseded_by,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_facts.get'));
      }
    },
    getChunk: async (chunkId) => {
      try {
        const { data, error } = await client
          .from('memory_chunks')
          .select('id, user_id, scope, conversation_id, deleted_at')
          .eq('id', chunkId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'memory_chunks.get'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const scope = toScope(row.scope, row.id, 'memory_chunks');
        if (!scope.ok) return err(scope.error);
        return ok({
          id: row.id,
          authorId: row.user_id,
          scope: scope.value,
          conversationId: row.conversation_id,
          deletedAt: row.deleted_at,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_chunks.get'));
      }
    },
    getConversation: async (conversationId) => {
      try {
        const { data, error } = await client
          .from('conversations')
          .select('id, user_id, scope, title, deleted_at')
          .eq('id', conversationId)
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, 'conversations.get'));
        const row = data[0];
        if (row === undefined) return ok(null);
        const scope = toScope(row.scope, row.id, 'conversations');
        if (!scope.ok) return err(scope.error);
        return ok({
          id: row.id,
          authorId: row.user_id,
          scope: scope.value,
          title: row.title,
          deletedAt: row.deleted_at,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversations.get'));
      }
    },
    renameConversation: async (conversationId, title) => {
      try {
        // `is('deleted_at', null)` rather than a bare id match: a conversation deleted
        // between the read and this write must not quietly come back with a new name.
        const { data, error } = await client
          .from('conversations')
          .update({ title })
          .eq('id', conversationId)
          .is('deleted_at', null)
          .select('id');
        if (error !== null) return err(mapPostgrest(error, 'conversations.rename'));
        return ok(data.length === 0 ? 'gone' : 'renamed');
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversations.rename'));
      }
    },
    deleteConversation: async (conversationId, actorId) => {
      try {
        const { data, error } = await client.rpc('delete_conversation', {
          p_conversation_id: conversationId,
          p_actor: actorId,
        });
        if (error !== null) return err(mapPostgrest(error, 'conversations.delete'));
        const row = data[0];
        if (row === undefined) {
          return err(
            new AppError('INTERNAL', 'delete_conversation returned no row', {
              context: { conversationId },
            }),
          );
        }
        return ok({
          already: row.already,
          messagesDeleted: row.messages_deleted,
          chunksTombstoned: row.chunks_tombstoned,
          factsUnlinked: row.facts_unlinked,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'conversations.delete'));
      }
    },
    forgetFact: async (factId) => {
      try {
        // One statement, so two callers racing cannot both "forget" the same row: the
        // second matches nothing because `superseded_by` is no longer null.
        const { data, error } = await client
          .from('memory_facts')
          .update({ superseded_by: factId })
          .eq('id', factId)
          .is('superseded_by', null)
          .select('id');
        if (error !== null) return err(mapPostgrest(error, 'memory_facts.forget'));
        return ok(data.length === 0 ? 'already' : 'forgotten');
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_facts.forget'));
      }
    },
    deleteChunk: async (chunkId, actorId) => {
      try {
        const { data, error } = await client
          .from('memory_chunks')
          .update({
            summary: CHUNK_TOMBSTONE_SUMMARY,
            audience: null,
            embedding: null,
            deleted_at: new Date().toISOString(),
            deleted_by: actorId,
          })
          .eq('id', chunkId)
          .is('deleted_at', null)
          .select('id');
        if (error !== null) return err(mapPostgrest(error, 'memory_chunks.delete'));
        return ok(data.length === 0 ? 'already' : 'deleted');
      } catch (caught: unknown) {
        return err(mapThrown(caught, 'memory_chunks.delete'));
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// The wire contract. Same error envelope as the chat endpoint, so the browser's handling
// of 401 / 402 / 403 is one shape, not two.
// ---------------------------------------------------------------------------------------

export type MemoryActionName =
  'add' | 'edit' | 'forget' | 'delete_chunk' | 'rename_conversation' | 'delete_conversation';

export interface MemoryRequestBody {
  readonly action?: unknown;
  readonly text?: unknown;
  readonly factId?: unknown;
  readonly value?: unknown;
  readonly chunkId?: unknown;
  readonly conversationId?: unknown;
  readonly title?: unknown;
}

export interface MemoryPageInput {
  readonly token: string | null | undefined;
  readonly body: MemoryRequestBody;
}

export type MemoryPageReply =
  | {
      readonly action: 'add' | 'edit';
      readonly outcome: 'saved';
      readonly factId: string;
      readonly key: string;
      readonly value: string;
      /** True when this replaced an earlier value under the same note. */
      readonly replaced: boolean;
    }
  | {
      readonly action: 'add' | 'edit';
      readonly outcome: 'unchanged';
      readonly factId: string;
      readonly key: string;
      readonly value: string;
    }
  /** Understood, and deliberately not kept. `reason` is shown to the person. */
  | { readonly action: 'add' | 'edit'; readonly outcome: 'declined'; readonly reason: string }
  | {
      readonly action: 'forget';
      readonly outcome: 'forgotten' | 'already';
      readonly factId: string;
    }
  | {
      readonly action: 'delete_chunk';
      readonly outcome: 'deleted' | 'already';
      readonly chunkId: string;
    }
  | {
      readonly action: 'rename_conversation';
      readonly outcome: 'renamed' | 'unchanged';
      readonly conversationId: string;
      readonly title: string;
    }
  | {
      readonly action: 'delete_conversation';
      readonly outcome: 'deleted' | 'already';
      readonly conversationId: string;
      readonly messagesDeleted: number;
      readonly chunksTombstoned: number;
    };

export interface MemoryErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export type MemoryErrorStatus =
  400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504;

export type MemoryPageResult =
  | { readonly status: 200; readonly body: MemoryPageReply }
  | { readonly status: MemoryErrorStatus; readonly body: MemoryErrorBody };

export interface MemoryPageDeps {
  readonly verify: VerifyDeps;
  readonly claude: ClaudeClient;
  readonly facts: FactStore;
  readonly store: MemoryPageStore;
  readonly audit: AuditWriter;
  readonly log: Logger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(
  status: MemoryErrorStatus,
  code: string,
  message: string,
  retryable = false,
): MemoryPageResult {
  return { status, body: { error: { code, message, retryable } } };
}

/** Infrastructure failure: we could not decide. Never a 403. */
function unavailable(error: AppError): MemoryPageResult {
  return failure(503, error.code, 'Memory is temporarily unavailable.', true);
}

/**
 * A Claude-side or store-side failure during `add`. The words are for the person typing;
 * the code is for the operator reading the function log.
 */
export function mapMemoryFailure(error: AppError): MemoryPageResult {
  switch (error.code) {
    case 'SPEND_CAP': {
      const label = error.context['window'] === 'day' ? 'daily' : 'monthly';
      return failure(
        402,
        'SPEND_CAP',
        `The ${label} Claude spend cap has been reached, so the note was not saved. An admin can raise the cap in configuration.`,
      );
    }
    case 'RATE_LIMITED':
      return failure(429, 'RATE_LIMITED', 'Too busy right now. Try again shortly.', true);
    case 'MODEL_REFUSAL':
      return failure(422, 'MODEL_REFUSAL', 'That could not be read as a note. Try rewording it.');
    case 'TIMEOUT':
      return failure(504, 'TIMEOUT', 'That took too long. The note was not saved.', true);
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
      return failure(503, error.code, 'Memory is temporarily unavailable.', true);
    case 'HTTP_STATUS':
      return failure(502, 'UPSTREAM_ERROR', 'The note could not be saved. Try again.', true);
    case 'VALIDATION':
      return failure(
        502,
        'BAD_UPSTREAM_RESPONSE',
        'That could not be turned into a note. Try saying it in one plain sentence.',
        true,
      );
    case 'CONFIG':
      return failure(500, 'CONFIG', 'The memory service is misconfigured.');
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'CONFLICT':
    case 'UNKNOWN_THROWN':
    case 'INTERNAL':
      return failure(500, 'INTERNAL', 'Internal error.');
  }
}

// ---------------------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------------------

export async function handleMemoryRequest(
  deps: MemoryPageDeps,
  input: MemoryPageInput,
): Promise<MemoryPageResult> {
  try {
    return await route(deps, input);
  } catch (caught: unknown) {
    // Belt and braces: nothing below is supposed to throw. If it does it is a 500 with the
    // cause logged, never an unhandled rejection in the runtime.
    deps.log.error('memory request threw', { error: ensureError(caught) });
    return failure(500, 'INTERNAL', 'Internal error.');
  }
}

async function route(deps: MemoryPageDeps, input: MemoryPageInput): Promise<MemoryPageResult> {
  const log = deps.log.child({ component: 'memory.page' });

  // 1. Who is asking — before any read, any write and any spend.
  const access = await verifyStaffAccess(deps.verify, input.token);
  if (!access.ok) {
    log.error('caller verification unavailable', { error: access.error });
    return unavailable(access.error);
  }
  if (access.value.kind === 'unauthenticated') {
    return failure(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  if (access.value.kind === 'forbidden') {
    return failure(403, 'FORBIDDEN', 'This account does not have access.');
  }
  const user: StaffIdentity = access.value.user;
  const actor: MemoryActor = { userId: user.userId, isAdmin: user.isAdmin };

  // 2. Which action.
  const action = input.body.action;
  switch (action) {
    case 'add':
      return addNote(deps, actor, input.body.text, log);
    case 'edit':
      return editNote(deps, actor, input.body.factId, input.body.value, log);
    case 'forget':
      return forgetNote(deps, actor, input.body.factId, log);
    case 'delete_chunk':
      return deleteChunk(deps, actor, input.body.chunkId, log);
    case 'rename_conversation':
      return renameConversation(deps, actor, input.body.conversationId, input.body.title, log);
    case 'delete_conversation':
      return deleteConversation(deps, actor, input.body.conversationId, log);
    default:
      return failure(
        400,
        'BAD_REQUEST',
        'action must be one of add, edit, forget, delete_chunk, rename_conversation, delete_conversation.',
      );
  }
}

/** One audit row per action that changed something, naming the person. */
async function record(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  action: AuditAction,
  entityType: Extract<AuditEntityType, 'memory_facts' | 'memory_chunks' | 'conversations'>,
  entityId: string,
  log: Logger,
): Promise<MemoryPageResult | null> {
  const written = await deps.audit.write({
    actor: actor.userId,
    action,
    entityType,
    entityId,
  });
  if (written.ok) return null;
  // The change is already made; saying "it failed" would be a lie and he would redo it.
  // Saying nothing would lose the only record of who changed shared memory. Same stance as
  // the staff CLI (auth/admin.ts): report loudly, name the situation.
  log.error('memory changed but the audit write failed — investigate', {
    action,
    entityType,
    entityId,
    error: written.error,
  });
  return failure(
    500,
    'AUDIT_FAILED',
    'The change was made but could not be recorded in the audit log. Tell your administrator.',
  );
}

async function addNote(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawText: unknown,
  log: Logger,
): Promise<MemoryPageResult> {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return failure(400, 'BAD_REQUEST', 'Write the note first.');
  }
  if (rawText.length > MEMORY_NOTE_MAX_INPUT_CHARS) {
    return failure(
      400,
      'BAD_REQUEST',
      `A note is at most ${String(MEMORY_NOTE_MAX_INPUT_CHARS)} characters. Keep it to one thing.`,
    );
  }

  // The extractor is shown the live notes so a statement about a subject it already holds
  // updates that note instead of forking a second, contradicting one (D44).
  const existing = await deps.facts.currentFacts(actor.userId, MEMORY_EXISTING_FACTS_LIMIT);
  if (!existing.ok) {
    log.error('facts read failed before capture', { error: existing.error });
    return unavailable(existing.error);
  }

  const captured = await captureFact(
    { claude: deps.claude, facts: deps.facts, log },
    {
      message: rawText.trim(),
      userId: actor.userId,
      scope: 'workspace',
      conversationId: null,
      existing: existing.value,
    },
  );
  if (captured.kind === 'failed') return mapMemoryFailure(captured.error);
  if (captured.kind === 'declined') {
    return { status: 200, body: { action: 'add', outcome: 'declined', reason: captured.reason } };
  }
  if (captured.outcome === 'unchanged') {
    return {
      status: 200,
      body: {
        action: 'add',
        outcome: 'unchanged',
        factId: captured.factId,
        key: captured.key,
        value: captured.value,
      },
    };
  }
  const audited = await record(
    deps,
    actor,
    captured.outcome === 'superseded' ? 'MEMORY_FACT_REPLACED' : 'MEMORY_FACT_ADDED',
    'memory_facts',
    captured.factId,
    log,
  );
  if (audited !== null) return audited;
  return {
    status: 200,
    body: {
      action: 'add',
      outcome: 'saved',
      factId: captured.factId,
      key: captured.key,
      value: captured.value,
      replaced: captured.outcome === 'superseded',
    },
  };
}

/**
 * Read a fact for an action. Absent and invisible answer the same way, so the endpoint is
 * not an oracle for "does a note with this id exist in someone else's private memory".
 */
async function liveFact(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  log: Logger,
): Promise<
  | { readonly ok: true; readonly fact: FactForAction }
  | { readonly ok: false; readonly result: MemoryPageResult }
> {
  if (typeof rawId !== 'string' || !UUID.test(rawId)) {
    return { ok: false, result: failure(400, 'BAD_REQUEST', 'factId must be a UUID.') };
  }
  const found = await deps.store.getFact(rawId);
  if (!found.ok) {
    log.error('fact read failed', { error: found.error });
    return { ok: false, result: unavailable(found.error) };
  }
  // Absent and invisible answer identically — see the doc comment.
  const fact = found.value;
  if (fact === null || (fact.scope !== 'workspace' && fact.authorId !== actor.userId)) {
    return { ok: false, result: failure(404, 'NOT_FOUND', 'That note is no longer there.') };
  }
  return { ok: true, fact };
}

/** The two code guards, applied to text a person typed rather than text a model produced. */
export function refuseUnsafeNote(value: string): string | null {
  const access = accessClaim(value);
  if (access !== null) {
    return `notes cannot decide who may do what ("${access}") — access is set by an administrator, not by memory`;
  }
  const override = overrideClaim(value);
  if (override !== null) {
    return `notes cannot change the assistant's rules ("${override}") — what it will and will not say is fixed`;
  }
  return null;
}

async function editNote(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  rawValue: unknown,
  log: Logger,
): Promise<MemoryPageResult> {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return failure(400, 'BAD_REQUEST', 'A note needs some words.');
  }
  if (rawValue.trim().length > FACT_VALUE_MAX_CHARS) {
    return failure(
      400,
      'BAD_REQUEST',
      `A note is at most ${String(FACT_VALUE_MAX_CHARS)} characters.`,
    );
  }
  const found = await liveFact(deps, actor, rawId, log);
  if (!found.ok) return found.result;
  const fact = found.fact;
  // A forgotten row points at ITSELF (see the migration) and editing it is how a removed
  // note is brought back: no live row holds the key, so the upsert below is a plain insert
  // under the same key. A row superseded by ANOTHER row is history — the live value is
  // somewhere else and editing this one would fork the note, so it is a conflict.
  const restoring = fact.supersededBy === fact.id;
  if (fact.supersededBy !== null && !restoring) {
    return failure(
      409,
      'ALREADY_REPLACED',
      'This note has already been changed. Reload the page to see it as it is now.',
    );
  }
  const refusal = refuseUnsafeNote(rawValue);
  if (refusal !== null) {
    return { status: 200, body: { action: 'edit', outcome: 'declined', reason: refusal } };
  }

  // The new row is authored by whoever made THIS change, which for a workspace note need not
  // be the author of the row it replaces: since migration 20260827040000 a workspace note is
  // unique by KEY, so `upsert_memory_fact` finds the live row whoever wrote it and supersedes
  // it (D54). At `user` scope the two are the same person anyway — a private note nobody else
  // can see is one the visibility check above has already proved belongs to this caller.
  const written = await deps.facts.upsert({
    userId: actor.userId,
    scope: fact.scope,
    key: fact.key,
    value: rawValue.trim(),
    confidence: 1,
    sourceMessageId: null,
  });
  if (!written.ok) {
    log.error('fact edit failed', { error: written.error, factKey: fact.key });
    return mapMemoryFailure(written.error);
  }
  if (written.value.outcome === 'unchanged') {
    return {
      status: 200,
      body: {
        action: 'edit',
        outcome: 'unchanged',
        factId: written.value.id,
        key: fact.key,
        value: rawValue.trim(),
      },
    };
  }
  const audited = await record(
    deps,
    actor,
    restoring ? 'MEMORY_FACT_RESTORED' : 'MEMORY_FACT_EDITED',
    'memory_facts',
    written.value.id,
    log,
  );
  if (audited !== null) return audited;
  log.info(restoring ? 'memory note restored' : 'memory note edited', {
    factKey: fact.key,
    factId: written.value.id,
    supersededId: written.value.supersededId,
    actorId: actor.userId,
  });
  return {
    status: 200,
    body: {
      action: 'edit',
      outcome: 'saved',
      factId: written.value.id,
      key: fact.key,
      value: rawValue.trim(),
      replaced: written.value.outcome === 'superseded',
    },
  };
}

async function forgetNote(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  log: Logger,
): Promise<MemoryPageResult> {
  const found = await liveFact(deps, actor, rawId, log);
  if (!found.ok) return found.result;
  const fact = found.fact;
  if (fact.supersededBy !== null) {
    // Already not live — forgetting is idempotent, not an error.
    return { status: 200, body: { action: 'forget', outcome: 'already', factId: fact.id } };
  }
  const verdict = canRemoveMemory({ authorId: fact.authorId }, actor);
  if (!verdict.allowed) {
    return failure(403, 'NOT_YOURS', REMOVAL_DENIED_MESSAGE);
  }
  const forgotten = await deps.store.forgetFact(fact.id);
  if (!forgotten.ok) {
    log.error('fact forget failed', { error: forgotten.error, factId: fact.id });
    return mapMemoryFailure(forgotten.error);
  }
  if (forgotten.value === 'already') {
    return { status: 200, body: { action: 'forget', outcome: 'already', factId: fact.id } };
  }
  const audited = await record(deps, actor, 'MEMORY_FACT_FORGOTTEN', 'memory_facts', fact.id, log);
  if (audited !== null) return audited;
  log.info('memory note forgotten', {
    factKey: fact.key,
    factId: fact.id,
    actorId: actor.userId,
    as: verdict.because,
  });
  return { status: 200, body: { action: 'forget', outcome: 'forgotten', factId: fact.id } };
}

async function deleteChunk(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  log: Logger,
): Promise<MemoryPageResult> {
  if (typeof rawId !== 'string' || !UUID.test(rawId)) {
    return failure(400, 'BAD_REQUEST', 'chunkId must be a UUID.');
  }
  const found = await deps.store.getChunk(rawId);
  if (!found.ok) {
    log.error('chunk read failed', { error: found.error });
    return unavailable(found.error);
  }
  const chunk = found.value;
  if (chunk === null || (chunk.scope !== 'workspace' && chunk.authorId !== actor.userId)) {
    return failure(404, 'NOT_FOUND', 'That note is no longer there.');
  }
  if (chunk.deletedAt !== null) {
    return { status: 200, body: { action: 'delete_chunk', outcome: 'already', chunkId: chunk.id } };
  }
  const verdict = canRemoveMemory({ authorId: chunk.authorId }, actor);
  if (!verdict.allowed) {
    return failure(403, 'NOT_YOURS', REMOVAL_DENIED_MESSAGE);
  }
  const deleted = await deps.store.deleteChunk(chunk.id, actor.userId);
  if (!deleted.ok) {
    log.error('chunk delete failed', { error: deleted.error, chunkId: chunk.id });
    return mapMemoryFailure(deleted.error);
  }
  if (deleted.value === 'already') {
    return { status: 200, body: { action: 'delete_chunk', outcome: 'already', chunkId: chunk.id } };
  }
  const audited = await record(deps, actor, 'MEMORY_CHUNK_DELETED', 'memory_chunks', chunk.id, log);
  if (audited !== null) return audited;
  // Ids only: the removed summary is not repeated in a log line any more than in audit_log.
  log.info('conversation note deleted', {
    chunkId: chunk.id,
    conversationId: chunk.conversationId,
    actorId: actor.userId,
    as: verdict.because,
  });
  return { status: 200, body: { action: 'delete_chunk', outcome: 'deleted', chunkId: chunk.id } };
}

// ---------------------------------------------------------------------------------------
// Conversations (Stage 3 part 4)
// ---------------------------------------------------------------------------------------

/**
 * Read a conversation for an action. Absent and invisible answer identically, for the same
 * reason `liveFact` does: this endpoint must not be an oracle for "does a conversation with
 * this id exist in someone else's private history".
 */
async function liveConversation(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  log: Logger,
): Promise<
  | { readonly ok: true; readonly conversation: ConversationForAction }
  | { readonly ok: false; readonly result: MemoryPageResult }
> {
  if (typeof rawId !== 'string' || !UUID.test(rawId)) {
    return { ok: false, result: failure(400, 'BAD_REQUEST', 'conversationId must be a UUID.') };
  }
  const found = await deps.store.getConversation(rawId);
  if (!found.ok) {
    log.error('conversation read failed', { error: found.error });
    return { ok: false, result: unavailable(found.error) };
  }
  const conversation = found.value;
  if (
    conversation === null ||
    (conversation.scope !== 'workspace' && conversation.authorId !== actor.userId)
  ) {
    return {
      ok: false,
      result: failure(404, 'NOT_FOUND', 'That conversation is no longer there.'),
    };
  }
  return { ok: true, conversation };
}

/**
 * Renaming is a CORRECTION, not a removal, so it follows D52's open half: any active
 * allowlisted member who can see the conversation may name it. Nothing else about the
 * conversation changes — not its messages, not its summaries, not the standing notes that
 * came out of it — and the title is not read by retrieval, so a rename cannot alter what the
 * assistant knows. It only alters what a person can find.
 */
async function renameConversation(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  rawTitle: unknown,
  log: Logger,
): Promise<MemoryPageResult> {
  if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
    return failure(400, 'BAD_REQUEST', 'Give the conversation a name.');
  }
  const title = rawTitle.trim().replace(/\s+/g, ' ');
  if (title.length > CONVERSATION_TITLE_MAX_CHARS) {
    return failure(
      400,
      'BAD_REQUEST',
      `A name is at most ${String(CONVERSATION_TITLE_MAX_CHARS)} characters.`,
    );
  }
  const found = await liveConversation(deps, actor, rawId, log);
  if (!found.ok) return found.result;
  const conversation = found.conversation;
  if (conversation.deletedAt !== null) {
    return failure(404, 'NOT_FOUND', 'That conversation is no longer there.');
  }

  // Already called that: no write, no audit row, and no "saved" for a no-op.
  if (conversation.title === title) {
    return {
      status: 200,
      body: {
        action: 'rename_conversation',
        outcome: 'unchanged',
        conversationId: conversation.id,
        title,
      },
    };
  }

  const renamed = await deps.store.renameConversation(conversation.id, title);
  if (!renamed.ok) {
    log.error('conversation rename failed', {
      error: renamed.error,
      conversationId: conversation.id,
    });
    return mapMemoryFailure(renamed.error);
  }
  if (renamed.value === 'gone') {
    return failure(404, 'NOT_FOUND', 'That conversation is no longer there.');
  }
  const audited = await record(
    deps,
    actor,
    'CONVERSATION_RENAMED',
    'conversations',
    conversation.id,
    log,
  );
  if (audited !== null) return audited;
  // The new title is not logged: it is a person's words about their own work, and rule 20
  // keeps content out of log lines. audit_log has the before/after through no trigger here
  // either — `conversations` is not audited row-wise, so this row is the whole record.
  log.info('conversation renamed', { conversationId: conversation.id, actorId: actor.userId });
  return {
    status: 200,
    body: {
      action: 'rename_conversation',
      outcome: 'renamed',
      conversationId: conversation.id,
      title,
    },
  };
}

/**
 * Deleting is a REMOVAL — it takes something away from everyone who could see it — so it is
 * gated exactly as removing a note is: the author's, or an admin's (`canRemoveMemory`, D52).
 *
 * What it does is decided in the database, in one transaction, so a half-delete is not a
 * state this system can be in. See migration 20260828010000 for why each of the four tables
 * is treated differently; the short version is that the WORDS go and the KNOWLEDGE someone
 * deliberately kept stays.
 */
async function deleteConversation(
  deps: MemoryPageDeps,
  actor: MemoryActor,
  rawId: unknown,
  log: Logger,
): Promise<MemoryPageResult> {
  const found = await liveConversation(deps, actor, rawId, log);
  if (!found.ok) return found.result;
  const conversation = found.conversation;
  if (conversation.deletedAt !== null) {
    return {
      status: 200,
      body: {
        action: 'delete_conversation',
        outcome: 'already',
        conversationId: conversation.id,
        messagesDeleted: 0,
        chunksTombstoned: 0,
      },
    };
  }
  const verdict = canRemoveMemory({ authorId: conversation.authorId }, actor);
  if (!verdict.allowed) {
    return failure(403, 'NOT_YOURS', CONVERSATION_DELETE_DENIED_MESSAGE);
  }

  const deleted = await deps.store.deleteConversation(conversation.id, actor.userId);
  if (!deleted.ok) {
    log.error('conversation delete failed', {
      error: deleted.error,
      conversationId: conversation.id,
    });
    return mapMemoryFailure(deleted.error);
  }
  if (deleted.value.already) {
    return {
      status: 200,
      body: {
        action: 'delete_conversation',
        outcome: 'already',
        conversationId: conversation.id,
        messagesDeleted: 0,
        chunksTombstoned: 0,
      },
    };
  }
  const audited = await record(
    deps,
    actor,
    'CONVERSATION_DELETED',
    'conversations',
    conversation.id,
    log,
  );
  if (audited !== null) return audited;
  // Counts, never content — the same discipline as the chunk delete above.
  log.info('conversation deleted', {
    conversationId: conversation.id,
    actorId: actor.userId,
    as: verdict.because,
    messagesDeleted: deleted.value.messagesDeleted,
    chunksTombstoned: deleted.value.chunksTombstoned,
    factsUnlinked: deleted.value.factsUnlinked,
  });
  return {
    status: 200,
    body: {
      action: 'delete_conversation',
      outcome: 'deleted',
      conversationId: conversation.id,
      messagesDeleted: deleted.value.messagesDeleted,
      chunksTombstoned: deleted.value.chunksTombstoned,
    },
  };
}
