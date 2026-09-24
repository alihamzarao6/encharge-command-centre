-- Milestone 4 part 4 (24 Sep 2026): the first writes from the running system to GoHighLevel —
-- a stage move and a contact note — and the record that explains every one of them.
--
-- Design decisions (MEMORY.md, 24 Sep):
--
--  * GoHighLevel first, mirror second. The Edge Function writes to GoHighLevel, then calls
--    `finish_ghl_write` with the opportunity exactly as GoHighLevel returned it, and that ONE
--    function updates the mirror row, closes the write record and inserts the audit row in
--    one transaction. The mirror never holds a stage the CRM does not have; if this second
--    half fails the write record says `mirror_failed` and the next sync overwrites by hash.
--  * Every attempted write is a row in `ghl_writes` BEFORE GoHighLevel is called, keyed on
--    the browser's `request_id` (unique). A replay of the same request (Try again after a
--    dropped connection) finds the row and is answered from it, never sent twice; two
--    requests with the same id in the same instant are separated by the unique index, not a
--    race. A gesture to the stage the lead is already in is recorded as `noop`.
--  * `audit_log.entity_id` is a uuid and GoHighLevel ids are not, so the audit row points at
--    the `ghl_writes` row (entity_type 'ghl_writes') and carries the opportunity id and the
--    two stage ids in before/after — never a name, an email or a phone (CLAUDE.md rule 20;
--    PHASE-ACCEPTANCE Milestone 4 item 9).
--  * Notes write through to GoHighLevel and are mirrored in `ghl_notes` keyed on the GHL note
--    id, with the author's user id (GoHighLevel cannot name one of our accounts). Nothing
--    reads notes back from GoHighLevel yet, so a note written in the CRM directly is not here.
--  * Same ownership shape as the part-1 mirror: `scope` pinned to 'workspace'; staff SELECT
--    only; every write goes through service_role functions; anon holds nothing.
--
-- Reversible: drop function public.mark_ghl_opportunity_removed(text);
--             drop function public.finish_ghl_write(uuid, text, integer, text, integer, text, jsonb, jsonb);
--             drop function public.begin_ghl_write(uuid, uuid, text, text, text, text, text, text);
--             drop table public.ghl_notes; drop table public.ghl_writes;

create table public.ghl_writes (
  id uuid primary key default gen_random_uuid(),
  -- Minted by the browser per gesture; the idempotency key (CLAUDE.md rule 9).
  request_id uuid not null,
  actor uuid not null references auth.users (id),
  kind text not null constraint ghl_writes_kind_check check (kind in ('stage_move', 'note')),
  pipeline_ghl_id text not null,
  opportunity_ghl_id text not null,
  contact_ghl_id text,
  -- For a stage move: the stage GoHighLevel held LIVE when the write began (not what the
  -- screen showed), and the target. Null for a note.
  from_stage_ghl_id text,
  to_stage_ghl_id text,
  -- The stage the screen showed when the person acted; differs from from_stage_ghl_id when
  -- someone else moved the lead first (last write wins, visibly).
  screen_stage_ghl_id text,
  status text not null default 'in_flight' constraint ghl_writes_status_check
    check (status in ('in_flight', 'success', 'noop', 'failed', 'unknown', 'mirror_failed')),
  -- GoHighLevel's HTTP status for the write itself, when one was received.
  ghl_status integer,
  error_code text,
  duration_ms integer,
  scope text not null default 'workspace' constraint ghl_writes_scope_workspace check (scope = 'workspace'),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index ghl_writes_request_idx on public.ghl_writes (request_id);
create index ghl_writes_opportunity_idx on public.ghl_writes (opportunity_ghl_id, started_at desc);

create table public.ghl_notes (
  -- The GoHighLevel note id: a note is mirrored only once it exists in the CRM.
  ghl_id text primary key,
  contact_ghl_id text not null,
  opportunity_ghl_id text not null,
  author_user_id uuid references auth.users (id),
  -- The text as sent to GoHighLevel, without the "[Fundd app · email]" prefix the CRM shows.
  body text not null,
  ghl_date_added timestamptz,
  write_id uuid references public.ghl_writes (id),
  scope text not null default 'workspace' constraint ghl_notes_scope_workspace check (scope = 'workspace'),
  created_at timestamptz not null default now()
);

create index ghl_notes_opportunity_idx on public.ghl_notes (opportunity_ghl_id, ghl_date_added desc);

alter table public.ghl_writes enable row level security;
alter table public.ghl_writes force row level security;
alter table public.ghl_notes enable row level security;
alter table public.ghl_notes force row level security;

revoke all on public.ghl_writes, public.ghl_notes from anon, authenticated;
grant select on public.ghl_writes, public.ghl_notes to authenticated;
grant all on public.ghl_writes, public.ghl_notes to service_role;

create policy staff_read_ghl_writes on public.ghl_writes
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

create policy staff_read_ghl_notes on public.ghl_notes
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

-- ---------------------------------------------------------------------------------------
-- begin_ghl_write: claim the request id, or hand back the row that already claimed it.
-- Returns `existing = true` with that row's status so the caller can answer a replay from
-- the record instead of writing twice. Never raises on a duplicate.
-- ---------------------------------------------------------------------------------------

create or replace function public.begin_ghl_write(
  p_request_id uuid,
  p_actor uuid,
  p_kind text,
  p_pipeline_ghl_id text,
  p_opportunity_ghl_id text,
  p_contact_ghl_id text,
  p_screen_stage_ghl_id text,
  p_to_stage_ghl_id text
) returns table (id uuid, existing boolean, status text, from_stage_ghl_id text, to_stage_ghl_id text, error_code text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.ghl_writes (
    request_id, actor, kind, pipeline_ghl_id, opportunity_ghl_id, contact_ghl_id,
    screen_stage_ghl_id, to_stage_ghl_id
  ) values (
    p_request_id, p_actor, p_kind, p_pipeline_ghl_id, p_opportunity_ghl_id, p_contact_ghl_id,
    p_screen_stage_ghl_id, p_to_stage_ghl_id
  )
  on conflict (request_id) do nothing
  returning public.ghl_writes.id into v_id;

  if v_id is not null then
    return query select v_id, false, 'in_flight'::text, null::text, p_to_stage_ghl_id, null::text;
    return;
  end if;

  return query
    select w.id, true, w.status, w.from_stage_ghl_id, w.to_stage_ghl_id, w.error_code
    from public.ghl_writes w
    where w.request_id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- finish_ghl_write: ONE transaction for everything that follows a GoHighLevel answer.
--   p_status         success | noop | failed | unknown | mirror_failed (the caller's verdict)
--   p_from_stage_ghl_id  the stage GoHighLevel held live before the write (a move), else null
--   p_opportunity    the opportunity as GoHighLevel returned it (the part-1 row shape,
--                    content_hash included), or null when nothing is known to have changed
--   p_note           {ghl_id, contact_ghl_id, opportunity_ghl_id, body, ghl_date_added} for a
--                    note that now exists in GoHighLevel, else null
-- Writes: the write row; the mirror row (stage, timestamps, hash — the same columns the sync
-- writes, by the same rule: GoHighLevel's answer overwrites local); the note row; and an
-- audit row when GoHighLevel changed (success, or mirror_failed — the CRM did change). Raises if the write row is not in flight, so a second
-- finish for the same write is a definite error, not a second audit row.
-- ---------------------------------------------------------------------------------------

create or replace function public.finish_ghl_write(
  p_id uuid,
  p_status text,
  p_ghl_status integer,
  p_error_code text,
  p_duration_ms integer,
  p_from_stage_ghl_id text,
  p_opportunity jsonb,
  p_note jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_write public.ghl_writes%rowtype;
  v_from text;
  v_action text;
begin
  select * into v_write from public.ghl_writes where id = p_id for update;
  if not found then
    raise exception 'ghl write % not found', p_id using errcode = 'P0002';
  end if;
  if v_write.status <> 'in_flight' then
    raise exception 'ghl write % already finished (%)', p_id, v_write.status using errcode = '55006';
  end if;

  -- The stage GoHighLevel held before this write, as the caller read it live (null for a
  -- note, or when the live read itself failed).
  v_from := p_from_stage_ghl_id;

  if p_opportunity is not null then
    insert into public.ghl_opportunities (
      ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, monetary_value,
      source, assigned_to, ghl_created_at, ghl_updated_at, last_stage_change_at,
      last_status_change_at, content_hash, last_changed_at, removed_at
    ) values (
      p_opportunity ->> 'ghl_id',
      v_write.pipeline_ghl_id,
      p_opportunity ->> 'stage_ghl_id',
      p_opportunity ->> 'contact_ghl_id',
      coalesce(p_opportunity ->> 'name', ''),
      p_opportunity ->> 'status',
      (p_opportunity ->> 'monetary_value')::numeric,
      p_opportunity ->> 'source',
      p_opportunity ->> 'assigned_to',
      (p_opportunity ->> 'ghl_created_at')::timestamptz,
      (p_opportunity ->> 'ghl_updated_at')::timestamptz,
      (p_opportunity ->> 'last_stage_change_at')::timestamptz,
      (p_opportunity ->> 'last_status_change_at')::timestamptz,
      p_opportunity ->> 'content_hash',
      now(),
      null
    )
    on conflict (ghl_id) do update set
      stage_ghl_id = excluded.stage_ghl_id,
      contact_ghl_id = excluded.contact_ghl_id,
      name = excluded.name,
      status = excluded.status,
      monetary_value = excluded.monetary_value,
      source = excluded.source,
      assigned_to = excluded.assigned_to,
      ghl_created_at = excluded.ghl_created_at,
      ghl_updated_at = excluded.ghl_updated_at,
      last_stage_change_at = excluded.last_stage_change_at,
      last_status_change_at = excluded.last_status_change_at,
      content_hash = excluded.content_hash,
      last_changed_at = case
        when public.ghl_opportunities.content_hash is distinct from excluded.content_hash then now()
        else public.ghl_opportunities.last_changed_at
      end,
      removed_at = null
    where public.ghl_opportunities.pipeline_ghl_id = v_write.pipeline_ghl_id;
  end if;

  if p_note is not null then
    insert into public.ghl_notes (
      ghl_id, contact_ghl_id, opportunity_ghl_id, author_user_id, body, ghl_date_added, write_id
    ) values (
      p_note ->> 'ghl_id',
      p_note ->> 'contact_ghl_id',
      p_note ->> 'opportunity_ghl_id',
      v_write.actor,
      p_note ->> 'body',
      (p_note ->> 'ghl_date_added')::timestamptz,
      p_id
    )
    on conflict (ghl_id) do nothing;
  end if;

  update public.ghl_writes set
    status = p_status,
    ghl_status = p_ghl_status,
    error_code = p_error_code,
    duration_ms = p_duration_ms,
    from_stage_ghl_id = coalesce(v_from, from_stage_ghl_id),
    finished_at = now()
  where id = p_id;

  -- An audit row only when GoHighLevel changed: a noop changed nothing, and a failure is
  -- on the write row. mirror_failed still changed the CRM, so it is audited.
  if p_status in ('success', 'mirror_failed') then
    v_action := case v_write.kind when 'stage_move' then 'LEAD_STAGE_MOVED' else 'LEAD_NOTE_ADDED' end;
    insert into public.audit_log (actor, action, entity_type, entity_id, before, after)
    values (
      v_write.actor::text,
      v_action,
      'ghl_writes',
      p_id,
      jsonb_build_object(
        'opportunity_ghl_id', v_write.opportunity_ghl_id,
        'stage_ghl_id', coalesce(v_from, v_write.from_stage_ghl_id)
      ),
      jsonb_build_object(
        'opportunity_ghl_id', v_write.opportunity_ghl_id,
        'stage_ghl_id', case when v_write.kind = 'stage_move' then v_write.to_stage_ghl_id else coalesce(v_from, v_write.from_stage_ghl_id) end,
        'note_ghl_id', p_note ->> 'ghl_id',
        'status', p_status
      )
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- mark_ghl_opportunity_removed: GoHighLevel answered 404 for the opportunity on a live read
-- — a definite signal, so the mirror row is marked now rather than at the next full sync.
-- Marked, never deleted (part-1 rule). Returns true when the row was marked by this call.
-- ---------------------------------------------------------------------------------------

create or replace function public.mark_ghl_opportunity_removed(p_ghl_id text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_marked integer;
begin
  update public.ghl_opportunities
    set removed_at = now(), last_changed_at = now()
    where ghl_id = p_ghl_id and removed_at is null;
  get diagnostics v_marked = row_count;
  return v_marked > 0;
end;
$$;

revoke all on function public.begin_ghl_write(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.finish_ghl_write(uuid, text, integer, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.mark_ghl_opportunity_removed(text) from public, anon, authenticated;
grant execute on function public.begin_ghl_write(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.finish_ghl_write(uuid, text, integer, text, integer, text, jsonb, jsonb) to service_role;
grant execute on function public.mark_ghl_opportunity_removed(text) to service_role;
