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
| Embeddings | Voyage AI | client | Vector memory for the Stage 3 memory layer (R5 — account still to be created) |
| Chat / dashboard | Deployed app (URL recorded at Stage 2 part 6) | client | The interface the client talks to — primary surface (D29) |
| Internal surface | Notion | client | Internal working surface; eight databases exist (MEMORY 10 Aug) |
| CRM | GoHighLevel, white-labelled at `app.enchargecapital.com` (stays through the rebrand, D25) | client | Finance Pipeline, ten custom fields, five workflows (Stage 1) |
| Ads / pixel | Meta — Refi Pixel + Conversions API | client | `Lead` event server-side from the FUNDD funnel (Stage 1, D31) |

*Was also: Serper (website discovery), MillionVerifier (email verification), Google Sheets
"Finance leads" (export mirror), Meta / LinkedIn social-insights apps — parked, see the
bottom of this file.*

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
below the confidence threshold (Stage 4), generated drafts that failed the voice or review
check (Stage 5), and lead records the sync could not place. Consistently high volume means a
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

### The chat says the cap is reached
Not a bug. `api_usage` against `ANTHROPIC_DAILY_SPEND_CAP_USD` / the monthly cap. Raise the
cap in the server environment if the spend is legitimate, or wait for the daily reset. The
call is refused *before* it reaches Anthropic, so nothing was spent.

### A user cannot log in / sees nothing
Check `app_users`: the account must exist with `is_active = true`. Supabase Auth succeeding
but the app showing nothing is RLS doing its job for a non-allowlisted account, not a bug.

### Supabase project shows as paused
Free-tier projects auto-pause after roughly a week of inactivity. Restore from the Supabase
dashboard; no data is lost. If this becomes a recurring nuisance in production, the fix is a
paid tier, which is a client cost decision.

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

- Daily automatic backups, 7-day retention.
- Restore: dashboard → Backups → restore to a **new** project first, verify the data, then cut
  over. Never restore over a live project as a first move.
- The n8n encryption key must be backed up separately. Without it, every stored credential is
  unrecoverable and must be re-entered by hand.
- Workflows are in git (`n8n/workflows/`) and can be re-imported.

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

## 10. Adding a new website to read (Stage 4)

Reading is on demand — point the assistant at a URL. There is no source registry to extend.
If a page cannot be read: check `robots.txt` (honoured, always), the SSRF rules (SECURITY
§10 — private ranges are rejected by design), and the size / timeout caps. *(The "adding a new
data source" adapter procedure for the research engine is parked below.)*

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
