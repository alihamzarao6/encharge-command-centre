-- Stage 3 part 2 (FND-310): memory_facts becomes a written table, and retrieval gets its
-- two database-side operations. Everything the fact store and the retriever need the
-- database to guarantee, in one logical unit:
--
-- 1. A fact always has a value, a well-formed key and a confidence in [0, 1]. `key` is
--    `<category>:<slug>` — a controlled category (writing, audience, business, offer,
--    process, personal) and a free lowercase slug — so "tone" and "writing style" land
--    under one category the extractor can see and reuse (SCHEMA.md §4). The table is
--    empty on the live project (0 rows, 27 Aug) so NOT NULL needs no backfill.
--
-- 2. `upsert_memory_fact` — the ONLY write path. Append-only with supersede (D10): a new
--    value for a live key inserts a new row and points the old row's `superseded_by` at
--    it; an identical value is a no-op ('unchanged'); a new key is a plain insert. The
--    partial unique index `memory_facts_live_key_uniq` forbids two live rows for one key,
--    so the swap has to happen inside one transaction: the old row is marked with a
--    self-reference first (it stops being "live" without breaking the FK), the new row is
--    inserted, then the old row is pointed at the new one. A transaction-scoped advisory
--    lock on (user, scope, key) serialises two callers racing on the same key, so the
--    second one supersedes the FIRST one's new row instead of failing on the index.
--
-- 3. `match_memory_chunks` — cosine top-k over memory_chunks for one caller: workspace
--    chunks plus the caller's own private ones (the RLS rule, restated here because the
--    caller is service_role, which bypasses RLS), never a deleted conversation, never a
--    chunk whose messages are already in the turn's verbatim history window (the current
--    conversation's tail), and never below the similarity floor. Ordered by the `<=>`
--    operator so the HNSW index (D42) is used. Similarity = 1 - cosine distance.
--
-- Both functions are SECURITY INVOKER and executable by service_role only: the browser
-- holds the anon key and an authenticated session, and neither may search memory
-- server-side on someone else's behalf or write a fact. Postgres grants EXECUTE on a new
-- function to PUBLIC by default, so it is revoked explicitly.
--
-- Reversible:
--   drop function if exists public.match_memory_chunks(extensions.vector, uuid, uuid, integer, integer, double precision);
--   drop function if exists public.upsert_memory_fact(uuid, text, text, text, numeric, uuid);
--   alter table public.memory_facts drop constraint memory_facts_confidence_range;
--   alter table public.memory_facts drop constraint memory_facts_key_format;
--   alter table public.memory_facts alter column value drop not null;

-- (1) Shape.
alter table public.memory_facts
  alter column value set not null;

alter table public.memory_facts
  add constraint memory_facts_key_format
  check (key ~ '^(writing|audience|business|offer|process|personal):[a-z0-9]+(-[a-z0-9]+)*$' and length(key) <= 72);

alter table public.memory_facts
  add constraint memory_facts_confidence_range
  check (confidence is null or (confidence >= 0 and confidence <= 1));

comment on column public.memory_facts.key is
  '<category>:<slug>. Category is one of writing|audience|business|offer|process|personal; slug is lowercase kebab-case. One live row per (user_id, scope, key).';
comment on column public.memory_facts.superseded_by is
  'Set when a newer value replaced this row (append-only, D10). Current facts are `where superseded_by is null`. Written only by upsert_memory_fact.';

-- (2) The write path.
create or replace function public.upsert_memory_fact(
  p_user_id uuid,
  p_scope text,
  p_key text,
  p_value text,
  p_confidence numeric,
  p_source_message_id uuid
)
returns table (id uuid, superseded_id uuid, outcome text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_live public.memory_facts%rowtype;
  v_had_live boolean := false;
  v_new_id uuid;
begin
  if p_scope not in ('user', 'workspace') then
    raise exception 'scope must be user or workspace' using errcode = '22023';
  end if;

  -- Serialise writers of one key for the length of this transaction.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text || '|' || p_scope || '|' || p_key));

  select * into v_live
  from public.memory_facts f
  where f.user_id = p_user_id and f.scope = p_scope and f.key = p_key
    and f.superseded_by is null
  for update;
  v_had_live := found;

  if v_had_live and v_live.value = p_value then
    return query select v_live.id, null::uuid, 'unchanged'::text;
    return;
  end if;

  if v_had_live then
    -- Step out of the partial unique index without breaking the self-FK.
    update public.memory_facts set superseded_by = v_live.id where memory_facts.id = v_live.id;
  end if;

  insert into public.memory_facts (user_id, scope, key, value, confidence, source_message_id)
  values (p_user_id, p_scope, p_key, p_value, p_confidence, p_source_message_id)
  returning memory_facts.id into v_new_id;

  if v_had_live then
    update public.memory_facts set superseded_by = v_new_id where memory_facts.id = v_live.id;
    return query select v_new_id, v_live.id, 'superseded'::text;
    return;
  end if;

  return query select v_new_id, null::uuid, 'inserted'::text;
end;
$$;

-- (3) The read path for retrieval.
create or replace function public.match_memory_chunks(
  p_query extensions.vector(1024),
  p_user_id uuid,
  p_conversation_id uuid,
  p_history_messages integer,
  p_limit integer,
  p_min_similarity double precision
)
returns table (
  id uuid,
  conversation_id uuid,
  title text,
  summary text,
  turn_range text,
  created_at timestamptz,
  similarity double precision
)
language sql
security invoker
stable
set search_path = public
as $$
  with visible as (
    select k.id, k.conversation_id, c.title, k.summary, k.turn_range, k.created_at,
           1 - (k.embedding operator(extensions.<=>) p_query) as similarity
    from public.memory_chunks k
    join public.conversations c on c.id = k.conversation_id
    where k.embedding is not null
      and c.deleted_at is null
      and (k.scope = 'workspace' or k.user_id = p_user_id)
      and (
        p_conversation_id is null
        or k.conversation_id <> p_conversation_id
        or upper(k.turn_range) <= (
          (select count(*) from public.messages m where m.conversation_id = p_conversation_id)
          - greatest(p_history_messages, 0) + 1
        )
      )
    order by k.embedding operator(extensions.<=>) p_query
    limit greatest(p_limit, 0)
  )
  select v.id, v.conversation_id, v.title, v.summary, v.turn_range::text, v.created_at, v.similarity
  from visible v
  where v.similarity >= p_min_similarity
  order by v.similarity desc;
$$;

revoke execute on function public.upsert_memory_fact(uuid, text, text, text, numeric, uuid) from public, anon, authenticated;
revoke execute on function public.match_memory_chunks(extensions.vector, uuid, uuid, integer, integer, double precision) from public, anon, authenticated;
grant execute on function public.upsert_memory_fact(uuid, text, text, text, numeric, uuid) to service_role;
grant execute on function public.match_memory_chunks(extensions.vector, uuid, uuid, integer, integer, double precision) to service_role;
