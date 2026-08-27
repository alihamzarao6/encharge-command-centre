-- Stage 3 part 3 (FND-320): the memory page needs one thing the schema does not yet have —
-- a way to REMOVE something without lying about it. Two removals, two shapes, because a
-- fact and a chunk are not the same kind of thing (SCHEMA.md §4).
--
-- 1. FORGETTING A FACT needs no column. `memory_facts` is append-only with supersede (D10)
--    and the live predicate is `superseded_by is null`, so "no longer live, and nothing
--    replaced it" is expressible as a SELF-REFERENCE: superseded_by = id. The row survives
--    with its value, its author and its date; retrieval (`currentFacts`, the extractor's
--    `existing` list) drops it with no change to any read path; the partial unique index
--    frees the key so the same note can be stated again later. `upsert_memory_fact` already
--    uses the self-reference transiently for exactly this reason — it is the one value of
--    `superseded_by` that cannot mean "replaced by another row". This migration only
--    documents the convention; the update itself is a single idempotent statement
--    (`set superseded_by = id where id = $1 and superseded_by is null`) issued by the
--    memory Edge Function as service_role.
--
-- 2. DELETING A CHUNK does need columns. A chunk is a summary plus a claim over a range of
--    message ordinals, and `memory_chunks_no_overlap` is what stops the same range being
--    summarised twice. Deleting the row would hand the range back: the very next turn in
--    that conversation would re-summarise it and the note the user removed would reappear,
--    silently, having cost money twice. So a delete is a TOMBSTONE — the row stays and keeps
--    its `turn_range`, so the range is never summarised again, while everything that made it
--    memory is destroyed: `summary` replaced with a marker (the column is NOT NULL),
--    `audience` and `embedding` set to null. A null embedding is already invisible to
--    `match_memory_chunks`; `deleted_at` states the intent explicitly rather than relying on
--    that side effect, and `deleted_by` records who did it.
--
--    The text is not copied anywhere on the way out: `memory_chunks` deliberately has NO
--    audit trigger (the triggers migration audits consumer_leads, review_queue, memory_facts
--    and app_users only), because a before-image would preserve in `audit_log` exactly the
--    sentence the user asked to be rid of. The deletion is recorded in `audit_log` by the
--    application, by id and actor, with no content.
--
-- Reversible:
--   -- restore the part-2 body of match_memory_chunks (migration 20260827010000), then:
--   alter table public.memory_chunks drop column deleted_by;
--   alter table public.memory_chunks drop column deleted_at;

-- (1) Chunk tombstone columns.
alter table public.memory_chunks
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id);

comment on column public.memory_chunks.deleted_at is
  'Set when a user removed this note from the memory page (Stage 3 part 3). The row is a tombstone: turn_range is kept so the range is never re-summarised, while summary is replaced with a marker and audience/embedding are nulled. Never retrieved.';
comment on column public.memory_chunks.deleted_by is
  'The app_users member who removed it. The deletion is also an audit_log row (entity_type memory_chunk); neither carries the removed text.';

comment on column public.memory_facts.superseded_by is
  'Set when a newer value replaced this row (append-only, D10). Current facts are `where superseded_by is null`. Written by upsert_memory_fact; ALSO set to the row''s OWN id when a user forgot the note from the memory page without replacing it (Stage 3 part 3) — the row stops being live and nothing supersedes it.';

-- (2) The retrieval read path states the exclusion rather than inheriting it.
-- Byte-identical to migration 20260827020000's body except for `k.deleted_at is null`: a
-- tombstoned chunk has a null embedding and was already excluded by the first predicate, but
-- a reader of this function should not have to work that out. Same signature and same return
-- columns, so `create or replace` applies and the part-2 grants survive untouched. WHAT IS
-- RETRIEVED IS OTHERWISE UNCHANGED — same ordering, same floor, same scoping (D46).
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
  audience text,
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
    select k.id, k.conversation_id, c.title, k.audience, k.summary, k.turn_range, k.created_at,
           1 - (k.embedding operator(extensions.<=>) p_query) as similarity
    from public.memory_chunks k
    join public.conversations c on c.id = k.conversation_id
    where k.embedding is not null
      and k.deleted_at is null
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
  select v.id, v.conversation_id, v.title, v.audience, v.summary, v.turn_range::text, v.created_at, v.similarity
  from visible v
  where v.similarity >= p_min_similarity
  order by v.similarity desc;
$$;
