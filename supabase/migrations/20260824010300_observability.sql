-- Integration observability: workflow_runs, api_usage, audit_log (SCHEMA.md §3, task 2.2.6).
-- workflow_runs comes first because api_usage references it.
--
-- Reversible: drop table public.api_usage; drop table public.audit_log;
--             drop table public.workflow_runs;

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_name text not null,
  n8n_execution_id text,
  status text not null default 'running'
    check (status in ('running', 'success', 'failed', 'partial')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  input jsonb,
  output jsonb,
  error text,
  items_in integer,
  items_out integer,
  items_failed integer
);

-- Powers the $50/month cap (SECURITY.md §8) and the per-conversation cost view on the
-- Stage 3 dashboard. Cache token columns exist because prompt caching on the voice/brand
-- prefix is the main cost lever, and a cap that cannot see cache hits cannot be tuned.
-- The first Claude call in Stage 2 part 4 must land a row here.
create table public.api_usage (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('anthropic', 'voyage', 'ghl', 'meta')),
  operation text,
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  units integer,
  cost_usd numeric(10, 6),
  workflow_run_id uuid references public.workflow_runs (id),
  user_id uuid references auth.users (id),
  conversation_id uuid references public.conversations (id),
  created_at timestamptz not null default now()
);

create index api_usage_workflow_run_id_idx on public.api_usage (workflow_run_id);
create index api_usage_user_id_idx on public.api_usage (user_id);
create index api_usage_conversation_id_idx on public.api_usage (conversation_id);
-- The daily/monthly cap check is a date-range scan; without this it is a seq scan that
-- grows with every call ever made.
create index api_usage_created_at_idx on public.api_usage (created_at);

-- Written by trigger on every mutation to consumer_leads, review_queue, memory_facts and
-- app_users (triggers migration), and by application code on every Claude tool execution.
-- No audit trigger is ever attached to audit_log itself.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
