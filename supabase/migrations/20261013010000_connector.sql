-- MCP connector, stage 1 — the Command Centre as a connector the client's own AI can reach
-- (docs/MEMORY.md 13 Oct 2026, D101–D110). Goodwill work, not on the milestone list.
--
-- The client's AI connects in from outside with a key and READS his Finance Pipeline. Stage 1
-- reads only; it changes nothing in GoHighLevel and nothing in the mirror. What this
-- migration adds:
--
--   * `connector_keys` — one row per key, belonging to ONE user: its public 12-character
--     id (what logs and `npm run connector -- list` show), its label, when it was last used,
--     whether it has been switched off. A person may read their own rows.
--   * `connector_key_secrets` — the SHA-256 of each key, 32 bytes, and nothing else. The key
--     itself is never stored anywhere; the secret part is shown once, at issue. The digest
--     sits in a table of its own so that the rule every table here follows — the signed-in
--     role may SELECT, and row-level security decides which rows — can hold for the key
--     list while no browser role can ever read a digest: this table's policy is `false`.
--   * `connector_calls` — one row per request a key was allowed to make. It is the rate
--     limit's count and the record of what the key did: the method, the tool, the outcome,
--     how many records, how long. Never an argument's text and never anything a tool
--     returned; for `get_lead`, the lead's id.
--   * `connector_call` — the ONE door. It checks the key (constant-time comparison of the two
--     digests), the user, and the limits, records the call, and for a tool call hands the
--     read to `connector_read`. TypeScript never passes a user id: the function finds the
--     user from the key, so no bug upstream can read as somebody else.
--   * `connector_read` — the four tools' reads. It is declared `SET role = 'authenticated'`
--     and sets `auth.uid()` to the key's user, so the mirror's EXISTING row-level-security
--     policies decide what comes back, exactly as they do for that person's browser. That
--     role holds SELECT on the mirror and nothing else: a write from inside this function is
--     "permission denied" at the database, whatever the function's text says. Every query is
--     tied to the one pipeline id the caller's configuration names (R22, R25).
--
-- Why `connector_call` is SECURITY INVOKER and not DEFINER: PostgreSQL refuses a role switch
-- inside a security-definer function, and the switch is the point. It is reachable by
-- service_role only, like every other server-side function in this schema.
--
-- Deploy order: this migration first, then the `connector` function. Nothing deployed today
-- calls anything here, so there is no window in which something breaks.
--
-- Reversible:
--   drop function public.connector_call(text, bytea, text, text, jsonb, text, integer, integer);
--   drop function public.connector_read(uuid, text, text, jsonb);
--   drop function public.revoke_connector_key(uuid, text, uuid);
--   drop function public.issue_connector_key(uuid, text, bytea, text, uuid);
--   drop function public.connector_digest_equal(bytea, bytea);
--   drop table public.connector_calls;
--   drop table public.connector_key_secrets;
--   drop table public.connector_keys;

-- ---------------------------------------------------------------------------------------
-- (1) connector_keys
-- ---------------------------------------------------------------------------------------

create table public.connector_keys (
  id uuid primary key default gen_random_uuid(),
  -- The public half: what a log line, `list` and a settings screen show. Not a secret.
  key_id text not null constraint connector_keys_key_id_format
    check (key_id ~ '^[a-hjkmnp-z2-9]{12}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null default '' constraint connector_keys_label_length
    check (char_length(label) <= 80),
  created_at timestamptz not null default now(),
  -- Who issued it: null from the terminal, the signed-in user from a settings screen.
  created_by uuid references auth.users (id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);

create unique index connector_keys_key_id_idx on public.connector_keys (key_id);
create index connector_keys_user_idx on public.connector_keys (user_id, created_at desc);

comment on table public.connector_keys is
  'MCP connector, stage 1. One row per key, belonging to one user: its public id, label and state. Never the key and never its digest (connector_key_secrets). A person may read their own rows; issue and revoke go through issue_connector_key / revoke_connector_key (service_role).';

alter table public.connector_keys enable row level security;
alter table public.connector_keys force row level security;

revoke all on public.connector_keys from anon, authenticated;
-- A settings screen can list a person's own keys (Milestone 5 part 4) without a migration.
grant select on public.connector_keys to authenticated;
grant all on public.connector_keys to service_role;

create policy connector_keys_select_own on public.connector_keys
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_active_staff());

-- ---------------------------------------------------------------------------------------
-- (1b) connector_key_secrets — the digests, where no browser can read one
-- ---------------------------------------------------------------------------------------

create table public.connector_key_secrets (
  connector_key_id uuid primary key references public.connector_keys (id) on delete cascade,
  -- SHA-256 of the whole key. The key is 256 random bits, so there is nothing to guess and
  -- nothing a salt or a slow hash would add.
  key_hash bytea not null constraint connector_key_secrets_hash_length
    check (octet_length(key_hash) = 32)
);

create unique index connector_key_secrets_hash_idx on public.connector_key_secrets (key_hash);

comment on table public.connector_key_secrets is
  'MCP connector, stage 1. The SHA-256 of each connector key, 32 bytes — never the key. Read only by connector_call and issue_connector_key, as service_role. The one policy is false: no signed-in session reads a row.';

alter table public.connector_key_secrets enable row level security;
alter table public.connector_key_secrets force row level security;

revoke all on public.connector_key_secrets from anon, authenticated;
-- The grant every table carries, so that it is row-level security that refuses, not a
-- missing privilege (tests/security/rls.test.ts) — and the policy that refuses everyone.
grant select on public.connector_key_secrets to authenticated;
grant all on public.connector_key_secrets to service_role;

create policy connector_key_secrets_no_browser_read on public.connector_key_secrets
  for select to authenticated
  using (false);

-- ---------------------------------------------------------------------------------------
-- (2) connector_calls
-- ---------------------------------------------------------------------------------------

create table public.connector_calls (
  id uuid primary key default gen_random_uuid(),
  connector_key_id uuid not null references public.connector_keys (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- What the request was, from a fixed list. Never the caller's own text.
  method text not null constraint connector_calls_method_check
    check (method in ('initialize', 'notifications/initialized', 'ping', 'server/discover',
                      'tools/list', 'tools/call', 'other', 'invalid')),
  -- One of the four tools, or null. Never text the caller chose.
  tool text constraint connector_calls_tool_check
    check (tool is null or tool in ('pipeline_summary', 'list_leads', 'get_lead', 'search_leads')),
  -- get_lead only: the lead's GoHighLevel id. An id, never a name.
  subject_id text constraint connector_calls_subject_format
    check (subject_id is null or subject_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  outcome text not null default 'ok' constraint connector_calls_outcome_check
    check (outcome in ('ok', 'not_found', 'never_synced', 'read_failed')),
  records integer constraint connector_calls_records_check check (records is null or records >= 0),
  duration_ms integer constraint connector_calls_duration_check
    check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);

create index connector_calls_key_created_idx
  on public.connector_calls (connector_key_id, created_at desc);

comment on table public.connector_calls is
  'MCP connector, stage 1. One row per request a key was allowed to make: the rate limit counts these, and they are the record of what a key did. Ids, counts and durations only — no argument text, nothing a tool returned. Rows older than 30 days are deleted when the same key next calls.';

alter table public.connector_calls enable row level security;
alter table public.connector_calls force row level security;

revoke all on public.connector_calls from anon, authenticated;
grant select on public.connector_calls to authenticated;
grant all on public.connector_calls to service_role;

create policy connector_calls_select_own on public.connector_calls
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_active_staff());

-- ---------------------------------------------------------------------------------------
-- (3) connector_digest_equal — the comparison, in constant time
--
-- Two 32-byte digests. Always 32 steps; the result is the OR of every byte's difference, so
-- there is no step at which a nearly-right digest returns sooner than a wholly wrong one.
-- The lengths are not secret (a digest is always 32 bytes), so the length check may return
-- early.
-- ---------------------------------------------------------------------------------------

create or replace function public.connector_digest_equal(p_a bytea, p_b bytea)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_diff integer := 0;
begin
  if p_a is null or p_b is null or octet_length(p_a) <> 32 or octet_length(p_b) <> 32 then
    return false;
  end if;
  for i in 0..31 loop
    v_diff := v_diff | (get_byte(p_a, i) # get_byte(p_b, i));
  end loop;
  return v_diff = 0;
end;
$$;

comment on function public.connector_digest_equal(bytea, bytea) is
  'MCP connector. Compares two 32-byte digests in a fixed 32 steps with no early exit. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (4) issue_connector_key / revoke_connector_key
--
-- Used by `npm run connector` today and by a settings screen later (Milestone 5 part 4)
-- without another migration. Raises:
--   CK001 the user is not an active member of staff
--   CK002 the user already holds the most live keys one person may have
--   CK003 that key id is already taken by a different key
-- ---------------------------------------------------------------------------------------

create or replace function public.issue_connector_key(
  p_user_id uuid,
  p_key_id text,
  p_key_hash bytea,
  p_label text,
  p_created_by uuid
)
returns table (id uuid, key_id text, created_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_live integer;
  v_row public.connector_keys%rowtype;
  v_hash bytea;
begin
  if not exists (
    select 1 from public.app_users u where u.user_id = p_user_id and u.is_active
  ) then
    raise exception 'user % is not an active member of staff', p_user_id using errcode = 'CK001';
  end if;

  -- One person's keys are counted under one lock, so two issues at once cannot both pass.
  perform pg_advisory_xact_lock(hashtextextended('connector_issue:' || p_user_id::text, 0));

  -- The same key issued twice is the same key (a retry after a lost answer): return it.
  select * into v_row from public.connector_keys k where k.key_id = p_key_id;
  if found then
    select x.key_hash into v_hash
    from public.connector_key_secrets x where x.connector_key_id = v_row.id;
    if v_row.user_id = p_user_id and public.connector_digest_equal(v_hash, p_key_hash) then
      return query select v_row.id, v_row.key_id, v_row.created_at;
      return;
    end if;
    raise exception 'key id is already in use' using errcode = 'CK003';
  end if;

  select count(*) into v_live
  from public.connector_keys k
  where k.user_id = p_user_id and k.revoked_at is null;
  if v_live >= 5 then
    raise exception 'user % already holds % live keys', p_user_id, v_live using errcode = 'CK002';
  end if;

  insert into public.connector_keys (key_id, user_id, label, created_by)
  values (p_key_id, p_user_id, left(btrim(coalesce(p_label, '')), 80), p_created_by)
  returning * into v_row;
  insert into public.connector_key_secrets (connector_key_id, key_hash)
  values (v_row.id, p_key_hash);

  -- A new way into the pipeline is on the record: who it is for and who made it. Ids only.
  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values (
    coalesce(p_created_by::text, 'terminal'),
    'CONNECTOR_KEY_ISSUED',
    'connector_keys',
    v_row.id,
    jsonb_build_object('key_id', v_row.key_id, 'user_id', v_row.user_id)
  );

  return query select v_row.id, v_row.key_id, v_row.created_at;
end;
$$;

comment on function public.issue_connector_key(uuid, text, bytea, text, uuid) is
  'MCP connector. Records a new key for an active member of staff (five live keys at most) and an audit_log row. Receives the digest, never the key. Idempotent on the key id. service_role only.';

create or replace function public.revoke_connector_key(
  p_user_id uuid,
  p_key_id text,
  p_revoked_by uuid
)
returns table (key_id text, revoked_at timestamptz, already boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_row public.connector_keys%rowtype;
begin
  -- p_user_id null: an operator at the terminal, any key. Given: only that person's own key.
  select * into v_row
  from public.connector_keys k
  where k.key_id = p_key_id and (p_user_id is null or k.user_id = p_user_id)
  for update;
  if not found then
    return;
  end if;
  if v_row.revoked_at is not null then
    return query select v_row.key_id, v_row.revoked_at, true;
    return;
  end if;
  update public.connector_keys k
    set revoked_at = clock_timestamp(), revoked_by = p_revoked_by
    where k.id = v_row.id
    returning * into v_row;

  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values (
    coalesce(p_revoked_by::text, 'terminal'),
    'CONNECTOR_KEY_REVOKED',
    'connector_keys',
    v_row.id,
    jsonb_build_object('key_id', v_row.key_id, 'user_id', v_row.user_id)
  );

  return query select v_row.key_id, v_row.revoked_at, false;
end;
$$;

comment on function public.revoke_connector_key(uuid, text, uuid) is
  'MCP connector. Switches a key off and writes an audit_log row. Revoking a revoked key changes nothing and says so. No row back means there is no such key (for that user). service_role only.';

-- ---------------------------------------------------------------------------------------
-- (5) connector_read — the four tools, run as the key's user
--
-- `SET role = 'authenticated'`: the body runs as the role a signed-in browser has, and
-- `auth.uid()` is set to the key's user, so the mirror's own policies apply. If that user
-- is not active staff, the policies return nothing — and this function raises before asking.
--
-- Every query names p_pipeline_ghl_id. A lead in another pipeline, a lead that was removed
-- and a lead that never existed are the same answer: not found.
--
-- Returns jsonb: { outcome, records, freshness, ...the tool's rows }. Text is returned as
-- stored, bounded in length; the caller cleans and caps it before it leaves.
-- ---------------------------------------------------------------------------------------

create or replace function public.connector_read(
  p_user_id uuid,
  p_pipeline_ghl_id text,
  p_tool text,
  p_args jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
set role = 'authenticated'
-- Named here so that what the body sets is undone when it returns: the caller gets its own
-- role AND its own identity back, and nothing after this function runs as the key's user.
set request.jwt.claims = ''
set request.jwt.claim.sub = ''
as $$
declare
  v_pipeline_name text;
  v_applied timestamptz;
  v_last_status text;
  v_last_at timestamptz;
  v_freshness jsonb;
  v_limit integer;
  v_stage text;
  v_status text;
  v_after_at timestamptz;
  v_after_id text;
  v_has_cursor boolean;
  v_rows jsonb;
  v_total integer;
  v_lead text;
  v_opportunity public.ghl_opportunities%rowtype;
  v_contact jsonb;
  v_stage_row jsonb;
  v_mapped jsonb;
  v_other jsonb;
  v_other_total integer;
  v_notes jsonb;
  v_notes_total integer;
  v_query text;
  v_like text;
  v_digits text;
  v_digits_local text;
begin
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  if current_user <> 'authenticated'
     or (select auth.uid()) is distinct from p_user_id
     or not public.is_active_staff() then
    raise exception 'connector read without an active staff identity' using errcode = '42501';
  end if;
  if p_pipeline_ghl_id is null or p_pipeline_ghl_id = '' then
    raise exception 'connector read without a pipeline' using errcode = '22023';
  end if;

  select p.name into v_pipeline_name
  from public.ghl_pipelines p
  where p.ghl_id = p_pipeline_ghl_id;

  select r.applied_at into v_applied
  from public.ghl_sync_runs r
  where r.pipeline_ghl_id = p_pipeline_ghl_id and r.applied_at is not null
  order by r.applied_at desc
  limit 1;

  select r.status, coalesce(r.finished_at, r.started_at) into v_last_status, v_last_at
  from public.ghl_sync_runs r
  where r.pipeline_ghl_id = p_pipeline_ghl_id and r.status <> 'running'
  order by r.started_at desc
  limit 1;

  v_freshness := jsonb_build_object(
    'refreshed_at', v_applied,
    'read_at', clock_timestamp(),
    'last_attempt_status', v_last_status,
    'last_attempt_at', v_last_at
  );

  -- Never copied is not an empty pipeline, and the caller is told which.
  if v_pipeline_name is null or v_applied is null then
    return jsonb_build_object('outcome', 'never_synced', 'records', 0, 'freshness', v_freshness);
  end if;

  if p_tool = 'pipeline_summary' then
    return jsonb_build_object(
      'outcome', 'ok',
      'freshness', v_freshness,
      'pipeline', jsonb_build_object('id', p_pipeline_ghl_id, 'name', left(v_pipeline_name, 1000)),
      'by_status', (
        select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
        from (
          select o.status, count(*) as n
          from public.ghl_opportunities o
          where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
          group by o.status
        ) s
      ),
      'new_last_7_days', (
        select count(*)
        from public.ghl_opportunities o
        where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
          and o.status = 'open'
          and o.ghl_created_at > clock_timestamp() - interval '7 days'
      ),
      'stages', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'stage_id', s.ghl_id,
            'name', left(s.name, 1000),
            'position', s.position,
            'removed', s.removed_at is not null,
            'open_leads', coalesce(c.n, 0)
          ) order by s.position, s.ghl_id
        ), '[]'::jsonb)
        from public.ghl_stages s
        left join (
          select o.stage_ghl_id, count(*) as n
          from public.ghl_opportunities o
          where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
            and o.status = 'open'
          group by o.stage_ghl_id
        ) c on c.stage_ghl_id = s.ghl_id
        where s.pipeline_ghl_id = p_pipeline_ghl_id
          and (s.removed_at is null or coalesce(c.n, 0) > 0)
      ),
      -- Open leads sitting in a stage id this pipeline has never listed: counted, not hidden.
      'unknown_stages', (
        select coalesce(jsonb_agg(
          jsonb_build_object('stage_id', u.stage_ghl_id, 'open_leads', u.n) order by u.stage_ghl_id
        ), '[]'::jsonb)
        from (
          select o.stage_ghl_id, count(*) as n
          from public.ghl_opportunities o
          where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
            and o.status = 'open'
            and not exists (
              select 1 from public.ghl_stages s
              where s.ghl_id = o.stage_ghl_id and s.pipeline_ghl_id = p_pipeline_ghl_id
            )
          group by o.stage_ghl_id
        ) u
      ),
      'records', (
        select count(*) from public.ghl_stages s
        where s.pipeline_ghl_id = p_pipeline_ghl_id and s.removed_at is null
      )
    );
  end if;

  if p_tool = 'list_leads' then
    -- The caller validated these; the bounds are applied again here, where they bind.
    v_limit := least(greatest(coalesce((p_args ->> 'limit')::integer, 20), 1), 50);
    v_stage := nullif(p_args ->> 'stage_id', '');
    v_status := coalesce(nullif(p_args ->> 'status', ''), 'open');
    v_has_cursor := coalesce((p_args ->> 'has_cursor')::boolean, false);
    v_after_at := (p_args ->> 'after_created_at')::timestamptz;
    v_after_id := p_args ->> 'after_id';

    select count(*) into v_total
    from public.ghl_opportunities o
    where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
      and (v_status = 'any' or o.status = v_status)
      and (v_stage is null or o.stage_ghl_id = v_stage);

    select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc nulls last, page.lead_id), '[]'::jsonb)
      into v_rows
    from (
      select
        o.ghl_id as lead_id,
        left(coalesce(
          nullif(btrim(c.full_name), ''),
          nullif(btrim(concat_ws(' ', nullif(btrim(c.first_name), ''), nullif(btrim(c.last_name), ''))), ''),
          nullif(btrim(o.name), '')
        ), 1000) as name,
        o.stage_ghl_id as stage_id,
        left(s.name, 1000) as stage_name,
        s.ghl_id is not null as stage_known,
        coalesce(s.removed_at is not null, false) as stage_removed,
        o.status,
        o.ghl_created_at as created_at,
        o.last_stage_change_at
      from public.ghl_opportunities o
      left join public.ghl_contacts c on c.ghl_id = o.contact_ghl_id and c.removed_at is null
      left join public.ghl_stages s
        on s.ghl_id = o.stage_ghl_id and s.pipeline_ghl_id = p_pipeline_ghl_id
      where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
        and (v_status = 'any' or o.status = v_status)
        and (v_stage is null or o.stage_ghl_id = v_stage)
        and (
          not v_has_cursor
          or (v_after_at is not null and (
                o.ghl_created_at < v_after_at
                or (o.ghl_created_at = v_after_at and o.ghl_id > v_after_id)
                or o.ghl_created_at is null))
          or (v_after_at is null and o.ghl_created_at is null and o.ghl_id > v_after_id)
        )
      order by o.ghl_created_at desc nulls last, o.ghl_id
      limit v_limit + 1
    ) page;

    return jsonb_build_object(
      'outcome', 'ok',
      'freshness', v_freshness,
      'limit', v_limit,
      'total_matching', v_total,
      -- So "no leads in that stage" and "no such stage" are not the same answer.
      'stage_exists', case when v_stage is null then null else exists (
        select 1 from public.ghl_stages s
        where s.ghl_id = v_stage and s.pipeline_ghl_id = p_pipeline_ghl_id
      ) end,
      'leads', v_rows,
      'records', least(jsonb_array_length(v_rows), v_limit)
    );
  end if;

  if p_tool = 'search_leads' then
    v_limit := least(greatest(coalesce((p_args ->> 'limit')::integer, 10), 1), 25);
    v_query := left(btrim(coalesce(p_args ->> 'query', '')), 100);
    if char_length(v_query) < 2 then
      raise exception 'search query too short' using errcode = '22023';
    end if;
    -- The query is a value to find, never a pattern: its wildcards are escaped.
    v_like := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_digits := regexp_replace(v_query, '\D', '', 'g');
    v_digits_local := ltrim(v_digits, '0');

    with matched as (
      select
        o.ghl_id as lead_id,
        left(coalesce(
          nullif(btrim(c.full_name), ''),
          nullif(btrim(concat_ws(' ', nullif(btrim(c.first_name), ''), nullif(btrim(c.last_name), ''))), ''),
          nullif(btrim(o.name), '')
        ), 1000) as name,
        o.stage_ghl_id as stage_id,
        left(s.name, 1000) as stage_name,
        s.ghl_id is not null as stage_known,
        coalesce(s.removed_at is not null, false) as stage_removed,
        o.status,
        o.ghl_created_at as created_at,
        o.last_stage_change_at,
        array_remove(array[
          case when c.full_name ilike v_like or c.first_name ilike v_like or c.last_name ilike v_like
                 or concat_ws(' ', c.first_name, c.last_name) ilike v_like then 'name' end,
          case when c.email ilike v_like then 'email' end,
          case when char_length(v_digits_local) >= 4
                 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || v_digits_local || '%'
               then 'phone' end,
          case when o.name ilike v_like then 'opportunity_name' end
        ], null) as matched_on
      from public.ghl_opportunities o
      left join public.ghl_contacts c on c.ghl_id = o.contact_ghl_id and c.removed_at is null
      left join public.ghl_stages s
        on s.ghl_id = o.stage_ghl_id and s.pipeline_ghl_id = p_pipeline_ghl_id
      where o.pipeline_ghl_id = p_pipeline_ghl_id and o.removed_at is null
    ),
    hits as (
      select * from matched m where cardinality(m.matched_on) > 0
    )
    select
      (select count(*) from hits),
      (select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc nulls last, page.lead_id), '[]'::jsonb)
       from (
         select * from hits h order by h.created_at desc nulls last, h.lead_id limit v_limit
       ) page)
      into v_total, v_rows;

    return jsonb_build_object(
      'outcome', 'ok',
      'freshness', v_freshness,
      'limit', v_limit,
      'total_matching', v_total,
      'leads', v_rows,
      'records', jsonb_array_length(v_rows)
    );
  end if;

  if p_tool = 'get_lead' then
    v_lead := p_args ->> 'lead_id';
    select * into v_opportunity
    from public.ghl_opportunities o
    where o.ghl_id = v_lead
      and o.pipeline_ghl_id = p_pipeline_ghl_id
      and o.removed_at is null;
    if not found then
      return jsonb_build_object('outcome', 'not_found', 'records', 0, 'freshness', v_freshness);
    end if;

    select jsonb_build_object(
        'id', s.ghl_id, 'name', left(s.name, 1000), 'position', s.position,
        'removed', s.removed_at is not null)
      into v_stage_row
    from public.ghl_stages s
    where s.ghl_id = v_opportunity.stage_ghl_id and s.pipeline_ghl_id = p_pipeline_ghl_id;

    select jsonb_build_object(
        'full_name', left(c.full_name, 1000),
        'first_name', left(c.first_name, 1000),
        'last_name', left(c.last_name, 1000),
        'email', left(c.email, 1000),
        'phone', left(c.phone, 1000),
        'source', left(c.source, 1000),
        'dnd', c.dnd,
        'tags', to_jsonb(c.tags[1:21]),
        'tags_total', coalesce(cardinality(c.tags), 0),
        'created_at', c.ghl_created_at,
        'updated_at', c.ghl_updated_at,
        'custom_fields', c.custom_fields)
      into v_contact
    from public.ghl_contacts c
    where c.ghl_id = v_opportunity.contact_ghl_id and c.removed_at is null;

    -- The form's answers: the ids the seeded map names, labelled by their mirrored definition.
    select coalesce(jsonb_agg(
        jsonb_build_object(
          'internal_field', m.internal_field,
          'field_id', m.ghl_custom_field_id,
          'label', left(d.name, 1000),
          'value', v_contact -> 'custom_fields' -> m.ghl_custom_field_id
        ) order by m.internal_field
      ), '[]'::jsonb)
      into v_mapped
    from public.ghl_field_map m
    left join public.ghl_custom_fields d on d.ghl_id = m.ghl_custom_field_id
    where m.entity = 'contact' and coalesce(btrim(m.ghl_custom_field_id), '') <> '';

    -- Anything else the contact carries, by id; 21 at most, so the caller knows there are more.
    select count(*), coalesce(jsonb_agg(
        jsonb_build_object('field_id', f.key, 'label', left(f.label, 1000), 'value', f.value)
        order by f.key
      ) filter (where f.rn <= 21), '[]'::jsonb)
      into v_other_total, v_other
    from (
      select e.key, e.value, d.name as label, row_number() over (order by e.key) as rn
      from jsonb_each(coalesce(v_contact -> 'custom_fields', '{}'::jsonb)) e
      left join public.ghl_custom_fields d on d.ghl_id = e.key
      where jsonb_typeof(e.value) not in ('null', 'object')
        and not exists (
          select 1 from public.ghl_field_map m
          where m.entity = 'contact' and m.ghl_custom_field_id = e.key
        )
    ) f;

    select count(*), coalesce(jsonb_agg(
        jsonb_build_object(
          'note_id', n.ghl_id,
          'body', left(n.body, 4000),
          'body_length', char_length(n.body),
          'added_at', n.added_at,
          'yours', n.yours
        ) order by n.added_at desc, n.ghl_id desc
      ) filter (where n.rn <= 5), '[]'::jsonb)
      into v_notes_total, v_notes
    from (
      select x.ghl_id, x.body, coalesce(x.ghl_date_added, x.created_at) as added_at,
             x.author_user_id is not distinct from p_user_id as yours,
             row_number() over (order by coalesce(x.ghl_date_added, x.created_at) desc, x.ghl_id desc) as rn
      from public.ghl_notes x
      where x.opportunity_ghl_id = v_opportunity.ghl_id
    ) n;

    return jsonb_build_object(
      'outcome', 'ok',
      'freshness', v_freshness,
      'records', 1,
      'lead', jsonb_build_object(
        'lead_id', v_opportunity.ghl_id,
        'opportunity_name', left(v_opportunity.name, 1000),
        'status', v_opportunity.status,
        'monetary_value', v_opportunity.monetary_value,
        'source', left(v_opportunity.source, 1000),
        'assigned_to', left(v_opportunity.assigned_to, 100),
        'created_at', v_opportunity.ghl_created_at,
        'updated_at', v_opportunity.ghl_updated_at,
        'last_stage_change_at', v_opportunity.last_stage_change_at,
        'last_status_change_at', v_opportunity.last_status_change_at,
        'stage_id', v_opportunity.stage_ghl_id,
        'stage', v_stage_row,
        'contact', case when v_contact is null then null else v_contact - 'custom_fields' end,
        'form_answers', v_mapped,
        'other_fields', v_other,
        'other_fields_total', v_other_total,
        'notes', v_notes,
        'notes_total', v_notes_total
      )
    );
  end if;

  raise exception 'connector read of an unknown tool' using errcode = '22023';
end;
$$;

comment on function public.connector_read(uuid, text, text, jsonb) is
  'MCP connector. The four read tools, run as role authenticated with auth.uid() set to the key''s user, so the mirror''s own RLS decides what is returned; every query is tied to one pipeline id. Called only by connector_call. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (6) connector_call — the one door
--
-- In one transaction: is this a live key of an active member of staff; has it room left in
-- the minute and in the day; record the call; and, for a tool call, read.
--
-- Returns jsonb, never a row of any table:
--   { outcome: 'unauthenticated', reason }                     nothing was counted
--   { outcome: 'rate_limited', key_id, window, retry_after_seconds }   nothing was counted
--   { outcome: 'ok' | 'read_failed', key_id, call_id, data }
--
-- A refused request is not recorded, so a client in a loop does not extend its own lockout.
-- The limit is exact under concurrency: one key's calls take one lock, in turn.
-- ---------------------------------------------------------------------------------------

create or replace function public.connector_call(
  p_key_id text,
  p_key_hash bytea,
  p_method text,
  p_tool text,
  p_args jsonb,
  p_pipeline_ghl_id text,
  p_per_minute integer,
  p_per_day integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_dummy constant bytea := decode(repeat('00', 32), 'hex');
  v_key public.connector_keys%rowtype;
  v_hash bytea;
  v_found boolean;
  v_match boolean;
  v_minute integer;
  v_day integer;
  v_oldest_minute timestamptz;
  v_oldest_day timestamptz;
  v_call uuid;
  v_started timestamptz := clock_timestamp();
  v_tool text;
  v_subject text;
  v_data jsonb := null;
  v_outcome text := 'ok';
  v_records integer := null;
begin
  if p_per_minute is null or p_per_minute < 1 or p_per_day is null or p_per_day < 1 then
    raise exception 'limits must be positive' using errcode = '22023';
  end if;
  if p_method is null or p_method = '' then
    raise exception 'method is required' using errcode = '22023';
  end if;

  select * into v_key from public.connector_keys k where k.key_id = p_key_id;
  v_found := found;
  if v_found then
    select x.key_hash into v_hash
    from public.connector_key_secrets x where x.connector_key_id = v_key.id;
  end if;
  -- Compared whether or not the id exists, so an unknown id takes the same path as a wrong
  -- secret. An unknown id is refused on v_found, whatever the comparison says.
  v_match := public.connector_digest_equal(
    case when v_found and v_hash is not null then v_hash else v_dummy end,
    p_key_hash
  );
  -- A key row with no digest beside it cannot be matched by anything: it is not a key.
  if not v_found or v_hash is null then
    return jsonb_build_object('outcome', 'unauthenticated', 'reason', 'unknown_key');
  end if;
  if not v_match then
    return jsonb_build_object(
      'outcome', 'unauthenticated', 'reason', 'wrong_secret', 'key_id', v_key.key_id);
  end if;
  if v_key.revoked_at is not null then
    return jsonb_build_object(
      'outcome', 'unauthenticated', 'reason', 'revoked', 'key_id', v_key.key_id);
  end if;
  if not exists (
    select 1 from public.app_users u where u.user_id = v_key.user_id and u.is_active
  ) then
    return jsonb_build_object(
      'outcome', 'unauthenticated', 'reason', 'user_inactive', 'key_id', v_key.key_id);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('connector_key:' || v_key.id::text, 0));

  select
    count(*) filter (where c.created_at > clock_timestamp() - interval '1 minute'),
    count(*),
    min(c.created_at) filter (where c.created_at > clock_timestamp() - interval '1 minute'),
    min(c.created_at)
    into v_minute, v_day, v_oldest_minute, v_oldest_day
  from public.connector_calls c
  where c.connector_key_id = v_key.id
    and c.created_at > clock_timestamp() - interval '1 day';

  if v_day >= p_per_day then
    return jsonb_build_object(
      'outcome', 'rate_limited', 'key_id', v_key.key_id, 'window', 'day',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from
        (v_oldest_day + interval '1 day' - clock_timestamp())))::integer));
  end if;
  if v_minute >= p_per_minute then
    return jsonb_build_object(
      'outcome', 'rate_limited', 'key_id', v_key.key_id, 'window', 'minute',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from
        (v_oldest_minute + interval '1 minute' - clock_timestamp())))::integer));
  end if;

  -- Only a known tool name and a well-formed id are ever written down.
  v_tool := case
    when p_method = 'tools/call'
     and p_tool in ('pipeline_summary', 'list_leads', 'get_lead', 'search_leads') then p_tool
  end;
  v_subject := case
    when v_tool = 'get_lead' and (p_args ->> 'lead_id') ~ '^[A-Za-z0-9_-]{1,64}$'
      then p_args ->> 'lead_id'
  end;

  insert into public.connector_calls (connector_key_id, user_id, method, tool, subject_id, created_at)
  values (
    v_key.id,
    v_key.user_id,
    case
      when p_method in ('initialize', 'notifications/initialized', 'ping', 'server/discover',
                        'tools/list', 'tools/call', 'invalid') then p_method
      else 'other'
    end,
    v_tool,
    v_subject,
    clock_timestamp()
  )
  returning id into v_call;

  update public.connector_keys k set last_used_at = clock_timestamp() where k.id = v_key.id;

  delete from public.connector_calls c
  where c.connector_key_id = v_key.id
    and c.created_at < clock_timestamp() - interval '30 days';

  if v_tool is not null then
    begin
      v_data := public.connector_read(
        v_key.user_id, p_pipeline_ghl_id, v_tool, coalesce(p_args, '{}'::jsonb));
      v_outcome := coalesce(v_data ->> 'outcome', 'ok');
      v_records := (v_data ->> 'records')::integer;
    exception when others then
      -- The read is undone, the role with it; the call stays on record as a failure.
      v_data := jsonb_build_object('sqlstate', sqlstate);
      v_outcome := 'read_failed';
      v_records := null;
    end;
  end if;

  update public.connector_calls c
    set outcome = v_outcome,
        records = v_records,
        duration_ms = floor(extract(epoch from (clock_timestamp() - v_started)) * 1000)::integer
    where c.id = v_call;

  return jsonb_build_object(
    'outcome', case when v_outcome = 'read_failed' then 'read_failed' else 'ok' end,
    'key_id', v_key.key_id,
    'call_id', v_call,
    'data', v_data
  );
end;
$$;

comment on function public.connector_call(text, bytea, text, text, jsonb, text, integer, integer) is
  'MCP connector, the one entry point. Checks the key by constant-time digest comparison, the user and the per-minute and per-day limits under a per-key lock, records the call, and for a tool call returns connector_read''s answer. Never takes a user id. service_role only.';

revoke all on function public.connector_digest_equal(bytea, bytea) from public, anon, authenticated;
revoke all on function public.issue_connector_key(uuid, text, bytea, text, uuid) from public, anon, authenticated;
revoke all on function public.revoke_connector_key(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.connector_read(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.connector_call(text, bytea, text, text, jsonb, text, integer, integer) from public, anon, authenticated;
grant execute on function public.connector_digest_equal(bytea, bytea) to service_role;
grant execute on function public.issue_connector_key(uuid, text, bytea, text, uuid) to service_role;
grant execute on function public.revoke_connector_key(uuid, text, uuid) to service_role;
grant execute on function public.connector_read(uuid, text, text, jsonb) to service_role;
grant execute on function public.connector_call(text, bytea, text, text, jsonb, text, integer, integer) to service_role;
