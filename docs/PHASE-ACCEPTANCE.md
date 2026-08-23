# PHASE-ACCEPTANCE.md — Sign-off Criteria

Internally this defines "done". Externally it defines what the client approves when they
release each payment. It matches the scope document sent to Ross on 09 Aug 2026.

A phase is complete when all criteria are demonstrated live, the regression suite is green,
and the client confirms in writing.

---

## Phase 1 — Foundation · Payment 1 of 5

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

## Phase 2 — Discovery and web data pulling · Payment 2 of 5

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

## Phase 3 — Contacts, verification, ranking, CRM · Payment 3 of 5

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

## Phase 4 — Claude ops layer with memory · Payment 4 of 5

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

## Phase 5 — Social tracking, polish, handover · Payment 5 of 5

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

## What is not in any phase

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

## Client responsibilities

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
