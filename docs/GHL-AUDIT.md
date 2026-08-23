# GHL-AUDIT.md — What already exists in the client's GoHighLevel account

**Run 1:** 10 Aug 2026 · contacts + opportunities only · most endpoints `401`
**Run 2:** 12 Aug 2026 · expanded-scope token · **this document is the run-2 state**

**Status:** substantially complete. Three requested scopes did not land, and one thing the
API cannot expose at any scope — see §1b.

One-off investigation, not a checklist task. The goal is to find out what Encharge Capital
already has in GoHighLevel so we do not rebuild things that exist, and so the draft-workflow
completion work can be quoted from evidence rather than from names.

**Method.** One `GET` per endpoint against `https://services.leadconnectorhq.com`, header
`Version: 2021-07-28`, authenticated with `GHL_PRIVATE_INTEGRATION_TOKEN` from `.env`,
`locationId=tgw5Q3BnoZoSsVOnRUxB`. **No `POST`, `PUT` or `DELETE` was issued at any point.
Nothing was created, modified or deleted.** Pagination was followed on contacts (2 pages, all
180 records) and forms (all 14).

**PII.** 180 real contacts and 171 conversations were readable. No names, emails, phone
numbers, addresses or message bodies are recorded here — only counts, field names, IDs and
configuration vocabulary (CLAUDE.md rule 20). Two calendars are named after individual staff
members; they are referred to by role, not name.

---

## 1. Headline — read this first

### 1a. The nine pipeline stages still do not exist *(unchanged from run 1)*

The stages Ross described (`Lead in → Full details → Booked into Calendar → Docs sent →
Ongoing loan app → No show → Retarget → Disqualify → Settled`) match nothing in the live
account. Five pipelines, 21 stages, generic `New Lead → Contacted → Proposal Sent → Closed`
shape. Needs a decision from Ross before Phase 3 — see §7. **Still open (R15).**

### 1b. There are 21 workflows, 5 of them draft — not nine — and the API will not show their steps

Two separate corrections, both of which change the quoting conversation:

**The count.** The account holds **21 workflows: 16 published, 5 draft.** There is no set of
nine draft workflows. The "nine" in our notes refers to Ross's nine *pipeline stages* (§1a) and
to the nine *custom field IDs* found in run 1 — both different things, and the custom-field
number has since turned out to be wrong too (§3.5). Worth resolving with Ross before quoting,
in case he is counting something we cannot see.

**The step data.** GoHighLevel's public API v2 exposes workflows as a **flat list of seven
metadata fields** — `id, name, status, version, createdAt, updatedAt, locationId`. That is all.
There is no trigger, no action list, no step count, at any scope.

This is not a permissions problem and cannot be fixed by asking Ross for more scopes:

| Probe | Result |
|---|---|
| `GET /workflows/?locationId=…` | `200` — list of 21, metadata only |
| `GET /workflows/{id}` | `404 "Cannot GET /workflows/{id}"` |
| `GET /workflows/{id}/steps` | `404 "Cannot GET …"` |
| `GET /workflows/{id}/actions` | `404 "Cannot GET …"` |
| `GET /workflows/{id}/versions` | `404 "Cannot GET …"` |

`404 Cannot GET` means **the route does not exist on the API**, as distinct from the
`401 "The token is not authorized for this scope."` that a missing scope produces. Every other
denial in this audit is a `401`. These are `404`s.

**Consequence for the quote:** the requested per-workflow trigger-and-action breakdown cannot be
produced from the API by us or by anyone else. §9 estimates the work from the strongest
evidence that *is* available — version numbers, timestamps, sibling published workflows and the
tag vocabulary — and states plainly what it would take to replace that inference with fact.

---

## 2. Access status after the new token

The new token is live and confirmed: endpoints that returned `401` on 10 Aug now return `200`.

### What landed

| Scope (inferred) | Status | What it opened |
|---|---|---|
| `contacts.readonly` | ✅ pre-existing | 180 contacts |
| `opportunities.readonly` | ✅ pre-existing | 22 opportunities, 5 pipelines |
| `workflows.readonly` | ✅ **new** | 21 workflows — metadata only, see §1b |
| `calendars.readonly` | ✅ **new** | 3 calendars, full config |
| `funnels/page.readonly` | ✅ **new** | 7 funnels with their steps |
| `funnels/redirect.readonly` | ✅ **new** | 2 domain redirects |
| `forms.readonly` | ✅ **new** *(not requested)* | 14 forms |
| `conversations.readonly` | ✅ **new** *(not requested)* | 171 conversations |
| `socialplanner/account.readonly` | ✅ **new** *(not requested)* | 5 connected social accounts |
| `locations/templates.readonly` | ✅ **new** *(not requested)* | 0 templates |
| `emails/builder.readonly` | ✅ **new** *(not requested)* | 0 builders |

### What did not land — three of the six that were asked for

| Scope | Status | Cost of the gap |
|---|---|---|
| `locations/customFields.readonly` | ❌ still `401` | Field **names and types** still unreadable. R2 stays open |
| `locations/customValues.readonly` | ❌ still `401` | Cannot check for stored credentials or config collisions |
| `locations/tags.readonly` | ❌ still `401` | Only tags that happen to sit on a contact are visible |

Also still denied: `calendars/groups.readonly`, `locations.readonly`, `users.readonly`,
`objects.readonly`, `surveys.readonly`, `businesses.readonly`, `links.readonly`,
`custom-menu-link.readonly`.

**This is worth a specific message to Ross.** He believes he granted custom fields, custom
values and tags. He did not — those three are still returning the scope error, while everything
else in the same request works. Four alternate paths were tried for custom fields
(`/locations/{id}/customFields`, `?model=contact`, `/custom-fields/object-key/contact`,
`/custom-fields/object-key/opportunity`) and all four returned the same `401`. The denial is
real, not a wrong URL. Likely cause: these three sit under a nested **Location** sub-group in
the Private Integration scope picker that is easy to scroll past.

### The error taxonomy *(unchanged, still the fastest GHL debugging tool)*

| Response | Meaning |
|---|---|
| `401 "The token is not authorized for this scope."` | Scope missing. Fires before the location is examined |
| `403 "The token does not have access to this location."` | Scope **granted**, location wrong or absent |
| `404 "Cannot GET /path"` | **Route does not exist.** Not a permissions problem — no scope will fix it |

---

## 3. Inventory

### 3.1 Pipelines and stages — 5 pipelines, 21 stages

Unchanged from run 1 and re-confirmed. `"Assest Finance"` is still misspelled in GHL and one
stage name still carries a trailing space (`"Contacted "`). **Match on ID, never on name.**

| Pipeline | ID | Created | Stages | Open opps |
|---|---|---|---|---|
| 1-Step Funnel \| Quotes & Enquiries | `civcWG1oOY8u5g2dGcdM` | 2025-08-20 | 4 | **0** |
| 2-Step Funnel \| Discovery Sessions | `zBBfAPa6UYithZNUBKOI` | 2025-08-20 | 5 | **0** |
| Assest Finance *(sic)* | `MluAM6O0QZ8lPqlU8oR1` | 2025-10-14 | 4 | 7 |
| First Home | `jMBwTxdvLHhaKMXtvWr8` | 2025-11-02 | 4 | 7 |
| New Ad | `Fz3nC2nTwSqKD5P2ibNa` | 2026-06-30 | 4 | 8 |

<details>
<summary>Full stage list with IDs (task 1.35 needs these)</summary>

**1-Step Funnel | Quotes & Enquiries** — `civcWG1oOY8u5g2dGcdM`
| # | Stage | Win % | Stage ID |
|---|---|---|---|
| 0 | New Lead | 20 | `041578f3-fdba-4284-b459-fa8242740f87` |
| 1 | `Contacted ` *(trailing space)* | 40 | `824d0c9d-2ad1-4f11-9675-124bc1e53a8b` |
| 2 | Follow Up | 60 | `7646094f-5955-4655-9ca4-46380d742eb6` |
| 3 | Services Sold | 80 | `639e65ef-5aef-4218-802a-bf1c405c1a6b` |

**2-Step Funnel | Discovery Sessions** — `zBBfAPa6UYithZNUBKOI`
| # | Stage | Win % | Stage ID |
|---|---|---|---|
| 0 | New Leads | 16.67 | `eb0d441d-eb43-4d5d-80e7-fa507d4aed50` |
| 1 | Discovery Session Booked | 33.33 | `b0963652-fa90-45f3-b1f5-df7b20546e53` |
| 2 | No Shows | 50 | `ab009f53-9375-473e-9761-ddfd46a37a63` |
| 3 | Follow Up | 66.67 | `57c90a62-fca1-4994-a247-e1ca35eaea7e` |
| 4 | Services Sold | 83.33 | `4c147f7f-47a4-454d-af98-d7faebdc5653` |

**Assest Finance** — `MluAM6O0QZ8lPqlU8oR1`
| # | Stage | Win % | Stage ID |
|---|---|---|---|
| 0 | New Lead | 20 | `e6faf468-1f5d-489c-bc44-bb626311465d` |
| 1 | Contacted | 40 | `97b1233b-5edc-42e5-9c90-a1889f631ef4` |
| 2 | Proposal Sent | 60 | `4b459cf0-e21d-45db-8e2c-9011614c47ba` |
| 3 | Closed | 80 | `81b9f295-255e-4c1a-9c00-e73efb7a7b21` |

**First Home** — `jMBwTxdvLHhaKMXtvWr8`
| # | Stage | Win % | Stage ID |
|---|---|---|---|
| 0 | New Lead | 20 | `4887bc87-f4a1-41b7-8652-db9781a91a0a` |
| 1 | Contacted | 40 | `b82edd72-5681-4b36-bd38-66d89d7b44dc` |
| 2 | Proposal Sent | 60 | `fd15e3c9-e907-46fb-8aaf-f31c75022d11` |
| 3 | Closed | 80 | `93b42d00-8424-4b3f-a5e1-56285180d7bc` |

**New Ad** — `Fz3nC2nTwSqKD5P2ibNa`
| # | Stage | Win % | Stage ID |
|---|---|---|---|
| 0 | New Lead | 20 | `e6795ba6-380b-4d90-9254-c0c25ddd0020` |
| 1 | Contacted | 40 | `8ae4dd36-0b3d-49fc-8f40-e381fa9c9eb9` |
| 2 | Proposal Sent | 60 | `bda9d364-9073-4314-9a44-7e2114b2880d` |
| 3 | Closed | 80 | `a388e28f-5c68-4fe5-862a-98f367bc5683` |

</details>

---

### 3.2 Workflows — 21 total, 16 published, 5 draft

**Read §1b before using this table.** `status`, `version` and the timestamps are the *only*
fields the API returns. Triggers and action steps are **not obtainable**. Nothing in the
"reads as" column is observed; it is inference from name, version and siblings, and is labelled
as such.

`version` is the most useful signal available: GoHighLevel increments it on each save/publish of
the workflow. `v1` means created and never meaningfully edited. A high version means repeated
iteration. It is a proxy for *editing effort*, **not** a step count — a v10 workflow could be
three steps revised ten times.

#### The 5 drafts — the ones being quoted

| # | Name | v | Created | Last edited | Edit window | Reads as *(inference)* |
|---|---|---|---|---|---|---|
| D1 | `FB Lead form - Asset Finance` | **6** | 2025-11-01 | 2025-11-05 | 4 days | **Abandoned duplicate.** A published `FB Lead form Asset Finance` (no hyphen) sits at **v23**. Two names one character apart, same purpose, one live and heavily iterated, one parked at v6 |
| D2 | `Finance Equipment Appointment Booked → Tags` | **10** | 2025-12-15 | 2025-12-16 | 2 days | **Most-worked draft in the account.** 10 versions in 2 days is concentrated build effort. Name states its job precisely — applies tags on booking |
| D3 | `Finance Equipment Email – Booking Abandoned Follow-up` | **8** | 2025-12-15 | 2025-12-16 | 2 days | Substantially built. Email follow-up sequence, so message copy exists and is the bulk of the work |
| D4 | `Finance Equipment Meeting Booked - Follow Up` | **6** | 2025-12-16 | 2025-12-16 | same day | Built in one sitting, 6 saves. Least mature of the trio |
| D5 | `New Workflow : 1782815527870` | **1** | 2026-06-30 | 2026-06-30 | 0 | **Empty stub.** GHL's auto-generated default name, never renamed, never re-saved. Created the same day as the `New Ad` pipeline and the `New Ad` workflow — collateral from that session |

**The D2/D3/D4 trio is the real finding.** All three are "Finance Equipment", all three were
created 15–16 Dec 2025, and a **published** `Finance Equipment Form Submitted` (v9) exists from
exactly the same day. That is a complete booking lifecycle — form submitted → appointment booked
→ meeting follow-up → booking-abandoned recovery — where the **entry point was published and the
three follow-ups were not**.

Corroborating evidence from the contact records (§3.6): the tags `form submitted finance eqp`,
`no booking yet` and `booking abandoned` all exist in the account. Those are precisely the tags
this trio would read and write. The tag scaffolding for the sequence is in place.

This raises confidence that D2–D4 are **partially-built sequences, not three-step stubs** — but
it is inference from surrounding evidence, not from their contents.

#### The 16 published

| Name | v | Created | Last edited |
|---|---|---|---|
| `1-Step Funnel \| Quotes & Enquiries - SERVICES SOLD` | 2 | 2025-08-20 | 2026-03-23 |
| `1-Step Funnel \| Quotes - STEP 1 - Survey Completed` | 2 | 2025-08-20 | 2026-03-23 |
| `2-Step Funnel \| Discovery Sesisons - Services Sold` *(sic)* | 2 | 2025-08-20 | 2026-03-23 |
| `2-Step Funnel \| Discovery Sessions - FOLLOW UPS` | 2 | 2025-08-20 | 2026-03-23 |
| `2-Step Funnel \| Discovery Sessions - NO SHOWS` | 2 | 2025-08-20 | 2026-03-23 |
| `2-Step Funnel \| Discovery Sessions - STEP 1 - Nurture` | 2 | 2025-08-20 | 2026-03-23 |
| `2-Step Funnel \| Discovery Sessions - STEP 2 - Booking Confirmed / Reminders` | 6 | 2025-08-20 | 2026-03-23 |
| `Meta Conversion Tracking: Lead` | 2 | 2025-08-20 | 2026-03-23 |
| `Meta Conversion Tracking: Schedule` | 2 | 2025-08-20 | 2026-03-23 |
| `FB Lead form Asset Finance` | **23** | 2025-10-14 | 2026-03-23 |
| `Appointment Booked` | 9 | 2025-10-27 | 2026-03-23 |
| `chat widget` | 6 | 2025-10-27 | 2026-03-23 |
| `FB Lead form - First Home` | **26** | 2025-11-01 | 2026-03-23 |
| `Google - Asset Finance` | 5 | 2025-11-06 | 2026-03-23 |
| `Finance Equipment Form Submitted` | 9 | 2025-12-15 | 2026-03-23 |
| `New Ad` | 8 | 2026-06-30 | **2026-07-11** |

Three observations that matter for Phase 3:

1. **The two lead-capture workflows are the mature ones** — `FB Lead form - First Home` at v26
   and `FB Lead form Asset Finance` at v23 are far more iterated than anything else. These are
   the account's working automations and the most likely home of the five-minute contact rule.
   **Do not build anything that fires on new-contact-created without reading these two first**
   — a duplicate would double-text real people.
2. **Fifteen of the sixteen were last edited on the same day, 2026-03-23.** A single bulk
   operation — most likely an account-wide republish, a snapshot load, or a migration. Nobody
   hand-edited fifteen workflows in one day. Only `New Ad` has been touched since.
3. **Nothing has been edited in over a month** (`New Ad`, 11 Jul 2026). The account's automation
   is static, which makes it safe to inventory but also means the drafts have been parked for
   ~8 months.

---

### 3.3 Calendars — 3, all active

| Name | ID | Type | Event type | Slot | Interval | Team members | Linked form |
|---|---|---|---|---|---|---|---|
| *(staff member) Personal Calendar* | `cllTApJgMEXKY6Gtk7xN` | `personal` | `RoundRobin_OptimizeForAvailability` | 30 min | 30 min | **0** | — |
| *(Ross) Personal Calendar* | `eTNYOLFKpeCDgJOFZHBx` | `personal` | `RoundRobin_OptimizeForAvailability` | 30 min | 30 min | 1 (`Yd0QP86Gc91MI73139m0`) | — |
| **Discovery Session** | `hP68UdDC7ZiEqDP5bsA1` | **`round_robin`** | `RoundRobin_OptimizeForAvailability` | **45 min** | 15 min | 1 (`1bzQeKgRb1diKkw1FXQF`) | **`a57HdyvjGkV0UX6pis7I`** |

**What they are connected to:**

- **Discovery Session is the only real booking calendar.** It is the one wired into the funnel
  stack: linked to form `a57HdyvjGkV0UX6pis7I` (" Calendar Form"), it names the client in its
  public description, it has `shouldSendAlertEmailsToAssignedMember: true`, and its
  `notes` template injects `{{contact.phone}}`, `{{contact.email}}`, `{{reschedule_link}}` and
  `{{cancellation_link}}` into the calendar event. It matches the `Discovery Session` contact
  source and the `2-Step Funnel | Discovery Sessions` pipeline.
- **The two personal calendars are effectively unconnected.** No linked form, no group, and one
  of them has **zero team members assigned** — it cannot round-robin to anyone. They are the
  auto-created per-user calendars GHL makes on user provisioning, not deliberate configuration.

**Shared configuration across all three:** Mon–Fri only, `autoConfirm: true`,
`allowReschedule: true`, `allowCancellation: true`, `enableRecurring: false`,
`formSubmitType: ThankYouMessage`, `googleInvitationEmails: true`,
`enableClientPortalBooking: false`, no availability overrides set.

**Business hours differ:** personal calendars 08:00–17:00; Discovery Session 09:00–17:00.
**No timezone is exposed on the calendar object** and `locations.readonly` is still denied, so
the account timezone remains unconfirmed. The pipeline is Perth time (AWST, UTC+8) and the
five-minute rule depends on it — this is why `locations.readonly` stays on the ask list.

Every calendar carries an explicit consent string: *"I confirm that I want to receive content
from this company using any contact information I provide."* That is a usable
`consent_basis` value for leads arriving via booking, and it is the only explicit consent
artefact found anywhere in the account. Relevant to the Spam Act obligation and to R17.

`GET /calendars/groups` returned `401` — `calendars/groups.readonly` is a separate scope and was
not granted. The `Discovery Session` calendar reports `groupId: ""`, so no group is in use
anyway.

---

### 3.4 Funnels — 7, of which 4 published to a domain

| Name | ID | Type | Path | Domain attached | Steps | Added | Updated |
|---|---|---|---|---|---|---|---|
| Business Services | `wPU2tygqilgZ1VffjrJi` | funnel | `/business-services` | ✅ `MJWOWoLSkB2QaplOmYhy` | 4 | 2025-08-13 | 2025-10-31 |
| First Home Loan V1 | `fNHJFST5MT6U3ZX5HdOc` | funnel | `/first-home-loan-v1` | ✅ `MJWOWoLSkB2QaplOmYhy` | 2 | 2025-11-03 | 2025-11-03 |
| First Home Landing Page | `sGhbooyXlR13MU81gD4k` | funnel | `/course-ai-agency` | ❌ none | 1 | 2025-11-07 | 2025-11-26 |
| Finance Broker Offer - Apex | `VFqy4W78pabhMiNAwqVe` | funnel | `/finance` | ✅ `MJWOWoLSkB2QaplOmYhy` | 2 | 2025-12-06 | **2026-08-09** |
| Encharge Capital | `r5djDPGinb8wjCloZD5h` | funnel | `/encharge-capital` | ❌ none | 1 | 2026-05-23 | 2026-05-23 |
| **Éire Óg GAA Joondalup** | `eee6HzIC4Xgy3c38sn8b` | **website** | `/eireog-joondalup` | ✅ **`2IZQriHKGrc76NUD5BpL`** | 1 | 2026-07-04 | 2026-08-11 |
| **FUNDD** | `ndSGjrC3O1Xa6DcGMrBh` | funnel | `/finance` | ❌ none | 2 | **2026-08-11** | **2026-08-11** |

**Steps, in order:**

| Funnel | Steps |
|---|---|
| Business Services | 1. Home `/home` · 2. Appointment `/appointment` · 3. Thank you `/thank-you` · 4. Privacy Policy `/privacy-policy` |
| First Home Loan V1 | 1. Book a call `/book-a-call` · 2. Thank you `/thank-you-1665` |
| First Home Landing Page | 1. Home `/home-961716` |
| Finance Broker Offer - Apex | 1. Home `/offer` · 2. Booking `/book` |
| Encharge Capital | 1. Home `/home--encharge-capital` |
| Éire Óg GAA Joondalup | 1. Home `/home` |
| FUNDD | 1. Home `/offer-260903` · 2. Booking `/book` |

Every step is `type: optin_funnel_page`, holds exactly 1 page and 0 products. No order forms, no
upsells, no checkout anywhere in the account.

**Two domains, two redirects:**

| Domain | Redirect | Added |
|---|---|---|
| `www.enchargecapital.com` → `enchargecapital.com` | all paths | 2025-08-13 |
| `www.eireogjoondalup.com.au` → `eireogjoondalup.com.au` | all paths | 2026-07-04 |

**⚠️ This GHL location is shared with an unrelated business.** `Éire Óg GAA Joondalup` is a
Gaelic games club, published as a **website** (not a funnel) on its own domain
`eireogjoondalup.com.au`, inside the same location as Encharge Capital's finance funnels, and it
was updated yesterday. It is live work, not a leftover.

This is an operational risk we should state rather than discover later. Anything we build that
operates account-wide — a workflow on contact-created, a tag sweep, a bulk custom-field write —
will touch that business's data too. It also means contact and tag counts in this document are
not guaranteed to be purely Encharge Capital's. Add to the questions for Ross (§6 Q6).

**`FUNDD` was created yesterday (11 Aug 2026).** It is a clone of `Finance Broker Offer - Apex`
— the API reports `originId: VFqy4W78pabhMiNAwqVe`, and it shares the same `/finance` path and
the same Home→Booking structure. `Finance Broker Offer - Apex` was itself edited on 9 Aug.
**Someone is actively rebuilding the finance funnel right now**, under a new brand name, with no
domain attached yet. Whatever we wire to `/finance` may be about to move. Confirm with Ross
before Phase 3 targets it.

`First Home Landing Page` sits at path `/course-ai-agency` — a template that was cloned and
never re-pathed. Cosmetic, but it means the path is not a reliable identifier. Match funnels on
ID.

Only `First Home Loan V1` carries tracking code (664 chars in `<head>`). Every other funnel has
none, including the three on a live domain — so conversion tracking is inconsistent across the
account.

---

### 3.5 Custom fields — **21 IDs, not 9.** Names and types still unreadable

**Correction to run 1.** Run 1 sampled 100 of 180 contacts and reported 9 custom field IDs. The
full 180-record sweep finds **21**. The run-1 figure was a sampling artefact and any planning
based on "nine custom fields" is wrong. This is the second time a partial sample has produced a
wrong count in this account (§3.6 tags is the other) — **page to exhaustion on GHL, always.**

`locations/customFields.readonly` is still denied, so names and types remain unknown. What
follows is derived from the `{id, value}` pairs on contact records — the shape of the stored
values, never the values themselves.

| Custom field ID | Used on *n*/180 | Value shape observed | Likely type |
|---|---|---|---|
| `9guYLtgVuYmDK6K7s30m` | 9 | numeric, 3–4 chars | Number |
| `wFamEJlm7JJcNK7W6nfW` | 9 | numeric, 1–5 chars | Number |
| `7h6bCmGfo897F4KIhUKt` | 8 | numeric, 2–5 chars | Number |
| `7rIpOElfbElhDmcf2Bnz` | 8 | text, 13–21 chars | Single line text |
| `AFLNRuZWHqVaAJElsMde` | 8 | text, 5 or 8 chars — only two distinct lengths | **Dropdown / radio** |
| `qrVL6FLUrkNQYxjO8nj8` | 8 | text, 3–8 chars | Dropdown or short text |
| `V6k2MDy7SerQO8V9nxcn` | 8 | text, 2–19 chars | Single line text |
| `unIgtJACk1mFj0ajZDBV` | 8 | **array**, 1 element, 12–14 chars | **Multi-select / checkbox** |
| `BOpe0DTp0lEc67p0HUaD` | 5 | `yes`/`no`-like + text | Radio |
| `DMU9ln54369n2xYnO5AD` | 5 | text, 8–18 chars | Single line text |
| `HQw2eowVG6eHoUH2V6F9` | 4 | `yes`/`no`-like, 3 chars | **Radio / checkbox** |
| `TVt3oRhR5rusmdNIgcOX` | 4 | mixed text + numeric, 3–14 | Single line text |
| `JOlVzJrhwTkIrWZrExyJ` | 4 | text, 3–10 chars | Dropdown or short text |
| `3ma6Czg50bY5yhJ18zrD` | 2 | one 410-char value | **Multi-line text / textarea** |
| `1nDc1FA0NLmdmJs2yjTV` | 2 | **array**, 1 element, 25 chars | Multi-select |
| `ClCMpTAAqcPRMSdXDlg8` | 2 | **array**, 1 element, 19–31 chars | Multi-select |
| `iVrWBplXvhrrdqk7AHfe` | 1 | text, 22 chars | Single line text |
| `kbqZiLcApVYJO3DaNqHD` | 1 | text, 8 chars | Single line text |
| `3h6yioeuPjrFkInjaDyW` | 1 | text, 9 chars | Single line text |
| `ZKdvCLZbUwzK91UEsBaS` | 1 | `yes`/`no`-like, 3 chars | Radio |
| `dl4q6P9MSV6eV2OwLTKP` | 1 | `yes`/`no`-like, 2 chars | Radio |

**Zero custom fields on opportunities** — all 22 opportunity records carry an empty
`customFields` array. Anything we need at opportunity level must be created.

#### Does `ai_score`, `ai_tier`, `encharge_org_id`, `lead_type` or `lead_source` already exist?

Names are unreadable, so this cannot be answered by direct lookup. It can be answered by
reasoning, and the answer differs by field:

| Field | Verdict | Basis |
|---|---|---|
| `encharge_org_id` | **Does not exist. Must be created.** | It is our own identifier for our own system. This system has never written to this account — no field shows the density or shape it would have |
| `ai_score` | **Does not exist. Must be created.** | Three numeric fields exist, but each appears on only 8–9 of 180 contacts and none has ever been written by us. A pre-existing GHL account has no reason to hold an AI score |
| `ai_tier` | **Does not exist. Must be created.** | Same reasoning. The A/B/C tier vocabulary is ours, from `CLIENT-CONTEXT.md` |
| `lead_type` | **Probably does not exist — but verify before creating.** | Genuinely collision-prone: a Meta lead form could plausibly have created a field of this name. `AFLNRuZWHqVaAJElsMde` (two distinct value lengths, 8/180 contacts) has the exact profile of a small dropdown and is the strongest candidate. Cannot be confirmed without the scope |
| `lead_source` | **Probably does not exist — but verify before creating.** | Same collision risk. Note GHL already has a **native** `source` field on the contact object (§3.6), populated on 42/180 records. A custom `lead_source` would sit alongside it and the two would diverge |

**Every field we need must be created — but do not create any of them until
`locations/customFields.readonly` lands.** Creating a duplicate `lead_type` in a live CRM
produces two fields with the same name and no way to tell which one a workflow reads. That is a
silent-failure class of bug and exactly what R2 exists to prevent. The cost of waiting is a day;
the cost of a duplicate is untangling it in production.

**All 21 fields are lightly used** — the most-used appears on 9 of 180 contacts (5%), and only
32 of 180 contacts (18%) carry any custom field at all. Whatever these fields are for, they are
not part of a maintained data discipline. Our writes will be the densest use of custom fields in
the account.

---

### 3.6 Contacts — 180 total

All 180 are `type: lead`. Full pagination followed (2 pages).

Available fields per record: `id, locationId, contactName, firstName, lastName, companyName,
email, phone, dnd, dndSettings, type, source, assignedTo, city, state, postalCode, address1,
dateAdded, dateUpdated, dateOfBirth, businessId, tags, followers, country, website, timezone,
profilePhoto, additionalEmails, customFields`.

`companyName` and `website` already exist on the contact object — relevant to how we push
researched organisations.

**Lead sources — 13 distinct, 138/180 records have none.**

| Count | Source | | Count | Source |
|---|---|---|---|---|
| **138** | *(null — no source set)* | | 2 | `meta_short_lp` |
| 8 | `Facebook` | | 2 | `first home loan - new` |
| 8 | `asset finance - new` | | 2 | `home page` |
| 7 | `Calendly` | | 1 | `Website Leads form` |
| 4 | `meta_vsl_lp` | | 1 | `Discovery Session` |
| 4 | `meta_ads_encharge_capital` | | 1 | `Home Buyers Form` |
| | | | 1 | `chat widget` |
| | | | 1 | `first home loans form` |

Run 1 reported 8 sources from a 100-record sample; the true figure is 13. **77% of contacts
have no source at all** — attribution in this account is largely absent, and any reporting we
build on `source` will be reporting on the 23% minority.

These still do not match our seven `lead_source` values (`social_media · ads · referrals ·
networking · previous_client · outbound_research · other`). GHL's are campaign-level and
free-form, ours are categories, casing is inconsistent (`Facebook` vs `home page`), and several
are form names rather than sources. A translation table is needed, GHL has no equivalent of
`outbound_research`, and **the null case must map to something explicit** — not silently to
`other`. Risk R16.

---

### 3.7 Tags — 8 distinct, on 20 of 180 contacts

`locations/tags.readonly` was requested and **not granted**, so this is still derived from
contact records. Run 1's 100-record sample reported 6; the full 180 gives 8.

| Count | Tag |
|---|---|
| 7 | `fb lead-first home` |
| 6 | `fb lead` |
| 3 | `meta_vsl_lp` |
| 2 | `meta_short_lp` |
| 1 | `form submitted finance eqp` |
| 1 | `no booking yet` |
| 1 | `booking abandoned` |
| 1 | `google lead` |

**This is not necessarily the full vocabulary.** It is the set of tags currently *applied to a
contact*. A tag defined in the account but not presently on anyone — including tags the five
draft workflows are built to apply — is invisible without `locations/tags.readonly`. That scope
matters more than its tier-2 placement suggested, because the drafts in §3.2 are tag-driven.

Two conventions collide: campaign codes (`meta_vsl_lp`, `meta_short_lp`) and human-written
workflow states (`no booking yet`, `booking abandoned`, `fb lead-first home`). Mixed
snake_case, spaces and hyphens. Only 11% of contacts carry any tag.

The last three — `form submitted finance eqp`, `no booking yet`, `booking abandoned` — map
directly onto the Finance Equipment draft trio (§3.2) and are the corroboration that those
drafts have real structure behind them.

**Our Notion `Tags` property should not mirror this vocabulary.** It is campaign residue, not a
taxonomy.

---

### 3.8 Opportunities — 22, all open

All 22 have `status: open` — no won, lost or abandoned records anywhere. Distribution:
New Ad 8, First Home 7, Assest Finance 7. The two 2025 "Funnel" pipelines hold zero.

Fields include `pipelineId`, `pipelineStageId`, `monetaryValue`, `assignedTo`, `source`,
`lostReasonId`, `customFields` (empty on all 22).

No opportunity has ever been closed in this account. Either the team does not work
opportunities to completion in GHL, or the CRM is not where deals are tracked. Worth knowing
before Phase 3 writes opportunities into it.

---

### 3.9 Forms — 14

| ID | Name |
|---|---|
| `MJ8j12cyXHFaEc2HreHT` | `Website Leads form (ramim)` |
| `TgNSYDvdnovwxrKVEh5f` | `Home Page` |
| `netIhUHlIYj8RD0kfSQo` | `Home Page` *(duplicate name, different ID)* |
| `exBxW042htXjWUyL0qKY` | `Home Buyers Form - Copy #` |
| `rgKVIvkT37DaJhoGNJFH` | `Home Buyers Form` |
| `BlaKg3gSmf2R1uyLvDYq` | `First Home Loan - New` |
| `IYy3GzbZTyei6HeLwKWj` | `First Home Loans Form` |
| `a57HdyvjGkV0UX6pis7I` | `⟨NBSP⟩Calendar Form` — **leading non-breaking space (U+00A0)** |
| `twd6RNjmSQ2AMPo6cQAf` | `Asset Finance - New - FB` |
| `THcbbN43774fEyoYhymx` | `Asset Finance - New` |
| `GlHEABR4KTY9BEqHspLa` | `Asset Finance` |
| `l50zqyy9DJk6hNCdQwmu` | `1-Step Funnel - Form` |
| `MslpJ4AUB7tpKsfyBXqf` | `2-Step Funnel - Step 2 (Booking Form on Calendar)` |
| `h7GyHkM4m0LdSoIMN5gX` | `2-Step Funnel - Step 1 (Opt In) ` *(trailing space)* |

**Third instance of whitespace damage in this account.** After `"Contacted "` (stage) and
`"2-Step Funnel | Discovery Sesisons"` (typo), form `a57HdyvjGkV0UX6pis7I` — the one wired to
the Discovery Session calendar — begins with a **non-breaking space**, not a regular space. A
`trim()` will not remove U+00A0 and a name comparison will fail invisibly. **Match forms on ID.
Never trust a GHL name string.**

Heavy duplication: two `Home Page`, three Asset Finance variants, two First Home variants, one
explicitly `- Copy #`. Nobody has pruned these. Identifying "the" form for a given lead type is
guesswork from names alone.

**`GET /forms/submissions` returned `200` with `total: 0`.** Zero submissions recorded across
all 14 forms, despite 180 contacts and live funnels. Two readings: either leads arrive via Meta
lead-form sync and funnel opt-ins that do not register as GHL form submissions, or submission
history has been cleared. Either way **form submissions are not a usable data source for us**,
and — importantly for compliance — **there is no per-submission record establishing
`consent_basis` for existing contacts.** The only explicit consent artefact in the account is
the calendar consent string (§3.3). Bears on R17.

*(This route was tried specifically to recover custom field names indirectly, since form
payloads normally carry field keys. With zero submissions it yields nothing.)*

---

### 3.10 Connected social accounts — 5, two already expired

`socialplanner/account.readonly` was granted without being asked for. Directly relevant to
Phase 5 and to risks R3/R4.

| Platform | Type | Token expires | State (as of 12 Aug 2026) |
|---|---|---|---|
| Google | `location` | 2026-07-30 | ❌ **expired 13 days ago** |
| LinkedIn | `profile` | 2026-07-26 | ❌ **expired 17 days ago** |
| Facebook | `page` | 2026-09-01 | ✅ valid, **20 days left** |
| Instagram | `profile` | 2026-10-04 | ✅ valid |
| TikTok | `profile` | 2026-10-28 | ✅ valid |

Facebook, Instagram and LinkedIn are all connected here — the three platforms Phase 5 targets.
**Two caveats before treating this as a shortcut around R3/R4:**

1. GHL's social planner is a **publishing** integration. Phase 5 needs **insights/analytics**.
   A connection here does not imply readable metrics, and `socialplanner` has no insights
   endpoint in the public API.
2. The LinkedIn connection is a **`profile`**, not an organization page. R3 concerns the
   LinkedIn *Organization* API. A personal profile connection does not satisfy it.

Still worth raising with Ross: the Facebook and Instagram connections prove a Meta Business
linkage exists, which is the R4 blocker. And **two connections have silently expired** — if he
believes he is scheduling to Google Business Profile or LinkedIn, he is not. That is a finding
worth passing on regardless of our scope.

---

### 3.11 Custom values — **still unreadable**

`locations/customValues.readonly` was requested and returned `401`. Also tried under the
`locations/{id}/customValues` path only, as no alternate route exists.

**The credential question therefore stands unanswered.** GHL custom values are a common place
for API keys, webhook URLs and account config to be stored in plain text, and given R18 — a live
Anthropic key already found published in the client's prototype — the prior for this account
holding a credential in a custom value is not low.

**Nothing here is evidence of a problem.** It is an unchecked surface, and it should be checked.
It is the single highest-value item on the re-ask list for that reason, above its practical
value of avoiding config-key collisions.

---

## 4. Full endpoint results — run 2

### Granted — `200`

| Endpoint | Returned |
|---|---|
| `GET /contacts/` | 180 (paginated, 2 pages) |
| `GET /opportunities/search` | 22 |
| `GET /opportunities/pipelines` | 5 pipelines / 21 stages |
| `GET /workflows/` | 21 — **metadata only, see §1b** |
| `GET /calendars/` | 3 |
| `GET /funnels/funnel/list` | 7 |
| `GET /funnels/lookup/redirect/list` | 2 *(requires `offset`, else `422`)* |
| `GET /forms/` | 14 |
| `GET /forms/submissions` | **0** |
| `GET /conversations/search` | 171 |
| `GET /social-media-posting/{id}/accounts` | 5 |
| `GET /locations/{id}/templates` | 0 |
| `GET /emails/builder` | 0 |

### Denied — `401 "The token is not authorized for this scope."`

| Endpoint | Scope needed (inferred) | Asked for in this round? |
|---|---|---|
| `GET /locations/{id}/customFields` | `locations/customFields.readonly` | ✅ **yes — did not land** |
| `GET /locations/{id}/customValues` | `locations/customValues.readonly` | ✅ **yes — did not land** |
| `GET /locations/{id}/tags` | `locations/tags.readonly` | ✅ **yes — did not land** |
| `GET /custom-fields/object-key/{contact\|opportunity}` | `objects.readonly` | alternate path, same denial |
| `GET /calendars/groups` | `calendars/groups.readonly` | no |
| `GET /locations/{id}` | `locations.readonly` | no |
| `GET /users/` | `users.readonly` | no |
| `GET /objects/` | `objects.readonly` | no |
| `GET /surveys/` | `surveys.readonly` | no |
| `GET /businesses/` | `businesses.readonly` | no |
| `GET /links/` | `links.readonly` | no |
| `GET /custom-menus/` | `custom-menu-link.readonly` | no |

### Route does not exist — `404 "Cannot GET …"`

`GET /workflows/{id}` · `/workflows/{id}/steps` · `/workflows/{id}/actions` ·
`/workflows/{id}/versions`

**No scope will make these work.** See §1b.

Agency-level endpoints (`GET /locations/search`, `GET /oauth/installedLocations`,
`GET /snapshots/`) remain unreachable by a location-scoped Private Integration token however it
is configured. **Not worth asking for.**

---

## 5. The re-ask for Ross — short, and one of them is a correction

**Settings → Private Integrations →** the existing integration **→ Edit → tick → Save.** The
token value does not change, so nothing already working breaks.

### The correction — three scopes he thinks he granted

> "Workflows, calendars, funnels and forms all came through — thanks, that unblocked most of it.
> But **custom fields, custom values and tags are still being refused**. They're likely under a
> nested *Location* group in the scope list, separate from the top-level items. Could you check
> those three specifically?"

| Scope | Why it matters now |
|---|---|
| `locations/customFields.readonly` | **21** custom fields exist (not 9). Without names we cannot safely create `lead_type`/`lead_source` — a duplicate name in a live CRM is unresolvable. Blocks task 1.34. **R2** |
| `locations/customValues.readonly` | Unchecked credential surface (§3.11). Given R18, worth checking |
| `locations/tags.readonly` | The five draft workflows are tag-driven. We can only see tags currently on a contact — a tag a draft *writes* is invisible |

### Add to the same save

| Scope | Why |
|---|---|
| **`locations/customFields.write`** | Task 1.34 creates the missing fields. Ask now — otherwise a third trip to this screen |
| `locations.readonly` | Account timezone. Not exposed on any object we can read, and the five-minute rule is Perth-time |
| `users.readonly` | Two calendars reference user IDs we cannot resolve. Maps `owner`/assignee to real GHL users instead of free text |

### Not worth chasing

`surveys` · `businesses` · `links` · `custom-menu-link` · `calendars/groups` — nothing in the
account uses them.

---

## 6. Questions for Ross (business, not technical)

1. **The nine stages.** They exist nowhere in GoHighLevel. Are they a process you want built, or
   were you describing something else? See §7. *(Still open from run 1.)*
2. **Which pipeline receives our leads?** Three are active. Commercial and Referral partner leads
   have no obvious home. `GHL_PIPELINE_ID` is still empty.
3. **The two Funnel pipelines from Aug 2025 hold zero opportunities.** Dead, or seasonal?
4. **No contact in the account is marked Do Not Contact** — confirmed across all 180, not a
   sample. And **zero form submissions** exist, so there is no consent record for existing
   contacts either. Where do opt-outs and consent actually live? *(R17 — Spam Act.)*
5. **"Assest Finance" is misspelled**, one pipeline stage has a trailing space, and a form name
   starts with a non-breaking space. Want them corrected? We match on ID regardless, but the
   typos show in reports.
6. **NEW — is `Éire Óg GAA Joondalup` meant to be in this GHL location?** An unrelated business
   is running a live website on its own domain inside Encharge Capital's account (§3.4). It
   affects what we can safely automate account-wide. Not a problem, but we need to know.
7. **NEW — what is `FUNDD`?** A clone of the finance funnel was created on 11 Aug with no domain
   attached (§3.4). Is the finance funnel being rebranded? Phase 3 should not target a path
   that is about to move.
8. **NEW — the five draft workflows.** We can see they exist and when they were last touched, but
   **GoHighLevel's API does not expose workflow contents to anyone** (§1b). To quote accurately
   we need 10 minutes of screen-share, or a screenshot of each of the five canvases. See §9.
9. **NEW — nine or five?** We find **five** drafts. If you are counting nine, you are seeing
   something we cannot — worth reconciling before the quote.
10. **NEW — your Google and LinkedIn social connections expired in late July** (§3.10). If you
    think you are scheduling to those, you are not. Unrelated to our scope; passing it on.

---

## 7. The stage mismatch — options *(unchanged from run 1)*

Recorded so this is a decision, not a drift.

| Option | What it means | Cost |
|---|---|---|
| **A. Create a new pipeline in GHL** with Ross's nine stages | Our stages become real. Notion, database and GHL all agree | Needs `opportunities.write`. Existing 22 opportunities stay where they are, or get migrated — a separate conversation |
| **B. Map our nine onto an existing four-stage pipeline** | No GHL changes | Lossy and dishonest. Five of our nine stages collapse into "Contacted", and stage-level reporting becomes meaningless |
| **C. Keep our nine internal, sync only a coarse status to GHL** | Notion keeps full fidelity; GHL gets New Lead / Contacted / Proposal Sent / Closed | Honest and low-risk, but Ross loses stage detail in the CRM he actually works in |

Not choosing one is itself a choice — and **B is what happens by default if nobody decides.**
Needs Ross before Phase 3 is built. **R15.**

---

## 8. What this audit still could not determine

| Unknown | Why | Fixable by |
|---|---|---|
| **Workflow triggers and action steps** | **Not exposed by the GHL API at any scope** (§1b) | ❌ **Not by scopes.** Screen-share or screenshots only |
| Custom field **names and types** | `locations/customFields.readonly` denied | Scope re-ask (§5) |
| Custom **values** — the credential question | `locations/customValues.readonly` denied | Scope re-ask (§5) |
| Full **tag** vocabulary | `locations/tags.readonly` denied | Scope re-ask (§5) |
| Account **timezone** | `locations.readonly` denied; not on any readable object | Scope re-ask (§5) |
| **User** identities behind calendar assignments | `users.readonly` denied | Scope re-ask (§5) |
| **Whether the token can write** | Confirming needs a `POST`, which this task forbade. First write would land a junk record in a live CRM holding 180 real contacts | Ross confirms `.write` is ticked, **or** a controlled create-then-delete on a throwaway contact. **R14** |

Do not read the "contacts + opportunities scopes" note in `MEMORY.md` as implying write.

---

## 9. Effort estimate — bringing the draft workflows into working order

**For the client conversation.** Read the caveat first; it is the most important part.

### The caveat, stated plainly

This estimate is **not** based on the contents of the five drafts, because **GoHighLevel's API
does not expose workflow contents to anyone** (§1b). It is not a scope we can request; the
routes do not exist.

It is based on the strongest available proxies: version numbers, creation and edit timestamps,
the published siblings each draft sits beside, and the tag vocabulary those drafts operate on.
That is real evidence and it supports a defensible range — but **it is inference, and the range
is wide because of it.**

**One action collapses the range: 10–15 minutes of screen-share, or five screenshots.** Until
then, quote a range or a discovery slice — not a fixed price.

### Note before quoting: five drafts, not nine

Everything below covers the **five** drafts that exist. If Ross expects nine, reconcile that
first (§6 Q9) — the number materially changes the quote and the difference is not ours to
assume.

### Per-workflow assessment

| # | Workflow | v | Assessment | Est. |
|---|---|---|---|---|
| D5 | `New Workflow : 1782815527870` | 1 | **Barely started — effectively certain.** Auto-generated GHL name, never renamed, `createdAt == updatedAt`, one version. This is an empty canvas someone opened and abandoned | **0.5 h** to confirm and delete — **or 5–7 h** if Ross wants something built here, in which case it is new work, not completion |
| D1 | `FB Lead form - Asset Finance` | 6 | **Abandoned duplicate — high confidence.** A published `FB Lead form Asset Finance` sits at **v23**. Two names one hyphen apart. The live one has 17 more versions | **1 h** to compare and discard — **or 4–6 h** if it is an intended replacement, which means reconciling against a v23 workflow that is live on real leads |
| D2 | `Finance Equipment Appointment Booked → Tags` | **10** | **Substantially complete — best-evidenced of the five.** 10 versions in 2 days is concentrated build effort. Purpose is narrow and stated in the name. Its tags exist in the account | **3–5 h** |
| D3 | `Finance Equipment Email – Booking Abandoned Follow-up` | 8 | **Substantially built.** Its `booking abandoned` tag exists on a live contact. Email sequence, so the work is copy, timing and exit conditions rather than structure | **4–6 h** |
| D4 | `Finance Equipment Meeting Booked - Follow Up` | 6 | **Partially built.** Built in a single sitting, least mature of the trio, and the trio's other two absorb the shared design decisions | **3–5 h** |

**Substantially complete: D2, D3, D4** — the Finance Equipment trio. All three sit alongside a
*published* `Finance Equipment Form Submitted` (v9) from the same two days. The entry point was
finished and published; these three follow-ups were built and never switched on. Their tags are
present in the account. This is a coherent, mostly-built sequence that stalled — not three stubs.

**Barely started: D5** (empty stub) and **D1** (abandoned duplicate of a live v23 workflow).

### Work required regardless of what is in the canvases

This is the part that does not shrink when the drafts turn out to be well-built, and it is
where fixed-price GHL work usually goes wrong.

| Item | Est. | Why it is not optional |
|---|---|---|
| **Overlap audit of the 16 published workflows** | **4–6 h** | Two live lead-capture workflows sit at v23 and v26 — the account's real automations. Publishing a draft that fires on the same trigger **double-texts real people**. Contents are unreadable via API, so this is manual, and it is the single highest-risk item in the engagement |
| **Compliance pass — Spam Act / Do Not Call** | **3–4 h** | Zero of 180 contacts are marked `dnd`, **zero** form submissions exist, and the only consent artefact in the account is a calendar checkbox (§3.3, §3.9). Every outbound email or SMS step needs a consent basis, sender identification and a working unsubscribe before it is switched on. Non-negotiable — CLAUDE.md §7 |
| **Test passes with throwaway contacts** | **2–3 h** | Every path walked end-to-end before publishing. Live CRM, 180 real people |
| **Publish, monitor, first-fire verification** | **1–2 h** | Draft → published is where timing and exit-condition bugs surface |

### The number

| Scenario | Drafts | Cross-cutting | **Total** |
|---|---|---|---|
| **Best case** — D2/D3/D4 near-complete; D5 and D1 both discarded | 11.5 h | 10 h | **~21 h** |
| **Expected** | 15 h | 12 h | **~27 h** |
| **Worst case** — drafts are thin despite version counts; D5 built from scratch; D1 reconciled against the live v23 | 29 h | 15 h | **~44 h** |

**Take ~27 hours as the working number**, with a range of **21–44**.

Two things to say out loud in the client conversation:

1. **Roughly 40% of this is not the drafts at all.** It is making sure five new automations do
   not collide with sixteen existing ones, and that outbound messaging is Spam Act compliant
   before it reaches anyone. That work is fixed regardless of how complete the drafts turn out
   to be, and it is the part that protects him.
2. **Two of the five are probably deletions, not builds** — an empty stub and a duplicate of a
   workflow that is already live and far more developed. Worth confirming before he pays to
   "finish" them.

### Recommendation

Do not quote fixed-price yet. Either:

- **Quote the range** with the discovery caveat stated, **or**
- **Sell a short paid discovery slice** — 2 hours, screen-share plus the scope re-ask in §5 —
  and quote firm afterwards. That converts a 21–44 hour range into a ±15% number and costs the
  client less than the spread.

The uncertainty here is a genuine platform limitation, not a gap in this audit. Saying so
directly is more credible than a confident number that later moves.

---

## 10. Next steps

1. **Send the §5 re-ask.** Lead with the correction — three requested scopes did not land.
2. **Get the five draft canvases** — screen-share or screenshots (§6 Q8). Blocks a firm quote.
3. **Reconcile nine vs five drafts** with Ross (§6 Q9) before quoting.
4. **Do not create any custom field** until `locations/customFields.readonly` lands. **R2.**
5. **Get a decision on §7** before any Phase 3 stage-mapping work. **R15.**
6. **Resolve the write question** (§8). **R14.**
7. **Populate `ghl_field_map`** from the 21 custom field IDs once names are readable.
8. **Ask about `Éire Óg GAA Joondalup` and `FUNDD`** (§6 Q6, Q7) before Phase 3 targets funnels.
9. **Pass on the expired social connections** (§6 Q10). Outside our scope; useful to him.
