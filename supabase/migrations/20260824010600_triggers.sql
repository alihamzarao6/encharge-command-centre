-- updated_at and audit triggers (SCHEMA.md §2, §3; task 2.2.9).
--
-- updated_at: on the two tables that carry the column (consumer_leads, tasks).
-- audit: on consumer_leads, review_queue, memory_facts and app_users (contacts was on the
-- 09 Aug list and is parked, D36). audit_log itself never gets an audit trigger.
--
-- Reversible: drop the triggers, then the functions.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger consumer_leads_set_updated_at
  before update on public.consumer_leads
  for each row
  execute function public.set_updated_at();

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row
  execute function public.set_updated_at();

-- Generic audit writer. actor is the authenticated user where one exists (auth.uid() is
-- set by PostgREST / Edge Functions), else the database role (e.g. 'postgres' during
-- seeds and migrations). The entity id is pulled from the row's `id`, falling back to
-- `user_id` for app_users, whose primary key is user_id. before/after are whole-row jsonb:
-- audit_log is an RLS-protected table, not a log line, so CLAUDE.md rule 20 (log PII by ID
-- only) applies to the logger, not here — SCHEMA.md §3 specifies full before/after images.
create or replace function public.write_audit_log()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_actor text := coalesce((select auth.uid())::text, current_user::text);
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_entity_id uuid := coalesce((v_row ->> 'id')::uuid, (v_row ->> 'user_id')::uuid);
begin
  insert into public.audit_log (actor, action, entity_type, entity_id, before, after)
  values (
    v_actor,
    tg_op,
    tg_table_name,
    v_entity_id,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger consumer_leads_audit
  after insert or update or delete on public.consumer_leads
  for each row
  execute function public.write_audit_log();

create trigger review_queue_audit
  after insert or update or delete on public.review_queue
  for each row
  execute function public.write_audit_log();

create trigger memory_facts_audit
  after insert or update or delete on public.memory_facts
  for each row
  execute function public.write_audit_log();

create trigger app_users_audit
  after insert or update or delete on public.app_users
  for each row
  execute function public.write_audit_log();
