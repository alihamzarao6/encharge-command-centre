# PHASE-ACCEPTANCE.md — Sign-off Criteria

Internally this defines "done". Externally it defines what the client approves when they
release each payment. **It matches the delivery plan agreed with the client on 1 Sep 2026
(`docs/MEMORY.md` D77): eight milestones, 2,000 USD total. Milestones 1–3 are complete, signed
off and paid — 600 received; 1,400 remains across milestones 4–8.** What is built is still
Scope v3 (22 Aug 2026, D23–D32). The six-stage map of 22 Aug (D26/D27 — 1320 total, 198 per
stage, 528 at the end) is superseded: Stages 1–3 became Milestones 1–3 unchanged, and the old
Stage 4–6 sections are struck through in place below rather than deleted. The five-phase
criteria from the 09 Aug 2026 scope document are superseded and kept verbatim at the bottom of
this file for the record.

| # | Milestone (the client's wording) | Amount | Status |
|---|---|---|---|
| 1 | CRM and ad tracking set up | 200 | ✅ Done, paid |
| 2 | Foundations and the client's writing voice | 200 | ✅ Done, paid |
| 3 | Memory and the app itself | 200 | ✅ Done, paid |
| 4 | Your data on screen | 350 | **Next** |
| 5 | Files, documents and research | 250 | |
| 6 | Talking to it, and your day | 350 | |
| 7 | Advertising and social | 300 | |
| 8 | Content and handover | 150 | |

The order is the one the client asked for on 5 Sep (D79): the dashboard first, then files and
voice, with advertising and social later. Website reading is part of Milestone 5, not a
milestone of its own.

A milestone is complete when all criteria are demonstrated live, the regression suite is green,
and the client confirms in writing. "Demonstrated" means evidence — a test output, an HTTP
response, a row in a table, a screenshot of the phone — not a statement that it works.

The file keeps its name (`PHASE-ACCEPTANCE.md`) because `CLAUDE.md`, `TASKS.md` and the
MEMORY.md entries reference it by that name; "phase" in the filename means "stage", and a
"stage" in the Milestone 1–3 sections below means the milestone it became.

---

## Milestone 1 — CRM and ad tracking set up *(was Stage 1 — GoHighLevel + Meta)* · 200 · ✅ COMPLETE, signed off and paid 22 Aug 2026

*The payment line in the body below records 198 received on 22 Aug under the six-stage terms
of the day; the 1 Sep milestones document prices this milestone at 200 and records 600
received across milestones 1–3 (D77). Both are left as written.*

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

## Milestone 2 — Foundations and the client's writing voice *(was Stage 2)* · 200 · ✅ COMPLETE, signed off and paid (D77)

*Signed off and paid under the 1 Sep milestones document. The criteria below are kept as the
record of what was accepted; the twelve were re-run on 29 Aug (Stage 3 Part B below).*

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

## Milestone 3 — Memory and the app itself *(was Stage 3 — Memory + dashboard)* · 200 · ✅ COMPLETE, signed off and paid (D77)

*Signed off and paid under the 1 Sep milestones document. Kept as the record of what was
accepted.*

**Tightened 29 Aug 2026 at part 5, in the Stage 2 style: every criterion is a test output, an
HTTP response, a database row or a number.** The 09 Aug starting points are kept verbatim at
the bottom of this section, because **three of them were not built** and that has to be
visible rather than quietly dropped.

| # | Criterion | Status |
|---|---|---|
| **S3-1** | **Three-tier memory is live**: recent turns verbatim, semantic recall over `memory_chunks` (Voyage), durable facts in `memory_facts` (append-only with supersede) | **Pass** — parts 1–2; `recall.test.ts`, `memory.test.ts`, and the live session below |
| **S3-2** | **A preference stated in one conversation changes the output in a later, separate one** — the whole stage in one test | **Pass, live** (below) |
| **S3-3** | Memory survives a sign-out, a different device and a different browser | **Pass** — it is keyed on the user, not the device; proven live by a second account reading the same memory, and by the browser suite's session handling. *Not* separately demonstrated on two physical devices — that is one line on the manual list |
| **S3-4** | What is remembered is **visible on the Memory page and can be removed** | **Pass** — part 3; `memory-page.test.ts`, `memory.spec.ts` |
| **S3-5** | A second user can be added, sign in, and read shared memory | **Pass** — part 4; `users.test.ts` "1.", and live below |
| **S3-6** | Retrieval **degrades without breaking a reply** when Voyage or the search fails | **Pass, and exercised for real** — 12 of 21 live turns degraded (`degraded:["embed"]`) and every one returned a 200 with a reply. See the Voyage finding |
| **S3-7** | **Privacy behaves as Part A built it** | **Pass** — the seven assertions in CI and 27 assertions live |
| **S3-8** | `user` vs `workspace` scope behaves as `SCHEMA.md` §4 says, proven by the RLS test | **Pass** — `rls.test.ts` 4, 4b, 5, 11, 12 (37/37) |
| **S3-9** | The dashboard is usable on a phone, verified at 375 / 768 / 1280 | **Pass** — Assistant, Memory, Team; `177/177` browser assertions. (The "cost, review queue, tasks" surfaces in the old bullet belong to later stages — D71 below) |
| **S3-10** | Every memory and conversation write lands in `audit_log` with the right actor | **Pass** — parts 3–5; `memory-page.test.ts` "8.", `conversations.test.ts`, and `CONVERSATION_ADMIN_READ` observed live |
| **S3-11** | The running cost is inside the figure the client was given | **Pass with headroom** — measured below |
| **S3-12** | Regression suite green; migrations replay from zero | **Pass** — CI 33261767108 |
| ~~S3-13~~ | ~~Whitelisted tools with two-turn confirmation on anything that writes (D9)~~ | **SUPERSEDED — not in Scope v3 (D71)** |
| ~~S3-14~~ | ~~n8n on Railway, Postgres-backed, encrypted credentials, HMAC-verified webhooks~~ | **SUPERSEDED as a Stage 3 item — lands at Stage 6 (D71)** |

**S3-13 and S3-14 were checked against Scope v3 rather than carried as debt, and both are
leftovers of the five-phase plan (D71, 30 Aug).**

**S3-13** is verbatim from the superseded *"Phase 4 — Claude ops layer with memory"* criteria
kept at the bottom of this file: *"Whitelisted tools with confirmation required on anything
that writes"*, alongside "ask for conversion rates and pipeline metrics", "issue a write
command", "assign a task by text → the task appears in Notion". That was an **ops layer**.
Scope v3 (D23) describes something else: an assistant trained on the client's voice, with
memory that follows him, that reads websites and stores what it finds, generates content, and
sits on a dashboard — with GoHighLevel and Meta set up *underneath* it, not driven by it.
Nothing in Stage 3 writes anywhere. **D9 is not repealed**: "write tools require two-turn
confirmation" remains a standing safety rule that binds the day a write tool exists. It has
nothing to guard yet, which is not the same as being owed.

**S3-14** — n8n was the v1/v2 orchestration layer. The six stages (D26) never mention it, and
nothing Stage 3 delivered needs it: memory runs in Edge Functions and the dashboard is a static
app. It stays in `CLAUDE.md` §2 as the stack's automation layer and lands at **Stage 6**, whose
criteria already call for a monitoring workflow — daily health check, cost rollup, stale-data
and token-expiry alerts — which is exactly what it is for.

The same applies to the "cost, review queue, tasks" dashboard surfaces in the old Stage 3
bullet: `review_queue` is where below-threshold extractions go (CLAUDE.md rule 14), so its
surface belongs with **Stage 4**, when there is finally something in it to review.

**S3-2, proven live on 29 Aug** through the production handler against the live project. In
conversation 1 the broker said *"Remember that every post we publish finishes with exactly one
call to action, and the wording is always 'Send me a message'."* — captured as
`writing:call-to-action`, `outcome: inserted`. In a **separate new conversation** the same
person asked for a two-line post about offset accounts and got one ending `Send me a message`.
Then a **different signed-in person**, in their own new conversation, asked what had been
agreed about calls to action and was told *"We've agreed every published post ends with
exactly one call to action, worded as 'Send me a message.'"* — one person taught it, another
person's conversation used it. That is S3-1, S3-2, S3-3 and S3-5 in one sequence.

The sharpest evidence is unprompted: asked for a **Google ad**, it applied the rule and then
flagged its own conflict — *"This asset carries a 'book' CTA per the Google ad structure and
the standing 'Send me a message' line applies to published posts (Facebook/organic), not
Google ad CTAs — flagging in case you want it changed to match."* It reasoned about the
remembered instruction rather than pattern-matching it.

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

**Part 2 (FND-310, 27 Aug 2026) evidence, code level — the nine Part C assertions:**
(1) "Remember that…" → exactly one fact, right scope, source message — `capture.test.ts`
"Part C 1" (recorded Haiku answer), `recall.test.ts` "1." (through `handleChatTurn`,
`source_message_id` = the saved user message); (2) a contradiction supersedes, old row
survives with `superseded_by` — `capture.test.ts` "Part C 2", `recall.test.ts` "2.", and the
migration's own check run live in a rolled-back transaction (inserted → unchanged →
superseded → superseded, one live row of three); (3) current facts exclude superseded rows —
`facts.test.ts` (the predicate), `recall.test.ts` "3." (the next turn's request holds only
the live value); (4) a chunk from an earlier conversation reaches the model — `recall.test.ts`
"4." reads the wire body of the Claude request: the chunk text is in the second, uncached
system block after the cached voice prefix; `chat-recall.test.ts` "Part C 4"; live: a fact recalled into a real Sonnet reply that
applied it (Rule of One + one direct CTA) — the live chunk recall through the real function
waits on the migration being applied (MEMORY.md 27 Aug); (5)
budget with a large store — `retrieve.test.ts` "Part C 5" (40 facts, 3 long chunks, drops
counted, under the cap), `recall.test.ts` "5." (41 chunks in the table → ≤ 3, ordered,
above the floor); (6) nothing clears the floor → no chunks, turn works — `retrieve.test.ts`
"Part C 6", `recall.test.ts` "6."; (7) Voyage failure → reply — `retrieve.test.ts` "Part C 7",
`recall.test.ts` "7.", `chat-recall.test.ts` (degraded / throwing memory → 200); (8) RLS on
facts — `rls.test.ts` 4, 5 (unchanged) and 7 (the functions are `service_role`-only); (9)
the refusal boundary survives a hostile fact — live, real Sonnet with two seeded override
facts: refusal + reason + redirect, five boundary checks pass (MEMORY.md 27 Aug).
`recall.test.ts` and `rls.test.ts` 7 need a stack and were **not run here** — CI; and the
migration is **not yet applied live** (`supabase db push` refused by the tool permission
layer this session — one command for the reviewer).

**Part 3 (FND-320, 27 Aug 2026) evidence, code level — the eight Part C assertions:**
(1) a note added from the page is in the next turn's request to Claude — `memory-page.test.ts`
"1." (the fixture fetch reads the wire body of the Claude request), `page.test.ts` "add — 1.";
(2) a note forgotten from the page stops reaching the next turn and the row survives with
`superseded_by = its own id`, its value, its author and its audit trail —
`memory-page.test.ts` "2." (including that forgetting twice writes one audit row, not two);
(3) an edit supersedes rather than duplicating and the history is visible —
`memory-page.test.ts` "3." (three rows, one live, values in order, and a 409 on the row that
was just superseded), `page.test.ts` "edit — 3." (the upsert carries the ROW's author, not
the editor's), `memory.test.ts` `buildFactLists`, browser "an edit shows as one note with its
earlier wording kept"; (4) a deleted chunk stops being retrieved AND its range stays claimed
— `memory-page.test.ts` "4." (recalled before, absent after, `coverage()` still `[1,11)`,
embedding null, tombstone summary), `page.test.ts` "supabaseMemoryPageStore" (the update
destroys content and does not touch `turn_range`); (5) a non-allowlisted or deactivated user
cannot read or write memory through the page — `page.test.ts` "who is let in" (401/403 before
any read, write or spend), `memory-page.test.ts` "a deactivated member…", `rls.test.ts` 2/3,
browser "a deactivated account never reaches the page"; (6) the browser cannot write memory
without the server path — `rls.test.ts` 8 (forget, tombstone, insert and delete all refused
through PostgREST as a real session, nothing moved), browser (`postgrestWrites` empty on
every change); (7) 375 / 768 / 1280 with no horizontal scroll — `memory.spec.ts`, 33 browser
assertions, screenshots in `docs/assets/stage-3/`; (8) every memory write lands in
`audit_log` with the right actor — `memory-page.test.ts` "8." (four fact actions and one
chunk action, actor = the user id, trigger rows alongside with actor `service_role`, and no
removed summary text anywhere in `audit_log`), `page.test.ts` per action.
Items marked `memory-page.test.ts`, `schema.test.ts` and `rls.test.ts` need a stack and were
**not run on the developer's machine** (no Docker) — CI's `integration` job is the evidence,
and **CI run 33045965704 (`e762c69`, 27 Aug) is fully green**: unit 1021/1021 with the
coverage gate, `db reset --local` from zero with 14 migrations, integration 45/45, security
33/33, browser 81/81, zero skipped anywhere. (Two red runs preceded it, both cross-file
fixture leaks in the new suite, both fixed — `docs/MEMORY.md`, part-3 entry.)

**Part 3 review (27 Aug), two additions and the live proof.** (a) **D54** — a workspace note
is now unique by `key` alone and a private note by `(user_id, key)` (migration
`20260827040000`), closing the gap where two staff could hold contradicting live notes under
one key; `schema.test.ts` proves the constraint from both authors, `memory-page.test.ts`
proves the write path supersedes rather than forks, and it was confirmed live (below).
(b) **D55** — `web:build` forces `NODE_ENV=production` and `web:check` fails on a React
development bundle; the live Vercel artefact was checked first and was already the production
build. **Deployed and proven live on 27 Aug** against the real function with a disposable
account whose rows were all removed afterwards: delete a conversation note → 200 `deleted`
with the exact tombstone (marker summary, null audience, null embedding, `turn_range`
unchanged, `deleted_by` = the caller) and 200 `already` on a repeat; forget → 200 with the
row self-referenced and its wording kept; editing a teammate's note → 200 `replaced` leaving
one live row authored by the editor, with a direct second insert refused by
`memory_facts_live_workspace_key_uniq` (23505); three `audit_log` rows with the caller as
actor; anonymous POST 401, GET 405, CORS echoing the Vercel origin; the production alias
serving 444,266 bytes with zero React dev markers and no key of any kind.

**Part 4 (FND-330, 28 Aug 2026) evidence, code level — the nine Part C assertions:**
(1) an admin creates a user from the page and that user signs in and reads workspace memory —
`users.test.ts` "1." (through `handleUsersRequest`, then a real `signInWithPassword`, then a
PostgREST read of the workspace conversation *and* of the roster), `page.test.ts` "create",
browser "adding someone shows the password once"; (2) the generated password appears in no
log line, no table and no later response body — `users.test.ts` "2." (searched for in **every
text/varchar/jsonb column of every public table**, taken from the catalog, plus every captured
log line), `page.test.ts` "Part C 2" (and four later responses re-checked), browser (absent
from the DOM, `localStorage` and `sessionStorage` the moment the panel is dismissed);
(3) a non-admin cannot create, deactivate, promote or reset — refused at the SERVER —
`page.test.ts` "Part C 3" (all seven actions 403 `NOT_ADMIN`, nothing written, no password
generated), `users.test.ts` "3." (same against a real stack, and no identity minted),
`rls.test.ts` 10 (the same writes attempted straight through PostgREST as a signed-in user,
each refused), browser "a non-admin sees the roster and no controls at all" (and the endpoint
is never called at all); (4) the workspace cannot reach zero admins by any path the page
offers — `access.test.ts` "Part C 4" (every action against a one-admin workspace),
`admin.test.ts` (self-demotion, self-deactivation, the last admin, and the database's own
refusal surfaced intact), `page.test.ts` "Part C 4" (the full sequence: promote a second,
demote the first from the second's account, then be refused), `users.test.ts` "4." — the
proof that matters: **two connections racing**, each demoting the other under the shared
advisory lock, the second refused with `23514`; browser (the two actions are not offered, and
a server refusal is shown in words); (5) a deactivated user is refused at the database and
their contributions survive — `users.test.ts` "5." (still-valid JWT → zero rows from three
tables, ban refuses a fresh sign-in, the row and their live workspace note both intact and
still readable by everyone else), plus reactivation restoring access with the same password;
(6) a renamed conversation keeps its messages, chunks and facts — `conversations.test.ts` "6."
(counts identical before and after, the chunk's embedding untouched), `page.test.ts` rename
group, browser "a rename shows straight away"; (7) a deleted conversation behaves exactly as
decided — `conversations.test.ts` "7.", **asserted row by row**: `conversations` soft-deleted
and still present, `messages` count 0, `memory_chunks` tombstoned with `turn_range` `[1,3)`
intact and `summary` = the marker and `embedding` null and `deleted_by` = the caller,
`memory_facts` still live with its value, author and date and only `source_message_id`
cleared; plus the range cannot be re-claimed, `match_memory_chunks` returns nothing for it, a
second delete reports `already`, and no message text is anywhere in `audit_log`;
(8) every user and conversation action lands in `audit_log` with the right actor —
`users.test.ts` "8." (five actions, actor = the admin's email, never `service_role`),
`conversations.test.ts` "6."/"7." (actor = the person's user id, `before`/`after` null),
`page.test.ts` and `admin.test.ts` per action; (9) 375 / 768 / 1280 with no horizontal scroll
— `users.spec.ts` (9 tests × 3 widths, including a 22-person roster with 60-character email
addresses) and `conversations.spec.ts` (10 × 3, including **fifty** conversations with the
filter), screenshots in `docs/assets/stage-3/`.

Items in `users.test.ts`, `conversations.test.ts` and `rls.test.ts` need a stack and were
**not run on the developer's machine** (no Docker) — CI's `integration` job is the evidence,
and the migration `20260828010000` is **unapplied and unvalidated live**: `supabase db push`
is the reviewer's, per RUNBOOK §1c.

**Part 5 (FND-340, 29 Aug 2026) evidence, code level — the seven Part A assertions.** R27 is
closed by the client's own answer (D62): a conversation can be private to its author, an
administrator can read anybody's, and **what the assistant LEARNS still reaches the whole
team**. That last clause is not what the schema did — a chunk took its conversation's scope
by trigger — so it is what most of the evidence is about.

(1) **A private conversation is unreadable by another allowlisted non-admin, at the
database** — `privacy.test.ts` "1." (a real signed-in session, PostgREST, zero rows, with a
**control** immediately before it proving the same session could read the same row while it
was shared, so the assertion cannot pass vacuously), `rls.test.ts` 5, `page.test.ts` "a
non-admin cannot even see…" (404, nothing written); (2) **its messages are equally
unreadable** — `privacy.test.ts` "2." (every message row is `'user'`-scoped after the flip,
zero rows through a real session, and the message text itself unreachable by any query that
session can make), `rls.test.ts` 5; (3) **its chunks stay workspace-scoped and are reachable
by shared recall** — `privacy.test.ts` "3." (`scope` = workspace, `user_id` still the
author, readable by the outsider's session, and returned by `match_memory_chunks` scoped to
*the outsider*), `rls.test.ts` 4b, `schema.test.ts` "memory_chunks take their author from
the conversation and their scope from nobody", `privacy.test.ts` "nothing can make that chunk
private" (the trigger corrects a direct update; `memory_chunks_scope_workspace` is present
and `convalidated` in `pg_constraint`); (4) **an admin can read it** — `privacy.test.ts` "4.",
which first asserts the admin's OWN PostgREST session still sees zero rows (RLS was not
widened — that is the design, D65) and then reads it through the server path, with
`CONVERSATION_ADMIN_READ` in `audit_log` naming the admin, and the listing carrying no
title; `page.test.ts` "the administrator view" (six cases, including **an unrecorded admin
read is not a read**: the audit write fails, no message is fetched); `rls.test.ts` 12
(`pg_policies.qual` on `conversations` and `messages` must not mention `is_admin`);
(5) **toggling back restores visibility, and toggling repeatedly corrupts nothing** —
`privacy.test.ts` "5." (five flips, each asserting the conversation's scope, that *all* its
messages moved together rather than a mixture, and that the chunk never moved), `page.test.ts`
"toggling repeatedly writes exactly the scopes asked for, in order"; (6) **existing workspace
conversations are unaffected** — `privacy.test.ts` "6." (an untouched conversation, its
messages and its chunk, all still workspace and still visible to the outsider) and "6b." (no
private chunk anywhere in the database — an absence, so another suite's fixtures can only
break it, never make it pass), `privacy.test.ts` unit "does not migrate any conversation to
private"; (7) **facts are unchanged** — `privacy.test.ts` "7." (value, author, scope, date,
`source_message_id` and `superseded_by` all identical, one row for the key, still readable by
the outsider).

**Interface half** — `privacy.spec.ts`, 10 tests × 3 widths, screenshots in
`docs/assets/stage-3/`: the toggle is on the author's row and on nobody else's *including an
administrator's view of it*; the confirm carries both halves of the sentence; a private row
says so at a glance; going back says what becomes visible, "including what was said while it
was private"; the admin listing shows no names and says why; opening one reads it **once**,
says the read was recorded, and renders no composer; the Memory page names an unreachable
source *A private conversation* rather than one that was removed; and every change went to
`/functions/v1/memory` with `postgrestWrites` empty throughout.

**One layout regression, found and fixed here:** the thread bar at 375 px already held ☰
Conversations, the title, Rename and + New, and a fifth control collapsed the title to zero
width — caught by `conversations.spec.ts` and `memory.spec.ts`, not by the new file. The
thread-bar toggle is now shown from 768 up only; the list-row toggle exists at every width,
and `privacy.spec.ts` asserts both halves of that so "we hid it on mobile" stays honest.

Items in `privacy.test.ts`, `schema.test.ts` and `rls.test.ts` need a stack and were **not
run on the developer's machine** (no Docker, and the Supabase MCP failed to connect this
session). **CI is the evidence, and CI run 33261767108 (`28324fc`, 29 Aug) is fully green:**
unit 1199/1199 with the coverage gate, `db reset --local` from zero applying all **16**
migrations, integration **75/75** (`privacy.test.ts` 12/12), security **37/37**, browser
**177/177**, zero skipped anywhere — the integration job sets `REQUIRE_SUPABASE_TESTS=1`, so
a skip is a failure and a green run proves the suites actually ran.

**The first run (33261409503) was RED**, and on the assertion that matters: `2. its messages
are equally unreadable` failed its final by-content check. The cause was the fixture, not the
product — `seed()` wrote the same sentence into *both* conversations, so the outsider
correctly found the shared one's copy. The scoped-by-id half of the same assertion passed, as
did the other six (74 passed, 1 failed). The by-content lookup is the half worth keeping — a
read scoped by `conversation_id` can pass while the row is still reachable by a query that
never mentions the conversation — so it stayed and the fixture was corrected, with its own
control added (the shared sentence, same query shape, must still return one row).

**Migration `20260829010000` is APPLIED to the live project** (`supabase db push --linked`,
29 Aug): the CLI reported `Applying migration 20260829010000_private_conversations.sql...` and
`supabase migration list --linked` now returns `local 20260829010000 / remote 20260829010000`.
**Proven LIVE, 29 Aug**, after `db push` and the merge to `main`. Two passes, because a
migration applying cleanly is not the same as the objects being right, and neither is the same
as the behaviour being right.

**(a) The objects, read straight out of the live catalogs** (Management API query endpoint —
`supabase db dump` needs Docker and the MCP would not connect):

| Checked | Live result |
|---|---|
| `sync_chunk_ownership` exists and forces the constant | present · `forces_workspace` **true** · `copies_parent_scope` **false** |
| `sync_child_ownership` still copies the parent's scope | `copies_parent_scope` **true** — messages unchanged |
| trigger wiring | `memory_chunks → sync_chunk_ownership` · `messages → sync_child_ownership` · `conversations → cascade_conversation_ownership` |
| the constraint | `memory_chunks_scope_workspace` · `CHECK ((scope = 'workspace'::text))` · **`convalidated = true`** (checked against every existing row, not NOT VALID) |
| the cascade body | messages get `user_id` **and** `scope`; chunks get `user_id` **only** (`chunks_still_get_scope` **false**) |
| the policies were not widened (D65) | `workspace_or_own_conversations` and `workspace_or_own_messages`, SELECT, **neither mentions `is_admin`** |
| live data | 0 private chunks of 1 · 0 private conversations of 4 |

**(b) The behaviour, against the live project — 27 assertions, all passed.** Three throwaway
`example.com` accounts (author, an allowlisted non-admin outsider, an admin), one conversation
with two messages and a chunk, one standing note; refusals proven with **real signed-in
PostgREST sessions**, writes through the production `handleMemoryRequest`. Highlights: a chunk
inserted deliberately as `scope='user'` **landed as `workspace`** (the live trigger, observed);
the outsider read zero conversation rows and zero messages while still reading the shared
conversation and the chunk (so not a vacuous pass); `match_memory_chunks` scoped to the
outsider still returned the private conversation's note; the admin's **own** session read zero
messages while the server path returned them and wrote `CONVERSATION_ADMIN_READ` naming them;
the admin was refused the privacy flip with 403; three more flips moved conversation and
messages together and never moved the chunk; the standing note was untouched. Every fixture
was removed afterwards and the run re-counted the tables to prove it — `{"conversations":0,
"messages":0,"chunks":0,"facts":0,"staff":0,"auth_users":0}` — and the project is back to the
1 chunk / 4 conversations it held before. Neither action reaches Claude or Voyage, so the pass
cost nothing.

---

## Stage 3 PART B — the acceptance run, 29 Aug 2026

### The twelve Stage 2 criteria, re-run

Stage 3 changed the schema, the auth policy and the chat path underneath all of them, so they
were re-run rather than assumed. **Twelve pass.**

| # | Stage 2 criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | CI green on the demonstrated commit, coverage ≥ 80/75 | **Pass** | Run 33261767108 (`28324fc`), all three jobs; coverage **92.01% stmts · 87.84% branches · 94.50% funcs · 93.47% lines** |
| 2 | Schema rebuilds from zero, every table RLS-enabled and forced | **Pass** | CI `supabase db reset --local` replayed **16** migrations; `rls.test.ts` 1 asserts `rowsecurity` **and** `forcerowsecurity` on every table |
| 3 | RLS proven, not claimed | **Pass** | Security suite **37/37** (was 33; +4 from the part-5 additions) |
| 4 | Only allowlisted people get in | **Pass** | `rls.test.ts` 2/3 (anon and non-allowlisted read zero rows from every table); `page.test.ts` "who is let in" (401/403 before any read, write or spend); proven live — a non-admin got 403 from both admin actions |
| 5 | Every Claude call metered and capped | **Pass** | The acceptance run wrote **21 `chat.turn` rows** with model, tokens and cost; cap logic in `client.ts` with unit tests. *Not re-demonstrated live:* tripping the cap deliberately, because that means setting the client's live cap to 0 |
| 6 | The Anthropic key cannot be reached from the browser | **Pass** | `web:check` over the real production build with the **actual key values loaded**, not just shapes: `0 hits — no service role key, no Anthropic key, no Voyage key, no voice prompt, not a dev build` |
| 7 | The voice is traceable | **Pass** | Prompt built from `CLIENT-CONTEXT.md` with per-rule citations; unchanged this stage (`prompt v2026-08-25.4`, hash `796dc50d`) |
| 8 | Voice conformance is a test suite, 100% on the recorded set | **Pass** | `npm run voice`: **24 prompts · 291 checks · 0 failing** |
| 9 | The client would publish at least three of five | **His to answer** | Five outputs generated live on 29 Aug, below |
| 10 | He can open it and talk to it on his phone; 375/768/1280, no horizontal scroll | **Pass** | Browser suite **177/177** across the three widths |
| 11 | Conversations follow him across devices | **Pass** | Keyed on the user, not the device; the live run had two people reading the same workspace memory from separate sessions |
| 12 | `npm run test:regress` green, counts reported | **Pass** | typecheck + lint clean; **1209 passed · 102 skipped**; coverage above |

### The real cost per turn

Measured from `api_usage` rows the acceptance run itself wrote — 27 chat turns in total across
the project's life, split by whether the 3,017-token voice prefix was cached.

| | turns | mean | min | max |
|---|---|---|---|---|
| **warm** (cache read) | 22 | **$0.005653** | $0.002582 | $0.009173 |
| **cold** (cache write) | 5 | $0.015051 | $0.012916 | $0.018199 |

**Stage 2 measured $0.0055 warm. It is now $0.0057.** Memory did not move it materially,
because the recall block is small and sits below the cache breakpoint: 810 rendered characters
on every turn of the live session (≈ 270 tokens ≈ $0.0008 of uncached input), which is inside
the turn-to-turn variance from reply length.

The memory work that happens *around* a turn, amortised:

| Operation | measured mean | how often | per turn |
|---|---|---|---|
| `memory.recall` (Voyage query embed) | $0.000001 | every turn | $0.000001 |
| `memory.summarise` (Haiku) | $0.001664 | one chunk per 10 messages ≈ per 5 turns | $0.000333 |
| `memory.embed` (Voyage document) | $0.000010 | same | $0.000002 |
| `memory.capture` (Haiku) | $0.000852 | only a "remember that…" turn, say 1 in 20 | $0.000043 |
| | | | **≈ $0.00038** |

**All-in ≈ $0.0060 per warm turn.** Projected, assuming one cold turn per session and three
sessions a day (90 cold turns a month):

- **300 turns/month** — 300 × $0.0060 = $1.80, plus 90 cold at +$0.0094 = $0.85 → **≈ $2.65**
- **1,000 turns/month** — 1,000 × $0.0060 = $6.00, plus 200 cold = $1.88 → **≈ $7.90**

**The $50–80 a month the client was told still holds, with six to thirty times the headroom.**
It was never close. The configured caps ($6/day, $60/month) sit far above the projection, which
is the right way round. The one thing that would change this is Stage 5: carousels and ad-copy
variants produce far more output tokens per request than a two-line post, and output is where
the money is.

### Recall rate, and whether 0.45 is the right floor

Part 2 left this open. It could not be answered from live data — the project held **one chunk
and six turns**, all developer testing — so a realistic store was built (14 chunks from the
acceptance session) and probed with 13 requests: ten related to the material, three deliberately
not. Each probe embedded the query exactly as a turn does (`queryText`, current message plus the
previous user message) and asked `match_memory_chunks` **with the floor set to 0**, so the whole
distribution came back and the hit rate at any floor is arithmetic rather than a second paid run.

| floor | related | unrelated | overall |
|---|---|---|---|
| 0.30 | 9/10 | **1/3** | 10/13 |
| 0.35 | 9/10 | 0/3 | 9/13 |
| 0.40 | 9/10 | 0/3 | 9/13 |
| **0.45** | **9/10** | **0/3** | **9/13** |
| 0.50 | 8/10 | 0/3 | 8/13 |
| 0.55 | 7/10 | 0/3 | 7/13 |
| 0.60 | 3/10 | 0/3 | 3/13 |

Related: min 0.2914 · **median 0.5899** · max 0.6426. Unrelated: min 0.1702 · median 0.2674 ·
**max 0.3277**.

**0.45 is right, and it is right by measurement rather than by assertion.** There is a clean gap
between the highest unrelated request (0.3277) and the median related one (0.5899); 0.45 sits in
the middle of it with 0.12 of margin above the worst false positive and 0.14 below the median
true one. Anything from 0.35 to 0.45 gives the identical 9/10 · 0/3; below 0.35 an unrelated
request starts hitting; at 0.60 seven of ten related requests are lost. **Leave it at 0.45.**

The single related miss reproduces the case D46 already documented: **"Make it shorter" with no
previous message scores 0.2914**; the *same* request with the previous user turn prepended
scores **0.6255**. The two-message query is doing real work, and it is the difference between a
miss and a comfortable hit.

**What this measurement is not.** Fourteen chunks, thirteen probes, one subject area, all
written from a single session — so the chunks are more homogeneous than a real year of use, which
probably flatters the related scores. It is a real measurement on real embeddings, not a
simulation, but it is a small one and should be re-run once the client has a few months of
genuine conversations behind him.

### The Voyage rate limit — the material finding of this stage

**The Voyage account allows 3 requests per minute.** Measured directly: sequential embeds four
seconds apart succeed three times and then 429; the HTTP circuit breaker opens after five
consecutive failures and locks the origin out for a further 30 seconds, so one burst costs far
more than the single call that was refused.

A chat turn uses **two** Voyage calls when a chunk is due — one to embed the query for recall,
one to embed the summary. So the whole workspace supports roughly **1.5 turns per minute**
before memory starts degrading. The live acceptance session ran 21 turns at a realistic
copy-iteration pace and **12 of them reported `degraded:["embed"]`**.

Two consequences, and the second is a defect:

1. **Recall silently falls back to facts only.** The reply is still correct and still arrives —
   S3-6 passes, and passed under genuine failure rather than a simulated one — but the semantic
   half of memory is quietly absent.
2. **Summarisation pays for work it then throws away.** `summariseConversation` writes the
   summary with Haiku *first* and embeds *second*; when the embed fails the range is left
   uncovered and no chunk is written, so the money is spent and nothing is kept — and the next
   sweep plans the same range and spends it again. Measured: on the acceptance day
   `memory.summarise` ran and charged while **zero** chunks were written from 21 turns. Every
   chunk that now exists had to be created by a paced, manual flush.

**Neither is a part-5 regression** — both predate it and were invisible because the project had
almost no traffic.

**The second is fixed (D70, 30 Aug, migration `20260830010000`).** The chunk is now written
with a **null embedding** and the range is marked covered, so the same text is never summarised
and charged for twice. It needed no column: `embedding` has always been nullable, `turn_range`
already claims the range, and `match_memory_chunks` already filters `embedding is not null`, so
an unembedded note is invisible to retrieval while still appearing on the Memory page where a
person can read or delete it. One partial index makes the backlog cheap to find and states the
predicate — `embedding is null AND deleted_at is null` — whose second half is what stops a
**tombstone** (whose embedding is null because its content was destroyed on purpose) from ever
being re-embedded.

`backfillChunkEmbeddings` drains that backlog: **no Claude call**, one Voyage call per note,
oldest first. It runs **first** in `sweepIdleConversations`, before any new summarisation, so a
run under a rate limit spends what budget it has making existing notes retrievable rather than
creating more unembedded ones — and it **stops at the first refusal**, because under a rate
limit the next call will be refused too and the rows are exactly as safe as they were. It
re-reads the range's messages to rebuild the header exactly as the summariser would have
(`embeddingText`: title, the Perth date of the range's newest message, the stored audience), so
a note embedded a week late still matches what it would have matched on the day. Available on
its own as `npm run memory -- backfill [--limit N]`.

**The first is still the client's** — the Voyage tier. The system now behaves correctly under
the limit instead of losing work to it, but 3 requests a minute is still 3 requests a minute.

---

## Milestone 4 — Your data on screen · 350 · ← NEXT

Milestone 4 ends in **the client opening the app and seeing his business, not a chat box**:
his numbers and lists up front, the assistant as a panel beside them, the Finance Pipeline live
from GoHighLevel, any lead one tap away, and a lead moved from one stage to the next by his own
hand — the same on his phone as on his laptop (D78, the client's own wording). It is delivered
in five parts (`tasks/TASKS.md` Milestone 4): 1 the screen · 2 leads, pipeline and stages live
from GoHighLevel · 3 lead detail · 4 moving a lead · 5 phone and laptop. Task detail comes with
each part's own brief.

### What "done" means — and why each item is testable rather than subjective

The risk in this milestone is not taste, as it was in Stage 2 — it is a screen that *looks*
live and is not: a count that drifted from GoHighLevel, a stage moved on screen and not in the
CRM, a write that duplicated an opportunity, a retry that moved the same lead twice. So every
criterion below is a **side-by-side with GoHighLevel**, an **HTTP response**, a **database
row**, or a **screenshot at a stated width**.

**The screen (part 1)**

1. **It opens on his data, not on a chat.** The first thing on screen after login is the
   pipeline and the numbers; the assistant is a panel beside them that opens and closes without
   losing the board. *Evidence:* screenshots at 375, 768 and 1280 with the panel closed and
   open; the browser suite asserting both states.
2. **Everything Milestone 3 delivered still works** — Assistant, Memory, Team, private
   conversations: the twelve Stage 2 criteria and S3-1 to S3-12 re-run rather than assumed,
   because the shell they live in is being rebuilt. *Evidence:* the re-run table, as Stage 3
   Part B did it.

**Live from GoHighLevel (parts 2 and 3)**

3. **The board is the Finance Pipeline, read from GoHighLevel** — the ten stages in their
   order (D28), every opportunity in the stage GoHighLevel holds it in, matched on **stage ID,
   never name** (CLIENT-CONTEXT §3 — this account has produced three name-matching traps).
   *Evidence:* the count per stage on screen next to the count from an API read taken in the
   same minute; they agree. The CRM is the source of truth for pipeline state (CLIENT-CONTEXT
   §11): our screen reconciles to it, never the reverse.
4. **The read is scoped and the token never leaves the server.** Reads are by pipeline, never
   account-wide (R22, R25 — the location is shared with an unrelated business); the GHL token
   is read by exactly one server-side module, and the deployed client assets carry no `pit-`
   value — the same rule and the same grep as the Anthropic key (SECURITY §8, T11).
   *Evidence:* `web:check` output extended to the GHL key shape; the browser's network panel for
   a full board load showing requests to our endpoint only.
5. **Click into any lead and see the detail** — the contact, the opportunity, and the ten
   custom fields Stage 1 created (CLIENT-CONTEXT §3), each showing the value GoHighLevel holds.
   **A field GoHighLevel does not have is shown empty, never guessed or defaulted** (SECURITY
   §7). *Evidence:* one lead compared field by field against the GHL record in front of the
   client.
6. **GoHighLevel being down does not take the app down.** With the GHL read failing — timeout,
   5xx, breaker open (CLAUDE.md rule 8) — the board says so in words, and Assistant, Memory and
   Team are unaffected. *Evidence:* the failure state at 375; a chat turn completing while the
   board is in it.

**Moving a lead (part 4)**

7. **He moves a lead and GoHighLevel moves with it.** The client drags — or, on a phone,
   selects — a lead into another stage; a fresh API read of that opportunity shows the new
   stage ID. **The drop is the confirmation — no dialog (D81).** *Evidence:* the before and
   after API reads for one opportunity.
8. **The write is idempotent and never duplicates** (CLAUDE.md rule 9): keyed on the GHL
   opportunity ID; applying the same move twice, or a retry after a timeout, leaves one
   opportunity in one stage and creates nothing. A move is **never blindly retried** after a
   timeout (rule 8) — the opportunity is re-read and reconciled. *Evidence:* the double-apply
   test; the opportunity count in the pipeline before and after, identical.
9. **Every move lands in `audit_log`** with the person as actor, the opportunity ID, and the
   stage ID before and after — never the contact's name, email or phone (rule 20, PII by ID).
   *Evidence:* the row.
10. **A failed write is shown, not swallowed** (rule 7) — if GoHighLevel refuses or times out,
    the board puts the lead back where it was and says why in words. *Evidence:* the failure at
    375 with the card returned to its column; no audit row claiming success.
11. **Only the people who can use the app can move a lead** — the existing boundary holds:
    anonymous `401`, an authenticated account not in `app_users` `403`, a deactivated member
    `403`; a move attempted from the browser straight at PostgREST or the GHL API is
    impossible because neither credential is there. *Evidence:* the three responses; the
    security suite green.

**Phone and laptop (part 5)**

12. **It works the same on his phone as on his laptop** — verified at **375, 768 and 1280**:
    the board, the lead detail and a stage move all usable at every width, no horizontal
    scrolling, inputs at 16px or larger (the iOS zoom trap, `EXISTING-PROTOTYPE.md`), and a
    move on a touch screen reaching the same endpoint as a drag. *Evidence:* screenshots at
    the three widths; a stage move performed live on Ross's own phone.

**Acceptance**

13. `npm run test:regress` green, counts and coverage reported in numbers; migrations replay
    from zero; items 1–12 recorded with their evidence in `docs/MEMORY.md`; the client confirms
    in writing → **350**.

**Not in Milestone 4** (stated so it is not assumed): a drag-and-drop dashboard *builder* —
the screen is fixed, the client uses it, he does not compose it (D82); the assistant acting on
the board on its own — it stays a panel that answers and drafts (D82; D9/D81 still bind any
assistant-initiated write); any write to GoHighLevel other than a stage move; files, documents
and website reading (Milestone 5); whatever "Talking to it, and your day" turns out to be
(Milestone 6, defined at its kickoff); advertising and social (Milestone 7); the Quickli
calculator and the separate finance CRM (D82).

**Client responsibility before this milestone:** confirm the Private Integration token carries
the scopes the board needs — opportunities, contacts, custom fields (SECURITY §12; R21 is the
unreconciled scope list); answer R22 (the shared GHL location) so the pipeline-only scoping is
a decision rather than a guess.

---

## Milestone 5 — Files, documents and research · 250

*Starting points only — tightened at kickoff, as this file has always handled later work.
Website reading, a stage of its own under the six-stage map, sits here (D77).*

- Point it at a URL → it reads the page and stores what it finds, **every field carrying
  `source_url`, `fetched_at`, `extraction_method`, `confidence`** (CLAUDE.md rule 12,
  `SCHEMA.md` §2a). Open any stored fact and see the page it came from; a field that was not on
  the page is `null`, never guessed (SECURITY.md §7). *(Carried from the superseded Stage 4
  starting points below.)*
- Crawler safety: robots.txt honoured, the SSRF cases in SECURITY.md §10 rejected by test, rate
  limited per host, identified User-Agent. **The adversarial-page suite passes** — hidden
  instructions in a page alter nothing and trigger no tool (SECURITY.md §3). Below-threshold
  facts go to the review queue, never to the store; the same page read twice → no duplicate
  rows. *(Carried from Stage 4.)*
- Files and documents the client gives it are stored and read under the same provenance and
  untrusted-input rules as a web page. Which formats, where they live and how they are cleaned
  is defined at kickoff, not here.
- "Research" is the client's word for this milestone and is **not** the parked B2B
  lead-research engine (D23, CLAUDE.md rule 15): nothing here researches organisations or
  people. What it does cover is agreed at kickoff.

### Part 1 — Reading files and documents · built, reviewed, committed and deployed 12 Oct 2026 (CI run 38201198962 green, zero skipped)

*Decisions D83–D92 (`MEMORY.md` §2). The starting point above said "stored and read under the
same provenance and untrusted-input rules as a web page; which formats, where they live and
how they are cleaned is defined at kickoff". This is that definition, as tested.*

| # | Criterion | How it is proven | 12 Oct |
|---|---|---|---|
| F1 | PDF (typed), Word `.docx`, Excel `.xlsx`/`.xlsm`, CSV/TSV, plain text, and photos (JPEG, PNG, WebP, GIF; HEIC where the device can open it) are read. Everything else is refused **with a sentence saying why**, decided on the file's bytes, not its extension | `tests/unit/web/files-*.test.ts` over 38 invented fixtures; `tests/e2e/files.spec.ts` in real Chrome with the real PDF reader | ✅ |
| F2 | A scanned PDF or a photo is read by the model, **only after** the person has been told how many pages and roughly what it costs against today's budget, and has said yes. Never more than 50 pages. A single photo is read without the question | `uploads.test.ts`, `page.test.ts`, e2e "a scan asks first" | ✅ |
| F3 | The original file is **never stored**. The text is kept 30 days, then destroyed by a scheduled job; at once on removal; completely when the conversation is deleted | migration `20261012010000`; `tests/integration/files.test.ts` (CI) incl. `cron.job` exists; `store.test.ts` "no bucket" | ✅ CI; `cron.job` also confirmed on the live database |
| F4 | A file is visible to whoever can see its conversation and to nobody else; the text is readable by no browser session at all. **The cross-user test fails when each clause of the policy is removed** | `tests/security/files.test.ts` (CI); the same SQL replayed on a local PostgreSQL 17 on 12 Oct with the expected result at every step | ✅ CI (security 60 of 60) |
| F5 | The assistant answers from the file. A document longer than the per-turn budget goes as the pages matching the question **and the reply is told it has seen only part**. If nothing could be read, it says so and does not guess from the name | `context.test.ts`, `chat-documents.test.ts`; live: 300-page policy → correct page and figure, and "I've only seen 61 of the file's 300 pages" | ✅ |
| F6 | **Prompt injection:** a document's text is data. It is in the user turn inside a wrapper it cannot forge, never in the system prompt, in a request with no tools. The wrapper test fails without the tag rewrite | `context.test.ts` ("WITHOUT the defang the same document breaks out"), `chat-documents.test.ts`; live recordings held by `injection-live.test.ts` | ✅ |
| F7 | Spend: a page read counts against the same daily and monthly cap as a turn, checked **before** the request. Cap reached mid-document → told plainly, nothing attached, no half file | `chat-documents.test.ts` (image priced at worst case before the call), `page.test.ts`, integration "with the budget spent" | ✅ |
| F8 | An upload is all or nothing and idempotent: interrupted → nothing attached and Try again resumes without paying for a page twice; the same file twice → one attachment; stopped part-way → the server is told to drop it | `uploads.test.ts`, e2e "progress, and what happens when it stops", integration | ✅ |
| F9 | **No file content, and no file name, in any log line, error or trace.** Each upload is logged: who, kind, size, pages, extraction time, outcome | canary tests in `page.test.ts`, `store.test.ts`, `chat-documents.test.ts`; integration log assertion | ✅ |
| F10 | 375 / 768 / 1280: no horizontal scroll, inputs ≥ 16 px, attach reachable by keyboard, progress announced to a screen reader, long names contained, reduced motion respected | `tests/e2e/files.spec.ts` × 3 widths (93 tests); screenshots in `docs/assets/milestone-5/` | ✅ 540 of 540 browser tests |
| F12 | **A table value is never stated under the wrong heading.** A typed-PDF row with empty cells keeps each value in its column (`(blank)` where empty); a row whose columns cannot be settled is marked and quoted raw, never read as a labelled value | `files-pdf.test.ts` on `payslip-text-layer.pdf`, `rate-sheet-tables.pdf`, `rate-sheet-gaps.pdf`; live: uncertain row quoted with "check the original" | ✅ (added in review, 12 Oct) |
| F11 | `npm run typecheck && npm run lint && npm run test:regress` green; CI green with zero skipped | see the 12 Oct entry in `MEMORY.md` for the counts | ✅ CI run 38201198962: unit 1,903 · integration 118 · security 60 · browser 540, zero skipped |

**Measured, not estimated (12 Oct, live, the repo's price table of $3 / $15 per million
tokens — list price is now $2 / $10, so real cost is about a third lower):**

| What | Tokens in / out | Cost |
|---|---|---|
| Reading a typed PDF, Word, Excel, CSV or text file | none — parsed in the browser | $0 |
| One phone photo of a payslip, Sonnet | 3,042 / 230 | $0.0126 |
| The same photo, Haiku (`FILES_VISION_ROUTE=fast`) | 1,867 / 184 | $0.0028 |
| One dense scanned statement page (18 rows, 96 dpi, JPEG q55), Sonnet | 4,267 / 662 | $0.0227 |
| The same page, Haiku | 1,867 / 508 | $0.0044 |
| First question on a one-page payslip | 23 + 1,122 cache-write + 3,017 cache-read / 53 | $0.0060 |
| A follow-up on the same payslip (file cached) | 23 + 4,139 cache-read / 70 | $0.0024 |
| First question on a 300-page policy (61 pages sent, 48,775 chars) | 20 + 24,575 cache-write / 131 | $0.0951 |
| The same question again (same pages, cached) | 20 + 27,592 cache-read / 122 | $0.0102 |

Accuracy on the same run: both models returned every figure on the payslip photo correctly,
and all 18 rows of the scanned statement (72 of 72 fields) matched the generator's values.
The figure shown to the person before a scan is read is $0.027 a page (an estimate chosen
before measuring; measured $0.013–$0.023), and the cap reserves $0.077 a page as the worst
case. A 50-page scan is about $1.14 at the measured dense-page rate: 23% of the $5 daily cap.

### Part 2 — Reading a web page from a link · probed, decided, BUILT and reviewed 12 Oct 2026 — committed on branch `m5-part-2` (`c75be2c`), NOT pushed, NOT deployed, CI not yet run

*The brief asked for a probe before any decision, "from the Supabase Edge runtime, not from
your laptop and not from CI". This section is that probe, in full, and then what was built
on it. The decisions the probe led to were proposed in `MEMORY.md` (12 Oct, "M5 part 2 ·
Part A"), approved by the reviewer the same day with five calls of his own, and are now
D93–D99. The criteria, the Part C mapping, real extracted output and measured cost follow
the probe.*

**How it was run.** A throwaway Edge Function (`web-probe`) holding a fixed list of 25
addresses, answering only to a random token and taking no address as input, was deployed to
the project, called, and **deleted the same hour** (the endpoint answers 404; the five product
functions were not touched). It returned measurements, never a page into a log. Runtime:
`supabase-edge-runtime-1.77.0` (Deno 2.1.4-compatible). Each address was fetched three ways:

- **Sydney, honest agent** — region `ap-southeast-2`, `User-Agent: FunddCommandCentre/1.0
  (+https://fundd.com.au; reads one page when a signed-in user pastes its link)`. This is
  the configuration proposed for the product and is the main column below.
- **Sydney, browser-like agent** — the same region with a Chrome `User-Agent`, once, to
  measure what honesty costs. Not proposed for the product.
- **Default region, honest agent** — no region pinned. The calls were made from the
  developer's machine and the platform ran them in `ap-south-1` (Mumbai).

"Rate figures" counts `d.dd%` in the visible text of the returned HTML; "filled in later"
counts empty elements whose class or data attributes name a rate, price or amount — the
places a script writes a figure after the page loads.

| Target | Kind | Status | After redirects | Type | Size | ms | Text chars | Rate figures in the HTML | Filled in later | robots.txt | Browser-like agent | Default region |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| commbank.com.au `/home-loans/interest-rates.html` | lender rates | 200 | same | text/html | 204 KB | 31 | 39,472 | **3** | **12** | allowed | 200 | 200 |
| nab.com.au `…/all-home-loan-interest-rates` | lender rates | 200 | same | text/html | 762 KB | 66 | 36,528 | 568 | 0 | allowed | 200 | 200 |
| westpac.com.au `…/home-loans/all-interest-rates/` | lender rates | 200 | same | text/html | 318 KB | 44 | 63,334 | 566 | 0 | allowed | 200 | 200 |
| anz.com.au `/personal/home-loans/interest-rates/` | lender rates | 200 | same | text/html | 447 KB | 117 | 47,027 | **3** | **293** | allowed | 200 | 200 |
| macquarie.com.au `/home-loans/home-loan-rates.html` | lender rates | 200 | same | text/html | 204 KB | 62 | 35,103 | 269 | 0 | allowed | 200 | 200 |
| ing.com.au `/rates-and-fees/home-loan-rates.html` | lender rates | 200 | same | text/html | 262 KB | 56 | 27,607 | 36 | **244** | allowed | 200 | 200 |
| bankwest.com.au `/rates/home-loan-rates` | lender rates | 200 | same | text/html | 236 KB | 32 | 15,644 | 214 | 0 | allowed | 200 | 200 |
| rba.gov.au `/statistics/cash-rate/` | RBA cash rate | 200 | same | text/html | 142 KB | 28 | 16,914 | 687 table cells | 0 | allowed | 200 | 200 |
| bankwest.com.au `…/variable-home-loan-reference-rates.pdf` | lender PDF | 200 | same | application/pdf | 91 KB | 109 | 1,856 (1 page) | — | — | allowed | 200 | 200 |
| nab.com.au `…/indicator-rates-for-home-lending.pdf` | lender PDF | 200 | same | application/pdf | 41 KB | 42 | 8,570 (4 pages) | — | — | allowed | 200 | 200 |
| macquarie.com.au `…/MBL-Home-Loans-Terms-and-conditions.pdf` | lender PDF | 200 | same | application/pdf | 371 KB | 159 | 103,745 (45 pages) | — | — | allowed | 200 | 200 |
| realestate.com.au `/property/20-windsor-st-perth-wa-6000/` | property | **429** | same | text/html | 1 KB | 68 | 0 | — | — | allowed | **429** | 429 |
| realestate.com.au `/buy/in-perth,+wa+6000/list-1` | property | **429** | same | text/html | 1 KB | 62 | 0 | — | — | allowed | **429** | 429 |
| domain.com.au listing `…bulwer-street-perth-wa-6000-17652392` | property | 200 | same | text/html | 376 KB | 283 | 6,409 | — | 0 | allowed | **403** | 200 |
| domain.com.au `/property-profile/26-brisbane-terrace-perth-wa-6000` | property | 200 | same | text/html | 484 KB | 962 | 7,951 | — | 0 | allowed | **403** | 200 |
| reiwa.com.au listing `/20-windsor-street-perth-5001474/` | property (WA) | 200 | same | text/html | 252 KB | 761 | 66,160 | — | 0 | allowed | 200 | **403** |
| abc.net.au news article (9 Oct, mortgages) | news | 200 | same | text/html | 402 KB | 76 | 11,922 (article 4,144) | — | 0 | allowed for `*`; **AI assistants disallowed** | 200 | 200 |
| afr.com article (12 Oct) | news, paywall | 200 | same | text/html | 249 KB | 10 | 4,194 (article **1,079**: teaser, then "Already a subscriber?") | — | 0 | allowed for `*`; **AI assistants disallowed** | 200 | 200 |
| thewest.com.au article (premium) | news, paywall | 200 | same | text/html | 402 KB | 262 | 3,203 (article **895**; `isAccessibleForFree: false`, `content_tier: locked`) | — | 0 | allowed | 200 | 200 |
| nabbroker.com.au `/` | login | 200 | same | text/html | 32 KB | 71 | 877 (public landing page) | — | 0 | none (404) | 200 | 200 |
| brokers.bankwest.com.au `/` | login | 200 | **3 hops** → `www.bankwest.com.au/brokers` | text/html | 146 KB | 83 | 4,677 (public landing page) | — | 0 | none | 200 | 200 |
| commbroker.com.au `/` | login | **no answer in 25 s** | — | — | — | 25,002 | — | — | — | no answer | 200 (16 KB login page) | no answer |
| canstar.com.au `/home-loans/` | comparison | 200 | same | text/html | **1.82 MB** | 69 | 70,559 | 50 | 0 | allowed | 200 | 200 |
| rba.gov.au `/this-page-does-not-exist-fundd-probe/` | missing page | **404** | same | text/html | 18 KB | 27 | 1,797 (an error page) | — | 0 | allowed | 404 | 404 |
| `fundd-probe-does-not-exist-9d3f7a.com.au` | no such domain | **DNS failure** in 12 ms | — | — | — | — | — | — | — | — | DNS failure | DNS failure |

The three PDFs were then put through Part 1's own reader (`npm run files -- extract`): all
three are typed PDFs and every page came out as text, none needing vision.

**What the probe found.**

1. **Of the 25 addresses, 20 returned a page, and 15 of those carried their useful content
   in what was returned** — four of seven lender rate pages, the RBA page, all three PDFs,
   REIWA, both Domain pages, ABC, the two broker landing pages, Canstar. No renderer is
   needed for those. The other five that returned a page are items 2 and 7; the five that
   did not are realestate.com.au twice, CommBroker, the missing page and the missing domain.
2. **Three of the seven lender rate pages return the page but not the rates: CBA, ANZ and
   ING.** The headings, product names and conditions are in the HTML; the figures are empty
   elements a script fills in (`<span class="productdata" data-item="rate"></span>`). Two of
   the big four. Nothing in the probe set was an empty shell.
3. **realestate.com.au refuses every request (429, Kasada)** whatever the agent says it is.
   A renderer would not change that without evading the block, which is not proposed.
4. **The region decides what Australian sites answer.** REIWA answered 200 from Sydney and
   403 from Mumbai. A call from the client's browser runs in the region nearest him; a call
   from anywhere else does not. The read has to be pinned to `ap-southeast-2`
   (`forceFunctionRegion`, verified).
5. **Pretending to be a browser loses more than it gains.** It turned Domain from 200 into
   403 and gained only a broker login page. The honest agent is not the cost.
6. **robots.txt permits every path in the set for an unnamed agent** — and three sites (ABC,
   AFR/Nine, realestate.com.au) separately tell AI assistants acting for a user
   (`ChatGPT-User`, `Claude-User`, `Perplexity-User`, `anthropic-ai`) to stay out entirely.
   CBA and ING do the opposite and name them as welcome.
7. **Paywalls answer 200.** AFR returns 1,079 characters and marks itself free
   (`isAccessibleForFree: true`); The West marks itself locked. Status alone will not catch
   either.
8. **A missing page answers with 18 KB of ordinary-looking HTML.** The status is the only
   thing that says it is an error.
9. **The runtime can be guarded.** `Deno.resolveDns` works; a certificate is checked against
   the name (a connection under the wrong name was refused); the fetch decompresses and the
   byte count read is the decompressed size (145,383 bytes, both size headers stripped), so
   a cap on the stream is a cap on a compression bomb. Loopback is routable from inside the
   function (connection refused on port 80), the cloud metadata address is not (`EINVAL`),
   and `http://2130706433/` and `http://0x7f.1/` are both loopback by the time the fetch
   sees them — so the guard matters and has to judge the parsed address, not the string.
10. **A 20 MB binary reply passes through the function gateway** (5, 12 and 20 MB tried).

**Not probed, and why:** a page that needs a login the developer does not have (no
credential exists for any broker portal, and none is needed for this part — what is measured
is the public page in front of each); Google Drive and OneDrive links (Part 3); any page on a
phone (the fetch is server-side and does not depend on the device).

**Built, 12 Oct 2026 — after the reviewer approved the plan the same day (D93–D99).**

| # | Criterion | How it is proven | 12 Oct |
|---|---|---|---|
| W1 | He pastes a link and the assistant reads **that one page**. Nothing is read because a link appeared: he presses "Read this page", or answers the one question asked on Send. No search, no crawl, no link on the page followed | `tests/unit/web/links.test.ts`, `uploads-links.test.ts`; `tests/e2e/links.spec.ts` ("nothing is opened until he says so", "a link he did not mean to be read") — the scripted server records every fetch it is asked for | ✅ |
| W2 | **SSRF.** Private, reserved, loopback, link-local and cloud-metadata addresses are refused — written as a name, a number in any encoding, or reached by a redirect; the guard runs on every hop. **The tests fail when the guard is removed** | `tests/unit/pages/guard.test.ts` (171, table-driven); `tests/unit/pages/fetch.test.ts` — each case run again with a guard that passes everything, and then the address is requested | ✅ |
| W3 | The fetch is bounded: 10 s / 20 s, five hops, 5 MB a page and 20 MB a document counted on the decompressed stream; over the cap is refused, never truncated and read. Ten reads a minute per person, two seconds between reads of one site, one id one read | `fetch.test.ts` incl. a real HTTP server (compression bomb, endless body, stalled body); `page-fetch.test.ts` "the limits"; migration replayed on PostgreSQL 17 | ✅ (the database half first runs in CI) |
| W4 | robots.txt honoured, including rules addressed to AI assistants acting for a user; an unreadable robots file means the page is not read; the agent names itself with a contact address | `tests/unit/pages/robots.test.ts` (57), `fetch.test.ts` | ✅ |
| W5 | **A page is data, never instructions — in the same wrapper part 1 built.** In the user turn, inside a wrapper it cannot forge, never in the system prompt, in a request with no tools; its site and read time are written by us. **Hidden markup:** comments, `alt`, `aria-label`, off-screen and zero-opacity text never reach the model | `context-web.test.ts`, `chat-pages.test.ts`, `files-html.test.ts` — 59 hidden canaries (hidden blocks, and text hidden inside a visible sentence, table or tab), none comes out, and a naive tag-stripper passes ≥ 25 of them. **The reader's one fallback has its own canary** (`injection-revealed.html`): 20 more hidden any other way do not come out, and the instruction hidden by `opacity:0` — which the fallback does read — reaches the request once, inside the wrapper, with its forged tags rewritten. **With the tag rewrite removed, 13 tests fail** (run 12 Oct) | ✅ |
| W6 | **If a page cannot be read it says so plainly.** Every refusal is a sentence with the reason and the way round. Never a guess from the address, never an answer from memory, never a partial read presented as whole | every code in `src/lib/pages/limits.ts` has a sentence (`page-fetch.test.ts`); "read in part" and "read as the site sent it" on screen and in the model's context (`context-web.test.ts`, `links.spec.ts`); the unread-link rule (`chat-pages.test.ts`); live, below | ✅ |
| W7 | A PDF, Word, Excel, CSV, text file or image at a link goes through **part 1's readers** — no second extraction path | `sniff.ts` / `extract.ts` unchanged for those kinds; `files-html.test.ts` "through the one door"; e2e "a PDF at a link is read by the same reader" (pdf.js in Chrome); three lender PDFs below | ✅ |
| W8 | Provenance is the server's: address, site, read time, size and hash come from its own record of the fetch; an attachment with no record, somebody else's, different bytes or an old one attaches nothing | `page-fetch.test.ts` "begin — a page is attached only against the bytes the server fetched"; `tests/integration/web-pages.test.ts` | ✅ unit · CI for the database |
| W9 | Retention and freshness: a page's text 24 hours, a document from a link 30 days, the raw HTML never; nothing cached; the read time on screen and in front of the model with the time now; read again replaces, or refreshes if unchanged; a removed page names nothing | migration `20261012020000`; `page-fetch.test.ts`; `web-pages.test.ts` (CI); SQL replay | ✅ unit · CI for the database |
| W10 | **No page content in a log line, an error message or a trace; an address is logged as its host only** | canaries in the text, title, path and query through every path: `page-fetch.test.ts` "logging", `fetch.test.ts` (the fetcher has no logger), `web-pages.test.ts` (CI) | ✅ |
| W11 | RLS: no policy was changed. A page's address is visible to whoever can see the conversation and nobody else; the record of fetches is readable by no session, its owner included. **Each fails without its protection** | `tests/security/web-pages.test.ts` (CI); its SQL replayed locally with the expected answer at every step | ✅ replay · CI is its first run |
| W12 | 375 / 768 / 1280: no horizontal scroll, inputs ≥ 16 px, every new control a 44 px target and reachable by keyboard, progress shown on a slow connection, the read and any refusal announced, a 1,400-character address and a long title contained, reduced motion respected | `tests/e2e/links.spec.ts` × 3 widths (69 tests); screenshots `docs/assets/milestone-5/links-*.png` | ✅ 609 of 609 browser tests, zero skipped |
| W13 | `npm run typecheck && npm run lint && npm run test:regress` green; CI green with zero skipped | the 12 Oct "M5 part 2 · build" entry in `MEMORY.md` | ✅ local, after review round 1: exit 0 — unit 2,742 passed (187 stack-backed tests skipped, no Docker) · coverage 92.5% lines / 88.94% branches · browser 609 · build checks clean. **CI not run — nothing is pushed** |

**Every case in the brief's Part C, and where it is tested.**

| Part C | Case | Test |
|---|---|---|
| SSRF | `localhost`, `127.0.0.1`, `::1`, `0.0.0.0` | `guard.test.ts` "refused, each for its own reason" + `classifyAddress` |
| SSRF | Private ranges and their IPv6 equivalents | `guard.test.ts` `classifyAddress` (every range, both families; IPv4-mapped and NAT64 judged by the address inside; IPv4-compatible, 6to4 and Teredo refused outright) |
| SSRF | Link-local, including the cloud metadata address | `guard.test.ts` (named case `169.254.169.254`, and `64:ff9b::a9fe:a9fe`) |
| SSRF | A hostname that resolves to any of the above | `guard.test.ts` `checkResolvedAddresses`; `fetch.test.ts` "nothing reaches the network through the guard" — and "WITHOUT the guard the same private-resolving name is requested" |
| SSRF | A public hostname that redirects to any of the above; the guard on every hop | `fetch.test.ts` "redirects — the guard runs again on every hop" — and "WITHOUT the guard that redirect is followed to the internal address" |
| SSRF | **A hostname that resolves differently between the check and the fetch** | **Not prevented, and no test can show it prevented.** Made useless: https only, certificate checked against the name (probed on the runtime, finding 9 above; SECURITY §10). Pinning the connection is possible and was not built |
| SSRF | `file://`, `ftp://`, `data:`, `javascript:`, `gopher://` | `guard.test.ts` (each by name) |
| SSRF | Embedded credentials | `guard.test.ts`; shown back without the password: `links.test.ts`, e2e |
| SSRF | A non-standard port | `guard.test.ts` |
| SSRF | Decimal, octal or hex encoded IP | `guard.test.ts` (`2130706433`, `0x7f000001`, `0x7f.0.0.1`, `0x7f.1`, `017700000001`, `0177.0.0.1`, `127.1`, and the metadata address as `2852039166`) |
| SSRF | A redirect loop | `fetch.test.ts` |
| SSRF | A very long redirect chain | `fetch.test.ts` (stopped at five) |
| Response | A page that never finishes loading | `fetch.test.ts` (scripted, and "a body that stops arriving" on a real server) |
| Response | Claims one size and sends more; the cap enforced while streaming | `fetch.test.ts` "cut off at the cap, not at the claim" |
| Response | A multi-gigabyte response | `fetch.test.ts` "having read only that much" |
| Response | A compressed bomb | `fetch.test.ts`, real server: 60 MB of zeros in 58 KB, counted expanded |
| Response | 404, 403, 500, 429 | `fetch.test.ts` `classifyStatus`; each sentence in `page-fetch.test.ts` |
| Response | No content type, or a lying one | `fetch.test.ts` ("a page of text that CLAIMS to be a PDF", "no content type is still a page"); `files-html.test.ts` (the bytes decide) |
| Response | A non-UTF-8 encoding | `files-html.test.ts` "bytes to characters" (BOM, header, `<meta>`, windows-1252, Shift_JIS) |
| Response | A non-Latin script; right to left | `files-html.test.ts` on `non-latin.html`, `rtl.html`; e2e long title in three scripts |
| Page | Instructions aimed at the assistant, incl. comments, `alt`, `aria-label`, off-screen, zero opacity | `files-html.test.ts` "text a reader of the page never sees" (59 places, incl. hidden inside a visible sentence or table) and "a page that fades its WHOLE self in" (the fallback's shape: 20 more, and the opacity-hidden instruction that IS read); `context-web.test.ts` three PROMPT INJECTION groups; `chat-pages.test.ts` (two whole turns); `web-pages.test.ts` (CI); e2e "a page that hides instructions in its markup", "a page that fades itself in" |
| Page | Almost entirely tables | `files-html.test.ts` on `rate-table.html`, `rate-tabs.html`, `layout-table.html`; e2e asserts the rows sent |
| Page | One large image, no text | `files-html.test.ts` on `image-only.html` → `page_no_text` |
| Page | Behind a cookie or consent wall | `consent-wall.html` → refused; `cookie-banner.html` → banner dropped, page read |
| Page | Mostly navigation and boilerplate | `mostly-nav.html` → the content; `only-nav.html` → refused |
| Page | *(added in review)* Nested deeper than any real page, to put text where "hidden" is not tracked | `files-html.test.ts` "hostile structure" → refused whole, `page_malformed` |
| Page | Empty, and valid HTML with no body text | `fetch.test.ts` "an empty 200"; `no-body-text.html` → `page_no_text` |
| Page | `<meta refresh>` or a JavaScript redirect | `meta-refresh.html`, `js-redirect.html` → `page_forwards`, never followed |
| Run | The same URL twice in one conversation | `uploads-links.test.ts` (one read; read again); `page-fetch.test.ts` (replaced / unchanged); e2e "read again" |
| Run | Several URLs in one message | `links.test.ts`; e2e "several links" |
| Run | A URL pasted while a read is in flight | `uploads-links.test.ts` "a second link waits its turn", "behind a file being attached" |
| Run | The spend cap reached mid-read | A page costs no model call to read. On the question: `chat-pages.test.ts` "the spend cap is reached: told so, nothing saved, no partial answer". A scan at a link takes part 1's path (`uploads.test.ts`, `page.test.ts`) |
| Run | The model call times out after the fetch succeeded | `chat-pages.test.ts` (retryable, nothing saved, the page still there) |
| Run | A page removed while a question about it is in flight | `chat-pages.test.ts` |
| Run | He pastes a URL and asks nothing | **Decided: not read until he presses** (D94). `links.test.ts` (`onlyLinks`, the question's second wording); e2e "a message that is only a link" |
| Interface | Progress on a slow connection | e2e "a slow page: progress is shown and announced, Send waits, and it can be stopped" |
| Interface | 375 / 768 / 1280, no horizontal scroll | every e2e test ends on `expectNoHorizontalScroll` |
| Interface | Inputs at 16 px | e2e "text inputs stay at 16px" |
| Interface | A very long URL or title | e2e "a very long address and a very long title" |
| Interface | Screen reader hears a read and a refusal | e2e — the live region's text asserted for both |
| Interface | Reduced motion | e2e "reduced motion" |

**What the reader makes of real pages.** The bytes are the ones the Edge runtime fetched from
Sydney during the probe; the reader is the app's own, run through `npm run pages -- extract`.

| Page | Bytes | Result | Parts | Characters | Figures missing | Reader time |
|---|---|---|---|---|---|---|
| NAB — all home loan rates | 779,803 | read | 5 | 22,831 | 0 | 61 ms |
| Westpac — all interest rates | 325,346 | read | 9 | 45,422 | 0 | 66 ms |
| Macquarie — home loan rates | 208,604 | read | 5 | 22,449 | 0 | 75 ms |
| Bankwest — home loan rates | 241,362 | read **as the site sent it** (every section starts at `opacity:0`); says so on screen and to the model | 5 | 11,188 (11,161 of the page, and the reader's own first line) | 0 | 25 ms |
| RBA — cash rate target | 145,383 | read | 3 | 16,235 | 0 | 32 ms |
| ANZ — home loan rates | 457,924 | **read in part** | 6 | 31,953 | **154** | 57 ms |
| CBA — home loan rates | 208,547 | **read in part** | 10 | 32,303 | **12** | 39 ms |
| ING — home loan rates | 268,773 | **read in part** | 2 | 9,233 | **144** | 59 ms |
| Canstar — home loans | 1,908,273 | read | 18 | 55,013 | 0 | 139 ms |
| REIWA — a sold listing | 258,441 | read | 3 | 5,544 | 0 | 31 ms |
| Domain — a rental listing | 385,506 | read | 1 | 1,722 | 0 | 25 ms |
| ABC News — an article | 411,342 | read by the reader; **refused by robots.txt before it is fetched** (D96) | 3 | 5,873 | 0 | 29 ms |
| AFR — an article | 254,847 | **refused: paywall** | — | — | — | — |
| The West — an article | 415,051 | **refused: paywall** | — | — | — | — |
| NAB — indicator rates (PDF) | 41,923 | read by part 1's reader | 4 pages | 8,573 | — | 751 ms |
| Bankwest — reference rates (PDF) | 92,731 | read by part 1's reader | 1 page | 1,856 | — | 683 ms |
| Macquarie — terms and conditions (PDF) | 380,030 | read by part 1's reader | 45 pages | 103,789 | — | 895 ms |

*Re-measured after review round 1 (the hidden-text fix):* every rate count is unchanged —
NAB 513, Westpac 453, Macquarie 209, Bankwest 214 — and so is every character count above
except ABC's, which lost a duplicated timestamp that sat in an `aria-hidden` span. ANZ
gained a sentence that had been lost ("The information on this page does not apply to ANZ
Plus products" began with a hidden non-breaking space, which used to hide the whole
sentence) and lost two tab headings ("Variable interest rates", "Fixed interest rates":
its tab list sits inside an `aria-hidden` wrapper — an open question for the reviewer,
SECURITY §3).

Four excerpts, exactly as stored and as the model is given them:

```
NAB · part "All home loan interest rates"
## Variable home loan interest rates
### NAB Base Variable Rate Home Loan
Table: Table of interest rates for different home loan types of a NAB Base Variable Rate Home Loan.
(blank)	Interest rate	Comparison rate
Principal and interest	6.69% p.a.	6.69% p.a.

RBA · part "Cash Rate Target"
Effective Date	Change% points	Cash rate target %	Related Documents
30 Sep 2026	+0.25	4.60	Statement
12 Aug 2026	0.00	4.35	Statement Minutes
17 Jun 2026	0.00	4.35	Statement Minutes

ANZ · part "Home loan interest rates"  — read in part
LVR 80% or less	[not in the page as fetched]disclaimer	[not in the page as fetched]
LVR more than 80%	[not in the page as fetched]disclaimer	[not in the page as fetched]
### ANZ Simplicity PLUS home loan
A no-frills home loan with a competitive interest rate and basic features.

REIWA · part "20 Windsor Street, Perth WA 6000"
# 20 Windsor Street, Perth WA 6000
Sold price: $1,520,000 Sold: 11 Mar 2026
4 Bedrooms
1 Bathroom
Landsize 350m2

Bankwest reference rates (PDF) · "Page 1"
Variable Home Loan
Reference Rates.
Rates effective from 09 October 2026.
Standard Variable Reference Rate - SVR Owner Occupied Principal and Interest	9. 25 % p.a.
```

*(The Bankwest PDF's own text layer splits that figure as "9. 25 %"; the reader does not
repair what a document's text says.)*

**Measured, not estimated (12 Oct, live, on the same price table as part 1's figures
above).** Reading a page is no model call. The cost is the question:

| What | Sent | Tokens in / out | Cost |
|---|---|---|---|
| Reading a web page, or a typed PDF at a link | — | none — fetched by the function, read in the browser | $0 |
| First question, RBA cash rate (16,235 chars) | 16,800 chars | 20 + 14,899 cache-write / 128 | $0.0579 |
| A follow-up on it (page cached) | | 20 + 14,899 cache-read / 122 | $0.0064 |
| First question, NAB rates (22,831 chars) | 23,532 | 34 + 12,839 cache-write + 3,017 cache-read / 133 | $0.0511 |
| A follow-up | | 34 + 15,856 cache-read / 136 | $0.0069 |
| First question, ANZ rates, read in part (31,953 chars) | 32,806 | 26 + 13,125 cache-write + 3,017 cache-read / 142 | $0.0523 |
| A follow-up | | 26 + 16,142 cache-read / 169 | $0.0075 |
| First question, Macquarie T&Cs PDF (103,789 chars → the 48,000 budget) | 48,481 | 16 + 17,934 cache-write + 3,017 cache-read / 330 | $0.0732 |
| A follow-up | | 16 + 20,951 cache-read / 337 | $0.0114 |
| A message with a link that was never read | no page | 324 + 3,017 cache-read / 146 | $0.0041 |

So one page costs **about five to seven cents for the first question and about one cent for
each follow-up** while it is cached. The dearest measured here is $0.073, for a document cut
to the 48,000-character budget (part 1 measured $0.095 for a denser one at the same budget);
the budget is what bounds it. The first RBA figure includes writing the voice prefix to the
cache (the cache was cold); the others found it warm.

What the replies said, on the same run: RBA — "The cash rate target is currently 4.60%. It
last changed on 30 Sep 2026 … as read on 12 Oct 2026". NAB — "6.69% p.a., with a comparison
rate of 6.69% p.a. … accurate when the page was read today, but rates can change". ANZ —
"That figure isn't available — the ANZ page was read in part … Reading the page again won't
fix it … save the page as a PDF and attach it, or paste the rate in". A link never read —
"I haven't opened that page … Pressing "Read this page" beside the message box will have it
read … I won't guess at it or use a figure from memory". **These show what the model did on
12 Oct; the tests above are the proof** (SECURITY §3 says why a live reply is not one).

**Pages this client will paste that cannot be read**, in the order he is likely to meet them:

1. **The rate figures on CBA, ANZ and ING.** Read in part: everything but the numbers. Two
   of the big four. NAB, Westpac, Macquarie and Bankwest are complete.
2. **realestate.com.au — every page.** It refuses any automated reader (429). Domain and
   REIWA read.
3. **Paywalled news: AFR, The West.** Refused as a paywall. Only the teaser is public.
4. **Sites that tell AI assistants to stay out: ABC News** on the probe set, and any other
   that does. Refused before the page is asked for (D96).
5. **Anything behind a login:** a lender's broker portal, an aggregator's platform, his own
   CRM, a Google Doc that is not public. The assistant cannot sign in and is not given a way.
6. **A page drawn entirely by script,** with nothing in what the site sends. None was met on
   the probe set; it would be refused as having no readable text.

The way round is the same for all six and the product says it each time: open the page
himself, save it as a PDF, attach it — part 1 reads that — or paste the text.

**Could not be verified from this machine:** the two stack suites and the migration from
zero (no Docker — CI is the first run; their SQL was replayed on PostgreSQL 17, 85
assertions) · a real phone · a real screen reader (the live region's text is asserted, not
heard) · the region pin from the deployed app (verified with `curl` during the probe) · a
signed-in read on the live app (it writes to the production database, and nothing is
deployed) · how often the three script-filled lenders change their markup.

---

## Milestone 6 — Talking to it, and your day · 350

*Starting points only. The milestone's name is the client's wording; its content is defined at
kickoff and written here before any part is briefed, so the name is not read as more than it
says.*

- What "talking to it" means in practice, and what "your day" shows, are agreed with the client
  at kickoff.
- Whatever it is, it runs through the same server-side path, the same caps and the same
  `api_usage` metering as the chat (Stage 2 items 5–6) and the same voice rules (`VOICE.md`);
  no new credential reaches the browser.
- Verified at 375 / 768 / 1280 and live on the client's phone, as every milestone is.

---

## Milestone 7 — Advertising and social · 300

*Starting points only — tightened at kickoff. Moved later in the order at the client's request
on 5 Sep (D79).*

- Generated ad copy and social posts follow CLIENT-CONTEXT §9 (Green Brain hook, Red Brain
  body, Rule of One, Meta headline under 28 characters, Google ad structure); the voice suite is
  extended to each format, 100% pass on the recorded set. *(Carried from the superseded Stage 5
  starting points; which formats belong here and which in Milestone 8 is settled at kickoff.)*
- Nothing is published under the client's name from a draft that has not passed review
  (CLAUDE.md rule 14, R7). Where an approved draft goes — the GHL social planner is connected
  (MEMORY.md 12 Aug), Meta ad account access was granted 22 Aug — is a dated decision at
  kickoff; nothing publishes without one.
- Meta: Refi Pixel + Conversions API (D31) stay the measurement path; whether the pixel install
  survived the funnel's move to `ross.fundd.com.au` (D80) is checked here if not before.

---

## Milestone 8 — Content and handover · 150

*Starting points only — tightened at kickoff.*

- Content: drafts, approvals and check results stored and visible on the dashboard; carousels
  and post series in the voice. *(Carried from Stage 5; the split with Milestone 7 is settled at
  kickoff.)*
- Handover, carried from the superseded Stage 6 starting points: monitoring — daily health
  check, cost rollup, stale-data and token-expiry alerts — verified by a real failure and a
  real cap trip; full regression green and the manual QA (`TESTING.md` §9) done; the runbook
  walked through end to end (rotate a key, restore a backup, re-run a failed job, unpause a
  capped one); the security checklist (`SECURITY.md` §13) with every box ticked, **R18 closed
  in writing**; every account and key transferred to the client, developer vault access revoked
  in writing, all keys rotated; a recorded walkthrough of daily use.
- Where n8n lands (D71 put it at "Stage 6") is decided at this kickoff or earlier — open.

---

## ~~Stage 4 — Website reading and storage · Payment 4 of 5 (198)~~ — SUPERSEDED 12 Sep 2026 (D77): website reading is part of Milestone 5, not a milestone of its own

*Kept in place for the record. The starting points below were carried into Milestone 5 above.*

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

## ~~Stage 5 — Content, carousels, ad copy · (paid within the final 528)~~ — SUPERSEDED 12 Sep 2026 (D77): see Milestones 7 and 8

*Kept in place for the record. Carried into Milestones 7 and 8 above; the split is settled at
their kickoffs.*

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

## ~~Stage 6 — Monitoring, testing, docs, handover · Payment 5 of 5 (528, covering Stages 5–6)~~ — SUPERSEDED 12 Sep 2026 (D77): handover is Milestone 8

*Kept in place for the record. Carried into Milestone 8 above.*

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

Each is available as a separate, separately-priced engagement. The first four below were
**stated to the client in writing** alongside the milestones (D82):

- **A drag-and-drop dashboard builder.** Milestone 4 is a fixed screen the client uses, not one
  he composes
- **Agent software that carries out work on its own.** The assistant answers and drafts; any
  write it initiates is governed by D9/D81
- **The Quickli lending calculator** — no open API, partner access only
- **The client's separate finance CRM** — same reason (was "revisit when raised", 08 Aug)
- **The B2B outbound lead-research engine** — organisation research, website discovery,
  decision-maker extraction, email verification, the two scoring rubrics and the Google Sheets
  export. Never asked for by the client; parked, not deleted (D23)
- Outbound email sending, sequencing or inbox warming
- Scheduled social *insights* tracking (Instagram / Facebook / LinkedIn metrics) — parked, R3
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
