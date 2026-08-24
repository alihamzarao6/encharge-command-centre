-- Core entities (SCHEMA.md §1, §2, §3, §6; tasks 2.2.7).
-- consumer_leads, field_overrides, review_queue, crm_sync_log, ghl_field_map, tasks,
-- notion_sync_map. The shared enums of §1 are inline check constraints per the SCHEMA
-- conventions ("Enums as Postgres check constraints, not app-level strings").
--
-- contacts does NOT ship: parked with the research engine on review (D36) — it was the
-- decision-maker table, nothing in stages 2–6 uses it, and consumer_leads covers the
-- people who actually arrive from the ads.
--
-- Reversible: drop the tables in reverse order.

-- The consent and opt-out record for the people who receive marketing, and the local
-- mirror of a GoHighLevel contact in the Finance Pipeline. consent_basis and opt_out are
-- mandatory from day one, before any outbound exists (Spam Act 2003 (Cth), R10, R17).
create table public.consumer_leads (
  id uuid primary key default gen_random_uuid(),
  -- full_name, lead_type, pipeline_stage and lead_source are not null (review decision,
  -- 24 Aug): a lead with no name and no stage is not a lead, and every writer (form
  -- intake, GHL sync) knows all four. No default on pipeline_stage on purpose — a default
  -- would let a sync bug silently file everything as new.
  full_name text not null,
  email text,
  phone text,
  -- The eight categories Ross confirmed (CLIENT-CONTEXT.md §2). A taxonomy only — under
  -- Scope v3 no type is researched (D23).
  lead_type text not null check (
    lead_type in (
      'commercial', 'asset_finance', 'referral_partner', 'first_home_owner',
      'refinance', 'investor', 'referral', 'building'
    )
  ),
  -- The ten live Finance Pipeline stages built in GHL in Stage 1 (D28) — these values and
  -- nothing else. The mapping to GHL stage IDs lives in ghl_field_map, so a renamed GHL
  -- stage is a data change, not a migration. The nine pre-Stage-1 stage names were never
  -- built and must not appear here (R15).
  pipeline_stage text not null check (
    pipeline_stage in (
      'new_lead', 'appointment_booked', 'contacted', 'qualified', 'docs_requested',
      'docs_received', 'submitted_to_lender', 'approved', 'settled', 'lost_not_proceeding'
    )
  ),
  -- 'outbound_research' is retained so historical intent stays readable, but nothing sets
  -- it — it belonged to the parked research engine (D23).
  lead_source text not null check (
    lead_source in (
      'social_media', 'ads', 'referrals', 'networking', 'previous_client',
      'outbound_research', 'other'
    )
  ),
  ghl_contact_id text,
  ghl_opportunity_id text,
  owner text,
  notes text,
  enquiry_detail jsonb,
  consent_basis text check (consent_basis in ('inferred', 'express', 'none')),
  -- not null default false on purpose: an unset value must never read as "no objection".
  -- The query is `where opt_out = false`, never `where opt_out is not true`.
  opt_out boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ghl_contact_id is the idempotency key for anything that writes to GHL (CLAUDE.md rule 9).
create unique index consumer_leads_ghl_contact_id_uniq
  on public.consumer_leads (ghl_contact_id)
  where ghl_contact_id is not null;

-- Human corrections without destroying provenance: the original is preserved, the override
-- sits beside it. Reads use the override; audits can see both. Values are jsonb so a
-- numeric, boolean or structured field survives the round trip typed.
create table public.field_overrides (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  field_name text not null,
  original_value jsonb,
  override_value jsonb,
  reason text,
  overridden_by text,
  created_at timestamptz not null default now()
);

create index field_overrides_entity_idx on public.field_overrides (entity_type, entity_id);

-- CLAUDE.md rule 14: below the confidence threshold goes here, never straight to the CRM,
-- the knowledge store or published copy. entity_type settled in part 2 (D37): the three
-- producers named in the binding docs. Widening this check is a trivial migration; the
-- constraint exists to reject typos and parked-era values ('org', 'contact').
create table public.review_queue (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null
    check (entity_type in ('consumer_lead', 'web_fact', 'content_draft')),
  entity_id uuid,
  -- reason is not null (review decision, 24 Aug): rule-14 routing always has a cause
  -- (below threshold, failed validation, failed voice check), and a queue item the
  -- reviewer cannot see the reason for is unreviewable.
  reason text not null,
  payload jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  notion_page_id text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  -- An item must point at a stored row OR carry the thing under review inline (a content
  -- draft that only exists here). Both null would be an unreviewable ghost.
  constraint review_queue_target_check check (entity_id is not null or payload is not null)
);

create index review_queue_status_idx on public.review_queue (status);
create index review_queue_entity_idx on public.review_queue (entity_type, entity_id);

-- external_id enforces idempotency: checked before any push (CLAUDE.md rule 9). 'meta' is
-- a provider because the Refi Pixel Conversions API is a server-side write to an external
-- system — its event_id dedupe key is the external_id here (D31).
create table public.crm_sync_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  provider text not null check (provider in ('ghl', 'meta')),
  external_id text,
  operation text not null check (operation in ('create', 'update')),
  status text not null check (status in ('success', 'failed', 'skipped')),
  attempt integer not null default 1,
  request_payload jsonb,
  response_payload jsonb,
  error text,
  synced_at timestamptz not null default now()
);

create index crm_sync_log_idempotency_idx on public.crm_sync_log (provider, external_id);

-- Configuration, not code: GHL custom field IDs are account-specific, so pointing at a
-- different sub-account is a data change, not a redeploy. Two jobs since Stage 1: the ten
-- custom fields in their own folder, and the ten Finance Pipeline stage IDs
-- (entity = 'stage'). GHL objects are matched on ID, never on name — this account has
-- produced three name traps already (trailing space, 'Assest Finance', a U+00A0
-- non-breaking space; MEMORY.md 12 Aug).
create table public.ghl_field_map (
  id uuid primary key default gen_random_uuid(),
  internal_field text not null,
  -- Nullable: rows can exist before their GHL id is known (the ten custom-field rows will
  -- arrive that way). Nothing may sync against a NULL id. The ten stage rows are seeded
  -- with real IDs from the 24 Aug authorized read (MEMORY.md 24 Aug).
  ghl_custom_field_id text,
  ghl_field_key text,
  entity text not null check (entity in ('contact', 'opportunity', 'stage')),
  created_at timestamptz not null default now(),
  -- One mapping per internal field per object kind; also what the seed upserts against.
  unique (entity, internal_field)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  assignee text,
  due_date date,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'done', 'cancelled')),
  -- Unconstrained on purpose: the proposed values (low/medium/high/urgent) were never
  -- confirmed by Ross (R11). The check is added by migration once he confirms.
  priority text,
  -- not null (review decision, 24 Aug): every task has an origin, and provenance of who or
  -- what created a task matters once the assistant can write them (Stage 3, D9). No
  -- default — the writer states it.
  source text not null check (source in ('claude', 'notion', 'manual')),
  notion_page_id text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Prevents duplicate Notion pages and lets the writeback know which fields changed. Only
-- the editable fields listed in CLIENT-CONTEXT.md §8 are ever accepted from a Notion pull
-- (D22 — enforced by the sync whitelist, not by Notion).
create table public.notion_sync_map (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  notion_database_id text,
  notion_page_id text,
  last_pushed_at timestamptz,
  last_pulled_at timestamptz,
  content_hash text,
  created_at timestamptz not null default now(),
  -- "Prevents duplicate Notion pages" is this constraint.
  unique (entity_type, entity_id)
);
