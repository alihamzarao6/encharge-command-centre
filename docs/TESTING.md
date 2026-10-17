# TESTING.md — Test Strategy

The system runs unattended and feeds a CRM the client acts on. Untested code here does not
fail loudly — it quietly writes wrong data for weeks. Testing is not overhead on this
project; it is the deliverable.

---

## 1. Test pyramid

| Level | Scope | Speed | Runs |
|---|---|---|---|
| Unit | Pure functions in `src/lib/` | < 5s total | Every save, every commit |
| Contract | External API adapters vs recorded fixtures | < 20s | Every commit |
| Integration | Real local database, seeded | < 2 min | Pre-push, CI |
| Browser | The built web app in Chrome at 375 / 768 / 1280 against a scripted Supabase (`tests/e2e/`) | < 2 min | Every commit (CI `browser` job) |
| Workflow | n8n workflow JSON executed with test payloads | < 5 min | Pre-phase-signoff |
| Regression | Everything + golden set + security suite | < 10 min | **Before every phase sign-off** |

**Rule: no external network call in unit or contract tests.** Ever. All HTTP intercepted by
`msw` and served from `tests/fixtures/`.

---

## 2. What must have unit tests

Every one is a pure function in `src/lib/`, and every one has a bug class only a test catches:

| Module | Must test |
|---|---|
| `routing/leadType` | **All eight lead types.** A consumer type must never route to the crawler |
| `normalize/orgName` | Legal suffix stripping (Pty Ltd, P/L), case, punctuation, unicode |
| `normalize/domain` | `www.` stripping, subdomains, punycode, trailing dots, ports |
| `normalize/phone` | AU mobile/landline → E.164, area codes, international prefixes |
| `dedupe/hash` | Same org via different URL forms produces the same hash |
| `dedupe/fuzzy` | Trigram threshold: true matches vs false positives on similar names |
| `email/patterns` | first.last, flast, firstl, f.last, first, initials — and refusing to guess |
| `email/verify` | Syntax edge cases, role-account list, disposable list, MX result handling |
| `discovery/blocklist` | Directory and aggregator domains rejected, real sites kept |
| `crawler/urlSafety` | Every SSRF case in SECURITY.md section 10 rejected |
| `crawler/sanitize` | Hidden text, script tags, comments, zero-width chars removed |
| `extract/agentCount` | Team pages with 1, 3, 12 agents; pages with none; false positives from testimonials |
| `extract/inhouseFinance` | "our finance partner", named broker on team page, bank ownership, and clean negatives |
| `ranking/prefilter` | Every hard reject from CLIENT-CONTEXT.md section 7, both rubrics |
| `ranking/score` | Weighted dimensions, tier boundaries at exactly 40/60/80, both rubrics |
| `llm/parse` | Valid JSON, JSON with prose wrapper, markdown fences, malformed, empty *(extraction stages)* |
| `llm/schemas` | Every Zod schema accepts valid and rejects each invalid shape *(extraction stages)* |
| `llm/client` | Cap refuses **before** fetch (fetch count 0, no row); one success = one `api_usage` row with real tokens; timeout/transport after send records the reservation and is **not** retried; 429/529 envelopes retried, 4xx not; key in no log line / result / error. **Shipped 25 Aug** — `tests/unit/llm/client.test.ts` |
| `llm/chat` | 401 / 403 / 503 before any Claude call; own vs workspace vs other's-private conversation; every Claude failure mapped to a status the UI can render. **Shipped 25 Aug** |
| `llm/store` | `spentSince` paginates past 1,000 rows; every column written; PostgREST and transport failures typed. **Shipped 25 Aug** |
| `llm/spend`, `llm/pricing`, `llm/config`, `llm/response` | Cap arithmetic at the boundary, UTC windows, list-price cost to 6 dp, unpriced model refused, caps required, Zod response parse. **Shipped 25 Aug** |
| `voice/conformance` | Every check proven on text that must pass AND text that must fail (a check that cannot fail is not a check); part labels are not numbers; `Note:` lines are not copy. **Shipped 25 Aug** — `tests/unit/voice/checks.test.ts` |
| `voice/prompt`, `voice/rules` | Every rule has a source and a unique id; every rule text is in the assembled prefix verbatim; every rule id is in `docs/VOICE.md`; prefix ≥ 1,024 tokens for caching; hash deterministic; below-breakpoint block uncached and bounded. **Shipped 25 Aug** |
| `files/text`, `files/context`, `files/select`, `files/rules` | Names and text stripped of hiding places (bidi, zero-width, tag block, controls) while every visible script survives; a document cannot forge its wrapper — **and breaks out when the tag rewrite is removed**; the block is whole or an excerpt that says so; the cached voice prefix is byte-identical with and without document rules. **Shipped 12 Oct** — `tests/unit/files/` |
| `files/page`, `files/store`, `files/vision` | Every action of the files endpoint: who may attach, read and remove; every refusal a sentence; replays answered from the record; a canary in the text and in the file name appears in **no** log line or error; the adapter's arguments, columns and error codes equal the migration's (read from the SQL, because this machine has no stack). **Shipped 12 Oct** |
| `files/probe` | The terminal's request equals the chat handler's own; a reply that IS the planted word or claims an email was sent is obedience, one that mentions and refuses it is not; `tests/unit/files/injection-live.test.ts` holds the recorded live replies to that and fails when the request built today is no longer the one recorded. **Shipped 12 Oct** |
| `web/lib/files/*` (the readers) | Each format against invented fixtures (`tests/fixtures/files/`, regenerate with `make_fixtures.py`): rows and columns intact, formula results and code-computed totals, dates, hidden sheets, macros not run, zip bombs and nested archives refused, password / truncated / empty / wrong-extension files, non-Latin and right-to-left text. Run under Node with the real pdf.js; the canvas half (`browser.ts`) runs in real Chrome in `tests/e2e/files.spec.ts`. **Shipped 12 Oct** — `tests/unit/web/files-*.test.ts` |
| `pages/guard` | **The SSRF guard, on its own (SECURITY §10).** Table-driven over every form an address can take: scheme, port, credentials, every encoding of a number (decimal, hex, octal, short, IPv6, mapped, NAT64, 6to4), single-label and internal names, and every reserved range in both families — with the metadata address named. No network. **Shipped 12 Oct** — `tests/unit/pages/guard.test.ts` (171) |
| `pages/robots` | RFC 9309: groups, longest match, `*` and `$`, our own token before `*`; a disallow addressed to an AI assistant acting for a user applies to us; no file means allowed, a failing file means not read. **Shipped 12 Oct** — `tests/unit/pages/robots.test.ts` (57) |
| `pages/fetch` | The guarded fetch with every dependency injected: the guard on every hop, loops, the hop cap, timeouts, one retry on transport failure only, the per-host breaker, status → reason, the size cap on the stream. **Each SSRF case is run again with the guard replaced by one that passes everything and must then reach `fetch`** — the tests fail without the protection. One block uses a real HTTP server the test starts on loopback (a 60 MB compression bomb, an endless body, a body that stops arriving). **Shipped 12 Oct** — `tests/unit/pages/fetch.test.ts` (118) |
| `files/page` (`fetch_page`), `files/context` (pages), `llm/chat` (links) | The endpoint's new action: who may read, every refusal a sentence, the per-person limit and the per-site gap, **one id opens one page once**, an attachment held to the server's record of the fetch (none, a stranger's, other bytes, too old), re-read replaces or refreshes; canaries in the text, the title, the path and the query appear in no log line or error. The page reaches the model in the same wrapper with `source` and `read` written by us; a hostile title cannot leave it; the link rule is sent when a message has a link and never otherwise. **Shipped 12 Oct** — **The fallback's canary:** the page that fades itself in, from its bytes to the request — its hidden instruction once, inside the wrapper, its forged tags rewritten, nothing of it in the system prompt, no tools — and the same page breaking out when the rewrite is taken away. **Shipped 12 Oct** — `tests/unit/files/page-fetch.test.ts` (67), `context-web.test.ts` (41), `tests/unit/llm/chat-pages.test.ts` (17) |
| `web/lib/files/html*` (the page reader) | 23 invented pages (`tests/fixtures/web/`), one per case: tables with spans and empty cells, tabs and accordions, script-filled figures marked and counted, a paywall (declared and undeclared), login, bot challenge, consent wall, cookie banner over content, mostly navigation, picture-only, `<meta refresh>` and script redirects, non-Latin and right-to-left text, encodings, broken markup. **Hidden-markup injection: 59 canaries — hidden blocks, and text hidden inside a visible sentence, table or tab — none comes out, and a naive tag-stripper would pass at least 25. A second page, `injection-revealed.html`, is in the exact shape the reader's one fallback triggers on (nothing visible, everything behind `opacity:0`): 20 canaries hidden any other way still do not come out, and the instruction hidden by opacity — which that fallback does read — is followed to the request in the wrapper suites.** A page nested past the depth the reader tracks is refused. **Shipped 12 Oct** — `tests/unit/web/files-html.test.ts` (262) |
| `web/lib/links`, `filesView` (pages), `uploads` (links), `filesApi.fetchPage` | Link detection (only a link, in a sentence, several, punctuation, very long, refused forms said in the server's words); the strip's five states; the ask-once wording; read time by the reader's own calendar; the queue's link flow — fetch → read → begin with the receipt → finish, the same link twice is one read, a second link waits, Stop, Try again under a new id, an expired receipt starts over; the fetch call checks length and SHA-256 and never sends the address anywhere but our endpoint. **Shipped 12 Oct** — `tests/unit/web/links.test.ts` (48), `uploads-links.test.ts` (36) |
| `web/lib/uploads` | The queue: one file at a time; the question before a scan; resume from the page it stopped at; stop while the claim is in flight tells the server to drop it; a duplicate is never removed by a stop. **Shipped 12 Oct** |
| `drive/*` (Milestone 5 part 3a) | **The connection:** cancel at Google, a revoked grant found by a status check and by a read, a refresh token rejected later, a second Google account over the first (revoked first) and the same account again (never revoked), two people each with their own, a wrong or replayed state, the callback twice, **finished by a different signed-in person (D123)**, disconnect revoking at Google before deleting and keeping the row when Google is unreachable, disconnect while a read is in flight. **The file:** every A1 type exported or downloaded, every refusal a sentence, shortcuts once, the bin, renamed, too large, zero bytes, 401 / 403 / 429 / 5xx, a slow export. **No token, code, verifier, state or file name in any reply or log line, and no redaction either.** Sealing: wrong owner, wrong key, one flipped bit, malformed — none opens. Google's answers from `tests/fixtures/google/` (documented shapes, labelled; the probe checks them live). **Built 16 Oct, not yet committed** — `tests/unit/drive/` (crypto · formats · stream · google · store · config · page · limits · wiring) |
| `files/page` (`begin` with a Drive read), `files/store` (Drive rows) | Attached only against the server's record of the Drive read (this person's, fetched, recent, the same bytes), named as Drive named it, kept 30 days; a newer read of the same Drive file replaces the older; a Drive file reads to the model as an upload does (no source, no web-page rules). **Built 16 Oct, not yet committed** — `tests/unit/files/page-drive.test.ts`, `store.test.ts` |
| `files/drive-injection` (Milestone 5 part 3a) | **Prompt injection on the Drive path.** The three injection fixtures through the real reader, stored as Drive rows, loaded by the real store adapter (`supabaseFileStore.forTurn` over a PostgREST-shaped stub) and the real turn builder: the request hashes to part 1's recorded protected request, the rules are the document rules only, the planted instruction is once and inside one wrapper with no `source=`. A row with a host and a read time but no Drive id (the trigger shape) reads as a page and does NOT match — the canary. With the Drive exception removed from `forTurn`, 9 of 10 fail. **Built 16 Oct, not yet committed** — `tests/unit/files/drive-injection.test.ts` |
| `web/lib/driveApi`, `driveView`, `uploads` (Drive), `filesView` (Drive) | Bytes believed only when their length and SHA-256 are what the server reported; a connection failure is "Settings", never "Try again"; the four Drive states, no two alike; the return from Google read once and cleaned; a Drive file in the queue: read as a file (never a web page), two at once one after the other, the same twice once, renamed, refused, broken, disconnected in flight, the scan question and the spend cap mid-read. **Built 16 Oct, not yet committed** — `tests/unit/web/drive.test.ts`, `drive-uploads.test.ts`; `bundleCheck.test.ts` (Google token shapes and the Drive secrets by value); `pure.test.ts` (the browser's config takes nothing of Google's) |
| `crm/ghl/idempotency` | Same input twice produces one contact and one opportunity, not two |
| `notion/writeback` | Only editable fields accepted; read-only fields rejected with a logged reason |
| `memory/facts` | Supersede logic, current-facts query, scope isolation |
| `logger/redact` | Every secret-shaped key redacted, including nested. **Shipped 23 Aug** — `tests/unit/logger.test.ts` |
| `errors` | Every class sets code / retryable / context; `ensureError` wraps every non-Error thrown value; `Result` helpers. **Shipped 23 Aug** |
| `http` | Retry counts exact (retries=3 → 4 requests); POST never retried unless declared idempotent; 4xx not retried and not counted by the breaker; backoff + jitter + Retry-After; timeout aborts; breaker opens **and** closes (half-open trial success closes, failure re-opens), keyed per origin. **Shipped 23 Aug** |

Boundary cases are mandatory: empty input, null, unicode, extremely long strings, and the
exact threshold value (39/40/41, not just 20 and 90).

---

## 3. LLM output testing

Non-deterministic output is still testable. Three techniques, all required:

**a. Schema conformance.** Each prompt against 20 fixture inputs. **100% must parse** against
the Zod schema. Not 95%. A parse failure in production means a record silently diverted to
review, and at volume that is a broken pipeline.

**b. Golden set.** `tests/fixtures/golden-set.json` holds 25 hand-verified organisations —
15 business finance, 10 referral partners — with expected tier, expected decision-maker
count, and known-correct emails. Assertions:
- Tier must not move more than one band from expected
- Zero fabricated fields (any email not present in the source text is a hard failure)
- Extraction recall at least 80% of known decision makers
- Referral partners: `agent_count` within one of the hand-counted value
Run on every prompt edit, model change, and rubric version.

**c. Adversarial set.** The injection corpus from SECURITY.md section 3. Zero tolerance — any
tool call, out-of-allowlist URL, or schema break is a failing test.

**d. Voice conformance (Stage 2 part 5).** `tests/fixtures/voice/prompts.json` holds 24 fixed
prompts, each naming the code checks its response must pass (`src/lib/voice/conformance.ts`:
never a bank, three pillars, Rule of One, Green hook / Red body, Meta headline ≤ 27 chars,
Google H1–D2 shape, no number / lender / claim outside the brief, no guaranteed outcome,
Australian spelling, refuses personal credit advice with a reason and a redirect, five-minute
and two-day rules, no stale stack, brand, no markdown, SMS length). Responses are recorded
from the live model with `npm run voice -- record` and pinned to `VOICE_PROMPT_VERSION` + a
content hash; **a fixture recorded against another prompt version fails the suite**. CI runs
fixtures only (`npm run voice`); the live run is on demand and once in front of the client
before Stage 2 sign-off. 100% on the recorded set is the gate. Full detail: `docs/VOICE.md`.

Fixtures are recorded real responses committed to the repo, so the suite runs offline and
deterministically. Re-record deliberately, in a dedicated commit, never as a side effect.

**e. Memory layer (Stage 3 part 1).** `tests/unit/memory/` — the chunking policy as
arithmetic (`policy.test.ts`), the Voyage adapter over scripted fetches
(`tests/fixtures/voyage/`: a 1024-d fixture vector, a two-input reply, wrong dimensions,
429, 401), the summariser's prompt/validation/retry, the supabase-js chunk store over
PostgREST-shaped stubs, and the trigger end to end with the real Claude client and the real
Voyage adapter over fixtures (`tests/fixtures/anthropic/summary-ok.json` is a **recorded
Haiku summary** of a synthetic transcript — 915 in / 241 out — so the cost assertions are
real numbers). `tests/unit/llm/chat-memory.test.ts` proves the hook cannot change a reply.
`npm run memory -- preview <transcript.json>` summarises a transcript live to read what a
note looks like before trusting it.

**f. Facts and retrieval (Stage 3 part 2).** `tests/unit/memory/facts.test.ts` (key shape,
the supabase-js store over a stubbed PostgREST: the current-facts predicate, the
`upsert_memory_fact` RPC and its three outcomes, the source back-fill),
`capture.test.ts` (the "remember that…" gate on phrases that must and must not fire, the
override guard, the parser, and `captureFact` end to end with the real Claude client over
**recorded Haiku answers** — `tests/fixtures/anthropic/fact-ok.json`, `fact-replace.json`,
`fact-none.json`, `fact-access.json`, `fact-override.json`, recorded 27 Aug from the exact
messages in the test — so Part C 1 and 2 use real model output), `retrieve.test.ts` (query
text, budget arithmetic with drops counted, rendering inside the 4,000-char cap in the worst
case, the `match_memory_chunks` adapter, and `recallForTurn` over fakes: the floor, Voyage
down, facts down, search down, timeout, a throwing dependency, top-k 0, and the capture
path saved / declined / failed), `retrieval-config.test.ts`, and
`tests/unit/llm/chat-recall.test.ts` (the block is the second system block, uncached, after
the cached prefix; the summary rides on the reply; the source back-fill; memory that throws
still answers 200; a refused caller never reaches memory; streaming), and
`audience.test.ts` (the summariser's trailing `Audience:` line: split, placeholders, bounds,
access guard, the header, the recalled line, and the trigger over
`tests/fixtures/anthropic/summary-audience.json` — the real Haiku answer for the live
Meta-ad conversation, 955 in / 112 out). `npm run memory --
recall "<message>"` prints the assembled block for a real message; `-- remember "<statement>"`
stores a fact by hand through the same guards; `-- facts [--all]` lists them.

---

## 4. Integration tests

```bash
supabase start
npm run test:int
```

Coverage required:
- Migrations replay from zero into a working schema
- RLS suite (SECURITY.md section 6) across every table — including `memory_chunks`: a chunk
  under a workspace conversation is read by every allowlisted user with the parent's
  ownership. **Part 5 (R27) changed the chunk half:** a chunk under a private conversation is
  workspace-scoped and readable by every allowlisted teammate, while not one word of that
  conversation's `messages` is — that split is the client's own decision and `rls.test.ts`
  4b/5/11/12 assert both sides of it
- **Memory layer (`tests/integration/memory.test.ts`, Stage 3 part 1):** ten messages →
  exactly one chunk with `turn_range [1,11)`; the same run again → still one, no fetch, no
  new `api_usage` row; the stored vector is 1,024-d with a non-zero norm; one `voyage` and
  one `anthropic` row per chunk with the fixture's tokens and the arithmetic's cost; Voyage
  cap 0 → nothing fetched or written; a broken Voyage behind `handleChatTurn` still answers
  200 and saves the turn. `schema.test.ts` proves the no-overlap constraint, the mandatory
  valid range and the HNSW index
- **Facts and retrieval (`tests/integration/recall.test.ts`, Stage 3 part 2):** through
  `handleChatTurn` with fixture fetches — "remember that…" → exactly one `memory_facts` row,
  workspace scope, `source_message_id` = the saved user message; a contradiction → the old
  row survives with `superseded_by` set, one live row; the next turn's request holds only the
  live value; a chunk from an EARLIER conversation is in the request as an uncached system
  block after the cached prefix (the fixture fetch reads the wire body); forty chunks → at
  most three under the budget, lowest similarity dropped; nothing above the floor → no chunk
  block, still 200; Voyage unreachable → 200 with facts and no chunks. `rls.test.ts` 7:
  `upsert_memory_fact` / `match_memory_chunks` executable by `service_role` only, proven
  from the catalog and through PostgREST as a session
- **Fact identity (`schema.test.ts`, part 3 review, D54):** a second live WORKSPACE row for
  one key is refused by `memory_facts_live_workspace_key_uniq` — including from a *different*
  author, which is the case the old `(user_id, scope, key)` index allowed; and a PRIVATE note
  under the same key is fine for two people but refused twice for one
  (`memory_facts_live_user_key_uniq`). `memory-page.test.ts` proves the same thing through
  the write path: editing a teammate's workspace note supersedes it, leaving one live row
  authored by the editor
- **The memory page (`tests/integration/memory-page.test.ts`, Stage 3 part 3):** through
  `handleMemoryRequest` and `handleChatTurn` with fixture fetches — a note added from the
  page is in the NEXT turn's request to Claude; forgetting it takes it out of the next turn
  while the row survives self-referenced with its value and author; an edit supersedes rather
  than duplicating (three rows, one live, the earlier wording still readable) and editing the
  row that was just superseded is a 409, not a second live note; a deleted chunk stops being
  retrieved AND its range stays claimed (`coverage()` still reports `[1,11)`), so the
  summariser cannot rebuild what was removed; every change is one `audit_log` row whose actor
  is the person, and no removed summary text appears in `audit_log` at all; a deactivated
  member is refused. `rls.test.ts` 8: a real session's attempts to forget a note, tombstone a
  chunk, insert or delete a fact through PostgREST are all refused, and nothing moves
- **The Team page (`tests/integration/users.test.ts`, Stage 3 part 4):** through
  `handleUsersRequest` with no substitutions at all — an admin creates a user, the password
  handed back signs in, and that account reads workspace memory and the roster; the password
  is then searched for in **every text, varchar and jsonb column of every public table**,
  taken from the catalog rather than a hand-written list, and in every captured log line; a
  non-admin is refused all seven actions and no identity is minted; a deactivated user's
  still-valid JWT reads zero rows while the note they contributed stays live; reactivating
  makes their existing password work again; every action leaves one `audit_log` row naming
  the admin, never `service_role`
- **The last-admin invariant, raced (same file):** the two flag functions are called from
  **two real connections at once**, each demoting the other's admin. The second blocks on the
  advisory lock, re-reads, and raises — the case an application-level check cannot hold and
  the reason the rule lives in the database (D58). `rls.test.ts` 9 and 10 cover the policy
  half: the roster read is exactly as wide as described, and promote / add / remove / rename /
  message-delete are each refused through PostgREST as a signed-in user
- **Conversation management (`tests/integration/conversations.test.ts`, Stage 3 part 4):** a
  rename touches one column and nothing else (message, chunk and fact counts identical, the
  chunk's embedding untouched); a delete is asserted **row by row** against the four tables —
  the conversation soft-deleted, its messages *gone*, its chunk tombstoned with `turn_range`
  intact, its standing note still live with only `source_message_id` cleared; the deleted
  conversation is invisible to `match_memory_chunks` and its range cannot be re-claimed; a
  second delete reports `already` and writes no second audit row; renaming a deleted
  conversation is refused; and no message text reaches `audit_log` or any log line
- **Attached files (Milestone 5 part 1, `tests/integration/files.test.ts`, 16 tests):** the
  real endpoint and a real chat turn against the stack with only the Anthropic call scripted —
  a typed file stored as text with provenance on every page and the audit row carrying no
  name; a scanned page charged to `api_usage` once and replayed for free; the cap at zero
  stores nothing; the document reaches the model wrapped in the user turn and both rows of
  the turn are flagged so the summariser gets placeholders; an incomplete upload cannot be
  finished and is invisible meanwhile; ten files then a refusal; the tombstone; expiry before
  and after the purge; privacy following the conversation through a real session; a deleted
  conversation's files gone outright; and the `purge-conversation-files` cron job exists.
  `tests/security/files.test.ts` (12 tests) is the cross-user suite, with each clause of the
  policy removed inside a rolled-back transaction to show the read then succeeds
- **Pages read from a link (Milestone 5 part 2, `tests/integration/web-pages.test.ts`, 15
  tests):** the real endpoint, the real HTML reader and a real chat turn against the stack,
  with the fetch to the site and the Anthropic call scripted — a page stored with the
  SERVER's address, site and read time and kept one day (a PDF from a link: thirty); an
  attachment refused without a matching record of the fetch; one id opens one page once; the
  per-person limit and the per-site gap decided by the database (the gap tested with an hour
  required, so no clock decides it); a changed page replaces the older copy and an unchanged
  one is refreshed; figures a script fills in counted by the database; a page that fades
  itself in stored as read as sent, its hidden instruction in front of the model only as
  data; the page in front of
  the model wrapped, labelled with site and read time, the rules in the system prompt, no
  tool; an unread link gets the link rule and no fetch; the tombstone names no address (and
  cannot be given one back); the purge removes a page past its day and fetch records past
  theirs; a session sees a page through its conversation and nothing of `web_fetches`; no
  log line carries the page, its title, its path or its query.
  `tests/security/web-pages.test.ts` (10 tests): the address of a page in a private
  conversation is unreadable by a colleague however it is asked for; the fetch records
  answer every session with nothing, their owner included; nothing can be forged from a
  session; and each protection is removed inside a rolled-back transaction to show the read
  then succeeds — including that *any* policy on `web_fetches` makes it readable.
  **Neither has run on this machine (no Docker): CI is their first execution.** Their SQL —
  every statement the migration makes and every fixture the security suite inserts — was
  replayed on a local PostgreSQL 17 (85 assertions) before commit
- **Google Drive (Milestone 5 part 3a, `tests/integration/drive.test.ts`, 10 tests):** the real
  drive and files endpoints, the real stores and a real chat turn, with Google and Anthropic
  scripted — the migration's objects (three tables, forced RLS, one `begin_conversation_file`
  with fourteen parameters, the purge still scheduled); a connection made through
  connect_start → the callback → connect_finish and stored SEALED (opened back with the key and
  the right owner only); every step single-use, and a different signed-in person cannot finish
  someone else's Connect; a Drive file attached under Drive's name and its one address, thirty
  days, audited as `drive`; a changed read replacing the older one; a question about it in
  front of the model as a wrapped document without the web-page rules; a broken grant recorded;
  disconnect deleting the connection AND its reads so nothing read under it attaches; the purge
  clearing reads past a day and attempts past ten minutes (this run's only); no log line with a
  token, a code, a name or the content. `tests/security/drive.test.ts` (10 tests): no session
  reads a connection, a read record or an attempt — the owner included; **the cross-user test**
  — the colleague cannot learn the author's connection, sealed token, Drive reads or Drive file
  by any filter, the colleague's request uses only the colleague's own token, and cannot attach
  bytes the author read; nothing can be written from a session; each protection weakened inside
  a rolled-back transaction shows the read then succeeds. **Neither has run on this machine
  (no Docker): CI is their first execution.** The migration's SQL was replayed on a local
  PostgreSQL 17 first (98 assertions) — which found two defects before any stack did
- **Lead-type routing:** a consumer-type record inserted end to end must produce zero crawl
  requests, zero LLM calls and zero rankings
- Full pipeline against a fixture org: intake → discovery → enrich → rank → push (mocked GHL
  and Sheets), asserting the DB end state field by field
- **Idempotency: run the same pipeline twice, assert record counts are identical.** The single
  most valuable integration test in the project
- Failure injection: kill the run mid-pipeline, re-run, assert no duplicates and no partial garbage
- Review-queue round trip: flag → Notion → approve → write back → CRM push
- Notion writeback: attempt to change a read-only field, assert rejection and log entry
- Cost cap: exceed a cap deliberately, assert the workflow pauses and alerts

**Learned knowledge (Milestone 5 part 5).** Four layers, because pgvector does not run on the
development machine:

- `tests/unit/knowledge/` — the chunker (including the section a file's NAME gives, and names
  that must give none), the drain (every Voyage refusal, interruption, the lease, the summary
  written between capture and embedding), the summariser (`summarise.test.ts`: pages rebuilt
  from passages, blocks, the wrapped request, validation and one retry, giving up, the
  timeout, concurrency), retrieval through `createTurnDocuments` (every Part C retrieval case,
  and overview questions answered from the summary), the injection canaries on the retrieval
  path (through the real chat handler — now also a file whose name is an instruction and a
  summary that carries one), the store adapter against stubbed PostgREST, the probes and the
  decision-8 judge. They run against
  `knowledge/local-store.ts`, an in-memory restatement of the migration's functions.
- `tests/integration/knowledge.test.ts` — the same rules held against the real SQL. pg only,
  so it also runs here on a throwaway PostgreSQL 17 with every migration replayed and a stand-in
  `vector` type (a float8[] domain with an exact cosine operator; the test picks the vector
  literal the column takes). On CI it runs on real pgvector. If the local store and the SQL
  disagree, one of the two suites fails.
- `tests/security/knowledge.test.ts` — real GoTrue sessions and PostgREST: nobody outside the
  staff list reaches knowledge by any path, a teammate does from a private conversation. CI only.
- `tests/e2e/knowledge.spec.ts` — the note under an answer at 375 / 768 / 1280, including after
  a reload with the name looked up and a removed document naming nothing.

**The settings page (Milestone 5 part 4, 17 Oct 2026):**

- `tests/unit/settings/*` — the endpoint's four actions over a plain-object store with a capturing
  log sink (no key, digest, label or name in any line); the store against supabase-js over a
  recorded fetch (which function, which arguments, every refusal code); the forget rule shared
  with the page; the wiring (forgetting works with no model configuration).
- `tests/unit/web/settings.test.ts`, `settingsData.test.ts` — every sentence the page says, the
  endpoint client, and the exact PostgREST requests (order, range, filters; the activity read
  never asks for a whole before/after image). `bundleCheck.test.ts` — a connector key's shape in
  the bundle is a finding, reported as `fcc_…` only.
- `tests/integration/settings.test.ts` — against the stack: a question finds the document before
  and not straight after, in a new conversation and in its own; a question in flight; still being
  learned (the late embedding batch takes nothing); never learned; purged past 30 days; two tabs
  at once (one `forgotten`, one `already`); a key made on the page works at the connector, is
  refused on the very next request after switching off, and a switch-off issued while a call holds
  the key's row waits for it (the test waits until it SEES the wait, then releases); the spend
  moves by exactly a recorded call's cost. CI only (PostgREST and GoTrue).
- `tests/security/settings.test.ts` — Part D item 12: outside the staff list or switched off sees
  and forgets nothing; a colleague sees but cannot forget another's document, nor their own while
  a copy sits in someone's private conversation; `forget_document` callable by no session; keys
  never listed or switched off across people, and in no table. CI only.
- `tests/e2e/settings.spec.ts` — 15 cases at 375 / 768 / 1280 over `tests/e2e/settingsMock.ts`
  (installed by `installMock`, so every suite that visits /settings gets empty states, not
  errors). Screenshots `settings-*` under `docs/assets/milestone-5/`.

Live (not CI): `npm run knowledge -- ask <file> "<q>" [--fresh]` learns a real file with real
Voyage at the configured pace and answers through the real chat handler; `-- why <file>`
re-measures decision 8 into `tests/fixtures/knowledge/why-after.json`; `-- record` re-records the
retrieval-path injection probes; `-- scores <file> "<q>"… [--rewrite]` prints the nearest chunks
for each question (page, ordinal, similarity, whether its section was named) — the measurement
behind the floors. `--cache <file>` on `ask`, `why` and `scores` keeps vectors between runs (keyed
by the SHA-256 of model, input type and text), so a re-measurement does not re-learn a document
at three requests a minute. Changing `DOCUMENT_RULES` means re-recording those and
`npm run files -- record`; changing the chunker (`CHUNKER_VERSION`) means re-learning.

---

## 5. n8n workflow tests

- Workflows exported to `n8n/workflows/*.json` and committed. Diffs reviewable.
- `npm run n8n:validate` asserts no hardcoded credentials, no hardcoded URLs, every HTTP node
  has a timeout and retry, and every workflow has an error-handling branch.
- Each workflow has a test payload in `tests/workflows/` executed against a staging n8n
  instance before phase sign-off.
- Every workflow must have an attached error workflow writing to `workflow_runs` and alerting.
  A workflow without one fails validation.

---

## 6. Regression discipline

**Bugfix protocol, no exceptions:**
1. Write a failing test that reproduces the bug
2. Confirm it fails for the right reason
3. Fix
4. Confirm it passes
5. Commit test and fix together, referencing the bug

The regression suite only grows. A test is never deleted to make the build green — if a test
is genuinely wrong, that is a separate, explained commit.

**Before every phase sign-off:**
```bash
npm run typecheck && npm run lint && npm run test:regress
```
All green, plus a manual spot-check of 10 random records against their source pages. If any
of the above fails, the phase is not ready, regardless of schedule.

---

## 7. Coverage

- `src/lib/` floor: 80% lines, 75% branches. CI fails below.
- Coverage is a smoke detector, not a goal. 100% coverage with no boundary cases is worse
  than 80% with them, because it creates false confidence.
- Excluded: generated types, config files, n8n JSON.

---

## 8. CI (GitHub Actions)

On every push:
1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `gitleaks detect`
5. `npm run test:unit`
6. `npm run test:int` (database in a service container)
7. Coverage gate
8. `npm run n8n:validate`

Red CI blocks merge. No exceptions, no "will fix after".

*Status 23 Aug 2026 (Stage 2 part 1):* steps 1–5 and 7 are live in `.github/workflows/ci.yml`
— gitleaks runs twice (full git history and the working tree) from a pinned binary. Step 8
(`n8n:validate`) arrives in Stage 3 with the first workflow, in the same commit as the thing
it tests. The coverage gate is enforced by vitest's `thresholds` (80 lines / 75 branches /
80 functions / 80 statements), so a drop below the floor is a non-zero exit, not a warning.

*Status 25 Aug 2026 (Stage 2 part 6):* the `checks` job also builds the web app and runs
`npm run web:check` — a grep of the REAL build output for key shapes (`sk-ant-…`,
`sb_secret_…`, any JWT whose payload claims `service_role`), the real key values when the
build environment has them, and 24 sentences of the voice prompt plus its version tag; one
hit fails the job. It bundles the Edge Function (`npm run functions:bundle`) so a broken
import fails CI, not the deploy. A third job, `browser`, runs `tests/e2e/` in Chrome at the
three widths against `tests/e2e/mock.ts` (scripted GoTrue, PostgREST and chat endpoint — no
stack, no key, no spend): the eight Part C assertions of FND-250 that need a browser, and the
screenshots under `docs/assets/stage-2/` as an artefact. Unit tests for the browser's pure
libraries (`web/src/lib/`) live in `tests/unit/web/` and count toward coverage.

*Status 27 Aug 2026 (Stage 3 part 3):* **test files run one at a time when a real Supabase
stack is in the environment** (`fileParallelism: !stackBacked`, `vitest.config.ts`). They
share one database, and since D54 a workspace memory fact is unique by `key` across the whole
table and readable by every allowlisted user — so two concurrent files are two files
pretending to be the same workspace: they collide on the key and they see each other's notes
in `currentFacts`. Found the hard way on the first CI of this branch (8 failures, one cause).
Each stack-backed file also cleans up its own facts, and any file that writes one uses a
run-scoped key — including the recorded extractor answer, which `memory-page.test.ts`
run-scopes in its fetch stub. The unit suite is unaffected and still parallel.
`web:check` also greps for the Voyage key (shape and
value) and **fails on a React development bundle** — `npm run web:build` forces
`NODE_ENV=production` (`scripts/build-web.ts`, D55) and this is the assertion that says it
did. `tests/unit/web/bundleCheck.test.ts` covers the predicate; importing `check-bundle.ts`
is side-effect free so the unit suite, which runs before the web build, is unaffected; `functions:bundle` now builds THREE functions (part 4 added `admin`), so a broken import in any of them fails CI;
the `browser` job gains `tests/e2e/memory.spec.ts` (11 tests × 3 widths) and, in part 4,
`users.spec.ts` (9 × 3) and `conversations.spec.ts` (10 × 3), with the screenshots
under `docs/assets/stage-3/`. The e2e mock answers **403 / 42501 to any non-GET PostgREST
request** and records it, so "the page changes memory only through the verified server path"
is an assertion in the browser as well as in `rls.test.ts` — and since part 4 the same
assertion covers user management (`state.postgrestWrites` must stay empty in every test).
Two part-4 properties are proved only in the browser, because only the browser can:
a one-time password is **absent from `localStorage`, `sessionStorage` and the DOM** the moment
its panel is dismissed, and a non-admin's Team page makes **no call to the admin endpoint at
all** — the controls are not merely hidden, they are never reachable.

*Milestone 4 part 2 (13 Sep 2026):* `functions:bundle` builds FOUR functions (`crm` joined);
`web:check` greps the built app for the GoHighLevel token shape (`pit-<uuid>`) and value;
the `browser` job gains `tests/e2e/overview.spec.ts` (26 tests × 3 widths, screenshots under
`docs/assets/milestone-4/`) and the e2e mock serves the five `ghl_*` tables and the `crm`
endpoint, with switches for a 401, a 500 and a slow read; the `integration` job gains
`tests/integration/overview.test.ts`, which writes a known snapshot through the part-1
functions and reads it back under RLS the way the screen does. Two things are proved only
in the browser: the default route after login is the overview (item 12), and a message sent
in the docked panel is on the Assistant page (item 13 — the store half is
`tests/unit/web/thread.test.ts`).

*Milestone 4 part 3 (14 Sep 2026):* the `browser` job gains `tests/e2e/leads.spec.ts` (the
board, the list, the view switch, the click-through from both views, the refresh cooldown
refused in words, and every Part C state; screenshots `leads-board`, `leads-list`,
`leads-empty`, `leads-panel` at the three widths under `docs/assets/milestone-4/`); the e2e
mock serves the contact columns the screen selects (`email`, `phone`, `custom_fields`) and
the seeded `ghl_field_map` rows. The `integration` job gains `tests/integration/leads.test.ts`
(a known snapshot through the part-1 functions, read back under RLS as a member exactly as
the leads screen reads it — six selects — with the two form-field ids resolved through the
seeded map, and the member's view identical to the service role's). The refresh cooldown is
proved server-side in `tests/unit/crm/ghl/page.test.ts` ("the cooldown, enforced
server-side"): every case asserts the sync was NOT started, so the suite fails without the
check in `page.ts`; the pure half is `tests/unit/crm/cooldown.test.ts`. `overview.spec.ts`
now expects Refresh to wait out the cooldown after a run finishes.

*Milestone 4 part 4 (24 Sep 2026):* the `checks` job gains the write path's unit suites —
`tests/unit/crm/ghl/write.test.ts` (the write client against the responses recorded from the
live probe, `tests/fixtures/ghl/write-*.json`: one PUT per write, 429 waited and capped, the
typed refusals, the loud 401, the `contact` sub-object never in a result or a log line),
`moves.test.ts` (the orchestration with fakes: every Part C case — the write failing, the data
moving underneath, idempotency by request id and by target, the order of calls),
`page-writes.test.ts` (the two actions on the wire: 401/403/503 before anything runs, the
400s, every refusal and failure to its status and its sentence), `writeStore.test.ts` (the
three RPCs), and `tests/unit/web/moves.test.ts` (the optimistic move over a built view, every
sentence, the request/answer shapes, the lead detail line by line). The `integration` job
gains `tests/integration/ghl-writes.test.ts` — the real write client, store and database
functions with GoHighLevel scripted: the mirror row from the answer, the write record, the
audit row with ids only, the same request id answered from the record with no second PUT and no
second audit row, a timeout that did not land leaving the row byte-identical, one that landed
found by the re-read, deleted (marked removed), another pipeline (zero writes), a note read
back under RLS by a member and by nobody else, and a second finish refused. The `security`
job's `ghl.test.ts` covers the two new tables and three functions, and statically that
`write.ts` is the only module sending a write verb to GoHighLevel. The `browser` job gains
`tests/e2e/moves.spec.ts` (the detail; a move by menu on the detail and on a card; a move by
drag, with the ghost, the highlighted column, a drop back into its own column and one outside
every column writing nothing, Escape, a second gesture while one is saving refused in words,
keyboard-only, the live region, reduced motion; every failure putting the card back in words;
deleted / stage gone / moved by someone else / a stale mirror; notes: saved and listed, empty
and over-long refused before sending, a failed save keeping the text, two authors at once;
screenshots `lead-detail`, `lead-move-menu`, `lead-move-failed`, `lead-note-added` at the
three widths). The e2e mock answers `move` and `note` faithfully by default (the mirror
changes as the server's would) and takes a `crmWrite` script for the failure cases; the two
viewport-conditional `test.skip` calls in `overview.spec.ts` were replaced by tests that assert
the right shape at every width, so the browser job reports **zero skipped**. `drag.ts` (Pointer
Events, DOM) is covered by the browser suite only — the unit suite has no DOM.

*Milestone 5 part 2 (12 Oct 2026):* the `browser` job gains `tests/e2e/links.spec.ts` (23
tests × 3 widths): a link in a sentence offered and nothing fetched until he presses; a
message that is only a link; the question asked once on Send, both answers; a link he did
not mean to be read; several links; the keyboard; addresses that will not be opened, each
with its sentence; a login page and a paywall refused and announced; a page read in part; a
page that hides instructions in its markup; a page that fades itself in, read as sent and
saying so on screen; a PDF at a link read by pdf.js; read again
(changed, and unchanged); remove; a slow page with its progress, the blocked Send and Stop;
reduced motion; a 1,400-character address and a long title in three scripts; tap targets and
16px inputs; the docked panel. **Every test routes the fixtures' own host and asserts the
browser made zero requests to it** — the page is fetched by the (scripted) server and read
as bytes. The e2e mock answers `fetch_page` as the function does (bytes in the body, what it
measured in `x-page-meta`), holds `begin` to its record of the fetch, and replaces an older
read at `finish`. Screenshots `links-*` at the three widths under `docs/assets/milestone-5/`.
The integration job gains `tests/integration/web-pages.test.ts` and
`tests/security/web-pages.test.ts`, and replays migration `20261012020000` from zero.
*Milestone 5 part 3a (16 Oct 2026):* the browser job gains `tests/e2e/drive.spec.ts` — the
Drive section of Settings in all four states, connect through a stand-in for Google's consent
page and back (finished with his own session, the address cleaned), cancel, a stale return,
disconnect with its question (the safe answer focused) and with Google unreachable, keyboard
reach; a Drive file in the thread, opened in Drive, read again (replacing the older copy), a
colleague's file not read again from his Drive, a broken connection found by a read pointing at
Settings, a refusal, a slow Google with Send waiting — at 375 / 768 / 1280 with no horizontal
scroll, and nothing of Google's in anything the browser sent or stored. The e2e mock answers the
drive endpoint as the function does and holds `begin` to its record of the read. Screenshots
`drive-*` under `docs/assets/milestone-5/`. The integration job gains
`tests/integration/drive.test.ts` and `tests/security/drive.test.ts`, and replays
`20261016010000` from zero.

*Status 24 Aug 2026 (Stage 2 part 2):* step 6 is live as a second CI job (`integration`):
Supabase CLI pinned to the `supabase` devDependency version → `supabase start` →
`supabase db reset --local` (the from-zero replay proof, migrations + seed, on every push) →
`npm run test:int` (`tests/integration/schema.test.ts`) → `npm run test:security`
(`tests/security/rls.test.ts`, SECURITY.md §6). Both suites read the stack's throwaway
credentials from the environment (`npx supabase status -o env`); without them they are
**skipped locally** (a machine without Docker cannot run the stack) but the CI job sets
`REQUIRE_SUPABASE_TESTS=1`, which turns a missing stack into a loud failure — a green CI
proves the suites ran, never that they were skipped.

---

## 9. Manual QA before each client demo

- [ ] Every Notion view opened and checked **on a phone**, not a resized browser window
- [ ] 10 random records verified against their source URLs by hand
- [ ] GoHighLevel records inspected in the GHL UI, not just via API response
- [ ] Opportunity landed in the right pipeline at the right stage
- [ ] A workflow deliberately failed to confirm the alert actually arrives
- [ ] Cost dashboard reconciles against the Anthropic console for the period
- [ ] Re-ran a completed batch and confirmed zero duplicates
- [ ] A consumer-type lead added and confirmed it was tracked but never researched
