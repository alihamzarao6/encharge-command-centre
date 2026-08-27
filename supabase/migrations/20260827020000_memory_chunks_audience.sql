-- Stage 3 part 2 review (27 Aug 2026): the audience a chunk's work was aimed at is stored
-- with the chunk and embedded in its header.
--
-- Why now: retrieval measured a related request missing the floor purely on audience
-- wording ("…for young Perth couples" → 0.36 against a note about a renting-vs-buying ad),
-- and almost everything the client asks for is framed by audience — first home buyers,
-- tradies, refinancers, investors. The header that gets embedded is reproducible from
-- stored columns (SCHEMA.md §4), so the audience has to be a column; adding it later would
-- mean re-summarising and re-embedding every chunk written in between.
--
-- `audience` is the summariser's short answer to "who was this aimed at" (≤ 120 chars) or
-- null when the messages had none. `match_memory_chunks` returns it so the recalled line
-- can show it.
--
-- Reversible:
--   (re-create match_memory_chunks from migration 20260827010000)
--   alter table public.memory_chunks drop constraint memory_chunks_audience_length;
--   alter table public.memory_chunks drop column audience;

alter table public.memory_chunks
  add column audience text;

alter table public.memory_chunks
  add constraint memory_chunks_audience_length
  check (audience is null or (length(audience) between 1 and 120));

comment on column public.memory_chunks.audience is
  'Who the work in this range was aimed at, as the summariser stated it (≤ 120 chars); null when there was none. Part of the embedded header.';

drop function if exists public.match_memory_chunks(extensions.vector, uuid, uuid, integer, integer, double precision);

create function public.match_memory_chunks(
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

revoke execute on function public.match_memory_chunks(extensions.vector, uuid, uuid, integer, integer, double precision) from public, anon, authenticated;
grant execute on function public.match_memory_chunks(extensions.vector, uuid, uuid, integer, integer, double precision) to service_role;
