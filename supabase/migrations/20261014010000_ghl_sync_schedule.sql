-- Keeping the mirror fresh (brief of 14 Oct 2026; docs/MEMORY.md D111–D116).
--
-- The GoHighLevel mirror used to refresh only when a person pressed Refresh in the app. The
-- client's own AI now reads that mirror through the connector, and it cannot press anything:
-- on the day this was written the copy it was reading was 2,641 minutes old. This migration
-- puts a schedule in front of the sync that already exists. It adds no second sync and no
-- second lock.
--
-- How a scheduled refresh happens:
--
--   pg_cron, every ten minutes ──► public.dispatch_ghl_sync()            (this file)
--        ──► pg_net POST ──► the `crm` Edge Function, action `scheduled-sync`
--        ──► runGhlSync, trigger 'schedule'                               (unchanged since M4 part 1)
--        ──► begin_ghl_sync_run / apply_ghl_snapshot / finish_ghl_sync_run (unchanged)
--
-- Design decisions:
--
--  * The scheduler proves itself with a secret OF ITS OWN, not the service-role key. The
--    platform's own guide puts the service-role key in the cron command; that would keep the
--    key that opens every table inside the database (CLAUDE.md rule 17) and inside `cron.job`,
--    which stores each command as text. This secret opens one door — start a sync, under the
--    existing lock — and is read from Vault at call time. The cron command is the bare
--    function call and nothing else.
--  * THE SECRET NEVER TRAVELS. The request carries a token — the second it was made and an
--    HMAC of it keyed with the secret — that the function accepts for two minutes. On a real
--    Supabase stack the API roles hold SELECT on pg_net's request queue (CI found it before
--    the first deploy; a platform grant, not one this file can revoke), and a request waits
--    there until it is sent.
--  * The endpoint's address is in Vault too, so this file names no project, and THE JOB IS
--    INERT UNTIL BOTH VAULT ENTRIES EXIST: in CI, on a developer's stack, and on the live
--    project until the last step of the deploy (RUNBOOK §1h). Unconfigured is recorded once,
--    not every ten minutes.
--  * Every ten minutes, at minutes 3, 13, … 53 UTC. Not hourly: the screens turn amber at
--    exactly 60 minutes, so an hourly schedule would end every healthy cycle in amber. Not
--    fifteen: an interrupted run is retired after 900 seconds, and a tick 900 seconds later
--    would be refused or not depending on a few hundred milliseconds. At ten the next tick is
--    refused (600 s) and the one after retires it and runs (1,200 s). A plain period in UTC;
--    Perth keeps no daylight saving, so nothing ever shifts.
--  * A failure that leaves a run row (a rejected key, a rate limit, GoHighLevel down) is
--    already shown to a person: the app's red alert, and a sentence on every answer the
--    connector gives. A failure that leaves NO row — the function redeployed without this
--    action, its secret and Vault's out of step, the function gone or unreachable — used to be
--    invisible. So before asking for a run, the dispatcher settles the request before it: a
--    scheduled run started → fine; the function said one was already running → fine; anything
--    else → a `failed` row in `ghl_sync_runs` with a code that names the cause, so the same
--    alert and the same sentence fire through what already exists.
--  * `ghl_sync_dispatches` is the record of what each tick did. It is NOT a lock: nothing here
--    ever writes a `running` row, and overlap is still decided by `ghl_sync_runs_one_running`
--    and `begin_ghl_sync_run`, exactly as before.
--
-- What this does not cover: the scheduler itself stopping (the job disabled, Vault emptied,
-- the project paused). Nothing runs to notice. The backstop is the age of the copy, which the
-- screens and the connector state on their own.
--
-- Deploy order (RUNBOOK §1h): this migration → the function secret → the `crm` function →
-- the two Vault entries, last. Until the last step the job does nothing.
--
-- Reversible:
--   select cron.unschedule('ghl-sync');
--   drop function if exists public.dispatch_ghl_sync();
--   drop function if exists public.settle_ghl_sync_dispatch(bigint, integer);
--   drop index if exists public.ghl_sync_runs_applied_idx;
--   drop table if exists public.ghl_sync_dispatches;
--   (pg_net is left installed, as pg_cron was: other work may come to depend on it. The
--    failed rows already written to ghl_sync_runs stay — they are the history.)

-- ---------------------------------------------------------------------------------------
-- (1) pg_net — the database's way to make an HTTP request
--
-- A Supabase-supported extension, installed here so a from-zero replay ends with everything
-- the job needs. Its functions live in the `net` schema, which the API does not expose.
-- ---------------------------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------------------------
-- (2) ghl_sync_dispatches — what each tick of the schedule did
-- ---------------------------------------------------------------------------------------

create table public.ghl_sync_dispatches (
  id bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  -- requested       asked, not yet settled (settled by the next tick)
  -- started         a scheduled run began: the request worked, whatever the run then did
  -- already_running the function refused because a run held the slot — not a failure
  -- failed          no run came of it; `error_code` says why and `run_id` is the failed row
  -- not_configured  Vault holds no address or no secret; nothing was asked
  outcome text not null constraint ghl_sync_dispatches_outcome_check
    check (outcome in ('requested', 'started', 'already_running', 'failed', 'not_configured')),
  -- pg_net's id for the request. Null when none was made.
  request_id bigint,
  -- The pipeline the newest run was for when this was asked: where a failure is recorded.
  -- Null on a project that has never synced — then there is no screen to tell.
  pipeline_ghl_id text,
  http_status integer,
  error_code text,
  -- The run this request started, or the failed row written because it started none.
  run_id uuid references public.ghl_sync_runs (id) on delete set null,
  settled_at timestamptz
);

create index ghl_sync_dispatches_pending_idx
  on public.ghl_sync_dispatches (id)
  where outcome = 'requested';
create index ghl_sync_dispatches_requested_idx
  on public.ghl_sync_dispatches (requested_at desc);

comment on table public.ghl_sync_dispatches is
  'One row per tick of the ghl-sync schedule that asked for a refresh, and what came of it (14 Oct 2026, D113). Timestamps, ids and codes only — never a secret and never a person''s details. Not a lock: overlap is decided by ghl_sync_runs.';

alter table public.ghl_sync_dispatches enable row level security;
alter table public.ghl_sync_dispatches force row level security;

revoke all on public.ghl_sync_dispatches from anon, authenticated;
grant select on public.ghl_sync_dispatches to authenticated;
grant all on public.ghl_sync_dispatches to service_role;

create policy staff_read_ghl_sync_dispatches on public.ghl_sync_dispatches
  for select to authenticated
  using (public.is_active_staff());

-- The connector and both screens look up the newest run that applied. With a run every ten
-- minutes the log grows by about 52,000 rows a year; this keeps that lookup an index read.
create index ghl_sync_runs_applied_idx
  on public.ghl_sync_runs (applied_at desc)
  where applied_at is not null;

comment on column public.ghl_sync_runs.errors is
  '[{ "kind": "contact"|"opportunity"|"custom_fields"|"stale"|"schedule", "id": "<ghl id, run id or dispatch id>", "code": "<code>" }] — ids only, never a name.';

-- ---------------------------------------------------------------------------------------
-- (3) settle_ghl_sync_dispatch — did a request become a run?
--
-- The run log is the truth, not the HTTP exchange: a request whose answer was lost but whose
-- run started has worked, and one answered 200 with no run has not. `p_http_status` is what
-- pg_net recorded, or null when nothing answered (timed out, refused, never sent).
--
-- A request that produced nothing gets a FAILED row in ghl_sync_runs, for the pipeline the
-- mirror holds, so the app's alert and the connector's sentence say so. The row is written
-- as `failed`, never `running`: it cannot take the slot or refuse anyone.
--
-- Idempotent: a dispatch that is no longer `requested` is left alone.
-- ---------------------------------------------------------------------------------------

create or replace function public.settle_ghl_sync_dispatch(
  p_dispatch_id bigint,
  p_http_status integer
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  d public.ghl_sync_dispatches%rowtype;
  v_run uuid;
  v_code text;
  v_error text;
begin
  select * into d
  from public.ghl_sync_dispatches x
  where x.id = p_dispatch_id and x.outcome = 'requested'
  for update;
  if not found then
    return null;
  end if;

  -- A run asks for its slot within a second or two of the request; five minutes is past the
  -- function's own time limit and well short of the next tick. The rows this function
  -- writes are excluded, so one request's failure can never read as another's success.
  select r.id into v_run
  from public.ghl_sync_runs r
  where r.trigger = 'schedule'
    and r.started_at >= d.requested_at
    and r.started_at < d.requested_at + interval '5 minutes'
    and (r.error_code is null or r.error_code not like 'SCHEDULE\_%')
  order by r.started_at
  limit 1;

  if v_run is not null then
    update public.ghl_sync_dispatches x
      set outcome = 'started', http_status = p_http_status, run_id = v_run, settled_at = now()
      where x.id = d.id;
    return 'started';
  end if;

  if p_http_status = 409 then
    update public.ghl_sync_dispatches x
      set outcome = 'already_running', http_status = p_http_status, settled_at = now()
      where x.id = d.id;
    return 'already_running';
  end if;

  v_code := case
    when p_http_status is null then 'SCHEDULE_UNREACHABLE'
    when p_http_status in (401, 403) then 'SCHEDULE_REJECTED'
    when p_http_status = 404 then 'SCHEDULE_FUNCTION_MISSING'
    when p_http_status = 400 then 'SCHEDULE_CONTRACT'
    when p_http_status between 200 and 299 then 'SCHEDULE_NO_RUN'
    else 'SCHEDULE_FUNCTION_ERROR'
  end;
  v_error := case v_code
    when 'SCHEDULE_UNREACHABLE' then
      'the scheduled refresh was requested and nothing answered: the crm function timed out, could not be reached, or the request was never sent'
    when 'SCHEDULE_REJECTED' then
      'the crm function refused the scheduled refresh: the schedule''s secret in Vault and the function''s CRM_SCHEDULE_SECRET do not match, the function has none, or the two clocks are more than two minutes apart'
    when 'SCHEDULE_FUNCTION_MISSING' then
      'the scheduled refresh got a 404: the address in Vault is wrong, or the crm function is not deployed'
    when 'SCHEDULE_CONTRACT' then
      'the crm function did not recognise the scheduled refresh: it was deployed without the scheduled-sync action'
    when 'SCHEDULE_NO_RUN' then
      'the scheduled refresh was answered as a success and no run started: the address in Vault is not the crm function'
    else
      'the crm function failed before a run could start (HTTP ' || p_http_status::text || '): it is misconfigured or could not reach the database'
  end;

  if d.pipeline_ghl_id is not null then
    insert into public.ghl_sync_runs (
      pipeline_ghl_id, trigger, triggered_by, status, started_at, finished_at,
      error_code, error, errors
    )
    values (
      d.pipeline_ghl_id, 'schedule', null, 'failed', d.requested_at, now(),
      v_code, v_error,
      jsonb_build_array(jsonb_build_object('kind', 'schedule', 'id', d.id::text, 'code', v_code))
    )
    returning id into v_run;
  end if;

  update public.ghl_sync_dispatches x
    set outcome = 'failed', http_status = p_http_status, error_code = v_code,
        run_id = v_run, settled_at = now()
    where x.id = d.id;
  return 'failed';
end;
$$;

comment on function public.settle_ghl_sync_dispatch(bigint, integer) is
  '14 Oct 2026 (D113). Decides what came of one scheduled request from the run log, and writes a failed row to ghl_sync_runs when no run came of it. Idempotent. Owner only.';

-- ---------------------------------------------------------------------------------------
-- (4) dispatch_ghl_sync — what pg_cron runs
--
-- In order: settle what earlier ticks asked for; keep its own history bounded; read the
-- address and the secret from Vault; ask. The request is asynchronous — pg_net sends it
-- after this transaction commits — so this function never waits on GoHighLevel and never
-- holds a connection while a sync runs.
--
-- A request is settled only once it is older than the three minutes the function has to
-- answer in, so calling this by hand straight after a tick cannot mark that tick failed.
-- ---------------------------------------------------------------------------------------

create or replace function public.dispatch_ghl_sync()
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  d record;
  v_status integer;
  v_url text;
  v_secret text;
  v_pipeline text;
  v_request bigint;
  v_at bigint;
  v_token text;
begin
  for d in
    select x.id, x.request_id
    from public.ghl_sync_dispatches x
    where x.outcome = 'requested' and x.requested_at < now() - interval '3 minutes'
    order by x.id
  loop
    v_status := null;
    select r.status_code into v_status from net._http_response r where r.id = d.request_id;
    perform public.settle_ghl_sync_dispatch(d.id, v_status);
  end loop;

  delete from public.ghl_sync_dispatches x where x.requested_at < now() - interval '30 days';

  -- pg_cron keeps a row per run of every job for ever; this job makes 144 a day. Tidying
  -- it is housekeeping, so a refusal here must not stop the refresh that follows.
  begin
    delete from cron.job_run_details j
    where j.jobid in (select c.jobid from cron.job c where c.jobname = 'ghl-sync')
      and j.end_time < now() - interval '7 days';
  exception
    when insufficient_privilege or undefined_table or invalid_schema_name then
      null;
  end;

  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s where s.name = 'ghl_sync_schedule_url';
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s where s.name = 'ghl_sync_schedule_secret';

  -- https only: a mistyped address must not carry even a two-minute token in the clear. A
  -- secret shorter than 32 characters was not generated.
  if coalesce(v_url, '') !~ '^https://' or char_length(coalesce(v_secret, '')) < 32 then
    if not exists (
      select 1 from public.ghl_sync_dispatches x
      where x.outcome = 'not_configured'
        and x.id = (select max(y.id) from public.ghl_sync_dispatches y)
    ) then
      insert into public.ghl_sync_dispatches (outcome, settled_at)
      values ('not_configured', now());
    end if;
    return 'not_configured';
  end if;

  -- The database does not know which pipeline the function is configured for; the newest
  -- run's pipeline is the same fact from this side (the screens use the same rule).
  select r.pipeline_ghl_id into v_pipeline
  from public.ghl_sync_runs r
  order by r.started_at desc
  limit 1;

  -- The secret never leaves this function. What is sent is a token: this second, and the
  -- HMAC-SHA256 of "scheduled-sync:<this second>" keyed with the secret. The crm function
  -- makes the same HMAC and refuses a token more than two minutes from its own clock
  -- (src/lib/crm/schedule.ts). It has to be so: the API roles hold SELECT on pg_net's queue
  -- on Supabase, a platform grant this project cannot revoke, and the request waits there
  -- until it is sent.
  v_at := floor(extract(epoch from clock_timestamp()))::bigint;
  v_token := v_at::text || '.' || encode(
    extensions.hmac(convert_to('scheduled-sync:' || v_at::text, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'),
    'hex'
  );

  -- 150 s is the function's own time limit: pg_net should never give up before it does.
  v_request := net.http_post(
    url := v_url,
    body := jsonb_build_object('action', 'scheduled-sync'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-crm-schedule-token', v_token
    ),
    timeout_milliseconds := 150000
  );

  insert into public.ghl_sync_dispatches (outcome, request_id, pipeline_ghl_id)
  values ('requested', v_request, v_pipeline);
  return 'requested';
end;
$$;

comment on function public.dispatch_ghl_sync() is
  '14 Oct 2026 (D111). Run by pg_cron (job ghl-sync) every ten minutes: settles the previous request, then asks the crm Edge Function for a refresh through pg_net, with a two-minute token signed by a secret read from Vault (the secret itself is never sent). Does nothing until Vault holds ghl_sync_schedule_url and ghl_sync_schedule_secret. Owner only.';

-- Nobody but the owner (the role pg_cron runs the job as): not a browser session, and not
-- the service role either — the server has no reason to start a tick. Postgres grants
-- EXECUTE to PUBLIC by default, and this schema's default privileges add the three API roles.
revoke all on function public.settle_ghl_sync_dispatch(bigint, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.dispatch_ghl_sync()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- (5) The schedule
--
-- `cron.schedule` with a job name replaces a job of the same name, so re-running is safe.
-- Minute 3 and every ten after it: off the top of the hour, and clear of the purge at 03:17.
-- The command is the bare call — it is stored as text in cron.job and in the job's history,
-- and nothing secret may ever be written there.
-- ---------------------------------------------------------------------------------------

select cron.schedule(
  'ghl-sync',
  '3-59/10 * * * *',
  $$select public.dispatch_ghl_sync()$$
);
