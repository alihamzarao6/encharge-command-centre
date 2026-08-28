-- Stage 3 part 4 (FND-330): the Users page and conversation management.
--
-- Three things the schema does not yet have, and the reasoning for each.
--
-- (1) A ROSTER READ. `app_users` has been self-row-only since 20260824010500_rls.sql, which
--     is exactly right while the only question is "may this account in?" — but a page that
--     lists people cannot be built on a policy that returns one row. It also left the Memory
--     page unable to say who wrote a note, so a shared brain credits "a teammate" (D52,
--     TASKS 3.2.3a).
--
--     How far this widens, stated exactly: **every ACTIVE ALLOWLISTED member may SELECT
--     every app_users row.** Not one step further —
--       * `anon` still holds no grant and no policy on this table (or any other);
--       * `authenticated` still holds SELECT and nothing else — no INSERT, UPDATE or DELETE
--         policy exists for any role, so creating, deactivating and promoting still go
--         through the verified server path with the service role, exactly like memory writes;
--       * a NON-allowlisted account still reads zero rows (the predicate requires a row);
--       * a DEACTIVATED account still reads zero rows — including its own — because
--         is_active_staff() requires is_active. That is what App.tsx's sign-in check depends
--         on, so the widening must not, and does not, disturb it.
--     The table holds an email, a descriptive label and two booleans. There is no secret in
--     it: password hashes live in auth.users, which is not exposed through the Data API at
--     all. What it costs is that colleagues can see the list of colleagues, which is what a
--     staff directory is for.
--
--     The self-row policy is KEPT rather than replaced. Policies are permissive and OR'd, so
--     it changes nothing today; it is the floor that keeps sign-in working if the roster
--     policy is ever narrowed again.
--
--     is_active_staff() exists because the allowlist EXISTS-subquery every other policy uses
--     cannot be written inside a policy ON app_users — Postgres re-applies the policy to the
--     subquery and raises "infinite recursion detected in policy for relation app_users".
--     A security-definer function evaluates as its owner (postgres, BYPASSRLS) and breaks
--     the cycle. It is `stable` so the planner calls it once per query, and its search_path
--     is pinned so a caller cannot shadow `app_users` with their own table.
--
-- (2) DELETING A CONVERSATION, in one transaction. Four tables hang off a conversation and
--     they do NOT all mean the same thing, so the delete does not treat them the same:
--       * conversations — soft: `deleted_at` is set. Every read path already excludes it
--         (the app's lists, match_memory_chunks, chat.ts's resume check), and the row must
--         survive so surviving children and the audit row point at something real.
--       * messages — HARD. The words of the conversation are the thing being deleted; a
--         "delete" that leaves them selectable by anyone holding the id would be a lie. They
--         are safe to destroy here precisely because `messages` carries no audit trigger
--         (20260824010600) — the same reasoning that made a chunk delete a content-destroying
--         tombstone in 20260827030000: an audit before-image would preserve exactly the text
--         the person asked to be rid of.
--       * memory_chunks — TOMBSTONED, not deleted, with the identical shape a memory-page
--         delete uses: turn_range kept so no range is ever re-summarised, summary replaced
--         with the marker, audience and embedding destroyed. One mechanism, one promise.
--       * memory_facts — KEPT, live, untouched except for `source_message_id`, which is
--         nulled where it pointed at a message that is going (the FK cannot dangle). A
--         standing note is not a by-product of a conversation: it is something a person
--         deliberately told the business to remember, it is workspace knowledge in its own
--         right, and it is visible and removable on the Memory page. Deleting a conversation
--         must not silently empty the brain. The note keeps its value, author, date and
--         append-only history; what it loses is a pointer to a message that no longer exists.
--
--     One function rather than four statements from the client so a half-applied delete is
--     impossible, and so the counts the confirm step promised are the counts that happened.
--     Idempotent: a second call reports `already` and changes nothing.
--
-- (3) An index for the roster's most common read. `app_users` is tiny, but the users page
--     orders by email and the Memory page joins ids to emails on every load.
--
-- (4) THE LAST-ADMIN INVARIANT, serialised — see the block above set_staff_active below.
--
-- Reversible:
--   drop function public.set_staff_admin(uuid, boolean);
--   drop function public.set_staff_active(uuid, boolean);
--   drop function public.delete_conversation(uuid, uuid);
--   drop policy app_users_select_roster on public.app_users;
--   drop function public.is_active_staff();
--   drop index public.app_users_email_idx;

-- ---------------------------------------------------------------------------------------
-- (1) The roster read
-- ---------------------------------------------------------------------------------------

create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users u
    where u.user_id = (select auth.uid()) and u.is_active
  );
$$;

comment on function public.is_active_staff() is
  'True when the calling JWT belongs to an ACTIVE allowlisted staff member. security definer purely to break RLS recursion inside a policy on app_users itself; it reveals nothing about anyone but the caller.';

revoke execute on function public.is_active_staff() from public, anon;
grant execute on function public.is_active_staff() to authenticated, service_role;

create policy app_users_select_roster on public.app_users
  for select to authenticated
  using (public.is_active_staff());

create index app_users_email_idx on public.app_users (email);

comment on column public.app_users.is_admin is
  'May manage staff: create, deactivate, reactivate, reset a password, promote and demote. The second and last authorization fact (20260824020000) — `role` remains a descriptive label with no permission semantics. Changed only through the verified server path (src/lib/auth/admin.ts), never by the browser, and never by the holder on their own row.';

-- ---------------------------------------------------------------------------------------
-- (2) Deleting a conversation
-- ---------------------------------------------------------------------------------------

create or replace function public.delete_conversation(
  p_conversation_id uuid,
  p_actor uuid
)
returns table (
  already boolean,
  messages_deleted integer,
  chunks_tombstoned integer,
  facts_unlinked integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_locked public.conversations%rowtype;
  v_messages integer := 0;
  v_chunks integer := 0;
  v_facts integer := 0;
begin
  -- Serialise concurrent deletes of the same conversation for the length of this
  -- transaction: two taps on a slow phone connection must not both destroy and both report.
  select * into v_locked
  from public.conversations c
  where c.id = p_conversation_id
  for update;

  if not found then
    raise exception 'conversation % does not exist', p_conversation_id using errcode = '02000';
  end if;

  if v_locked.deleted_at is not null then
    return query select true, 0, 0, 0;
    return;
  end if;

  -- Facts first: the FK from memory_facts.source_message_id would otherwise refuse the
  -- message delete. The note itself is not touched — it stays live, with its own history.
  update public.memory_facts f
  set source_message_id = null
  where f.source_message_id in (
    select m.id from public.messages m where m.conversation_id = p_conversation_id
  );
  get diagnostics v_facts = row_count;

  delete from public.messages m where m.conversation_id = p_conversation_id;
  get diagnostics v_messages = row_count;

  -- The same tombstone a memory-page delete writes: the claim over the turn range survives,
  -- the content does not. Keep this marker in step with CHUNK_TOMBSTONE_SUMMARY in
  -- src/lib/memory/page.ts — tests/unit/memory/page.test.ts asserts the two agree.
  update public.memory_chunks k
  set summary = '(removed from memory by a user)',
      audience = null,
      embedding = null,
      deleted_at = now(),
      deleted_by = p_actor
  where k.conversation_id = p_conversation_id and k.deleted_at is null;
  get diagnostics v_chunks = row_count;

  update public.conversations c
  set deleted_at = now()
  where c.id = p_conversation_id and c.deleted_at is null;

  return query select false, v_messages, v_chunks, v_facts;
end;
$$;

comment on function public.delete_conversation(uuid, uuid) is
  'Stage 3 part 4. Soft-deletes the conversation, permanently deletes its messages, tombstones its conversation notes and keeps its standing notes (unlinking source_message_id only). One transaction, idempotent, service_role only — the browser holds SELECT and nothing else.';

revoke execute on function public.delete_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_conversation(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------
-- (4) The last-admin invariant, enforced where it can actually hold
--
-- "The workspace must never reach zero active administrators" is not a rule the application
-- can keep on its own. Two admins each demoting the other at the same moment both read
-- "two admins" under READ COMMITTED, both pass their own check, and both commit — the
-- lockout the rule exists to prevent, arrived at by two people who each did something the
-- interface allowed. A constraint trigger does not help: it evaluates in each transaction's
-- own snapshot and sees the other's change no better.
--
-- So the two writes that can remove an administrator take the SAME transaction-scoped
-- advisory lock, exactly as upsert_memory_fact serialises writers of one note (D45). The
-- second waits, re-reads, and is refused. The application checks first as well — so the
-- interface can explain the refusal in words rather than surfacing a database error — but
-- the guarantee is here.
--
-- Both are idempotent and both report the resulting count, so a caller never has to ask a
-- second question to know where the workspace stands.
-- ---------------------------------------------------------------------------------------

create or replace function public.set_staff_active(
  p_user_id uuid,
  p_active boolean
)
returns table (changed boolean, active_admins integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.app_users%rowtype;
  v_others integer;
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('app_users|admins'));

  select * into v_row from public.app_users u where u.user_id = p_user_id for update;
  if not found then
    raise exception 'no allowlist row for %', p_user_id using errcode = '02000';
  end if;

  if v_row.is_active = p_active then
    select count(*) into v_count from public.app_users u where u.is_admin and u.is_active;
    return query select false, v_count::integer;
    return;
  end if;

  if not p_active and v_row.is_admin then
    select count(*) into v_others
    from public.app_users u
    where u.is_admin and u.is_active and u.user_id <> p_user_id;
    if v_others = 0 then
      raise exception 'the workspace must keep at least one active administrator'
        using errcode = '23514';
    end if;
  end if;

  update public.app_users u set is_active = p_active where u.user_id = p_user_id;

  select count(*) into v_count from public.app_users u where u.is_admin and u.is_active;
  return query select true, v_count::integer;
end;
$$;

create or replace function public.set_staff_admin(
  p_user_id uuid,
  p_is_admin boolean
)
returns table (changed boolean, active_admins integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.app_users%rowtype;
  v_others integer;
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('app_users|admins'));

  select * into v_row from public.app_users u where u.user_id = p_user_id for update;
  if not found then
    raise exception 'no allowlist row for %', p_user_id using errcode = '02000';
  end if;

  -- Promoting someone who cannot sign in would put an administrator in the list who is not
  -- there. Reactivate first; the interface says so in those words.
  if p_is_admin and not v_row.is_active then
    raise exception 'cannot promote a deactivated member' using errcode = '23514';
  end if;

  if v_row.is_admin = p_is_admin then
    select count(*) into v_count from public.app_users u where u.is_admin and u.is_active;
    return query select false, v_count::integer;
    return;
  end if;

  if not p_is_admin and v_row.is_active then
    select count(*) into v_others
    from public.app_users u
    where u.is_admin and u.is_active and u.user_id <> p_user_id;
    if v_others = 0 then
      raise exception 'the workspace must keep at least one active administrator'
        using errcode = '23514';
    end if;
  end if;

  update public.app_users u set is_admin = p_is_admin where u.user_id = p_user_id;

  select count(*) into v_count from public.app_users u where u.is_admin and u.is_active;
  return query select true, v_count::integer;
end;
$$;

comment on function public.set_staff_active(uuid, boolean) is
  'Stage 3 part 4. Deactivate or reactivate a staff member under the app_users|admins advisory lock, refusing anything that would leave the workspace with no active administrator. Idempotent; returns the resulting count. service_role only.';
comment on function public.set_staff_admin(uuid, boolean) is
  'Stage 3 part 4. Promote or demote under the same lock, with the same refusal, plus: a deactivated member cannot be promoted. Idempotent; returns the resulting count. service_role only.';

revoke execute on function public.set_staff_active(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.set_staff_admin(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_staff_active(uuid, boolean) to service_role;
grant execute on function public.set_staff_admin(uuid, boolean) to service_role;
