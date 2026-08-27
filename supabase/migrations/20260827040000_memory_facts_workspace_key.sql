-- Stage 3 part 3, review (27 Aug 2026): a workspace note is unique by KEY, not by
-- (author, key). Amends the uniqueness half of D45 — see MEMORY.md D54.
--
-- THE GAP THIS CLOSES. `memory_facts_live_key_uniq` was `(user_id, scope, key) where
-- superseded_by is null`, and `upsert_memory_fact` looked the live row up by the same three
-- columns. For a PRIVATE note that is exactly right. For a WORKSPACE note it was wrong in a
-- way that only shows up once there is more than one person: memory is one brain (D33), the
-- controlled vocabulary exists precisely so that "tone" and "writing style" cannot become
-- two notes that contradict each other (D44) — and yet two different staff members could
-- each hold a live `writing:tone`, both handed to the model on every single turn, saying
-- opposite things, with nothing anywhere reporting a problem. The extractor would even help
-- it happen: it is shown the live keys and told to reuse one, so the SECOND person's
-- statement arrives with `replaces: 'writing:tone'`, and the upsert then inserted a second
-- row because no live row existed for *that user* and that key. One user today; part 4 adds
-- staff, so this is days away, not months.
--
-- WHAT CHANGES. Two partial unique indexes instead of one, each matching the scope's own
-- notion of identity:
--   workspace — one live row per `key`, whoever wrote it (the business has one answer);
--   user      — one live row per `(user_id, key)` (a private note is per person).
-- `upsert_memory_fact` looks up and locks by the same shape, so the write path and the
-- constraint cannot disagree.
--
-- WHAT HAPPENS WHEN TWO PEOPLE RACE on one workspace key. Both take the SAME transaction
-- advisory lock — it is now hashed over `(scope, key)` for workspace rows rather than over
-- the caller, which is the whole point: two different callers must contend, not pass each
-- other. The second waits; when it proceeds its `select … for update` re-reads under READ
-- COMMITTED and sees the first one's row as live, so it supersedes THAT row. The loser is
-- the earlier writer: their row keeps its value, its author and its date, gains
-- `superseded_by` pointing at the winner, and shows on the memory page under "Earlier
-- wording" as *replaced*. One live row, always. Nobody gets an error, nothing is lost, and
-- last-writer-wins is visible rather than silent. (If a caller ran REPEATABLE READ instead
-- of the default, it would get a serialization failure rather than a wrong answer — the
-- correct failure mode.)
--
-- BACKFILL. Any live workspace duplicates that already exist are collapsed first, keeping
-- the NEWEST by `(created_at, id)` — the same rule the racing case produces — and pointing
-- the others at it, so the history reads the same way whether the collision happened before
-- or after this migration. On the live project `memory_facts` holds a handful of rows and
-- one author, so this is expected to change nothing; it is written to be correct anyway,
-- because a migration that assumes its own table is empty is a migration that fails once.
--
-- Reversible:
--   drop index public.memory_facts_live_user_key_uniq;
--   drop index public.memory_facts_live_workspace_key_uniq;
--   create unique index memory_facts_live_key_uniq
--     on public.memory_facts (user_id, scope, key) where superseded_by is null;
--   (and restore upsert_memory_fact from migration 20260827010000)

-- (1) Collapse pre-existing live workspace duplicates: newest wins, the rest point at it.
with ranked as (
  select id,
         key,
         first_value(id) over (
           partition by key order by created_at desc, id desc
         ) as winner_id
  from public.memory_facts
  where scope = 'workspace' and superseded_by is null
)
update public.memory_facts f
set superseded_by = r.winner_id
from ranked r
where f.id = r.id and r.id <> r.winner_id;

-- (2) Identity per scope.
drop index if exists public.memory_facts_live_key_uniq;

create unique index memory_facts_live_workspace_key_uniq
  on public.memory_facts (key)
  where scope = 'workspace' and superseded_by is null;

create unique index memory_facts_live_user_key_uniq
  on public.memory_facts (user_id, key)
  where scope = 'user' and superseded_by is null;

comment on column public.memory_facts.key is
  '<category>:<slug>. Category is one of writing|audience|business|offer|process|personal; slug is lowercase kebab-case. ONE live row per key at workspace scope, whoever wrote it (the business has one answer); one live row per (user_id, key) at user scope.';

-- (3) The write path, matching those two shapes.
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

  -- Serialise writers of one note for the length of this transaction. A workspace note is
  -- one note for the business, so the lock must NOT include the caller — otherwise two
  -- people writing the same key would take different locks, pass each other, and collide on
  -- the unique index instead of superseding one another.
  if p_scope = 'workspace' then
    perform pg_advisory_xact_lock(hashtext('workspace|' || p_key));

    select * into v_live
    from public.memory_facts f
    where f.scope = 'workspace' and f.key = p_key and f.superseded_by is null
    for update;
  else
    perform pg_advisory_xact_lock(hashtext(p_user_id::text || '|user|' || p_key));

    select * into v_live
    from public.memory_facts f
    where f.user_id = p_user_id and f.scope = 'user' and f.key = p_key
      and f.superseded_by is null
    for update;
  end if;
  v_had_live := found;

  -- Already what the note says — including when someone else said it first. Nothing to
  -- write, nothing to supersede, and the caller is told so rather than given a new row.
  if v_had_live and v_live.value = p_value then
    return query select v_live.id, null::uuid, 'unchanged'::text;
    return;
  end if;

  if v_had_live then
    -- Step out of the partial unique index without breaking the self-FK.
    update public.memory_facts set superseded_by = v_live.id where memory_facts.id = v_live.id;
  end if;

  -- The new row's author is whoever made THIS change, which for a workspace note may not be
  -- the author of the row it replaces. Who changed what is also an audit_log row.
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
