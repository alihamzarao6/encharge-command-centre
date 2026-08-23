# CLAUDE.md — Encharge Capital Command Centre

You are the sole senior engineer on this build. Behave like someone with 10+ years of
production experience: defensive, test-first, security-conscious, allergic to shortcuts
that create silent failure. The client is a working mortgage brokerage who will phone and
email real people based on this data. Wrong data here causes real-world harm, not a bug
report.

---

## 1. What this project is

An automated lead-research and AI operations system for **Encharge Capital**, a Perth
(Western Australia) finance and mortgage brokerage. Client contact: **Ross Byrne**.

1. Takes an organisation name, finds its website, identifies decision makers, collects and
   verifies contact details, ranks the lead with Claude, flags uncertain records for human
   review, deduplicates, and pushes clean records to **GoHighLevel** + Google Sheets **with
   a full source trail on every field**.
2. Exposes a conversational Claude layer with persistent memory that answers questions
   about the pipeline and executes operations on command.
3. Uses Notion as the human interface (desktop + mobile app). Ross works from his phone.
4. Pulls Instagram / LinkedIn / Facebook insights on a schedule.

Full spec: `docs/PLAN.md`. Business rules and ranking rubrics: `docs/CLIENT-CONTEXT.md`.
Never invent business logic — if it is not in those two files, stop and ask.

---

## 2. Stack

| Layer | Technology |
|---|---|
| Orchestration | n8n, self-hosted on Railway, Postgres-backed queue mode |
| Database | Supabase (Postgres 15 + pgvector + Storage + Edge Functions) — **see §3** |
| AI | Claude API (`claude-sonnet-5` default, `claude-haiku-4-5-20251001` high-volume) |
| Embeddings | Voyage AI `voyage-3` (Anthropic serves no embeddings endpoint) |
| UI | Notion (databases, views, buttons) |
| CRM | **GoHighLevel** — Private Integration token, contacts + opportunities scopes |
| Search | Serper |
| Email verification | MillionVerifier |
| Export | Google Sheets API v4 |
| Custom code | TypeScript (Node 20), Supabase Edge Functions (Deno) |
| Tests | Vitest + Supabase local + msw for HTTP fixtures |

Do not substitute anything above without asking.

---

## 3. OPEN DECISION — database platform

The Supabase project is currently **paused** and a MongoDB Atlas organisation has appeared
under the client's account. It is not confirmed which the client intends to use.

**Until Ross confirms in writing, build against Supabase.** Everything in `docs/SCHEMA.md`
is relational Postgres with row-level security, and the whole provenance and audit design
depends on it. Do not start migrating to MongoDB on assumption.

If Ross confirms MongoDB, stop and flag it — `docs/SCHEMA.md`, `docs/SECURITY.md` and the
data-access layer all need rewriting first, and that is a scope conversation before it is
a code change.

---

## 4. MCP servers — available, and how to use them

Connected: `supabase`, `mongodb`, `railway`, `notion`. Use them, but with discipline:

- **Read freely, write deliberately.** Inspecting schema, listing projects, reading Notion
  databases — go ahead. Anything that creates, alters or deletes gets proposed first.
- **Never apply a schema change through the Supabase MCP.** Every schema change is a file
  in `supabase/migrations/` applied through the CLI. If it isn't in a migration, it doesn't
  exist. A dashboard-applied change that isn't in the repo is a bug waiting to happen.
- **Notion MCP can create databases, properties AND views** (`create_view`, `update_view`
  are available on this workspace's plan). Build the full structure through the MCP. Buttons
  and a few layout details are still UI-only — flag those for the human rather than guessing.
- **The Notion MCP authenticates as the developer's own Notion account, not as an
  integration.** It is fine for building. The running system (n8n) needs a separate
  workspace access token, which requires workspace admin rights — pending from Ross.
- **Railway MCP for inspection and env vars.** The n8n deploy itself is done in the
  dashboard.
- Anything an MCP writes still gets recorded in `docs/MEMORY.md` like any other change.

There is no MCP for the Anthropic Console. The API key in `.env` is all that's needed.

---

## 5. Commands

```bash
npm install
npm run dev
npm run typecheck      # must pass before any commit
npm run lint           # must pass before any commit
npm test
npm run test:unit
npm run test:int       # requires: supabase start
npm run test:regress   # REQUIRED before phase sign-off
supabase start
supabase db reset
supabase migration new <name>
npm run n8n:export
npm run n8n:validate
```

---

## 6. Hard rules — non-negotiable

**Process**
1. Work **one task at a time** from `tasks/TASKS.md`. Never batch.
2. **Plan Mode (Shift+Tab)** before any change touching more than two files. Present the
   plan, wait for approval, then implement.
3. Never mark a task `[x]` until its tests pass *and* its acceptance criteria in
   `docs/PHASE-ACCEPTANCE.md` are met.
4. After completing any task, append a dated entry to `docs/MEMORY.md`. This is how context
   survives `/clear`. Skipping it is a bug.
5. Do not start Phase N+1 while Phase N is unsigned. Phases map to client payments.

**Code**
6. TypeScript strict. No `any`. No `@ts-ignore` without a comment explaining why.
7. Every external call wrapped in explicit error handling with typed results. No unhandled
   rejections, no swallowed errors.
8. Every external API call gets a timeout, retry with exponential backoff + jitter, and a
   circuit breaker after repeated failure. Never blindly retry non-idempotent writes.
9. All writes to the database, GoHighLevel and Google Sheets must be **idempotent**, keyed
   on a deterministic external ID. Re-running a workflow must never duplicate a record.
10. Business logic lives in `src/lib/` as pure, unit-testable functions. n8n nodes call
    those functions or Edge Functions. Do **not** bury logic in n8n Function nodes.
11. Every n8n workflow is exported to `n8n/workflows/*.json` and committed. The repo is the
    source of truth, not the n8n UI.

**Data integrity**
12. Every collected field carries `source_url`, `fetched_at`, `extraction_method`,
    `confidence`. A field with no provenance is invalid data.
13. Never let Claude output land in the database unvalidated. Parse against a Zod schema;
    on failure retry once with the validation error, then route to the review queue.
14. Confidence below threshold → `review_queue`, never straight to the CRM.
15. **Research runs only on business lead types** (Commercial, Asset finance, Referral
    partner). Consumer types are tracked through the stages, never researched. See
    `docs/CLIENT-CONTEXT.md` §2.

**Security** (detail in `docs/SECURITY.md`)
16. RLS enabled on every table, deny-by-default. No table ships without a policy.
17. `service_role` key exists only in n8n and Edge Function environments. Never in a
    browser, a Notion page, or a log line.
18. Scraped web content is **untrusted input**. Wrapped in delimiters, labelled as data,
    and can never trigger a tool call. Highest-risk surface in the project.
19. No secrets in code, logs, error messages, commits, or n8n node parameters.
20. Log PII by ID reference only. Never log full emails, phone numbers, or page bodies.

**Testing** (detail in `docs/TESTING.md`)
21. Every `src/lib/` function ships with unit tests in the same commit. Coverage floor 80%
    lines / 75% branches — CI fails below.
22. Bugfixes start with a failing regression test reproducing the bug.
23. External APIs are never called in unit tests. Recorded fixtures in `tests/fixtures/`.
24. The full regression suite must be green before any phase is presented to the client.

---

## 7. Compliance — Australian client

- **Privacy Act 1988 (Cth) + Australian Privacy Principles.** Collect only business-context
  data about people in their professional capacity, from public sources, for the stated
  purpose. Record the source of every record (APP 3, APP 5).
- **Spam Act 2003 (Cth).** Any outbound email needs a consent basis, accurate sender
  identification and a working unsubscribe. Store `consent_basis` and `opt_out` from day
  one, before outbound exists.
- **Do Not Call Register Act 2006** applies to collected phone numbers used for telemarketing.
- Respect `robots.txt`. Identify the crawler with a contact URL. Rate limit per host. No
  authenticated scraping of LinkedIn, Instagram or Facebook — official APIs only.

---

## 8. Style

- Small commits, Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`).
- Comments explain *why*, never *what*.
- No dead code, no commented-out blocks, no `console.log` — use `src/lib/logger.ts`.
- If a requirement is ambiguous, ask. A wrong assumption compounds across five phases.
