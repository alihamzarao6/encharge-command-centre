-- Claude memory layer (SCHEMA.md §4, D24, D33; task 2.2.5).
-- All four tables ship now, in the first migration set, with user_id and scope — even the
-- two Stage 3 does not populate yet. One user today, but adding an ownership column to a
-- table with rows in it is a migration against live data that has to guess who owns what.
--
-- user_id: "follows him across devices" = keyed on who is logged in, not the device (the
--   prototype's localStorage failure). Never null. FK deliberately has NO cascade: deleting
--   an auth user who authored memory would destroy workspace memory the whole business was
--   promised ("one brain", D33). People are deactivated in app_users, not deleted.
-- scope: 'workspace' (default — memory is shared) | 'user' (the opt-in private exception).
--   On messages and memory_chunks there is no default: the value is always derived from the
--   parent conversation by trigger, and a default would silently paper over a failed sync.
--
-- Reversible: drop the triggers, functions and tables in reverse order.

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  scope text not null default 'workspace' check (scope in ('user', 'workspace')),
  title text,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index conversations_user_id_idx on public.conversations (user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id),
  -- Denormalised from the parent conversation so the RLS policy is a column check, not a
  -- join. The triggers below keep them equal to the parent's (SCHEMA.md §4).
  user_id uuid not null references auth.users (id),
  scope text not null check (scope in ('user', 'workspace')),
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text,
  tool_calls jsonb,
  tool_results jsonb,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);

create index messages_conversation_id_idx on public.messages (conversation_id);
create index messages_user_id_idx on public.messages (user_id);

-- Semantic memory. Populated from Stage 3 (Voyage voyage-3, 1024 dimensions — R5).
create table public.memory_chunks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id),
  user_id uuid not null references auth.users (id),
  scope text not null check (scope in ('user', 'workspace')),
  summary text not null,
  embedding extensions.vector (1024),
  turn_range int4range,
  created_at timestamptz not null default now()
);

create index memory_chunks_conversation_id_idx on public.memory_chunks (conversation_id);
create index memory_chunks_user_id_idx on public.memory_chunks (user_id);
create index memory_chunks_embedding_idx on public.memory_chunks
  using ivfflat (embedding extensions.vector_cosine_ops);

-- Structured memory. Populated from Stage 3. Append-only with supersede (D10): updating
-- inserts a new row and sets superseded_by on the old one; current facts are
-- `where superseded_by is null`.
create table public.memory_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  scope text not null default 'workspace' check (scope in ('user', 'workspace')),
  key text not null,
  value text,
  confidence numeric(3, 2),
  source_message_id uuid references public.messages (id),
  superseded_by uuid references public.memory_facts (id),
  embedding extensions.vector (1024),
  created_at timestamptz not null default now()
);

-- Two live values for one key cannot coexist (SCHEMA.md §4).
create unique index memory_facts_live_key_uniq
  on public.memory_facts (user_id, scope, key)
  where superseded_by is null;

create index memory_facts_user_id_idx on public.memory_facts (user_id);
create index memory_facts_source_message_id_idx on public.memory_facts (source_message_id);
create index memory_facts_superseded_by_idx on public.memory_facts (superseded_by);

-- ---------------------------------------------------------------------------------------
-- Parent-sync triggers: messages.user_id/scope and memory_chunks.user_id/scope are always
-- the parent conversation's values. Both directions are enforced —
--   (a) inserting or updating a child row pulls the values from the parent, so a child can
--       never disagree with its conversation, and
--   (b) changing a conversation's user_id or scope cascades to its children, so marking a
--       conversation private ('user') actually makes its messages private. Without (b),
--       flipping a conversation to private would leave every existing message readable at
--       workspace scope — a silent privacy failure.
-- security invoker (the default): all writes come through service_role, which bypasses RLS;
-- a definer function would only widen the surface for no gain.
-- ---------------------------------------------------------------------------------------

create or replace function public.sync_child_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent record;
begin
  select user_id, scope into parent
  from public.conversations
  where id = new.conversation_id;

  if not found then
    -- FK makes this unreachable in practice; belt-and-braces against a dropped constraint.
    raise exception 'conversation % does not exist', new.conversation_id;
  end if;

  new.user_id := parent.user_id;
  new.scope := parent.scope;
  return new;
end;
$$;

create trigger messages_sync_ownership
  before insert or update of conversation_id, user_id, scope on public.messages
  for each row
  execute function public.sync_child_ownership();

create trigger memory_chunks_sync_ownership
  before insert or update of conversation_id, user_id, scope on public.memory_chunks
  for each row
  execute function public.sync_child_ownership();

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
    set user_id = new.user_id, scope = new.scope
    where conversation_id = new.id;
  return new;
end;
$$;

create trigger conversations_cascade_ownership
  after update of user_id, scope on public.conversations
  for each row
  when (old.user_id is distinct from new.user_id or old.scope is distinct from new.scope)
  execute function public.cascade_conversation_ownership();
