# EXISTING-PROTOTYPE.md — Technical assessment of enchargecontrol.netlify.app

**Assessed:** 11 Aug 2026 · **Target:** `https://enchargecontrol.netlify.app/` · **Status:** complete

Ross refers to this as his AI agent and has asked whether it is usable. This is the honest
technical answer, for the scope document.

**Convention used throughout:** every claim is marked **[OBSERVED]** (I fetched it, rendered it,
or measured it) or **[INFERENCE]** (my reading of what it means). Nothing below is assumed.

---

## 0. Verdict in one paragraph

The prototype is a **single 36 KB HTML file with no backend**, containing a **live Anthropic API
key in plain text, served publicly to anyone who opens the page**. That one fact makes it
unusable as a foundation and makes revoking the key urgent regardless of what happens next.
Setting security aside, the thing is more finished than "prototype" suggests — seven working
tools, no dead buttons, no console errors, and a genuinely good ~4 KB distillation of Ross's
business context. **The prompt content is worth keeping. The delivery mechanism is not.**

---

## 1. Method, and what I deliberately did not do

**Did:** fetched the page and headers; searched the source for credential patterns; probed seven
paths for a backend; rendered the page in Chrome at 1440×900 and 390×844; clicked through all
seven tabs; measured layout; ran a local copy with the key redacted and intercepted the outbound
API request to prove the wiring.

**Deliberately did not:**

- **I did not validate the API key.** Testing it would spend the client's money and use a
  credential I had just found compromised. Its format matches Anthropic's live key format
  exactly (`sk-ant-api03-` prefix, 108 characters), but **whether it is currently active is
  untested**. This does not change the recommended action — see §2.
- **I did not trigger any generation against the live site.** Every Chrome session had
  `api.anthropic.com` blocked at the network layer as a hard guard (**[OBSERVED]** — the run
  reported `anthropic requests blocked: 0`, i.e. the page made no such call merely from loading
  and tab-switching). The one functional test that does fire a request ran against a **local
  copy with the key replaced by a placeholder**, and the request was aborted before leaving the
  machine.
- **The key is not reproduced in this document, in MEMORY.md, or anywhere in the repo** (rule 19).

---

## 2. CRITICAL — the Anthropic API key is exposed client-side

**[OBSERVED]** Line 375 of the served HTML:

```js
const ANTHROPIC_API_KEY = 'sk-ant-api03-…';   // 108 chars, redacted here
```

**[OBSERVED]** It is used at line ~389 in a `fetch` straight from the browser:

```js
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  },
  ...
```

**[OBSERVED]** I confirmed the key actually travels on the wire by intercepting the request from
a real browser click on *Qualify This Lead*:

```
method: POST      hasApiKeyHeader: true      x-api-key: sk-ant-REDACTE…[MASKED]
model: claude-sonnet-4-20250514             max_tokens: 2000
```

**[OBSERVED]** There is no build step, no bundler, no minification — the key is in readable
plain text in the page source. `view-source:` is enough. No developer tooling required.

**[OBSERVED]** The header `anthropic-dangerous-direct-browser-access: true` is set. Anthropic
requires this header specifically to opt in to browser-side calls; the word *dangerous* is theirs.

### Why this is the finding that decides everything

**[INFERENCE]** Anyone who has opened that URL — or any crawler, archive, or browser extension
that touched it — can extract the key and bill Ross's Anthropic account. Anthropic keys carry no
IP restriction and no per-key origin binding. The agreed **$50/month spend cap is unenforceable**
against a third party holding the key, because that cap is a control in our pipeline, not
something Anthropic enforces on the account.

**[INFERENCE]** The exposure is not undoable by taking the site down. The key has been served
publicly; it may sit in browser caches, Netlify deploy history, and web archives. **Revocation is
the only fix.** You cannot un-publish a secret.

### Required action, in order

1. **Revoke the key now** in the Anthropic Console — before the scope conversation, not after.
   This is correct whether or not the key is still active, and costs nothing if it was already dead.
2. **Check Anthropic usage/billing** for spend that does not match Ross's own use.
3. **Set an account spend limit** in the Console as defence in depth.
4. Only then decide what happens to the site itself.

---

## 3. Architecture — there is no backend

**[OBSERVED]** The entire application is one file: `HTTP 200`, `Content-Type: text/html`,
**36,025 bytes**, 740 lines, served by Netlify. The HTML contains exactly one `<script>` tag and
one `<style>` block, both inline. **There are no external JS or CSS bundles** — the only
`<script>`/`<link>` element in the document is that single inline script.

**[OBSERVED]** Seven probes for a backend, all 404:

| Path | Status |
|---|---|
| `/.netlify/functions/` | 404 |
| `/.netlify/functions/chat` | 404 |
| `/api/` | 404 |
| `/api/chat` | 404 |
| `/_redirects` | 404 |
| `/robots.txt` | 404 |
| `/netlify.toml` | 404 |

**[OBSERVED]** The only external host referenced anywhere in the source is
`https://api.anthropic.com/v1/messages`. There is no other URL in the file.

**[INFERENCE]** It is a static page talking directly to a third-party API. There is no server to
put a key behind, no place to enforce rate limits, no audit log, and no way to add access
control. This is why the key exposure is structural rather than a slip — with no backend, there
is nowhere else for the key to live.

---

## 4. State — localStorage only

**[OBSERVED]** Exactly two storage keys, both `localStorage`. No `sessionStorage`, no
`indexedDB`, no cookies:

| Key | Contents | Cap |
|---|---|---|
| `ec_chat` | Chat history | last **40** messages |
| `ec_memories` | Saved "memories" — `{text, date, id}` | max **50**, oldest dropped |

**[OBSERVED]** I tested the persistence claims by adding a memory and reloading:

| Test | Result |
|---|---|
| Add memory, reload same browser profile | **survives** (1 → 1, badge reads "1 memories") |
| Open in a **fresh browser profile** (simulates his phone, or another browser) | **0 memories — nothing carries over** |

**[OBSERVED]** The Memory tab tells the user: *"Everything you've saved permanently. This context
is automatically added to every conversation and agent."*

**[OBSERVED]** The second half of that claim is **true** — I intercepted the outbound request and
confirmed a saved memory was present in the system prompt (`systemIncludesSavedMemory: true`,
system prompt 4,037 characters).

**[INFERENCE]** The word **"permanently" is misleading**, and this is the second most important
finding after the key. Memory is per-browser and per-device. Anything Ross saves on his laptop is
invisible on his phone. Clearing site data, switching browsers, or using a private window loses
it silently — with no export, no sync and no warning. Given CLAUDE.md §1 records that **Ross works
from his phone**, a memory feature that does not cross devices does not deliver what the feature
name promises.

---

## 5. What it actually does — all seven tabs are wired

**[OBSERVED]** Seven tabs, all functional. I clicked every one and screenshotted each at both
widths. **No dead buttons:** I enumerated every `onclick` handler in the DOM and checked each
against `window` — all seven (`switchTab`, `runTool`, `sendChat`, `quickChat`, `copyResult`,
`addMemoryFromPanel`, `saveMemoryFromBar`) are defined. **No placeholders, no console errors.**

| Tab | What it does | Wired? |
|---|---|---|
| 💬 Chat | Free chat with 5 suggested prompts, history in `localStorage` | ✅ |
| 🎯 Lead Qualifier | Paste lead details → score Hot/Warm/Cold + call approach | ✅ |
| 📱 Content Generator | Social/content generation | ✅ |
| 📧 Follow-up Sequences | Email/SMS sequences | ✅ |
| 📞 Sales Scripts | Call scripts | ✅ |
| 🚀 Ad Copy | Meta/Google ad copy | ✅ |
| 🧠 Memory | Add/delete saved insights, injected into system prompt | ✅ |

**[OBSERVED]** All five tool tabs share one `runTool()` function with a per-tab prompt template,
calling the same `callClaude()`.

**[OBSERVED]** Model in use: **`claude-sonnet-4-20250514`**.
**[INFERENCE]** Two generations behind this project's standard (`claude-sonnet-5` per CLAUDE.md
§2) — a one-line change, noted only for completeness.

**[OBSERVED]** There is **no integration with GoHighLevel, Notion, Supabase, Google Sheets, Make
or any CRM**. The single keyword match in the file is line 385, inside the prompt text:
`- Stack: HubSpot CRM, Make/Zapier, Notion | ACL: 523711`.
**[INFERENCE]** That line is also **stale** — D11 records the CRM as GoHighLevel, not HubSpot.
The tool tells the model the wrong CRM.

**[INFERENCE]** This is a prompt library with a good UI, not an agent. It reads nothing, writes
nothing, and takes no action. Nothing it produces is stored anywhere but the browser.

---

## 6. Mobile usability — works, but was not designed for it

**[OBSERVED]** **Zero `@media` queries in the entire file.** The layout is a single flex column
sized with `height: 100vh` and `overflow: hidden` on `body`.

**[OBSERVED]** Measured at 390×844 (iPhone 14 Pro) in Chrome:

| Measurement | Value | Verdict |
|---|---|---|
| Page horizontal overflow | `scrollWidth 390` = `innerWidth 390` | ✅ none |
| Tab strip width | `scrollWidth 972` vs `clientWidth 390` | ⚠️ ~60% of tabs off-screen |
| Input font size | **12px** | ⚠️ under 16px |
| Smallest tap target | **36px** | ⚠️ under guidance |
| Console errors | none | ✅ |

**[OBSERVED]** The screenshots show the tab strip clipping mid-word — "Content Generat…" — and
the header title wrapping to two lines with the badge squeezed beside it.

**[INFERENCE]** It is usable on a phone but not pleasant. Three concrete issues:

1. **Four of seven tabs are off-screen** with no visual affordance that the strip scrolls. The
   `overflow-x: auto` makes it swipeable, so this is discoverability rather than breakage.
2. **12px inputs trigger iOS Safari's auto-zoom on focus** — Safari zooms any input under 16px,
   and the page cannot zoom back out because it is `height: 100vh; overflow: hidden`. This is the
   most likely thing to feel broken in daily phone use.
3. **`height: 100vh` fights mobile browser chrome**, where `100vh` exceeds the visible viewport.

**[INFERENCE]** All three are fixable in well under a day. They are not why the tool should be
replaced — §2 is.

Evidence: [desktop chat](assets/prototype/desktop-chat.png) ·
[mobile chat](assets/prototype/mobile-chat.png) ·
[mobile lead qualifier](assets/prototype/mobile-leads.png)

---

## 7. Other credentials

**[OBSERVED]** I scanned the source for seven credential shapes — `sk-*`, `pit-*` (GoHighLevel),
`secret_*` and `ntn_*` (Notion), `eyJ*` (JWT / Supabase), `AIza*` (Google), `xox*` (Slack).
**The Anthropic key is the only credential present.** No GHL token, no Notion token, no Supabase
key, no Google key.

**[OBSERVED]** One other identifier appears: **`ACL: 523711`** in the prompt text.
**[INFERENCE]** An Australian Credit Licence number — public business information, published on
the client's own website. Not a secret and not a finding.

---

## 8. Salvage vs rebuild

Ross put real work into this and it deserves a fair reading. Splitting it honestly:

### Worth keeping

| Asset | Why | Where it goes |
|---|---|---|
| **The ~4 KB business-context prompt** | The single most valuable thing here. Avatar, away-from/towards motivators, Red/Green Brain, Rule of One, proven hooks, 3 Pillars, funnel rules, call scripts — distilled and already validated by Ross | Merge into `CLIENT-CONTEXT.md` §5/§9/§10/§11, then load from there. **Fix the HubSpot→GoHighLevel line first** |
| **The five tool prompt templates** | Lead qualification, content, follow-up, scripts, ad copy — a working starting point for Phase 4's `generate_content_from_url` | `src/lib/prompts/` as versioned, testable strings |
| **The tab/tool information architecture** | Seven categories match how Ross actually thinks about his work. Validated by use | Informs the Notion view structure and the Phase 4 tool list |
| **The visual design** | Dark gold-on-black, clean, on-brand, no console errors | Reference only — Notion cannot be styled this way |
| **Proof of appetite** | He built and used it. Strong signal the conversational layer in Phase 4 is genuinely wanted, not a nice-to-have | Confidence for Phase 4 scope |

### Must be rebuilt

| Problem | Why it cannot be patched |
|---|---|
| **Key in the browser** | Structural. With no backend there is nowhere to put it. Fixing this *is* building a backend |
| **No backend** | No auth, no rate limiting, no audit log, no spend enforcement, no idempotency. CLAUDE.md rules 8, 9, 19 are all unmet and unmeetable in a static file |
| **localStorage memory** | Rule 12 requires provenance on every field, and D1 makes the database the source of truth. Browser-local, device-bound, 50-item, silently-lossy storage cannot satisfy either. Phase 4's memory tiers (`memory_chunks`, `memory_facts` with embeddings and supersede) are a different design entirely |
| **No integrations** | The whole value of this project — GHL, Notion, Sheets, research pipeline — is absent |
| **No validation** | Rule 13 requires Zod-validated model output. Output goes straight to `innerHTML` |
| **No tests** | Rule 21 sets an 80% floor. There is no test surface in a single HTML file |

**[INFERENCE]** Rough split: **the prompt content is ~90% reusable, the code ~0%.** That is not a
criticism of the code — it does what it set out to do. It is that "static page calling an API
directly from the browser" and "auditable multi-source pipeline writing to a live CRM" are
different classes of system.

---

## 9. What this means for scope

**[INFERENCE]** Three points for the scope document:

1. **This does not change D12.** Notion remains the interface. If anything the prototype supports
   it — Ross clearly wants a conversational layer, and Phase 4 delivers exactly that, on a backend
   that can hold a key safely.
2. **The prototype is not a shortcut.** It cannot be extended into the delivery. Reusing the
   prompt content saves real time in Phase 4; reusing the code saves none.
3. **The key exposure is worth telling Ross about directly and plainly**, separately from the
   scope conversation. It is a live billing exposure on his account today, it is not his fault for
   not knowing, and the fix takes two minutes. Lead with the fix, not the diagnosis.

**[INFERENCE]** Suggested framing for Ross: *the thinking in it is good and we are keeping it —
the business context is going straight into the new system. What has to change is where it runs.
Right now your API key is visible to anyone who opens the page, so revoke it today; the new build
keeps it on the server where it belongs.*

---

## 10. Open questions

1. **Is the key still active?** Untested by choice (§1). Revoke regardless.
2. **Has it been used by anyone else?** Only the Anthropic Console usage log can answer this.
3. **Who else has the URL?** No `robots.txt` (404), so nothing discourages crawling. **[INFERENCE]**
   Exposure window is from first deploy to revocation, and the deploy date is unknown to us.
4. **Does Ross want the site kept alive** in read-only form as a reference while Phase 4 is built?
   Only safe *after* the key is revoked — at which point every tab stops working.
