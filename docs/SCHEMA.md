# SCHEMA.md — Data Model

Supabase Postgres + pgvector. Every table has RLS enabled and deny-by-default policies.
Migrations in `supabase/migrations/`, replayable from an empty database.
*(24 Aug, part 2: the live project runs **Postgres 17.6**, not the 15 this file assumed —
confirmed from project settings. Nothing in this schema is 15-specific; the migration set
was validated against 17.6. CLAUDE.md §2 still says 15 — corrected in the same change.)*

**Platform: Supabase, confirmed by the client 22 Aug 2026 (D24). The MongoDB question is
closed.** The earlier platform note ("if Ross confirms MongoDB, this file is rewritten") is
superseded; nothing in this file is conditional on the platform any more. See `CLAUDE.md` §3.

**Scope v3 (22 Aug 2026, `docs/MEMORY.md` D23–D32) is binding.** The live model is: the
consumer-lead record with its consent columns (§2), integration and observability (§3), the
Claude memory layer with `user_id` and `scope` on every memory table (§4), Notion sync (§6), the
RLS pattern (§7) and migration discipline (§8). The B2B lead-research tables — `organizations`,
`org_sources`, `rankings`, `rubric_versions`, `email_verifications`, `merge_log` — and the
social-insights tables are **parked under the "OUT OF CURRENT SCOPE" heading below §6**, not
deleted: the provenance design they carry remains correct and Stage 4's website knowledge store
(§2a) is built on the same pattern. **Part 2 of Stage 2 writes the first migrations from this
file.** Nothing under a parked heading ships in a migration. *(12 Sep 2026: delivery is now
eight milestones, D77 — "Stage 4" in this file means Milestone 5, "Stage 5" means Milestones
7–8, and Stages 1–3 are Milestones 1–3.)*

Conventions:
- `id uuid primary key default gen_random_uuid()`
- `created_at timestamptz not null default now()`, `updated_at` via trigger
- Soft delete via `deleted_at` — **never** hard-delete a record with provenance
- Enums as Postgres `check` constraints, not app-level strings
- Every foreign key indexed

---

## 1. Shared enums

```sql
-- lead_type: the eight categories Ross confirmed (CLIENT-CONTEXT.md §2). Kept as a
-- taxonomy; under Scope v3 NO type is researched, so there is no researched / tracking split.
--   'commercial' | 'asset_finance' | 'referral_partner'
--   | 'first_home_owner' | 'refinance' | 'investor' | 'referral' | 'building'

-- pipeline_stage: the ten live Finance Pipeline stages, built in GoHighLevel in Stage 1
-- (D28). Stored as snake_case of the GHL stage name; matched to GHL on STAGE ID, never name.
--   'new_lead' | 'appointment_booked' | 'contacted' | 'qualified' | 'docs_requested'
--   | 'docs_received' | 'submitted_to_lender' | 'approved' | 'settled'
--   | 'lost_not_proceeding'

-- lead_source:
--   'social_media' | 'ads' | 'referrals' | 'networking'
--   | 'previous_client' | 'outbound_research' | 'other'
--   ('outbound_research' is retained in the constraint so historical intent is readable,
--    but nothing sets it — it belonged to the parked research engine, D23.)
```

The `pipeline_stage` check constraint is the **ten values above and nothing else**. The
mapping from each value to its GHL stage ID lives in `ghl_field_map` (§3), so a renamed
stage in GHL is a data change, not a migration.

**Superseded — never built (R15, D28).** The nine stages this file carried from 08 to 22 Aug
(`'lead_in' | 'full_details' | 'booked_calendar' | 'docs_sent' | 'ongoing_loan_app' |
'no_show' | 'retarget' | 'disqualify' | 'settled'`) were a plan recorded as fact. They exist
nowhere in GHL and must not appear in any constraint, seed or fixture. Kept here for the
record only.

**Parked (D23).** The helper `is_researched_type(lead_type)`, which returned true only for
the three business types and guarded the crawler, belonged to the research engine. It is not
created. Under Scope v3 there is no crawler for it to guard.

---

## 2. Core entities

*Live under Scope v3. The research-engine tables that used to open this section
(`organizations`, `org_sources`, `email_verifications`, `rankings`, `rubric_versions`,
`merge_log`) are parked verbatim under the "OUT OF CURRENT SCOPE" heading after §6.*

### consumer_leads — individual lead records
Originally "lead types 4–8, deliberately separate from `organizations`". With the research
engine parked (D23) there is no `organizations` table to be separate from, but the table
stays: it is the consent and opt-out record for the people who receive marketing, and the
local mirror of a GoHighLevel contact in the Finance Pipeline. **Keep it. R17 is unresolved —
the client's CRM holds ~180 contacts with no consent record and nobody marked opted out — and
this design is the mitigation, not the problem.**

`id · full_name not null · email · phone · lead_type not null (check: any of the eight
types in §1) · pipeline_stage not null (check: the ten Finance Pipeline values) ·
lead_source not null · ghl_contact_id · ghl_opportunity_id · owner · notes ·
enquiry_detail jsonb · consent_basis text · opt_out boolean not null default false ·
created_at · updated_at · deleted_at`

*(24 Aug review: `full_name`, `lead_type`, `pipeline_stage` and `lead_source` are `not
null` — a lead with no name and no stage is not a lead, and every writer knows all four.
`pipeline_stage` deliberately has no default: a default would let a sync bug silently file
everything as new.)*

`ghl_contact_id` is the idempotency key for anything that writes to GHL (CLAUDE.md rule 9);
unique where not null. `ghl_opportunity_id` is new since Stage 1 built a real pipeline — an
opportunity is the object that carries the stage, so it needs its own ID.

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

### contacts — *parked 24 Aug (Part 2 decision, see MEMORY.md D36)*
Decided in Stage 2 part 2: **`contacts` does not ship.** It was the business decision-maker
table for the research engine — `org_id` FK to a parked table, `seniority`, `email_status`,
`email_is_inferred`, `extraction_method`, `confidence` all populated by decision-maker
extraction and email verification, both parked — and nothing in stages 2–6 reads or writes
it. `consumer_leads` covers the people who actually arrive from the ads. The table definition
is moved **verbatim** to the OUT OF CURRENT SCOPE section below §6; it is removed from the
audit-trigger list (§3) and from the migration set (§8). If lead research is ever bought as
new work, it comes back unchanged (with `org_id` restored alongside `organizations`).

### field_overrides — human corrections without destroying provenance
`id · entity_type · entity_id · field_name · original_value · override_value · reason ·
overridden_by · created_at`

When Ross corrects a system-derived field, the original is preserved and the override sits
beside it. Reads use the override; audits can see both.

### review_queue
`id · entity_type not null · entity_id · reason not null · payload jsonb ·
status (pending|approved|rejected) · notion_page_id · reviewed_by · reviewed_at · created_at`

*(24 Aug review: `reason` is `not null` — rule-14 routing always has a cause, and an item
the reviewer cannot see the reason for is unreviewable. A check constraint
(`review_queue_target_check`) requires `entity_id` or `payload`: an item must point at a
stored row or carry the thing under review inline.)*

`entity_type` was `(org|contact)`. **Settled in Part 2 (24 Aug, D37): the check constraint
is `('consumer_lead','web_fact','content_draft')`.** All three producers are already named
in binding docs — a lead record the sync could not place or that fell below threshold
(RUNBOOK §3), a stored website fact below confidence (Stage 4, §2a), and a generated draft
that failed the voice or review check (Stage 5, §5 — `content_draft` is referenced by name
there). The constraint's job is to reject typos and parked-era values (`org`, `contact`),
not to track which stage is live — a value nothing writes yet is harmless, whereas widening
a check constraint once the queue holds live rows is a migration. The rule it enforces is
unchanged: CLAUDE.md rule 14 — below threshold goes here, never straight to the CRM, the
knowledge store or published copy.

---

## 2a. Website knowledge store — Milestone 5, was "Stage 4" (design placeholder)

Milestone 5 (D77; Stage 4 under the six-stage map) "reads websites and stores what it finds,
with a full source trail on every field" (Scope v3). The tables are specified at that
milestone's kickoff, not here, but two things are fixed now so
that Part 2 does not lay a foundation that fights them:

1. **Every stored field carries `source_url`, `fetched_at`, `extraction_method`, `confidence`**
   (CLAUDE.md rule 12), enforced by `NOT NULL`. The parked `org_sources` + `contacts`
   provenance pattern below is the template — one row per page fetched, one row per fact,
   the fact pointing at the page. That pattern is why the parked tables are kept verbatim.
2. **The page store is separate from the memory layer (§4).** What the assistant *remembers
   about the user* and what it *knows from a website* are different data with different
   trust levels; scraped text is untrusted input (SECURITY.md §3) and must never be able to
   masquerade as a user preference.

Working names, to be confirmed at Stage 4: `web_sources` (page-level provenance) and
`web_facts` (field-level facts, append-only with supersede, as `memory_facts` in §4).

*12 Oct 2026: Milestone 5 part 2 read websites without building these.* It reads one page
from a pasted link into the conversation's own files (§4, "Pages read from a link"), keeps
the text for a day and extracts no fields. Both points above hold as built: every stored
part carries its source, time, method and confidence, and a page's text sits with attached
files, not in the memory layer. This section stays as the design for a store of extracted
facts, should one be asked for.

---

## 3. Integration and observability

### crm_sync_log
`id · entity_type · entity_id · provider ('ghl'|'meta') · external_id ·
operation (create|update) · status (success|failed|skipped) · attempt int ·
request_payload jsonb · response_payload jsonb · error · synced_at`

`external_id` enforces idempotency. Checked before any push. `provider` was `('ghl'|'sheets')`
— Google Sheets was the research-export target and is parked with the engine (D23); `meta`
is added because the Refi Pixel Conversions API (D31) is a server-side write to an external
system and falls under the same idempotency rule (CLAUDE.md rule 9 — the `event_id` dedupe
key Meta expects is the `external_id` here).

### ghl_field_map — configuration, not code
`id · internal_field · ghl_custom_field_id · ghl_field_key · entity (contact|opportunity|stage) ·
created_at`

GoHighLevel custom field IDs are account-specific. Keeping the mapping in a table means
pointing at a different sub-account is a data change, not a redeploy. Since Stage 1 the map
has two real jobs: the **ten custom fields** Stage 1 created in their own folder (Loan Type,
Loan Amount, Property Value, Deposit Amount, Employment Type, Annual Income, Credit Concerns,
Lead Source, Preferred Contact Time, Current Interest Rate) and the **ten Finance Pipeline
stage IDs** (`entity = 'stage'`, `internal_field` = the `pipeline_stage` value). GHL objects
are matched on ID, never on name — this account has produced three name traps already
(`MEMORY.md` 12 Aug). The 21 pre-existing custom fields stay unmapped and untouched (R2).

### GoHighLevel mirror — Milestone 4 part 1 (12 Sep 2026)

The local copy of the Finance Pipeline that the screen (parts 2–4) reads. **GoHighLevel is
the source of truth**: every row is keyed on the GHL object's own id (`ghl_id`), carries a
`content_hash` of what was mirrored, and is overwritten from GHL whenever the two disagree.
Scoped to ONE pipeline — `GHL_PIPELINE_ID`, verified against the pipelines list before every
sync (an unknown id fails loudly; GHL answers 200 and an empty list for one) — and the
contacts that have an opportunity in it, never account-wide (R22, R25). Names are stored
for display only; matching is on id.

Ownership: no `user_id` — the rows have no author — and `scope` pinned to `'workspace'` by a
check (`*_scope_workspace`, like `memory_chunks`), so the RLS policy has the memory tables'
shape and a private variant would be additive. `ghl_sync_runs.triggered_by` names the person
who asked for a refresh (nullable).

Deletion in GHL is a **mark**, `removed_at`, never a delete — set only from a COMPLETE read.
No FK opportunity → stage (a stage deleted in GHL must still be representable) or
opportunity → contact (an opportunity syncs even when its contact could not be read).

| Table | Key | Holds |
|---|---|---|
| `ghl_pipelines` | `ghl_id` | `name · location_id · ghl_updated_at · scope · first_synced_at · last_changed_at` |
| `ghl_stages` | `ghl_id` | `pipeline_ghl_id · name (display only) · position · win_probability · first_seen_at · last_changed_at · removed_at` |
| `ghl_opportunities` | `ghl_id` | `pipeline_ghl_id · stage_ghl_id · contact_ghl_id · name · status (open|won|lost|abandoned) · monetary_value numeric(14,2) (NULL = GHL had none, 0 = GHL said zero — different things) · source · assigned_to · ghl_created_at · ghl_updated_at · last_stage_change_at · last_status_change_at (all UTC, exactly as GHL sent them; nothing here converts to Perth time) · content_hash · first_synced_at · last_changed_at · removed_at` |
| `ghl_contacts` | `ghl_id` | `first_name · last_name · full_name · email · phone · source · dnd (null = not carried, never defaulted) · tags text[] · custom_fields jsonb {"<field id>": value as GHL returned it} · ghl_created_at · ghl_updated_at · content_hash · first_synced_at · last_changed_at · removed_at (set when no live opportunity references the contact)` |
| `ghl_custom_fields` | `ghl_id` | `name · field_key · data_type · model · parent_id (folder) · position · picklist_options · first_seen_at · last_changed_at · removed_at` — the definitions a synced contact carries or that sit in `GHL_CUSTOM_FIELD_FOLDER_IDS`; a rename changes `name`, a removal sets `removed_at`, and neither touches a stored value |
| `ghl_sync_runs` | `id` | `pipeline_ghl_id · trigger (cli|api|schedule|test) · triggered_by · status (running|success|partial|failed) · started_at · applied_at · finished_at · duration_ms · requests · pages_fetched · opportunities_fetched/rejected · contacts_fetched/failed/rejected/missing · custom_fields_fetched · stages_seen/added/updated/removed · opportunities_inserted/updated/unchanged/removed · contacts_inserted/updated/unchanged/removed · custom_fields_seen/removed · error_code · error · errors jsonb (ids only)` |

Three `service_role`-only functions (migration `20260912010000_ghl_sync.sql`):
`begin_ghl_sync_run` retires a run left `running` past the stale threshold (marked
`failed/STALE`) and claims the one running slot per pipeline (partial unique index
`ghl_sync_runs_one_running`) — a second caller gets SQLSTATE `55006`, never a race;
`apply_ghl_snapshot` writes the whole snapshot in ONE transaction, skipping rows whose
`content_hash` is unchanged so two syncs of an unchanged pipeline leave every row
byte-identical, computing removals only when the snapshot says the read was complete, and
recording the apply counts on the run; `finish_ghl_sync_run` closes the run with its status,
fetch counts and error list. Code: `src/lib/crm/ghl/` (config · types · map · client · sync ·
store); trigger: `npm run crm -- sync`; read-only check: `npm run crm -- read`.

`ghl_field_map` (`entity = 'contact'`) carries the eleven internal-name → field-id rows the
screen labels by — nine in the Stage 1 folder plus `loan_balance` and `current_interest_rate`
from the folder the live form writes to — seeded from the 12 Sep 2026 read and pinned in
`tests/integration/schema.test.ts`. `consumer_leads` is NOT written by the sync: its
`lead_type` / `lead_source` / `pipeline_stage` enums would force invented values and cannot
hold a stage GHL added (M4 part 1 decision).

### The sync schedule — ghl_sync_dispatches (14 Oct 2026, D111–D116)

The mirror refreshes itself every ten minutes, at minutes 3, 13, … 53 UTC (migration
`20261014010000_ghl_sync_schedule.sql`). `pg_cron` job **`ghl-sync`** runs
`public.dispatch_ghl_sync()`, which asks the `crm` Edge Function for a run through `pg_net`
(action `scheduled-sync`); the run itself is the part-1 sync with `trigger = 'schedule'` and
no `triggered_by`. No second lock: overlap is still `ghl_sync_runs_one_running` and
`begin_ghl_sync_run`.

The address and the scheduler's secret are in **Vault** (`ghl_sync_schedule_url`,
`ghl_sync_schedule_secret`), read at call time; the job's stored command is the bare call.
With either entry missing — or an address that is not `https://`, or a secret under 32
characters — the job asks for nothing and records `not_configured` once.

| Table | Key | Holds |
|---|---|---|
| `ghl_sync_dispatches` | `id` (identity) | `requested_at · outcome (requested\|started\|already_running\|failed\|not_configured) · request_id (pg_net) · pipeline_ghl_id (the newest run's, at request time) · http_status · error_code · run_id → ghl_sync_runs (on delete set null) · settled_at`. Kept 30 days. RLS forced; staff SELECT; no write policy |

`dispatch_ghl_sync()` first settles every request older than three minutes with
`settle_ghl_sync_dispatch(id, http_status)`: a run with `trigger = 'schedule'` that started
within five minutes of the request means it worked; HTTP 409 means a refresh already held the
slot (not a failure); anything else writes a **`failed` row into `ghl_sync_runs`** —
`started_at` = when it was asked, no `applied_at`, `error_code` naming the cause
(`SCHEDULE_REJECTED` 401/403 · `SCHEDULE_CONTRACT` 400 · `SCHEDULE_FUNCTION_MISSING` 404 ·
`SCHEDULE_FUNCTION_ERROR` 5xx · `SCHEDULE_NO_RUN` 2xx with no run · `SCHEDULE_UNREACHABLE` no
answer), `errors = [{kind: 'schedule', id: <dispatch id>, code}]` — so the screens' alert and
the connector's freshness sentence fire through what already reads that table. Neither
function writes a `running` row. Both are owner-only (revoked from `anon`, `authenticated` and
`service_role`). It also deletes this job's `cron.job_run_details` rows older than seven days.

Index `ghl_sync_runs_applied_idx (applied_at desc) where applied_at is not null`: the newest
applied run, which the connector and (since this change) both mirror screens look up on its
own. The run log grows by about 144 rows a day.

### GoHighLevel writes — Milestone 4 part 4 (24 Sep 2026)

The first writes from the running system to GoHighLevel: a stage move and a contact note,
through the `crm` Edge Function (`move` / `note`). **GoHighLevel first, mirror second**: the
server reads the opportunity live, writes GoHighLevel, and then one function updates the
mirror row from GoHighLevel's own reply, closes the write record and inserts the audit row in
one transaction — the mirror never holds a stage the CRM does not have.

| Table | Key | Holds |
|---|---|---|
| `ghl_writes` | `id` | one row per ATTEMPTED write, claimed before GoHighLevel is called: `request_id` (uuid, unique — the browser mints one per gesture; the idempotency key) · `actor` (auth user) · `kind (stage_move|note)` · `pipeline_ghl_id · opportunity_ghl_id · contact_ghl_id` · `from_stage_ghl_id` (the stage GoHighLevel held LIVE when the write began) · `to_stage_ghl_id` · `screen_stage_ghl_id` (what the screen showed; differs when someone else moved the lead first) · `status (in_flight|success|noop|failed|unknown|mirror_failed)` · `ghl_status · error_code · duration_ms · started_at · finished_at` · `scope` pinned to `'workspace'` |
| `ghl_notes` | `ghl_id` (the GoHighLevel note id) | `contact_ghl_id · opportunity_ghl_id · author_user_id · body` (as typed, without the `[Fundd app · email]` prefix GoHighLevel shows) · `ghl_date_added · write_id · created_at · scope`. Only notes this app wrote through: nothing reads notes back from GoHighLevel yet |

Three `service_role`-only functions (migration `20260924010000_ghl_writes.sql`):
`begin_ghl_write` claims the request id (`on conflict do nothing`) or hands back the row that
already claimed it with its status, so a replay is answered from the record and never sent
twice; `finish_ghl_write` closes the write row, upserts the mirror opportunity from
GoHighLevel's reply (same columns and hash rule as the sync; only within the write's pipeline),
inserts the note row, and — for `success` and `mirror_failed` only, because those are the
outcomes in which GoHighLevel changed — the `audit_log` row (`LEAD_STAGE_MOVED` /
`LEAD_NOTE_ADDED`; `entity_type = 'ghl_writes'`, `entity_id` = the write row because
`audit_log.entity_id` is a uuid and GoHighLevel ids are not; the opportunity id and both stage
ids in `before`/`after`); a second finish for the same write raises `55006`.
`mark_ghl_opportunity_removed` sets `removed_at` when a live read answered 404 — a definite
signal, applied now rather than at the next full sync. RLS enabled and forced on both tables,
staff-allowlist SELECT only, explicit grants (`tests/security/rls.test.ts` and
`tests/security/ghl.test.ts`). Code: `src/lib/crm/ghl/` (write · moves · writeStore).

### workflow_runs
`id · workflow_name · n8n_execution_id · status (running|success|failed|partial) ·
started_at · finished_at · input jsonb · output jsonb · error · items_in · items_out ·
items_failed`

### api_usage
`id · provider (anthropic|voyage|ghl|meta) · operation · model · input_tokens · output_tokens ·
cache_read_tokens · cache_write_tokens · units · cost_usd numeric(10,6) · workflow_run_id ·
user_id · conversation_id · created_at`

Powers the $50/month cap (SECURITY.md §8) and the per-conversation cost view on the Stage 3
dashboard. `serper`, `millionverifier` and `linkedin` were in the provider list for the
research engine and social insights — parked (D23, R3); `org_id` is replaced by
`user_id · conversation_id` because cost now attaches to a conversation, not an organisation.
`cache_read_tokens` / `cache_write_tokens` are added because prompt caching on the voice and
brand prefix (Stage 2 part 5) is the main cost lever, and a cap that cannot see cache hits
cannot be tuned. **Ships in Stage 2** — the first Claude call in part 4 must land a row here.
*(Part 4, 25 Aug: it does. `operation` is `chat.turn` for a confirmed call and
`chat.turn:unconfirmed` for a call that may have been billed but whose usage could not be
read — timeout after send, transport failure, unparseable 200 — recorded as the worst-case
reservation so the cap counts it. `units` stays null for Anthropic rows. The cap reads
`sum(cost_usd)` over `created_at >= <UTC day / month start>` by paginating `select`, not a
single page — PostgREST's `max_rows` would otherwise blind the cap past 1,000 rows.)*

### audit_log
`id · actor · action · entity_type · entity_id · before jsonb · after jsonb · ip · created_at`

Written by trigger on every mutation to `consumer_leads`, `review_queue`, `memory_facts`
and `app_users`, and by application code on every Claude tool execution. (Was also
`organizations` and `contacts` — both parked, D23/D36.)

---

## 4. Claude memory layer

*Scope v3 deliverable 1: "trained on the client's voice, with persistent memory that follows
him across devices." Conversations and messages ship in Stage 2 (the chat the client talks
to); semantic recall and durable facts ship in Stage 3. **All four tables are created in
the first migration set with `user_id` and `scope` (D24)**, even the two Stage 3 does not
populate yet — one user today, but adding an ownership column to a table with rows in it is
a migration against live data that has to guess who owns what.*

### Why `user_id`, and what `scope` holds

**`user_id uuid not null references auth.users(id)`** on every memory table. "Follows him
across devices" means memory is keyed on *who is logged in*, not on the device — the
prototype's failure (`EXISTING-PROTOTYPE.md`: localStorage "memory", invisible from a second
browser) is exactly what this column prevents. On a `workspace`-scoped row `user_id` is the
author: who the fact was learned from, who started the conversation. It is never null.

**`scope text not null default 'workspace' check (scope in ('user','workspace'))`.** Two
values, chosen over the earlier `(global|user|org) + scope_id`. **The default is `workspace`**
(changed 23 Aug from `user`, D33): the client was told in writing that memory is shared — one
brain for the business, whatever anyone teaches it is there for everyone — so a row that does
not say otherwise belongs to the business. `user` is the opt-in exception for something a
person explicitly marks as private (a draft conversation, a personal preference), not the
resting state.

| Value | Meaning | Readable by | Example |
|---|---|---|---|
| `workspace` (**default**) | Belongs to the business — "one brain" | Every active `app_users` row | "We are rebranding to Fundd", the brand voice facts, a preference Ross teaches it, any conversation not marked private |
| `user` (opt-in) | Explicitly private to one person | That `user_id` only | A draft conversation Ross marks private; a personal note he does not want the team to see |

Why these two and not more: (1) **the thing the client was promised** is one shared memory
for the business that survives a device change and a change of who is typing — that is
`workspace`, and that is why it is the default. (2) **`user` exists so that "shared by
default" does not mean "nothing can ever be private"** — a column that can only say
`workspace` cannot express a private draft, and adding the distinction later, once rows exist,
would mean guessing which old rows were meant to be private. It costs one value in a check
constraint now and nothing else. (3) `org` is gone with the research engine; knowledge
*from websites* is the Stage 4 store (§2a), not memory, and keeping it out of this table is a
trust boundary (SECURITY.md §3), not tidiness. (4) `scope_id` is dropped: for `user` it
would duplicate `user_id`, for `workspace` there is exactly one workspace and no table for it.
If a second workspace is ever needed, `workspace_id` is **added** (a nullable column,
backfilled with the one value — trivial), whereas `user_id` **cannot** be backfilled after
the fact because nobody recorded who said what. That asymmetry is the whole reason these two
columns are in the first migration and `workspace_id` is not. (5) No `conversation` scope
for facts — a fact that should not outlive its conversation is not a fact, it is a message,
and `messages` already holds it.

**RLS consequence** (§7): `select` on memory tables is
`scope = 'workspace' or user_id = auth.uid()`, and-ed with the `app_users` allowlist check —
the common case (shared) is the first clause; the private case is the exception. Writes go
through the service role as everywhere else. `tests/security/rls.test.ts` asserts that every
allowlisted user reads every `workspace` row regardless of author, and that user A cannot read
user B's `user`-scoped rows.

### conversations
`id · user_id not null · scope not null default 'workspace' · title · created_at ·
last_active_at · deleted_at`

**How a conversation is named (part 4a, D61).** Two halves, and neither writes a prefix:

- `title` is **auto-set on create** from the first user message (`titleFromFirstMessage`,
  `src/lib/memory/naming.ts`, called by `chat.ts`). It was null on every conversation that
  had ever existed, which made renaming a chore rather than a correction. Nothing re-titles
  later, so a person's rename is never overwritten.
- The **displayed** name is `<author's email local part> — <title>`, derived at read time
  from `app_users.email` and **never stored**. Conversations are workspace-scoped (D33), so
  since part 4 put staff on the system everyone sees everyone's; the prefix is what makes
  that list attributable. Deriving rather than storing means an email change is followed on
  the next read and no backfill is owed for existing rows.
- `rename_conversation` therefore edits only the part after the prefix. The interface keeps
  the prefix outside the input, and the server applies `stripConversationPrefix` against the
  **author's** email as well, so a title can never come to contain its own prefix.

Renaming is open to every active allowlisted member because naming is a correction, not a
removal — D52's open half.

**Who can see a conversation (part 5, R27, D62, migration `20260829010000`).** `scope` has
accepted `'user'` since the first migration; nothing could set it until now. The client was
given three options and chose the second: *each person's chats are their own, the owner can
see everybody's, and what the assistant LEARNS still goes into the one shared brain.* What
that means, table by table:

| Table | When a conversation is `'user'` | Mechanism |
|---|---|---|
| `conversations` | readable by its author only | the existing RLS policy, unchanged |
| `messages` | readable by its author only, **including everything already said in it** | `sync_child_ownership` + the cascade, both unchanged |
| `memory_chunks` | **still `'workspace'`** — the note reaches the whole team | `sync_chunk_ownership` (new) forces it; `memory_chunks_scope_workspace` refuses anything else |
| `memory_facts` | **still `'workspace'`** — a standing note is the business's | the turn writes at `SHARED_MEMORY_SCOPE`, not the conversation's scope |

- **Workspace stays the resting state.** Private is the author's opt-in exception; nothing
  defaults to it and no existing conversation was migrated into it.
- **Only the AUTHOR may flip it** — `canSetConversationPrivacy`, deliberately *not*
  `canRemoveMemory`. This is the one place an administrator is not the wider power: an admin
  sharing someone's private conversation back to the team would publish that person's words
  in a single tap, asked for by nobody. An admin may still rename and delete one (D52).
- **An administrator reads a private conversation through an audited server path, never
  through a policy.** The policies on `conversations` and `messages` were NOT widened, and
  the migration adds none. Postgres has no SELECT trigger, so an RLS bypass would be
  invisible by construction; the server path writes `CONVERSATION_ADMIN_READ` to `audit_log`
  before it hands over a single message. The admin's *listing* (`admin_list_private`) carries
  author and dates and **no title** — a title is the first thing its author said (D61) — which
  is why the listing is not audited and the read is.
- **What a staff member is told, on screen, before the tap** (`PRIVACY_EXPLANATION`,
  `src/lib/memory/privacy.ts`, imported by both sides): *"Only you and an administrator can
  open this conversation or read what is said in it. What the assistant learns here is still
  shared: the short note it writes about this conversation, and anything you ask it to
  remember, go to the whole team as usual."* Each clause is a claim about one of the four
  rows above, and `tests/unit/memory/privacy.test.ts` checks each against the mechanism.

**Deleting a conversation** (D59, migration `20260828010000`, one transaction in
`delete_conversation(uuid, uuid)`) treats the four tables that hang off it differently,
because they are not the same kind of thing:

| Table | What happens | Why |
|---|---|---|
| `conversations` | **soft** — `deleted_at` set | Every read path already excludes it, and the row must survive so the surviving children and the audit row point at something real |
| `messages` | **hard** — permanently deleted | The words are the thing being deleted; a "delete" that left them selectable by anyone holding the id would be a lie. Safe here precisely because `messages` carries **no audit trigger** — the same reasoning that made a chunk delete content-destroying (D50) |
| `memory_chunks` | **tombstoned**, identically to a memory-page delete | `turn_range` kept so the range is never re-summarised; `summary` replaced with the marker, `audience` and `embedding` destroyed. One mechanism, one promise |
| `memory_facts` | **kept, live, unchanged** except `source_message_id → null` | A standing note is not a by-product of the conversation it was said in: someone deliberately told the business to remember it, it is workspace knowledge in its own right, and it is visible and removable on the Memory page. Deleting a conversation must not silently empty the brain. The FK cannot dangle once the message is gone, so the pointer — and only the pointer — is cleared |

Who may: **the author's or an admin's**, the same `canRemoveMemory` that gates removing a
note (D52). Idempotent, `service_role`-only, and the counts it returns are the counts the
page reports afterwards.

### messages
`id · conversation_id FK · user_id not null · scope not null · role (user|assistant|tool) ·
content · tool_calls jsonb · tool_results jsonb · model · input_tokens · output_tokens ·
created_at`

`user_id` and `scope` are denormalised from the conversation so the RLS policy is a column
check, not a join. A trigger keeps them equal to the parent's.

*(12 Oct 2026, Milestone 5 part 1: `document_context boolean not null default false` added —
true on both rows of a turn answered with an attached file in front of the model; see
"conversation_files" below.)*

### memory_chunks — semantic memory (written from Stage 3 part 1, FND-300)
`id · conversation_id FK · user_id not null · scope not null · summary not null ·
embedding vector(1024) · turn_range int4range not null · created_at`

A chunk is **a summary plus a pointer**, never a second copy of the messages. Written by
`src/lib/memory/` (26 Aug 2026, migration `20260826010000_memory_chunks_stage3.sql`):

- **`turn_range`** is a half-open `[lo, hi)` over **1-based message ordinals** of the
  conversation in `(created_at, id)` order — every row counts, tool rows included, so an
  ordinal never moves. `not null`, `lo >= 1`, non-empty (`memory_chunks_turn_range_valid`).
  Chunks tile a conversation from ordinal 1: the next chunk always starts at the highest
  `hi` written so far. One chunk = **10 messages** (five exchanges) by default
  (`MEMORY_CHUNK_MESSAGES`), or a shorter idle tail — the policy is `src/lib/memory/policy.ts`.
- **`memory_chunks_no_overlap`** — `exclude using gist (conversation_id with =, turn_range
  with &&)` (needs `btree_gist`). The idempotency key: two writers racing on the same range
  cannot both land, and a re-run of the same summarisation is refused by the database
  (`23P01`), which the store reports as `exists`.
- **Index: `hnsw (embedding vector_cosine_ops)`** — replaces the part-2 `ivfflat`. ivfflat
  computes its centroids from the rows present at `create index`; built on an empty table it
  is untrained and pgvector says to create it only once data exists and rebuild as it grows.
  HNSW needs no training, gives better recall for the same query time, and suits a table
  that grows one conversation at a time. Retrieval (part 2) queries with `<=>`.
- `user_id` is the parent conversation's author (trigger, as for `messages`), so attribution
  and `canRemoveMemory` work without a join and a reassigned conversation moves its notes
  with it. **`scope` is ALWAYS `'workspace'`** — since part 5 (R27, migration
  `20260829010000`) it is not copied from the parent at all: `sync_chunk_ownership` sets the
  constant and `memory_chunks_scope_workspace` refuses any other value, so a private
  conversation still feeds the shared brain. The cascade carries `user_id` to chunks and
  `user_id` + `scope` to messages.
  *(Superseded: until 28 Aug both children shared `sync_child_ownership` and a chunk of a
  private conversation was private — which is option THREE, and not what the client chose.)*

**What is embedded** is the note under a header — `Conversation: <title>`, `Date: <Perth
calendar date of the range's newest message>` and, when there is one, `Audience: <who the
work was for>` (`embeddingText`, `src/lib/memory/summarise.ts`) — so retrieval can match on
what a conversation was called, when, and who it was for, not only on the note's words.
`summary` stores the note alone; the header is reproducible from `conversations.title`,
`memory_chunks.audience` and the range's messages.

- **`audience text`** (review of part 2, 27 Aug, migration `20260827020000`): the
  summariser's trailing `Audience:` line — who the copy or advice in that range was aimed
  at, ≤ 120 chars (`memory_chunks_audience_length`), null when it named none. Stored so the
  header can be rebuilt and shown on the memory page; `match_memory_chunks` returns it and
  the recalled line reads `"<title>" (<date>, for <audience>, similarity …)`. Measured on
  the one live chunk: it does **not** rescue the audience-phrased miss that prompted it
  ("…for young Perth couples." 0.36 → 0.35 — the summariser called the audience "renters
  aspiring to homeownership") but lifts other audience phrasings a little ("post for first
  home buyers in Perth" 0.24 → 0.32). Recorded honestly in MEMORY.md 27 Aug.

- **`deleted_at timestamptz` / `deleted_by uuid`** (Stage 3 part 3, migration
  `20260827030000`): what Delete on the memory page leaves behind. The row is NOT removed —
  it keeps its `turn_range`, so `memory_chunks_no_overlap` still owns that range and the
  summariser can never quietly re-summarise the messages the user asked to be rid of and
  charge for it twice. Everything that made it memory is destroyed in the same update:
  `summary` becomes a fixed marker (`CHUNK_TOMBSTONE_SUMMARY`, the column is NOT NULL),
  `audience` and `embedding` become null. A null embedding is already invisible to
  `match_memory_chunks`; the migration adds `k.deleted_at is null` to the same function so
  the intent is stated rather than inherited. **`memory_chunks` deliberately has no audit
  trigger** — a before-image would preserve in `audit_log` exactly the sentence that was
  removed; the deletion is an application-written `audit_log` row carrying ids and the actor
  only. The removal is therefore NOT reversible, and the page says so on the confirm step.

Embeddings are Voyage `voyage-3`, 1024 dimensions, `input_type: document`.

- **A chunk may exist without one** (part 5b, D70, migration `20260830010000`). When the
  embedding call fails the summary is **kept** and the range is marked covered, because the
  Haiku summary costs ~1,600× the Voyage embedding and discarding it means paying for the same
  text again on the next sweep. `null` therefore means one of two things, told apart by
  `deleted_at`: **`deleted_at is null`** — waiting for `backfillChunkEmbeddings`; **`deleted_at`
  set** — a tombstone whose content was destroyed on purpose (D50) and which must never be
  re-embedded. `memory_chunks_needs_embedding_idx` is the partial index over the first case,
  and `match_memory_chunks` ignores both.
- The backfill rebuilds the header exactly — title, the Perth date of the range's newest
  message, the stored audience — by re-reading the range, so a note embedded late still matches
  what it would have matched on the day. Cost per chunk is in
`SECURITY.md` §8.

### memory_facts — structured memory (written from Stage 3 part 2, FND-310)
`id · user_id not null · scope not null · key not null · value not null · confidence ·
source_message_id · superseded_by · embedding vector(1024) · created_at`

Append-only. Updating inserts a new row and sets `superseded_by` on the old one. Current
facts = `where superseded_by is null`. **Identity is per scope** (migration
`20260827040000`, D54): a **workspace** note is unique on `key` alone — the business has one
answer, whoever wrote it — and a **user** note is unique on `(user_id, key)`. *(Superseded:
the single index `(user_id, scope, key) where superseded_by is null`, which let two people
each hold a live `writing:tone`, both handed to the model on every turn.)* Written by
`src/lib/memory/facts.ts` (27 Aug 2026, migration `20260827010000_memory_facts_stage3.sql`):

- **`key` is `<category>:<slug>`** — `memory_facts_key_format`: category one of `writing`,
  `audience`, `business`, `offer`, `process`, `personal`; slug lowercase kebab-case; ≤ 72
  chars. A controlled category with a free slug (D44): a wholly free key lets "tone" and
  "writing style" become two facts that contradict each other; a closed vocabulary refuses
  the useful thing the user actually says. The extractor is shown the live keys and told to
  reuse one when a new statement is about the same subject.
- **`value not null`** (a fact with no value is not a fact); `confidence` in `[0, 1]`
  (`memory_facts_confidence_range`); explicit "remember that…" facts are stored at `1`.
- **`upsert_memory_fact(user, scope, key, value, confidence, source_message_id)`** is the
  ONLY write path — `service_role` executes it, `anon`/`authenticated` cannot. One
  transaction under a per-note advisory lock: identical value → `unchanged`; new key →
  `inserted`; different value for a live note → the old row is pointed at the new one and the
  result is `superseded`. The partial unique index would refuse two live rows, so the
  function steps the old row out of "live" first (a self-reference), inserts, then repoints.
  The lock and the lookup use the **same shape as the index** — `(scope, key)` for a
  workspace note, `(user_id, key)` for a private one — so two different people writing one
  workspace note contend rather than pass each other. **Racing:** the second caller waits,
  re-reads under READ COMMITTED, and supersedes the first one's row; the loser keeps its
  value, author and date and appears in the note's history as *replaced*. One live row,
  always, and never an error. `p_user_id` is therefore the **author of the new row**, not
  part of a workspace note's identity.
- **`source_message_id`** is the user message that carried the request, attached once the
  turn is saved (the fact is captured before the reply so the reply can say it was saved).
  Null for a fact stored by hand (`npm run memory -- remember`).
- **`scope`** is `'workspace'` for anything the assistant is told to remember, whatever the
  conversation's own scope (part 5, R27). The column still accepts `'user'` and the CLI can
  still write one by hand; nothing on the chat or memory-page path does. *(Superseded: D41
  said a fact stated in a private conversation is private — true while nothing could make a
  conversation private, and the opposite of what the client chose once something could.)*
- `embedding` stays null in part 2: facts are few and always included in a turn (§4 of
  `docs/MEMORY.md` D46), so nothing ranks them by similarity yet. The column is there for
  the day the fact count outgrows the per-turn budget.
- **Read path for retrieval:** `match_memory_chunks(query, user, conversation,
  history_messages, limit, min_similarity)` — cosine top-k over `memory_chunks` via the HNSW
  index, workspace rows plus the caller's own private ones, no deleted conversation, no
  deleted chunk, no chunk whose messages are already in the turn's verbatim history window,
  nothing under the floor. `service_role` only, like the write path.
- **`superseded_by` also carries "forgotten"** (Stage 3 part 3): a row whose `superseded_by`
  is **its own id** was removed by a person from the memory page and nothing replaced it. It
  is the one value that cannot mean "a newer row took over", `upsert_memory_fact` already
  used it transiently for exactly that reason, and it needs no column: the live predicate
  stays `superseded_by is null`, so retrieval and the extractor's key list both drop the note
  with no change to any read path, and the partial unique index frees the key so the same
  note can be stated again later. The row keeps its value, its author and its date, so the
  page can show what was removed and offer to add it back — which is why the button says
  **Forget** and not Delete. Three states, one column: `null` = live, own id = forgotten,
  another id = replaced.
- **Written from the page** (Stage 3 part 3, `src/lib/memory/page.ts`, Edge Function
  `memory`): adding a note runs the SAME extractor and guards as "remember that…" in the
  chat, so the page is not a way around D43's access and override checks; editing keeps the
  person's exact words under the existing key and goes through `upsert_memory_fact` with the
  **row's own `user_id`**, not the editor's — the function matches on `(user_id, scope, key)`
  and passing the editor would insert a second live workspace row for one key instead of
  superseding. Who made the change is the `audit_log` row. A note made on the page is always
  `workspace`.

*Superseded column shape, kept for the record:* `scope (global|user|org) · scope_id`. Replaced
23 Aug by the two-value `scope` + `user_id` above; see the reasoning at the top of §4. *The
first draft of 23 Aug had `default 'user'`; corrected the same day to `default 'workspace'`
because the client was told memory is shared.*

### conversation_files, conversation_file_pages — attached files (Milestone 5 part 1, 12 Oct 2026)

A file belongs to **one conversation** (D83). **The original file is never stored** — not in a
table, not in a bucket; there is no Storage bucket for this feature and so no object URL
(D84). The browser reads the file; what is kept is the **text** it read, page by page, plus
the file's name, size, kind and a SHA-256 of the original (so the same file sent twice is
recognised). Migration `20261012010000_conversation_files.sql`.

| Table | Key | Holds |
|---|---|---|
| `conversation_files` | `id` | `conversation_id` FK **on delete cascade** · `user_id` + `scope` (the CONVERSATION's author and scope, denormalised and kept equal to the parent by the same trigger `messages` uses) · `uploaded_by` · `request_id` (uuid, unique — one per upload gesture; the idempotency key) · `name` (a sanitised label, ≤ 120 chars) · `kind (pdf\|docx\|xlsx\|csv\|text\|image)` · `byte_size` (of the original, as the browser measured it) · `content_hash` · `expected_pages` · `vision_pages` · `page_count` · `char_count` · `confidence` (the lowest page confidence) · `status (reading\|ready\|removed)` · `created_at · ready_at · expires_at` (30 days after upload, D85) · `removed_at · removed_by · removed_reason (user\|expired)` |
| `conversation_file_pages` | `(file_id, page_no)` | `label` ("Page 7", `Sheet "Rates"`) · `content` (≤ 64,000 chars) · **provenance, all NOT NULL (rule 12):** `extraction_method (pdf_text_layer\|claude_vision\|docx_xml\|xlsx_xml\|csv_parse\|plain_text)` · `confidence` (1.00 for a parse; 0.90 / 0.60 / 0.00 for a page read by vision that was fully / partly / not legible) · `legibility (full\|partial\|none)` · `extracted_at` — the source is the upload itself (`file_id` → hash, uploader, time; there is no URL) · `letter_count` (letters and digits of any script, counted by the server; what "is there anything readable" is decided on) |

Also `messages.document_context boolean not null default false`: true on both rows of a turn
that was answered with a file in front of the model. The shared-memory summariser replaces
such a message with a placeholder, so a figure read off a payslip never reaches workspace
memory (D89).

**Status.** `reading` — pages still arriving; invisible to every session and to the model.
`ready` — every declared page is stored; what a turn loads. `removed` — a tombstone: the text
is deleted and `name` and `content_hash` are null, enforced by
`conversation_files_tombstone_check`, so the thread can say "a file was here" and nothing can
say which. One `ready` row per `(conversation_id, content_hash)` (partial unique index).

**Who reads what (D86).** `conversation_files`: one SELECT policy — `status <> 'reading' and
(scope = 'workspace' or user_id = auth.uid()) and is_active_staff()` — i.e. whoever can read
the conversation. `conversation_file_pages`: RLS enabled and forced with **no policy at all**;
no browser session reads the text, whoever it belongs to. Only the server does
(`service_role`), to put it in front of the model. Both proven in
`tests/security/files.test.ts`, each clause shown to matter by removing it inside a
rolled-back transaction.

**Triggers.** `conversation_files_sync_ownership` (child takes owner and scope from its
conversation); `conversations_cascade_files_ownership` (making a conversation private makes
its files private in the same statement); `conversations_purge_files` (a soft-deleted
conversation's files are deleted outright — rows, text, names).

**Five `service_role`-only functions.** `begin_conversation_file` claims an upload under a
lock on its conversation: idempotent on `request_id` (a retry resumes and is told which pages
are already stored), returns the `ready` row for the same content, deletes abandoned attempts,
raises `FL001` past ten live files and `02000` for a missing or deleted conversation.
`append_conversation_file_pages` upserts pages while `reading` (`FL002` not reading, `FL003`
page outside what was declared). `finish_conversation_file` makes the file `ready` only when
**every** declared page is stored, in one transaction with its `audit_log` row
(`FILE_ATTACHED`: ids and counts, never the name or a word of the text) — `FL004` pages
missing, `FL005` nothing readable, `FL006` too long. `remove_conversation_file` deletes an
unfinished upload outright or turns a ready file into a tombstone (`FILE_REMOVED` /
`FILE_EXPIRED`). `purge_conversation_files` deletes uploads unfinished after 15 minutes and
tombstones files past `expires_at`; **pg_cron runs it daily at 03:17 UTC** (job
`purge-conversation-files`, created by the migration; RUNBOOK §1e). A turn also ignores a file
past its date, so the promise holds in the hours before the job runs. Code:
`src/lib/files/` (store · page · context · vision), `web/src/lib/files/` (the readers).

### Pages read from a link — columns on conversation_files, and web_fetches (Milestone 5 part 2, 12 Oct 2026)

A page read from a link is **a `conversation_files` row like any other** (D93): same
ownership, same policy, same text table, same wrapper in front of the model. It is not a
second store. What a page has that a file does not is where it came from and when, and those
are the server's to say. Migration `20261012020000_web_pages.sql`.

**Added to `conversation_files`.**

| Column | Holds |
|---|---|
| `source_url text` | The address that was actually read — after redirects, `https`, no credentials, no fragment, ≤ 2,048 chars. Null for an uploaded file, **and null again once the row is removed** |
| `source_host text` | Its host. What the screen and the model are shown; never taken from the page |
| `fetched_at timestamptz` | When the server fetched it. What "is this still current" is answered from |
| `values_missing integer not null default 0` | Places the site leaves for a script to fill in, found empty in what was fetched — counted by the database at `finish` from the marks in the stored text. Above zero the page is shown, and described to the model, as *read in part* |
| `read_as_sent boolean not null default false` | The page showed nothing until its scripts ran and was read with its `opacity:0` declarations ignored (SECURITY §3). Set by the database at `finish` when the reader's own first line, `[read as the site sent it]`, is in the stored text. True: the page says so under its title for as long as it is there, and its opening tag in front of the model says so too — what was read may include text a visitor never sees |

`kind` gains `html`; `conversation_file_pages.extraction_method` gains `html_text`;
`removed_reason` gains `replaced`. Constraints: `conversation_files_source_check` (address,
host and time are all present or all absent, and the address is `https`);
`conversation_files_html_source_check` (an `html` row that is not removed names its source —
an uploaded `.html` file is still refused, D83, so `html` only arrives with a fetch behind
it); `conversation_files_tombstone_check` **extended so a removed row has no address
either**. Index `conversation_files_source_idx (conversation_id, source_url)` on ready rows.

**`expires_at` for a page is one day, not thirty (D95).** A document reached by a link — a
PDF, a spreadsheet — keeps the thirty days an attachment has. The number comes from the
endpoint (`FILES_PAGE_RETENTION_DAYS`); the same nightly job enforces both.

**`web_fetches` — the server's record of each read.** One row per `fetch_page` request.

| Column | Holds |
|---|---|
| `id uuid` PK | The browser's id for one request to open a page. **Never reused: one id opens one page, once** |
| `user_id` | Who asked. FK `auth.users`, on delete cascade |
| `requested_url`, `requested_host` | What was asked for |
| `final_url`, `final_host` | Where it ended after redirects. Null until the site answered |
| `status` | `started` · `fetched` (bytes were handed to the browser) · `refused` (the address or the page was refused) · `failed` (no usable answer; may be asked again under a new id) |
| `outcome` | A reason code from `src/lib/pages/limits.ts` (`^[a-z_]{1,48}$`). Never a sentence, never page content |
| `http_status`, `content_type`, `byte_size`, `content_hash`, `hops`, `duration_ms` | How the site answered. The hash is the SHA-256 of the bytes handed over |
| `created_at`, `fetched_at` | |

`web_fetches_fetched_check`: a row cannot be `fetched` without its final address, size, hash
and time. **No page text and no title are stored here.**

**Who reads what.** `conversation_files` — unchanged: part 2 touched no policy, and the new
columns are visible to exactly whoever can see the conversation. `web_fetches` — RLS enabled
and forced with **no policy at all**: no browser session reads a row, its owner included.
`authenticated` holds `SELECT` (the privilege says "you may ask"; with no policy row-level
security answers "there is nothing for you" — the `conversation_file_pages` pattern, and what
`tests/security/rls.test.ts` asserts of every table), `service_role` holds all, `anon`
nothing. Proven in `tests/security/web-pages.test.ts`, including that *any* policy — even
"a person may see their own" — makes the rows readable.

**Functions (`service_role` only).**

- `claim_web_fetch(p_id, p_user_id, p_url, p_host, p_per_minute, p_host_gap_ms)` → `(claimed,
  existing, wait_ms)`. Decides, under an advisory lock on the person and then on the host,
  whether a read may go ahead: `WF001` when the person has made `p_per_minute` reads in the
  last minute; `wait_ms` when the host was read less than `p_host_gap_ms` ago by anyone
  (nothing is claimed); **`existing` when the id is already on record — nothing is claimed,
  whoever the id belongs to.**
- `complete_web_fetch(…)` → boolean. Records how the read ended, scoped to the person who
  asked. Also called when the browser's reader refuses a page it was handed, so that fetch
  can no longer be attached.
- `begin_conversation_file(…, p_fetch_id uuid default null)` — **dropped and recreated with a
  thirteenth parameter.** With a fetch id the attachment is checked against the record —
  this person's, `fetched`, within 15 minutes, **the same size and SHA-256** — and takes its
  address, host and time from it; anything else, and any `html` row without one, raises
  `FL007`. The same bytes already attached is still "the same file", and for a page it means
  the site was asked again and nothing had changed: that row's `fetched_at` and `expires_at`
  move forward.
- `finish_conversation_file(…, p_gap_mark text default null, p_sent_mark text default
  null)` → gains `replaced`. Counts the gap marks into `values_missing`, sets `read_as_sent`
  when the sent mark is in the stored text, and **removes older ready copies of the same
  address in the same conversation** (`removed_reason = 'replaced'`, audit `FILE_REPLACED`), so two copies
  of one page never sit in front of the model saying different things.
- `remove_conversation_file` — same signature; nulls the source columns; `replaced` is a
  third reason. `purge_conversation_files` — also deletes `web_fetches` rows older than a day.

All three new parameters have defaults and are passed by name, so the `files` function deployed
before this migration keeps working between the migration and its own redeploy (RUNBOOK
§1f). Code: `src/lib/pages/` (limits · guard · robots · fetch), `src/lib/files/` (store ·
page · context · rules · meta), `web/src/lib/files/html*.ts` (the reader),
`web/src/lib/links.ts`.

**§2a's `web_sources` / `web_facts` were not built, and rule 12 is met differently.** That
placeholder imagined a knowledge store of facts extracted from pages. What was asked for is
narrower — read one page he pasted and answer about it — and nothing is extracted into
fields: the text is kept whole, for a day, and every part of it carries the four things rule
12 names. `source_url` and `fetched_at` are on the file row (one source per file),
`extraction_method` and `confidence` on each part. If a knowledge store is ever wanted, §2a
still describes it.

### Google Drive — drive_connections, drive_oauth_states, drive_reads, and one column on conversation_files (Milestone 5 part 3a, 16 Oct 2026)

A file picked from Drive is **a `conversation_files` row like any other** (D121) — same
ownership, same policy, same text table, same wrapper, the same 30 days — and its bytes are
stored nowhere. What Drive adds is the connection (one per person), the single-use attempt that
makes it, and the server's record of each file it read. Migration `20261016010000_drive.sql`.
SECURITY §12b says why each column is where it is.

**Added to `conversation_files`.** `drive_file_id text` — the Drive file the row was read from,
copied from `drive_reads`, never from the browser; null for an upload or a link, **and null again
once the row is removed** (the tombstone check now covers it). A Drive row's `source_url` is the
file's **one canonical address**, `https://drive.google.com/file/d/<id>/view`, and its
`source_host` is `drive.google.com` (`conversation_files_drive_source_check`), so part 2's "a
newer read of the same address replaces the older one" replaces an older read of the same Drive
file. A Drive row reads to the model as an upload does: `forTurn` gives it no `source`, and it
does not make a conversation one "with a page in it".

**`drive_connections` — one per person.**

| Column | Holds |
|---|---|
| `user_id` PK | FK `auth.users`, on delete cascade |
| `token_id uuid` | Which token the row holds now. A new token gets a new id, so a write meant for an older one (mark broken, delete after revoking) never lands on a newer one |
| `google_account_id` | Drive's permission id: tells "the same account again" from "a different account" (D125) |
| `google_email` | Shown so the page can say which account is connected (D126). Never logged |
| `refresh_token_sealed` | `v1.<iv>.<ciphertext+tag>`, AES-256-GCM sealed in the function, the person and the token id as associated data (D124). Pattern and length checked apart (PostgreSQL allows no repetition count over 255) |
| `granted_scope` | What Google granted — always exactly `drive.file`; nothing else is ever written |
| `status`, `broken_reason`, `broken_at` | `active` or `broken` with a reason code and a time (D122); `drive_connections_broken_check` holds the three together |
| `connected_at`, `last_used_at` | |

**`drive_oauth_states` — one per press of Connect.** `state_hash` (SHA-256 hex of the state sent
to Google, unique), `user_id`, `verifier_sealed`, `code_sealed` and `callback_error` (exactly one
set once the callback returned — `drive_oauth_states_returned_check`), `created_at`,
`expires_at` (ten minutes), `returned_at`.

**`drive_reads` — the server's record of each read.** `id` (the browser's request id; one id
reads one file, once), `user_id` (FK **`drive_connections`**, on delete cascade — a disconnect
takes the records with it), `drive_file_id`, `status` (`started` · `fetched` · `refused` ·
`failed`), `outcome` (a reason code), `name` (Drive's name when read, cleaned), `google_mime`,
`exported_as`, `byte_size`, `content_hash`, `modified_at`, `duration_ms`, `created_at`,
`fetched_at`. `drive_reads_fetched_check`: no `fetched` row without its name, size, hash and
time. **No content is stored here.**

**Who reads what.** All three tables: RLS enabled and forced, **one policy, `using (false)`** —
no browser session reads a row, its owner included; `authenticated` holds `SELECT` (what
`tests/security/rls.test.ts` asserts of every table), `service_role` all, `anon` nothing. Proven
in `tests/security/drive.test.ts`, including that an "own rows" policy would hand a browser its
own sealed token.

**Functions (`service_role` only).**

- `create_drive_oauth_state(p_user_id, p_state_hash, p_verifier_sealed, p_ttl_seconds,
  p_max_open)` → id. `DV001` past `p_max_open` open attempts per person.
- `return_drive_oauth_state(p_state_hash, p_code_sealed, p_error)` → `(id, user_id)` or no row.
  The callback: **once per state, only while fresh**.
- `take_drive_oauth_state(p_id, p_user_id)` → `(outcome, state_hash, verifier_sealed,
  code_sealed, callback_error)`. Deletes the attempt whatever the outcome; only `ok` — the same
  person, fresh, returned with a code — hands back anything sealed (D123).
- `save_drive_connection(p_user_id, p_expected_token_id, p_token_id, p_account_id, p_email,
  p_refresh_sealed, p_scope)` → `(replaced, same_account)`. Under a per-person lock; `DV002`
  when the row is not the one the caller saw. Audited `DRIVE_CONNECTED`, without the address.
- `mark_drive_connection_broken(p_user_id, p_token_id, p_reason)` → boolean; audited
  `DRIVE_BROKEN`. `delete_drive_connection(p_user_id, p_token_id)` → boolean; called only after
  Google confirmed the revocation; audited `DRIVE_DISCONNECTED`.
- `claim_drive_read(p_id, p_user_id, p_drive_file_id, p_per_minute)` → `(claimed, existing)`;
  `DR001` past the per-minute limit; a foreign-key error when there is no connection.
  `complete_drive_read(…)` → boolean, scoped to the person.
- `begin_conversation_file(…, p_fetch_id uuid default null, p_drive_read_id uuid default
  null)` — **dropped and recreated with a fourteenth parameter.** With a Drive read the
  attachment is checked against the record — this person's, `fetched`, within 15 minutes, still
  under a live connection, the same size and SHA-256, not `html` — and takes the Drive file,
  address, time **and name** from it; `FL007` otherwise. The same bytes already attached and
  read again: that row's time moves forward and it takes Drive's current name (renamed in Drive).
- `finish_conversation_file` — same signature; the audit row's `source` is `drive` for a Drive
  file. `remove_conversation_file` — same signature; nulls `drive_file_id`.
  `purge_conversation_files` — also deletes `drive_reads` older than a day and attempts past
  their ten minutes.

The new `begin` parameter has a default and is passed by name, so the `files` function deployed
before this migration keeps working until its own redeploy (RUNBOOK §1i). Code:
`src/lib/drive/` (limits · crypto · formats · stream · google · store · config · page · wiring ·
meta), `src/lib/files/` (store · page), `web/src/lib/driveApi.ts`, `web/src/lib/driveView.ts`.

### connector_keys, connector_key_secrets, connector_calls — the MCP connector (stage 1, 13 Oct 2026)

Migration `20261013010000_connector.sql` (D101–D110). Goodwill work, not on the milestone
list: the client's own AI reads the Finance Pipeline through a key.

- **`connector_keys`** — one row per key, belonging to one user. `key_id` (12 characters,
  public: what logs and `npm run connector -- list` show), `user_id`, `label`, `created_at`,
  `created_by`, `last_used_at`, `revoked_at`, `revoked_by`. **Never the key and never its
  digest.** A person may SELECT their own rows (`connector_keys_select_own`); nobody but
  `service_role` writes. This is the shape a settings screen (Milestone 5 part 4) reads
  without a migration.
- **`connector_key_secrets`** — `connector_key_id` → `key_hash`, the SHA-256 of the whole key,
  32 bytes. A table of its own so the project's rule holds — the signed-in role may SELECT
  every table and row-level security decides — while no session can read a digest: its one
  policy is `using (false)`.
- **`connector_calls`** — one row per request a key was allowed to make: `method` (from a
  fixed list — `other` for anything else, never the caller's text), `tool` (one of the four,
  or null), `subject_id` (the lead's id, `get_lead` only), `outcome`, `records`,
  `duration_ms`, `created_at`. It is what the rate limit counts and the record of what a key
  did. No argument text, nothing a tool returned. Rows older than 30 days are deleted when the
  same key next calls. A person may SELECT their own rows.

All three: RLS enabled and forced, `anon` holds nothing, `authenticated` holds SELECT only.

**Functions** (all `security invoker`, executable by `service_role` only):

- `connector_call(key_id, key_hash, method, tool, args, pipeline_ghl_id, per_minute, per_day)`
  — the one door. Key (constant-time digest comparison), user still active, limits under a
  per-key lock, the record, and for a tool call the read. Returns jsonb, never a row. Takes no
  user id.
- `connector_read(user_id, pipeline_ghl_id, tool, args)` — the four reads, declared
  `SET role = 'authenticated'` with `auth.uid()` set to the key's user: the mirror's own RLS
  decides, and the role cannot write. Every query names the pipeline id. Called only by
  `connector_call`.
- `connector_digest_equal(a, b)` — 32 steps, no early exit.
- `issue_connector_key`, `revoke_connector_key` — used by `npm run connector`; each writes an
  `audit_log` row (`CONNECTOR_KEY_ISSUED` / `CONNECTOR_KEY_REVOKED`, ids only). Five live keys
  a person at most (`CK002`); only active staff (`CK001`).

**What a tool returns traces to:** `ghl_pipelines`, `ghl_stages`, `ghl_opportunities`,
`ghl_contacts`, `ghl_custom_fields`, `ghl_sync_runs` (the part 1 sync), the seeded
`ghl_field_map`, and `ghl_notes` (notes written through the app, part 4). Nothing is derived
that those cannot back.

### tasks
`id · title not null · description · assignee · due_date ·
status (open|in_progress|done|cancelled) · priority ·
source not null (claude|notion|manual) · notion_page_id · created_by · created_at · updated_at`

*(24 Aug review: `source` is `not null` — every task has an origin, and that provenance
matters once the assistant can write tasks (Stage 3, D9). `priority` stays unconstrained
until Ross confirms the value set — R11.)*

---

## 5. Social and content (Stage 5)

Stage 5 **generates** social posts, carousels and ad copy in the client's voice; it does not
pull platform insights (R3 parked — scheduled social *insights* are not in Scope v3). The
insights tables this section used to hold (`social_accounts`, `social_metrics`,
`social_posts`) are parked verbatim below §6. What Stage 5 stores — drafts, their voice-check
results, approval state, and where a draft was published if anywhere — is specified at Stage
5. The one fixed rule: a draft below the voice / review threshold sits in `review_queue`
(`entity_type = 'content_draft'`) and is never published under the client's name unreviewed
(CLAUDE.md rule 14, R7).

---

## 6. Notion sync

*Retained. Under D29 the dashboard (Stage 3) is the primary surface and Notion is an internal
working surface, but the eight Notion databases exist (MEMORY.md 10 Aug) and anything that
mirrors into them still needs this map.*

### notion_sync_map
`id · entity_type · entity_id · notion_database_id · notion_page_id · last_pushed_at ·
last_pulled_at · content_hash`

Prevents duplicate Notion pages and lets the writeback know which fields changed. Only the
editable fields listed in `CLIENT-CONTEXT.md` §8 are ever accepted from a Notion pull.

---

## OUT OF CURRENT SCOPE — parked research-engine and social-insights tables (D23, R3)

**Nothing in this section ships in a migration.** These tables belonged to the B2B outbound
lead-research engine, which Scope v3 (22 Aug 2026, D23) puts out of scope — it was never
asked for by the client — and to scheduled social-insights tracking, parked under R3. They
are kept **verbatim**, not deleted: the provenance design (`org_sources` → `contacts` with
`source_url · fetched_at · extraction_method · confidence` NOT NULL) is the template for the
Stage 4 knowledge store (§2a), and the append-only `rankings` / `rubric_versions` pattern is
how any future scored output should be stored. Column notes that refer to "the nine stages"
or "the three researched types" are as written on 09 Aug and are superseded by §1.

### organizations — business records (lead types 1–3) — *PARKED*
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

*(`consumer_leads` was described as "deliberately a separate table — these have no website,
no crawl, no ranking, and mixing them into `organizations` would make every research query
carry a filter it could forget." That reasoning is D15, parked with this table; the
`consumer_leads` table itself is live, §2.)*

### org_sources — provenance for every page touched — *PARKED (template for §2a)*
`id · org_id FK · source_type (homepage|about|team|contact|agents|finance|search_result) ·
source_url not null · http_status · fetched_at not null · content_hash · storage_path ·
clean_text · robots_allowed not null`

Unique on `(org_id, source_url)`.

### contacts — business decision-makers (research engine) — *PARKED (moved here 24 Aug, D36)*
Kept verbatim as it stood in §2. Its consent columns (`consent_basis`, `opt_out`) follow the
same Spam Act reasoning as `consumer_leads`; if the table ever ships, they ship with it.

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

### email_verifications — *PARKED*
`id · contact_id FK · email · syntax_ok · mx_ok · is_disposable · is_role_account ·
provider_name · provider_result jsonb · final_status · cost_usd · verified_at`

One row per attempt. History retained — re-verification never overwrites.

### rankings — *PARKED*
`id · org_id FK · rubric_key text ('business_finance'|'referral_partner') · score int ·
tier char(1) · reasoning text · confidence numeric(3,2) · flags text[] · rubric_version int
FK · model text · input_tokens · output_tokens · cost_usd · created_at`

Never updated. A re-rank inserts a new row; latest by `created_at` is current.

### rubric_versions — *PARKED*
`id · rubric_key text · version int · rubric jsonb not null · notes · is_active bool ·
created_at`

Unique on `(rubric_key, version)`. Partial unique index enforces exactly one active version
per `rubric_key`. Seeded with Rubric A and Rubric B from `CLIENT-CONTEXT.md` §5–6.

### merge_log — *PARKED*
`id · surviving_id · merged_id · entity_type · similarity · decided_by (auto|human) · created_at`

### social_accounts — *PARKED (R3)*
`id · platform (instagram|facebook|linkedin) · handle · external_id · token_ref (vault
reference, NEVER the token) · token_expires_at · status · created_at`

### social_metrics — *PARKED (R3)*
`id · account_id FK · metric_date · followers · reach · impressions · engagement ·
profile_views · raw jsonb · pulled_at`
Unique on `(account_id, metric_date)` — idempotent daily pull.

### social_posts — *PARKED (R3)*
`id · account_id FK · external_post_id · posted_at · permalink · caption · likes · comments ·
shares · saves · reach · raw jsonb · pulled_at`
Unique on `(account_id, external_post_id)`.

---

## 7. RLS policy pattern

Every table follows this shape. No exceptions.

```sql
alter table public.consumer_leads enable row level security;
alter table public.consumer_leads force row level security;

-- Privilege layer is explicit, never inherited (24 Aug, found by CI): hosted pre-grants
-- ALL via default privileges, the local stack grants nothing — so the migration states
-- the grants itself. anon holds nothing; authenticated holds SELECT only. RLS filters
-- rows only after this check passes.
revoke all on public.consumer_leads from anon;
revoke all on public.consumer_leads from authenticated;
grant select on public.consumer_leads to authenticated;
-- service_role gets its grant explicitly too (part 3, 20260824020100): BYPASSRLS skips
-- row policies, not table privileges, and the local stack grants nothing — without this
-- an Edge Function using the service key through PostgREST is refused with 42501.
grant all on public.consumer_leads to service_role;

-- deny by default: no permissive policy for anon or authenticated
-- service_role bypasses RLS and is used only by n8n / Edge Functions

create policy "staff_read_consumer_leads" on public.consumer_leads
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

Memory tables (§4) add the ownership clause on top of the allowlist:

```sql
create policy "workspace_or_own_memory" on public.memory_facts
  for select to authenticated
  using (
    (scope = 'workspace' or user_id = auth.uid())   -- shared by default; 'user' is the private exception
    and exists (
      select 1 from public.app_users u
      where u.user_id = auth.uid() and u.is_active
    )
  );
```

`app_users` holds the staff allowlist (`user_id references auth.users`, `email`, `role`,
`is_active`, `is_admin`, `created_at`). It is the table Stage 2 part 3 (auth and user
management) builds on: a Supabase Auth account that is not in `app_users` with
`is_active = true` sees nothing and cannot reach the chat endpoint.

*(Part 3, 24 Aug: `is_admin boolean not null default false` is the second — and last —
authorization fact. It gates exactly two server-side operations: creating a staff user and
deactivating one (`src/lib/auth/admin.ts`). `role` stays a descriptive label with no
permission semantics; deriving permissions from labels would be a roles system, which part
3 explicitly does not build. Deactivation is `is_active = false` plus an auth-level ban —
never a delete, so a person leaving cannot take the workspace's memory with them (D33).)*

**Stage 3 part 4 (28 Aug, migration `20260828010000`) — the roster read, and exactly how far
it widened.** `app_users` was self-row-only, which is right while the only question is "may
this account in?" and impossible to build a staff list on. It is now readable in full by
**every ACTIVE allowlisted member** — one additional permissive policy, `app_users_select_roster`,
`using (public.is_active_staff())`. Nothing else moved (D56):

- `anon` still holds no grant and no policy, here or anywhere;
- `authenticated` still holds SELECT and nothing else — creating, deactivating, promoting and
  resetting all still go through the verified server path with the service role;
- a **non-allowlisted** account still reads zero rows (the predicate needs a row);
- a **deactivated** account still reads zero rows, *including its own* — `is_active_staff()`
  requires `is_active`, and `App.tsx`'s sign-in check depends on that staying true.

The self-row policy is kept beside it: permissive policies are OR'd, so it changes nothing
today and is the floor that keeps sign-in working if the roster policy is ever narrowed.

`is_active_staff()` is `security definer` for one reason: the allowlist EXISTS-subquery every
other policy uses cannot be written *inside* a policy on `app_users` — Postgres re-applies the
policy to the subquery and raises "infinite recursion detected in policy for relation
app_users". A definer function evaluates as its owner (postgres, BYPASSRLS) and breaks the
cycle. It is `stable`, its `search_path` is pinned, and `anon` has no EXECUTE on it.

**The last-admin invariant lives in the database, not in the application** (D58). Two admins
demoting each other at the same moment both read "two admins" under READ COMMITTED, both pass
an application check, and both commit — a lockout arrived at by two people who each did
something the interface allowed. So `set_staff_active(uuid, boolean)` and
`set_staff_admin(uuid, boolean)` take the same transaction-scoped advisory lock
(`hashtext('app_users|admins')`), re-read under it, and raise `23514` rather than leave zero
active administrators. Both are `service_role`-only, both idempotent, and both return the
resulting count. `src/lib/auth/access.ts` checks the same rule first so a person gets a
sentence instead of a constraint violation — that is the politeness; this is the guarantee.

**Verification requirement:** `tests/security/rls.test.ts` asserts an anon client and a
non-allowlisted authenticated client receive zero rows from every table, and that on memory
tables an allowlisted user sees every `workspace` row (the default) plus only their own
`user`-scoped rows. Since part 4 it also asserts the roster read is exactly as wide as
described above (test 9) and that user management and conversation deletion cannot be done
from a session at all (test 10). Runs
in the regression suite; a **Stage 2 (part 2) acceptance criterion** — the claim "RLS is
enabled" is not accepted, the test output is.

---

## 8. Migration discipline

- One logical change per timestamped migration file.
- Every migration reversible, or documents why not.
- `supabase db reset` must produce a working schema from zero, every time.
- Seed (`supabase/seed.sql`): `app_users` (the developer and Ross), the ten Finance Pipeline
  rows in `ghl_field_map` (`entity = 'stage'`) and the ten custom-field rows once their IDs
  are read from GHL. *(Was: Rubric A v1, Rubric B v1, disposable-domain list, discovery
  blocklist, one test org per lead type — all parked with the research engine, D23.)*
- **No manual changes in the Supabase dashboard, and none through the Supabase MCP.** If it
  isn't in a migration, it doesn't exist.
- **Stage 2 part 2 migration set — written 24 Aug** (was "proposed"; confirmed with two
  changes: `contacts` parked out of the set (D36), and the memory-layer migration also
  carries the parent-sync triggers because they are part of that logical change):
  `..._extensions.sql` (`pgcrypto`, `pg_trgm`, `vector`) → `..._app_users.sql` →
  `..._memory_layer.sql` (`conversations`, `messages`, `memory_chunks`, `memory_facts`, all
  with `user_id` + `scope`; parent-sync triggers) → `..._observability.sql` (`workflow_runs`,
  `api_usage`, `audit_log`) → `..._core_entities.sql` (`consumer_leads`, `field_overrides`,
  `review_queue`, `crm_sync_log`, `ghl_field_map`, `tasks`, `notion_sync_map`) →
  `..._rls.sql` (enable/force + policies on **every** table) → `..._triggers.sql`
  (`updated_at` + audit triggers). Nothing under the parked heading.
- **Stage 2 part 3 additions — written 24 Aug:** `20260824020000_app_users_is_admin.sql`
  (the admin flag, §7) and `20260824020100_service_role_grants.sql` (explicit
  `grant all … to service_role` — BYPASSRLS skips row policies, not table privileges, and
  the local stack inherits nothing; same environment-divergence class as the CI 42501).
  Any later migration that adds a table must carry its own service_role grant —
  `tests/security/rls.test.ts` asserts full DML per table and fails CI if one is missing.
- **Milestone 4 part 1 addition — written 12 Sep:** `20260912010000_ghl_sync.sql` — the six
  GoHighLevel mirror tables (§3), RLS enabled and forced with the staff-allowlist SELECT
  policy and the explicit anon / authenticated / service_role grants, and the three
  `service_role`-only sync functions. Reversible; the drops are listed at the top of the
  file. Seed: eleven `ghl_field_map` contact rows. Validated against the live project inside
  one `BEGIN…ROLLBACK` transaction through the Supabase MCP (MEMORY.md 12 Sep), not applied.
- **Milestone 4 part 4 addition — written 24 Sep:** `20260924010000_ghl_writes.sql` — the
  write record (`ghl_writes`, unique on `request_id`) and the mirrored notes (`ghl_notes`),
  RLS enabled and forced, staff-allowlist SELECT, explicit grants, and the three
  `service_role`-only write functions (`begin_ghl_write`, `finish_ghl_write`,
  `mark_ghl_opportunity_removed`, §3). Reversible; the drops are listed at the top of the
  file. **Not applied to the live project from this machine** (no CLI credentials, MCP down —
  MEMORY.md 24 Sep); CI replays it from zero.
- **Stage 3 part 4 addition — written 28 Aug:** `20260828010000_users_page.sql` — the roster
  read policy plus `is_active_staff()` (§7), `delete_conversation(uuid, uuid)` (§4), and
  `set_staff_active` / `set_staff_admin`, the two flag writes that hold the last-admin
  invariant under an advisory lock. All three functions are `service_role`-only by grant and
  asserted as such by `tests/security/rls.test.ts` test 10. Reversible; the drops are listed
  at the top of the file.
