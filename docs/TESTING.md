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
| `llm/parse` | Valid JSON, JSON with prose wrapper, markdown fences, malformed, empty |
| `llm/schemas` | Every Zod schema accepts valid and rejects each invalid shape |
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

Fixtures are recorded real responses committed to the repo, so the suite runs offline and
deterministically. Re-record deliberately, in a dedicated commit, never as a side effect.

---

## 4. Integration tests

```bash
supabase start
npm run test:int
```

Coverage required:
- Migrations replay from zero into a working schema
- RLS suite (SECURITY.md section 6) across every table
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
