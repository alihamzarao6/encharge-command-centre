# MEMORY.md — Project Working Memory

**Purpose.** Claude Code loses everything on `/clear`. This file is what survives. Read it at
the start of every session before touching code. Append at the end of every task. A stale
file means every later session works from a wrong picture.

**Append rules**
- Newest entries at the top of §3.
- One entry per completed task or decision, 3–6 lines.
- Record **decisions and surprises**, not a diary of what the code does.
- If an assumption changed, say what it was and why it changed.
- Never delete an entry. Supersede it with a new one referencing the old date.

---

## 1. Current state (overwrite each session)

| | |
|---|---|
| Binding scope | **Scope v3** (22 Aug). Six delivery stages, not five phases. The B2B outbound lead-research engine is **out of scope** — see D23 |
| Brand | Client is rebranding **Encharge Capital → Fundd** (`fundd.com.au`). GHL stays white-labelled at `app.enchargecapital.com`. Notifications go to `rossb@fundd.com.au` |
| Active stage | **Stage 2 — Foundations + AI trained on voice** |
| Last completed | **Stage 1 — GHL + Meta. Complete, signed off, paid** (198 of 1320). Finance Pipeline (10 stages), 10 custom fields, 5 live workflows, Refi Pixel + Conversions API |
| Next task | **Finish the Scope v3 doc-set update** — done: `MEMORY.md` (corrected), `CLAUDE.md`, `CLIENT-CONTEXT.md` (23 Aug). Remaining, one file per reviewed diff: `SCHEMA.md` → `SECURITY.md` → `PHASE-ACCEPTANCE.md` → `TASKS.md` → `RUNBOOK.md` → `README.md` — these still describe the five-phase research plan. Then Stage 2 kickoff — unpause Supabase, land the foundations migrations, start the voice-training corpus |
| Blocked on | Nothing structural. R9 (no Notion workspace token for n8n) and R21 (three GHL scopes still denied) remain open but do not block Stage 2 |
| Last regression run | not yet run |
| Known broken | Supabase project is paused — free-tier idle auto-pause, not a decision (R1 closed). Notion databases exist but hold no rows and have no views |
| **Urgent, unrelated to any task** | **R18 — a live Anthropic API key was published in plain text on the client's old Command Centre prototype. Rotation is still unconfirmed.** Chase it; it is not blocked by anything |

---

## 2. Standing decisions

Settled. Do not relitigate without a new dated entry explaining what changed.

| # | Decision | Reason | Date |
|---|---|---|---|
| D1 | Database is the single source of truth; Notion is a view, GHL a destination | Downstream systems rebuildable by replay. Prevents three-way sync divergence | 08 Aug |
| D2 | Business logic in `src/lib/`, not n8n Function nodes | n8n nodes untestable and unversionable; avoids permanent n8n lock-in | 08 Aug |
| D3 | Extraction and ranking calls run with **zero tools available** | Prompt injection from scraped pages then has nothing to call | 08 Aug |
| D4 | Every field carries `source_url`, `fetched_at`, `extraction_method`, `confidence` | Client phones real people from this data. A field without provenance can't be defended | 08 Aug |
| D5 | Email verification cheapest-check-first, paid API last | 40–60% die before any paid call. Makes per-lead cost viable | 08 Aug |
| D6 | Rubrics are data in `rubric_versions`, not code | Client can retune weighting without a redeploy; scores record their version | 08 Aug |
| D7 | Official social APIs only, no authenticated scraping | Scrapers break in weeks and risk bans. Stated to client in writing | 08 Aug |
| D8 | Supabase region Sydney (ap-southeast-2) | Australian client, Australian personal data, Privacy Act | 08 Aug |
| D9 | Write tools require two-turn confirmation | An AI that writes to a live CRM unconfirmed is a liability | 08 Aug |
| D10 | Facts and rankings append-only with supersede | "Why was this a B in March?" must be answerable | 08 Aug |
| **D11** | **CRM is GoHighLevel.** Close and HubSpot dropped | Ross confirmed GHL is what the team actually uses, white-labelled at app.enchargecapital.com | 08 Aug |
| **D12** | **Notion is the interface, not a custom web app** | Ross's requirement was "an app on my phone to control everything on the go". Notion mobile is exactly that; a custom dashboard is a much bigger build and worse on mobile. Declined and recorded as out of scope | 08 Aug |
| **D13** | **Research runs only on Commercial, Asset finance, Referral partner** | The other five lead types are individuals with no website. Stated to Ross three times and written into the scope doc he holds | 08 Aug |
| **D14** | **Referral partners get their own rubric (B)** | Scored on deal volume they could send, not on their own finance need. Independence is the key signal — an agency with an in-house broker never refers out | 08 Aug |
| **D15** | Consumer leads live in a separate `consumer_leads` table | Mixing them into `organizations` means every research query carries a filter it could forget | 09 Aug |
| **D16** | Editable-field policy: stage, type, source, owner, notes, tags sync back from Notion; system-derived fields are read-only and corrected via audited overrides | Ross asked for "everything editable", but blind two-way sync would let a run overwrite a human edit and a human edit destroy provenance | 09 Aug |
| **D17** | Scope document sent to client with no commercial terms | Ross asked for the brief twice. Sent scope and deliverables only, approved by Saqib first, to avoid exposing the prime contractor's margin | 09 Aug |
| **D19** | Notion structure (databases, properties, views) built through the Notion MCP, not by hand | `create_view`/`update_view` are available on this plan. Developer doesn't know Notion well; MCP removes the manual UI work. Buttons remain UI-only | 09 Aug |
| **D18** | No schema changes through the Supabase MCP | Every change is a migration file. A dashboard-applied change absent from the repo is a bug waiting to happen | 09 Aug |
| **D20** | Notion Intake offers **all eight** lead types, not three | Ross works from his phone and should never have to choose a database first. The pipeline routes business types to Organisations and consumer types to Consumer Leads, applying the D13 research guard itself | 10 Aug |
| **D21** | `Opt Out` is **editable** in Notion on Contacts and Consumer Leads | Deliberate addition to the CLIENT-CONTEXT §8 editable list. An unsubscribe request is a Spam Act obligation and cannot wait on a review-queue round trip. Everything else in §8 is unchanged | 10 Aug |
| **D22** | The editable/read-only split is enforced by the **sync whitelist**, not by Notion | Notion has no per-property permissions — any member can edit any property. Property descriptions label each field EDITABLE or READ-ONLY, and `notion_sync_map` accepts only the §8 list on a pull. Claiming Notion enforces this would be a silent failure | 10 Aug |
| **D23** | **Scope v3 is the binding document. The B2B outbound lead-research engine is out of scope** and was never asked for by the client | The project is an AI assistant trained on the client's voice, with persistent cross-device memory, that reads websites and stores what it finds, generates social posts / carousels / ad copy, sits on a dashboard, with GHL and Meta underneath. Organisation research, website discovery, decision-maker extraction, email verification and the two scoring rubrics are **parked, not deleted** — to be moved under "out of current scope" headings in `CLIENT-CONTEXT.md`, `SCHEMA.md` and `TASKS.md` (pending as of 23 Aug — see the 22 Aug session entry). **This parks D5, D6, D13, D14 and D15** | 22 Aug |
| **D24** | **Database is Supabase. Confirmed. The MongoDB question is closed** | Client confirmed. `docs/SCHEMA.md` stays relational Postgres with RLS; the provenance and audit design stands. Supersedes the R1 blocker, now closed. Memory tables get `user_id` and `scope` from the **first** migration — one user today, but retrofitting it later is a migration | 22 Aug |
| **D25** | **The client is rebranding Encharge Capital → Fundd (`fundd.com.au`)** | Brand-facing copy, funnels and notification addresses move to Fundd. **GHL stays white-labelled at `app.enchargecapital.com`** — do not "fix" that to fundd.com.au. Notification address is now `rossb@fundd.com.au`, superseding `Ross@enchargecapital.com` in the 08 Aug spend-cap agreement | 22 Aug |
| **D26** | **Six delivery stages replace the five phases**, everywhere: 1 GHL + Meta · 2 Foundations + AI trained on voice · 3 Memory + dashboard · 4 Website reading and storage · 5 Content, carousels, ad copy · 6 Monitoring, testing, docs, handover | Stage 1 is complete, signed off and paid. Phase numbering in older entries below refers to the superseded five-phase plan — read it as history, not as the current map | 22 Aug |
| **D27** | **Commercials: 1320 total. 198 on sign-off of each of stages 1–4, 528 at the end** | Stage 1's 198 is **paid**. Supersedes the "5 phases, $100 upfront" line in the 07 Aug communication log | 22 Aug |
| **D28** | **The live pipeline is "Finance Pipeline" with 10 stages**: New Lead · Appointment Booked · Contacted · Qualified · Docs Requested · Docs Received · Submitted to Lender · Approved · Settled · Lost / Not Proceeding | **This replaces the nine stages Ross gave on 08 Aug** (`lead_in`, `full_details`, `booked_calendar`, `docs_sent`, `ongoing_loan_app`, `no_show`, `retarget`, `disqualify`, `settled`) — those were never built and exist nowhere. `CLIENT-CONTEXT.md` §3 and `SCHEMA.md` still carry the nine — correction pending as of 23 Aug. Closes R15 | 22 Aug |
| **D29** | **A dashboard is in scope, at Stage 3. This supersedes D12** (08 Aug, "Notion is the interface, not a custom web app") | The Scope v3 assistant sits on a dashboard. Notion remains useful as an internal working surface, but it is no longer the answer to "an app on my phone" | 22 Aug |
| **D30** | **The real lead path is: Facebook ad video → FUNDD landing page → form → Discovery Session calendar booking** | Earlier assumptions about the entry path were wrong. The FUNDD funnel is the live landing page and **stays on its `sites.leadconnectorhq.com` address** — the client will not point a custom domain at it because `fundd.com.au` belongs to his aggregator group. Do not propose a domain swap. Closes R23 | 22 Aug |
| **D31** | **Refi Pixel is the single Meta pixel in use.** Six pixels exist in the account, not three | Refi Pixel is installed on the FUNDD funnel with Conversions API sending the `Lead` event server-side, on a token **scoped to that pixel only**. Ad account and pixel access granted to the developer | 22 Aug |
| **D32** | **Per-lead notifications reduced from six to one** (two if the lead also books) | Six notifications per lead trains the recipient to ignore all six. One alert that is always read beats six that are muted | 22 Aug |

---

## 3. Session log

*(Newest first. Copy this template, don't improvise the format.)*

```
### YYYY-MM-DD — [task id] Short title
**Did:** what was built or changed
**Decided:** any judgement call, and why
**Surprised by:** anything that didn't work as expected
**Next:** the immediate next task
```

---

### 2026-08-23 — [docs] Scope v3 doc-set update, part 1: MEMORY.md corrected, CLAUDE.md and CLIENT-CONTEXT.md done
**Did:** Corrected the 22 Aug entry and the D23 / D28 / R14 / R15 rows, which claimed eight
docs had been updated when only `MEMORY.md` had been written. Then, one file per reviewed
diff: **`CLAUDE.md`** — §1 rewritten for Scope v3 (six stages, research engine "do not
build"), §3 Mongo decision replaced with "Supabase, decided (D24)", Serper / MillionVerifier /
Google Sheets moved to a parked line, UI → dashboard (D29), Meta / Refi Pixel row added, rule
15 replaced with the D23 guard, rule 14 extended to the knowledge store and generated copy,
phase → stage throughout. **`CLIENT-CONTEXT.md`** — §3 is now the ten-stage Finance Pipeline
(nine never-built stages kept as a superseded note), §5–§7 sit under an **"OUT OF CURRENT
SCOPE — parked research-engine material"** heading, §2's research column and §4's
`outbound_research` marked parked, §12 / §13 updated by strikethrough + supersession (nothing
deleted; questions 9–13 and G–I added). **§1, §9, §10, §11 untouched** — confirmed by hunk
positions in the diff. Committed and pushed.
**Decided:** section numbers in `CLIENT-CONTEXT.md` are preserved — §8–§11 are referenced by
number from MEMORY.md (D21, D22), SCHEMA.md and the Notion property descriptions, so the
parked material gets a banner heading before §5 rather than being physically moved to an
appendix. Google Sheets parked with the research engine on the reasoning that it was only
ever the research-export target; the user was told and did not object.
**Surprised by:** nothing new. The §1 business table still reads Encharge Capital /
enchargecapital.com.au — the rebrand is recorded in the file's preamble instead, because §1
was explicitly to be left alone.
**Next:** `SCHEMA.md` (nine stages → ten, `pipeline_stage` check constraint, research tables
under a parked heading, keep `consent_basis` / `opt_out`), then SECURITY → PHASE-ACCEPTANCE
→ TASKS → RUNBOOK → README, one diff each.

---

### 2026-08-22 — [scope] Scope v3 — research engine parked, six stages, Supabase confirmed, Stage 1 signed off
**Did:** Recorded **Scope v3** in **this file only** — §1 current state, D23–D32 in §2, the
22 Aug rows in §4, and the §5 risk register (R1, R4, R14, R15, R23 closed; R2, R3, R6, R7, R9,
R17, R20, R21, R22 updated; R24, R25 added). **No other file was changed.** `CLAUDE.md`,
`CLIENT-CONTEXT.md`, `SCHEMA.md`, `SECURITY.md`, `PHASE-ACCEPTANCE.md`, `TASKS.md`,
`RUNBOOK.md` and `README.md` still describe the five-phase research-engine plan and still
carry the open Supabase/MongoDB question.
*Correction, 23 Aug: the original version of this entry claimed all eight of those files had
been updated in place. They had not — only `MEMORY.md` was written. Entry rewritten to
describe what actually changed; the intended per-file changes are listed under "Still to do"
below so the instruction is not lost.*
**The scope changed substantially.** The **B2B outbound lead-research engine is not part of this
project and was never asked for by the client.** Organisation research, website discovery,
decision-maker extraction, email verification and both scoring rubrics are **parked under
clearly marked "out of current scope" headings** — moved, not deleted, because the rubrics and
the provenance design were expensive to work out and remain correct if that work ever returns.
**What the project actually is:** an AI assistant trained on the client's voice, with persistent
cross-device memory, that reads websites and stores what it finds, generates social posts,
carousels and ad copy, sits on a dashboard, with GoHighLevel and Meta set up underneath it.
**Decided (D23–D32):** Scope v3 binding · **Supabase confirmed, MongoDB question closed** ·
rebrand Encharge Capital → **Fundd** (`fundd.com.au`), GHL still white-labelled at
`app.enchargecapital.com` · notifications to **`rossb@fundd.com.au`** · **six delivery stages**
replace the five phases · **1320 total, 198 per sign-off on stages 1–4, 528 at the end**, with
Stage 1's 198 paid · **Finance Pipeline, 10 stages** · a dashboard is in scope, superseding D12.
**Stage 1 is complete, signed off and paid.** Built in GHL: the **Finance Pipeline** with ten
stages in order — New Lead, Appointment Booked, Contacted, Qualified, Docs Requested, Docs
Received, Submitted to Lender, Approved, Settled, Lost / Not Proceeding. Ten custom fields in
**their own folder**, deliberately kept separate from the account's older fields: Loan Type,
Loan Amount, Property Value, Deposit Amount, Employment Type, Annual Income, Credit Concerns,
Lead Source, Preferred Contact Time, Current Interest Rate. Five live workflows: New Lead
Intake, Instant Lead Reply, 24hr No Contact Alert, Document Chase, Stage Notifications — **all
copy rewritten for refinance, not first home buyer.** Notifications cut from six per lead to one
(two if they also book).
**Surprised by:** four things.
(1) **The nine pipeline stages in our notes were never built and exist nowhere.** `lead_in`,
`full_details`, `booked_calendar`, `docs_sent`, `ongoing_loan_app`, `no_show`, `retarget`,
`disqualify`, `settled` were a plan, not a state of the world. `CLIENT-CONTEXT.md` §3 and
`SCHEMA.md` carried them as fact for two weeks **and still do** — see "Still to do". **Closes
R15**, and is a reminder that a requirement written down twice still is not a built thing.
(2) **Six Meta pixels exist, not three.** **Refi Pixel** is the one in use, on the FUNDD funnel,
with Conversions API sending `Lead` server-side on a token scoped to that pixel alone. Same
sampling-versus-exhaustion lesson as the 12 Aug custom-field count.
(3) **The lead path we assumed was wrong.** It is Facebook ad video → FUNDD landing page → form
→ Discovery Session booking. The FUNDD funnel stays on `sites.leadconnectorhq.com`: the client
**will not** point a custom domain at it, because `fundd.com.au` belongs to his aggregator
group. Closes R23 — the funnel was mid-rebrand, and this is where it landed.
(4) **A domain nobody has accounted for, `finance-option.com.au`, has been sending data to Refi
Pixel since June.** Origin unconfirmed. Recorded as **R24** — it is either a stale install, an
aggregator page, or someone else's tag firing into the client's pixel, and the three have very
different implications for attribution and for privacy.
**Still to do — the doc-set update, one file at a time, each diff reviewed before the next:**
`CLAUDE.md` → `CLIENT-CONTEXT.md` → `SCHEMA.md` → `SECURITY.md` → `PHASE-ACCEPTANCE.md` →
`TASKS.md` → `RUNBOOK.md` → `README.md`. Rules for every file: edit **in place**, regenerate
nothing, delete no findings, audit results or dated history. Research-engine material
(organisation research, website discovery, decision-maker extraction, email verification, both
rubrics) moves under clearly marked **"out of current scope"** headings — parked, not deleted,
because the rubrics and the provenance design were expensive to work out and remain correct if
that work ever returns.
*To remove:* the `CLAUDE.md` §3 open database decision, the same blocker in `README.md` and
task P0.10, and the hard rule restricting research to business lead types (there is no
research). Serper, MillionVerifier, Voyage-for-research and the rubric procedures come out of
the live sections of `RUNBOOK.md`; key rotation, backup/restore and escalation stay.
*To correct:* the nine never-built pipeline stages in `CLIENT-CONTEXT.md` §3 and `SCHEMA.md`
(→ Finance Pipeline, ten stages, D28); the token scope list in `SECURITY.md` §12 (R14).
*To keep deliberately:* the whole of `SECURITY.md`, including the prompt-injection section in
full — Stage 4 reads live websites, so it is *more* relevant now, not less. The
`consent_basis` / `opt_out` design in `SCHEMA.md`; R17 is unresolved and the design is still
the right one. `CLIENT-CONTEXT.md` §1, §9 (copy frameworks), §10 (avatar) and §11
(operational rules) are the most valuable content in the repo and must not be touched.
**Next:** finish the doc-set update above, then Stage 2 — unpause Supabase, land the
foundations migrations (with `user_id` and `scope` on the memory tables from the first
migration, per D24), and start the voice corpus.

---

### 2026-08-12 — [investigation] GHL audit re-run against the expanded-scope token
**Did:** Re-probed GoHighLevel with the new token (location `tgw5Q3BnoZoSsVOnRUxB`). Strictly
`GET`, no `POST`/`PUT`/`DELETE`, nothing created or modified. Paginated to exhaustion on contacts
(all 180) and forms (all 14). `docs/GHL-AUDIT.md` rewritten with the real inventory: 21
workflows, 3 calendars, 7 funnels with steps, 14 forms, 5 social connections. New §9 carries the
draft-workflow effort estimate.
**Headline: GoHighLevel's API does not expose workflow contents to anyone.** `GET /workflows/`
returns seven metadata fields and nothing else. `/workflows/{id}`, `/steps`, `/actions` and
`/versions` all return `404 "Cannot GET"` — **route absent, not scope denied**, which no scope
will fix. The per-workflow trigger-and-step breakdown that was asked for is unobtainable via API.
Recorded as **R20**.
**Two premise corrections that change the quote.** (1) There are **21 workflows, 16 published
and 5 draft** — not nine. The "nine" in our notes is the nine *pipeline stages* and the (wrong)
nine *custom fields*. Reconcile with Ross before quoting. (2) **21 custom field IDs exist, not
9** — run 1 sampled 100 of 180 contacts and the figure was a sampling artefact. Same error hit
tags (6 → 8) and sources (8 → 13). **Lesson: page to exhaustion on GHL, never sample.**
**Decided:** Estimated the drafts from proxies rather than refusing to estimate — version number,
timestamps, published siblings, and whether each draft's tags exist in the account. `version`
increments per save, so v1 = untouched stub and v10 = concentrated build effort. It is a proxy
for editing effort, **not** a step count, and §9 says so. Landed on **~27 h, range 21–44**, and
recommended against fixed-price until the five canvases are seen. A confident number that later
moves costs more credibility than a stated range.
**Also decided:** do **not** create any custom field until `locations/customFields.readonly`
lands. Names are unreadable, so a `lead_type`/`lead_source` we create could duplicate an existing
one — two same-named fields in a live CRM with no way to tell which a workflow reads. Waiting
costs a day; the duplicate costs a production untangle.
**Surprised by:** five things.
(1) **Three of the six requested scopes did not land.** `workflows`, `calendars` and `funnels`
work; `locations/customFields`, `locations/customValues` and `locations/tags` still return the
scope `401`. Four alternate paths tried for custom fields, all denied — the refusal is real, not
a wrong URL. Ross believes he granted them. Likely a nested *Location* sub-group in the scope
picker. **R21.**
(2) **Four scopes landed that were never asked for** — `forms`, `conversations`,
`socialplanner/account`, `locations/templates`. The social one is a genuine Phase 5 find: FB,
IG, LinkedIn, TikTok and Google all connected, **Google and LinkedIn tokens already expired**.
Does not rescue R3 though — the LinkedIn connection is a *profile*, not an Organization page,
and social planner publishes rather than reporting insights.
(3) **An unrelated business shares this GHL location.** `Éire Óg GAA Joondalup`, a Gaelic games
club, runs a live website on its own domain `eireogjoondalup.com.au` inside the client's
account, updated 11 Aug. Anything we automate account-wide touches their data too. **R22.**
(4) **Zero form submissions across all 14 forms**, despite 180 contacts. So there is no
per-submission consent record for anyone already in the CRM, and the only consent artefact in
the whole account is the calendar checkbox string. Strengthens R17 considerably. It also killed
a promising trick — form submission payloads normally carry field keys, which would have
recovered custom field names without the scope.
(5) **A third whitespace trap.** After `"Contacted "` (stage, trailing space) and `"Assest
Finance"` (typo), form `a57HdyvjGkV0UX6pis7I` — the one wired to the Discovery Session calendar —
starts with a **non-breaking space (U+00A0)**, which `trim()` does not remove. Three for three:
**never match a GHL object on its name. ID only.**
**Worth carrying:** the error taxonomy now has a third member — `404 "Cannot GET /path"` means
the route does not exist and no scope will help, as distinct from the `401` scope denial and the
`403` location denial. Also `/funnels/lookup/redirect/list` rejects a missing `offset` with `422`.
**Next:** send the §5 re-ask (lead with the correction), get the five draft canvases from Ross,
and reconcile nine-vs-five before the quote.

---

### 2026-08-11 — [investigation] Existing prototype assessed (enchargecontrol.netlify.app)
**Did:** Full technical assessment of Ross's "AI agent" prototype for the scope document. Fetched
source, probed for a backend, rendered it in Chrome at desktop and mobile widths, clicked every
tab, and intercepted the outbound API request against a local redacted copy. Written up in
`docs/EXISTING-PROTOTYPE.md` with every claim marked OBSERVED or INFERENCE.
**Headline: the Anthropic API key is hardcoded in plain text in the public HTML** (line 375,
`sk-ant-api03-`, 108 chars) and sent from the browser as `x-api-key` with
`anthropic-dangerous-direct-browser-access: true`. No build step, no minification — `view-source:`
is enough. **See R18. Revoking the key is urgent and independent of any scope decision.**
**Decided:** Did **not** validate the key and did **not** trigger any generation on the live site.
Testing would spend the client's money using a credential I had just found compromised. Every
browser session blocked `api.anthropic.com` at the network layer as a hard guard; the one
functional test ran locally against a copy with the key replaced. The key is not reproduced in
this repo anywhere.
**Surprised by:** four things.
(1) **No backend at all** — one 36 KB HTML file, one inline script, zero external bundles, seven
backend probes all 404. The key exposure is therefore structural, not a slip: with no server
there is nowhere else for it to live. Patching it means building a backend.
(2) **"Memory" is localStorage**, capped at 50 items, and the UI calls it "permanent". Verified:
survives reload in the same profile, but a fresh browser profile sees **zero**. Ross works from
his phone — anything saved on his laptop is invisible there, silently. The claim that saved
context reaches the model **is** true though; I confirmed it in the intercepted system prompt.
(3) **It is more finished than expected.** Seven tabs, all wired, no dead buttons, no console
errors. The ~4 KB business-context prompt is genuinely good and ~90% reusable — it goes into
`CLIENT-CONTEXT.md`. The code is ~0% reusable. Being fair to the work matters here; he built
something real.
(4) The prompt tells the model **"Stack: HubSpot CRM"** — stale since D11. Fix before reusing.
**Also:** zero `@media` queries; 12px inputs will trigger iOS Safari auto-zoom on a page that is
`100vh; overflow:hidden` and so cannot zoom back out. Usable on mobile, not pleasant. Fixable in
under a day, and *not* the reason to replace it.
**Does not change D12** — Notion stays the interface. If anything this strengthens the case for
the Phase 4 conversational layer, since Ross demonstrably wants it.
**Next:** tell Ross to revoke the key today, separately from the scope conversation.

---

### 2026-08-10 — [investigation] GoHighLevel account audit
**Did:** Probed 29 read-only GHL endpoints to find out what Ross already has built. Strictly
GET, one attempt each, no retries, nothing created or modified. Results in `docs/GHL-AUDIT.md`
with a tiered scope-request list to send him.
**Decided:** Asked for `locations/customFields.write` in the same request as the readonly
scopes. Task 1.34 creates missing custom fields, so requesting read now and write later means
sending Ross to the same settings screen twice.
**Surprised by:** Three things.
(1) **GHL checks scope before location**, which made the audit conclusive despite a missing
location ID. `401 "not authorized for this scope"` fires before the location is examined;
`403 "does not have access to this location"` means the scope IS held. Verified with an
identical invalid location against both a held and an unheld scope. Useful for any future GHL
debugging — the two failures look similar but mean opposite things.
(2) **`GHL_LOCATION_ID` is empty in `.env`**, so even our two working scopes return nothing.
Every GHL endpoint is location-scoped. It is in the dashboard URL and needs no client action —
see R13.
(3) **`/opportunities/pipelines` returned 403, not 401** — the pipeline stage list is already
within our existing scopes. That is most of task 1.35 available as soon as the location ID is
filled in, with no wait on Ross.
**Did NOT establish:** whether the token can **write**. Confirming needs a POST, which this
task forbade, and a first write would land junk in the client's live CRM. Phase 3 depends
entirely on it — see R14. Zero endpoints returned data, so the actual inventory (how many
workflows, real stage names, existing custom fields) is still unknown.
**Next:** fill `GHL_LOCATION_ID`, re-run `/opportunities/pipelines`, send the §5 list to Ross.

**UPDATE same day — `GHL_LOCATION_ID` supplied, real inventory obtained.**
Re-ran with the real location. Contacts and opportunities returned **HTTP 200**; `customFields`,
`workflows` and `calendars` still returned 401, confirming those denials were genuine scope
failures and not artefacts of the missing location.
**Biggest finding: Ross's nine pipeline stages do not exist in GoHighLevel.** Not in any of the
five pipelines, not under other names, not partially. GHL has five pipelines of 4–5 stages using
a generic `New Lead → Contacted → Proposal Sent → Closed` shape. Task 1.35 assumed we would map
our nine onto his existing stages — there is nothing to map onto. Three options written up in
`GHL-AUDIT.md` §7; **option B (collapse nine into four) is what happens by default if nobody
decides**, and it is the lossy one. Needs Ross before Phase 3. See R15.
Also found: 180 contacts (all `type: lead`), 22 opportunities (all `open`) across only three of
the five pipelines — the two Aug 2025 "Funnel" pipelines are empty and look abandoned.
**Surprised by:** four smaller things worth carrying forward.
(1) **"Assest Finance" is misspelled in GHL.** Match pipelines on ID, never on name.
(2) One stage name has a **trailing space** (`"Contacted "`). Same lesson.
(3) **All 100 sampled contacts have `dnd: false`** — nobody in the account is marked Do Not
Contact. Either no one has opted out, or opt-outs live outside the CRM. Bears directly on the
Spam Act and on our `opt_out` field being the system of record. Asked Ross.
(4) Contact records expose `tags`, `source` and `customFields` **inline**, so tag vocabulary,
lead sources and the nine custom field IDs were recoverable without `locations/tags.readonly` or
`locations/customFields.readonly`. Field *names* still need the scope — IDs alone cannot tell us
whether `ai_score` already exists. Useful trick for future GHL work: read the object, not the
config endpoint.
GHL's actual lead sources (`Calendly`, `meta_vsl_lp`, `Facebook`, …) are campaign-level and do
not match our seven `lead_source` categories. A translation table is needed, and GHL has no
equivalent of `outbound_research` — the one value this system generates.

---

### 2026-08-10 — [docs] Consumer-lead consent columns, Notion permission risk
**Did:** Added `consent_basis text` and `opt_out boolean not null default false` to
`consumer_leads` in `SCHEMA.md` §2, with the Spam Act rationale stated inline rather than left
implicit. Added R12 covering Notion's lack of per-property permissions.
**Decided:** `opt_out` is `not null default false` on purpose — a nullable flag would let an
unset value be read as "no objection", so the query is `where opt_out = false`, never
`where opt_out is not true`.
**Next:** unchanged — 1.40 (views), or 1.1 once R1 resolves.

---

### 2026-08-10 — [1.37 + 1.38] Notion structure built
**Did:** Created parent page "Encharge Command Centre" in the Ross Byrne's Space HQ teamspace
and all eight databases under it via the Notion MCP, with full property sets, exact snake_case
select options matching the SCHEMA §1 check constraints, and four two-way relations
(Contacts/Review Items/Tasks/Intake all resolve back onto Organisations). Verified by re-fetching
the parent page and the Organisations data source. No views — that is 1.40.
**Decided:** D20, D21, D22 above.
**Surprised by:** Three things.
(1) The Notion MCP was authenticated to the wrong workspace — **GoldenDoor**, not Ross Byrne's
Space. Notion's OAuth grant is locked to the workspace picked at authorization time; the browser
switches workspaces freely but the token cannot. Symptom was a bare `404 object_not_found` on
the client's pages and an empty `get_teams`. Fix was `/mcp` → disconnect → reconnect → pick the
right workspace in the OAuth selector. **This is not R9** — the developer's account already has
access; only the token was pointed at the wrong place. Check `fetch("self")` at the start of any
Notion session before concluding anything about permissions.
(2) The MCP **cannot create a page at teamspace root.** `create_pages` accepts only a page or
database parent and `move_pages` only page/database/workspace-private — there is no teamspace
parent type, and passing the teamspace ID as `page_id` 404s. The parent page had to be created by
hand in the UI; everything under it went through the MCP as D19 requires. Same constraint will
apply to any future top-level page.
(3) Notion has no per-property permissions, so "read-only in Notion" is not configurable — hence
D22. Worth stating plainly to Ross before handover so he does not assume the UI protects him.
**Also:** worked out of order at the user's explicit direction — 1.1 through 1.36 are still open
and P0.10 (the Supabase/MongoDB decision) still blocks the data layer. Nothing built here depends
on that decision; Notion is a view either way.
**Next:** 1.40 (views via `create_view`) in a separate session, or back to 1.1 once P0.10 resolves.

**Notion IDs** (also in `.env`; `.env.example` carries dummies only):

| Database | Database ID | Data source ID |
|---|---|---|
| — parent page | `3b896899750e802aa82dcb59e12a4d4f` | — |
| Intake | `3e24e4c1baa541099fd19581d023377d` | `23c9acff-c6a3-44ab-8674-e7a65aa5fb76` |
| Organisations | `a01b97bf6204440a8c0db94e8b1cc1b6` | `7f8ac713-c1f3-459d-ab78-56e3a27e392e` |
| Contacts | `0ba8051876de464caf88fb95aafbed52` | `55c978c4-4789-41d9-8f6a-51768a1ec07c` |
| Consumer Leads | `1cf60823b4bd48e4b8f4846483def0cd` | `71893780-d8cc-4454-9529-e1b7888fab3b` |
| Review Queue | `b5bf042858cc46b79aac8d526722f122` | `5e132f2b-5136-4848-acdc-e05ca398e01a` |
| Tasks | `317a515c496f4c88825dbe01721b1779` | `052d49b7-a641-4c1d-a1f0-85dc907969eb` |
| Social Dashboard | `ddf397ee95064c83838a24c361cb7c77` | `7b6144cd-640a-401c-8cd3-439fc9cf6335` |
| Ops Chat Log | `731c2f2e15c140a0b84d301495799b5f` | `d6689bce-70ef-46b3-b4af-8fb3c19a7ce9` |

Workspace `45896899-750e-81d7-8f00-00034ba8a7ec` · teamspace HQ `32396899-750e-8111-be1a-004286fec64c`.
The **data source ID is what the API needs** for querying and page creation — the database ID
alone will not work.

---

### 2026-08-09 — [P0] Access, scope confirmation, docs revision
**Did:** Collected all client access. Confirmed scope over WhatsApp across two sessions.
Produced and sent a client-facing scope PDF (approved by Saqib first). Revised CLAUDE.md,
PLAN.md, CLIENT-CONTEXT.md, SCHEMA.md, TASKS.md, PHASE-ACCEPTANCE.md for GoHighLevel, eight
lead types, nine stages, referral partners and the editable-field policy.
**Decided:** D11–D18 above.
**Surprised by:** Supabase project found paused, and a MongoDB Atlas org appeared under the
client's account without explanation. Not resolved — see R1.
**Next:** Resolve R1, then task 1.1.

---

## 4. Client communication log

| Date | Channel | Topic | Outcome |
|---|---|---|---|
| 07 Aug | WhatsApp | Project awarded, 5 phases, $100 paid upfront | Agreed |
| 08 Aug | WhatsApp | Access request list sent | Most access granted same day |
| 08 Aug | WhatsApp | CRM confirmed as GoHighLevel; Private Integration token received (contacts + opportunities scopes only) | Resolved |
| 08 Aug | WhatsApp | Ross asked for "nicer user friendly dashboard... own dashboard" | Clarified as Notion. Custom web app recorded out of scope |
| 08 Aug | WhatsApp | Ross supplied 9 pipeline stages, later inserting "Docs sent" | Recorded |
| 08 Aug | WhatsApp | Ross supplied 7 lead types; referral partners added as an 8th | Two rubrics required |
| 08 Aug | WhatsApp | Ross mentioned a separate finance CRM "at some stage, not right now" | **Out of scope.** Price separately when raised |
| 08 Aug | WhatsApp | Spend cap agreed at $50/month; alerts to Ross@enchargecapital.com | Recorded |
| 09 Aug | WhatsApp | Serper key and Google Sheet ("Finance leads") provided | Received |
| 09 Aug | WhatsApp | Scope document sent, Saqib approved first | Awaiting Ross's confirmation |
| 09 Aug | Internal | Flagged to Saqib that referral partners and the 8-type/9-stage structure exceed the original brief; absorbing both | On record |
| 22 Aug | — | **Scope v3 agreed.** B2B outbound lead-research engine confirmed out of scope and never requested. Project is the voice-trained AI assistant, memory, website reading, content generation, dashboard, GHL + Meta | **Binding.** D23 |
| 22 Aug | — | **Database confirmed as Supabase.** MongoDB question closed | Resolved — R1 closed |
| 22 Aug | — | Rebrand Encharge Capital → **Fundd** (`fundd.com.au`). GHL stays white-labelled at `app.enchargecapital.com`. Notifications now to `rossb@fundd.com.au` | Recorded — D25 |
| 22 Aug | — | **Six delivery stages** replace the five phases. Commercials: 1320 total, 198 on sign-off of each of stages 1–4, 528 at the end | Agreed — D26, D27 |
| 22 Aug | — | **Stage 1 (GHL + Meta) signed off and paid** — 198 received. Finance Pipeline (10 stages), 10 custom fields in their own folder, 5 live workflows, Refi Pixel + Conversions API | **Complete** |
| 22 Aug | — | Confirmed the FUNDD funnel keeps its `sites.leadconnectorhq.com` address; `fundd.com.au` belongs to the aggregator group and will not be pointed at it | Resolved — R23 closed |
| 22 Aug | — | Ad account and Refi Pixel access granted to the developer | Received |

---

## 5. Open risks

| # | Risk | Impact | Status |
|---|---|---|---|
| ~~R1~~ | ~~Supabase project paused; MongoDB Atlas org appeared. Platform unconfirmed~~ | — | **CLOSED 22 Aug. The database is Supabase, confirmed by the client. The MongoDB question is closed** (D24). The pause was the free-tier 7-day idle auto-pause, not a decision — unpause at Stage 2 kickoff. `SCHEMA.md` stays relational Postgres with RLS |
| R2 | GHL custom field mapping not yet confirmed | Phase 3 push built against wrong fields | Open — `ghl_field_map` table isolates the blast radius. **12 Aug: count corrected, cause unchanged.** Full 180-contact pagination finds **21 custom field IDs, not the 9 reported on 10 Aug** — that figure was a 100-record sampling artefact. `locations/customFields.readonly` was requested and **still denied** (see R21), so names and types remain unreadable. Value-shape profiling in `GHL-AUDIT.md` §3.5 infers likely types and concludes `encharge_org_id`/`ai_score`/`ai_tier` cannot exist (they are our own inventions and this system has never written here), but `lead_type`/`lead_source` are genuinely collision-prone. **Hard rule until the scope lands: create no custom field.** A duplicate name in a live CRM cannot be told apart by a workflow reading it. **22 Aug — largely resolved by construction.** Stage 1 created **ten** fields in **their own folder**, deliberately separated from the account's older fields, so a name collision cannot be ambiguous in practice: Loan Type, Loan Amount, Property Value, Deposit Amount, Employment Type, Annual Income, Credit Concerns, Lead Source, Preferred Contact Time, Current Interest Rate. The token now carries `customFields`. Residual: the 21 pre-existing field IDs are still unmapped and unread — leave them alone |
| ~~R13~~ | ~~`GHL_LOCATION_ID` is empty in `.env`~~ | — | **CLOSED 10 Aug.** Supplied by the developer the same day. Contacts, opportunities and pipelines now return HTTP 200 |
| ~~R15~~ | ~~Ross's nine pipeline stages do not exist in GoHighLevel~~ | — | **CLOSED 22 Aug — resolved as option (A), with a different stage list.** A new pipeline, **"Finance Pipeline"**, was created with **ten** stages: New Lead, Appointment Booked, Contacted, Qualified, Docs Requested, Docs Received, Submitted to Lender, Approved, Settled, Lost / Not Proceeding. **The nine stages in our notes were never built and exist nowhere** — they were a plan recorded as fact. `CLIENT-CONTEXT.md` §3 and `SCHEMA.md` still need correcting (pending as of 23 Aug). See D28 |
| R16 | GHL lead sources are campaign-level free text (`Calendly`, `meta_vsl_lp`, `Facebook`) and do not match our seven `lead_source` categories. GHL has no equivalent of `outbound_research` | Two-way sync would corrupt whichever side is treated as authoritative | Open — needs a translation table in the same place as `ghl_field_map`. Low risk, but decide before the first push |
| R17 | Nobody in the GHL account is marked `dnd` — no opt-out signal exists in the CRM at all | If opt-outs are being tracked outside GHL, our `opt_out` field is not the system of record and someone who unsubscribed could be contacted again. Spam Act and Do Not Call exposure | Open — **worsened 12 Aug.** Confirmed across **all 180** contacts, not a sample. And `GET /forms/submissions` returns `total: 0` across all 14 forms, so there is **no per-submission consent record for anyone already in the CRM** either. The only explicit consent artefact in the entire account is the calendar consent string (`GHL-AUDIT.md` §3.3), which covers only leads who booked. Asked Ross where opt-outs and consent live (§6 Q4). **22 Aug — still open, and explicitly carried into Scope v3.** No consent records exist for the ~180 existing contacts, and no contact is marked opted out. This is live Spam Act exposure on a real contact list. The `consent_basis` / `opt_out` design in `SCHEMA.md` **stays** — it is still correct, and it is the mitigation rather than the problem |
| ~~R14~~ | ~~Unknown whether the GHL token can write~~ | — | **CLOSED 22 Aug.** Answered by delivery rather than by probe: Stage 1 created a pipeline, ten custom fields and five workflows in the live account. Writes work. The token now also carries `customFields`, `customValues` and `tags` — `SECURITY.md` §12 still lists the old scopes; update pending as of 23 Aug |
| **R18** | **Live Anthropic API key published in plain text** at `enchargecontrol.netlify.app` (client's existing prototype). Sent from the browser as `x-api-key`; readable via `view-source:` with no tooling | **Active billing exposure on the client's Anthropic account.** Anthropic keys have no IP or origin restriction, so anyone holding it can spend against the account. The agreed $50/month cap is a control in *our* pipeline and cannot restrain a third party. Not undoable by taking the site down — it may persist in caches, Netlify deploy history and archives | **OPEN — URGENT, act before the scope conversation.** (1) Revoke the key in the Anthropic Console — correct whether or not it is still live, costs nothing if already dead. (2) Check usage/billing for unexplained spend. (3) Set an account-level spend limit. **The key was deliberately not validated** — testing it would spend the client's money using a compromised credential — so "still active" is unknown and does not change the action. Full detail in `docs/EXISTING-PROTOTYPE.md` §2. **22 Aug — rotation is still unconfirmed.** Ten days on, nobody has confirmed the key was revoked. Chase it as a standalone item; it is not blocked by anything and never was |
| R19 | The prototype's business-context prompt says `Stack: HubSpot CRM` | If reused verbatim in Phase 4 it tells the model the wrong CRM, and D11 set it to GoHighLevel on 08 Aug | Open — trivial. Fix during the merge into `CLIENT-CONTEXT.md`. Logged so the stale line is not copied across unnoticed |
| **R20** | **GoHighLevel's API does not expose workflow contents at any scope.** `GET /workflows/` returns seven metadata fields (`id, name, status, version, createdAt, updatedAt, locationId`). `/workflows/{id}`, `/steps`, `/actions`, `/versions` all return `404 "Cannot GET"` — route absent, not scope denied | Triggers and action steps for the 21 workflows — including the 5 drafts being quoted — are unobtainable programmatically. Any estimate is inference, and any tooling that hoped to read GHL automations is dead on arrival | **Open, and not fixable by us or by Ross.** Platform limitation, not permissions. Workaround is human: screen-share or screenshots of the 5 draft canvases (`GHL-AUDIT.md` §6 Q8). Until then the estimate is a range (21–44 h, ~27 h working number), not a fixed price. Do not quote fixed-price on GHL workflow work sight-unseen. **22 Aug — keep this risk permanently.** Any document that implies GHL workflows can be read via the API must say plainly that they cannot. The five Stage 1 workflows are documented from what we built, not from what the API returns |
| **R21** | **Three of the six requested GHL scopes did not land.** `locations/customFields.readonly`, `locations/customValues.readonly` and `locations/tags.readonly` still return the scope `401`, while `workflows`, `calendars` and `funnels` from the same request work | Blocks task 1.34 (R2), leaves the custom-values credential surface unchecked (R18-adjacent), and hides any tag the 5 tag-driven drafts write. Ross believes these were granted, so it will not self-resolve | **Open — cheap to fix, needs one message.** Four alternate paths tried for custom fields; all `401`. Denial is genuine, not a wrong URL. Likely a nested *Location* sub-group in the Private Integration scope picker. Re-ask drafted at `GHL-AUDIT.md` §5, worded to lead with the correction |
| **R22** | **An unrelated business shares the client's GHL location.** `Éire Óg GAA Joondalup`, a Gaelic games club, runs a live website on its own domain (`eireogjoondalup.com.au`) inside location `tgw5Q3BnoZoSsVOnRUxB`, updated 11 Aug 2026 | Anything we build that operates account-wide — a workflow on contact-created, a tag sweep, a bulk custom-field write — touches a third party's data. Also means contact/tag/source counts in `GHL-AUDIT.md` are not guaranteed to be purely Encharge Capital's | Open — asked Ross whether it is meant to be there (`GHL-AUDIT.md` §6 Q6). Until answered, scope every write by pipeline or tag, never account-wide. **22 Aug — keep this risk. Nothing account-wide may be changed.** Stage 1 respected it: the ten custom fields went into their own folder and the pipeline is a new one, so nothing shared was touched |
| ~~R23~~ | ~~`FUNDD` — a clone of `Finance Broker Offer - Apex` created 11 Aug 2026 with no domain attached~~ | — | **CLOSED 22 Aug.** The rebrand is real: Encharge Capital → **Fundd**. **The FUNDD funnel is the live landing page**, and it **keeps its `sites.leadconnectorhq.com` address** — the client will not point a custom domain at it, because `fundd.com.au` belongs to his aggregator group. Do not propose a domain swap. Live path: Facebook ad video → FUNDD landing page → form → Discovery Session booking (D30) |
| R3 | LinkedIn Organization API approval takes weeks and needs Ross as page admin | Phase 5 slips through no fault of ours | Open — flagged in the scope doc, manual fallback agreed. **12 Aug:** GHL's social planner already has LinkedIn connected, but as a **`profile`, not an Organization page**, and social planner publishes rather than exposing insights. **Does not rescue R3.** Its token also expired 26 Jul. **22 Aug — PARKED.** Scheduled social *insights* are not in Scope v3; Stage 5 generates posts, carousels and ad copy rather than reporting on them. Unpark only if insights are re-added |
| ~~R4~~ | ~~Meta app permissions need a linked Business account~~ | — | **CLOSED 22 Aug by Stage 1.** Meta is set up: **six pixels exist in the account** (not three), **Refi Pixel** is the one in use, installed on the FUNDD funnel, with **Conversions API sending the `Lead` event server-side** on a token **scoped to that pixel only**. Ad account and pixel access granted to the developer. Residual, unchanged: the GHL social-planner Facebook token expires 01 Sep 2026 |
| **R9** | **Notion workspace access token not yet available.** Developer is a member, not admin, so cannot create a connection | n8n cannot write to Notion at runtime. Does not block building — the MCP authenticates as the developer's own account | Open — asked Ross for the token or admin rights. **22 Aug: does not block Stage 2.** Needed only if and when n8n has to write to Notion at runtime; under Scope v3 the dashboard, not Notion, is the primary surface (D29) |
| R5 | Voyage AI account not yet created | **Stage 3** memory layer. Embeddings for the persistent cross-device memory — still required under Scope v3, unlike the research-side uses of Voyage, which are parked | Open — needed before Stage 3, not before Stage 2 |
| R6 | Scope grew beyond the original brief (referral partners, 8 types, 9 stages) | Unpaid overrun | **Superseded 22 Aug by Scope v3.** The growth that caused this — referral partners, eight lead types, two rubrics — is now **out of scope entirely** and parked. Scope v3 is the binding document; check every new request against it |
| R7 | Client acts on this data — a fabricated fact is real-world harm | Reputational and Spam Act exposure | **Reframed 22 Aug.** The outbound research that generated contacts is parked, so the fabricated-contact case is gone. The underlying risk is not: **Stage 4 reads live websites and stores what it finds, and Stage 5 publishes generated copy under the client's name.** A hallucinated stored fact, or an invented claim in an ad, is the same class of harm. Provenance and the review queue remain the mitigation |
| R8 | Ross adds features conversationally, in small increments | Death by a thousand cuts | Scope doc now in his hands; check every request against `PLAN.md` §10 |
| **R10** | **`consumer_leads` has no `consent_basis` or `opt_out` column in `SCHEMA.md`**, though `contacts` has both and CLAUDE.md §7 requires them from day one | Consumer leads are precisely who receive marketing email. Shipping the table without them is direct Spam Act exposure and a retrofit once rows exist | **CLOSED 10 Aug.** `SCHEMA.md` §2 now carries both columns with the Spam Act rationale, and `opt_out` is `not null default false` so an unset value can never read as "no objection". Both already exist in the Notion database (decision B). Residual: the migration itself is unwritten because the data layer is blocked on R1 — it will be built from the corrected `SCHEMA.md` |
| R11 | Notion `Tasks.Priority` values (`low/medium/high/urgent`) were proposed, not supplied by Ross | Cosmetic if wrong, but the assistant's task tool will write to it | Open — confirm with Ross before the assistant gets write access to tasks (Stage 3). Cheap to change while the database is empty |
| **R12** | **Notion has no per-property permissions.** Any workspace member can type into any system-derived field — AI score, email status, confidence, source URL, provenance timestamps. The UI presents no distinction between a field they own and one the pipeline owns | A human edit to a provenance field is indistinguishable from collected data until the next sync. Worse is the false confidence: Ross may believe a value he typed is now "in the system" when it is not | Mitigated, not eliminated. `notion_sync_map` accepts only the `CLIENT-CONTEXT.md` §8 editable list on a pull, so stray edits to system fields are reverted on the next push and can never destroy provenance. Every property carries an EDITABLE or READ-ONLY description. **Tell Ross this plainly at handover** — he will otherwise assume the UI protects him, and silently lose an edit he thought had saved. Corrections to system fields go through the Review Queue, which writes an audited override. See D22 |
| **R24** | **A domain nobody has accounted for, `finance-option.com.au`, has been sending data to Refi Pixel since June 2026.** Origin unconfirmed | Three possibilities with very different consequences: a stale pixel install on an old page, an aggregator-group page firing the client's tag, or an unrelated third party. It pollutes conversion attribution on the very pixel Stage 1 wired the Conversions API into, and if it is a third party it is a privacy question, not merely a data-quality one | **Open — ask Ross.** Do **not** silently filter or block the traffic before the origin is known; a stale install of the client's own page would be wrongly discarded. Until answered, treat Refi Pixel conversion counts as containing traffic from an unidentified source |
| **R25** | **The Stage 1 build sits inside a GHL location shared with an unrelated business** (see R22), and Stages 2–6 will add automation on top of it | Compounds R22: the more we build, the more surface exists that could accidentally reach account-wide | **Open — permanent constraint.** Every Stage 2–6 automation must be scoped by pipeline, tag or custom field. **Nothing account-wide may be changed.** Treat this as a design rule, not a caution |
