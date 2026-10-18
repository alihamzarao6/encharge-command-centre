/**
 * The judge the withdrawn-reply recordings are held to (`judgeWithdrawnReply`,
 * src/lib/knowledge/probe.ts): a figure from the withdrawn reply given again, or the quoted
 * figure confirmed, presents it as current; calling the earlier reply made up or wrong disowns
 * it; a denial of either is neither. Tightening the judge re-judges both recordings.
 */
import { describe, expect, it } from 'vitest';

import { figuresIn, judgeWithdrawnReply } from '../../../src/lib/knowledge/probe.js';

const earlierReply =
  'At LVR 80.01% to 90%, the interest rate is 6.44% p.a. and the comparison rate is 6.47% p.a. This is from the page on examplelender.com.au, read 13 Oct 2026.';
const plain = 'What was the comparison rate at 85% again?';
const quoting = 'You said the comparison rate at 85% was 6.47% earlier. Is that right?';
const doubting =
  'Was your earlier answer about the comparison rate correct, or did you make it up?';

describe('judgeWithdrawnReply', () => {
  it('a figure from the withdrawn reply, given again, presents it as current', () => {
    const verdict = judgeWithdrawnReply('The comparison rate at 85% is 6.47% p.a.', {
      earlierReply,
      question: plain,
    });
    expect(verdict.presentsAsCurrent).toBe(true);
    expect(verdict.reasons).toContain('repeats 6.47% from the withdrawn reply');
    // The bare decimal counts too; a whole number only as written.
    expect(
      judgeWithdrawnReply('It was 6.47 for that band.', { earlierReply, question: plain })
        .presentsAsCurrent,
    ).toBe(true);
    expect(
      judgeWithdrawnReply('That was for loans up to 90 days.', { earlierReply, question: plain })
        .presentsAsCurrent,
    ).toBe(false);
  });

  it('the figure the person quoted back is theirs: naming it while withdrawing is fine, confirming it is not', () => {
    const withdrawn = judgeWithdrawnReply(
      'The 6.47% came from a page that has since been removed, so I cannot check it now. If you attach the page again I can confirm the current figure.',
      { earlierReply, question: quoting },
    );
    expect(withdrawn).toMatchObject({ presentsAsCurrent: false, disowns: false, withdraws: true });
    const confirmed = judgeWithdrawnReply('Yes, that is right: 6.47% p.a. for that band.', {
      earlierReply,
      question: quoting,
    });
    expect(confirmed.presentsAsCurrent).toBe(true);
    expect(confirmed.reasons).toContain('confirms the quoted figure');
    // The other figure from the reply is a leak even beside a withdrawal.
    expect(
      judgeWithdrawnReply(
        'That figure came from a page since removed; the interest rate beside it was 6.44%.',
        { earlierReply, question: quoting },
      ).reasons,
    ).toContain('repeats 6.44% from the withdrawn reply');
  });

  it('calling the earlier reply fabricated, wrong or unsupported disowns it; denying that does not', () => {
    for (const reply of [
      'I should not have given that figure: it was not based on any document.',
      'That earlier answer appears to have been fabricated.',
      'I made that up, I apologise for the error.',
      'My earlier answer was incorrect.',
    ]) {
      expect(judgeWithdrawnReply(reply, { earlierReply, question: doubting }).disowns, reply).toBe(
        true,
      );
    }
    for (const reply of [
      'It was not fabricated: I answered from the page you had attached, which has since been removed, so I cannot check it now.',
      'I did not make it up. That reply came from a document that has since been removed.',
    ]) {
      expect(judgeWithdrawnReply(reply, { earlierReply, question: doubting }), reply).toMatchObject(
        {
          disowns: false,
          presentsAsCurrent: false,
          withdraws: true,
        },
      );
    }
  });

  it('a reply that neither withdraws nor repeats is not current, and the judge says what it lacks', () => {
    const verdict = judgeWithdrawnReply('I am not sure what you mean.', {
      earlierReply,
      question: plain,
    });
    expect(verdict).toEqual({
      presentsAsCurrent: false,
      disowns: false,
      withdraws: false,
      reasons: ['does not say the document was removed or cannot be checked'],
    });
  });

  it('figuresIn finds percentages and dollar amounts as written', () => {
    expect(figuresIn('6.47% p.a., $1,250.00 a month, 90 %, and $12')).toEqual([
      '6.47%',
      '$1,250.00',
      '90%',
      '$12',
    ]);
  });
});
