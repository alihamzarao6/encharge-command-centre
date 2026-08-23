# Encharge Capital Command Centre

Automated lead research, AI operations layer, and social insight tracking for Encharge
Capital (Perth, WA). Built on n8n, Supabase, Notion, GoHighLevel and the Claude API.

**Docs version 2.0** — revised 09 Aug 2026 after client confirmations. See
`docs/MEMORY.md` §2 for what changed and why.

---

## Documentation map — read in this order

| File | What it is | When |
|---|---|---|
| `CLAUDE.md` | Operating rules. Stack, commands, hard rules, MCP discipline | **Every session, first** |
| `docs/MEMORY.md` | Working memory, decisions, current state, open risks | **Every session, second** |
| `tasks/TASKS.md` | The build checklist. One item at a time | Every session, to pick the next task |
| `docs/PLAN.md` | Full technical specification and architecture | Before starting a new phase |
| `docs/CLIENT-CONTEXT.md` | The client's business, lead types, both rubrics, copy frameworks | Before writing any prompt |
| `docs/SCHEMA.md` | Complete data model and RLS pattern | Phase 1, and any schema change |
| `docs/SECURITY.md` | Threat model and non-negotiable requirements | Phase 1, then before each phase gate |
| `docs/TESTING.md` | Test strategy, coverage gates, regression discipline | Before the first test |
| `docs/PHASE-ACCEPTANCE.md` | What "done" means per phase — client-facing | Before each demo |
| `docs/RUNBOOK.md` | Operations and handover procedures | Phase 5, filled in as you build |

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
│   ├── migrations/           # every schema change, replayable from zero
│   └── seed.sql              # rubrics, blocklists, test data
├── n8n/workflows/            # exported workflow JSON — the repo is the source of truth
├── src/
│   ├── lib/                  # all business logic, pure and unit-tested
│   └── functions/            # Edge Functions
├── tests/
│   ├── unit/  integration/  workflows/  security/
│   └── fixtures/             # recorded API responses, golden set, adversarial pages
└── scripts/                  # replay, migration helpers, deletion requests
```

---

## Getting started with Claude Code

```bash
cd encharge-command-centre
claude
```

First session:

> Read CLAUDE.md, docs/MEMORY.md, docs/PLAN.md and tasks/TASKS.md before doing anything.
> Then tell me the current state of the project and which single task is next. Do not start
> work until I confirm.

Every session after:

> Read CLAUDE.md and docs/MEMORY.md. What's next in tasks/TASKS.md?

**Session discipline**
1. One task per session. `/clear` between tasks.
2. Plan Mode (Shift+Tab) before anything touching 3+ files. Approve the plan, then build.
3. Tests pass → mark the task `[x]` → append to `docs/MEMORY.md` → `/clear`.
4. Never start Phase N+1 while Phase N is unsigned. Phases map to payments.

The most common failure with Claude Code on a project this size is asking for too much at
once. Two hours on one well-tested task beats four hours on six broken ones.

---

## MCP servers

`supabase`, `mongodb`, `railway` and `notion` are connected. Read freely, write deliberately.
Never apply a database schema change through an MCP — every change is a migration file. The
Notion MCP can create databases, properties and views. See `CLAUDE.md` §4.

---

## Current blocker

The database platform is unconfirmed — the Supabase project is paused and a MongoDB Atlas
organisation has appeared. Build against Supabase until Ross confirms otherwise. See
`CLAUDE.md` §3 and `docs/MEMORY.md` R1.

---

## Local development

```bash
npm install
supabase start            # local Postgres + Studio
supabase db reset         # rebuild schema + seed from zero
npm test
npm run test:regress      # required before any phase sign-off
```

---

## Delivery

Five phases, each ending in a client demo and payment. Acceptance criteria per phase in
`docs/PHASE-ACCEPTANCE.md`. Anything not listed in `docs/PLAN.md` §10 is out of scope and
priced separately.
