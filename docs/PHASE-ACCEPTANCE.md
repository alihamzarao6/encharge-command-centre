# PHASE-ACCEPTANCE.md — Sign-off Criteria

Internally this defines "done". Externally it defines what the client approves when they
release each payment. **It matches Scope v3 (22 Aug 2026, `docs/MEMORY.md` D23–D32): six
stages, 1320 total, 198 on sign-off of each of stages 1–4, 528 at the end (D27).** The
five-phase criteria from the 09 Aug 2026 scope document are superseded and kept verbatim at
the bottom of this file for the record.

A stage is complete when all criteria are demonstrated live, the regression suite is green,
and the client confirms in writing. "Demonstrated" means evidence — a test output, an HTTP
response, a row in a table, a screenshot of the phone — not a statement that it works.

The file keeps its name (`PHASE-ACCEPTANCE.md`) because `CLAUDE.md`, `TASKS.md` and the
MEMORY.md entries reference it by that name; "phase" in the filename means "stage".

---

## Stage 1 — GoHighLevel + Meta · Payment 1 of 5 (198) · ✅ COMPLETE, signed off and paid 22 Aug 2026

**Delivered, as actually built in the live account** (location `tgw5Q3BnoZoSsVOnRUxB`):
- **Finance Pipeline** with ten stages, in order: New Lead · Appointment Booked · Contacted ·
  Qualified · Docs Requested · Docs Received · Submitted to Lender · Approved · Settled ·
  Lost / Not Proceeding (D28). A new pipeline — nothing shared with the other business in the
  location was touched (R22).
  *Correction, 24 Aug 2026: **nine** of the ten were actually delivered by the Stage 1
  build. "Appointment Booked" — specified 19 Aug — was missed, discovered during the first
  authorized API read of the pipeline (Stage 2 part 2), and created via an approved API
  write on 24 Aug (MEMORY.md 24 Aug). The pipeline now genuinely has all ten; the original
  nine stage IDs were untouched by the fix.*
- **Ten custom fields in their own folder**, deliberately separate from the account's 21
  older fields: Loan Type, Loan Amount, Property Value, Deposit Amount, Employment Type,
  Annual Income, Credit Concerns, Lead Source, Preferred Contact Time, Current Interest Rate.
- **Five live workflows**: New Lead Intake, Instant Lead Reply, 24hr No Contact Alert,
  Document Chase, Stage Notifications — all copy rewritten for refinance, not first home
  buyer.
- **Refi Pixel** installed on the FUNDD funnel with the **Conversions API sending the `Lead`
  event server-side**, on a token scoped to that pixel only (D31). Six pixels exist in the
  account; this is the one in use.
- **Notifications reduced from six per lead to one** (two if the lead also books), to
  `rossb@fundd.com.au` (D32, D25).

**Demonstrated** (22 Aug): the pipeline and fields visible in GHL; the five workflows
published; a `Lead` event arriving at Refi Pixel via the Conversions API; the notification
path firing once per lead. Signed off and 198 paid the same day (MEMORY.md §4, 22 Aug).

**Carried forward, not blocking:** R21 (three GHL scopes recorded as denied on 12 Aug — the
token now carries `customFields`, `customValues` and `tags`; reconcile when next probed),
R24 (`finance-option.com.au` sending to Refi Pixel since June, origin unknown — do not filter
before it is known), R17 (no consent record for ~180 existing contacts).

---

## Stage 2 — Foundations + AI trained on the client's voice · Payment 2 of 5 (198)

Stage 2 ends in **something the client can open on his phone and talk to**, in his voice, on a
foundation the remaining stages build on without a rewrite. It is delivered in seven parts
(`tasks/TASKS.md`): 1 docs + repo foundation · 2 database, migrations, RLS · 3 auth and user
management · 4 Claude integration layer · 5 voice and brand prompt layer · 6 chat interface,
responsive, deployed · 7 end-to-end test and acceptance.

### What "done" means — and why each item is testable rather than subjective

The risk in this stage is that "trained on his voice" is a matter of taste and "foundations"
is invisible. So every criterion below is either a **test output**, an **HTTP response**, a
**database row**, or a **count the client produces himself**. Exactly one item (item 9) asks for
the client's judgement, and it is structured so the answer is a number.

**Foundations (parts 1–4)**

1. **CI is green on the demonstrated commit** — typecheck, lint, gitleaks, unit tests,
   coverage ≥ 80% lines / 75% branches. *Evidence:* the GitHub Actions run. The gitleaks hook
   is shown blocking a planted key pattern locally.
2. **The schema rebuilds from zero** — `supabase db reset` replays every migration into a
   working schema with **every** table RLS-enabled and forced, and the memory tables carry
   `user_id` and `scope` (D24). *Evidence:* the reset output and `\d` of the memory tables.
3. **RLS is proven, not claimed** — `tests/security/rls.test.ts` output shows: an anon client
   receives zero rows from every table; an authenticated account not in `app_users` receives
   zero rows from every table; user A cannot read user B's `user`-scoped memory rows and can
   read `workspace`-scoped ones. *Evidence:* the test run, table by table.
4. **Only allowlisted people get in** — an anonymous request to the chat endpoint returns
   `401`; a real Supabase Auth account that is *not* in `app_users` returns `403` and sees an
   empty UI; Ross's account gets through. *Evidence:* the three HTTP responses.
5. **Every Claude call is metered and capped** — one chat turn produces one `api_usage` row
   (model, input/output/cache tokens, cost); the daily cap is then set to a value already
   spent and the next turn is **refused before the request reaches Anthropic**, with a clear
   message in the UI. *Evidence:* the row, then the refusal and the absence of a new row.
6. **The Anthropic key cannot be reached from the browser** (T11 — the prototype's failure,
   R18) — a grep of the deployed client assets for `sk-ant-` returns zero hits, and the
   browser's network panel for a complete chat turn shows no request to `api.anthropic.com`,
   only to our endpoint. *Evidence:* the grep output and a screenshot of the network panel.

**Voice (part 5)**

7. **The voice is traceable** — the prompt layer is built from `CLIENT-CONTEXT.md` §1
   (business, positioning, three pillars), §9 (copy frameworks), §10 (avatar) and §11
   (operational rules), plus whatever samples Ross supplies, and **every rule in the prompt
   cites its section**. A rule that cannot be traced is removed, not kept because it sounds
   right. *Evidence:* the traceability table in the repo.
8. **Voice conformance is a test suite, not an opinion** — a fixed set of **at least 20
   prompts** (`tests/fixtures/voice/`) whose recorded responses are checked **by code** for
   the rules that can be checked by code: never positions as a bank; states the three pillars
   when asked for positioning; when asked for a Meta ad, produces Hook → Body → CTA with the
   headline under 28 characters; one CTA per asset (Rule of One); no "HubSpot" or other stale
   stack reference (R19); **no number, rate or claim that was not in the prompt** (R7 — an
   invented figure under the client's name is the harm). **100% pass** on the recorded set in
   CI; re-run live once in front of the client before sign-off. *Evidence:* the test output.
9. **The client would publish it** — Ross reads **five generated posts** (in voice, from
   briefs he has not seen the output of before) and confirms he **would publish at least
   three** of them as they stand. This is the single subjective judgement in the stage, and it
   is structured so the result is a count, taken once, in the acceptance session. *Evidence:*
   the five posts and his three-or-more, recorded in `docs/MEMORY.md`. *(Replaced the 10-pair
   blind A/B on 23 Aug — the client would not sit through it and it would block sign-off.)*

**Chat on the phone (part 6)**

10. **He can open it and talk to it on his phone** — the deployed URL opens on Ross's own
    phone (not a resized browser window), he logs in, sends a message, and gets a reply in
    voice. Verified at **375px, 768px and 1280px**: no horizontal scrolling, inputs at 16px or
    larger so iOS Safari does not auto-zoom into a page it cannot zoom out of
    (`EXISTING-PROTOTYPE.md`). *Evidence:* screenshots at the three widths and the live demo
    on his phone.
11. **Conversations follow him across devices** — a conversation started on the phone is
    visible, with all its messages, on a laptop after logging in as the same user, and vice
    versa. This proves the prototype's localStorage failure is gone: memory lives against the
    user, not the device. *(Recall of facts across conversations is Stage 3; this item is the
    conversation itself persisting.)* *Evidence:* the same conversation on two screens.

**Acceptance (part 7)**

12. `npm run test:regress` green, counts and coverage reported in numbers; items 1–11
    recorded with their evidence in `docs/MEMORY.md`; client confirms in writing → **198**.

**Not in Stage 2** (stated so it is not assumed): semantic memory and durable-fact recall
across conversations (Stage 3); the dashboard beyond the chat screen (Stage 3); reading
websites (Stage 4); structured content formats — carousels, ad-copy variants, post series
(Stage 5); n8n workflows (Stage 3 onwards); any writes to GoHighLevel from the assistant.

**Client responsibility before this stage:** the Supabase project unpaused (developer can do
it — it is the free-tier idle auto-pause, D24); R18 — confirmation that the prototype's
published Anthropic key has been revoked; voice samples if he has any he wants the assistant
to sound like (optional — §1, §9–§11 are enough to start).

---

## Stage 3 — Memory + dashboard · Payment 3 of 5 (198)

*Criteria to be tightened at Stage 3 kickoff in the same style as Stage 2. Starting points,
from Scope v3 and the 09 Aug Phase 4 criteria that survive:*

- Three-tier memory live: recent turns verbatim, semantic recall of past sessions
  (`memory_chunks`, Voyage embeddings — R5), durable facts (`memory_facts`, append-only with
  supersede). **Tell it a preference in one session on one device; start a fresh session on
  another device; it recalls the preference.**
- `user` vs `workspace` scope behaves as `SCHEMA.md` §4 says, proven by the RLS test.
- Dashboard (D29) usable on a phone: conversations, cost, review queue, tasks. Verified at
  375/768/1280.
- Whitelisted tools, **two-turn confirmation on anything that writes** (D9); every tool
  execution in `audit_log`; a declined write changes nothing.
- n8n on Railway with Postgres backing, encrypted credentials, HMAC-verified webhooks.
- Voyage AI account created (client responsibility, R5).

**Part 1 (FND-300, 26 Aug 2026) evidence, code level — the eight Part C assertions:**
(1) ten messages → exactly one chunk, `turn_range [1,11)` — `trigger.test.ts` "1." and
`memory.test.ts` "1."; (2) re-run → no second chunk, nothing spent — "2." and "2b." (the
constraint path) in both; (3) 1,024 dimensions, non-zero — "3." in both (`vector_dims` /
`vector_norm` on the stored row in the integration suite); (4) one `voyage` and one
`anthropic` `api_usage` row per chunk, tokens from the wire, cost from the arithmetic — "4."
in both; (5) Voyage cap 0 → no HTTP and no Haiku call — "Part C 5" in `trigger.test.ts`,
`embed.test.ts`, "5." in `memory.test.ts`; (6) chunk readable only by an allowlisted user,
workspace/private per the parent — `rls.test.ts` 4, 4b, 5; (7) the key in no log line,
error, response or client file — `embed.test.ts` "Part C item 7", `trigger.test.ts`,
`voyage-key.test.ts`, `web:check` + a `pa-` grep of `web/dist` (0 files); (8) a failing
summarisation never changes the reply — `chat-memory.test.ts` (reject / throw / slow /
not-saved / streaming), `memory.test.ts` "8." (broken Voyage behind `handleChatTurn` → 200).
Items marked `memory.test.ts` / `rls.test.ts` / `schema.test.ts` need a stack and were
**not run on the developer's machine** (no Docker) — CI's `integration` job is the evidence.

---

## Stage 4 — Website reading and storage · Payment 4 of 5 (198)

*Criteria to be tightened at Stage 4 kickoff. Starting points:*

- Point it at a URL → it reads the page and stores what it finds, **every field carrying
  `source_url`, `fetched_at`, `extraction_method`, `confidence`** (CLAUDE.md rule 12,
  `SCHEMA.md` §2a).
- Open any stored fact and see the page it came from. A field that was not on the page is
  `null`, never guessed (SECURITY.md §7).
- Crawler safety: robots.txt honoured, SSRF cases in SECURITY.md §10 rejected by test, rate
  limited per host, identified User-Agent.
- **The adversarial-page suite passes** — pages containing hidden instructions do not alter
  behaviour or trigger any tool (SECURITY.md §3).
- Below-threshold facts go to the review queue, never to the store.
- Re-read the same page twice → no duplicate rows.

---

## Stage 5 — Content, carousels, ad copy · (paid within the final 528)

*Criteria to be tightened at Stage 5 kickoff. Starting points:*

- From a brief or a stored page, it drafts social posts, carousel copy and ad copy in the
  voice, following `CLIENT-CONTEXT.md` §9 (Green Brain hook, Red Brain body, Rule of One, Meta
  headline under 28 characters, Google ad structure).
- The Stage 2 voice-conformance suite extended to each format; 100% pass on the recorded set.
- Nothing is published under the client's name from a draft that has not passed review
  (CLAUDE.md rule 14, R7). Where a draft goes after approval is agreed at kickoff (GHL social
  planner is connected — MEMORY.md 12 Aug — but nothing publishes without a decision).
- Drafts, approvals and the check results are stored and visible on the dashboard.

---

## Stage 6 — Monitoring, testing, docs, handover · Payment 5 of 5 (528, covering Stages 5–6)

- Monitoring workflow: daily health check, cost rollup, stale-data and token-expiry alerts —
  verified by triggering a real failure and a real cap trip.
- Full regression suite green; manual QA (`TESTING.md` §9) completed.
- Runbook walked through end to end: rotate a key, restore a backup, re-run a failed
  workflow, unpause a capped workflow.
- Security checklist (`SECURITY.md` §13) — every box ticked, including R18 closed in writing.
- All accounts and keys transferred to the client; developer access to the client's password
  vault revoked in writing; all keys rotated so the developer's copies are dead.
- Recorded walkthrough: daily use, the review queue, the chat, what to do when something
  breaks.

---

## What is not in any stage

Each is available as a separate, separately-priced engagement:

- **The B2B outbound lead-research engine** — organisation research, website discovery,
  decision-maker extraction, email verification, the two scoring rubrics and the Google Sheets
  export. Never asked for by the client; parked, not deleted (D23)
- Outbound email sending, sequencing or inbox warming
- Scheduled social *insights* tracking (Instagram / Facebook / LinkedIn metrics) — parked, R3
- Integration with the separate finance CRM Ross mentioned
- CRMs beyond GoHighLevel
- Authenticated scraping of any social platform
- Phone or SMS integration
- ~~A custom web frontend with its own login~~ — **superseded by D29 (22 Aug): a dashboard is
  in scope at Stage 3**
- Ongoing maintenance or support after handover

---

## Client responsibilities

Delays here move the timeline, and that is worth agreeing now rather than discovering later:

| Needed | By stage |
|---|---|
| ~~Database platform decision (Supabase or MongoDB)~~ | **Closed 22 Aug — Supabase (D24)** |
| Confirmation the prototype's published Anthropic key is revoked (R18) | **Before Stage 2 sign-off** — it is also simply urgent |
| Voice samples, if any (optional) | Stage 2 |
| Voyage AI account | Before Stage 3 |
| Answers on `finance-option.com.au` (R24), consent/opt-out location (R17), the shared GHL location (R22) | Before any stage that writes to GHL or publishes |
| Review and sign-off within 3 business days of each demo | Every stage |

---

## SUPERSEDED — five-phase acceptance criteria from the 09 Aug 2026 scope document

**Kept verbatim for the record. Not the current acceptance criteria.** These were written for
the five-phase plan that Scope v3 replaced on 22 Aug 2026 (D23, D26). Phase 1's repo / schema /
RLS items survive as Stage 2 parts 1–3; Phase 4's memory and tool items survive as Stage 3;
Phase 2's crawler-safety and adversarial-page items survive as Stage 4. Everything about
organisation research, contacts, verification, rubrics, CRM push of researched leads, Google
Sheets and social insights is parked.

### Phase 1 — Foundation · Payment 1 of 5

**Delivered**
- n8n running on Railway with Postgres backing, encrypted credentials, basic auth
- Database (Sydney region) with the full schema, RLS enforced on every table, daily backups
- Notion workspace with all eight databases, relations, and mobile-tested views
- GoHighLevel connected, custom fields mapped, pipeline and stages agreed
- Repository with CI, secret scanning, test harness

**Demonstrated live**
1. Press a button in Notion on a phone → a record appears in the database → Notion updates.
2. Anonymous access to the database returns zero rows from every table.
3. A deliberately failed workflow produces an alert to Ross@enchargecapital.com.
4. A test Claude API call appears in the cost tracking table.
5. The spend cap is tripped deliberately and the workflow pauses rather than overruns.
6. `supabase db reset` rebuilds the entire schema from zero.

**Not included in this phase:** any lead research. Phase 1 is plumbing. It looks like little
from the outside and is the reason the next four phases work.

---

### Phase 2 — Discovery and web data pulling · Payment 2 of 5

**Delivered**
- Intake from Notion and CSV with lead type classification
- Correct routing: business types researched, consumer types tracked only
- Website resolution with confidence scoring
- Crawler with robots.txt compliance, rate limiting, SSRF protection
- Full source trail: every page fetched recorded with URL, timestamp, stored content
- Organisation-level deduplication

**Demonstrated live**
1. Add 25 business names → correct websites resolved for at least 90%; the rest flagged for
   review rather than guessed.
2. Add a consumer-type lead → it is tracked, and no crawl or AI call is made for it.
3. Open any organisation record and see every source URL and fetch timestamp behind it.
4. Add the same organisation twice in two different URL forms → one record, not two.
5. Re-run the entire batch → zero duplicates created.
6. The adversarial-page test suite passes: pages containing hidden instructions do not alter
   system behaviour.

---

### Phase 3 — Contacts, verification, ranking, CRM · Payment 3 of 5

**Delivered**
- Decision-maker extraction: name, title, email, phone, LinkedIn
- Five-stage email verification
- Two scoring rubrics — business finance and referral partners — with score, tier, written
  reasoning and confidence
- Review queue in Notion with approve/reject
- Idempotent push to GoHighLevel and Google Sheets
- Editable-field writeback from Notion, with system-derived fields protected

**Demonstrated live**
1. 50 organisations processed end to end across both rubrics.
2. Every contact shows its source URL. Any inferred email is visibly marked as inferred in
   both Notion and GoHighLevel.
3. Ranking reasoning is readable and defensible — Ross can see *why* a lead scored what it did.
4. A referral partner with an in-house broker scores lower, and the reasoning says so.
5. Low-confidence records appear in the review queue instead of the CRM; approving one pushes
   it through.
6. Push the same batch twice → GoHighLevel shows no duplicates.
7. Change a stage in Notion → it syncs back. Attempt to change a system-derived field → it is
   rejected and logged.
8. Cost per fully-enriched organisation reported and within the agreed ceiling.
9. Ten records verified by hand against their source pages in front of the client.

**Client responsibility before this phase:** confirmation of which GoHighLevel pipeline
receives leads and which custom fields to map to.

---

### Phase 4 — Claude ops layer with memory · Payment 4 of 5

**Delivered**
- Conversational interface accepting operational commands
- Three-tier memory: recent conversation, semantic recall of past sessions, durable facts
- Whitelisted tools with confirmation required on anything that writes
- Content generation grounded in Encharge's own copy frameworks

**Demonstrated live**
1. Ask for conversion rates and pipeline metrics → correct numbers, reconciled against GHL.
2. Tell it a preference in one session; start a fresh session; it recalls the preference.
3. Issue a write command → it shows exactly what it will change and waits. Decline it →
   nothing changes.
4. Assign a task by text → the task appears in Notion.
5. Point it at a webpage → it generates ad copy following the Green Brain / Rule of One
   structure from the client's own playbook.
6. Every action taken is visible in the audit log.

---

### Phase 5 — Social tracking, polish, handover · Payment 5 of 5

**Delivered**
- Instagram, Facebook and LinkedIn insights pulled daily
- Notion social dashboard with 7 and 30-day movement
- Mobile-verified Notion interface across every view
- Monitoring, alerting, runbook and handover

**Demonstrated live**
1. Yesterday's social metrics present without anyone touching anything.
2. Run the daily pull twice → one row per day, not two.
3. Every Notion view opened on a phone and usable without horizontal scrolling.
4. A token nearing expiry produces an alert.
5. Runbook walked through: rotate a key, restore a backup, re-run a failed batch, unpause a
   workflow that hit its cost cap.
6. All accounts and keys transferred to client ownership; developer access to the client's
   password vault revoked.

**Stated constraint, agreed in advance:** LinkedIn Organization API access requires an
approved developer app with Ross as page admin, and Instagram/Facebook require a Business
account linked to a Meta app. If any approval is outstanding at the start of Phase 5, that
platform ships with a manual-entry fallback and completes on approval. This does not block
phase sign-off.

---

### What is not in any phase *(09 Aug list — superseded)*

Each is available as a separate, separately-priced engagement:

- Outbound email sending, sequencing or inbox warming
- Automated research on the consumer lead types
- Integration with the separate finance CRM Ross mentioned
- CRMs beyond GoHighLevel
- Data sources beyond those built in Phase 2
- Authenticated scraping of any social platform
- Phone or SMS integration
- A custom web frontend with its own login
- Ongoing maintenance or support after handover

---

### Client responsibilities *(09 Aug list — superseded)*

Delays here move the timeline, and that is worth agreeing now rather than discovering later:

| Needed | By phase |
|---|---|
| Database platform decision (Supabase or MongoDB) | **Before Phase 1** |
| GoHighLevel pipeline and custom field mapping | Before Phase 3 |
| MillionVerifier account and key | Before Phase 3 |
| Voyage AI account | Before Phase 4 |
| Meta Business account linked, app permissions granted | Before Phase 5 |
| LinkedIn developer app approved with admin rights | Before Phase 5 |
| Review and sign-off within 3 business days of each demo | Every phase |
