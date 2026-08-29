# TASKS.md — Build Checklist

**How to use this file**
Work **one task at a time**, top to bottom. Do not skip ahead. Do not batch.
Plan Mode before any task touching more than two files.
After each task: tests pass → mark `[x]` → append to `docs/MEMORY.md` → `/clear`.
Do not begin a stage until the previous is signed off in `docs/PHASE-ACCEPTANCE.md` — stages
map to client payments (D27).

**Scope v3 (22 Aug 2026, `docs/MEMORY.md` D23–D32) is binding.** Six stages replace the five
phases (D26). The original five-phase checklist is **frozen under the "PARKED / SUPERSEDED"
heading at the bottom** — do not work from it. Where a live task is carried over from it, the
old ID is given in brackets so the history stays traceable.

Legend: `[ ]` todo · `[x]` done · `[!]` blocked (reason inline) · `[~]` in progress

---

## STAGE 0 — Pre-build ✅ COMPLETE

- [x] P0.1 Client access obtained: Supabase, Railway, Notion, GoHighLevel, Anthropic, LastPass, Google Sheets, MillionVerifier, MongoDB Atlas
- [x] P0.2 CRM confirmed: **GoHighLevel** (Close and HubSpot dropped)
- [x] P0.3 Lead types confirmed: eight *(research on three — superseded by D23: no research on any)*
- [x] P0.4 Pipeline stages confirmed: ~~nine~~ **ten — the Finance Pipeline, built in Stage 1 (D28). The nine were never built (R15)**
- [x] P0.5 Interface confirmed: ~~Notion (custom dashboard declined)~~ **superseded by D29 — a dashboard is in scope at Stage 3; Notion stays as an internal working surface**
- [x] P0.6 API keys received: GoHighLevel Private Integration, Serper *(Serper parked with the research engine, D23)*
- [x] P0.7 Spend cap ($50/mo) and alert address confirmed *(address now `rossb@fundd.com.au`, D25)*
- [x] P0.8 Scope document approved by Saqib and sent to Ross *(superseded by Scope v3, 22 Aug)*
- [x] P0.9 Docs revised to v2 (CLAUDE, PLAN, CLIENT-CONTEXT, SCHEMA, TASKS, MEMORY, PHASE-ACCEPTANCE)
- [x] **P0.10 Resolve database platform: Supabase or MongoDB** — **CLOSED 22 Aug: Supabase, confirmed by the client (D24).** The pause was free-tier idle auto-pause
- [ ] P0.11 Voyage AI account + key — **Stage 3** (memory layer), not before (R5)
- [x] P0.12 Confirm GoHighLevel custom fields: map to existing or create new — **resolved by construction 22 Aug: Stage 1 created ten fields in their own folder; the 21 pre-existing fields stay untouched (R2)**

---

## STAGE 1 — GoHighLevel + Meta ✅ COMPLETE · signed off and paid 22 Aug 2026 (198)

Built directly in the client's live accounts. Recorded here as delivered, not as a checklist
to re-run. Detail: `docs/PHASE-ACCEPTANCE.md` Stage 1, `docs/MEMORY.md` 22 Aug.

- [x] S1.1 **Finance Pipeline** created with ten stages: New Lead · Appointment Booked · Contacted · Qualified · Docs Requested · Docs Received · Submitted to Lender · Approved · Settled · Lost / Not Proceeding (D28). New pipeline; nothing account-wide touched (R22). *Corrected 24 Aug: the build delivered **nine** — "Appointment Booked" (specified 19 Aug) was missed, caught by the first API read of the pipeline, and created via an approved API write on 24 Aug with the other nine stage IDs untouched (MEMORY.md 24 Aug)*
- [x] S1.2 **Ten custom fields in their own folder**: Loan Type, Loan Amount, Property Value, Deposit Amount, Employment Type, Annual Income, Credit Concerns, Lead Source, Preferred Contact Time, Current Interest Rate
- [x] S1.3 **Five live workflows**: New Lead Intake, Instant Lead Reply, 24hr No Contact Alert, Document Chase, Stage Notifications — copy rewritten for refinance
- [x] S1.4 **Refi Pixel** on the FUNDD funnel, **Conversions API** sending `Lead` server-side on a pixel-scoped token (D31)
- [x] S1.5 Notifications cut from six per lead to one (two if the lead books), to `rossb@fundd.com.au` (D32)
- [x] S1.6 Client demo + sign-off → **PAYMENT 1 (198) — received**

Carried forward from Stage 1, not blocking: R21 (GHL scope reconciliation), R24
(`finance-option.com.au` → Refi Pixel), R17 (no consent record for ~180 contacts).

---

## STAGE 2 — Foundations + AI trained on the client's voice ← ACTIVE

Ends in something the client can open on his phone and talk to. Definition of done:
`docs/PHASE-ACCEPTANCE.md` Stage 2, items 1–12. Seven parts, in order; **do not start part
N+1 until part N is reviewed.**

### Part 1 — Scope v3 doc alignment + repo foundation (FND-200)

*Docs first: parts 2–7 are built by reading these files.*

- [x] 2.1.1 `docs/SCHEMA.md` — `pipeline_stage` → ten Finance Pipeline values (nine kept as superseded note); `organizations`, `org_sources`, `rankings`, `rubric_versions`, `email_verifications`, `merge_log` parked; `consumer_leads` with `consent_basis` / `opt_out` kept; memory tables carry `user_id` + `scope` (`user | workspace`) from the first migration, with the reasoning; RLS pattern and migration discipline kept in full
- [x] 2.1.2 `docs/SECURITY.md` — kept in full incl. §3 prompt injection; §12 token scopes now include `customFields`, `customValues`, `tags`; Anthropic-key-server-side-only rule added with R18 as the reason (T11)
- [x] 2.1.3 `docs/PHASE-ACCEPTANCE.md` — six stages; Stage 1 recorded as demonstrated; Stage 2 definition of done, testable; five-phase criteria kept verbatim under SUPERSEDED
- [x] 2.1.4 `tasks/TASKS.md` — this file: six stages, Stage 2 in seven parts, Stage 1 complete, Notion done-items kept, five-phase list frozen below
- [x] 2.1.5 `docs/RUNBOOK.md` — Serper, MillionVerifier, Voyage-for-research and rubric procedures moved out of the live sections and parked; key rotation, backup/restore, escalation kept
- [x] 2.1.6 `README.md` — docs map, six stages, stale database blocker removed, rebrand noted
- [x] 2.1.7 *(was 1.1)* Node 24 (was Node 20 — D35), TypeScript strict, ESLint, Prettier, Vitest
- [x] 2.1.8 *(was 1.2)* `.gitignore` verified for `.env`; `gitleaks` pre-commit hook installed (fail-closed) and **shown blocking a planted key pattern**
- [x] 2.1.9 *(was 1.3)* `src/lib/logger.ts` — structured logger, key-based secret redaction (`password`, `key`, `token`, `secret`, `authorization` …) at the serialiser level, nested objects included
- [x] 2.1.10 *(was 1.4)* `src/lib/errors.ts` — typed error classes, `Result` type; never throw a string
- [x] 2.1.11 *(was 1.5)* `src/lib/http.ts` — fetch wrapper: timeout, retry with exponential backoff + jitter (idempotent requests only), circuit breaker per origin
- [x] 2.1.12 *(was 1.6)* Unit tests for 2.1.9–2.1.11: nested redaction, retry counts, breaker opens **and** closes. Coverage ≥ 80% lines / 75% branches
- [x] 2.1.13 *(was 1.7)* GitHub Actions CI: typecheck, lint, gitleaks, tests with coverage gate
- [ ] 2.1.14 Part 1 report reviewed; changes requested applied; working tree committed and pushed **by the reviewer's instruction only**

### Part 2 — Database, migrations, RLS (FND-210 — built 24 Aug, awaiting review)

*This machine has no Docker and `.env` has no Supabase credentials, so nothing could be
applied or run locally. Every migration was instead **validated against the live Sydney
project through the Supabase MCP's `execute_sql`, inside a rolled-back transaction**
(measured checks all green, database left byte-identical — MEMORY.md 24 Aug; access path
recorded in SECURITY.md §4), and the CI `integration` job replays the schema from zero and
runs both suites on every push. Items marked `[~]` are written and validated but await
their first real run (CI on push, or credentials).*

- [x] 2.2.1 *(was 1.8)* ~~Unpause the Supabase project~~ — **found already ACTIVE_HEALTHY on 24 Aug** (nothing to restore); region **`ap-southeast-2` confirmed from project settings via the management API** (D8). The project runs **Postgres 17.6**, not the 15 the docs said — SCHEMA.md and CLAUDE.md corrected
- [~] 2.2.2 Supabase CLI pinned as a devDependency (`supabase@2.115.0`, `npx supabase`); `supabase/config.toml` committed (`major_version = 17`). **Not done:** `supabase link` (needs an access token) and `supabase start` locally (needs Docker — not installed on this machine)
- [x] 2.2.3 *(was 1.10)* Migration `20260824010000_extensions.sql` — `pgcrypto`, `pg_trgm`, `vector` (0.8.2 available on the project, verified)
- [x] 2.2.4 *(was 1.18, moved first)* Migration `20260824010100_app_users.sql` — PK on `user_id references auth.users` (1:1 allowlist, no surrogate id — recorded deviation)
- [x] 2.2.5 *(was 1.15)* Migration `20260824010200_memory_layer.sql` — all four tables with `user_id not null` + `scope` (D24, D33); parent-sync trigger on `messages` **and** `memory_chunks`, plus a cascade trigger so flipping a conversation's scope actually re-scopes its children (a silent privacy hole otherwise — validated)
- [x] 2.2.6 *(was 1.14)* Migration `20260824010300_observability.sql` — `workflow_runs`, `api_usage` (`user_id`, `conversation_id`, cache token columns), `audit_log`
- [x] 2.2.7 *(was 1.11–1.13, reduced)* Migration `20260824010400_core_entities.sql` — check constraints (ten stages D28, eight types, seven sources) inline per SCHEMA conventions · `consumer_leads` with `consent_basis` + `opt_out not null default false` · `field_overrides` · `review_queue` (`entity_type` settled: `consumer_lead | web_fact | content_draft`, D37) · `crm_sync_log` · `ghl_field_map` · `tasks` · `notion_sync_map`. **`contacts` does not ship — parked (D36)**. Nothing from the parked section (asserted by test)
- [x] 2.2.8 *(was 1.18)* Migration `20260824010500_rls.sql` — enable **and force** on all 15 tables; deny-by-default (no anon policies, no write policies); staff-allowlist selects; `workspace_or_own` on the four memory tables; `app_users` is self-row-only, which is what makes the allowlist subquery recursion-free
- [x] 2.2.9 *(was 1.19)* Migration `20260824010600_triggers.sql` — `updated_at` on `consumer_leads`/`tasks`; audit triggers on `consumer_leads`, `review_queue`, `memory_facts`, `app_users` (`contacts` parked out of the list, D36)
- [x] 2.2.10 *(was 1.20, reduced)* `supabase/seed.sql` — two `app_users` rows (Ross, developer) over placeholder auth identities with fixed UUIDs; ten `ghl_field_map` stage rows **with real stage IDs** (24 Aug: authorized read found only nine stages live — "Appointment Booked" was missed in the Stage 1 build and created via an approved API write, then all ten IDs read and seeded, matched on ID never name; the mapping is pinned in `tests/integration/schema.test.ts`)
- [x] 2.2.11 *(was 1.21)* `tests/security/rls.test.ts` — catalog-iterating, all six required assertions plus behavioural write-refusal **and the privilege-layer grants assertion** (added after the first CI run caught a missing GRANT — MEMORY.md 24 Aug [CI fix]). **Green in CI** (run 32686391063 on `2843901`, 24 Aug) against a real local stack: anon zero everywhere, non-allowlisted zero via RLS with grants present, A/B `user`-scope isolation, workspace shared
- [x] 2.2.12 *(was 1.22)* From-zero replay proven twice: rolled-back validation on the live project (all 22 checks green), and **`supabase db reset --local` green in CI** (run 32686391063, 24 Aug) followed by the integration suite against the freshly replayed schema. Runs on every push; a local run still needs Docker
- [!] 2.2.13 *(was 1.23)* **Blocked — the org is on the free plan, which has no automated backups at all** (the old RUNBOOK §6 text described Pro). Client cost decision needed (Pro US$25/mo vs scripted `pg_dump`); restore drill still owed before Stage 2 sign-off and needs Docker or the DB password. RUNBOOK §6 rewritten with the reality and the drill procedure
- [x] 2.2.14 `npm run test:int` / `test:security` wired (skip without a stack, hard-fail in CI via `REQUIRE_SUPABASE_TESTS=1`); CI `integration` job added (CLI pinned 2.115.0, `supabase start`, `db reset --local`, both suites); `docs/SCHEMA.md`, `docs/TESTING.md`, `docs/RUNBOOK.md`, `docs/SECURITY.md`, `docs/MEMORY.md` updated

### Part 3 — Auth and user management

- [x] 2.3.1 **Email + password, decided and recorded** (MEMORY.md 24 Aug [FND-220] — it is what the client was told in writing; a magic link needs a production email sender that does not exist). Public signup **disabled** in `config.toml` (admin-created accounts only), minimum password length 12; the hosted project's signup toggle and the deployed site/redirect URLs are deploy-time settings (part 6) — flagged in the manual checklist
- [x] 2.3.2 `src/lib/auth/verify.ts` — token → typed decision (`401` missing/invalid vs `403` not-allowlisted/deactivated vs authorized with `is_admin`); infrastructure failure is the error channel, never a 403. supabase-js adapters in `src/lib/auth/clients.ts` (fetch timeout, no blind retries of non-idempotent auth writes). Strict, no `any`
- [~] 2.3.3 The 401/403 decision layer plus unit tests for missing / expired / tampered token, non-allowlisted and deactivated (`tests/unit/auth/verify.test.ts`, `clients.test.ts` — GoTrue-shaped fixtures). **The chat endpoint itself does not exist until parts 4/6**; wiring the decision onto HTTP responses lands with the endpoint, which is when acceptance item 4's three HTTP responses can be captured
- [x] 2.3.4 `src/lib/auth/admin.ts` + `npm run staff` CLI: add-user (auth user + `app_users` row + one-time generated password), deactivate (**never delete** — `is_active = false` + auth ban; memory survives), reset-password, and bootstrap that attaches credentials to the two **seeded fixed UUIDs** without minting new identities. Every operation verifies the CALLER is an active admin (`is_admin`, migration `20260824020000`); explicit audit rows with the human actor. Plus `20260824020100` — explicit `service_role` grants (found: part 2 granted nothing to service_role, so PostgREST-as-service-role fails 42501 on local/CI). Proven by `tests/security/auth.test.ts` + `secrets.test.ts` (in CI; no Docker locally — SQL validated rolled-back on the live project, MEMORY.md 24 Aug)
- [x] 2.3.5 `docs/SECURITY.md` §4–§6, `docs/SCHEMA.md` §7–§8, `docs/MEMORY.md` updated; acceptance item 4 evidence: the DB-level half (zero rows for deactivated/non-allowlisted) captured by the security suite, the HTTP half deferred to the endpoint (see 2.3.3)

### Part 4 — Claude integration layer

- [x] 2.4.1 *(was 2.12)* `src/lib/llm/client.ts` — Claude wrapper over `src/lib/http.ts` (request marked non-idempotent; `client.ts` retries only provably-unbilled 429/5xx envelopes, never timeouts): model routing from `CLAUDE_MODEL_DEFAULT` / `CLAUDE_MODEL_FAST` (env, no redeploy), prompt caching (`cache_control` on the stable prefix — `prompt.ts` placeholder until part 5), timeout, **UTC daily + monthly provider-wide caps enforced in code before the call, fail-closed**, every billed or possibly-billed call written to `api_usage` (`store.ts`; reservations as `:unconfirmed`). `chat.ts` = the server-side turn (verify → validate → conversation → Claude → `messages`); `wiring.ts` = env → deps; `supabase/functions/chat` Deno adapter; `npm run chat` runner. Unit: 26 client + 27 chat + 12 store + 3 wiring + 33 pure
- [~] 2.4.2 *(was 2.13–2.14)* Response parsing is Zod (`response.ts`, rule 13 — `zod` added as a dependency). The **extraction** schemas + tolerant parse + one-retry-then-review-queue belong to the stages that extract (4 and 5); nothing in part 4 produces structured output to parse
- [x] 2.4.3 **The Anthropic key is read from the server environment by exactly one module** (`config.ts`) — `tests/security/secrets.test.ts` asserts `ANTHROPIC_API_KEY`, `api.anthropic.com` and the `x-api-key` header each have one reader in `src/`, scans `supabase/functions/` too; the built-asset grep lands with the bundle in part 6 (T11, R18)
- [x] 2.4.4 Contract tests against a recorded Anthropic fixture (`tests/fixtures/anthropic/messages-ok.json`, recorded from the live call `req_011CeNPXfxvgJzSwMaXUPubk`) via the injectable fetch — no msw dependency needed; cap-trip test asserts zero fetches and zero rows, unit and against the real stack (`tests/integration/llm.test.ts`)
- [x] 2.4.5 `docs/SECURITY.md` §8 rewritten for the real shape, `SCHEMA.md` §3, `RUNBOOK.md` §3, `TESTING.md` §2, `.env.example`, `CLAUDE.md` §5, `docs/MEMORY.md`; acceptance item 5 evidence captured (unit + stack); item 6's browser half lands with the bundle in part 6

### Part 5 — Voice and brand prompt layer

- [x] 2.5.1 Voice corpus assembled **only** from `CLIENT-CONTEXT.md` §1, §9, §10, §11 and any samples Ross supplies; every rule in the system prompt cites its section (traceability table committed). Brand name in generated copy: **Fundd** — confirmed by Ross 25 Aug ("Everything will be Fundd. Email, landing page, booking page, Calender."), D25 closed. Panel size and Discovery Session name are `LENDER_PANEL_COUNT` / `DISCOVERY_SESSION_NAME` in `rules.ts`, marked unverified until Ross confirms
- [x] 2.5.2 `src/lib/voice/` — system-prompt builder (pure function) + unit tests; stable prefix structured for prompt caching
- [x] 2.5.3 `tests/fixtures/voice/` — ≥ 20 fixed prompts with recorded responses; **code-checked conformance**: never positions as a bank; three pillars on positioning questions; Meta ad = Hook → Body → CTA, headline < 28 chars; one CTA per asset; no stale stack reference (R19); no number / rate / claim not present in the prompt (R7). 100% pass in CI
- [ ] 2.5.4 Five generated posts prepared for acceptance item 9 (Ross confirms he would publish at least three as they stand) — *was a 10-pair blind A/B; replaced 23 Aug*. **25 Aug:** eight recorded posts exist in `tests/fixtures/voice/responses/fb-*.json` and the reviewer's own brief runs with `npm run voice -- live "<brief>"`; the five for item 9 are generated fresh in the acceptance session from briefs Ross has not seen output of (part 7)
- [x] 2.5.5 `docs/CLIENT-CONTEXT.md` §9–§11 **untouched** (blob identical to HEAD, checked 25 Aug); `docs/MEMORY.md` updated; `docs/VOICE.md` added (traceability table, version log, corrections workflow, cost)

### Part 6 — Chat interface, responsive, deployed

- [x] 2.6.1 Chat UI: login, conversation list, message thread, composer. **Mobile-first**, verified at 375 / 768 / 1280 — no horizontal scroll, inputs ≥ 16px (iOS zoom trap, `EXISTING-PROTOTYPE.md`). *(FND-250, 25 Aug: `web/` — Vite + React, static output; dashboard shell with Assistant live and Memory / Content / Ads as labelled not-yet sections; `tests/e2e/assistant.spec.ts` asserts no horizontal scroll and ≥16px inputs at all three widths in Chrome.)*
- [x] 2.6.2 Conversations and messages persisted server-side against `user_id` (SCHEMA §4) — the same conversation visible on phone and laptop after login. *(The browser reads `conversations` / `messages` under RLS as the signed-in user; the Edge Function writes them with the service role and titles a conversation from its first message. Cross-device proof is the part-7 live test.)*
- [x] 2.6.2a **Conversation history in the request** (decided on FND-230 review, 25 Aug): a turn sends the prior `messages` of the **current conversation only** to Claude, so the second message remembers the first. Load via a `ConversationStore.recentMessages(conversationId)` adapter and pass them through `CompletionRequest.messages` (already an array — `chat.ts` sends one message today, deliberately). Bounded (last N turns / token budget, config), oldest first, `user`/`assistant` roles only. **No semantic recall, no facts, no cross-conversation retrieval — that stays Stage 3.** Cost note: history is uncached input; the part-5 prefix stays the cached part. *(Done 25 Aug: `ConversationStore.recentMessages`, `boundHistory` — `CHAT_HISTORY_MAX_MESSAGES` 20 / `CHAT_HISTORY_MAX_CHARS` 24,000 defaults, newest wins, request always starts with a user turn; a new conversation is not asked. Unit: chat 5 + boundHistory 4 + store 3 + config 2.)*
- [x] 2.6.3 **Enable and bundle `supabase/functions/chat`** (`[functions.chat] enabled = true` in `config.toml`; the library's NodeNext `.js` specifiers need an esbuild bundle step or Deno sloppy-imports — `supabase start` failed to bundle it on the part-4 push, CI 32790078875, so it ships disabled). Deployed at a stable URL over HTTPS; the browser calls **only our endpoint**, never `api.anthropic.com`; no secret in the bundle (build-time grep in CI). *(25 Aug: source moved to `src/functions/chat/index.ts`; `npm run functions:bundle` (esbuild) writes the gitignored entrypoint with supabase-js / zod left to Deno via `deno.json`; `enabled = true`. `npm run web:check` greps `web/dist` for key shapes, the real key values when present, and 24 voice sentences + the version tag — 0 hits; runs in CI. **Deployment to a stable URL is the reviewer's step — no Supabase credentials or Docker on this machine.**)*
- [x] 2.6.4 Error states visible, not silent: cap reached, auth failure, upstream timeout each show a message. *(402 → plain words, no code; 401 mid-turn → login with the draft kept and restored; network / timeout / empty reply → failed bubble with Retry that resends the same text; server-side `EMPTY_REPLY` 502 so a blank reply is never saved. Browser tests at three widths.)*
- [x] 2.6.5 Screenshots at the three widths committed under `docs/assets/stage-2/`; `docs/RUNBOOK.md` §1 system map updated with the deployed URL and owner. **Deployed 25 Aug: https://fundd-command-centre.vercel.app** — login, a turn in voice (9.1 s), one `api_usage` row and the saved conversation all proven live (RUNBOOK §1a). *(Screenshots generated by the browser suite against the scripted backend — login, empty, conversation, cap-reached × 375 / 768 / 1280. RUNBOOK §1a has the deploy procedure (Vercel, decided on review 25 Aug); **the URL is filled in on deploy**, blocked on Supabase CLI credentials — see MEMORY 25 Aug.)*
- [x] 2.6.6 **Streaming** (review, 25 Aug): `client.stream()` (SSE from Anthropic, billed from `message_start` / `message_delta`, one `api_usage` row; interrupted → `:partial` row + partial text), `handleChatTurnStream`, the Edge Function answers `Accept: text/event-stream` with `start` / `delta` / `done` | `error` events, the browser streams and degrades to JSON when the answer is not a stream. Copy appears only on a saved reply. Unit: sse 8, stream 13, chat-stream 7, http.open 3, web stream 8; browser 12 × 3.
- [x] 2.6.7 **Copy strips `Note:` lines** (review, 25 Aug): `web/src/lib/notes.ts` mirrors `conformance.stripNotes` (asserted equal); notes render set apart under the reply.

### Part 7 — End-to-end test and Stage 2 acceptance

- [ ] 2.7.1 End-to-end test: login → send message → reply in voice → `api_usage` row → reload on a second device shows the conversation
- [ ] 2.7.2 `npm run typecheck && npm run lint && npm run test:regress` green — counts and coverage recorded in numbers
- [ ] 2.7.3 Acceptance items 1–12 walked through with evidence captured in `docs/MEMORY.md`
- [ ] 2.7.4 Client demo on **his phone** + sign-off in writing → **PAYMENT 2 (198)**

---

## STAGE 3 — Memory + dashboard

*Outline — detailed at Stage 3 kickoff. Criteria: `PHASE-ACCEPTANCE.md` Stage 3.*

- [!] 3.1 *(P0.11)* Voyage AI account + key (R5) — **asked of the client 26 Aug; the adapter is complete and fixture-tested, the live call is the only thing waiting** (FND-300)
- [~] 3.2 *(was 4.1–4.4)* `src/lib/memory/` — in five parts (FND-300 → FND-340):
  - [x] 3.2.1 **Part 1 (FND-300, 26 Aug, staged not committed) — embeddings + conversation summarisation.** `config.ts` (sole `VOYAGE_API_KEY` reader; own caps 0.50/day, 5/month), `embed.ts` (Voyage `voyage-3` 1024-d: cap before HTTP, timeout, idempotent retries, Zod, `api_usage` row per call), `summarise.ts` (Haiku, no voice prompt, delimited transcript, validated, one retry), `policy.ts` (10-message windows + 24 h idle tail, pure), `chunks.ts` (store; overlap → `exists`), `trigger.ts` (after-turn hook, sweep, flush). Migration `20260826010000`: `turn_range not null` + valid, `exclude … (conversation_id =, turn_range &&)`, ivfflat → HNSW. `chat.ts` gains `afterTurn` / `waitUntil`; the Edge Function passes `EdgeRuntime.waitUntil`. `npm run memory -- flush | sweep | preview`. Tests: unit (policy, config, embed, summarise, chunks, trigger, chat-memory, wiring, redaction), security (`voyage-key`, RLS on `memory_chunks`), integration (`memory.test.ts`, schema constraint + HNSW). Acceptance evidence in MEMORY.md 26 Aug. **Not verified here: `db reset` from zero and the stack suites (no Docker) — CI; a live embedding (no key)**
  - [~] 3.2.2 **Part 2 (FND-310, 27 Aug, staged not committed) — durable facts + retrieval.** `facts.ts` (store over `upsert_memory_fact`; key `<category>:<slug>`), `capture.ts` (explicit route only: code gate → Haiku extractor → Zod + access/override guards; on the reply's path so the reply can say "saved" truthfully), `retrieve.ts` (facts always-on + top-3 chunks over a 0.45 floor via `match_memory_chunks`, budgeted under the 4,000-char below-breakpoint cap, framed as data, raced against a 4 s deadline — every failure degrades, never refuses), `chat.ts` step 4b + `TurnMemory`, `ChatReply.memory`, `wiring.ts` `createTurnMemory`. Migration `20260827010000`: key/confidence/value constraints, the two `service_role`-only functions. `npm run memory -- recall | remember | facts`. Tests: unit (facts, capture over 5 recorded Haiku answers, retrieve, retrieval-config, chat-recall), security (`rls.test.ts` 7: function privileges), integration (`recall.test.ts`, Part C 1–7 through `handleChatTurn`). **Blocked in this session: `supabase db push` was refused by the tool permission layer — migration validated live in a rolled-back transaction only; the live recall through the real function and the Edge deploy wait on the reviewer (report, MEMORY.md 27 Aug)**
  - [~] 3.2.3 **Part 3 (FND-320, 27 Aug, staged not committed) — the Memory page.** `access.ts` (who may remove: the author or an admin; the ONE rule, imported by both the Edge Function and the browser, plus the two length limits the interface must honour), `page.ts` (`handleMemoryRequest` + `supabaseMemoryPageStore`: **add** through the same extractor and guards as “remember that…” so the page is not a way round D43; **edit** keeps his words under the existing key and upserts as the ROW's author, not the editor's; **forget** = `superseded_by = id`; **delete_chunk** = tombstone), new Edge Function `memory` (`src/functions/memory/`, bundled, `[functions.memory]` in `config.toml`, same `CHAT_ALLOWED_ORIGIN`), `createMemoryPageDeps` in `wiring.ts` (deliberately **not** dependent on the Voyage key). Migration `20260827030000`: `memory_chunks.deleted_at` / `deleted_by`, `match_memory_chunks` + `deleted_at is null`, the self-reference convention documented. Browser: `Memory.tsx` / `MemoryFacts.tsx` / `MemoryChunks.tsx`, `memoryApi.ts`, `memoryView.ts`, memory live in the nav, “Open conversation” jumps to the Assistant; reads go straight to PostgREST under RLS, every change through the function. `web:check` also greps the Voyage key. Tests: unit (access 6, page 41 incl. the store over a stubbed PostgREST, web memory 27), security (`rls.test.ts` 8), integration (`memory-page.test.ts`, Part C 1–4 + 8), browser (`memory.spec.ts` 11 × 3 widths + screenshots in `docs/assets/stage-3/`). **Blocked in this session: `supabase db push` AND a rolled-back validation transaction were both refused by the tool permission layer — the migration is unvalidated live; CI's `db reset` from zero is the proof, then the reviewer applies it (RUNBOOK §1b)**
  - [x] 3.2.3a **(part 3 review, 27 Aug — done)** the cross-author duplicate-key gap is closed: migration `20260827040000` replaces the single `(user_id, scope, key)` index with **workspace unique by `key`** and **user unique by `(user_id, key)`**, reshapes `upsert_memory_fact`'s lock and lookup to match, and collapses any pre-existing live duplicates newest-wins (D54). Editing now upserts as the EDITOR, so the page and `audit_log` agree on who changed what. Also on the same review: `npm run web:build` forces `NODE_ENV=production` (`scripts/build-web.ts`) and `web:check` fails on a React development bundle (D55) — the live Vercel artefact was checked first and was already the production build. **Still open, part 4:** showing a note's author by NAME needs an `app_users` read policy wider than self-row-only, so the page says “you” or “a teammate” for now
  - [~] 3.2.4 **Part 4 (FND-330, 28 Aug, staged not committed) — the Team page and conversation management.** `src/lib/auth/access.ts` (who may change a staff account: the ONE rule, imported by the admin Edge Function *and* the browser — only an admin; never yourself for deactivate or demote; never the last administrator; never promote or reset someone deactivated), `src/lib/auth/admin.ts` gains `reactivateStaffUser` / `setStaffAdmin` / `listStaffUsers` and a `StaffRef` (the CLI names people by email, the page by id), `src/lib/auth/page.ts` (`handleUsersRequest` — create · deactivate · reactivate · promote · demote · reset_password · sign_ins), new Edge Function `admin` (`src/functions/admin/`, bundled, `[functions.admin]` in `config.toml`, same `CHAT_ALLOWED_ORIGIN`, `cache-control: no-store`), `createUsersPageDeps` in `wiring.ts` (deliberately **no** Anthropic and **no** Voyage — managing people must work on a degraded day). `src/lib/memory/page.ts` gains `rename_conversation` (a correction, open to everyone allowlisted) and `delete_conversation` (a removal, the author's or an admin's, through one database transaction). Migration `20260828010000`: the roster read policy + `is_active_staff()` (D56), `delete_conversation` (D59), `set_staff_active` / `set_staff_admin` under a shared advisory lock (D58). Browser: `Users.tsx`, `usersApi.ts`, `usersView.ts`, `conversationsView.ts`, Team in the nav, rename/delete from the list and the thread, a filter past ten conversations. CLI gains `reactivate` / `promote` / `demote` and stays the break-glass path. Tests: unit (access 11, users page 16, admin 29, web users 22, web conversations 12, memory page 55), security (`rls.test.ts` 9 + 10), integration (`users.test.ts`, `conversations.test.ts`), browser (`users.spec.ts` 9 × 3 + `conversations.spec.ts` 10 × 3, screenshots in `docs/assets/stage-3/`). **Not verified here: the stack suites and `db reset` from zero (no Docker on this machine) — CI; the migration is unapplied and unvalidated live, the reviewer applies it (RUNBOOK §1c)**
  - [x] 3.11a **Users section in the dashboard — done as part of 3.2.4** (28 Aug). Built as specified with two deliberate departures, both recorded: the page is **visible to everyone** in a read-only form rather than admin-only (D56 — a shared brain with a hidden membership list sends the client to the developer to ask who wrote a note), and **there is no invite email** (D57 — no sender is configured and adding one is a scope decision; the password is shown once on screen and handed over out of band, exactly as the CLI does it). "Forgot password" on the login page still needs SMTP from the client's domain and is **not built** — R26, ask Ross
  - [~] 3.2.5 **Part 5 (FND-340, 29 Aug) — private conversations, then Stage 3 acceptance.** Closes **R27** with the client's own answer (D62, option 2): a conversation can be the author's alone, its messages go with it, and what the assistant LEARNS still reaches the whole team. `src/lib/memory/privacy.ts` — the rules and the words, imported by the Edge Function *and* the browser (the `access.ts` pattern): `canSetConversationPrivacy` (**the author's alone — deliberately NOT an admin's**, D63), `SHARED_MEMORY_SCOPE`, and `PRIVACY_EXPLANATION`, the sentence a person reads before the tap. Migration `20260829010000`: `sync_chunk_ownership` splits the chunk off `sync_child_ownership` and forces `scope = 'workspace'`, the cascade stops carrying scope to chunks, and `memory_chunks_scope_workspace` refuses anything else (D64). **No policy is added, dropped or widened** — an administrator reads a private conversation through an audited server path (`admin_list_private`, metadata only, plus `admin_read_conversation`, which writes `CONVERSATION_ADMIN_READ` *before* it returns a message), because Postgres has no SELECT trigger and an RLS bypass could never be recorded (D65). `page.ts` gains three actions; `chat.ts` and `trigger.ts` now write what the assistant learns at `SHARED_MEMORY_SCOPE` rather than at the conversation's scope (D66). Browser: the toggle in the list row and the thread bar, a private badge, the admin section, and the Memory page naming a note's private source as private rather than removed. Tests: unit (privacy 22, memory page +21, web conversations +9, web memory +3), security (`rls.test.ts` 4b/5 rewritten, 11 and 12 added), integration (`privacy.test.ts`, `schema.test.ts` +1), browser (`privacy.spec.ts` 10 × 3). **CI run 33261767108 green: unit 1199, integration 75 (privacy 12/12), security 37, browser 177, `db reset` from zero with 16 migrations, zero skipped. Migration APPLIED live via `db push`; an object-level live inspection and a live functional pass are still outstanding (no Docker, Supabase MCP down) — they belong with the acceptance run**
  - [ ] 3.2.5b Part 5 acceptance — the twelve Stage 2 criteria re-run, the Stage 3 criteria, the real per-turn cost, the recall rate, and the client sign-off material
- [ ] 3.3 *(was 4.14–4.15)* Memory continuity test across sessions **and devices**; token-budget test
- [ ] 3.4 *(was 4.5–4.9)* Tool registry: whitelisted, typed, read/write flag; **two-turn confirmation on writes** (D9); every execution → `audit_log`; confirmation-flow test. Tools revised for Scope v3 — no `run_research_batch`
- [ ] 3.5 Dashboard (D29): conversations, cost rollup, review queue, tasks — mobile-first, 375 / 768 / 1280
- [ ] 3.6 *(was 1.24–1.31)* n8n on Railway with **Postgres backing**, `N8N_ENCRYPTION_KEY` backed up, basic auth, timezone `Australia/Perth`; `src/lib/webhookAuth.ts` HMAC + timestamp with tests; global error workflow → `workflow_runs` + alert to `rossb@fundd.com.au`; `npm run n8n:export` / `n8n:validate`
- [ ] 3.7 *(was 1.32, 1.36)* `src/lib/crm/ghl/client.ts` — read-only to start; contract tests on fixtures; every object matched on **ID, never name**; nothing account-wide (R22, R25)
- [x] 3.8 *(was 1.37)* Via Notion MCP: parent page "Encharge Command Centre" + eight databases — **done 10 Aug** (parent page by hand; MCP has no teamspace-root parent). Notion is an internal working surface under D29
- [x] 3.9 *(was 1.38)* Properties and relations per `PLAN.md` §7; editable vs read-only per CLIENT-CONTEXT §8 — **done 10 Aug**; enforced by the sync whitelist (D22), not by Notion
- [ ] 3.10 *(was 1.39–1.42)* Notion client, views via `create_view`, phone pass, contract tests — **only if Stage 3 decides Notion is still worth wiring at runtime** (R9 — no workspace token for n8n yet)
- [ ] 3.11 *(was 4.16)* Pipeline metrics reconcile against GoHighLevel, not our own count (CLIENT-CONTEXT §11)
- [x] 3.11a **Users section in the dashboard** (added 26 Aug on FND-250 review — Ross must not need a script to add a user). **Done 28 Aug inside 3.2.4** — see that entry for what was built and the two departures from this description (the page is readable by everyone, not admin-only; no invite email). Acceptance met: a non-admin sees no controls and the server refuses all seven actions (`tests/unit/auth/page.test.ts`, `tests/integration/users.test.ts`, `tests/e2e/users.spec.ts`); every action lands in `audit_log` under the acting admin; the CLI keeps working and gained `reactivate` / `promote` / `demote`. **Still open:** "Forgot password" on the login page via Supabase's email reset — needs SMTP from the client's domain (R26)
- [ ] 3.12 `npm run test:regress` green · client demo + sign-off → **PAYMENT 3 (198)**

---

## STAGE 4 — Website reading and storage

*Outline — detailed at Stage 4 kickoff. Criteria: `PHASE-ACCEPTANCE.md` Stage 4.*

- [ ] 4.1 Migrations for the knowledge store (`web_sources`, `web_facts` — SCHEMA §2a), every field with `source_url · fetched_at · extraction_method · confidence` NOT NULL
- [ ] 4.2 *(was 2.7–2.11)* `src/lib/crawler/` — `urlSafety` (every SSRF case in SECURITY §10), `robots`, `fetch` (rate limit, size cap, timeout, redirect limit, re-check IP after redirect), `sanitize`, `extract` — all with tests
- [ ] 4.3 *(was 2.15)* Reading prompt with the untrusted-content wrapper (SECURITY §3), **zero tools**; null-not-guess rule stated explicitly
- [ ] 4.4 *(was 2.16–2.17)* Storage: raw HTML → Storage bucket, cleaned text → `web_sources`; `content_hash` skip; raw purged after 90 days (SECURITY §11)
- [ ] 4.5 *(was 2.20)* `tests/security/injection.test.ts` — ≥ 10 adversarial pages, zero violations
- [ ] 4.6 Below-threshold facts → `review_queue` (`entity_type = 'web_fact'`); approve writes through with an audited override
- [ ] 4.7 Idempotency test: read the same page twice → identical row counts
- [ ] 4.8 `npm run test:regress` green · client demo + sign-off → **PAYMENT 4 (198)**

---

## STAGE 5 — Content, carousels, ad copy

*Outline — detailed at Stage 5 kickoff. Criteria: `PHASE-ACCEPTANCE.md` Stage 5.*

- [ ] 5.1 *(was 4.10)* Generation grounded in CLIENT-CONTEXT §9 frameworks: social post, carousel (slide-by-slide copy), Meta ad, Google ad — each a typed schema
- [ ] 5.2 Voice-conformance suite (Stage 2 part 5) extended per format; 100% pass on recorded fixtures
- [ ] 5.3 Drafts stored with check results and approval state; nothing published unreviewed (`review_queue`, `entity_type = 'content_draft'`)
- [ ] 5.4 Decide and record where approved drafts go (GHL social planner is connected — MEMORY 12 Aug; Meta ads account access granted 22 Aug) — **no publishing without a dated decision**
- [ ] 5.5 Dashboard surfaces for drafts and approvals, mobile-first
- [ ] 5.6 `npm run test:regress` green · client demo

---

## STAGE 6 — Monitoring, testing, docs, handover

*Criteria: `PHASE-ACCEPTANCE.md` Stage 6. Paid with Stage 5 in the final 528.*

- [ ] 6.1 *(was 5.10)* Monitoring workflow — daily health check, cost rollup, stale-data and token-expiry alerts; verified by a real failure and a real cap trip
- [ ] 6.2 *(was 5.11)* `docs/RUNBOOK.md` completed and walked through end to end
- [ ] 6.3 *(was 5.12)* Security checklist SECURITY.md §13 — every box ticked, **R18 closed in writing**
- [ ] 6.4 *(was 5.13)* Rotate all keys; transfer ownership of every account to the client; LastPass access revoked in writing
- [ ] 6.5 *(was 5.14)* Recorded walkthrough: daily use, review queue, chat, what to do when something breaks
- [ ] 6.6 *(was 5.15)* Final `npm run test:regress` + full manual QA (TESTING.md §9)
- [ ] 6.7 Client sign-off → **FINAL PAYMENT (528)**

---

## Blocked / parked

| Item | Reason | Since | Unblocked by |
|---|---|---|---|
| ~~P0.10 database platform~~ | ~~Supabase paused, MongoDB org appeared, intent unconfirmed~~ | 09 Aug | **Closed 22 Aug — Supabase (D24)** |
| R9 Notion workspace token for n8n | Developer is a member, not admin | 09 Aug | Ross — only needed if n8n writes to Notion at runtime (Stage 3, optional) |
| R18 prototype's published Anthropic key | Rotation unconfirmed | 11 Aug | Ross — **urgent, independent of every task** |
| R21 three GHL scopes | Recorded denied 12 Aug; token now carries the write scopes — reconcile | 12 Aug | Next GHL probe, or Ross |
| R24 `finance-option.com.au` → Refi Pixel | Origin unknown | 22 Aug | Ross |
| **R26 an email sender for staff invites and "forgot password"** | No SMTP is configured on the project, so an admin hands a generated password over by hand — fine for one person, awkward for the 35 the client has described (D57). A sender from a domain he controls would let Supabase send both the invite and a self-service reset | 28 Aug | Ross — a scope conversation, not a code change |

| ~~**R27 should a conversation be able to be private?**~~ | ~~Nothing in the UI could set `conversations.scope`, so every conversation anyone started was readable by the whole team~~ | 28 Aug | **CLOSED 29 Aug — the client answered, and chose option 2 (D62).** *"Each person's chats are their own. Nobody sees anyone else's. You, as the owner, can see everybody's. What the assistant learns still goes into the one shared brain."* Built in Stage 3 part 5 (3.2.5). **Note the correction to the recommendation on file:** it assumed a private conversation would stop contributing to shared recall. He chose the opposite, and that is what shipped — the messages go private, the chunk and any standing note stay workspace |

*Anything sitting here more than 3 days goes into a client message, not silence.*

---

## PARKED / SUPERSEDED — the original five-phase checklist (09 Aug 2026)

**Frozen. Do not work from this list.** Kept verbatim because it is the record of what was
planned and because the research-engine tasks (Phase 2 discovery, Phase 3 contacts /
verification / rubrics / Sheets, Phase 5 social insights) are **parked, not deleted** (D23,
R3) — the designs remain correct if that work ever returns. Live tasks that were carried
forward are listed above with their old ID in brackets; the checkboxes below are not
maintained. `[x]` items below (P0.*, 1.37, 1.38) are genuinely done and are also recorded
above.

### PHASE 0 — Pre-build ✅ COMPLETE *(frozen)*

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

### PHASE 1 — Foundation *(frozen)*

#### 1A. Repository and tooling
- [ ] 1.1 Init repo, Node 20, TypeScript strict, ESLint, Prettier, Vitest
- [ ] 1.2 `.gitignore`, verify `.env` is ignored, `gitleaks` pre-commit hook
- [ ] 1.3 `src/lib/logger.ts` — structured logger with key-based secret redaction
- [ ] 1.4 `src/lib/errors.ts` — typed error classes, no thrown strings
- [ ] 1.5 `src/lib/http.ts` — fetch wrapper: timeout, retry+backoff+jitter, circuit breaker
- [ ] 1.6 Unit tests for 1.3–1.5 (redaction incl. nested, retry counts, breaker opens/closes)
- [ ] 1.7 GitHub Actions CI per `docs/TESTING.md` §8

#### 1B. Database
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

#### 1C. n8n on Railway
- [ ] 1.24 Deploy n8n on Railway with **Postgres backing** (not SQLite)
- [ ] 1.25 Set `N8N_ENCRYPTION_KEY`, basic auth, webhook URL, timezone `Australia/Perth`
- [ ] 1.26 Back up the encryption key somewhere the client controls
- [ ] 1.27 Create credentials: database, Anthropic, Notion, GoHighLevel, Serper, Google
- [ ] 1.28 `src/lib/webhookAuth.ts` — HMAC signature + timestamp verification
- [ ] 1.29 Unit tests: valid sig, bad sig, replayed timestamp, missing header
- [ ] 1.30 Global error workflow → writes `workflow_runs` + alerts Ross@enchargecapital.com
- [ ] 1.31 `npm run n8n:export` / `npm run n8n:validate` scripts

#### 1D. GoHighLevel
- [ ] 1.32 `src/lib/crm/ghl/client.ts` — auth with Private Integration token, rate-limit handling
- [ ] 1.33 Read the account's existing custom fields via API; populate `ghl_field_map`
- [ ] 1.34 Create any missing custom fields (`encharge_org_id`, `lead_type`, `ai_score`, `ai_tier`, `ai_reasoning`, `email_status`, `email_is_inferred`, `source_url`)
- [ ] 1.35 Confirm with Ross which pipeline receives leads, and map the nine stages to GHL stages
- [ ] 1.36 Contract tests against recorded GHL fixtures

#### 1E. Notion
- [x] 1.37 Via Notion MCP: create parent page "Encharge Command Centre", then databases — Intake, Organisations, Contacts, Consumer Leads, Review Queue, Tasks, Social Dashboard, Ops Chat Log
      *Parent page created by hand in the UI — the MCP has no teamspace-root parent type. All eight databases created via MCP. See MEMORY.md 2026-08-10.*
- [x] 1.38 Properties and relations per `docs/PLAN.md` §7; editable vs read-only per CLIENT-CONTEXT §8
      *Done in the same session as 1.37. Notion cannot lock properties — the split is carried by property descriptions and enforced by the sync whitelist.*
- [ ] 1.39 `src/lib/notion/client.ts` — typed wrapper, rate-limit handling (3 req/s)
- [ ] 1.40 Create views via the Notion MCP (`create_view`). Board/gallery, 3–4 visible properties, mobile-first. Buttons still added by hand in the UI
- [ ] 1.41 Open every view on a phone and fix anything that scrolls sideways
- [ ] 1.42 Unit + contract tests against recorded Notion fixtures

#### 1F. Phase 1 gate
- [ ] 1.43 **W0 health check:** Notion button → n8n webhook (HMAC verified) → DB write → Notion update, round trip
- [ ] 1.44 Cost tracking wired: a test Claude call lands in `api_usage`
- [ ] 1.45 Spend cap enforced **before** the call, not just monitored — test by tripping it
- [ ] 1.46 Alerting verified by deliberately failing a workflow
- [ ] 1.47 `npm run test:regress` green
- [ ] 1.48 Client demo + sign-off → **PAYMENT 1**

---

### PHASE 2 — Discovery and web data pulling *(frozen)*

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

### PHASE 3 — Contacts, verification, ranking, CRM push *(frozen)*

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

### PHASE 4 — Claude ops layer with memory *(frozen)*

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

### PHASE 5 — Social tracking, polish, handover *(frozen)*

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

### Blocked / parked *(frozen)*

| Item | Reason | Since | Unblocked by |
|---|---|---|---|
| P0.10 database platform | Supabase paused, MongoDB org appeared, intent unconfirmed | 09 Aug | Ross |

| ~~**R27 should a conversation be able to be private?**~~ | ~~Nothing in the UI could set `conversations.scope`, so every conversation anyone started was readable by the whole team~~ | 28 Aug | **CLOSED 29 Aug — the client answered, and chose option 2 (D62).** *"Each person's chats are their own. Nobody sees anyone else's. You, as the owner, can see everybody's. What the assistant learns still goes into the one shared brain."* Built in Stage 3 part 5 (3.2.5). **Note the correction to the recommendation on file:** it assumed a private conversation would stop contributing to shared recall. He chose the opposite, and that is what shipped — the messages go private, the chunk and any standing note stay workspace |

*Anything sitting here more than 3 days goes into a client message, not silence.*
