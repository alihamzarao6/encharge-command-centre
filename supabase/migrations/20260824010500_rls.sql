-- Row-level security (SCHEMA.md §7, SECURITY.md §6, task 2.2.8).
--
-- Every table: enable AND force, deny-by-default. FORCE matters because the table owner
-- (postgres) is otherwise exempt — with force, even owner queries go through policies
-- (postgres still bypasses via its BYPASSRLS attribute, which is what lets migrations and
-- seeds run; anon and authenticated have no such attribute).
--
-- Privilege layer (grants) — explicit, never inherited. RLS filters rows only AFTER the
-- privilege check passes, and the two environments disagree about defaults: hosted
-- Supabase pre-grants ALL on postgres-created tables to anon/authenticated via default
-- privileges, while the local/CI stack grants nothing (found by CI on the first push:
-- 42501 "permission denied for table conversations" for authenticated — the policies were
-- never even evaluated). So this migration states the privilege layer itself:
-- anon holds NOTHING; authenticated holds SELECT and nothing else. On hosted this REVOKES
-- the implicit write grants — defense in depth even though RLS already blocks the rows.
-- tests/security/rls.test.ts asserts the grants per table, so a future migration that
-- forgets to grant (or over-grants) fails loudly instead of passing quietly.
--
-- Policy shape:
--   * No policy for anon, anywhere — and no grants either. Zero table access on the
--     public key (SECURITY.md §4).
--   * authenticated gets SELECT only, gated on the app_users allowlist. No insert/update/
--     delete policies exist for authenticated on any table: all writes go through Edge
--     Functions / n8n running as service_role (BYPASSRLS), which validate input and write
--     the audit log.
--   * app_users itself is self-row-only (user_id = auth.uid() and is_active). This is what
--     makes the allowlist EXISTS subquery in every other policy work without recursion:
--     the caller can see exactly their own active row and nothing else. A non-allowlisted
--     or deactivated account sees zero rows here and therefore zero rows everywhere.
--   * The four memory tables add the ownership clause (D33): scope = 'workspace' rows are
--     readable by every active staff member ("one brain"); scope = 'user' rows only by
--     their owner.
--
-- Verified by tests/security/rls.test.ts, which iterates pg_tables so a table added later
-- without RLS fails CI.
--
-- Reversible: drop the policies; alter table ... no force row level security; disable.

-- ---------------------------------------------------------------------------------------
-- Enable + force on every table
-- ---------------------------------------------------------------------------------------

alter table public.app_users enable row level security;
alter table public.app_users force row level security;

alter table public.conversations enable row level security;
alter table public.conversations force row level security;

alter table public.messages enable row level security;
alter table public.messages force row level security;

alter table public.memory_chunks enable row level security;
alter table public.memory_chunks force row level security;

alter table public.memory_facts enable row level security;
alter table public.memory_facts force row level security;

alter table public.workflow_runs enable row level security;
alter table public.workflow_runs force row level security;

alter table public.api_usage enable row level security;
alter table public.api_usage force row level security;

alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;

alter table public.consumer_leads enable row level security;
alter table public.consumer_leads force row level security;

alter table public.field_overrides enable row level security;
alter table public.field_overrides force row level security;

alter table public.review_queue enable row level security;
alter table public.review_queue force row level security;

alter table public.crm_sync_log enable row level security;
alter table public.crm_sync_log force row level security;

alter table public.ghl_field_map enable row level security;
alter table public.ghl_field_map force row level security;

alter table public.tasks enable row level security;
alter table public.tasks force row level security;

alter table public.notion_sync_map enable row level security;
alter table public.notion_sync_map force row level security;

-- ---------------------------------------------------------------------------------------
-- Privilege layer: normalize away environment defaults, then state the intended grants.
-- Covers the 15 tables above; any later migration that adds a table must carry its own
-- grant (the RLS test iterates pg_tables and fails CI if one is missing).
-- ---------------------------------------------------------------------------------------

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------------------------
-- app_users: self-row only, active only
-- ---------------------------------------------------------------------------------------

create policy app_users_select_self on public.app_users
  for select to authenticated
  using (user_id = (select auth.uid()) and is_active);

-- ---------------------------------------------------------------------------------------
-- Staff-allowlist SELECT on every non-memory table
-- ---------------------------------------------------------------------------------------

create policy staff_read_consumer_leads on public.consumer_leads
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_field_overrides on public.field_overrides
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_review_queue on public.review_queue
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_crm_sync_log on public.crm_sync_log
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_ghl_field_map on public.ghl_field_map
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_tasks on public.tasks
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_notion_sync_map on public.notion_sync_map
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_workflow_runs on public.workflow_runs
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_api_usage on public.api_usage
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy staff_read_audit_log on public.audit_log
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

-- ---------------------------------------------------------------------------------------
-- Memory tables: allowlist AND (workspace-shared or own) — D33
-- ---------------------------------------------------------------------------------------

create policy workspace_or_own_conversations on public.conversations
  for select to authenticated
  using (
    (scope = 'workspace' or user_id = (select auth.uid()))
    and exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy workspace_or_own_messages on public.messages
  for select to authenticated
  using (
    (scope = 'workspace' or user_id = (select auth.uid()))
    and exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy workspace_or_own_memory_chunks on public.memory_chunks
  for select to authenticated
  using (
    (scope = 'workspace' or user_id = (select auth.uid()))
    and exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );

create policy workspace_or_own_memory_facts on public.memory_facts
  for select to authenticated
  using (
    (scope = 'workspace' or user_id = (select auth.uid()))
    and exists (
      select 1 from public.app_users u
      where u.user_id = (select auth.uid()) and u.is_active
    )
  );
