# Encharge Capital Command Centre

An AI assistant for Encharge Capital (Perth, WA — rebranding to **Fundd**, `fundd.com.au`):
trained on the client's voice, with persistent memory that follows him across devices; reads
websites and stores what it finds with a full source trail; generates social posts, carousels
and ad copy in that voice; sits on a dashboard with GoHighLevel and Meta set up underneath.
Built on Supabase, the Claude API, n8n on Railway, GoHighLevel and Meta.

**Docs version 3.0** — aligned to **Scope v3 (22 Aug 2026)**, `docs/MEMORY.md` D23–D32. Six
delivery stages; Stage 1 (GoHighLevel + Meta) is complete, signed off and paid. The B2B
outbound lead-research engine described by docs v2.0 was never asked for and is **out of
scope** — parked under "out of current scope" headings, not deleted. The repo name keeps the
pre-rebrand business name.

---

## Documentation map — read in this order

| File | What it is | When |
|---|---|---|
| `CLAUDE.md` | Operating rules. Stack, commands, hard rules, MCP discipline | **Every session, first** |
| `docs/MEMORY.md` | Working memory, decisions D1–D32, current state, open risks | **Every session, second** |
| `tasks/TASKS.md` | The build checklist — six stages, Stage 2 in seven parts. One item at a time | Every session, to pick the next task |
| `docs/CLIENT-CONTEXT.md` | The client's business (§1), pipeline (§3), copy frameworks (§9), avatar (§10), operational rules (§11). Research rubrics parked in §5–§7 | Before writing any prompt — **the voice layer is built from §1, §9–§11** |
| `docs/SCHEMA.md` | Data model, memory-layer ownership (`user_id` + `scope`), RLS pattern, migration discipline. Research tables parked | Stage 2 part 2, and any schema change |
| `docs/SECURITY.md` | Threat model (T1–T11) and non-negotiable requirements, incl. prompt injection and the server-side-only Anthropic key rule | Stage 2, then before each stage gate |
| `docs/TESTING.md` | Test strategy, coverage gates, regression discipline | Before the first test |
| `docs/PHASE-ACCEPTANCE.md` | What "done" means per **stage** — client-facing; Stage 2's definition of done is here | Before each demo |
| `docs/RUNBOOK.md` | Operations and handover procedures | Stage 6, filled in as you build |
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
│   └── functions/            # Edge Functions
├── tests/
│   ├── unit/  integration/  workflows/  security/
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

> Read CLAUDE.md, docs/MEMORY.md (especially D23–D32 and the 22–23 Aug entries) and
> tasks/TASKS.md before doing anything. Then tell me the current state of the project and
> which single task is next. Do not start work until I confirm.

Every session after:

> Read CLAUDE.md and docs/MEMORY.md. What's next in tasks/TASKS.md?

**Session discipline**
1. One task per session. `/clear` between tasks.
2. Plan Mode (Shift+Tab) before anything touching 3+ files. Approve the plan, then build.
3. Tests pass → mark the task `[x]` → append to `docs/MEMORY.md` → `/clear`.
4. Never start Stage N+1 while Stage N is unsigned. Stages map to payments (D27).

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
```

---

## Delivery

Six stages (D26): **1** GoHighLevel + Meta — complete, signed off, paid · **2** Foundations +
AI trained on the client's voice · **3** Memory + dashboard · **4** Website reading and
storage · **5** Content, carousels, ad copy · **6** Monitoring, testing, docs, handover.
198 on sign-off of each of stages 1–4, 528 at the end (1320 total, D27). Acceptance criteria
per stage in `docs/PHASE-ACCEPTANCE.md`. The B2B lead-research engine, outbound email, social
insights tracking and the other items listed there under "What is not in any stage" are out
of scope and priced separately.
