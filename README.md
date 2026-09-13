# Encharge Capital Command Centre

An AI assistant for Encharge Capital (Perth, WA — rebranding to **Fundd**, `fundd.com.au`):
trained on the client's voice, with persistent memory that follows him across devices; reads
websites and stores what it finds with a full source trail; generates social posts, carousels
and ad copy in that voice; sits on a dashboard with GoHighLevel and Meta set up underneath.
Built on Supabase, the Claude API, n8n on Railway, GoHighLevel and Meta.

**Docs version 3.0** — aligned to **Scope v3 (22 Aug 2026)**, `docs/MEMORY.md` D23–D32, for
what is built, and to the **eight-milestone delivery plan agreed 1 Sep 2026 (D77)**.
Milestones 1–3 (CRM and ad tracking; foundations and the client's writing voice; memory and
the app itself) are complete, signed off and paid; Milestone 4 (Your data on screen) is next.
The six-stage map of 22 Aug is superseded. The B2B
outbound lead-research engine described by docs v2.0 was never asked for and is **out of
scope** — parked under "out of current scope" headings, not deleted. The repo name keeps the
pre-rebrand business name.

---

## Documentation map — read in this order

| File | What it is | When |
|---|---|---|
| `CLAUDE.md` | Operating rules. Stack, commands, hard rules, MCP discipline | **Every session, first** |
| `docs/MEMORY.md` | Working memory, decisions D1–D82, current state, open risks | **Every session, second** |
| `tasks/TASKS.md` | The build checklist — eight milestones, Milestone 4 next in five parts. One item at a time | Every session, to pick the next task |
| `docs/CLIENT-CONTEXT.md` | The client's business (§1), pipeline (§3), copy frameworks (§9), avatar (§10), operational rules (§11). Research rubrics parked in §5–§7 | Before writing any prompt — **the voice layer is built from §1, §9–§11** |
| `docs/SCHEMA.md` | Data model, memory-layer ownership (`user_id` + `scope`), RLS pattern, migration discipline. Research tables parked | Stage 2 part 2, and any schema change |
| `docs/SECURITY.md` | Threat model (T1–T11) and non-negotiable requirements, incl. prompt injection and the server-side-only Anthropic key rule | Stage 2, then before each stage gate |
| `docs/TESTING.md` | Test strategy, coverage gates, regression discipline | Before the first test |
| `docs/PHASE-ACCEPTANCE.md` | What "done" means per **milestone** — client-facing; Milestone 4's definition of done is here | Before each demo |
| `docs/RUNBOOK.md` | Operations and handover procedures | Milestone 8, filled in as you build |
| `docs/PLAN.md` | Technical specification **as written for the superseded five-phase plan** (v2.0, 09 Aug). Architecture and memory-tier design still useful; where it conflicts with Scope v3, `MEMORY.md` D23–D32 win | Reference only |
| `docs/GHL-AUDIT.md`, `docs/EXISTING-PROTOTYPE.md` | Dated investigations — the GHL account inventory (12 Aug) and the client's previous prototype assessment (11 Aug, incl. R18) | When touching GHL or the chat UI |

---

## Repository layout

```
.
├── CLAUDE.md                 # operating rules — Claude Code reads this automatically
├── README.md
├── .env                      # real credentials, gitignored
├── .env.example              # sanitised template
├── docs/                     # specification, context, security, testing, runbook
├── tasks/TASKS.md            # the build checklist
├── supabase/
│   ├── migrations/           # every schema change, replayable from zero (Stage 2 part 2)
│   └── seed.sql              # app_users, GHL stage/field map
├── n8n/workflows/            # exported workflow JSON — the repo is the source of truth (Stage 3)
├── src/
│   ├── lib/                  # all business logic, pure and unit-tested (logger, errors, http …)
│   └── functions/            # Edge Function sources (bundled by `npm run functions:bundle`)
├── web/                      # the dashboard — Vite + React, static output in web/dist (Stage 2 part 6)
├── tests/
│   ├── unit/  integration/  workflows/  security/  e2e/ (browser, scripted Supabase)
│   └── fixtures/             # recorded API responses, voice fixtures, adversarial pages
├── scripts/                  # replay, migration helpers, deletion requests
├── .githooks/pre-commit      # gitleaks secret scan — fail-closed
└── .github/workflows/ci.yml  # typecheck · lint · gitleaks · tests + coverage gate
```

---

## Getting started with Claude Code

```bash
cd encharge-command-centre
claude
```

First session:

> Read CLAUDE.md, docs/MEMORY.md (especially D23–D32, D77–D82 and the 22–23 Aug entries) and
> tasks/TASKS.md before doing anything. Then tell me the current state of the project and
> which single task is next. Do not start work until I confirm.

Every session after:

> Read CLAUDE.md and docs/MEMORY.md. What's next in tasks/TASKS.md?

**Session discipline**
1. One task per session. `/clear` between tasks.
2. Plan Mode (Shift+Tab) before anything touching 3+ files. Approve the plan, then build.
3. Tests pass → mark the task `[x]` → append to `docs/MEMORY.md` → `/clear`.
4. Never start Milestone N+1 while Milestone N is unsigned. Milestones map to payments (D77).

The most common failure with Claude Code on a project this size is asking for too much at
once. Two hours on one well-tested task beats four hours on six broken ones.

---

## MCP servers

`supabase`, `mongodb`, `railway` and `notion` are connected. Read freely, write deliberately.
Never apply a database schema change through an MCP — every change is a migration file. The
Notion MCP can create databases, properties and views. The `mongodb` server is unused — the
database is Supabase (D24). See `CLAUDE.md` §4.

---

## Current state

**Database platform: Supabase, confirmed by the client 22 Aug 2026 (D24).** The earlier
"Supabase or MongoDB" blocker is closed; the project was paused only by the free tier's idle
auto-pause and is unpaused at Stage 2 part 2. Nothing structural is blocked. Open items that
do not block: R18 (the client's old prototype published an Anthropic key — rotation still
unconfirmed, chase it), R9 (no Notion workspace token for n8n), R21 (GHL scope
reconciliation). See `docs/MEMORY.md` §1 and §5.

---

## Local development

```bash
nvm use                   # Node 24 (.nvmrc, D35)
npm install
git config core.hooksPath .githooks   # enables the gitleaks pre-commit hook (needs gitleaks on PATH)
npm run typecheck && npm run lint && npm test
supabase start            # local Postgres + Studio (Stage 2 part 2 onwards)
supabase db reset         # rebuild schema + seed from zero
npm run test:regress      # required before any stage sign-off
npm run web:dev           # the dashboard at http://127.0.0.1:5173 (VITE_SUPABASE_* in .env)
npm run test:e2e          # browser suite in installed Chrome, no stack needed
```

---

## Delivery

Eight milestones, 2,000 USD total, agreed 1 Sep 2026 (D77; supersedes the six-stage map of
D26/D27): **1** CRM and ad tracking set up (200) · **2** Foundations and the client's writing
voice (200) · **3** Memory and the app itself (200) — **1–3 complete, signed off and paid, 600
received** · **4** Your data on screen (350) — next · **5** Files, documents and research (250)
· **6** Talking to it, and your day (350) · **7** Advertising and social (300) · **8** Content
and handover (150). Order as the client asked on 5 Sep (D79). Acceptance criteria per milestone
in `docs/PHASE-ACCEPTANCE.md`. A drag-and-drop dashboard builder, agent software that acts on
its own, the Quickli calculator and the separate finance CRM are out of scope and were stated
so in writing (D82); so are the B2B lead-research engine, outbound email, social insights
tracking and the other items listed there under "What is not in any stage".
