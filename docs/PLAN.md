# PLAN.md — Full Technical Specification

Encharge Capital Command Centre
Version 2.0 (revised after client confirmations, 09 Aug 2026) · Owner: Ali Hamza

Changes from v1.0: CRM is GoHighLevel (not Close/HubSpot) · eight lead types with research
on three of them · referral partners added as a researched type with its own rubric · nine
pipeline stages · lead source tagging · editable-field policy · MCP servers available.

---

## 1. Problem statement

Encharge Capital runs lead generation through paid ads and manual follow-up. Their operating
constraint, from their own playbook, is **speed to contact — five minutes or the lead cools**.
Research and enrichment is entirely manual, their CRM is GoHighLevel, their knowledge lives
in Notion, and Ross works from his phone as much as a desktop.

This system removes the manual research layer and puts an AI operations interface on top,
without introducing a new app the team has to learn — the interface is Notion, which they
already use.

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │   NOTION (UI — desktop + mobile app)      │
                    │  Intake · Review Queue · Dashboard · Chat │
                    └───────────┬──────────────────▲───────────┘
                                │ button/webhook   │ sync
                                ▼                  │
   ┌────────────────────────────────────────────────────────────┐
   │        n8n — self-hosted on Railway (queue mode)            │
   │  W1 intake  W2 discovery  W3 enrich  W4 rank  W5 push       │
   │  W6 social  W7 ops-command  W8 health/alert                 │
   └──┬─────────────┬──────────────┬─────────────┬──────────────┘
      │             │              │             │
      ▼             ▼              ▼             ▼
 ┌─────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐
 │ Serper  │  │ Crawler   │  │ Claude API│  │ GoHighLevel  │
 │ search  │  │ (fetch/   │  │ + Voyage  │  │ Google Sheets│
 │         │  │  parse)   │  │ embeddings│  │ Meta/LI APIs │
 └─────────┘  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘
                    │              │               │
                    ▼              ▼               ▼
   ┌────────────────────────────────────────────────────────────┐
   │  SUPABASE — Postgres 15 + pgvector + Storage + Edge Fns     │
   │  system of record · RLS deny-by-default · full audit log    │
   └────────────────────────────────────────────────────────────┘
```

**Design principle:** the database is the single source of truth. Notion is a view.
GoHighLevel is a destination. Google Sheets is a mirror. If any downstream system is wiped,
a replay job rebuilds it.

**Why n8n stays thin:** every non-trivial operation is an Edge Function or a `src/lib`
module called over HTTP. n8n handles orchestration, scheduling, retries and fan-out only.
Logic stays version-controlled and testable, and the client is not locked into n8n forever.

**Database platform is an open decision** — see `CLAUDE.md` §3. Build against Supabase until
Ross confirms otherwise.

---

## 3. Lead routing — which records get researched

```
Lead arrives (Notion intake / CSV / GHL webhook / API)
  → classify lead_type
      ├── Commercial / Asset finance / Referral partner
      │      → FULL RESEARCH PIPELINE (§4)
      │      → Rubric A (commercial, asset) or Rubric B (referral partner)
      └── First home owner / Refinance / Investors / Referrals / Building
             → TRACKING ONLY
             → record created, stage set, no crawl, no ranking, no verification
```

This split is the single most important routing rule in the system. It was confirmed with
Ross in writing and is stated in the scope document he holds.

---

## 4. Data flow — research pipeline (business lead types only)

```
Organisation name
  → W1  normalise, dedupe check, create org record (status=queued)
  → W2  resolve website          → Claude verifies domain matches org name
  → W2  crawl target pages       → raw HTML to Storage, clean text to DB
  → W3  extract decision makers  → Claude structured output (Zod validated)
  → W3  infer + verify emails    → syntax → MX → disposable/role → MillionVerifier
  → W4  select rubric by lead_type → rank → score, tier, reasoning, confidence
  → W4  confidence gate          → below threshold? → review_queue → Notion
  → W5  idempotent upsert        → GoHighLevel (contact + opportunity) + Google Sheets
  → W8  metrics, cost, alerting
```

### 4.1 Website resolution (W2)
1. Serper query: `"<org name>" <suburb/state> official site`.
2. Candidate filter: drop directories, aggregators, social profiles, marketplaces
   (maintained blocklist in `src/lib/discovery/blocklist.ts`).
3. Fetch top 3 candidates' homepage title, meta description, footer ABN if present.
4. Claude adjudicates which candidate is the official site, with confidence and reason. Ties
   or low confidence → review queue, never a guess.

### 4.2 Crawling (W2)
- Priority paths: `/`, `/about`, `/about-us`, `/team`, `/our-team`, `/people`,
  `/leadership`, `/contact`, `/contact-us`, plus nav links matching those patterns.
- For **referral partners**, also: `/agents`, `/our-agents`, `/advisers`, `/staff`,
  `/meet-the-team`, `/finance`, `/services`. The finance pages matter — that is where an
  in-house broker shows up, which is a scoring signal under Rubric B.
- Hard caps: 12 pages per org, 2 MB per page, 15s timeout, 1 request per 2s per host.
- `robots.txt` fetched and honoured before the first request; cached 24h.
- User-Agent identifies the crawler and links to a contact page.
- Raw HTML → Storage (`raw-pages/{org_id}/{sha256}.html`), cleaned text → DB.
- `content_hash` skips re-processing unchanged pages on re-runs.

### 4.3 Decision-maker extraction (W3)
- Claude receives cleaned page text, delimited and labelled as untrusted data, returns a
  strict JSON array validated by Zod: `full_name`, `title`, `seniority`, `department`,
  `email`, `phone`, `linkedin_url`, `source_url`, `confidence`.
- Seniority: `owner | c_suite | director | manager | other`.
- For referral partners, additionally count staff in agent/adviser roles — this feeds the
  referral volume dimension of Rubric B.
- Anything not grounded in the source text must be `null`. The prompt states explicitly that
  inventing a plausible value is a failure, not a fallback.

### 4.4 Email verification (W3) — cost-ordered, cheapest first
| Stage | Check | Cost | Kills |
|---|---|---|---|
| 1 | RFC syntax + normalisation | free | typos, malformed |
| 2 | MX record lookup | free | dead domains |
| 3 | Disposable-domain list | free | temp mail |
| 4 | Role-account detection (`info@`, `admin@`) | free | non-personal |
| 5 | MillionVerifier API | ~$0.004 | catch-all, invalid mailbox |

Only records surviving 1–4 reach stage 5, typically removing 40–60% before any paid call.
Statuses: `valid | risky | invalid | unknown | catch_all`. Only `valid` and `risky` proceed;
`risky` is flagged in the CRM.

Where no direct email is found, pattern inference runs against the org domain using patterns
observed from *confirmed* emails at the same domain. With no confirmed pattern, the inferred
email is `unknown`, flagged, and marked `email_is_inferred` — never silently pushed as fact.

### 4.5 Deduplication
- Org level: `domain_hash` (registrable domain, lowercased, `www.` stripped, punycode
  normalised) as a unique index. Fallback fuzzy match on normalised name + locality via
  trigram similarity; matches above threshold go to review, not auto-merge.
- Contact level: unique on `(org_id, lower(email))`; secondary fuzzy on normalised name.
- Merges recorded in `merge_log` with both records retained. Never hard-delete.

### 4.6 Ranking (W4)
- Two rubrics, selected by `lead_type`. Both stored as data in `rubric_versions`, versioned,
  changeable without a redeploy. Every score records which rubric and version produced it.
- Claude returns `{ score, tier, reasoning, confidence, flags }`, Zod-validated.
- Deterministic pre-filters run *before* the model (hard rejects from CLIENT-CONTEXT §7) so
  the model is never asked to re-decide a hard rule.
- Golden set of 25 hand-scored organisations — 15 business finance, 10 referral partners —
  in `tests/fixtures/golden-set.json`. Changes must not move golden-set tiers by more than
  one band.

### 4.7 CRM push (W5) — GoHighLevel
- Private Integration token, scopes: contacts read/write, opportunities read/write.
- Upsert Contact keyed on custom field `encharge_org_id`; then create or update an
  Opportunity in the configured pipeline at the mapped stage.
- Custom fields to carry: `encharge_org_id`, `lead_type`, `lead_source`, `ai_score`,
  `ai_tier`, `ai_reasoning`, `email_status`, `email_is_inferred`, `source_url`.
- All calls idempotent; every attempt written to `crm_sync_log` with request/response.
- Failure policy: retry with backoff, then park with status `failed` and alert. Never
  silently drop.
- Google Sheets ("Finance leads"): append-or-update by `org_id` in a hidden key column.

---

## 5. Claude ops layer with memory (Phase 4)

### 5.1 Memory model — three tiers
| Tier | Table | Purpose | Retrieval |
|---|---|---|---|
| Episodic | `messages` | Raw conversation turns | Last N turns verbatim |
| Semantic | `memory_chunks` | Embedded summaries of past sessions | Vector top-k |
| Structured | `memory_facts` | Durable key/value facts | Direct lookup by scope |

A summariser compacts conversations older than the verbatim window into `memory_chunks`.
Facts are never overwritten — a new row supersedes the old via `superseded_by`, so history
stays auditable.

### 5.2 Tool calling
Whitelisted tools only, each mapped to an n8n webhook or Edge Function RPC:

| Tool | Type | Confirmation |
|---|---|---|
| `get_pipeline_metrics` | read | no |
| `search_organisations` | read | no |
| `get_lead_detail` | read | no |
| `get_conversion_rates` | read | no |
| `run_research_batch` | write | **yes** |
| `assign_task` | write | **yes** |
| `store_note` | write | **yes** |
| `generate_content_from_url` | write | **yes** |
| `push_to_crm` | write | **yes** |
| `update_lead_stage` | write | **yes** |

Write tools return a preview of the intended change and require explicit confirmation in a
second turn. Every execution writes to `audit_log`.

### 5.3 Content generation
`generate_content_from_url` fetches a page, extracts the substance, and drafts content
against Encharge's own frameworks from `CLIENT-CONTEXT.md` §9 — Green Brain hook, Rule of
One, their ad structures. This is where the client's Notion playbook becomes a live asset.

---

## 6. Social tracking (Phase 5)

Official APIs only. Stated to the client in writing.

| Platform | Method | Available | Not available |
|---|---|---|---|
| Instagram | Graph API (Business/Creator linked to a FB Page) | Followers, reach, impressions, profile views, per-post engagement | Competitor accounts, follower identities |
| Facebook | Page Insights API | Page reach, engagement, post metrics, follower growth | Personal profiles |
| LinkedIn | Organization API (requires app approval) | Company page followers, impressions, engagement | Personal profile scraping, member data |

**Constraint communicated before Phase 5:** LinkedIn Organization API needs an approved
developer app with Ross as page admin; Instagram/Facebook need a linked Business account and
a Meta app. Authenticated scraping is out of scope — it breaks within weeks and risks bans.
If approval is delayed, that platform ships with a manual-entry fallback and completes on
approval, without blocking sign-off.

Daily pull → `social_metrics` / `social_posts` → Notion dashboard with 7/30-day deltas.
Token refresh automated; expiry alerts 7 days out.

---

## 7. Notion interface

| Database | Purpose | Key views |
|---|---|---|
| Intake | Add names, pick lead type, trigger research | Mobile "Add + Run" button |
| Organisations | Business records (types 1–3) | By tier, by stage, by lead type |
| Contacts | Decision makers | Grouped by org, filtered by email status |
| Consumer Leads | Individual records (types 4–8) | By stage, by source |
| Review Queue | Flagged records | Approve / Reject buttons |
| Tasks | Assigned work | By assignee, by due date |
| Social Dashboard | Metrics + deltas | Mobile-first cards |
| Ops Chat Log | Claude conversation history | Recent |

**Sync model.** Data flows database → Notion. Actions flow Notion → webhook → database.
The editable-field policy in `CLIENT-CONTEXT.md` §8 defines exactly which properties sync
back; everything else is read-only in Notion so a run cannot silently overwrite a human edit,
and a human edit cannot silently destroy provenance.

**Mobile.** Every view is built and tested in the Notion phone app before sign-off. Board and
gallery views with 3–4 visible properties. No wide tables requiring horizontal scroll.

**Note on the Notion MCP:** databases, properties and views can all be created through the
MCP (`create_view` / `update_view` are available). Buttons and some layout details remain
UI-only. The MCP authenticates as the developer's own account; the running system needs a
separate workspace access token, which requires admin rights on the workspace.

---

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Throughput | 100 organisations per batch without manual intervention |
| Latency | Full pipeline per org under 4 minutes p95 |
| Cost | Under $0.12 per fully-enriched organisation, tracked in `api_usage`. Hard cap $50/month |
| Reliability | Any workflow safely resumable; no duplicate records on re-run |
| Observability | Every run in `workflow_runs`; failures alert within 5 min to Ross@enchargecapital.com |
| Backup | Daily backups enabled; migrations replay from zero |
| Handover | Runbook + recorded walkthrough; client owns every account and key |

---

## 9. Phase map (payment-aligned)

| Phase | Scope | Payment |
|---|---|---|
| 1 | Foundation: Railway n8n, database schema + RLS, Notion databases, secrets, health-check E2E, repo + CI | 1 of 5 |
| 2 | Org discovery, website resolution, crawler, source trail, deduplication | 2 of 5 |
| 3 | Contact extraction, email verification, both rubrics, review queue, GoHighLevel + Sheets push | 3 of 5 |
| 4 | Claude ops layer, memory tiers, tool calling, content generation | 4 of 5 |
| 5 | Social tracking, Notion mobile polish, monitoring, runbook, handover | 5 of 5 |

Acceptance criteria: `docs/PHASE-ACCEPTANCE.md`. Task breakdown: `tasks/TASKS.md`.

---

## 10. Explicitly out of scope

Recorded so scope creep is a conversation, not an assumption. This list matches the scope
document sent to Ross on 09 Aug.

- Outbound email sending, sequencing, or inbox warming
- Automated research on the consumer lead types (4–8)
- Integration with the separate "finance CRM" Ross mentioned
- Additional CRMs beyond GoHighLevel
- Additional data sources beyond those built in Phase 2
- Authenticated scraping of any social platform
- Phone/SMS integration
- A custom web frontend with its own login
- Ongoing maintenance, monitoring, or support after handover

Any of the above is a separate, separately-priced engagement.
