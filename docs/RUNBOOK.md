# RUNBOOK.md — Operations

Fill this in as you build, not at the end. It is a Stage 6 deliverable and the difference
between a handover and an abandonment. Every procedure here must have been performed once,
not just written down.

**Scope v3 (22 Aug 2026, `docs/MEMORY.md` D23–D32).** The live sections below cover the
Scope v3 system: the voice-trained assistant, memory, website reading, content generation,
dashboard, GoHighLevel and Meta. Procedures that belonged to the parked B2B lead-research
engine (Serper discovery, MillionVerifier, Voyage-for-research, the ranking rubrics, Google
Sheets export, social-insights tokens) are **moved, not deleted, to the "OUT OF CURRENT SCOPE"
section at the bottom**. Key rotation (§4), backup and restore (§6) and escalation (§11) are
kept in full.

---

## 1. System map

| Component | Where | Owner account | Purpose |
|---|---|---|---|
| n8n | Railway | client | Orchestration (from Stage 3) |
| Database | Supabase (Sydney) | client | Source of truth — confirmed platform (D24) |
| AI | Anthropic Console | client | Claude API — **key is server-side only, never in a browser (R18, SECURITY §2)** |
| Embeddings | Voyage AI | client | Vector memory for the Stage 3 memory layer (R5 — **account still to be created; the code is built and tested against fixtures, the key is the only thing missing**). Read by `src/lib/memory/config.ts` only; own spend caps (SECURITY §8). Without `VOYAGE_API_KEY` in the function's secrets the chat runs normally and every invocation logs `memory layer disabled` |
| Chat / dashboard | Static web app (`web/`) on **Vercel** — **https://fundd-command-centre.vercel.app** (project `fundd-command-centre`, scope `alihamzarao6s-projects` until handover; deployed 25 Aug 2026) | client | The interface the client talks to — primary surface (D29). Calls only the Supabase Edge Function `chat`; holds only the anon key |
| Chat endpoint | Supabase Edge Function `chat` — **https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/chat** (project `mxdfptqdshdgdszizlbo`, Sydney; deployed 25 Aug 2026, secrets set, first live turn proven the same day) | client | The one place the Anthropic key is used: verify caller → cap → history → Claude → save |
| Memory endpoint | Supabase Edge Function `memory` — **https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/memory** (deployed 27 Aug 2026) | client | The memory page's only write path: add / edit / forget a standing note, delete a conversation note. Verifies the caller itself (`verify_jwt` off), writes the `audit_log` row. Reads do NOT go through it — the browser selects `memory_facts` / `memory_chunks` under RLS. Shares `CHAT_ALLOWED_ORIGIN`; needs no Voyage key |
| Internal surface | Notion | client | Internal working surface; eight databases exist (MEMORY 10 Aug) |
| CRM | GoHighLevel, white-labelled at `app.enchargecapital.com` (stays through the rebrand, D25) | client | Finance Pipeline, ten custom fields, five workflows (Stage 1) |
| Ads / pixel | Meta — Refi Pixel + Conversions API | client | `Lead` event server-side from the FUNDD funnel (Stage 1, D31) |

*Was also: Serper (website discovery), MillionVerifier (email verification), Google Sheets
"Finance leads" (export mirror), Meta / LinkedIn social-insights apps — parked, see the
bottom of this file.*

### 1a. Deploying the chat interface (Stage 2 part 6)

Two deployables, two commands, both from the repo root. Each has been run only as far as
this machine allows (no Docker, no project credentials here) — the first live run is the
reviewer's, and its URL goes in the table above.

**What was actually run on 25 Aug 2026, in order** (all with `SUPABASE_ACCESS_TOKEN` in the
shell, never in a file): `supabase link --project-ref mxdfptqdshdgdszizlbo` → `supabase db
push` (9 migrations applied; the token's login role connects without the database password)
→ `supabase db query --linked -f supabase/seed.sql` (the two fixed-UUID staff identities +
the GHL field map — `db push` does not run the seed) → `npm run staff -- bootstrap
developer` (one-time password handed over out of band) → `npm run functions:bundle` +
`supabase functions deploy chat --no-verify-jwt` → real `npm run web:build` + `npm run
web:check` (0 hits, with the real key values present in the environment) → `vercel link` /
`vercel env add` × 2 / `vercel deploy --prod`. **Secrets:** the first attempt at `supabase secrets set` was refused — secrets need an
organisation **Owner or Admin**, and the developer account was a project-level member.
Ross granted Admin; the five secrets went in (`ANTHROPIC_API_KEY`, both caps,
`CLAUDE_THINKING`, `CHAT_ALLOWED_ORIGIN`), and the function answered `401` to an anonymous
call and named the Vercel origin in its CORS headers without a redeploy. First live turn
from the deployed app: reply in voice after 9.1 s, one `api_usage` row (`chat.turn`,
cache write 3,017 / input 21 / output 210, $0.01453), one conversation titled from its
first message, two `messages` rows.

**The Edge Function** (Supabase — the client's project; nothing to pay):

```bash
supabase login                              # once
supabase link --project-ref <ref>           # once
# Owner/Admin of the organisation only. SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY are
# reserved names that the platform injects into every function — do not set them.
supabase secrets set --project-ref mxdfptqdshdgdszizlbo ANTHROPIC_API_KEY=... \
  ANTHROPIC_DAILY_SPEND_CAP_USD=5 ANTHROPIC_MONTHLY_SPEND_CAP_USD=50 CLAUDE_THINKING=disabled \
  CHAT_ALLOWED_ORIGIN=https://fundd-command-centre.vercel.app
npm run functions:bundle                    # writes supabase/functions/chat/index.ts (gitignored)
supabase functions deploy chat --no-verify-jwt
```

`--no-verify-jwt` matches `config.toml`: the library verifies the bearer token itself and
answers 401/403 with a body the interface can show. `CHAT_ALLOWED_ORIGIN` is the exact
origin of the web app (scheme + host, no path); unset, no browser can call the function.

**The web app** (Vercel — Hobby plan is free but its terms exclude commercial use; the
client's own Vercel account on a paid plan, or a transfer of the project at handover, is
the end state. The Vercel CLI is logged in as `alihamzarao6` on the build machine):

```bash
VITE_SUPABASE_URL=https://<ref>.supabase.co VITE_SUPABASE_ANON_KEY=<anon key> npm run web:build
npm run web:check                           # MUST print "0 hits" before anything is uploaded
vercel link --yes --project fundd-command-centre     # once: creates/links the project
vercel env add VITE_SUPABASE_URL production          # paste the value when prompted
vercel env add VITE_SUPABASE_ANON_KEY production
vercel deploy --prod --prebuilt=false               # or `vercel deploy web/dist --prod` for a prebuilt upload
```

`vercel.json` (repo root) pins the build (`npm run web:build`), the output directory (`web/dist`)
and the SPA rewrite. The first production deploy prints the `*.vercel.app` URL; a custom
domain (e.g. `app.fundd.com.au`) is added in the Vercel dashboard → Domains, and then set
as `CHAT_ALLOWED_ORIGIN`. Only the two `VITE_` values reach the bundle (Vite's rule); the
service role key and the Anthropic key have no `VITE_` name.

**Then close the loop:** `supabase secrets set CHAT_ALLOWED_ORIGIN=https://<the deployed
origin>` and `supabase functions deploy chat --no-verify-jwt` again — without it the
function's CORS answer names no origin and the browser refuses every request.

**Local run, no stack:** `npm run test:e2e` builds and drives the app against a scripted
Supabase in the installed Chrome. **Local run against a stack:** `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` in `.env` (the repo root `.env` is Vite's env dir) → `npm run web:dev`
→ http://127.0.0.1:5173, with `supabase functions serve chat` for the endpoint.

**Rollback:** Vercel keeps every deployment — dashboard → Deployments → "Promote to
Production" on the previous one (or `vercel rollback`); the function: redeploy the previous
commit.

---

### 1b. Deploying the memory page (Stage 3 part 3)

Same three deployables as §1a, one of them new. In order, from the repo root:

```bash
supabase db push                 # 20260827030000 (chunk tombstone columns +
                                 #   match_memory_chunks with `deleted_at is null`)
                                 # 20260827040000 (workspace facts unique by key — D54;
                                 #   collapses any live duplicates before the index)
npm run functions:bundle         # writes BOTH supabase/functions/{chat,memory}/index.ts
supabase functions deploy memory --no-verify-jwt
npm run web:build && npm run web:check && vercel deploy --prod
```

Notes that will otherwise cost an hour:

- The `memory` function reads the **same** `CHAT_ALLOWED_ORIGIN` secret as `chat` — it names
  the one browser app both serve, so there is no new secret to set. If the page can read
  memory but every change fails with a network error, that variable is the first thing to
  check (an unset value means no browser origin is allowed).
- The function needs `SUPABASE_*` and `ANTHROPIC_*`, and **not** `VOYAGE_API_KEY`: nothing on
  this path embeds anything, so correcting or removing a note keeps working on a day when
  memory itself is degraded — which is exactly the day someone wants to.
- `supabase functions deploy chat` is still needed if the chat function itself changed; part
  3 did not change it, but `functions:bundle` rewrites both entrypoints, so deploying only
  `memory` is deliberate, not an oversight.
- Order matters: deploying the function before `db push` means every Delete answers 500
  (`deleted_at` does not exist yet). Applying the migration first is harmless — the column
  is simply unused until the function lands.

---

### 1c. Deploying the Team page and conversation management (Stage 3 part 4)

Same shape again, with a **third** Edge Function. In order, from the repo root:

```bash
supabase db push                 # 20260828010000 (roster read policy + is_active_staff;
                                 #   delete_conversation; set_staff_active / set_staff_admin)
npm run functions:bundle         # writes all THREE supabase/functions/{chat,memory,admin}/index.ts
supabase functions deploy admin --no-verify-jwt
supabase functions deploy memory --no-verify-jwt   # gained the two conversation actions
npm run web:build && npm run web:check && vercel deploy --prod
```

Notes that will otherwise cost an hour:

- `admin` reads the **same** `CHAT_ALLOWED_ORIGIN` as the other two — one app, one origin, no
  new secret. It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
  (all injected by the platform) and **nothing else**: no Anthropic key, no Voyage key.
  Managing people has to keep working on a day when the model is down or the cap has tripped,
  because that is exactly the day someone needs their access restored.
- `memory` **must** be redeployed too: rename and delete are new actions on that function. A
  page whose Rename returns 400 `action must be one of add, edit, forget, delete_chunk` is
  the symptom of skipping this line.
- Order matters: the function before `db push` means every conversation delete answers 500
  (`delete_conversation` does not exist yet) and the Team page lists one person (the roster
  policy is not there yet). Applying the migration first is harmless.
- After the migration, **check that you can still sign in** before doing anything else. The
  migration touches the policy `App.tsx`'s sign-in check depends on; `tests/security/rls.test.ts`
  test 9 asserts a deactivated account still reads zero rows, but the live smoke test is a
  sign-out and a sign-in.

### 1d. Deploying the overview and the crm refresh endpoint (Milestone 4 part 2)

A **fourth** Edge Function, `crm`, and the first time the running system reads GoHighLevel.
The migration is part 1's (`20260912010000_ghl_sync.sql`). In order, from the repo root:

```bash
supabase db push                 # 20260912010000 — six ghl_* tables, RLS forced, three functions
supabase secrets set --project-ref mxdfptqdshdgdszizlbo \
  GHL_PRIVATE_INTEGRATION_TOKEN=pit-… \
  GHL_LOCATION_ID=tgw5Q3BnoZoSsVOnRUxB \
  GHL_PIPELINE_ID=M4unnMKBy0TgwCwOA6wS \
  GHL_CUSTOM_FIELD_FOLDER_IDS=BEFyPDjs8dlcpRuz3ZcL,fA9zYqgDoZUUN5CKnb5G
npm run functions:bundle         # writes all FOUR supabase/functions/{chat,memory,admin,crm}/index.ts
supabase functions deploy crm --no-verify-jwt
npm run web:build && npm run web:check && vercel deploy --prod
```

Notes:

- `crm` reads the **same** `CHAT_ALLOWED_ORIGIN` as the other three. It needs the four `GHL_*`
  values above (the caps have defaults — `.env.example` lists them) and the platform-injected
  `SUPABASE_*` values, and nothing else. The GoHighLevel token exists in exactly two places
  once this is live: the Supabase secrets of this function, and the n8n credential store.
  Never a `VITE_` name — `npm run web:check` greps the built app for the `pit-` shape.
- **The first thing the client sees after this deploy is "Not set up yet"**: the mirror is
  empty until a refresh runs. Press Refresh on the overview (any active member can), or run
  `npm run crm -- sync` from a machine with the `.env`. Either way the run lands in
  `ghl_sync_runs` with who triggered it, and `npm run crm -- runs` shows it.
- A refresh takes ~13 GoHighLevel requests for today's pipeline of ten. The Edge runtime's
  wall-clock limit is far above that; the part-1 caps (`GHL_MAX_PAGES`,
  `GHL_MAX_CONTACTS_PER_RUN`) make a pipeline too big for one request a loud failure rather
  than a silent partial. Revisit before ~2,000 contacts (MEMORY.md 12 Sep, Part A decision 3).
- **"The last refresh failed (UNAUTHENTICATED)" on the overview means the token was
  rejected.** The numbers on screen are from the last successful refresh and the screen says
  so; the fix is a new Private Integration token in GoHighLevel and a `supabase secrets set`.
  This is the failure that sat unnoticed on this project once; it is now a sentence on the
  landing screen.
- There is no scheduled refresh yet. The client refreshes by hand; a schedule is an n8n
  workflow calling this function, which is a later part.
- **Part 3 (14 Sep) changed the `crm` function: redeploy it** (`npm run functions:bundle &&
  supabase functions deploy crm --no-verify-jwt`) together with the web app. It now refuses a
  refresh that starts within **60 seconds of the previous run ending** (any outcome) with
  `429 SYNC_COOLDOWN`, a sentence saying how long to wait, `retryAfterSeconds` and a
  `retry-after` header — the token also serves the live lead flow and GoHighLevel allows 100
  requests per 10 seconds on it. The screens disable Refresh and count down before the server
  would refuse; a 429 the screen did not foresee (a colleague refreshed) is shown in the
  server's words. The window is `SYNC_COOLDOWN_MS` in `src/lib/crm/cooldown.ts`; it is not an
  environment variable. `npm run crm -- sync` (developer-only) is not gated. If the endpoint
  answers `503 COOLDOWN_UNKNOWN`, it could not read the last run row and refused rather than
  waived the limit — check the database, then try again.
- **Part 4 (24 Sep) adds a migration and changes the `crm` function again — both must ship
  together, migration first:**

  ```bash
  supabase db push                 # 20260924010000 — ghl_writes, ghl_notes, three write functions
  npm run functions:bundle && supabase functions deploy crm --no-verify-jwt
  npm run web:build && npm run web:check && vercel deploy --prod
  ```

  The function needs no new secret: the moves use the same `GHL_PRIVATE_INTEGRATION_TOKEN`
  (the token carries the `opportunities` and `contacts` write scopes — SECURITY §12). A
  deployed function without the migration answers every move and note `503 STORE` ("could
  not record the change") and writes nothing to GoHighLevel — by design, the record is
  claimed before the CRM is called. **"GoHighLevel rejected our access key, so the lead was
  not moved. The connection needs reauthorising"** on a move is the dead-token sentence for
  the write path; same fix as above. A move that answers "didn't confirm the move, and we
  couldn't check" left a `ghl_writes` row with `status = 'unknown'`; the next Refresh
  reconciles the stage from GoHighLevel by hash, and `select * from ghl_writes order by
  started_at desc` is where a disputed move is explained (who, from, to, when, the
  GoHighLevel status). **Test data in the client's account from the 24 Sep live probe:**
  contact `Kglw9sSb0SI8tg1Lukh7` ("ZZ-TEST Fundd app write test (delete me)", tag
  `fundd-app-test`, five notes) and opportunity `bxsEZfR8ghLL19YAL31t` in the Finance
  Pipeline — delete both from GoHighLevel once part 4 is reviewed, then Refresh.

### 1e. Deploying file reading (Milestone 5 part 1)

A **fifth** Edge Function, `files`; a changed `chat`; one migration; and the first scheduled
job in the database. Order matters — the migration first, the functions second, the web app
last. In order, from the repo root:

*(12 Oct 2026: done. The migration installed `pg_cron` itself on this project and the job was confirmed with the query in step 2. **Vercel deploys on every push to `main`**, so pushing first puts the web app out before its backend — for a change like this one, run the database and function steps BEFORE pushing, or push to a branch.)*

**Step 0 — enable `pg_cron` on the live project.** Dashboard → Database → Extensions →
`pg_cron` → enable. The migration also says `create extension if not exists pg_cron`, so on a
project where the extension is available to migrations it installs itself; doing it by hand
first means the push cannot stop at that line. This is what keeps the 30-day retention
promise (D85): without the job, text read out of clients' documents is never purged and
nothing on screen would say so. Do not skip the check in step 2.

```bash
supabase db push                 # 20261012010000 — conversation_files, conversation_file_pages,
                                 # messages.document_context, five functions, the cron job
```

**Step 2 — confirm the purge is scheduled** (SQL editor, or `psql`):

```sql
select jobname, schedule, active, command from cron.job where jobname = 'purge-conversation-files';
-- one row: 17 3 * * * | true | select public.purge_conversation_files()
```

No row means retention is not being enforced: fix that before the web app goes out. After the
first night, `select status, start_time, return_message from cron.job_run_details where jobid
= (select jobid from cron.job where jobname = 'purge-conversation-files') order by start_time
desc limit 5;` shows it ran.

```bash
npm run functions:bundle         # writes all FIVE supabase/functions/{chat,memory,admin,crm,files}/index.ts
supabase functions deploy files --no-verify-jwt
supabase functions deploy chat --no-verify-jwt     # changed: a turn now loads the conversation's files
npm run web:build && npm run web:check && vercel deploy --prod
```

Notes:

- **No new secret.** `files` reads a scanned page with the same `ANTHROPIC_API_KEY` and is
  held by the same two spend caps as `chat`; it needs `CHAT_ALLOWED_ORIGIN` and the
  platform-injected `SUPABASE_*` values like the other four. The four `FILES_*` settings have
  defaults (`.env.example`); set them only to change one, and on **both** `files` and `chat`.
- **Why the order.** `chat` and the memory summariser read `messages.document_context`; a
  `chat` deployed before the migration fails those reads. A web app deployed before `files`
  shows "Something went wrong on our side. Nothing was attached." on every attach.
- **The web build now carries the PDF reader's own data files** under `web/dist/pdfjs/`
  (character maps, fonts, image decoders — about 6 MB, fetched only when a PDF needs one).
  They must be served from the app's own address. After the deploy, attach a typed PDF and
  ask what it says; then attach `tests/fixtures/files/non-latin.pdf` and ask for the Chinese
  line. If the first fails, the reader's worker did not load; if only the second does, the
  `pdfjs/` folder was not published.
- **The original file is never uploaded.** It is read in the browser; only the text (and, for
  a photo or a scan, one page image at a time, which is not kept) leaves the device. There is
  no storage bucket for this feature and nothing to configure in Storage.
- **"Why did his upload fail?"** — `supabase functions logs files` (or the dashboard). Every
  upload logs who, what kind, how big, how many pages, how long, and how it ended, as
  `file upload started / finished / failed / refused`, `file page read` and `file removed`.
  A refusal carries the reason code (`password_pdf`, `too_large`, `no_text`, …). There is no
  file name and no text in any of those lines, by design: ask him for the time and the size.
  To see what the readers get out of a file he sends you, on your own machine:
  `npm run files -- extract <file>` (no network, no database).
- **"It read the scan wrongly."** A page read from an image is a transcription by the model
  and the assistant is told to say so. `npm run files -- read <page.jpg>` shows what the
  model returns for one page and what it cost. A typed PDF is parsed, not transcribed; if
  the text is wrong there, the PDF's own text layer is wrong (`extract` shows it).
- **Removing everything for one client now, not in 30 days:** he removes the file in the
  conversation (text, name and hash are destroyed at once), or deletes the conversation
  (its files go with it, completely). To purge on demand: `select * from
  public.purge_conversation_files();` — it only ever removes what is already past its date
  or was never finished.
- **Changing the 30 days:** `FILES_RETENTION_DAYS` on `files`. It applies to files attached
  after the change; existing rows keep the date they were given.

### 1f. Deploying page reading (Milestone 5 part 2) — and the order every deploy now follows

One migration, a changed `files`, a changed `chat`, and the web app. No new function, no new
secret, no new service.

**The order, and why it is this one.** Vercel deploys the web app on **every push to
`main`** — the push *is* the web deploy. Part 1 was pushed first and its web app was live
before its backend (12 Oct). So `main` is pushed **last**, and CI is run on a branch first:

```bash
# 1. CI before anything is live. Every branch push runs all three CI jobs (.github/workflows/ci.yml).
git switch -c m5-part-2 && git push -u origin m5-part-2
#    Wait for green with ZERO skipped. This is the first run of migration 20261012020000 from
#    zero and of tests/integration/web-pages.test.ts + tests/security/web-pages.test.ts.
#    (Vercel may build a preview for the branch. A preview is not production; leave it.)

# 2. The database. Safe ahead of the functions: the deployed `files` and `chat` keep working
#    against it (the two changed functions took new parameters WITH defaults, passed by name).
supabase db push                 # 20261012020000 — source columns, web_fetches, claim/complete,
                                 # begin + finish recreated, the purge extended

# 3. The functions. Safe ahead of the web app: the old web app does not send what is new.
npm run functions:bundle
supabase functions deploy files --no-verify-jwt    # gains fetch_page; begin takes a fetch id
supabase functions deploy chat --no-verify-jwt     # a turn's rules now cover pages and links

# 4. Check the backend BEFORE the web app points people at it (below).

# 5. The web app: this push is the deploy.
git switch main && git merge --ff-only m5-part-2 && git push origin main
```

**Step 2 check** (SQL editor):

```sql
select count(*) from supabase_migrations.schema_migrations;            -- 21
select relrowsecurity, relforcerowsecurity from pg_class where relname = 'web_fetches';  -- t | t
select count(*) from pg_policies where tablename = 'web_fetches';      -- 0 — deliberate
select jobname, active from cron.job where jobname = 'purge-conversation-files';  -- still one row, true
```

**Step 4 check.** `supabase functions list` shows new versions of `files` and `chat`. Then,
signed in to the *still-old* web app: attach a file and ask about it. That is part 1 running
on the new database and the new functions; if it works, nothing was broken on the way.

**After step 5**, in the app, with the reviewer:

1. Paste `https://www.rba.gov.au/statistics/cash-rate/` with a question. A row appears above
   the box; **nothing is fetched until "Read this page" is pressed** (the `files` log shows no
   line). Press it. The page appears in the thread with its title, `rba.gov.au`, the time, and
   "Removed tomorrow". Ask the question: the answer says when the page was read.
2. `supabase functions logs files` — one `page fetched` line: host, status 200, type, bytes,
   milliseconds, `hadQuery`. **No path, no title, no text.** If any of those is there, stop.
3. Paste an ANZ, CBA or ING rates address and read it: "Read in part: N figures…" under the
   title, and the assistant declines to give a rate from it.
4. Paste `https://www.afr.com/…` (any article): refused as a paywall, in a sentence.
5. Type `http://169.254.169.254/` and `https://localhost/`: each says why beside the link and
   offers no button.
6. Send a message containing a link **without** reading it ("Send without reading"): the
   assistant says it has not opened the page and gives no figure.

Notes:

- **The read is pinned to Sydney.** The web app calls `files` with
  `?forceFunctionRegion=ap-southeast-2` for this one action. Sites answer by where a request
  comes from (REIWA: 200 from Sydney, 403 from where the platform ran it by default). If a
  site that read yesterday is refused today, check the region in the function's log before
  anything else.
- **Two settings, both optional:** `FILES_PAGE_RETENTION_DAYS` (default 1) and
  `PAGES_USER_AGENT`, on `files`. The agent's contact address is the client's own site,
  `fundd.com.au` — **decided 13 Oct 2026 (D96); there is nothing to confirm.** Leave
  `PAGES_USER_AGENT` unset: the built-in agent string already carries that address. Nothing
  else about the fetch is a setting.
- **No new secret, and nothing leaves that did not before** except the request to the site
  itself: no search, scraping or rendering service.
- **"Why could it not read this page?"** — first `npm run pages -- check <url>` (the address
  rules and DNS; no request to the site). Then the `files` log around the time he tried:
  `page not read` carries `outcome` — `robots_ai_disallowed`, `page_blocked`, `page_timeout`,
  `page_too_large`, … — and `at` (`address`, `limit`, `site`). A page that was fetched and
  then refused by the reader in his browser logs `file upload refused` with the reason
  (`page_paywall`, `page_forwards`, `page_no_text`, `page_malformed`, …). To see what the reader makes of a
  page: `npm run pages -- extract <url>` — but **that fetches from your machine, not from
  Sydney**, and sites answer the two differently; it shows what the reader does with the
  bytes, not what the app was sent.
- **Pages he will paste that cannot be read**, so nobody investigates them as faults: the
  rate figures on **CBA, ANZ and ING** (read in part — the site fills them in by script);
  **realestate.com.au** (refuses every automated reader); **AFR, The West** and other
  paywalled news; **ABC News** and any site whose robots.txt tells AI assistants to stay out;
  **anything behind a login** (a lender's broker portal, an aggregator's platform, his CRM).
  The way round is always the same and the product says it: open it himself, save as PDF,
  attach — part 1 reads that.
- **"Read as the site sent it" under a page.** The page shows nothing until its scripts run
  (one lender fades every section in), so it was read with its `opacity:0` declarations
  ignored. What was read can differ from what he sees — in particular it can include text
  the page never shows. It is not a fault. The assistant is told the same and says so; tell
  him to check anything that matters against the page, or to save it as a PDF and attach
  that, which is read as he sees it.
- **"It gave an old rate."** A page is as true as when it was read; the thread shows the
  time, and the assistant is told to say it. A page is removed after a day. "Read again" on
  the link replaces the copy; if nothing changed it says so.
- **Someone is hammering a site through us.** They cannot: ten reads a minute per person and
  two seconds between reads of one site are enforced in the database. To see who has been
  reading what in the last day: `select user_id, requested_host, status, outcome, created_at
  from web_fetches order by created_at desc limit 50;` (service role only; rows last a day).
  To stop one person, deactivate the account (Team page).
- **Rolling back.** Redeploy the previous `files` and `chat` (`git checkout fd1a7ec --
  src && npm run functions:bundle`, deploy, then restore the tree) and revert the web app in
  Vercel. The migration can stay: the old functions run against it. To remove it, the
  reverse is written at the top of the migration file.

### 1g. Deploying and running the connector (MCP, stage 1 — goodwill, built 13 Oct 2026)

The Command Centre as a connector the client's own AI (Grok) connects to, to READ his Finance
Pipeline. Not on the milestone list. One Edge Function (`connector`), one migration
(`20261013010000_connector.sql`), one rewrite in `vercel.json`, one CLI (`npm run connector`).
What it is and why: `docs/MEMORY.md` 13 Oct (D101–D110) and `docs/SECURITY.md` §12a. What the
client is given: `docs/CONNECTOR-CLIENT.md`.

**Deploy — the order §1f gives, because the web push is what makes `/mcp` exist:**

1. Push a branch. CI green with zero skipped is the first time the migration runs from zero on
   a real stack, and the first run of `tests/integration/connector.test.ts` (9) and of the 34
   database-backed tests in `tests/security/connector.test.ts`. (Those 34 have run against a
   plain PostgreSQL 17 here; the 9 have run nowhere.)
2. `supabase db push` — 22 of 22.
3. Secrets on the project. `GHL_PIPELINE_ID` is already set and is the only one the connector
   needs. Optional, all with defaults: `CONNECTOR_PUBLIC_URL`, `CONNECTOR_ALLOWED_ORIGINS`,
   `CONNECTOR_RATE_PER_MINUTE` (30), `CONNECTOR_RATE_PER_DAY` (1000), `CONNECTOR_TIMEOUT_MS`
   (8000).
4. `npm run functions:bundle && supabase functions deploy connector --no-verify-jwt`.
   `--no-verify-jwt` is required: the bearer token is a connector key, not a Supabase session,
   and with verification on the platform refuses every request before the function sees it.
5. Fast-forward and push `main`. That is the web deploy, and the rewrite goes live with it.
6. Check, with no key: `curl -i -X POST https://fundd-command-centre.vercel.app/mcp` → **401**
   with `WWW-Authenticate: Bearer realm="Fundd Command Centre"`. The app's HTML, or a 404,
   means the rewrite is not deployed. A 401 from Supabase's own gateway (a body that is not
   JSON-RPC) means step 4 was run without `--no-verify-jwt`.
7. Issue the key: `npm run connector -- issue rossb@fundd.com.au --label "Grok"`. It is shown
   once. Hand it over out of band, with `docs/CONNECTOR-CLIENT.md`.

**The address, and what changes when the client's domain lands.** Today the address is
`https://fundd-command-centre.vercel.app/mcp` (the rewrite), or equally the function's own
`https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/connector`. When his domain exists,
three things change and none of them is code:

1. Add the domain to the Vercel project (dashboard → Domains). The rewrite already serves
   `/mcp` on every domain the project has.
2. Set `CONNECTOR_PUBLIC_URL=https://<his domain>/mcp` — as a function secret, and in `.env`
   so `npm run connector -- issue` prints the right address.
3. Change the one address line in `docs/CONNECTOR-CLIENT.md` and send it to him.

Keys issued before the change keep working at the new address.

**Keys.** `npm run connector -- list` shows every key's 12-character id, whose it is, when it
was last used and whether it is live — never a key. `npm run connector -- revoke <id>` switches
one off; its next request is refused. A person may hold five live keys. A lost or exposed key
is revoked and replaced; there is no way to show one again. Both are written to `audit_log`.

**"His AI says not authorised."** `list`, and look at the key's state. The function's log line
(kept by Supabase only from the 14 Oct logger fix onwards — §1h; before it, no function's
lines were kept at all)
for the request carries `outcome: unauthenticated` and a `reason`: `missing`, `wrong_scheme`,
`empty` or `malformed` (the header never held a whole key — he pasted part of it, or into the
wrong box), `unknown_key`, `wrong_secret`, `revoked`, `user_inactive`. He is told only "not
authorised"; the reason is ours.

**"Too many requests."** 30 a minute and 1,000 a day per key, counted in `connector_calls`.
`select method, tool, outcome, count(*) from connector_calls where created_at > now() -
interval '1 hour' group by 1,2,3` says what his AI has been doing. Raise a limit with its
setting, not in code.

**"It told me something out of date."** The connector reads the mirror; it does not refresh
it. Since 14 Oct the schedule refreshes it every ten minutes (§1h), so a copy older than about
eleven minutes means the schedule is failing: the overview's red alert names the cause. Every
result says how old the copy is in its `freshness`. (Its sentence still says the copy "is
refreshed when someone presses Refresh" — that text is in the connector's tools, which this
change did not touch; it is for the stage 2 brief.)

**If Grok's connector screen asks for an address and no key** it is expecting OAuth. Nothing
is broken. What adding it takes is in `docs/SECURITY.md` §12a — an authorization server, a
metadata route, a second way to check a token, and a migration; the endpoint, the tools and
the rate limit do not change.

**Not built, on purpose:** any tool that changes anything (stage 2, a later brief), a settings
screen for keys (Milestone 5 part 4 — the tables already fit it), the old two-endpoint SSE
transport, a refresh of the mirror from the connector.

### 1h. The mirror keeps itself fresh — deploying and running the sync schedule (14 Oct 2026)

Every ten minutes (minutes 3, 13, … 53 UTC) the database asks the `crm` function for a
refresh. Why it works this way: `docs/MEMORY.md` 14 Oct (D111–D116); the table and the two
SQL functions: `docs/SCHEMA.md` §3; the secret: `docs/SECURITY.md` §12. **The same change
makes every Edge Function's log lines reach Supabase for the first time** (the logger wrote
to stdout, which the Edge runtime discards), so all six functions are redeployed.

*(14 Oct 2026: done, in this order, `main` at `cb7bae4`; live since the 05:53 UTC tick; five
consecutive runs read back and the worst gap between refreshes measured at 10 min 0.8 s —
`docs/MEMORY.md` 14 Oct "shipped". Step 5 went in through the CLI rather than the dashboard:
`node node_modules/supabase/dist/supabase.js db query --linked "<sql>"` — called directly so
the SQL stays one argument (through `npx` on Windows it is split and refused) — with the value
read from the file at run time, errors caught inside the statement, and Vault's value checked
against the function's by SHA-256. No log source showed the statement afterwards.)*

**Deploy — §1f's order. The job is inert until the LAST step, so nothing fires half-built:**

1. Push a branch. CI green with zero skipped: the first from-zero replay of
   `20261014010000` with the real `pg_net`, Vault and `pg_cron`, and the first run of the API
   half of `tests/security/ghl-schedule.test.ts` (the rest ran against a plain PostgreSQL 17).
2. `supabase db push` — 23 of 23. Check: `select jobname, schedule, active from cron.job` →
   `ghl-sync | 3-59/10 * * * * | t` beside the purge job. Within ten minutes
   `select outcome from ghl_sync_dispatches order by id desc limit 1` → `not_configured`.
3. Make the secret and set it on the functions, without printing it, in a file OUTSIDE the
   repository so it can never be committed:
   `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > "$TEMP/schedule-secret"`
   then `npx supabase secrets set CRM_SCHEDULE_SECRET="$(cat "$TEMP/schedule-secret")"`. Keep
   the file for step 5 and delete it after.
4. `npm run functions:bundle`, then `supabase functions deploy <name> --no-verify-jwt` for
   **all six**: `crm` (the new action), and `chat`, `memory`, `admin`, `files`, `connector`
   (the logger only). Check: an unauthenticated
   `curl -s -X POST <project>/functions/v1/crm -d '{"action":"scheduled-sync"}'` → `401`
   `{"error":{"code":"UNAUTHENTICATED","message":"Not authorised."…}}`.
5. **Last:** Dashboard → Project Settings → Vault → add two secrets. `ghl_sync_schedule_url`
   = `https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/crm`; `ghl_sync_schedule_secret` =
   the contents of that file. (The dashboard, not SQL: a statement that fails is logged with
   its text.) Delete the file.
6. Wait for two ticks and read them — this is the acceptance evidence:
   ```sql
   select d.requested_at, d.outcome, d.http_status, d.error_code, r.status, r.duration_ms,
          r.requests, r.opportunities_fetched, r.opportunities_inserted,
          r.opportunities_updated, r.opportunities_removed, r.contacts_updated
   from ghl_sync_dispatches d left join ghl_sync_runs r on r.id = d.run_id
   order by d.id desc limit 4;
   ```
   A request is settled by the tick after it, so the newest row reads `requested`. Function
   logs: Edge Functions → `crm` → Logs, search `crm: scheduled refresh`.
7. Fast-forward and push `main`: the web deploy (the two screens' read and the open-screen
   re-read).

**How old can the copy be?** Working: about eleven minutes. Measure it:
`select max(gap) from (select applied_at - lag(applied_at) over (order by applied_at) as gap
from ghl_sync_runs where applied_at > now() - interval '1 day') g;`

**The red alert says the last refresh failed — what each code means:**

| Code | Means | Do |
|---|---|---|
| `UNAUTHENTICATED` | GoHighLevel rejected the token | New token: `supabase secrets set GHL_PRIVATE_INTEGRATION_TOKEN=…`. The next tick heals; nothing else to do |
| `RATE_LIMITED`, `NETWORK`, `TIMEOUT`, `CIRCUIT_OPEN`, `HTTP_STATUS` | GoHighLevel refused for now or did not answer | Nothing. Each tick retries; an outage clears itself |
| `STALE` | A run was interrupted and the next one retired it | Nothing, unless it repeats: then the function is being killed mid-run (time limit, near 370 leads) |
| `SCHEDULE_REJECTED` | The function and Vault hold different secrets, the function has none, or the database's clock and the function's are more than two minutes apart (the token is refused as `stale` — the function's log line says which) | Set both again from one value (steps 3 and 5) |
| `SCHEDULE_CONTRACT` | The deployed `crm` does not know `scheduled-sync` — an older build | Redeploy `crm` from `main` |
| `SCHEDULE_FUNCTION_MISSING` | 404: wrong address in Vault, or `crm` not deployed | Check `ghl_sync_schedule_url`, then the deploy |
| `SCHEDULE_FUNCTION_ERROR` | `crm` failed before a run could start (misconfigured, or could not reach the database) | `crm` function logs, search `crm function misconfigured` |
| `SCHEDULE_UNREACHABLE` | Nothing answered within 150 s | Supabase status; the function logs |
| `SCHEDULE_NO_RUN` | Answered 200, no run: the address is not `crm` | Fix `ghl_sync_schedule_url` |

**Pause and resume** — not by emptying Vault, which only records `not_configured` once:
`select cron.alter_job((select jobid from cron.job where jobname = 'ghl-sync'), active := false);`
(and `true` to resume).

**Rotate the secret:** steps 3 and 5 with a new value, one straight after the other. A tick in
between records `SCHEDULE_REJECTED`; the next one clears it.

**When the interval must change.** A run is leads + ⌈leads ÷ 100⌉ + 2 requests, one after
another, measured at 262–465 ms each.
`select max(requests), max(duration_ms) from ghl_sync_runs where trigger = 'schedule' and
started_at > now() - interval '7 days';` At **about 134 leads** the schedule alone is 10% of
GoHighLevel's 200,000 a day: go to every 30 minutes (a new migration calling `cron.schedule`
with the same job name). **From about 300 leads** a run can meet the function's 150-second
limit at any interval — the Refresh button too — and the function is killed rather than
failing in words: `tasks/TASKS.md` "KNOWN WALL" has the numbers and the three ways to move it.
Watch `max(duration_ms)`: past 60,000 is the time to start. Whatever the interval, keep every
multiple of it clear of 900 seconds by a few minutes: that is when an interrupted run is retired.

**What is not watched by anything:** the scheduler itself (job disabled, Vault emptied, project
paused). Then no row is written and the only sign is the copy's age: amber on the screens after
an hour, red after a day, and his AI told the age on every answer.

### 1i. Google Drive — setting up, deploying and running (Milestone 5 part 3a, 16 Oct 2026)

He connects his Drive once on **Settings**, then a file from it arrives in a conversation the
way an upload does. Why it works this way: `docs/MEMORY.md` D119–D127; tables and functions:
`docs/SCHEMA.md` §4; every credential and where it lives: `docs/SECURITY.md` §12b.

**Google's side (done once, by whoever owns the Google Cloud project — D127).**

1. Google Cloud console → the project "Fundd Command Centre" → **APIs & Services → Library**:
   enable **Google Drive API** (and **Google Picker API** only if the in-page Picker is used —
   D119).
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access): User
   type **External**; app name **Fundd Command Centre**; support and developer contact
   addresses; scope **`…/auth/drive.file` only**; Audience → **Publish app** → *In production*.
   With only `drive.file` Google asks for no verification and shows no "unverified app"
   screen; in *Testing* every connection would die after seven days (the brief's decision 4).
   Do not add a logo: a logo is what makes Google ask for brand verification.
3. **Clients → Create client → Web application.** Authorised redirect URIs:
   `https://mxdfptqdshdgdszizlbo.supabase.co/functions/v1/drive/callback` (the app), and — for
   the probe on a developer's machine only — `http://localhost:8765/callback`. Remove the
   localhost one at handover. Keep the client id and the client secret.

**Deploy — §1f's order (nothing is live until the function has its three secrets):**

1. Push a branch. CI green with zero skipped: the first from-zero replay of `20261016010000`,
   and the first run of `tests/integration/drive.test.ts` and `tests/security/drive.test.ts`
   (the migration's SQL was replayed on a plain PostgreSQL 17 first — 98 assertions).
2. `supabase db push` — 24 of 24.
3. The secrets, without printing them, from files OUTSIDE the repository:
   `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > "$TEMP/drive-key"`
   then `npx supabase secrets set DRIVE_TOKEN_KEY="$(cat "$TEMP/drive-key")" GOOGLE_DRIVE_CLIENT_ID=<id> GOOGLE_DRIVE_CLIENT_SECRET="$(cat "$TEMP/drive-secret")"`.
   **Keep `DRIVE_TOKEN_KEY` somewhere safe (the client's password manager):** without it every
   stored connection is unreadable and every person must connect again. Delete the files.
   `CHAT_ALLOWED_ORIGIN` (already set) is where Google sends him back.
4. `npm run functions:bundle`, then `supabase functions deploy drive --no-verify-jwt` and
   `supabase functions deploy files --no-verify-jwt` (`begin` learned the Drive receipt).
   Check: an unauthenticated `curl -s -X POST <project>/functions/v1/drive -d '{"action":"status"}'`
   → `401`; `curl -s -o /dev/null -w '%{http_code}' <project>/functions/v1/drive/callback` → `303`
   (to `/settings?drive=stale`).
5. Fast-forward and push `main`: the web deploy (Settings, the Drive section, a Drive file in the
   thread).
6. Acceptance: on the live app, **Settings → Connect Google Drive** → Google → back on Settings
   reading "Connected as …"; then read a file of each type (PHASE-ACCEPTANCE M5 part 3a).
   `select status, google_email, broken_reason from drive_connections` — one row, `active`.

**Before any of that — the OnePick probe and the real-file reads, on a developer's machine,
nothing deployed:** put `GOOGLE_DRIVE_CLIENT_ID` (and, to read files, `GOOGLE_DRIVE_CLIENT_SECRET`)
in `.env`, then `npm run drive -- probe`. It prints Google's address; open it in a browser on the
same machine, pick files, approve. It reports whether Google returned `picked_file_ids` (OnePick
works for a web client) and, with the secret, reads every picked file through the app's own plan
and readers and prints what came out — then revokes the grant. `--plain` shows the ordinary
consent screen instead; `--mode query` tries the code in the address instead of the form body.

**A connection says "Not working" — what the reason means:**

| Reason | Means | Do |
|---|---|---|
| `grant_revoked` | Google refused the refresh token: access removed in his Google account, six months unused, a Workspace administrator's restriction or session limit | He connects again on Settings |
| `access_lost` | Drive refused the access token on a read (removed in between) | He connects again |
| `unreadable` | The stored token does not open: `DRIVE_TOKEN_KEY` changed or was lost | Put the old key back if it exists; otherwise everyone connects again |

**A read failed — what the log says** (`drive` function logs, search `drive file not read`; the
`outcome` field): `drive_file_gone` (deleted, or never opened through the app — pick it again) ·
`drive_in_bin` · `drive_folder` · `drive_google_type` · `drive_download_blocked` (the owner turned
downloading off) · `drive_shortcut_target` · `drive_domain_policy` (his Workspace administrator
blocks the app) · `drive_export_too_large` (Google's 10 MB) · `too_large` (part 1's 20 MB) ·
`empty` · `drive_busy` / `drive_unreachable` / `drive_timeout` (retryable; nothing to do unless it
persists) · `connection_broken` (the table above) · `client_config` (**our** configuration: the
client id, secret or redirect address Google holds does not match — check step 3 of Google's side
and step 3 above).

**Rotate the client secret:** Google Cloud → the client → add a secret → `supabase secrets set
GOOGLE_DRIVE_CLIENT_SECRET=…` → delete the old secret in Google. Connections survive.
**Rotate `DRIVE_TOKEN_KEY`:** there is no re-sealing tool — a new key makes every stored
connection `unreadable`, and everyone connects again. Do it only when the key may have leaked.
**Move the project to the client (D127, Milestone 8):** transfer the Google Cloud project, or
create a new OAuth client under his account, set its id and secret, and have everyone connect
again; then remove the localhost redirect.

### 1j. Learned knowledge — deploying and running (Milestone 5 part 5, 17 Oct 2026)

Every attached file and every page read from a link is now LEARNED: chunked at once, embedded at
the pace Voyage allows, kept past the 30-day purge, and searched by meaning on every turn — in a
brand-new conversation too. Why: the part 5 report; tables and functions: SCHEMA.md §4
("knowledge_sources…"); the security case: SECURITY.md §3 ("What is LEARNED") and §11.

**Deploy, in this order** (the §1f order — backend first; pushing `main` deploys the web):

1. CI green with zero skipped on the branch.
2. `npx supabase db push` — migration `20261017010000_knowledge.sql`. pg_cron and pg_net are
   already enabled (§1e, §1h). The cron job `knowledge-drain` is created by the migration and is
   inert until step 4.
3. Function secret on the project (all functions share it): `KNOWLEDGE_DRAIN_SECRET` = 32 random
   bytes, base64url (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
   The `KNOWLEDGE_*` numbers are optional — unset, the free-plan defaults apply (.env.example).
4. In the SQL editor, the two Vault entries the scheduler reads (it never sends the secret):
   `select vault.create_secret('https://<ref>.supabase.co/functions/v1/memory', 'knowledge_drain_url');`
   `select vault.create_secret('<the same secret as step 3>', 'knowledge_drain_secret');`
5. `npm run functions:bundle`, then deploy **`chat`, `files` and `memory`** (all three changed:
   the chat searches, the files function starts learning after an attach, the memory function
   answers the scheduler).
6. Push `main` (the web: the note under an answer, the delete confirmation, the attach hint).

**What the migration does on its own.** Every file that is ready when it is applied is queued
once (`knowledge_enqueue_ready_files`), newest first — otherwise everything attached before this
deploy would never be learned, and its own conversation would fall back to its opening pages. On
17 Oct that was 5 PDFs, 44 pages: about a quarter of an hour of learning on the free plan once
step 4 is done.

**Summaries.** A document with 24,000 characters or more is given a summary while it is learned:
the fast model writes a breakdown of each run of about seven pages (five calls for the client's
33-page transcript), stored and searched like any passage. An overview question ("break down week
one") is answered from it. Nothing of such a document is embedded until its summary is written
(`summary_status = 'done'`) or has failed three times (`'failed'` — it is learned without one).
The calls go through the Anthropic client, so they are under the same spend cap and in
`api_usage` as `knowledge.summary`. `KNOWLEDGE_SUMMARY=off` turns them off;
`KNOWLEDGE_SUMMARY_MIN_CHARS` and `KNOWLEDGE_SUMMARY_BLOCK_CHARS` move the thresholds. Without an
Anthropic key no summaries are written and nothing waits for one.

**Check it is running.** `select status, summary_status, chunk_count, embedded_count, failure from
knowledge_sources order by created_at desc limit 5;` — a new attachment goes `pending` →
`learning` (summary `pending` → `done` for a long one) → `ready`. On the free plan a 33-page document takes about ten minutes (measured on
a stand-in, 17 Oct). `select * from knowledge_drain_state;` shows the lease, the last outcome and
any rest Voyage asked for. `select * from cron.job_run_details where jobid = (select jobid from
cron.job where jobname = 'knowledge-drain') order by start_time desc limit 5;` shows the ticks;
`dispatch_knowledge_drain()` returns `idle`, `busy`, `not_configured` or `requested`.

**When a card is added to the Voyage account** (2,000 requests a minute): set
`KNOWLEDGE_EMBED_BATCH_CHARS=100000`, `KNOWLEDGE_EMBED_REQUESTS_PER_RUN=20`,
`KNOWLEDGE_EMBED_GAP_MS=0` as function secrets. No code change, no redeploy beyond the secrets.
A 33-page document is then learned in one or two requests, seconds after it is attached.

**Common situations**

- *A document stays `learning`.* `knowledge_drain_state.last_outcome`: `rate_limited` /
  `unavailable` rest 65 s and resume by themselves; `unauthorised` (the Voyage key was refused)
  rests 15 minutes and logs an error — check `VOYAGE_API_KEY`; `spend_cap` — the Voyage cap
  (`VOYAGE_DAILY_SPEND_CAP_USD`) is reached; it resumes tomorrow. `not_configured` from the
  dispatcher means step 3 or 4 is missing: until then learning happens only right after an attach.
- *A document is `failed`.* `text_gone`: its text was purged before it could be learned (a page
  is kept one day) — read the page again. `no_text`: nothing readable in it.
- *He wants the assistant to forget a document.* Remove the file in its conversation: that
  forgets every copy. If the attachment has expired or its conversation was deleted (so there is
  no Remove), an operator does it: find it with `select id, name, learned_at from
  knowledge_sources where name ilike '%…%' and status = 'ready';` then
  `select public.forget_knowledge('<id>', null, null, 'operator');` — every copy of those bytes
  is forgotten and audited by id. Tell him it is done.
- *He asks about "week three" and the note lists pages outside it.* A question that names a
  section (week, module, lesson, chapter, session, unit, part, step, day…, with a number in
  digits, words or roman) takes only the chunks labelled with it, plus one either side. The
  labels come from the document itself — a heading line ("Week 3 — Referrals"), "welcome to week
  three", "week three is all about…" — and carry forward until the next one. A course that never
  introduces its weeks in any of those ways has no labels, and the question is matched by
  meaning alone, as any other. To see what a document's chunks are labelled, run
  `npm run knowledge -- chunk <file>` on a copy and `-- scores <file> "<question>" --rewrite` for
  what a question finds (both on this machine, nothing stored).

### Adding a person — what the admin actually does

1. **Team** in the nav → **+ Add someone** → their work email → **Create account**.
2. The password appears **once**, on a panel that says so. Copy it.
3. Hand it over the way you would a door code: in person, or by a message you are
   comfortable with. **Not by email** — there is no email sender configured, and adding one is
   a scope decision, not a quiet one (D57).
4. Tap **Done — I've handed it over**. The password is gone from the page and from the
   system; if it is lost, **Reset password** issues a new one the same way.
5. They sign in at the same address with their email and that password. They get the
   assistant, everything it remembers, and the Team list, read-only. They are **not** an
   administrator — tap **Make administrator** only if they should be able to add and remove
   people.

The break-glass path is unchanged and still works: `npm run staff -- add-user <email>`,
`deactivate`, `reactivate`, `promote`, `demote`, `reset-password`, `bootstrap`. Same library,
same checks, same audit rows — see `npm run staff -- help`.

### Nobody can administer any more

Should be impossible: nobody can deactivate or demote themselves, and the database refuses
any write that would leave zero active administrators (`SCHEMA.md` §7). If it somehow
happens, the recovery is `npm run staff -- bootstrap ross` (or `developer`), which attaches a
fresh password to a seeded fixed-UUID account without a signed-in admin — that is what it is
for. Then `promote` whoever should hold it.

---

## 2. Daily checks (2 minutes)

1. Dashboard (Notion until Stage 3 ships it): anything stuck in the review queue more than 24h?
2. Cost rollup: today's spend inside the daily cap? Month inside $50?
3. Alerts inbox (`rossb@fundd.com.au` — D25, was Ross@enchargecapital.com): anything overnight?

---

## 3. Common situations

### A workflow failed
1. Open `workflow_runs`, filter `status = failed`, find the run.
2. The `error` column tells you which step and why.
3. Transient (timeout, 429, 5xx)? Re-run — every workflow is idempotent, a re-run cannot
   create duplicates.
4. Persistent? Check the external service's status page before assuming it's our code.

### A batch stopped partway
The cost cap probably tripped. Check `api_usage` against the daily cap. To resume: raise the
cap in the environment variables or wait for the daily reset, then re-run. Re-running skips
already-processed records via `content_hash` and idempotency keys.

### Records piling up in the review queue
The system doing its job. Under Scope v3 the things that land here are stored website facts
below the confidence threshold (Stage 4 — now Milestone 5, D77), generated drafts that failed
the voice or review check (Stage 5 — now Milestones 7–8), and lead records the sync could not
place. Consistently high volume means a
threshold or prompt needs tuning — a data or prompt change, not a code change, and never a
reason to lower the gate silently. *(The research-era causes — thin team pages, catch-all
email domains — are in the parked section.)*

### A stored fact or a generated claim looks wrong
Open the record, follow `source_url`, view the original page. Every field is traceable. If
the source genuinely does not contain that data, it is a fabrication (R7): capture the record,
add it to the regression fixtures, and investigate the prompt. For a generated piece, check
whether the claim was in the brief — if it was not, the voice-conformance suite (Stage 2 part
5) should have caught it; add the case.

### CRM push failed
`crm_sync_log` filtered to `status = failed` shows request and response. Fix the cause, then
re-push with the replay script (`npm run replay-crm -- --id=<id>`, Stage 3). Never hand-edit
GoHighLevel to "fix" it — that creates divergence from the source of truth. Remember the
account is shared with an unrelated business (R22): never replay account-wide.

### A reply stopped part-way ("The connection dropped part-way through the reply")

The stream from the Edge Function died. The interface shows what arrived, marked
incomplete and NOT saved; Retry resends the same message. `api_usage` has a row with
operation `chat.turn:partial` for the money that was spent (real input tokens, output
estimated from the text received). If this is frequent from one network, the browser falls
back to plain JSON only when the response is not an event stream — a proxy that buffers
SSE still delivers the whole reply at once, which is fine; one that cuts long responses
needs `CHAT_TIMEOUT` attention, see `CLAUDE_TIMEOUT_MS`.

### The chat says the cap is reached (HTTP 402, code `SPEND_CAP`)
Not a bug. The message names the window (daily or monthly). Check spend:
`select date_trunc('day', created_at at time zone 'utc') d, sum(cost_usd) from api_usage
where provider = 'anthropic' and created_at >= date_trunc('month', now() at time zone 'utc')
group by 1 order by 1;` — against `ANTHROPIC_DAILY_SPEND_CAP_USD` / `_MONTHLY_`. Windows are
UTC (the Anthropic invoice is UTC): the daily window resets at 08:00 Perth. Raise the cap
with `supabase secrets set ANTHROPIC_DAILY_SPEND_CAP_USD=…` (no redeploy) if the spend is
legitimate, or wait. The call is refused *before* it reaches Anthropic, so nothing was
spent. Rows with `operation` ending `:unconfirmed` are worst-case reservations for calls
whose usage could not be read (timeout after send) — a run of them means Anthropic or the
network was unhealthy, not that someone is chatting.

### The chat returns 503 with code `NETWORK` / `HTTP_STATUS` and the cap looks fine
The cap **fails closed**: if `api_usage` cannot be read, the call is refused rather than
made blind. Check the Supabase project (paused? — see below) before anything else.

### The chat returned a reply but `TURN_NOT_SAVED` (503)
Claude answered and was metered (`api_usage` has the row) but `messages` could not be written.
The user was told the reply was generated; do not resend on their behalf — check the database
and let them retry.

### A user cannot log in / sees nothing

The interface says exactly one of three things. "The email or password is incorrect" (wrong
password AND unknown email — deliberately identical); "This account has been deactivated"
(GoTrue ban from `npm run staff -- deactivate`, or an `app_users` row that is not active —
the app signs the session out); "Couldn't reach the sign-in service" (network). A user who
signs in but sees an empty conversation list has no rows visible under RLS — check
`app_users.is_active` first.

#### (original notes)
Check `app_users`: the account must exist with `is_active = true`. Supabase Auth succeeding
but the app showing nothing is RLS doing its job for a non-allowlisted account, not a bug.

### Supabase project shows as paused
Free-tier projects auto-pause after roughly a week of inactivity. Restore from the Supabase
dashboard; no data is lost. If this becomes a recurring nuisance in production, the fix is a
paid tier, which is a client cost decision.

---

### Memory is not summarising (Stage 3 part 1)

Chunks are written by the chat function **after** each reply, off the critical path, so a
failure never shows in the interface — it shows in the function logs and as an absence of
`memory_chunks` rows. In order:

1. `supabase functions logs chat` — look for `memory layer disabled` (no `VOYAGE_API_KEY`
   secret), `voyage spend cap reached` (raise `VOYAGE_*_SPEND_CAP_USD` or wait for the UTC
   window), `summary rejected by validation` (Haiku output refused twice — the range is
   retried on the next turn; a persistent rejection means the prompt in
   `src/lib/memory/summarise.ts` needs a look), `embed failed` / `voyage error response`
   (the Voyage side; a 401 is the key).
2. Nothing wrong but no chunk? The policy needs **10 uncovered messages**, or a tail older
   than **24 h** revisited by a new turn or the sweep. A short live conversation is not
   summarised yet, by design.
3. **Force it:** `npm run memory -- flush <conversationId>` summarises the whole uncovered
   tail of that conversation now (needs the server env in `.env`). `npm run memory -- sweep`
   does the idle rule across conversations — what a schedule will call from part 5.
4. To read what a note looks like without a database: `npm run memory -- preview
   <transcript.json>` (`[{ "role": "user"|"assistant", "content": "…" }]`).

Every chunk written costs one Haiku call and one Voyage call, both in `api_usage`
(`memory.summarise`, `memory.embed`). A re-run of a covered range costs nothing and writes
nothing — the database refuses the overlap.

### The assistant is not remembering, or remembers the wrong thing (Stage 3 part 2)

Recall runs on the reply's path, bounded by `MEMORY_RECALL_TIMEOUT_MS` (4 s); anything it
cannot do in time, the turn goes without, and the reply still arrives. Every turn's reply
body carries `memory` — the fact count, the chunk ids with their similarity, the size in
characters and estimated tokens, `savedFact` when a "remember that…" landed, and `degraded`
naming what failed (`facts`, `embed`, `search`, `capture`, `timeout`, `threw`). In order:

1. **See what a turn would retrieve:** `npm run memory -- recall "<the message>"
   [--conversation <id>]` (as `CHAT_EMAIL`) prints the assembled below-breakpoint block, each
   chunk with its similarity, and the size. Nothing is sent to Claude. If the chunk you
   expected is missing, its similarity is under the floor (`MEMORY_RETRIEVAL_MIN_SIMILARITY`,
   0.45) or it was not summarised yet (the section above).
2. **See the standing notes:** `npm run memory -- facts` (live) or `-- facts --all` (with
   superseded rows and their `superseded_by` pointer). A fact the user says he never asked
   for should be traced through `source_message_id` to the message that created it.
3. **"I told it to remember and it did not":** the reply on that turn says whether the note
   was saved, and if not, why (a question, a one-off instruction, an access decision, or
   something that would override the assistant's rules — those are refused by design). The
   function logs carry `fact stored` / `fact not stored` / `fact extraction rejected` with
   ids and reasons. `npm run memory -- remember "<statement>"` stores one by hand through the
   same guards.
4. **Wrong or stale note — the client's own path (Stage 3 part 3):** the **Memory** tab in
   the Command Centre. *You told it* lists every standing note with who added it and when;
   **Edit** rewords one (the old wording stays under *Earlier wording*), **Forget** takes it
   out of every future turn and moves it to *Removed notes*, where **Add it back** restores
   it. *From conversations* lists the automatic summaries; **Delete** there is permanent —
   the text is destroyed and the range is never re-summarised. Removing is the author's or
   an admin's. The operator equivalents are `-- facts`, `-- facts --all` and `-- remember`.
   *A note that reappears after being forgotten was stated again in a chat — check
   `audit_log` for `MEMORY_FACT_ADDED` after the `MEMORY_FACT_FORGOTTEN`.*
5. **A memory-page change was refused:** `403 NOT_YOURS` means the caller is neither the
   author nor an admin (`app_users.is_admin`). `409 ALREADY_REPLACED` means someone else
   changed that note first — reload. `402 SPEND_CAP` means the Haiku extractor could not be
   paid for; editing and forgetting still work, only **adding** needs it. `500 AUDIT_FAILED`
   means the change WAS made but `audit_log` did not record it — investigate the database,
   do not repeat the change.
6. **`degraded: ["embed"]` on every turn** → the Voyage side (cap, key, outage) — same
   checks as the section above. `["search"]` → the `match_memory_chunks` function is
   missing or refused (migration `20260827010000` not applied, or a grant changed).

---

## 4. Key rotation

Per key: generate new → update in Railway / Supabase Vault → redeploy or restart n8n → verify
with a health-check run → revoke the old key. Rotate all keys at handover, and any time
someone with access leaves.

Order matters for n8n credentials: update the credential in the n8n UI first, run one test
execution, *then* revoke the old key. Revoking first means a broken pipeline and a panicked
debug session.

The GoHighLevel Private Integration token is revoked and regenerated from
Settings → Private Integrations in the GHL account. Re-scope to the minimum when you do —
the current token carries `customFields`, `customValues` and `tags` from the Stage 1 build
(SECURITY §12).

The Anthropic key is rotated in the Anthropic Console → API keys. It lives **only** in the
server environment of the chat endpoint; after rotating, confirm no `sk-ant-` string exists
in any deployed client asset (the Stage 2 acceptance check). R18 — the client's previous
prototype published a key in page source; if that key has still not been confirmed revoked,
do it now, it is independent of everything else.

The Voyage key (Stage 3) is rotated at dash.voyageai.com → API keys. It lives only in the
chat function's secrets (`supabase secrets set VOYAGE_API_KEY=…`, re-read on the next
invocation, no redeploy) and in the developer's `.env` for the `npm run memory` runner. After
rotating, confirm no `pa-` key shape exists in any deployed client asset — the same grep as
for the Anthropic key; `tests/security/voyage-key.test.ts` runs it on source and fixtures.

The Meta Conversions API token is scoped to Refi Pixel only (D31). Where it is configured
and how to regenerate it is recorded at Stage 6 handover.

---

## 5. Social token refresh — *parked (R3)*

Scheduled social-insights pulls are not in Scope v3. The procedure is kept verbatim in the
parked section at the bottom. The GHL social-planner connections noted on 12 Aug (Google and
LinkedIn tokens already expired, Facebook expiring 01 Sep 2026) are the client's to refresh
inside GHL; nothing in this system depends on them until Stage 5 decides where approved
content goes.

---

## 6. Backup and restore

**Status 24 Aug 2026 (Stage 2 part 2): the earlier text here ("daily automatic backups,
7-day retention") described the Pro plan, not this project.** The client's Supabase org is
on the **free plan** (confirmed from the management API, 24 Aug), which has **no automated
backups at all**. Until that changes, the only recoverable copy of the database is one we
make ourselves.

**Decision needed from the client (cost item, flag before Stage 2 sign-off):**
- **Option A — Supabase Pro** (US$25/month): daily automated backups, 7-day retention,
  restore from the dashboard. The right answer once real conversations and memory exist.
- **Option B — scripted `pg_dump`** (free): a scheduled dump to storage we control. Weaker
  (retention and scheduling are ours to get wrong) and it needs somewhere safe to put the
  files. Acceptable only while the database holds no client conversations.

**Manual backup and restore drill (works on any plan):**

```bash
# 1. Dump the remote database (needs SUPABASE_DB_URL with the real password)
npx supabase db dump --db-url "$SUPABASE_DB_URL" -f backup.sql          # schema
npx supabase db dump --db-url "$SUPABASE_DB_URL" -f data.sql --data-only --use-copy

# 2. Restore into a scratch target FIRST — local stack or a throwaway project.
#    Never restore over a live project as a first move.
npx supabase start
npx supabase db reset --local          # schema from migrations (the source of truth)
psql "$LOCAL_DB_URL" -f data.sql       # data on top

# 3. Verify: row counts per table against the source, then spot-check.
```

- **The restore drill has NOT yet been performed.** Part 2 could not run it: this
  machine has no Docker (no local stack to restore into) and `.env` carries no database
  password (no way to dump the remote). It is a Stage 2 acceptance item and must be done —
  once as a drill, before sign-off — as soon as either exists. A restore procedure that has
  never been run is not a restore procedure; until the drill runs, treat this section as a
  plan, not a capability.
- The n8n encryption key must be backed up separately. Without it, every stored credential is
  unrecoverable and must be re-entered by hand.
- Workflows are in git (`n8n/workflows/`) and can be re-imported. The schema is in
  `supabase/migrations/` and is replayable from zero — proven by the CI integration job on
  every push. Backups are therefore about **data** (conversations, memory, leads), not
  structure.

---

## 7. Rebuilding a downstream system

The database is the source of truth, so GoHighLevel and Notion are rebuildable (Google Sheets
was the research export and is parked):

```bash
npm run replay-crm      # rebuild GoHighLevel records from the database (Stage 3)
npm run replay-notion   # rebuild Notion databases from the database
```

Both idempotent and safe against a partially-populated target. Both scoped by pipeline / tag
— never account-wide (R22, R25).

---

## 8. Adding a new lead type or pipeline stage

1. Add the value to the `lead_type` (or `pipeline_stage`) check constraint via a migration.
2. For a stage: create it in the Finance Pipeline in GHL first, then add its **stage ID** to
   `ghl_field_map` (`entity = 'stage'`). Match on ID, never name.
3. Add the option in Notion and the matching GoHighLevel custom field value.
4. Run the regression suite.

*(Steps about researched vs tracking-only routing and rubric seeding are parked — see the
bottom of this file.)*

---

## 9. Changing the voice or brand prompt

The voice layer (Stage 2 part 5) is built only from `CLIENT-CONTEXT.md` §1, §9, §10, §11
and client-supplied samples; every rule cites its section. To change it: edit the source
section (or add a sample), update the traceability table, re-run the voice-conformance suite
(`tests/fixtures/voice/`) — 100% must still pass — and record the change in `docs/MEMORY.md`.
Never edit the system prompt text directly without the source change; a rule nobody can trace
is a rule nobody can defend. *(The ranking-rubric procedure this section used to hold is
parked below.)*

---

## 10. Adding a new website to read (Milestone 5 — was Stage 4, D77)

Reading is on demand — he pastes a link and presses "Read this page" (Milestone 5 part 2,
built 12 Oct 2026). There is no source registry to extend and no list of allowed sites: any
public `https` page may be asked for, one at a time. If a page cannot be read, the product
says why in a sentence; §1f lists how to find out more (`npm run pages -- check <url>`, the
`files` log's `outcome`) and the kinds of page that will never read. The rules themselves —
`robots.txt` honoured always, private and reserved addresses refused by design, the size and
time caps — are SECURITY §10 and are not settings. *(The "adding a new data source" adapter
procedure for the research engine is parked below.)*

---

## 11. Escalation

| Symptom | First check |
|---|---|
| Nothing is running | Railway service status, n8n container up |
| Everything is failing | Database status, API key validity, spend cap |
| One workflow failing | `workflow_runs.error` |
| Bad data | `source_url` on the record, then the prompt |
| Unexpected cost | `api_usage` grouped by provider and day |
| CRM out of sync | `crm_sync_log`, then `replay-crm` |
| Chat refuses every message | Cap reached (§3), or the user is not in `app_users` |
| A secret may have leaked | Rotate first (§4), investigate second. `gitleaks detect --log-opts="--all"` on the repo |

---

## OUT OF CURRENT SCOPE — parked research-engine and social-insights procedures (D23, R3)

**Kept verbatim, not maintained.** These belonged to the B2B outbound lead-research engine
and scheduled social-insights tracking, both out of Scope v3. If that work ever returns,
start here.

**System map rows, as they were:**

| Component | Where | Owner account | Purpose |
|---|---|---|---|
| Search | Serper | client | Website discovery |
| Email verification | MillionVerifier | client | Address validation |
| Export | Google Sheets ("Finance leads") | client | Mirror |
| Social | Meta / LinkedIn apps | client | Insights |

**Common situations, as they were:**

*Records piling up in the review queue* — The system doing its job. Common causes in order:
thin websites with no team page, ambiguous industry or partner-type classification, catch-all
email domains. Consistently high volume means the confidence thresholds need tuning — a
rubric change, not a code change.

*A contact looks wrong* — Open the record, follow `source_url`, view the original page. Every
field is traceable. If the source genuinely does not contain that data, it is a fabrication:
capture the record, add it to the golden set as a regression case, and investigate the prompt.

*A consumer lead got researched* — It shouldn't be possible — `src/lib/routing/leadType.ts`
guards it. If it happens, that is a routing bug, not a data issue. Write the failing test
first.

*CRM push failed (original)* — `crm_sync_log` filtered to `status = failed` shows request and
response. Fix the cause, then `npm run replay-crm -- --org-id=<id>` to re-push.

*Social metrics stopped updating* — Almost always an expired token. Check
`social_accounts.token_expires_at`. Refresh in section 5.

**§5 Social token refresh, as it was:** Automated, with an alert 7 days before expiry. Manual
procedure: Meta → Business Settings → System User → generate token with the insights
permissions → update the credential in n8n → run W6 manually → confirm rows land in
`social_metrics`. LinkedIn → developer portal → refresh the app token → same verification.

**§7 as it was:** `npm run replay-crm` rebuilt GoHighLevel **+ Sheets** from the database.

**§8 Adding a new lead type, as it was:**
1. Add the value to the `lead_type` check constraint via a migration.
2. Decide: researched or tracking-only. Update `src/lib/routing/leadType.ts` and its tests.
3. If researched, either map it to an existing rubric or seed a new one in `rubric_versions`.
4. Add the option in Notion and the matching GoHighLevel custom field value.
5. Run the golden set to confirm nothing shifted.

**§9 Changing a ranking rubric, as it was:** Rubrics live in `rubric_versions` as JSON, keyed
by `rubric_key` (`business_finance` or `referral_partner`). Insert a new version and mark it
active; the old one deactivates. Every historical score keeps its rubric version, so past
decisions stay explainable. Run the golden set after any change — tiers should not move more
than one band unless that was the intent.

**§10 Adding a new data source, as it was:**
1. Write an adapter in `src/lib/discovery/` implementing the source interface.
2. Contract tests with recorded fixtures.
3. Register it in the source registry.
4. Run the golden set to confirm ranking has not shifted.

The adapter pattern keeps this contained. It is still a scope change and should be priced.
