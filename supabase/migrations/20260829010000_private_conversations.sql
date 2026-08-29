-- Stage 3 part 5 (FND-340): private conversations — R27, answered by the client.
--
-- He was given three options for who sees whose conversations and chose the second:
--
--     "Each person's chats are their own. Nobody sees anyone else's. You, as the owner, can
--      see everybody's. What the assistant LEARNS still goes into the one shared brain, so
--      the team still benefits from each other's work."
--
-- That last sentence is the whole of this migration. Everything else the schema already
-- does. Since 20260824010200 a `memory_chunks` row has taken its conversation's `scope` by
-- trigger, so marking a conversation private made its summaries private too — which is
-- option THREE, and explicitly not what he chose. Under option two a private conversation
-- must produce a WORKSPACE chunk.
--
-- ---------------------------------------------------------------------------------------
-- (1) WHY A TRIGGER SPLIT AND NOT A COLUMN
-- ---------------------------------------------------------------------------------------
-- The obvious alternative is a column on `conversations` saying what scope its chunks
-- should take. It was rejected: it would be a second privacy dial, settable independently
-- of the first, with four combinations of which the client asked for one. A setting that
-- can be wrong is worse than no setting, and "a chunk is workspace" is not a preference —
-- it is what option two MEANS.
--
-- So the two children stop sharing one function:
--
--   messages       — sync_child_ownership(), UNCHANGED. user_id and scope both follow the
--                    parent, in both directions. The words of a private conversation are
--                    private, and flipping a conversation private makes its EXISTING
--                    messages private in the same statement. This is the guarantee the
--                    whole feature rests on and nothing here touches it.
--
--   memory_chunks  — sync_chunk_ownership(), NEW. user_id still follows the parent, so
--                    attribution ("from a teammate"), canRemoveMemory (D52) and a
--                    reassigned conversation all keep working exactly as before. scope is
--                    no longer copied from anywhere: it is set to 'workspace', full stop.
--
-- What the trigger still guarantees afterwards, stated plainly, because it was doing real
-- work and a reader should not have to infer what survived:
--   * a chunk's user_id is ALWAYS exactly its conversation's author — enforced on insert,
--     on update of the three columns, and on a change to the parent (the cascade below);
--   * a chunk's scope is ALWAYS 'workspace' — which is a STRONGER guarantee than it had.
--     Before, scope was a copy of a value that could be anything the parent held; now it is
--     a constant, and the check constraint refuses any other value even if the trigger is
--     disabled. A copy can drift. A constant cannot.
--
-- The check constraint is deliberate friction: the day someone wants a genuinely private
-- summary, that is a client conversation and a migration, not a stray UPDATE.
--
-- ---------------------------------------------------------------------------------------
-- (2) EXISTING ROWS
-- ---------------------------------------------------------------------------------------
-- Every conversation in the live database is 'workspace' and always has been: `scope` has
-- accepted 'user' since the first migration but NOTHING has ever been able to set it — no
-- UI, no CLI, no server path (R27 in tasks/TASKS.md is precisely that observation). So the
-- normalising update below is expected to touch zero rows. It runs anyway, because a
-- constraint added on the strength of "there cannot be any" is a constraint that fails on
-- somebody's laptop at the worst moment.
--
-- Conversations themselves are NOT migrated. They stay workspace, which is both their
-- current state and the resting state the client chose. Flipping existing conversations to
-- private would be us making a privacy decision on someone's behalf, silently, in the
-- direction of less sharing than they had yesterday.
--
-- ---------------------------------------------------------------------------------------
-- (3) ADMIN ACCESS IS NOT IN THIS FILE, AND THAT IS THE DECISION
-- ---------------------------------------------------------------------------------------
-- "You, as the owner, can see everybody's" could have been one more OR in the RLS policy:
--   (scope = 'workspace' or user_id = auth.uid() or <caller is admin>)
-- It is not, and the policies on `conversations` and `messages` are not touched by this
-- migration at all. Two reasons, and the second is the one that decided it:
--
--   * Postgres has no SELECT trigger. An RLS bypass is invisible by construction: an
--     administrator could read every private conversation in the workspace, every day, and
--     leave not one row anywhere saying so. Reading someone's private messages is exactly
--     the kind of act that should be recorded.
--   * The policy as written is what makes the promise true. Widening it for a role means
--     the database no longer refuses — it defers to a boolean on a row. Deny-by-default is
--     worth more than the convenience.
--
-- So an admin reads a private conversation through the memory Edge Function, which verifies
-- the caller from their JWT, checks is_admin, reads as service_role, and writes a
-- CONVERSATION_ADMIN_READ row into audit_log naming the actor and the conversation. The
-- LISTING an admin sees carries no title and no content — author, dates and a message count
-- only — which is why the listing is not audited and the read is. See src/lib/memory/page.ts.
--
-- ---------------------------------------------------------------------------------------
-- Reversible:
--   alter table public.memory_chunks drop constraint memory_chunks_scope_workspace;
--   drop trigger memory_chunks_sync_ownership on public.memory_chunks;
--   create trigger memory_chunks_sync_ownership
--     before insert or update of conversation_id, user_id, scope on public.memory_chunks
--     for each row execute function public.sync_child_ownership();
--   drop function public.sync_chunk_ownership();
--   (re-create cascade_conversation_ownership from migration 20260824010200)
-- ---------------------------------------------------------------------------------------

-- (a) Normalise before constraining. Expected: 0 rows.
update public.memory_chunks
set scope = 'workspace'
where scope <> 'workspace';

-- (b) The chunk's own sync function. Author from the parent; scope a constant.
create or replace function public.sync_chunk_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent record;
begin
  select user_id into parent
  from public.conversations
  where id = new.conversation_id;

  if not found then
    -- FK makes this unreachable in practice; belt-and-braces against a dropped constraint.
    raise exception 'conversation % does not exist', new.conversation_id;
  end if;

  new.user_id := parent.user_id;
  -- NOT the parent's scope (R27, option two): what the assistant learns is shared even when
  -- the conversation it learned it in is not. The constraint below says the same thing to
  -- anyone who reaches the table without going through this trigger.
  new.scope := 'workspace';
  return new;
end;
$$;

comment on function public.sync_chunk_ownership() is
  'Stage 3 part 5 (R27). A chunk takes its conversation''s AUTHOR and always workspace scope: a private conversation still contributes to the shared brain. Replaces sync_child_ownership() on memory_chunks; messages keep the original, which copies both columns.';

drop trigger memory_chunks_sync_ownership on public.memory_chunks;

create trigger memory_chunks_sync_ownership
  before insert or update of conversation_id, user_id, scope on public.memory_chunks
  for each row
  execute function public.sync_chunk_ownership();

-- (c) The cascade stops carrying scope to chunks. Byte-for-byte the part-1 function except
-- for the memory_chunks statement, which now sets user_id only — a conversation changing
-- hands still moves its notes to the new author, and a conversation going private no longer
-- takes its notes out of the shared brain on the way.
create or replace function public.cascade_conversation_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.messages
    set user_id = new.user_id, scope = new.scope
    where conversation_id = new.id;
  update public.memory_chunks
    set user_id = new.user_id
    where conversation_id = new.id;
  return new;
end;
$$;

comment on function public.cascade_conversation_ownership() is
  'A conversation''s user_id and scope cascade to its messages, so flipping it private makes its existing messages private in the same statement. Only user_id cascades to memory_chunks: chunk scope is always workspace (R27, sync_chunk_ownership).';

-- (d) The invariant, stated where it cannot be argued with. NOT VALID is deliberately NOT
-- used: (a) above has already made every row conform, so the table scan is honest and cheap
-- on a table this size, and a constraint that has never been checked is a comment.
alter table public.memory_chunks
  add constraint memory_chunks_scope_workspace check (scope = 'workspace');

comment on column public.memory_chunks.scope is
  'Always ''workspace'' (memory_chunks_scope_workspace, R27): the note the assistant writes about a conversation reaches the whole team even when the conversation is private to its author. The column is kept rather than dropped so the RLS policy stays a plain column check and a future genuinely-private note is a migration, not a rewrite.';

comment on column public.conversations.scope is
  '''workspace'' (the default and the resting state) or ''user'' — the author''s opt-in "Just me". A ''user'' conversation and its messages are readable only by their author under RLS; an administrator reads them through the audited server path, never through a policy. Its memory_chunks stay workspace.';
