# SCHEMA.md — Data Model

Supabase Postgres 15 + pgvector. Every table has RLS enabled and deny-by-default policies.
Migrations in `supabase/migrations/`, replayable from an empty database.

**Platform note:** if Ross confirms MongoDB, this file is rewritten before any code changes.
Do not partially migrate. See `CLAUDE.md` §3.

Conventions:
- `id uuid primary key default gen_random_uuid()`
- `created_at timestamptz not null default now()`, `updated_at` via trigger
- Soft delete via `deleted_at` — **never** hard-delete a record with provenance
- Enums as Postgres `check` constraints, not app-level strings
- Every foreign key indexed

---

## 1. Shared enums

```sql
-- lead_type: which pipeline a record belongs to
--   researched:    'commercial' | 'asset_finance' | 'referral_partner'
--   tracking only: 'first_home_owner' | 'refinance' | 'investor'
--                  | 'referral' | 'building'

-- pipeline_stage (nine, shared across all lead types):
--   'lead_in' | 'full_details' | 'booked_calendar' | 'docs_sent'
--   | 'ongoing_loan_app' | 'no_show' | 'retarget' | 'disqualify' | 'settled'

-- lead_source:
--   'social_media' | 'ads' | 'referrals' | 'networking'
--   | 'previous_client' | 'outbound_research' | 'other'
```

A helper `is_researched_type(lead_type)` returns true only for the three business types. The
pipeline uses it as a routing guard so a consumer record can never enter the crawler.

---

## 2. Core entities

### organizations — business records (lead types 1–3)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text not null | as supplied |
| normalized_name | text not null | lowercased, legal suffixes stripped |
| **lead_type** | text not null | check: one of the three researched types |
| **pipeline_stage** | text not null default 'lead_in' | check against the nine stages |
| **lead_source** | text not null default 'outbound_research' | |
| domain | text | registrable domain, no `www.` |
| domain_hash | text unique | sha256(domain) — the dedupe key |
| website_url | text | resolved homepage |
| website_confidence | numeric(3,2) | 0–1 from resolution |
| industry | text | |
| industry_code | text | ANZSIC where derivable |
| employee_estimate | int | |
| **agent_count** | int | referral partners: agents/advisers found. Feeds Rubric B |
| **has_inhouse_finance** | boolean | referral partners: independence signal |
| locality / state | text | suburb, WA etc |
| country | text default 'AU' | |
| abn | text | if found on site |
| status | text | `queued · discovering · enriching · ranked · pushed · rejected · review` |
| reject_reason | text | |
| owner | text | assigned staff member |
| notes | text | human-editable |
| intake_source | text | `notion · csv · ghl_webhook · api` |
| created_at / updated_at / deleted_at | timestamptz | |

Indexes: `domain_hash` unique · `normalized_name` gin_trgm · `lead_type` · `pipeline_stage`
· `status` · `created_at`.

### consumer_leads — individual records (lead types 4–8)
Deliberately a separate table. These have no website, no crawl, no ranking, and mixing them
into `organizations` would make every research query carry a filter it could forget.

`id · full_name · email · phone · lead_type (check: one of the five consumer types) ·
pipeline_stage · lead_source · ghl_contact_id · owner · notes · enquiry_detail jsonb ·
consent_basis text · opt_out boolean not null default false ·
created_at · updated_at · deleted_at`

**`consent_basis` and `opt_out` are mandatory, not optional.** Consumer leads are precisely the
people who receive marketing email — they arrive from ads and forms and are the audience for
every outbound campaign. Under the **Spam Act 2003 (Cth)** each of those messages needs a
recorded consent basis and a working unsubscribe, so both columns exist from day one, before any
outbound is built. `consent_basis` takes the same values as `contacts`: `inferred · express ·
none`. `opt_out` is `not null default false` so an unset value can never be read as "no
objection" — the check is `where opt_out = false`, never `where opt_out is not true`.

`opt_out` is one of the few system-adjacent fields that is **human-editable from Notion**
(see `CLIENT-CONTEXT.md` §8). An unsubscribe request is a legal obligation with a deadline; it
cannot wait for a review-queue round trip.

### org_sources — provenance for every page touched
`id · org_id FK · source_type (homepage|about|team|contact|agents|finance|search_result) ·
source_url not null · http_status · fetched_at not null · content_hash · storage_path ·
clean_text · robots_allowed not null`

Unique on `(org_id, source_url)`.

### contacts
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| org_id | uuid FK | |
| full_name / first_name / last_name | text | |
| title | text | |
| seniority | text | `owner · c_suite · director · manager · other` |
| department | text | |
| email | text | |
| email_status | text | `valid · risky · invalid · unknown · catch_all · not_found` |
| email_is_inferred | boolean not null default false | surfaced in Notion and GHL |
| phone | text | E.164 |
| linkedin_url | text | |
| source_url | text **not null** | provenance — required |
| extraction_method | text **not null** | `llm · regex · structured_data · manual` |
| confidence | numeric(3,2) **not null** | |
| is_flagged | boolean default false | |
| flag_reason | text | |
| consent_basis | text | `inferred · express · none` — Spam Act |
| opt_out | boolean default false | |
| created_at / updated_at / deleted_at | | |

Unique on `(org_id, lower(email)) where email is not null and deleted_at is null`.

### email_verifications
`id · contact_id FK · email · syntax_ok · mx_ok · is_disposable · is_role_account ·
provider_name · provider_result jsonb · final_status · cost_usd · verified_at`

One row per attempt. History retained — re-verification never overwrites.

### rankings
`id · org_id FK · rubric_key text ('business_finance'|'referral_partner') · score int ·
tier char(1) · reasoning text · confidence numeric(3,2) · flags text[] · rubric_version int
FK · model text · input_tokens · output_tokens · cost_usd · created_at`

Never updated. A re-rank inserts a new row; latest by `created_at` is current.

### rubric_versions
`id · rubric_key text · version int · rubric jsonb not null · notes · is_active bool ·
created_at`

Unique on `(rubric_key, version)`. Partial unique index enforces exactly one active version
per `rubric_key`. Seeded with Rubric A and Rubric B from `CLIENT-CONTEXT.md` §5–6.

### field_overrides — human corrections without destroying provenance
`id · entity_type · entity_id · field_name · original_value · override_value · reason ·
overridden_by · created_at`

When Ross corrects a system-derived field, the original is preserved and the override sits
beside it. Reads use the override; audits can see both.

### review_queue
`id · entity_type (org|contact) · entity_id · reason · payload jsonb ·
status (pending|approved|rejected) · notion_page_id · reviewed_by · reviewed_at · created_at`

### merge_log
`id · surviving_id · merged_id · entity_type · similarity · decided_by (auto|human) · created_at`

---

## 3. Integration and observability

### crm_sync_log
`id · entity_type · entity_id · provider ('ghl'|'sheets') · external_id ·
operation (create|update) · status (success|failed|skipped) · attempt int ·
request_payload jsonb · response_payload jsonb · error · synced_at`

`external_id` enforces idempotency. Checked before any push.

### ghl_field_map — configuration, not code
`id · internal_field · ghl_custom_field_id · ghl_field_key · entity (contact|opportunity) ·
created_at`

GoHighLevel custom field IDs are account-specific. Keeping the mapping in a table means
pointing at a different sub-account is a data change, not a redeploy.

### workflow_runs
`id · workflow_name · n8n_execution_id · status (running|success|failed|partial) ·
started_at · finished_at · input jsonb · output jsonb · error · items_in · items_out ·
items_failed`

### api_usage
`id · provider (anthropic|voyage|serper|millionverifier|ghl|meta|linkedin) · operation ·
input_tokens · output_tokens · units · cost_usd numeric(10,6) · workflow_run_id · org_id ·
created_at`

Powers the per-lead cost NFR and the $50/month cap. A daily rollup view feeds Notion.

### audit_log
`id · actor · action · entity_type · entity_id · before jsonb · after jsonb · ip · created_at`

Written by trigger on every mutation to `organizations`, `consumer_leads`, `contacts`,
`review_queue`, and by application code on every Claude tool execution.

---

## 4. Claude memory layer

### conversations
`id · user_id · title · created_at · last_active_at`

### messages
`id · conversation_id FK · role (user|assistant|tool) · content · tool_calls jsonb ·
tool_results jsonb · input_tokens · output_tokens · created_at`

### memory_chunks — semantic memory
`id · conversation_id FK · summary not null · embedding vector(1024) · turn_range int4range ·
created_at`
Index: `ivfflat (embedding vector_cosine_ops)`.

### memory_facts — structured memory
`id · scope (global|user|org) · scope_id · key · value · confidence · source_message_id ·
superseded_by · embedding vector(1024) · created_at`

Append-only. Updating inserts a new row and sets `superseded_by` on the old one. Current
facts = `where superseded_by is null`.

### tasks
`id · title · description · assignee · due_date · status (open|in_progress|done|cancelled) ·
priority · source (claude|notion|manual) · notion_page_id · created_by · created_at · updated_at`

---

## 5. Social

### social_accounts
`id · platform (instagram|facebook|linkedin) · handle · external_id · token_ref (vault
reference, NEVER the token) · token_expires_at · status · created_at`

### social_metrics
`id · account_id FK · metric_date · followers · reach · impressions · engagement ·
profile_views · raw jsonb · pulled_at`
Unique on `(account_id, metric_date)` — idempotent daily pull.

### social_posts
`id · account_id FK · external_post_id · posted_at · permalink · caption · likes · comments ·
shares · saves · reach · raw jsonb · pulled_at`
Unique on `(account_id, external_post_id)`.

---

## 6. Notion sync

### notion_sync_map
`id · entity_type · entity_id · notion_database_id · notion_page_id · last_pushed_at ·
last_pulled_at · content_hash`

Prevents duplicate Notion pages and lets the writeback know which fields changed. Only the
editable fields listed in `CLIENT-CONTEXT.md` §8 are ever accepted from a Notion pull.

---

## 7. RLS policy pattern

Every table follows this shape. No exceptions.

```sql
alter table public.organizations enable row level security;
alter table public.organizations force row level security;

-- deny by default: no permissive policy for anon or authenticated
-- service_role bypasses RLS and is used only by n8n / Edge Functions

create policy "staff_read_orgs" on public.organizations
  for select to authenticated
  using (
    exists (
      select 1 from public.app_users u
      where u.user_id = auth.uid() and u.is_active
    )
  );

-- no insert/update/delete policy for authenticated:
-- all writes go through Edge Functions running as service_role,
-- which validate input and write the audit log.
```

`app_users` holds the staff allowlist (`user_id`, `email`, `role`, `is_active`).

**Verification requirement:** `tests/security/rls.test.ts` asserts an anon client and a
non-allowlisted authenticated client receive zero rows from every table. Runs in the
regression suite; a phase-1 acceptance criterion.

---

## 8. Migration discipline

- One logical change per timestamped migration file.
- Every migration reversible, or documents why not.
- `supabase db reset` must produce a working schema from zero, every time.
- Seed (`supabase/seed.sql`): Rubric A v1, Rubric B v1, app_users, disposable-domain list,
  discovery blocklist, one test org per lead type.
- **No manual changes in the Supabase dashboard, and none through the Supabase MCP.** If it
  isn't in a migration, it doesn't exist.
