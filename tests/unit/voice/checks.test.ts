/**
 * The conformance checks themselves (src/lib/voice/conformance.ts), each proven on
 * hand-written text that must pass and text that must fail. The recorded-fixture suite
 * (conformance.test.ts) only means something if these are right: a check that cannot fail
 * is not a check.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_CHECK_IDS,
  META_HEADLINE_MAX_CHARS,
  ctaSentences,
  extractLabelled,
  numbersIn,
  runCheck,
  runChecks,
  stripNotes,
  wordCount,
  type CheckId,
  type VoiceFormat,
  type VoicePrompt,
} from '../../../src/lib/voice/conformance.js';

function prompt(
  format: VoiceFormat,
  message = 'brief',
  checks: readonly CheckId[] = [],
): VoicePrompt {
  return { id: 'p', format, message, checks };
}

function run(id: CheckId, text: string, p: VoicePrompt = prompt('chat')): boolean {
  return runCheck(id, text, p).pass;
}

const META_AD = `Headline: Stop renting their dream
Hook: Every rent payment is someone else's mortgage getting smaller.
Body: Fundd is independent, with a panel of 40+ lenders and the whole process handled end to end. Perth first home buyers, this is how it actually gets done.
CTA: Book your Discovery Session and find out what's possible.`;

const GOOGLE_AD = `H1: Refinance Perth Mortgage Broker
H2: Still on the rate your bank gave you years ago
H3: Book a Discovery Session today
D1: The bank won't call you about a better rate
D2: Independent, 40+ lenders, handled end to end`;

const FB_POST = `Your rent just paid for your landlord's new kitchen.
Every month it goes out, every month someone else's mortgage gets smaller. Perth renters are told to wait, save more, try again next year. Fundd is independent, with a panel of 40+ lenders, and the process is handled end to end.
CTA: Book a Discovery Session and find out where you actually stand.`;

describe('helpers', () => {
  it('extractLabelled splits labelled parts and records order (case-insensitive labels)', () => {
    const { parts, order } = extractLabelled('headline: A\nHook: B\nmore B\nBody: C\nCTA: D', [
      'Headline',
      'Hook',
      'Body',
      'CTA',
    ]);
    expect(order).toEqual(['Headline', 'Hook', 'Body', 'CTA']);
    expect(parts).toEqual({ Headline: 'A', Hook: 'B\nmore B', Body: 'C', CTA: 'D' });
  });

  it('numbersIn normalises thousands separators and ignores words', () => {
    expect(numbersIn('40+ lenders, $1,250,000 at 5.99% over 30 years')).toEqual([
      '40',
      '1250000',
      '5.99',
      '30',
    ]);
    expect(numbersIn('five minutes')).toEqual([]);
    // Part labels are structure, not figures.
    expect(numbersIn('H1: Refinance Perth\nD2: 40+ lenders')).toEqual(['40']);
  });

  it('ctaSentences finds asks and ignores the broker describing his own actions', () => {
    expect(
      ctaSentences("I'll give you a call today. Book a Discovery Session here [booking link]."),
    ).toEqual(['Book a Discovery Session here [booking link].']);
    expect(ctaSentences('DM me the word HOME. Comment YES below. Link in bio.')).toHaveLength(3);
    expect(ctaSentences('Perth renters are told to wait.')).toHaveLength(0);
  });

  it('stripNotes drops Note: lines and nothing else', () => {
    expect(stripNotes('Hook line\nBody\nCTA: Book\nNote: check the D1/D2 figure')).toBe(
      'Hook line\nBody\nCTA: Book',
    );
    expect(
      runChecks(prompt('chat', 'brief', ['no-invented-numbers']), 'Fine.\nNote: see D1/D2')[0]
        ?.pass,
    ).toBe(true);
  });

  it('wordCount', () => {
    expect(wordCount('  a b\n c  ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});

describe('positioning checks', () => {
  it('not-a-bank', () => {
    expect(run('not-a-bank', 'The banks knocked you back. Fundd is not a bank.')).toBe(true);
    expect(run('not-a-bank', 'Here at Fundd we are a bank that cares.')).toBe(false);
    expect(run('not-a-bank', 'Bank with us and see.')).toBe(false);
    expect(run('not-a-bank', 'Our bank offers great rates.')).toBe(false);
    expect(run('not-a-bank', 'As a bank, we understand.')).toBe(false);
  });

  it('independence', () => {
    expect(run('independence', 'Fundd is independent.')).toBe(true);
    expect(run('independence', 'Fundd works for you.')).toBe(false);
  });

  it('pillars needs all three', () => {
    const all =
      'Independent access to a panel of 40+ lenders, not tied to a bank. No-stress: handled end to end. Long-term partnership with rate monitoring after settlement.';
    expect(run('pillars', all)).toBe(true);
    expect(
      runCheck('pillars', 'Independent, 40+ lenders. Handled end to end.', prompt('positioning'))
        .detail,
    ).toContain('long-term partnership');
    expect(
      run(
        'pillars',
        "I'm independent with 40+ lenders, I run the whole thing start to finish, and I keep an eye on your rate down the track.",
      ),
    ).toBe(true);
    expect(
      run(
        'pillars',
        'Over forty lenders, the whole process handled, and I keep watching your loan after settlement.',
      ),
    ).toBe(true);
    expect(run('pillars', 'We look after you after settlement.')).toBe(false);
  });
});

describe('structure checks', () => {
  it('rule-of-one: one CTA label, at most one restatement', () => {
    expect(run('rule-of-one', META_AD, prompt('meta_ad'))).toBe(true);
    expect(run('rule-of-one', `${META_AD}\nCTA: Also call us now.`, prompt('meta_ad'))).toBe(false);
    const twoAsks = META_AD.replace('Body:', 'Body: DM me today. Comment YES below.');
    expect(run('rule-of-one', twoAsks, prompt('meta_ad'))).toBe(false);
    expect(run('rule-of-one', FB_POST, prompt('facebook_post'))).toBe(true);
    expect(
      run(
        'rule-of-one',
        FB_POST.replace('\nCTA:', '\nAlso DM me. Comment YES below.\nCTA:'),
        prompt('facebook_post'),
      ),
    ).toBe(false);
    expect(run('rule-of-one', 'No label at all.', prompt('facebook_post'))).toBe(false);
    expect(
      run(
        'rule-of-one',
        "Hi Jake, Ross from Fundd. I'll call you in five minutes.",
        prompt('lead_reply'),
      ),
    ).toBe(true);
    expect(
      run('rule-of-one', 'Book a call here [booking link]. Or DM me.', prompt('lead_reply')),
    ).toBe(false);
    expect(run('rule-of-one', GOOGLE_AD, prompt('google_ad'))).toBe(true);
  });

  it('hook-green: outcome language, no feature terms', () => {
    expect(run('hook-green', META_AD, prompt('meta_ad'))).toBe(true);
    expect(
      run(
        'hook-green',
        META_AD.replace('Hook: Every', 'Hook: Perth mortgage broker with 40+ lenders. Every'),
        prompt('meta_ad'),
      ),
    ).toBe(false);
    expect(run('hook-green', 'Hook: Rates from 5.99%', prompt('meta_ad'))).toBe(false);
    expect(runCheck('hook-green', 'Hook: Announcement.', prompt('meta_ad')).detail).toContain(
      'judge by eye',
    );
    expect(
      run(
        'hook-green',
        'Congratulations to the couple who settled this week.\nBody',
        prompt('facebook_post'),
      ),
    ).toBe(true);
    expect(
      run(
        'hook-green',
        'Years of on-time payments. Never missed a beat.\nBody',
        prompt('facebook_post'),
      ),
    ).toBe(true);
    expect(run('hook-green', 'Body: x', prompt('meta_ad'))).toBe(false);
    expect(run('hook-green', FB_POST, prompt('facebook_post'))).toBe(true);
    expect(run('hook-green', GOOGLE_AD, prompt('google_ad'))).toBe(true);
    expect(run('hook-green', '', prompt('chat'))).toBe(false);
  });

  it('hook-not-a-question: never asks the audience if they are the audience', () => {
    expect(run('hook-not-a-question', FB_POST, prompt('facebook_post'))).toBe(true);
    expect(
      run(
        'hook-not-a-question',
        'Are you a first home buyer in Perth?\nBody.',
        prompt('facebook_post'),
      ),
    ).toBe(false);
    expect(
      run('hook-not-a-question', 'Hook: Tired of renting?\nBody: x\nCTA: y', prompt('meta_ad')),
    ).toBe(false);
    expect(
      run(
        'hook-not-a-question',
        'Hook: What if your rent was paying off your own place?',
        prompt('meta_ad'),
      ),
    ).toBe(true);
    expect(run('hook-not-a-question', '', prompt('chat'))).toBe(false);
  });

  it('body-red: body carries a logical element', () => {
    expect(run('body-red', META_AD, prompt('meta_ad'))).toBe(true);
    expect(
      run(
        'body-red',
        META_AD.replace(/Body:.*\n/, 'Body: Feel it. Dream it. Want it.\n'),
        prompt('meta_ad'),
      ),
    ).toBe(false);
    expect(run('body-red', 'Hook: x\nCTA: y', prompt('meta_ad'))).toBe(false);
    expect(run('body-red', FB_POST, prompt('facebook_post'))).toBe(true);
    expect(run('body-red', 'Just a hook line', prompt('facebook_post'))).toBe(false);
  });

  it('meta-headline: under 28 characters', () => {
    expect(META_HEADLINE_MAX_CHARS).toBe(27);
    expect(run('meta-headline', META_AD, prompt('meta_ad'))).toBe(true);
    expect(run('meta-headline', `Headline: ${'x'.repeat(27)}`, prompt('meta_ad'))).toBe(true);
    expect(run('meta-headline', `Headline: ${'x'.repeat(28)}`, prompt('meta_ad'))).toBe(false);
    expect(run('meta-headline', 'Headline:', prompt('meta_ad'))).toBe(false);
    expect(run('meta-headline', 'Hook: no headline', prompt('meta_ad'))).toBe(false);
  });

  it('meta-structure: Headline + Hook → Body → CTA, each once', () => {
    expect(run('meta-structure', META_AD, prompt('meta_ad'))).toBe(true);
    expect(
      run(
        'meta-structure',
        META_AD.replace('Headline: Stop renting their dream\n', ''),
        prompt('meta_ad'),
      ),
    ).toBe(false);
    expect(run('meta-structure', `${META_AD}\nBody: again`, prompt('meta_ad'))).toBe(false);
    expect(run('meta-structure', 'Headline: a\nBody: b\nHook: c\nCTA: d', prompt('meta_ad'))).toBe(
      false,
    );
    expect(run('meta-structure', 'Headline: a\nHook: \nBody: b\nCTA: d', prompt('meta_ad'))).toBe(
      false,
    );
  });

  it('google-structure: H1 keyword · H2 · H3 CTA · D1 · D2 in order', () => {
    expect(run('google-structure', GOOGLE_AD, prompt('google_ad'))).toBe(true);
    expect(
      run(
        'google-structure',
        GOOGLE_AD.replace('H1: Refinance Perth Mortgage Broker', 'H1: Sunny Days'),
        prompt('google_ad'),
      ),
    ).toBe(false);
    expect(
      run(
        'google-structure',
        GOOGLE_AD.replace('H3: Book a Discovery Session today', 'H3: We are friendly'),
        prompt('google_ad'),
      ),
    ).toBe(false);
    expect(run('google-structure', GOOGLE_AD.replace('D2:', 'D3:'), prompt('google_ad'))).toBe(
      false,
    );
    expect(
      run('google-structure', GOOGLE_AD.split('\n').reverse().join('\n'), prompt('google_ad')),
    ).toBe(false);
  });
});

describe('fact and compliance checks', () => {
  it('no-invented-numbers: only numbers from the brief or the prompt', () => {
    const p = prompt('chat', 'Rate went from 6.84% to 5.99%, saving $300 a month');
    expect(
      run(
        'no-invented-numbers',
        'From 6.84% to 5.99%: $300 back. 40+ lenders, a call in 5 minutes.',
        p,
      ),
    ).toBe(true);
    expect(runCheck('no-invented-numbers', 'Rates from 5.49%', p).detail).toContain('5.49');
    expect(run('no-invented-numbers', 'Over 1,000 happy clients', p)).toBe(false);
    expect(run('no-invented-numbers', 'No figures here at all.', p)).toBe(true);
  });

  it('no-lender-names: names allowed only when the brief mentions them', () => {
    expect(run('no-lender-names', 'Westpac said no.', prompt('chat'))).toBe(false);
    expect(run('no-lender-names', 'ANZ said no.', prompt('chat'))).toBe(false);
    expect(
      run('no-lender-names', 'Westpac said no.', prompt('chat', 'Compare westpac and Macquarie')),
    ).toBe(true);
    expect(run('no-lender-names', 'The banks said no.', prompt('chat'))).toBe(true);
    // Acronyms are case-sensitive so ordinary words do not trip them.
    expect(run('no-lender-names', 'Nothing amp-like or boqing here, ing.', prompt('chat'))).toBe(
      true,
    );
  });

  it('no-unsupplied-claims: free / no-cost / best-rate only when the brief says so', () => {
    expect(run('no-unsupplied-claims', 'Book a free Discovery Session.')).toBe(false);
    expect(run('no-unsupplied-claims', 'No obligation, award-winning, the best rates.')).toBe(
      false,
    );
    expect(
      run('no-unsupplied-claims', 'Book a free session.', prompt('chat', 'the session is free')),
    ).toBe(true);
    expect(run('no-unsupplied-claims', 'Book a Discovery Session.')).toBe(true);
  });

  it('no-guarantee: promises fail, honest disclaimers pass', () => {
    expect(run('no-guarantee', 'Guaranteed approval for tradies!')).toBe(false);
    expect(run('no-guarantee', 'You will be approved within a week.')).toBe(false);
    expect(run('no-guarantee', "You'll save thousands.")).toBe(false);
    expect(run('no-guarantee', 'Approval is certain with us.')).toBe(false);
    expect(run('no-guarantee', 'No-risk refinance.')).toBe(false);
    expect(run('no-guarantee', "I can't guarantee approval — nobody can.")).toBe(true);
    expect(run('no-guarantee', "Nobody can promise a guaranteed outcome, and I won't.")).toBe(true);
    expect(run('no-guarantee', 'Find out where you stand.')).toBe(true);
  });

  it('no-credit-verdict: no personal approval or borrowing verdict', () => {
    expect(run('no-credit-verdict', "You'd probably be approved.")).toBe(false);
    expect(run('no-credit-verdict', 'You could borrow around $600,000.')).toBe(false);
    expect(run('no-credit-verdict', 'You will be knocked back.')).toBe(false);
    expect(
      run(
        'no-credit-verdict',
        "I can't tell you what you'd be approved for without a proper look.",
      ),
    ).toBe(false);
    expect(run('no-credit-verdict', 'That needs a proper conversation with Ross.')).toBe(true);
  });

  it('australian-spelling', () => {
    expect(
      run(
        'australian-spelling',
        'Organise your finances, realise the dream, favourite colour, a credit licence.',
      ),
    ).toBe(true);
    expect(run('australian-spelling', 'Organize your finances.')).toBe(false);
    expect(run('australian-spelling', 'Your favorite color.')).toBe(false);
    expect(run('australian-spelling', 'He holds a credit license.')).toBe(false);
    expect(run('australian-spelling', 'We license the software.')).toBe(true);
    expect(run('australian-spelling', 'Mom said no.')).toBe(false);
  });

  it('refuses-credit-advice: refusal + reason + redirect, all three', () => {
    expect(
      run(
        'refuses-credit-advice',
        "I can't tell you that — it's personal credit advice and it depends on your circumstances, which is Ross's job as the licensed broker. Book a Discovery Session and he'll go through it properly.",
      ),
    ).toBe(true);
    expect(
      runCheck('refuses-credit-advice', "I can't help with that.", prompt('refusal')).detail,
    ).toContain('the reason');
    expect(
      runCheck(
        'refuses-credit-advice',
        'It depends on your circumstances. Book a session.',
        prompt('refusal'),
      ).detail,
    ).toContain('a plain refusal');
    expect(
      runCheck('refuses-credit-advice', "I can't give personal credit advice.", prompt('refusal'))
        .detail,
    ).toContain('redirect');
    expect(
      run(
        'refuses-credit-advice',
        "I can't weigh that up for you. It needs to be assessed properly against your actual situation. Book a Discovery Session with Ross.",
      ),
    ).toBe(true);
    expect(run('refuses-credit-advice', 'Sure, about $600k.')).toBe(false);
  });

  it('speed-rule and booking-rule', () => {
    expect(run('speed-rule', "I'll call you within five minutes.")).toBe(true);
    expect(run('speed-rule', "I'll give you a call in 5 mins.")).toBe(true);
    expect(run('speed-rule', "I'll call you shortly.")).toBe(false);
    expect(run('booking-rule', 'I can do today at 4 or tomorrow morning.')).toBe(true);
    expect(run('booking-rule', 'Sometime in the next 48 hours works.')).toBe(true);
    expect(run('booking-rule', 'Sure, next week is fine.')).toBe(false);
    expect(run('booking-rule', 'How about in 5 days?')).toBe(false);
    expect(run('booking-rule', 'Let me know a time.')).toBe(false);
  });

  it('no-stale-stack and brand-name', () => {
    expect(run('no-stale-stack', 'We track everything in GoHighLevel.')).toBe(true);
    expect(run('no-stale-stack', 'We track everything in HubSpot.')).toBe(false);
    expect(run('brand-name', 'Fundd is independent.')).toBe(true);
    expect(run('brand-name', 'Encharge Capital is independent.')).toBe(false);
  });

  it('no-markdown', () => {
    expect(run('no-markdown', 'Plain lines.\n\nAnother paragraph.')).toBe(true);
    expect(run('no-markdown', '**Bold** claim')).toBe(false);
    expect(run('no-markdown', '# Heading')).toBe(false);
    expect(run('no-markdown', '- a bullet')).toBe(false);
    expect(run('no-markdown', '1. numbered')).toBe(false);
    expect(run('no-markdown', '```code```')).toBe(false);
  });

  it('length: only the lead reply (an SMS) has a checked limit', () => {
    const words = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');
    expect(run('length', words(60), prompt('lead_reply'))).toBe(true);
    expect(run('length', words(61), prompt('lead_reply'))).toBe(false);
    for (const format of [
      'facebook_post',
      'meta_ad',
      'positioning',
      'google_ad',
      'refusal',
      'chat',
    ] as const) {
      expect(run('length', words(500), prompt(format))).toBe(true);
    }
  });
});

describe('runChecks', () => {
  it('runs the named checks in order and every check id is runnable', () => {
    const p = prompt('meta_ad', 'brief', ['meta-headline', 'not-a-bank']);
    expect(runChecks(p, META_AD).map((r) => [r.id, r.pass])).toEqual([
      ['meta-headline', true],
      ['not-a-bank', true],
    ]);
    for (const id of ALL_CHECK_IDS) {
      const result = runCheck(id, META_AD, prompt('meta_ad'));
      expect(typeof result.pass).toBe('boolean');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});
