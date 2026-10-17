-- Milestone 5 part 4 — the settings page: forgetting a learned document from one screen
-- (brief of 17 Oct 2026, decisions 4 and 5).
--
-- One function. No table, no column, no policy, no grant to any browser role.
--
-- ---------------------------------------------------------------------------------------
-- WHY A MIGRATION AT ALL
-- ---------------------------------------------------------------------------------------
-- Part 5 already has `forget_knowledge` (the passages, the summary, the tombstone) and the
-- files path has `remove_conversation_file` (the attachment's text, name and hash). Forgetting
-- a document needs BOTH, for every copy of it, because the attachment row keeps the document's
-- text for 30 days (a web page one day) and a turn in that conversation reads it from there:
-- whole when it fits, its opening pages when it does not — whatever the knowledge row says
-- (src/lib/files/context.ts). A document whose learned copy is gone but whose attachment is
-- still ready keeps answering in its own conversation.
--
-- Done from the server as separate calls, a failure between them is unrecoverable: each call
-- clears the content hash, and the hash is the only thing that finds the other copies. The
-- second press of the button would then find a tombstone and nothing to do, while an
-- attachment elsewhere still held the text. So it is one function, one transaction: every
-- copy is found and locked first, the person is checked against all of them, and either all
-- of it goes or none of it does.
--
-- ---------------------------------------------------------------------------------------
-- WHAT IT REMOVES (the whole list, as traced in the code on 17 Oct)
-- ---------------------------------------------------------------------------------------
--   * every `ready` attachment holding the same bytes, in any conversation: its pages
--     (`conversation_file_pages`) deleted, its name, hash, address and Drive file cleared —
--     through `remove_conversation_file`, so it is audited exactly as a removal in the thread;
--   * every learned copy of the same bytes (`knowledge_sources`): its passages and its
--     summary (`knowledge_chunks`, both kinds) deleted, the row left as a tombstone that names
--     nothing — through `forget_knowledge`, the trigger and the direct call both;
--   * a document whose file was purged after 30 days: the attachment is already a tombstone
--     and the learned copy is the only thing left, and it goes.
-- What it does not touch, deliberately: `messages` — what was said in a conversation stays
-- that conversation's record (an answer already written is not the document); the memory
-- summaries — they never held document text, because a turn with any document in front of the
-- model is kept out of the summariser (D89, part 5); `audit_log` — ids and counts only.
--
-- WHO: an active member of staff who is an administrator, or who added every copy of it. The
-- rule every removal in this app follows (D52: the person who added it, or an administrator),
-- applied to all the copies at once — a non-administrator never removes somebody else's
-- attachment by forgetting their own.
--
-- Raises: KF001 the caller is not an active member of staff · KF002 something survived (never
-- expected; the transaction is undone rather than leaving half a forget).
--
-- Reversible:
--   drop function public.forget_document(uuid, uuid);

create or replace function public.forget_document(
  p_source_id uuid,
  p_actor uuid
)
returns table (outcome text, sources integer, files integer, chunks integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_admin boolean;
  v_hash text;
  v_status text;
  v_files uuid[];
  v_sources uuid[];
  v_chunks integer;
  v_file uuid;
  v_removed integer := 0;
begin
  select u.is_admin into v_admin
  from public.app_users u
  where u.user_id = p_actor and u.is_active;
  if not found then
    raise exception 'user % is not an active member of staff', p_actor using errcode = 'KF001';
  end if;

  -- The hash, read without a lock: it changes only when the source is forgotten, and that is
  -- checked again below, under the locks.
  select s.content_hash into v_hash from public.knowledge_sources s where s.id = p_source_id;
  if not found then
    return query select 'not_found'::text, 0, 0, 0;
    return;
  end if;

  -- Locks in the order the removal path takes them — attachments, then learned copies, each
  -- by id — so this and a removal in the thread wait for each other instead of deadlocking.
  select coalesce(array_agg(x.id order by x.id), '{}'::uuid[]) into v_files
  from (
    select f.id from public.conversation_files f
    where v_hash is not null and f.content_hash = v_hash and f.status = 'ready'
    order by f.id
    for update
  ) x;
  select coalesce(array_agg(x.id order by x.id), '{}'::uuid[]) into v_sources
  from (
    select s.id from public.knowledge_sources s
    where s.status <> 'forgotten'
      and (s.id = p_source_id or (v_hash is not null and s.content_hash = v_hash))
    order by s.id
    for update
  ) x;

  -- Under the locks: forgotten by somebody else while this waited (the second tab).
  select s.status into v_status from public.knowledge_sources s where s.id = p_source_id;
  if v_status = 'forgotten' then
    return query select 'already'::text, 0, 0, 0;
    return;
  end if;

  if not v_admin and (
    exists (
      select 1 from public.knowledge_sources s
      where s.id = any(v_sources) and s.uploaded_by is distinct from p_actor
    )
    or exists (
      select 1 from public.conversation_files f
      where f.id = any(v_files) and f.uploaded_by is distinct from p_actor
    )
  ) then
    return query select 'not_allowed'::text, 0, 0, 0;
    return;
  end if;

  select count(*)::integer into v_chunks
  from public.knowledge_chunks c
  where c.source_id = any(v_sources);

  -- Each removal's trigger forgets every learned copy of the same bytes on the way.
  foreach v_file in array v_files loop
    if public.remove_conversation_file(v_file, p_actor, 'user') then
      v_removed := v_removed + 1;
    end if;
  end loop;
  -- Whatever no attachment was left to take with it: the file purged after 30 days, or its
  -- conversation deleted.
  perform public.forget_knowledge(p_source_id, v_hash, p_actor, 'user');

  if exists (
    select 1 from public.knowledge_sources s where s.id = any(v_sources) and s.status <> 'forgotten'
  ) or exists (
    select 1 from public.knowledge_chunks c where c.source_id = any(v_sources)
  ) or exists (
    select 1 from public.conversation_files f where f.id = any(v_files) and f.status <> 'removed'
  ) then
    raise exception 'document % was not wholly forgotten', p_source_id using errcode = 'KF002';
  end if;

  return query select 'forgotten'::text, coalesce(array_length(v_sources, 1), 0), v_removed, v_chunks;
end;
$$;

comment on function public.forget_document(uuid, uuid) is
  'Milestone 5 part 4. Forgets a learned document from the settings page in one transaction: every ready attachment holding the same bytes is removed (its text, name and hash), every learned copy is forgotten (passages and summary deleted, tombstone left), each audited by id. An administrator, or the person who added every copy. Idempotent: a forgotten source answers already. service_role only.';

revoke all on function public.forget_document(uuid, uuid) from public, anon, authenticated;
grant execute on function public.forget_document(uuid, uuid) to service_role;
