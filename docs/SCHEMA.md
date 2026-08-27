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
file.** Nothing under a parked heading ships in a migration.

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

## 2a. Stage 4 — website knowledge store (design placeholder)

Stage 4 "reads websites and stores what it finds, with a full source trail on every field"
(Scope v3). The tables are specified at Stage 4, not here, but two things are fixed now so
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

### messages
`id · conversation_id FK · user_id not null · scope not null · role (user|assistant|tool) ·
content · tool_calls jsonb · tool_results jsonb · model · input_tokens · output_tokens ·
created_at`

`user_id` and `scope` are denormalised from the conversation so the RLS policy is a column
check, not a join. A trigger keeps them equal to the parent's.

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
- `user_id` / `scope` are the parent conversation's (trigger, as for `messages`): a chunk of
  a private conversation is private, a scope flip cascades, and the RLS policy needs no join.

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

Embeddings are Voyage `voyage-3`, 1024 dimensions, `input_type: document` (R5 — the key is
still to arrive; without it the chat runs and no chunk is written). Cost per chunk is in
`SECURITY.md` §8.

### memory_facts — structured memory (written from Stage 3 part 2, FND-310)
`id · user_id not null · scope not null · key not null · value not null · confidence ·
source_message_id · superseded_by · embedding vector(1024) · created_at`

Append-only. Updating inserts a new row and sets `superseded_by` on the old one. Current
facts = `where superseded_by is null`. Unique on `(user_id, scope, key) where superseded_by
is null` so two live values for one key cannot coexist. Written by `src/lib/memory/facts.ts`
(27 Aug 2026, migration `20260827010000_memory_facts_stage3.sql`):

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
  transaction under a per-key advisory lock: identical value → `unchanged`; new key →
  `inserted`; different value for a live key → the old row is pointed at the new one and the
  result is `superseded`. The partial unique index would refuse two live rows, so the
  function steps the old row out of "live" first (a self-reference), inserts, then repoints.
  Two callers racing on one key end with one live row superseding the other, never an error.
- **`source_message_id`** is the user message that carried the request, attached once the
  turn is saved (the fact is captured before the reply so the reply can say it was saved).
  Null for a fact stored by hand (`npm run memory -- remember`).
- **`scope`** is the conversation's (D41 applies to facts exactly as to chunks): a fact
  stated in a private conversation is private.
- `embedding` stays null in part 2: facts are few and always included in a turn (§4 of
  `docs/MEMORY.md` D46), so nothing ranks them by similarity yet. The column is there for
  the day the fact count outgrows the per-turn budget.
- **Read path for retrieval:** `match_memory_chunks(query, user, conversation,
  history_messages, limit, min_similarity)` — cosine top-k over `memory_chunks` via the HNSW
  index, workspace rows plus the caller's own private ones, no deleted conversation, no chunk
  whose messages are already in the turn's verbatim history window, nothing under the
  floor. `service_role` only, like the write path.

*Superseded column shape, kept for the record:* `scope (global|user|org) · scope_id`. Replaced
23 Aug by the two-value `scope` + `user_id` above; see the reasoning at the top of §4. *The
first draft of 23 Aug had `default 'user'`; corrected the same day to `default 'workspace'`
because the client was told memory is shared.*

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

**Verification requirement:** `tests/security/rls.test.ts` asserts an anon client and a
non-allowlisted authenticated client receive zero rows from every table, and that on memory
tables an allowlisted user sees every `workspace` row (the default) plus only their own
`user`-scoped rows. Runs
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
