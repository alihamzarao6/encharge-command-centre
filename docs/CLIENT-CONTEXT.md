# CLIENT-CONTEXT.md — Encharge Capital

Grounding truth for every prompt in the system. If a prompt needs business judgement, it
pulls from here — not from the model's general knowledge.

Sources: client-supplied Notion knowledge base, plus direct confirmations from Ross Byrne
over WhatsApp (08–09 Aug 2026) and the Scope v3 / Stage 1 sign-off conversation (22 Aug
2026). Confirmed items are marked. Nothing here is assumed.

**Scope v3 (22 Aug 2026) is binding — `docs/MEMORY.md` D23–D32.** The B2B outbound
lead-research engine is out of scope and was never asked for. The research-side material in
this file (§2 research routing, §5–§7 rubrics and rejects) is **parked under the heading
before §5**, not deleted. §1 (business), §9 (copy frameworks), §10 (avatar) and §11
(operational rules) are the grounding for Stages 2–5 and are unchanged.
**Brand:** the client is rebranding **Encharge Capital → Fundd** (`fundd.com.au`), D25.
GoHighLevel stays white-labelled at `app.enchargecapital.com`; notifications go to
`rossb@fundd.com.au`.

---

## 1. The business

| | |
|---|---|
| Name | Encharge Capital |
| Site | enchargecapital.com.au |
| Market | Perth, Western Australia |
| Type | Independent finance / mortgage brokerage, 40+ lender panel |
| Primary contact | Ross Byrne |
| CRM | **GoHighLevel**, white-labelled at app.enchargecapital.com — *confirmed by Ross* |
| Automation | Make.com currently; n8n introduced by this project |

**Positioning:** not a bank. Independent, no bank bias, works for the client not the lender.
Stated enemy is the banks — they knocked you back, they're biased, they work for themselves.

**Three pillars** used in every sales conversation:
1. Independent access — 40+ lenders, not tied to any bank
2. No-stress process — handled end to end, first call to settlement
3. Long-term partnership — rate monitoring and next-step help after settlement

---

## 2. Lead types — eight categories

*Confirmed by Ross. This resolves the earlier ICP ambiguity.*

| # | Lead type | Automated research *(PARKED — D23)* | What it is |
|---|---|---|---|
| 1 | Commercial | ~~Yes — Rubric A~~ parked | Businesses seeking commercial finance |
| 2 | Asset finance | ~~Yes — Rubric A~~ parked | Businesses seeking equipment or vehicle finance |
| 3 | Referral partner | ~~Yes — Rubric B~~ parked | Businesses who send Encharge deals |
| 4 | First home owner | No — tracking only | Individuals from ads and forms |
| 5 | Refinance | No — tracking only | Individuals |
| 6 | Investors | No — tracking only | Individuals |
| 7 | Referrals | No — tracking only | Individuals referred in |
| 8 | Building | No — tracking only | Individuals |

**Under Scope v3 no lead type is researched.** The research routing ("types 1, 2 and 3 get
Rubric A/B, types 4–8 are tracking only") belonged to the parked lead-research engine (D23);
the growth to eight types and two rubrics is itself recorded as out of scope in R6. The
taxonomy is kept here for the record and because the Notion Intake database already offers
all eight (D20). Stage 1 did not build on it — the live Finance Pipeline and its ten custom
fields (§3) are not keyed on lead type. Do not reintroduce research routing without a new
dated decision.

Historical note, kept: the research-on-3-types distinction was stated to Ross in writing
three times and is recorded in the 09 Aug scope document — which Scope v3 has since
superseded.

---

## 3. Pipeline stages — the Finance Pipeline, ten stages, live in GoHighLevel

*Built in Stage 1, signed off and paid 22 Aug 2026 (D28). Pipeline name in GHL: **"Finance
Pipeline"**, location `tgw5Q3BnoZoSsVOnRUxB`.*

```
New Lead → Appointment Booked → Contacted → Qualified → Docs Requested → Docs Received
         → Submitted to Lender → Approved → Settled → Lost / Not Proceeding
```

GoHighLevel is the system of record for pipeline state (§11 — conversion metrics reconcile
against the CRM). Anything that reads or writes a stage matches it on the **GHL stage ID,
never the name** — this account has already produced three name-matching traps (trailing
space, typo, non-breaking space; `docs/MEMORY.md` 12 Aug). Any copy of the stage held in our
database or mirrored into Notion uses these ten values; editability of a mirrored stage
follows §8.

Ten custom fields were created alongside the pipeline, in **their own folder**, deliberately
separate from the account's 21 older fields: Loan Type, Loan Amount, Property Value, Deposit
Amount, Employment Type, Annual Income, Credit Concerns, Lead Source, Preferred Contact Time,
Current Interest Rate. Five live workflows: New Lead Intake, Instant Lead Reply, 24hr No
Contact Alert, Document Chase, Stage Notifications — copy written for refinance, not first
home buyer. One notification per lead (two if the lead also books), D32.

**Superseded — never built (R15).** The nine stages Ross gave on 08 Aug, including the later
insertion of "Docs sent", were a plan recorded here as fact for two weeks. They exist nowhere
in GHL. Kept for the record only:
`Lead in → Full details → Booked into Calendar → Docs sent → Ongoing loan app → No show →
Retarget → Disqualify → Settled`.

---

## 4. Lead source

*Confirmed by Ross.* Every lead is tagged with where it came from:

`social_media · ads · referrals · networking · previous_client · outbound_research · other`

`outbound_research` was to be set automatically for anything the research engine discovered
itself — **parked with that engine (D23); nothing sets it now.** The rest are set by Ross or
by the intake form. The list is extendable. Note that GoHighLevel's own lead sources are
campaign-level free text (`Calendly`, `meta_vsl_lp`, `Facebook`…) and do not match this list
— R16; Stage 1 added a `Lead Source` custom field in GHL (§3). Decide the translation before
anything syncs the two.

---

## OUT OF CURRENT SCOPE — parked research-engine material (§5–§7)

**Everything from here to §8 belongs to the B2B outbound lead-research engine, which Scope v3
(22 Aug 2026, D23) puts out of scope. It was never asked for by the client.** The two rubrics
and the reject/review rules are kept verbatim — they were expensive to work out and remain
correct if that work ever returns — but **nothing in Stages 2–6 builds on them, and no prompt
may pull from §5–§7.** Section numbers are preserved so that references to §8–§11 elsewhere
(MEMORY.md, SCHEMA.md, the Notion property descriptions) stay valid. D5, D6, D13, D14 and D15
are parked with this material.

---

## 5. Rubric A — business finance leads (Commercial, Asset finance) — *PARKED, D23*

Score 0–100. Tier: A ≥ 80, B 60–79, C 40–59, D < 40.

| Dimension | Weight | Scoring guidance |
|---|---|---|
| Geography | 20 | Perth metro 20 · regional WA 15 · other AU 5 · international 0 (hard reject) |
| Industry fit | 25 | Asset-heavy / capital-intensive 25 · services with growth signals 18 · low-capital services 10 · competitor 0 (hard reject) |
| Size fit | 15 | 10–200 staff 15 · 5–9 staff 10 · 200+ 8 · under 5 4 |
| Decision-maker access | 20 | Owner / C-suite with verified email 20 · director or GM verified 15 · manager 8 · generic inbox only 3 |
| Finance-need signals | 15 | Multiple explicit signals 15 · one signal 9 · none visible 3 |
| Data quality | 5 | All core fields verified 5 · partial 3 · thin 1 |

**Ideal organisation:** Perth metro or wider WA; asset-heavy or growth-stage SME —
construction and trades, transport and logistics, civil and earthmoving, agriculture,
manufacturing, healthcare practices, hospitality groups, professional services; 5–200 staff;
owner-operated or closely held.

**Finance-need signals:** fleet or plant on site, recent expansion, new premises, active
hiring, new equipment purchases, multiple sites, franchise growth.

**Ideal contact:** Owner, Founder, Managing Director, CEO, CFO, Finance Director, General
Manager, Operations Director. Whoever can authorise borrowing.

---

## 6. Rubric B — referral partners — *PARKED, D23*

*Confirmed by Ross: real estate agents, accountants, financial planners, buyers agents, car
dealerships, machinery dealers, and similar.*

The question is not "do they need finance" but **"how many deals could they send us"**. A
busy agency with several agents scores far higher than a one-person operation.

Score 0–100. Same tier bands.

| Dimension | Weight | Scoring guidance |
|---|---|---|
| Referral volume potential | 30 | 10+ agents/brokers/advisers 30 · 4–9 staff 22 · 2–3 staff 12 · sole operator 5 |
| Partner type fit | 20 | Real estate agency, accounting firm, financial planner, buyers agent 20 · car dealership, machinery/equipment dealer 18 · adjacent professional services 12 · unrelated 0 |
| Geography | 20 | Perth metro 20 · regional WA 14 · other AU 4 · international 0 (hard reject) |
| Decision-maker access | 20 | Principal / partner / dealer principal with verified email 20 · branch or sales manager verified 14 · other staff 7 · generic inbox only 3 |
| Independence | 10 | No in-house finance arm 10 · unclear 5 · has in-house broker or is bank-aligned 0 |

**Independence matters most.** An agency with its own in-house broker will never refer out.
Look for "our finance partner", "in-house finance", "finance available", a named broker on
the team page, or ownership by a bank or lender group.

**Hard rejects (Rubric B):** outside Australia · is itself a mortgage or finance broker ·
owned by a bank or lender · already in GoHighLevel as an active partner.

---

## 7. Hard rejects and review triggers — both rubrics — *PARKED, D23*

*The review-trigger pattern (low confidence → human review, never straight to the CRM) is
still a live rule for Stages 4–5 — see CLAUDE.md rule 14. The specific thresholds below were
tuned for lead research and are parked with it.*

**Deterministic hard rejects, applied before the model runs:**
- Not in Australia
- Bank, lender, mortgage broker or finance broker (competitor)
- Government department or public agency
- Sole trader with no ABN presence and no website
- Already present in GoHighLevel as a client, active opportunity or existing partner

**Flag for human review when:**
- Model confidence < 0.70
- Website resolution confidence < 0.80
- Email status is `catch_all`, `unknown`, or inferred without a confirmed domain pattern
- Fuzzy duplicate match above the similarity threshold
- Industry or partner-type classification is ambiguous, or the site is a holding page
- Referral partner shows possible in-house finance but it is not clear-cut

---

## 8. Editable fields

*Ross asked for "everything as editable as possible".* Resolved as follows, because the
database is the source of truth and a blind two-way sync would let a Notion edit be
overwritten by the next run.

**Editable in Notion, synced back to the database:**
`pipeline_stage · lead_type · lead_source · status · owner/assignee · notes ·
manual_score_override · review decisions (approve/reject) · tags`

**Read-only in Notion** — system-derived, carries provenance:
`extracted contact fields · source_url · fetched_at · email_status · confidence ·
AI score and reasoning · rubric_version · crawl data`

If Ross needs to correct a system-derived field, it is corrected through the review queue,
which writes an audited override rather than silently editing the record. Overrides are kept
alongside the original value, never on top of it.

---

## 9. Copy and content frameworks (for `generate_content_from_url`, Phase 4)

Generated content follows the client's own frameworks, not general best practice.

**Red Brain vs Green Brain.** Red = logical/feature ("Perth mortgage broker", "40+ lenders").
Green = emotional/outcome ("stop paying off someone else's mortgage", "find out what you can
borrow in 15 minutes"). Hooks and CTAs are Green. Body copy is Red.

**Green Brain roadmap:** what it is → the result → the emotional effect.

**Rule of One:** one idea, one promise, one story, one emotion, one CTA. Per asset.

**Hook rules:** implies who it's for, implies who it's *not* for, piques curiosity. Never ask
the audience whether they're the audience — show them you understand them.

**Meta ad structure:** Hook (Green) → Body (Red: urgency, scarcity, social proof, authority,
familiar language, benefits not features) → CTA (Green: action + emotional benefit).
Headline under 28 characters. The ad sells the click, not the product.

**Google ad structure:** H1 service keyword · H2 away-from hook · H3 CTA · D1 shortened hook
· D2 justification.

**Video rule:** don't make it look like an ad. No logo, no intro, no brand animation at the
start. Hook immediately. Camouflage as organic.

**Tribalism angle:** the customer's enemy is the banks; Encharge is the ally.

**Proven angles from their playbook:** rent paying the landlord's renovation · congratulations
posts cutting deeper · the house that sold for 50k more · the barista who owns more property.
Levers: comparison, injustice, loss aversion, status anxiety, specific-imagery FOMO.

---

## 10. Consumer avatar — context for content, not for ranking

Types 4–8 are not researched or scored, but content written for them must land:

- 25–38, Perth metro, male skew or couples
- Tradies, nurses, teachers, mid-level corporate, small business owners
- **Away from:** renting is dead money · home ownership slipping away · stuck in the rat race
  · paying off someone else's mortgage
- **Towards:** get on the property ladder · financial freedom · smart financing
- **Already tried:** knocked back by banks · can't build savings · don't know borrowing
  capacity · confused by online info · scared to act · self-employed with no idea where to start

---

## 11. Operational rules that constrain the build

- **Speed rule — five minutes.** A new lead gets an instant SMS and email, then a call within
  five minutes. Nothing this system does may add latency to that path. Research enrichment
  runs *alongside*, never as a blocker.
- **Three-day booking rule.** Discovery sessions booked today or within two days. Show rates
  collapse beyond that.
- **Reminder cadence.** Confirmation → 24h → 1h → 30min.
- **Source of truth for conversion metrics is the CRM.** Our pipeline metrics reconcile
  against GoHighLevel, they do not compete with it.

---

## 12. Resolved questions

| # | Question | Answer | Date |
|---|---|---|---|
| 1 | Which CRM? | GoHighLevel. Close and HubSpot both dropped | 08 Aug |
| 2 | B2B or consumer? | ~~Both — 8 lead types, research on 3 of them~~ **Superseded 22 Aug (D23):** no research on any type; the engine is out of scope | 08 Aug → 22 Aug |
| 3 | Notion or custom dashboard? | ~~Notion. Ross wants a phone app; custom build declined~~ **Superseded 22 Aug (D29):** a dashboard is in scope at Stage 3; Notion stays as an internal working surface | 08 Aug → 22 Aug |
| 4 | Pipeline stages? | ~~Nine, listed in §3~~ **Superseded 22 Aug (D28):** the ten-stage Finance Pipeline, built and live — §3. The nine were never built | 08 Aug → 22 Aug |
| 5 | Lead sources? | Listed in §4 | 08 Aug |
| 6 | Alert email? | ~~Ross@enchargecapital.com~~ **Superseded 22 Aug (D25):** `rossb@fundd.com.au` | 08 Aug → 22 Aug |
| 7 | Monthly spend cap? | $50/month, stated to Ross as the starting cap | 08 Aug |
| 8 | Google Sheet? | "Finance leads", access granted. *Was the research-export target — parked with the engine (D23)* | 08 Aug |
| 9 | Database platform? | **Supabase**, confirmed by the client. MongoDB question closed (D24) | 22 Aug |
| 10 | What is the project? | **Scope v3:** AI assistant trained on the client's voice, persistent cross-device memory, reads websites and stores what it finds, generates social posts / carousels / ad copy, sits on a dashboard, GHL + Meta underneath. Six stages; 1320 total, 198 per sign-off on stages 1–4, 528 at the end (D23, D26, D27) | 22 Aug |
| 11 | Brand? | Rebranding **Encharge Capital → Fundd** (`fundd.com.au`). GHL stays at `app.enchargecapital.com` (D25) | 22 Aug |
| 12 | Lead path? | Facebook ad video → **FUNDD** landing page (stays on `sites.leadconnectorhq.com` — `fundd.com.au` belongs to the aggregator group, no domain swap) → form → Discovery Session booking (D30) | 22 Aug |
| 13 | Meta pixel? | **Refi Pixel**, of six in the account. Conversions API sends `Lead` server-side on a token scoped to that pixel only (D31) | 22 Aug |

## 13. Still open

| # | Question | Blocks |
|---|---|---|
| ~~A~~ | ~~**Supabase or MongoDB?**~~ **Closed 22 Aug — Supabase, confirmed (D24).** The pause was free-tier idle auto-pause; unpause at Stage 2 kickoff | — |
| B | Voyage AI account and key — still needed for the Stage 3 memory layer (R5) | Stage 3 |
| ~~C~~ | ~~GoHighLevel: map to existing custom fields, or create new ones?~~ **Resolved by construction 22 Aug:** Stage 1 created ten new fields in their own folder; the 21 pre-existing fields stay unmapped and untouched (R2) | — |
| ~~D~~ | ~~Meta Business account linked, app permissions granted?~~ **Closed 22 Aug by Stage 1 (R4):** Refi Pixel + Conversions API live; ad account and pixel access granted | — |
| E | LinkedIn developer app approved, Ross admin on the page? — **parked (R3):** scheduled social *insights* are not in Scope v3 | parked |
| F | Separate "finance CRM" Ross mentioned — out of current scope, revisit when raised | future |
| G | **`finance-option.com.au` has been sending data to Refi Pixel since June 2026** — stale install, aggregator page, or a third party? Do not filter it before the origin is known (R24) | Stage 1 attribution / privacy — ask Ross |
| H | Where do opt-outs and consent live? No contact is marked `dnd`, zero form submissions, no consent record for the ~180 existing contacts (R17) | Any outbound |
| I | Is `Éire Óg GAA Joondalup` meant to share the GHL location? Until answered, nothing account-wide may be changed (R22, R25) | Every stage |
