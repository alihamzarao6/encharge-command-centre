# TASKS.md — Build Checklist

**How to use this file**
Work **one task at a time**, top to bottom. Do not skip ahead. Do not batch.
Plan Mode before any task touching more than two files.
After each task: tests pass → mark `[x]` → append to `docs/MEMORY.md` → `/clear`.
Do not begin a phase until the previous is signed off in `docs/PHASE-ACCEPTANCE.md`.

Legend: `[ ]` todo · `[x]` done · `[!]` blocked (reason inline)

---

## PHASE 0 — Pre-build ✅ COMPLETE

- [x] P0.1 Client access obtained: Supabase, Railway, Notion, GoHighLevel, Anthropic, LastPass, Google Sheets, MillionVerifier, MongoDB Atlas
- [x] P0.2 CRM confirmed: **GoHighLevel** (Close and HubSpot dropped)
- [x] P0.3 Lead types confirmed: eight, research on three
- [x] P0.4 Pipeline stages confirmed: nine
- [x] P0.5 Interface confirmed: Notion (custom dashboard declined, out of scope)
- [x] P0.6 API keys received: GoHighLevel Private Integration, Serper
- [x] P0.7 Spend cap ($50/mo) and alert address confirmed
- [x] P0.8 Scope document approved by Saqib and sent to Ross
- [x] P0.9 Docs revised to v2 (CLAUDE, PLAN, CLIENT-CONTEXT, SCHEMA, TASKS, MEMORY, PHASE-ACCEPTANCE)
- [ ] **P0.10 Resolve database platform: Supabase or MongoDB.** Blocks everything below
- [ ] P0.11 Voyage AI account + key (not urgent, Phase 4)
- [ ] P0.12 Confirm GoHighLevel custom fields: map to existing or create new

---

## PHASE 1 — Foundation

### 1A. Repository and tooling
- [ ] 1.1 Init repo, Node 20, TypeScript strict, ESLint, Prettier, Vitest
- [ ] 1.2 `.gitignore`, verify `.env` is ignored, `gitleaks` pre-commit hook
- [ ] 1.3 `src/lib/logger.ts` — structured logger with key-based secret redaction
- [ ] 1.4 `src/lib/errors.ts` — typed error classes, no thrown strings
- [ ] 1.5 `src/lib/http.ts` — fetch wrapper: timeout, retry+backoff+jitter, circuit breaker
- [ ] 1.6 Unit tests for 1.3–1.5 (redaction incl. nested, retry counts, breaker opens/closes)
- [ ] 1.7 GitHub Actions CI per `docs/TESTING.md` §8

### 1B. Database
- [ ] 1.8 **Restore the Supabase project from paused** (or execute the MongoDB decision from P0.10)
- [ ] 1.9 Confirm region is Sydney (ap-southeast-2)
- [ ] 1.10 Migration: extensions (`pgcrypto`, `pg_trgm`, `vector`)
- [ ] 1.11 Migration: enums/check constraints for `lead_type`, `pipeline_stage`, `lead_source` + `is_researched_type()` helper
- [ ] 1.12 Migration: `organizations`, `consumer_leads`, `org_sources`, `contacts`
- [ ] 1.13 Migration: `email_verifications`, `rankings`, `rubric_versions`, `field_overrides`, `review_queue`, `merge_log`
- [ ] 1.14 Migration: `crm_sync_log`, `ghl_field_map`, `workflow_runs`, `api_usage`, `audit_log`
- [ ] 1.15 Migration: memory layer — `conversations`, `messages`, `memory_chunks`, `memory_facts`, `tasks`
- [ ] 1.16 Migration: social — `social_accounts`, `social_metrics`, `social_posts`
- [ ] 1.17 Migration: `notion_sync_map`
- [ ] 1.18 Migration: `app_users` + RLS enable/force + deny-by-default policies on **every** table
- [ ] 1.19 Migration: `updated_at` triggers, audit triggers on core tables
- [ ] 1.20 `supabase/seed.sql` — Rubric A v1 + Rubric B v1 from CLIENT-CONTEXT §5–6, disposable-domain list, discovery blocklist, app_users, one test org per researched lead type
- [ ] 1.21 **`tests/security/rls.test.ts`** — anon and non-allowlisted see zero rows on every table
- [ ] 1.22 Verify `supabase db reset` replays cleanly from zero
- [ ] 1.23 Enable daily backups; perform and document one real restore

### 1C. n8n on Railway
- [ ] 1.24 Deploy n8n on Railway with **Postgres backing** (not SQLite)
- [ ] 1.25 Set `N8N_ENCRYPTION_KEY`, basic auth, webhook URL, timezone `Australia/Perth`
- [ ] 1.26 Back up the encryption key somewhere the client controls
- [ ] 1.27 Create credentials: database, Anthropic, Notion, GoHighLevel, Serper, Google
- [ ] 1.28 `src/lib/webhookAuth.ts` — HMAC signature + timestamp verification
- [ ] 1.29 Unit tests: valid sig, bad sig, replayed timestamp, missing header
- [ ] 1.30 Global error workflow → writes `workflow_runs` + alerts Ross@enchargecapital.com
- [ ] 1.31 `npm run n8n:export` / `npm run n8n:validate` scripts

### 1D. GoHighLevel
- [ ] 1.32 `src/lib/crm/ghl/client.ts` — auth with Private Integration token, rate-limit handling
- [ ] 1.33 Read the account's existing custom fields via API; populate `ghl_field_map`
- [ ] 1.34 Create any missing custom fields (`encharge_org_id`, `lead_type`, `ai_score`, `ai_tier`, `ai_reasoning`, `email_status`, `email_is_inferred`, `source_url`)
- [ ] 1.35 Confirm with Ross which pipeline receives leads, and map the nine stages to GHL stages
- [ ] 1.36 Contract tests against recorded GHL fixtures

### 1E. Notion
- [x] 1.37 Via Notion MCP: create parent page "Encharge Command Centre", then databases — Intake, Organisations, Contacts, Consumer Leads, Review Queue, Tasks, Social Dashboard, Ops Chat Log
      *Parent page created by hand in the UI — the MCP has no teamspace-root parent type. All eight databases created via MCP. See MEMORY.md 2026-08-10.*
- [x] 1.38 Properties and relations per `docs/PLAN.md` §7; editable vs read-only per CLIENT-CONTEXT §8
      *Done in the same session as 1.37. Notion cannot lock properties — the split is carried by property descriptions and enforced by the sync whitelist.*
- [ ] 1.39 `src/lib/notion/client.ts` — typed wrapper, rate-limit handling (3 req/s)
- [ ] 1.40 Create views via the Notion MCP (`create_view`). Board/gallery, 3–4 visible properties, mobile-first. Buttons still added by hand in the UI
- [ ] 1.41 Open every view on a phone and fix anything that scrolls sideways
- [ ] 1.42 Unit + contract tests against recorded Notion fixtures

### 1F. Phase 1 gate
- [ ] 1.43 **W0 health check:** Notion button → n8n webhook (HMAC verified) → DB write → Notion update, round trip
- [ ] 1.44 Cost tracking wired: a test Claude call lands in `api_usage`
- [ ] 1.45 Spend cap enforced **before** the call, not just monitored — test by tripping it
- [ ] 1.46 Alerting verified by deliberately failing a workflow
- [ ] 1.47 `npm run test:regress` green
- [ ] 1.48 Client demo + sign-off → **PAYMENT 1**

---

## PHASE 2 — Discovery and web data pulling

- [ ] 2.1 `src/lib/normalize/` — orgName, domain, phone + full unit tests
- [ ] 2.2 `src/lib/dedupe/hash.ts` — domain_hash + tests (all URL form variants)
- [ ] 2.3 `src/lib/dedupe/fuzzy.ts` — trigram match, threshold tuning, false-positive tests
- [ ] 2.4 `src/lib/routing/leadType.ts` — **researched vs tracking-only guard.** A consumer type must never reach the crawler. Test every one of the eight types
- [ ] 2.5 `src/lib/discovery/blocklist.ts` — directory/aggregator/social domains + tests
- [ ] 2.6 `src/lib/discovery/serper.ts` — Serper adapter, contract tests on fixtures
- [ ] 2.7 `src/lib/crawler/urlSafety.ts` — **every SSRF case in SECURITY.md §10** + tests
- [ ] 2.8 `src/lib/crawler/robots.ts` — parse, honour, cache 24h + tests
- [ ] 2.9 `src/lib/crawler/fetch.ts` — rate limit, size cap, timeout, redirect limit, re-check IP after redirect
- [ ] 2.10 `src/lib/crawler/sanitize.ts` — strip scripts, comments, hidden text, zero-width + tests
- [ ] 2.11 `src/lib/crawler/extract.ts` — HTML → clean text, link discovery. Include the referral-partner paths (`/agents`, `/advisers`, `/finance`) from PLAN §4.2
- [ ] 2.12 `src/lib/llm/client.ts` — Claude wrapper: model routing, prompt caching, cost logging, daily cap enforced **before** the call
- [ ] 2.13 `src/lib/llm/schemas.ts` — Zod schemas for every structured output
- [ ] 2.14 `src/lib/llm/parse.ts` — tolerant parse (fences, prose wrapper), validate, one retry with error, then flag
- [ ] 2.15 `src/lib/llm/prompts/resolveWebsite.ts` — untrusted-content wrapper per SECURITY §3, **no tools**
- [ ] 2.16 Storage: raw HTML → `raw-pages/{org_id}/{sha256}.html`, cleaned text → `org_sources`
- [ ] 2.17 `content_hash` skip logic — unchanged page not reprocessed
- [ ] 2.18 **W1 intake workflow:** Notion/CSV → classify lead_type → route → normalise → dedupe → create record
- [ ] 2.19 **W2 discovery workflow:** resolve website → crawl → store with full source trail
- [ ] 2.20 `tests/security/injection.test.ts` — 10+ adversarial pages, zero violations
- [ ] 2.21 Integration test: fixture org through W1+W2, DB end state asserted field by field
- [ ] 2.22 **Idempotency test:** run W1+W2 twice, record counts identical
- [ ] 2.23 Run 25 real orgs (mix of business finance and referral partners); website resolution accuracy ≥ 90%
- [ ] 2.24 `npm run test:regress` green + 10-record spot check against source pages
- [ ] 2.25 Client demo + sign-off → **PAYMENT 2**

---

## PHASE 3 — Contacts, verification, ranking, CRM push

- [ ] 3.1 `src/lib/llm/prompts/extractContacts.ts` — strict schema, null-not-guess rule stated explicitly
- [ ] 3.2 Seniority classifier + tests
- [ ] 3.3 `src/lib/extract/agentCount.ts` — count agents/advisers on referral-partner sites (Rubric B input) + tests
- [ ] 3.4 `src/lib/extract/inhouseFinance.ts` — detect in-house broker signals ("our finance partner", named broker on team page, bank ownership) + tests
- [ ] 3.5 `src/lib/email/patterns.ts` — inference from confirmed same-domain patterns only + tests
- [ ] 3.6 `src/lib/email/verify.ts` — 5 stages in cost order + tests per stage
- [ ] 3.7 MillionVerifier adapter + contract tests + per-call cost logged
- [ ] 3.8 `src/lib/email/sanity.ts` — extracted email domain must match org domain or known provider
- [ ] 3.9 `src/lib/ranking/prefilter.ts` — every hard reject from CLIENT-CONTEXT §7 (both rubrics) + tests
- [ ] 3.10 `src/lib/ranking/rubric.ts` — load active version **by rubric_key**, version every score
- [ ] 3.11 `src/lib/llm/prompts/rankBusinessFinance.ts` — Rubric A
- [ ] 3.12 `src/lib/llm/prompts/rankReferralPartner.ts` — Rubric B
- [ ] 3.13 Tier boundary tests at exactly 39/40/59/60/79/80, both rubrics
- [ ] 3.14 `tests/fixtures/golden-set.json` — 25 hand-verified orgs (15 business finance, 10 referral partner)
- [ ] 3.15 **Golden-set test:** tier within one band, zero fabricated fields, recall ≥ 80%
- [ ] 3.16 Review queue: confidence gate → `review_queue` → Notion page with Approve/Reject
- [ ] 3.17 Review write-back endpoint (validated, audited) → database
- [ ] 3.18 `src/lib/crm/ghl/upsert.ts` — idempotent contact upsert on `encharge_org_id`, then opportunity in the mapped pipeline/stage. Full `crm_sync_log`
- [ ] 3.19 `src/lib/crm/sheets.ts` — append-or-update by hidden key column in "Finance leads"
- [ ] 3.20 Failed-push handling: backoff → park as `failed` → alert. Never silently drop
- [ ] 3.21 `scripts/replay-crm.ts` — rebuild GHL + Sheets from the database
- [ ] 3.22 Notion writeback: accept **only** the editable fields from CLIENT-CONTEXT §8; everything else rejected with a logged reason
- [ ] 3.23 `field_overrides` flow — human correction preserves the original
- [ ] 3.24 **W3 enrich**, **W4 rank**, **W5 push** workflows
- [ ] 3.25 Consent/opt-out fields populated; `scripts/gdpr-delete.ts` written and tested
- [ ] 3.26 Full-pipeline integration test + idempotency test across all five workflows
- [ ] 3.27 Run 50 real orgs end to end; measure cost per org against the $0.12 NFR
- [ ] 3.28 `npm run test:regress` green + 10-record manual verification against source pages
- [ ] 3.29 Client demo + sign-off → **PAYMENT 3**

---

## PHASE 4 — Claude ops layer with memory

- [ ] 4.1 `src/lib/memory/facts.ts` — append-only, supersede logic, scope isolation + tests
- [ ] 4.2 `src/lib/memory/chunks.ts` — summarise old turns, embed via Voyage, store + tests
- [ ] 4.3 `src/lib/memory/retrieve.ts` — last N verbatim + vector top-k + current facts, token-budgeted
- [ ] 4.4 Voyage embedding adapter + contract tests
- [ ] 4.5 `src/lib/tools/registry.ts` — whitelist from PLAN §5.2, typed params, read/write flag
- [ ] 4.6 Read tools: `get_pipeline_metrics`, `search_organisations`, `get_lead_detail`, `get_conversion_rates`
- [ ] 4.7 Write tools with **two-turn confirmation**: `run_research_batch`, `assign_task`, `store_note`, `generate_content_from_url`, `push_to_crm`, `update_lead_stage`
- [ ] 4.8 Confirmation flow test: write tool must not execute on first turn, must on confirmed second
- [ ] 4.9 Every tool execution → `audit_log` (test asserts this)
- [ ] 4.10 `generate_content_from_url` grounded in CLIENT-CONTEXT §9 frameworks
- [ ] 4.11 Conversation endpoint (Edge Function) — authenticated staff only, HMAC on the n8n side
- [ ] 4.12 Notion Ops Chat Log surface: submit → response rendered, mobile-friendly
- [ ] 4.13 **Injection test on the ops layer:** scraped content pulled into a conversation must not trigger any tool
- [ ] 4.14 Memory continuity test: fact stored in session 1 recalled in session 2
- [ ] 4.15 Token budget test: long conversation stays in context without dropping current facts
- [ ] 4.16 Metrics reconcile against GoHighLevel, not against our own count
- [ ] 4.17 `npm run test:regress` green
- [ ] 4.18 Client demo + sign-off → **PAYMENT 4**

---

## PHASE 5 — Social tracking, polish, handover

- [ ] 5.1 **Confirm API access exists** — Meta Business linked, LinkedIn app approved. Blocked? Log `[!]` and agree the fallback in writing before proceeding
- [ ] 5.2 `src/lib/social/instagram.ts` + contract tests
- [ ] 5.3 `src/lib/social/facebook.ts` + contract tests
- [ ] 5.4 `src/lib/social/linkedin.ts` + contract tests
- [ ] 5.5 Token storage via vault reference; automated refresh; 7-day expiry alert + test
- [ ] 5.6 **W6 social workflow** — daily scheduled pull, idempotent on `(account_id, metric_date)`
- [ ] 5.7 Idempotency test: run the daily pull twice, one row per day
- [ ] 5.8 Notion Social Dashboard with 7/30-day deltas
- [ ] 5.9 **Mobile pass:** every Notion view opened and fixed in the phone app
- [ ] 5.10 **W8 monitoring workflow** — daily health check, cost rollup, stale-data and token-expiry alerts
- [ ] 5.11 `docs/RUNBOOK.md` completed and walked through end to end
- [ ] 5.12 Security checklist SECURITY.md §12 — every box ticked
- [ ] 5.13 Rotate all keys; transfer ownership of every account to the client
- [ ] 5.14 Record a walkthrough video: daily use, review queue, ops chat, what to do when something breaks
- [ ] 5.15 Final `npm run test:regress` + full manual QA (TESTING.md §9)
- [ ] 5.16 Client demo + sign-off → **PAYMENT 5**

---

## Blocked / parked

| Item | Reason | Since | Unblocked by |
|---|---|---|---|
| P0.10 database platform | Supabase paused, MongoDB org appeared, intent unconfirmed | 09 Aug | Ross |

*Anything sitting here more than 3 days goes into a client message, not silence.*
