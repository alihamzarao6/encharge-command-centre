-- Milestone 4 part 1 (12 Sep 2026): the GoHighLevel read-and-sync layer — a local mirror
-- of the Finance Pipeline, keyed on GHL IDs, plus the run log that explains every sync.
--
-- Design decisions (recorded in MEMORY.md, 12 Sep):
--
--  * GoHighLevel is the source of truth. Every row here is keyed on the GHL object's own
--    id (`ghl_id`), carries a `content_hash` of what was mirrored, and is overwritten
--    from GHL whenever the two disagree. Nothing in this layer is authored locally.
--  * Scoped to ONE pipeline. The location is shared with an unrelated business (R22,
--    R25); the sync reads the pipeline named by configuration and the contacts that have
--    an opportunity in it, and nothing else. `ghl_opportunities.pipeline_ghl_id` and the
--    stage rows say which pipeline every row belongs to.
--  * Match on id, never name. Stage and custom-field NAMES are stored for display only:
--    `ghl_stages.stage_ghl_id` and the keys of `ghl_contacts.custom_fields` are ids. A
--    rename in GHL changes a `name` column and nothing else.
--  * Deletion in GHL is a MARK, not a delete: `removed_at` is set when a full read no
--    longer lists the object. The row stays so a lead that vanished from the CRM is still
--    explainable, and so an opportunity whose stage was deleted still has a stage id.
--    No FK from opportunity → stage or opportunity → contact for exactly that reason.
--  * Ownership. These rows have no author and belong to the whole business, so there is
--    no `user_id` (a NOT NULL owner would have to be invented — the memory-layer comment
--    warns against a default that papers over a failed sync). `scope` IS carried, pinned
--    to 'workspace' by a check like `memory_chunks_scope_workspace`, so the RLS policy has
--    the same shape as the memory tables' and a private variant would be additive rather
--    than a migration on live rows. `ghl_sync_runs.triggered_by` is the person who asked
--    for a refresh (nullable: a scheduled run has none).
--  * The write phase is ONE transaction — `apply_ghl_snapshot` — so an interrupted sync
--    leaves the mirror either untouched or fully applied, never half of each. Removals are
--    computed inside that transaction from the complete snapshot, never from a partial
--    read (the `*_complete` flags).
--  * Overlapping runs are prevented, not raced: a partial unique index allows one
--    `running` row per pipeline, and `begin_ghl_sync_run` marks a run that has been
--    `running` longer than the stale threshold as `failed` before inserting the new one.
--    The second caller gets a definite SQLSTATE 55006 (object_in_use), never a race.
--
-- Reversible:
--   drop function if exists public.finish_ghl_sync_run(uuid, text, text, text, jsonb, jsonb);
--   drop function if exists public.apply_ghl_snapshot(uuid, jsonb);
--   drop function if exists public.begin_ghl_sync_run(text, text, uuid, integer);
--   drop table if exists public.ghl_sync_runs;
--   drop table if exists public.ghl_custom_fields;
--   drop table if exists public.ghl_opportunities;
--   drop table if exists public.ghl_contacts;
--   drop table if exists public.ghl_stages;
--   drop table if exists public.ghl_pipelines;

-- ---------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------

create table public.ghl_pipelines (
  ghl_id text primary key,
  name text not null,
  location_id text not null,
  ghl_updated_at timestamptz,
  scope text not null default 'workspace' constraint ghl_pipelines_scope_workspace check (scope = 'workspace'),
  first_synced_at timestamptz not null default now(),
  -- Bumped only when the mirrored content changes: an unchanged row is never touched, so
  -- two syncs of an unchanged pipeline leave it byte-identical. "When was it last
  -- confirmed present" is answered by ghl_sync_runs, not by this column.
  last_changed_at timestamptz not null default now()
);

comment on table public.ghl_pipelines is
  'The pipeline(s) this system mirrors from GoHighLevel — in practice the one named by GHL_PIPELINE_ID. Keyed on the GHL id; the name is display only.';

create table public.ghl_stages (
  ghl_id text primary key,
  pipeline_ghl_id text not null references public.ghl_pipelines (ghl_id),
  name text not null,
  position integer not null,
  win_probability numeric(6, 2),
  scope text not null default 'workspace' constraint ghl_stages_scope_workspace check (scope = 'workspace'),
  first_seen_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  -- Set when a full read of the pipeline no longer lists the stage. Never deleted:
  -- opportunities may still point at it.
  removed_at timestamptz
);

create index ghl_stages_pipeline_position_idx
  on public.ghl_stages (pipeline_ghl_id, position);

comment on column public.ghl_stages.name is
  'Display only. Matching is on ghl_id — this account has produced three name traps (trailing space, misspelling, U+00A0).';

create table public.ghl_contacts (
  ghl_id text primary key,
  first_name text,
  last_name text,
  full_name text,
  email text,
  phone text,
  source text,
  -- GHL Do-Not-Disturb flag. Null = the record did not carry it; never defaulted to
  -- false, because "no objection" must never be inferred (Spam Act, R17).
  dnd boolean,
  tags text[] not null default '{}',
  -- { "<custom field id>": <value as GHL returned it: string | number | boolean | string[] | null> }.
  -- Keyed by field ID so a rename or removal in GHL never touches a stored value; the
  -- definition (name, type, folder) lives in ghl_custom_fields and is read at display time.
  custom_fields jsonb not null default '{}'::jsonb
    constraint ghl_contacts_custom_fields_object check (jsonb_typeof(custom_fields) = 'object'),
  ghl_created_at timestamptz,
  ghl_updated_at timestamptz,
  content_hash text not null,
  scope text not null default 'workspace' constraint ghl_contacts_scope_workspace check (scope = 'workspace'),
  first_synced_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  -- Set when no live opportunity in a mirrored pipeline references the contact any more:
  -- the person has left the scope this system is allowed to hold.
  removed_at timestamptz
);

create table public.ghl_opportunities (
  ghl_id text primary key,
  pipeline_ghl_id text not null references public.ghl_pipelines (ghl_id),
  -- No FK on purpose: a stage deleted in GHL must still be representable here.
  stage_ghl_id text not null,
  -- No FK on purpose: an opportunity syncs even when its contact could not be fetched
  -- or GHL reports none.
  contact_ghl_id text,
  name text not null default '',
  status text not null constraint ghl_opportunities_status_check
    check (status in ('open', 'won', 'lost', 'abandoned')),
  -- In the location's currency (AUD for this client). NULL = GHL carried no value;
  -- 0 = GHL said zero. The two are different things and stay different here.
  monetary_value numeric(14, 2),
  source text,
  assigned_to text,
  -- All timestamps are stored exactly as GHL returned them (UTC). Nothing in this layer
  -- converts to Perth time; that is a display concern for the screen.
  ghl_created_at timestamptz,
  ghl_updated_at timestamptz,
  last_stage_change_at timestamptz,
  last_status_change_at timestamptz,
  content_hash text not null,
  scope text not null default 'workspace' constraint ghl_opportunities_scope_workspace check (scope = 'workspace'),
  first_synced_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  -- Set when a COMPLETE read of the pipeline no longer lists the opportunity (deleted
  -- in GHL, or moved to another pipeline). Marked, never deleted.
  removed_at timestamptz
);

create index ghl_opportunities_live_stage_idx
  on public.ghl_opportunities (pipeline_ghl_id, stage_ghl_id)
  where removed_at is null;
create index ghl_opportunities_contact_idx
  on public.ghl_opportunities (contact_ghl_id);

create table public.ghl_custom_fields (
  ghl_id text primary key,
  name text not null,
  field_key text,
  data_type text not null,
  model text not null,
  -- The folder in GHL. The Stage 1 fields sit in their own folder (R2); the folder id is
  -- how "our" fields are told from the account's older ones without trusting a name.
  parent_id text,
  position integer,
  picklist_options jsonb,
  scope text not null default 'workspace' constraint ghl_custom_fields_scope_workspace check (scope = 'workspace'),
  first_seen_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  -- Set when the definitions read no longer lists the field. Values already stored
  -- under its id on ghl_contacts are untouched.
  removed_at timestamptz
);

create table public.ghl_sync_runs (
  id uuid primary key default gen_random_uuid(),
  pipeline_ghl_id text not null,
  trigger text not null constraint ghl_sync_runs_trigger_check
    check (trigger in ('cli', 'api', 'schedule', 'test')),
  triggered_by uuid references auth.users (id),
  status text not null default 'running' constraint ghl_sync_runs_status_check
    check (status in ('running', 'success', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  applied_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  requests integer,
  -- Fetch-side counts (written by the application at finish).
  pages_fetched integer,
  opportunities_fetched integer,
  opportunities_rejected integer,
  contacts_fetched integer,
  contacts_failed integer,
  contacts_rejected integer,
  contacts_missing integer,
  custom_fields_fetched integer,
  -- Apply-side counts (written by apply_ghl_snapshot, in the same transaction as the rows).
  stages_seen integer,
  stages_added integer,
  stages_updated integer,
  stages_removed integer,
  opportunities_inserted integer,
  opportunities_updated integer,
  opportunities_unchanged integer,
  opportunities_removed integer,
  contacts_inserted integer,
  contacts_updated integer,
  contacts_unchanged integer,
  contacts_removed integer,
  custom_fields_seen integer,
  custom_fields_removed integer,
  error_code text,
  error text,
  -- [{ "kind": "contact"|"opportunity"|"custom_fields"|"stale", "id": "<ghl id>", "code": "<ErrorCode>" }] — ids only, never a name.
  errors jsonb
);

-- One running sync per pipeline. The second caller is refused by begin_ghl_sync_run
-- with a definite error, not by winning or losing a race.
create unique index ghl_sync_runs_one_running
  on public.ghl_sync_runs (pipeline_ghl_id)
  where status = 'running';

create index ghl_sync_runs_started_idx on public.ghl_sync_runs (started_at desc);

-- ---------------------------------------------------------------------------------------
-- RLS: enable + force on every new table; allowlist SELECT for staff; no write policy.
-- ---------------------------------------------------------------------------------------

alter table public.ghl_pipelines enable row level security;
alter table public.ghl_pipelines force row level security;
alter table public.ghl_stages enable row level security;
alter table public.ghl_stages force row level security;
alter table public.ghl_contacts enable row level security;
alter table public.ghl_contacts force row level security;
alter table public.ghl_opportunities enable row level security;
alter table public.ghl_opportunities force row level security;
alter table public.ghl_custom_fields enable row level security;
alter table public.ghl_custom_fields force row level security;
alter table public.ghl_sync_runs enable row level security;
alter table public.ghl_sync_runs force row level security;

-- Privilege layer, stated per table like every migration since 20260824010500: anon
-- nothing, authenticated SELECT only, service_role full DML (tests/security/rls.test.ts
-- asserts all three).
revoke all on public.ghl_pipelines, public.ghl_stages, public.ghl_contacts,
  public.ghl_opportunities, public.ghl_custom_fields, public.ghl_sync_runs
  from anon, authenticated;
grant select on public.ghl_pipelines, public.ghl_stages, public.ghl_contacts,
  public.ghl_opportunities, public.ghl_custom_fields, public.ghl_sync_runs
  to authenticated;
grant all on public.ghl_pipelines, public.ghl_stages, public.ghl_contacts,
  public.ghl_opportunities, public.ghl_custom_fields, public.ghl_sync_runs
  to service_role;

create policy staff_read_ghl_pipelines on public.ghl_pipelines
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

create policy staff_read_ghl_stages on public.ghl_stages
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

create policy staff_read_ghl_contacts on public.ghl_contacts
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

create policy staff_read_ghl_opportunities on public.ghl_opportunities
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

create policy staff_read_ghl_custom_fields on public.ghl_custom_fields
  for select to authenticated
  using (scope = 'workspace' and public.is_active_staff());

create policy staff_read_ghl_sync_runs on public.ghl_sync_runs
  for select to authenticated
  using (public.is_active_staff());

-- ---------------------------------------------------------------------------------------
-- begin_ghl_sync_run: mark stale runs failed, then claim the one running slot.
-- ---------------------------------------------------------------------------------------

create or replace function public.begin_ghl_sync_run(
  p_pipeline_ghl_id text,
  p_trigger text,
  p_triggered_by uuid,
  p_stale_after_seconds integer
)
returns table (id uuid, stale_marked integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_stale integer := 0;
  v_id uuid;
begin
  if p_stale_after_seconds is null or p_stale_after_seconds <= 0 then
    raise exception 'stale threshold must be a positive number of seconds' using errcode = '22023';
  end if;

  -- Serialise starters for one pipeline so two callers cannot both mark-stale-then-insert.
  perform pg_advisory_xact_lock(hashtext('ghl_sync_run|' || p_pipeline_ghl_id));

  -- A run that has been "running" past the threshold was interrupted (process died between
  -- begin and finish). It is recorded as failed with the reason, and the slot is freed.
  update public.ghl_sync_runs r
    set status = 'failed',
        finished_at = now(),
        duration_ms = (extract(epoch from (now() - r.started_at)) * 1000)::integer,
        error_code = 'STALE',
        error = 'run did not finish within the stale threshold; marked failed by the next sync',
        errors = coalesce(r.errors, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('kind', 'stale', 'id', r.id::text, 'code', 'STALE'))
    where r.pipeline_ghl_id = p_pipeline_ghl_id
      and r.status = 'running'
      and r.started_at < now() - make_interval(secs => p_stale_after_seconds);
  get diagnostics v_stale = row_count;

  if exists (
    select 1 from public.ghl_sync_runs r
    where r.pipeline_ghl_id = p_pipeline_ghl_id and r.status = 'running'
  ) then
    raise exception 'a GoHighLevel sync is already running for pipeline %', p_pipeline_ghl_id
      using errcode = '55006';
  end if;

  insert into public.ghl_sync_runs (pipeline_ghl_id, trigger, triggered_by)
  values (p_pipeline_ghl_id, p_trigger, p_triggered_by)
  returning ghl_sync_runs.id into v_id;

  return query select v_id, v_stale;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- apply_ghl_snapshot: the whole write phase in one transaction.
--
-- p_snapshot shape (built and validated in src/lib/crm/ghl/sync.ts):
-- {
--   "pipeline":   { "ghl_id", "name", "location_id", "ghl_updated_at" },
--   "stages":     [ { "ghl_id", "name", "position", "win_probability" } ],
--   "opportunities_complete": true,
--   "opportunities": [ { "ghl_id", "stage_ghl_id", "contact_ghl_id", "name", "status",
--                        "monetary_value", "source", "assigned_to", "ghl_created_at",
--                        "ghl_updated_at", "last_stage_change_at", "last_status_change_at",
--                        "content_hash" } ],
--   "contacts":   [ { "ghl_id", "first_name", "last_name", "full_name", "email", "phone",
--                     "source", "dnd", "tags", "custom_fields", "ghl_created_at",
--                     "ghl_updated_at", "content_hash" } ],
--   "custom_fields_complete": true|false,
--   "custom_fields": [ { "ghl_id", "name", "field_key", "data_type", "model", "parent_id",
--                        "position", "picklist_options" } ]
-- }
--
-- Unchanged rows (same content_hash, not previously removed) are NOT touched — so two
-- consecutive syncs of an unchanged pipeline leave every row byte-identical, which is
-- what the idempotency test compares. Removals use the complete set in the snapshot.
-- ---------------------------------------------------------------------------------------

create or replace function public.apply_ghl_snapshot(p_run_id uuid, p_snapshot jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pipeline_id text := p_snapshot -> 'pipeline' ->> 'ghl_id';
  v_now timestamptz := now();
  v_stages_seen integer := 0;
  v_stages_added integer := 0;
  v_stages_updated integer := 0;
  v_stages_removed integer := 0;
  v_opps_seen integer := 0;
  v_opps_inserted integer := 0;
  v_opps_updated integer := 0;
  v_opps_removed integer := 0;
  v_contacts_seen integer := 0;
  v_contacts_inserted integer := 0;
  v_contacts_updated integer := 0;
  v_contacts_removed integer := 0;
  v_fields_seen integer := 0;
  v_fields_removed integer := 0;
  v_opps_complete boolean := coalesce((p_snapshot ->> 'opportunities_complete')::boolean, false);
  v_fields_complete boolean := coalesce((p_snapshot ->> 'custom_fields_complete')::boolean, false);
begin
  if v_pipeline_id is null or v_pipeline_id = '' then
    raise exception 'snapshot has no pipeline id' using errcode = '22023';
  end if;
  if not exists (select 1 from public.ghl_sync_runs r where r.id = p_run_id and r.status = 'running') then
    raise exception 'run % is not running', p_run_id using errcode = '55006';
  end if;
  if jsonb_typeof(p_snapshot -> 'stages') <> 'array'
     or jsonb_typeof(p_snapshot -> 'opportunities') <> 'array'
     or jsonb_typeof(p_snapshot -> 'contacts') <> 'array'
     or jsonb_typeof(p_snapshot -> 'custom_fields') <> 'array' then
    raise exception 'snapshot arrays are missing or not arrays' using errcode = '22023';
  end if;

  -- Pipeline.
  insert into public.ghl_pipelines (ghl_id, name, location_id, ghl_updated_at, last_changed_at)
  values (
    v_pipeline_id,
    p_snapshot -> 'pipeline' ->> 'name',
    p_snapshot -> 'pipeline' ->> 'location_id',
    (p_snapshot -> 'pipeline' ->> 'ghl_updated_at')::timestamptz,
    v_now
  )
  on conflict (ghl_id) do update
    set name = excluded.name,
        location_id = excluded.location_id,
        ghl_updated_at = excluded.ghl_updated_at,
        last_changed_at = excluded.last_changed_at
    where ghl_pipelines.name is distinct from excluded.name
       or ghl_pipelines.location_id is distinct from excluded.location_id
       or ghl_pipelines.ghl_updated_at is distinct from excluded.ghl_updated_at;

  -- Stages: upsert by id; the ones no longer listed are marked removed.
  with incoming as (
    select s ->> 'ghl_id' as ghl_id,
           s ->> 'name' as name,
           (s ->> 'position')::integer as position,
           (s ->> 'win_probability')::numeric as win_probability
    from jsonb_array_elements(p_snapshot -> 'stages') s
  ),
  upserted as (
    insert into public.ghl_stages (ghl_id, pipeline_ghl_id, name, position, win_probability, last_changed_at, removed_at)
    select i.ghl_id, v_pipeline_id, i.name, i.position, i.win_probability, v_now, null
    from incoming i
    on conflict (ghl_id) do update
      set pipeline_ghl_id = excluded.pipeline_ghl_id,
          name = excluded.name,
          position = excluded.position,
          win_probability = excluded.win_probability,
          last_changed_at = excluded.last_changed_at,
          removed_at = null
      where ghl_stages.name is distinct from excluded.name
         or ghl_stages.position is distinct from excluded.position
         or ghl_stages.win_probability is distinct from excluded.win_probability
         or ghl_stages.pipeline_ghl_id is distinct from excluded.pipeline_ghl_id
         or ghl_stages.removed_at is not null
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_stages_added, v_stages_updated
  from upserted;
  select count(*) into v_stages_seen from jsonb_array_elements(p_snapshot -> 'stages');

  update public.ghl_stages s
    set removed_at = v_now
    where s.pipeline_ghl_id = v_pipeline_id
      and s.removed_at is null
      and not exists (
        select 1 from jsonb_array_elements(p_snapshot -> 'stages') i
        where i ->> 'ghl_id' = s.ghl_id
      );
  get diagnostics v_stages_removed = row_count;

  -- Opportunities.
  with incoming as (
    select o ->> 'ghl_id' as ghl_id,
           o ->> 'stage_ghl_id' as stage_ghl_id,
           o ->> 'contact_ghl_id' as contact_ghl_id,
           coalesce(o ->> 'name', '') as name,
           o ->> 'status' as status,
           (o ->> 'monetary_value')::numeric as monetary_value,
           o ->> 'source' as source,
           o ->> 'assigned_to' as assigned_to,
           (o ->> 'ghl_created_at')::timestamptz as ghl_created_at,
           (o ->> 'ghl_updated_at')::timestamptz as ghl_updated_at,
           (o ->> 'last_stage_change_at')::timestamptz as last_stage_change_at,
           (o ->> 'last_status_change_at')::timestamptz as last_status_change_at,
           o ->> 'content_hash' as content_hash
    from jsonb_array_elements(p_snapshot -> 'opportunities') o
  ),
  upserted as (
    insert into public.ghl_opportunities (
      ghl_id, pipeline_ghl_id, stage_ghl_id, contact_ghl_id, name, status, monetary_value,
      source, assigned_to, ghl_created_at, ghl_updated_at, last_stage_change_at,
      last_status_change_at, content_hash, last_changed_at, removed_at
    )
    select i.ghl_id, v_pipeline_id, i.stage_ghl_id, i.contact_ghl_id, i.name, i.status,
           i.monetary_value, i.source, i.assigned_to, i.ghl_created_at, i.ghl_updated_at,
           i.last_stage_change_at, i.last_status_change_at, i.content_hash, v_now, null
    from incoming i
    on conflict (ghl_id) do update
      set pipeline_ghl_id = excluded.pipeline_ghl_id,
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
          last_changed_at = excluded.last_changed_at,
          removed_at = null
      where ghl_opportunities.content_hash is distinct from excluded.content_hash
         or ghl_opportunities.removed_at is not null
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_opps_inserted, v_opps_updated
  from upserted;
  select count(*) into v_opps_seen from jsonb_array_elements(p_snapshot -> 'opportunities');

  if v_opps_complete then
    update public.ghl_opportunities o
      set removed_at = v_now
      where o.pipeline_ghl_id = v_pipeline_id
        and o.removed_at is null
        and not exists (
          select 1 from jsonb_array_elements(p_snapshot -> 'opportunities') i
          where i ->> 'ghl_id' = o.ghl_id
        );
    get diagnostics v_opps_removed = row_count;
  end if;

  -- Contacts.
  with incoming as (
    select c ->> 'ghl_id' as ghl_id,
           c ->> 'first_name' as first_name,
           c ->> 'last_name' as last_name,
           c ->> 'full_name' as full_name,
           c ->> 'email' as email,
           c ->> 'phone' as phone,
           c ->> 'source' as source,
           (c ->> 'dnd')::boolean as dnd,
           coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(c -> 'tags') = 'array' then c -> 'tags' else '[]'::jsonb end)), '{}'::text[]) as tags,
           coalesce(case when jsonb_typeof(c -> 'custom_fields') = 'object' then c -> 'custom_fields' end, '{}'::jsonb) as custom_fields,
           (c ->> 'ghl_created_at')::timestamptz as ghl_created_at,
           (c ->> 'ghl_updated_at')::timestamptz as ghl_updated_at,
           c ->> 'content_hash' as content_hash
    from jsonb_array_elements(p_snapshot -> 'contacts') c
  ),
  upserted as (
    insert into public.ghl_contacts (
      ghl_id, first_name, last_name, full_name, email, phone, source, dnd, tags,
      custom_fields, ghl_created_at, ghl_updated_at, content_hash, last_changed_at, removed_at
    )
    select i.ghl_id, i.first_name, i.last_name, i.full_name, i.email, i.phone, i.source,
           i.dnd, i.tags, i.custom_fields, i.ghl_created_at, i.ghl_updated_at,
           i.content_hash, v_now, null
    from incoming i
    on conflict (ghl_id) do update
      set first_name = excluded.first_name,
          last_name = excluded.last_name,
          full_name = excluded.full_name,
          email = excluded.email,
          phone = excluded.phone,
          source = excluded.source,
          dnd = excluded.dnd,
          tags = excluded.tags,
          custom_fields = excluded.custom_fields,
          ghl_created_at = excluded.ghl_created_at,
          ghl_updated_at = excluded.ghl_updated_at,
          content_hash = excluded.content_hash,
          last_changed_at = excluded.last_changed_at,
          removed_at = null
      where ghl_contacts.content_hash is distinct from excluded.content_hash
         or ghl_contacts.removed_at is not null
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_contacts_inserted, v_contacts_updated
  from upserted;
  select count(*) into v_contacts_seen from jsonb_array_elements(p_snapshot -> 'contacts');

  -- A contact leaves scope when no live opportunity in a mirrored pipeline references it.
  -- Reference-based, so a contact whose fetch failed this run but whose opportunity is
  -- still live keeps its previous row.
  if v_opps_complete then
    update public.ghl_contacts c
      set removed_at = v_now
      where c.removed_at is null
        and not exists (
          select 1 from public.ghl_opportunities o
          where o.contact_ghl_id = c.ghl_id and o.removed_at is null
        );
    get diagnostics v_contacts_removed = row_count;
  end if;

  -- Custom field definitions.
  with incoming as (
    select f ->> 'ghl_id' as ghl_id,
           f ->> 'name' as name,
           f ->> 'field_key' as field_key,
           f ->> 'data_type' as data_type,
           f ->> 'model' as model,
           f ->> 'parent_id' as parent_id,
           (f ->> 'position')::integer as position,
           f -> 'picklist_options' as picklist_options
    from jsonb_array_elements(p_snapshot -> 'custom_fields') f
  )
  insert into public.ghl_custom_fields (
    ghl_id, name, field_key, data_type, model, parent_id, position, picklist_options, last_changed_at, removed_at
  )
  select i.ghl_id, i.name, i.field_key, i.data_type, i.model, i.parent_id, i.position,
         i.picklist_options, v_now, null
  from incoming i
  on conflict (ghl_id) do update
    set name = excluded.name,
        field_key = excluded.field_key,
        data_type = excluded.data_type,
        model = excluded.model,
        parent_id = excluded.parent_id,
        position = excluded.position,
        picklist_options = excluded.picklist_options,
        last_changed_at = excluded.last_changed_at,
        removed_at = null
    where ghl_custom_fields.name is distinct from excluded.name
       or ghl_custom_fields.field_key is distinct from excluded.field_key
       or ghl_custom_fields.data_type is distinct from excluded.data_type
       or ghl_custom_fields.model is distinct from excluded.model
       or ghl_custom_fields.parent_id is distinct from excluded.parent_id
       or ghl_custom_fields.position is distinct from excluded.position
       or ghl_custom_fields.picklist_options is distinct from excluded.picklist_options
       or ghl_custom_fields.removed_at is not null;
  select count(*) into v_fields_seen from jsonb_array_elements(p_snapshot -> 'custom_fields');

  if v_fields_complete then
    update public.ghl_custom_fields f
      set removed_at = v_now
      where f.removed_at is null
        and not exists (
          select 1 from jsonb_array_elements(p_snapshot -> 'custom_fields') i
          where i ->> 'ghl_id' = f.ghl_id
        );
    get diagnostics v_fields_removed = row_count;
  end if;

  update public.ghl_sync_runs r
    set applied_at = v_now,
        stages_seen = v_stages_seen,
        stages_added = v_stages_added,
        stages_updated = v_stages_updated,
        stages_removed = v_stages_removed,
        opportunities_inserted = v_opps_inserted,
        opportunities_updated = v_opps_updated,
        opportunities_unchanged = v_opps_seen - v_opps_inserted - v_opps_updated,
        opportunities_removed = v_opps_removed,
        contacts_inserted = v_contacts_inserted,
        contacts_updated = v_contacts_updated,
        contacts_unchanged = v_contacts_seen - v_contacts_inserted - v_contacts_updated,
        contacts_removed = v_contacts_removed,
        custom_fields_seen = v_fields_seen,
        custom_fields_removed = v_fields_removed
    where r.id = p_run_id;

  return jsonb_build_object(
    'stages_seen', v_stages_seen,
    'stages_added', v_stages_added,
    'stages_updated', v_stages_updated,
    'stages_removed', v_stages_removed,
    'opportunities_inserted', v_opps_inserted,
    'opportunities_updated', v_opps_updated,
    'opportunities_unchanged', v_opps_seen - v_opps_inserted - v_opps_updated,
    'opportunities_removed', v_opps_removed,
    'contacts_inserted', v_contacts_inserted,
    'contacts_updated', v_contacts_updated,
    'contacts_unchanged', v_contacts_seen - v_contacts_inserted - v_contacts_updated,
    'contacts_removed', v_contacts_removed,
    'custom_fields_seen', v_fields_seen,
    'custom_fields_removed', v_fields_removed
  );
end;
$$;

-- ---------------------------------------------------------------------------------------
-- finish_ghl_sync_run: close the run with its outcome and the fetch-side counts.
-- ---------------------------------------------------------------------------------------

create or replace function public.finish_ghl_sync_run(
  p_run_id uuid,
  p_status text,
  p_error_code text,
  p_error text,
  p_errors jsonb,
  p_counts jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_status not in ('success', 'partial', 'failed') then
    raise exception 'status must be success, partial or failed' using errcode = '22023';
  end if;
  update public.ghl_sync_runs r
    set status = p_status,
        finished_at = now(),
        duration_ms = (extract(epoch from (now() - r.started_at)) * 1000)::integer,
        error_code = p_error_code,
        error = p_error,
        errors = p_errors,
        requests = (p_counts ->> 'requests')::integer,
        pages_fetched = (p_counts ->> 'pages_fetched')::integer,
        opportunities_fetched = (p_counts ->> 'opportunities_fetched')::integer,
        opportunities_rejected = (p_counts ->> 'opportunities_rejected')::integer,
        contacts_fetched = (p_counts ->> 'contacts_fetched')::integer,
        contacts_failed = (p_counts ->> 'contacts_failed')::integer,
        contacts_rejected = (p_counts ->> 'contacts_rejected')::integer,
        contacts_missing = (p_counts ->> 'contacts_missing')::integer,
        custom_fields_fetched = (p_counts ->> 'custom_fields_fetched')::integer
    where r.id = p_run_id and r.status = 'running';
  if not found then
    raise exception 'run % is not running', p_run_id using errcode = '55006';
  end if;
end;
$$;

-- service_role only: the browser holds the anon key and a session, and neither may start
-- a sync or write the mirror. Postgres grants EXECUTE to PUBLIC by default — revoked.
revoke execute on function public.begin_ghl_sync_run(text, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.apply_ghl_snapshot(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.finish_ghl_sync_run(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.begin_ghl_sync_run(text, text, uuid, integer) to service_role;
grant execute on function public.apply_ghl_snapshot(uuid, jsonb) to service_role;
grant execute on function public.finish_ghl_sync_run(uuid, text, text, text, jsonb, jsonb) to service_role;
