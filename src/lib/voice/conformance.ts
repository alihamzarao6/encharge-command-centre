/**
 * Voice conformance checks (Stage 2 part 5). Pure functions over a prompt and the text the
 * model produced for it. Every check is a rule from CLIENT-CONTEXT.md or the FND-240
 * boundary made mechanical: it passes or fails in code, with a detail string that says what
 * was found, so "sounds about right" never decides.
 *
 * Checks are deliberately literal. A check that is too lax is worse than one that is too
 * strict, because the fixtures are recorded once and then pinned: a false pass in the
 * recording is a false pass forever. When a live response fails a check, the question is
 * whether the prompt or the check is wrong — never whether the check should be softened to
 * fit (FND-240 §5).
 *
 * Labels ("Hook:", "Headline:", "H1:" …) are the delivery mechanic the prompt asks for
 * (rules.ts `format.labels`), which is what makes the structural checks possible at all.
 */
import { PROMPT_SUPPLIED_NUMBERS } from './rules.js';

export type VoiceFormat =
  'positioning' | 'facebook_post' | 'meta_ad' | 'google_ad' | 'lead_reply' | 'refusal' | 'chat';

export type CheckId =
  | 'not-a-bank'
  | 'independence'
  | 'pillars'
  | 'rule-of-one'
  | 'hook-green'
  | 'hook-not-a-question'
  | 'body-red'
  | 'meta-headline'
  | 'meta-structure'
  | 'google-structure'
  | 'no-invented-numbers'
  | 'no-lender-names'
  | 'no-unsupplied-claims'
  | 'no-guarantee'
  | 'no-credit-verdict'
  | 'australian-spelling'
  | 'refuses-credit-advice'
  | 'speed-rule'
  | 'booking-rule'
  | 'no-stale-stack'
  | 'brand-name'
  | 'no-markdown'
  | 'length';

export const ALL_CHECK_IDS: readonly CheckId[] = [
  'not-a-bank',
  'independence',
  'pillars',
  'rule-of-one',
  'hook-green',
  'hook-not-a-question',
  'body-red',
  'meta-headline',
  'meta-structure',
  'google-structure',
  'no-invented-numbers',
  'no-lender-names',
  'no-unsupplied-claims',
  'no-guarantee',
  'no-credit-verdict',
  'australian-spelling',
  'refuses-credit-advice',
  'speed-rule',
  'booking-rule',
  'no-stale-stack',
  'brand-name',
  'no-markdown',
  'length',
];

export interface VoicePrompt {
  readonly id: string;
  readonly format: VoiceFormat;
  /** The user turn sent to the model, verbatim. */
  readonly message: string;
  readonly checks: readonly CheckId[];
}

export interface CheckResult {
  readonly id: CheckId;
  readonly pass: boolean;
  readonly detail: string;
}

/** Meta ad headline limit: "under 28 characters" (§9) — 27 is the most allowed. */
export const META_HEADLINE_MAX_CHARS = 27;

/**
 * Only the lead reply has a checked word limit: it is an SMS (§11 "instant SMS"). Post and ad
 * lengths are guidance in the prompt, not a gate — the client never stated one, and the model
 * cannot count words reliably (v.1–v.3 recordings ran 150–185 words on a "150 max" rule).
 */
export const WORD_LIMITS: Readonly<Record<'lead_reply', number>> = { lead_reply: 60 };

const META_LABELS = ['Headline', 'Hook', 'Body', 'CTA'] as const;
const GOOGLE_LABELS = ['H1', 'H2', 'H3', 'D1', 'D2'] as const;

/** Australian lenders and broker brands. A name here in output without being in the brief is an invented claim. */
export const LENDER_NAMES: readonly string[] = [
  'Commonwealth Bank',
  'CommBank',
  'CBA',
  'Westpac',
  'NAB',
  'National Australia Bank',
  'ANZ',
  'Macquarie',
  'ING',
  'Bankwest',
  'Suncorp',
  'Bendigo',
  'St George',
  'St.George',
  'Bank of Queensland',
  'BOQ',
  'AMP',
  'HSBC',
  'Citi',
  'UBank',
  'Athena',
  'Pepper Money',
  'Liberty',
  'La Trobe',
  'Resimac',
  'Firstmac',
  'Heritage Bank',
  'Great Southern Bank',
  'P&N',
  'Beyond Bank',
  'Adelaide Bank',
  'Keystart',
  'Unloan',
  'Tiimely',
  'Bank of Melbourne',
  'BankSA',
  'Newcastle Permanent',
  'Aussie',
  'Mortgage Choice',
  'Lendi',
  'Loan Market',
];

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function wordCount(text: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  return words.length;
}

function sentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export interface LabelledParts {
  readonly parts: Readonly<Record<string, string>>;
  /** Labels in the order they appear, one entry per occurrence (duplicates included). */
  readonly order: readonly string[];
}

/** Split text into labelled parts. A label is `Name:` at the start of a line. */
export function extractLabelled(text: string, labels: readonly string[]): LabelledParts {
  const pattern = new RegExp(`^\\s*(${labels.map(escapeRegExp).join('|')}):[ \\t]*`, 'im');
  const lines = text.split('\n');
  const parts: Record<string, string> = {};
  const order: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) {
      const canonical = labels.find((l) => l.toLowerCase() === match[1]?.toLowerCase()) ?? match[1];
      current = canonical;
      order.push(canonical);
      const rest = line.slice(match[0].length).trim();
      parts[canonical] = rest;
      continue;
    }
    if (current !== null) {
      parts[current] = `${parts[current] ?? ''}\n${line}`.trim();
    }
  }
  return { parts, order };
}

const NUMBER = /\d+(?:[.,]\d+)*/g;
const PART_LABEL = /^\s*(H[123]|D[12]|Headline|Hook|Body|CTA|Note):/gim;

/** Every numeric token in `text`, normalised (thousands separators dropped, "40+" → "40"). */
export function numbersIn(text: string): readonly string[] {
  // Part labels (H1:, D2:) are structure, not figures.
  const found = text.replace(PART_LABEL, '').match(NUMBER) ?? [];
  return found.map((n) => n.replace(/,/g, ''));
}

// CTA sentence detectors — "one CTA per asset" needs a definition of CTA that is written
// down. A sentence is a CTA when it asks the reader to take one of these actions.
const CTA_PATTERNS: readonly RegExp[] = [
  /\b(book|reserve|grab|lock in|secure|claim)\b[^.!?\n]{0,60}\b(call|session|chat|spot|time|slot|discovery|place)\b/i,
  /\b(send|shoot|flick|drop)\b[^.!?\n]{0,30}\b(message|dm|text)\b/i,
  /\b(dm|message|text|call|ring|email)\s+(me|us|ross|fundd)\b/i,
  /\b(click|tap|hit|follow|use)\b[^.!?\n]{0,30}\b(link|button|below)\b/i,
  /\blink in (the )?bio\b/i,
  /\bcomment\b[^.!?\n]{0,40}\bbelow\b/i,
  /\b(apply|enquire|inquire|start|begin)\s+(now|today|here)\b/i,
  /\bget in touch\b/i,
  /\breach out\b/i,
  /\[booking link\]/i,
];

export function ctaSentences(text: string): readonly string[] {
  return sentences(text).filter((s) => CTA_PATTERNS.some((p) => p.test(s)));
}

// ---------------------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------------------

type Checker = (text: string, prompt: VoicePrompt) => Omit<CheckResult, 'id'>;

const pass = (detail: string): Omit<CheckResult, 'id'> => ({ pass: true, detail });
const fail = (detail: string): Omit<CheckResult, 'id'> => ({ pass: false, detail });

const BANK_SELF_PATTERNS: readonly RegExp[] = [
  /\b(we|we're|we are|i|i'm|i am|fundd|ross)( is| are)? (a|the|your) bank\b/i,
  /\bour bank\b/i,
  /\bbank with (us|me|fundd)\b/i,
  /\bfundd bank\b/i,
  /\bas (a|your) bank,? (we|i)\b/i,
];

const notABank: Checker = (text) => {
  const hit = BANK_SELF_PATTERNS.map((p) => p.exec(text)?.[0]).find((m) => m !== undefined);
  return hit === undefined
    ? pass('never positions as a bank')
    : fail(`positions as a bank: "${hit}"`);
};

const independence: Checker = (text) =>
  /\bindependen(t|ce)\b/i.test(text)
    ? pass('independence stated')
    : fail('"independent" / "independence" absent');

const PILLARS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'independent access (40+ lenders, not tied to a bank)',
    pattern: /\b(40\+?|forty)\s*lenders?\b|\blender panel\b|\bpanel of\b/i,
  },
  {
    name: 'no-stress process (end to end, first call to settlement)',
    pattern:
      /\bend[- ]to[- ]end\b|\bstart to finish\b|\bfirst (call|chat)( right)? (to|through to) settlement\b|\bno[- ]stress\b|\bhandled?\b|\bwhole (thing|process)\b/i,
  },
  {
    name: 'long-term partnership (rate monitoring, next step after settlement)',
    pattern:
      /\blong[- ]term\b|\bpartnership\b|\bafter (settlement|you'?ve settled|the loan settles)\b|\brate monitoring\b|\b(monitor(ing)?|watch(ing)?|keep(ing)? an eye on) your (rate|loan|position)\b|\bnext (step|move)\b|\bdown the track\b/i,
  },
];

const pillars: Checker = (text) => {
  const missing = PILLARS.filter((p) => !p.pattern.test(text)).map((p) => p.name);
  return missing.length === 0
    ? pass('all three pillars present')
    : fail(`pillar(s) missing: ${missing.join('; ')}`);
};

function bodyWithoutCtaLabel(
  text: string,
  prompt: VoicePrompt,
): {
  readonly body: string;
  readonly ctaLabelCount: number;
} {
  if (prompt.format === 'meta_ad') {
    const { parts, order } = extractLabelled(text, META_LABELS);
    return {
      body: [parts['Headline'], parts['Hook'], parts['Body']]
        .filter((p) => p !== undefined)
        .join('\n'),
      ctaLabelCount: order.filter((l) => l === 'CTA').length,
    };
  }
  if (prompt.format === 'google_ad') {
    const { parts, order } = extractLabelled(text, GOOGLE_LABELS);
    return {
      body: [parts['H1'], parts['H2'], parts['D1'], parts['D2']]
        .filter((p) => p !== undefined)
        .join('\n'),
      ctaLabelCount: order.filter((l) => l === 'H3').length,
    };
  }
  const { order } = extractLabelled(text, ['CTA']);
  const labelCount = order.filter((l) => l === 'CTA').length;
  // Everything before the first CTA label is the body.
  const idx = text.search(/^\s*CTA:/im);
  const body = idx === -1 ? text : text.slice(0, idx);
  return { body, ctaLabelCount: labelCount };
}

const ruleOfOne: Checker = (text, prompt) => {
  const { body, ctaLabelCount } = bodyWithoutCtaLabel(text, prompt);
  const inBody = ctaSentences(body);
  const labelled =
    prompt.format === 'lead_reply' || prompt.format === 'chat' ? null : ctaLabelCount;
  if (labelled !== null && labelled !== 1) {
    return fail(`expected exactly one CTA label, found ${labelled}`);
  }
  // With a label present, the body may restate that one ask at most once; without a label
  // (lead reply) the whole message may carry at most one ask.
  if (inBody.length > 1) {
    return fail(`more than one call to action: ${inBody.map((s) => `"${s}"`).join(' | ')}`);
  }
  return pass(
    labelled === null
      ? `${inBody.length} CTA sentence(s)`
      : `one CTA label, ${inBody.length} restatement(s) in body`,
  );
};

const RED_TERMS =
  /\b(\d+\+?\s*lenders?|lender panel|mortgage broker|brokers?|LVR|offset( account)?|serviceability|pre-?approval|interest rates?|comparison rates?|per ?cent|percent)\b|%/i;
// The client's own emotional vocabulary (section 9 examples, section 10 avatar, the proven
// angles): outcome, feeling, injustice, status.
const GREEN_TERMS =
  /\b(you|your|you're|you've|you'll|rent(ing)?|landlord|mortgage|ladder|freedom|banks?|knock(ed)? back|knock-?back|savings|deposit|dream|stuck|rat race|own(s|ing)?|home|house|place|keys|congratulations|congrats|settled|payments?|loyal\w*|waited?|waiting|approve[ds]?|guess who|make it make sense)\b/i;

function hookOf(text: string, prompt: VoicePrompt): string | null {
  if (prompt.format === 'meta_ad') return extractLabelled(text, META_LABELS).parts['Hook'] ?? null;
  if (prompt.format === 'google_ad')
    return extractLabelled(text, GOOGLE_LABELS).parts['H2'] ?? null;
  // A post or a set of hook ideas: the first non-empty line is the hook.
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  return first ?? null;
}

const hookGreen: Checker = (text, prompt) => {
  const hook = hookOf(text, prompt);
  if (hook === null) return fail('no hook found');
  const red = RED_TERMS.exec(hook)?.[0];
  if (red !== undefined) return fail(`hook is Red Brain (feature term "${red}"): "${hook}"`);
  // "Green Brain" is decidable only by the ABSENCE of Red Brain feature language: a positive
  // vocabulary list fails on every new angle (the barista, the congratulations post). The
  // vocabulary match is reported for the reader, not used as the verdict.
  const green = GREEN_TERMS.test(hook)
    ? 'outcome/emotion vocabulary present'
    : 'no listed outcome word — judge by eye';
  return pass(`no feature language in the hook (${green}): "${hook}"`);
};

const ASKS_IF_AUDIENCE =
  /^\W*(are you|do you|have you|want(ing)? to|looking to|ready to|tired of|sick of|struggling (to|with)|thinking (of|about)|need(ing)? (a|to))\b/i;

const hookNotAQuestion: Checker = (text, prompt) => {
  const hook = hookOf(text, prompt);
  if (hook === null) return fail('no hook found');
  const hit = ASKS_IF_AUDIENCE.exec(hook)?.[0];
  return hit === undefined
    ? pass('hook does not ask the audience whether they are the audience')
    : fail(`hook asks the audience if they are the audience ("${hit.trim()}…"): "${hook}"`);
};

const RED_BODY_TERMS =
  /\b(independent|lenders?|panel|broker|Perth|end[- ]to[- ]end|settlement|process|handled?|pre-?approval|borrowing capacity|deposit|refinanc\w*|self-employed|licensed|discovery session|structure|options?)\b/i;

const bodyRed: Checker = (text, prompt) => {
  const body =
    prompt.format === 'meta_ad'
      ? extractLabelled(text, META_LABELS).parts['Body']
      : bodyWithoutCtaLabel(text, prompt).body.split('\n').slice(1).join('\n');
  if (body === undefined || body.trim() === '') return fail('no body found');
  const hit = RED_BODY_TERMS.exec(body)?.[0];
  return hit === undefined
    ? fail('body has no Red Brain (logical/feature) element')
    : pass(`Red Brain element present ("${hit}")`);
};

const metaHeadline: Checker = (text) => {
  const headline = extractLabelled(text, META_LABELS).parts['Headline'];
  if (headline === undefined) return fail('no Headline: label');
  const firstLine = headline.split('\n')[0]?.trim() ?? '';
  if (firstLine === '') return fail('empty headline');
  return firstLine.length <= META_HEADLINE_MAX_CHARS
    ? pass(`headline ${firstLine.length} chars: "${firstLine}"`)
    : fail(`headline ${firstLine.length} chars (max ${META_HEADLINE_MAX_CHARS}): "${firstLine}"`);
};

function structure(
  text: string,
  labels: readonly string[],
  required: readonly string[],
): Omit<CheckResult, 'id'> {
  const { order, parts } = extractLabelled(text, labels);
  const counts = required.map((l) => ({ l, n: order.filter((o) => o === l).length }));
  const wrong = counts.filter((c) => c.n !== 1);
  if (wrong.length > 0) {
    return fail(`each label once — ${wrong.map((c) => `${c.l}×${c.n}`).join(', ')}`);
  }
  const empty = required.filter((l) => (parts[l] ?? '').trim() === '');
  if (empty.length > 0) return fail(`empty part(s): ${empty.join(', ')}`);
  const seen = order.filter((l) => required.includes(l));
  const inOrder = seen.every((l, i) => l === required[i]);
  return inOrder ? pass(required.join(' → ')) : fail(`order was ${seen.join(' → ')}`);
}

const metaStructure: Checker = (text) => {
  const shape = structure(text, META_LABELS, ['Hook', 'Body', 'CTA']);
  if (!shape.pass) return shape;
  const headline = extractLabelled(text, META_LABELS).order.filter((l) => l === 'Headline').length;
  if (headline !== 1) return fail(`Headline label ×${headline}`);
  return pass('Headline + Hook → Body → CTA');
};

const SERVICE_KEYWORD =
  /\b(mortgage|broker|home loan|refinanc\w*|finance|loan|lending|first home)\b/i;

const googleStructure: Checker = (text) => {
  const shape = structure(text, GOOGLE_LABELS, [...GOOGLE_LABELS]);
  if (!shape.pass) return shape;
  const { parts } = extractLabelled(text, GOOGLE_LABELS);
  const h1 = parts['H1'] ?? '';
  if (!SERVICE_KEYWORD.test(h1)) return fail(`H1 has no service keyword: "${h1}"`);
  const h3 = parts['H3'] ?? '';
  if (ctaSentences(h3).length === 0) return fail(`H3 is not a CTA: "${h3}"`);
  return pass('H1 keyword · H2 hook · H3 CTA · D1 · D2');
};

const noInventedNumbers: Checker = (text, prompt) => {
  const allowed = new Set<string>([
    ...numbersIn(prompt.message),
    ...PROMPT_SUPPLIED_NUMBERS.map(String),
  ]);
  const invented = numbersIn(text).filter((n) => !allowed.has(n));
  const unique = [...new Set(invented)];
  return unique.length === 0
    ? pass('no number outside the brief')
    : fail(`number(s) not in the brief: ${unique.join(', ')}`);
};

const noLenderNames: Checker = (text, prompt) => {
  const brief = prompt.message.toLowerCase();
  const found = LENDER_NAMES.filter((name) => {
    if (brief.includes(name.toLowerCase())) return false;
    const acronym = /^[A-Z&.]+$/.test(name);
    const pattern = new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`, acronym ? '' : 'i');
    return pattern.test(text);
  });
  return found.length === 0
    ? pass('no lender or broker brand outside the brief')
    : fail(`lender/brand name(s) not in the brief: ${found.join(', ')}`);
};

const NEGATED =
  /(can'?t|cannot|can not|don'?t|do not|won'?t|never|no one can|nobody can|not going to|isn'?t|no)\s+(\w+\s+){0,3}$/i;
const GUARANTEE_PATTERNS: readonly RegExp[] = [
  /\bguarantee[ds]?\b[^.!?\n]{0,30}\b(approv\w*|outcome|loan|result|saving|you'?ll|you will)\b/i,
  /\b(guaranteed|assured|certain)\s+(approval|outcome|result|savings?)\b/i,
  /\b(will|100%|definitely|certainly|absolutely)\s+(be\s+)?(approved|get approved|save)\b/i,
  /\bapproval\s+(is\s+)?(guaranteed|certain|assured|a sure thing)\b/i,
  /\b(you'?ll|you will)\s+save\s+(thousands|\$)/i,
  /\bno[- ]risk\b/i,
];

const UNSUPPLIED_CLAIMS: readonly RegExp[] = [
  /\bfree\b/i,
  /\bno[- ]cost\b/i,
  /\bno[- ]obligation\b/i,
  /\baward[- ]winning\b/i,
  /\b(#|number )1\b/i,
  /\b(the )?(best|lowest|cheapest) (rates?|deals?)\b/i,
];

const noUnsuppliedClaims: Checker = (text, prompt) => {
  const brief = prompt.message.toLowerCase();
  const found = UNSUPPLIED_CLAIMS.map((p) => p.exec(text)?.[0])
    .filter((m): m is string => m !== undefined)
    .filter((m) => !brief.includes(m.toLowerCase()));
  return found.length === 0
    ? pass('no free / no-cost / best-rate claim outside the brief')
    : fail(`claim(s) not in the brief: ${[...new Set(found)].join(', ')}`);
};

const noGuarantee: Checker = (text) => {
  for (const pattern of GUARANTEE_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (NEGATED.test(before)) continue; // "I can't guarantee approval" is the boundary, not a breach
    return fail(`guaranteed-outcome language: "${match[0]}"`);
  }
  return pass('no guaranteed-approval or guaranteed-outcome language');
};

const CREDIT_VERDICT =
  /\b(you(?:'d|'ll| would| will| should| could)\s+(?:probably |likely |easily |almost certainly )?(?:be |get )?(approved|eligible|fine|knocked back|declined|able to borrow))\b|\byou (can|could) borrow (up to |around |about )?\$?\d/i;

const noCreditVerdict: Checker = (text) => {
  const hit = CREDIT_VERDICT.exec(text)?.[0];
  return hit === undefined
    ? pass("no verdict on an individual's borrowing or approval")
    : fail(`gives a personal credit verdict: "${hit}"`);
};

const AMERICAN =
  /\b(colou?rs?|favorite|organiz\w*|realiz\w*|optimiz\w*|recogniz\w*|prioritiz\w*|maximiz\w*|minimiz\w*|specializ\w*|centers?|neighbor\w*|honor(?:s|ed)?|analyz\w*|catalog|behavior\w*|defense|offense|travel(?:ed|ing)|cancel(?:ed|ing)|jewelry|mom|moms|apologiz\w*|labor\b(?! party)|savior|flavor\w*|humor|rumor\w*|fulfill\w*|enroll\w*|skillful|installment|checkbook|paycheck)\b/gi;
const AUS_OK = new Set(['colour', 'colours']);

const australianSpelling: Checker = (text) => {
  const hits = [...new Set((text.match(AMERICAN) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !AUS_OK.has(w),
  );
  const licence = /\b(a|the|your|his|her|credit|broker's|driver's)\s+license\b/i.exec(text)?.[0];
  if (licence !== undefined) hits.push(licence);
  return hits.length === 0
    ? pass('Australian spelling')
    : fail(`American spelling: ${hits.join(', ')}`);
};

const REFUSES =
  /\b(can'?t|cannot|can not|not able to|unable to|won'?t|isn'?t something|not something i|i don'?t (give|offer|do)|i'?m not (in a position|able|the (right )?(person|one))|not (my|something i can) (place|call|job))\b/i;
const REASON =
  /\b(licen[cs]ed|personal|individual|your (\w+ )?(situation|circumstances|numbers|position|file)|credit advice|broker|depends on|depending on|assess\w*|weighed|needs? (a |to be |to do )(real |proper |assessed |looked at |it )?(conversation|chat|look|properly)|without (looking|seeing|knowing))/i;
const REDIRECT =
  /\b(discovery session|book|ross|a (quick |proper |real )?(call|chat)|talk (it )?through|sit down|\[booking link\])/i;

const refusesCreditAdvice: Checker = (text) => {
  const missing: string[] = [];
  if (!REFUSES.test(text)) missing.push('a plain refusal');
  if (!REASON.test(text)) missing.push('the reason');
  if (!REDIRECT.test(text)) missing.push('a redirect to Ross / a Discovery Session');
  return missing.length === 0
    ? pass('refuses, says why, redirects')
    : fail(`refusal incomplete — missing ${missing.join(', ')}`);
};

const speedRule: Checker = (text) =>
  /\b(five|5)[- ]min(ute)?s?\b/i.test(text)
    ? pass('five-minute call stated')
    : fail('no five-minute call commitment');

const BEYOND_TWO_DAYS =
  /\b(next week|later (this|in the) (week|month)|in a (few|couple of) (days|weeks)|(\b[3-9]|1\d) days|end of the week)\b/i;
const WITHIN_WINDOW =
  /\b(today|tomorrow|this (arvo|afternoon|evening|morning)|tonight|within (the next )?(two|2|48) (days|hours)|next (two|2) days|day after tomorrow|(next|in the next) 48 hours)\b/i;

const bookingRule: Checker = (text) => {
  const beyond = BEYOND_TWO_DAYS.exec(text)?.[0];
  if (beyond !== undefined) return fail(`offers a slot beyond two days: "${beyond}"`);
  return WITHIN_WINDOW.test(text)
    ? pass('booking offered today / within two days')
    : fail('no today-or-within-two-days booking offer');
};

const noStaleStack: Checker = (text) =>
  /hubspot|make\.com|salesforce|pipedrive/i.test(text)
    ? fail(
        `stale or wrong stack reference: "${/hubspot|make\.com|salesforce|pipedrive/i.exec(text)?.[0] ?? ''}"`,
      )
    : pass('no stale stack reference');

const brandName: Checker = (text) =>
  /\bencharge\b/i.test(text)
    ? fail('published copy uses "Encharge" — the brand is Fundd (D25)')
    : pass('brand is Fundd, not Encharge');

const MARKDOWN = /\*\*|__|^\s*#{1,6}\s|^\s*[-*•]\s|```|^\s*\d+\.\s/m;

const noMarkdown: Checker = (text) => {
  const hit = MARKDOWN.exec(text)?.[0];
  return hit === undefined
    ? pass('plain text')
    : fail(`markdown in copy: "${hit.trim() === '' ? hit : hit.trim()}"`);
};

const length: Checker = (text, prompt) => {
  switch (prompt.format) {
    case 'lead_reply': {
      const n = wordCount(text);
      return n <= WORD_LIMITS.lead_reply
        ? pass(`${n} words`)
        : fail(`${n} words (max ${WORD_LIMITS.lead_reply})`);
    }
    case 'facebook_post':
    case 'meta_ad':
    case 'positioning':
    case 'google_ad':
    case 'refusal':
    case 'chat':
      return pass('no length rule for this format');
  }
};

const CHECKERS: Readonly<Record<CheckId, Checker>> = {
  'not-a-bank': notABank,
  independence,
  pillars,
  'rule-of-one': ruleOfOne,
  'hook-green': hookGreen,
  'hook-not-a-question': hookNotAQuestion,
  'body-red': bodyRed,
  'meta-headline': metaHeadline,
  'meta-structure': metaStructure,
  'google-structure': googleStructure,
  'no-invented-numbers': noInventedNumbers,
  'no-lender-names': noLenderNames,
  'no-unsupplied-claims': noUnsuppliedClaims,
  'no-guarantee': noGuarantee,
  'no-credit-verdict': noCreditVerdict,
  'australian-spelling': australianSpelling,
  'refuses-credit-advice': refusesCreditAdvice,
  'speed-rule': speedRule,
  'booking-rule': bookingRule,
  'no-stale-stack': noStaleStack,
  'brand-name': brandName,
  'no-markdown': noMarkdown,
  length,
};

export function runCheck(id: CheckId, text: string, prompt: VoicePrompt): CheckResult {
  return { id, ...CHECKERS[id](text, prompt) };
}

/**
 * A trailing `Note:` line is the assistant talking to Ross (rules.ts `format.asset-only`), not
 * copy that gets published, so it is not what the checks judge.
 */
export function stripNotes(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*Note:/i.test(line))
    .join('\n')
    .trim();
}

/** Run every check the prompt names. Order preserved so reports read the same each time. */
export function runChecks(prompt: VoicePrompt, text: string): readonly CheckResult[] {
  const copy = stripNotes(text);
  return prompt.checks.map((id) => runCheck(id, copy, prompt));
}

export function isCheckId(value: unknown): value is CheckId {
  return typeof value === 'string' && (ALL_CHECK_IDS as readonly string[]).includes(value);
}
