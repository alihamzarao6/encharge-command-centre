/**
 * robots.txt (Milestone 5 part 2, D96): parsing, RFC 9309 matching, and the rule that a
 * disallow addressed to AI assistants is honoured even though no site knows our name. The
 * files below are invented; their SHAPES are the ones the probe met on 12 Oct 2026.
 */
import { describe, expect, it } from 'vitest';

import { AI_ASSISTANT_TOKENS, ROBOTS_AGENT_TOKEN } from '../../../src/lib/pages/limits.js';
import {
  parseRobots,
  robotsFromResponse,
  robotsVerdict,
  ruleMatches,
} from '../../../src/lib/pages/robots.js';

/** A news site: everyone may read articles; AI assistants and crawlers may read nothing. */
const NEWS_SITE = `
# robots.txt for a news site
User-agent: *
Disallow: /search
Disallow: /account/
Allow: /

User-agent: ChatGPT-User
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: anthropic-ai
Disallow: /

Sitemap: https://news.example.org/sitemap.xml
`;

/** A bank: AI agents are named as WELCOME, with the same private areas as everyone. */
const BANK_SITE = `
User-agent: GPTBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: Claude-User
Allow: /
Disallow: /netbank/
Disallow: /digital/
Allow: /digital/home-loans/borrowing-power-calculator

User-agent: *
Disallow: /bin/
Disallow: /etc/
Allow: /etc/designs/favicon.ico
`;

describe('parseRobots', () => {
  it('groups consecutive user-agent lines, lower-cases the names, and keeps each rule', () => {
    const groups = parseRobots(BANK_SITE);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.agents).toEqual(['gptbot', 'chatgpt-user', 'claudebot', 'claude-user']);
    expect(groups[0]?.rules).toEqual([
      { allow: true, pattern: '/' },
      { allow: false, pattern: '/netbank/' },
      { allow: false, pattern: '/digital/' },
      { allow: true, pattern: '/digital/home-loans/borrowing-power-calculator' },
    ]);
    expect(groups[1]?.agents).toEqual(['*']);
  });

  it('ignores comments, blank lines, sitemaps, crawl-delay and lines with no colon', () => {
    const groups = parseRobots(
      [
        '# a comment',
        'User-agent: * # everyone',
        'Crawl-delay: 10',
        'Disallow: /private/ # not this',
        'this line is not a rule',
        'Sitemap: https://example.org/sitemap.xml',
        '',
        ': no key',
      ].join('\r\n'),
    );
    expect(groups).toEqual([{ agents: ['*'], rules: [{ allow: false, pattern: '/private/' }] }]);
  });

  it('a "Disallow:" with nothing after it disallows nothing', () => {
    const groups = parseRobots('User-agent: *\nDisallow:\n');
    expect(groups[0]?.rules).toEqual([]);
    expect(robotsVerdict(groups, '/anything')).toEqual({ allowed: true });
  });

  it('a rule before any user-agent line belongs to nobody', () => {
    expect(parseRobots('Disallow: /\nUser-agent: *\nAllow: /\n')).toEqual([
      { agents: ['*'], rules: [{ allow: true, pattern: '/' }] },
    ]);
  });

  it('a file that is not a robots file — a home page served for every address — has no groups', () => {
    const html =
      '<!doctype html><html><head><title>Brokers</title></head><body>Log in</body></html>';
    expect(parseRobots(html)).toEqual([]);
    expect(robotsVerdict(parseRobots(html), '/brokers')).toEqual({ allowed: true });
  });

  it('reads old Mac and Windows line endings alike', () => {
    expect(parseRobots('User-agent: *\rDisallow: /a\rDisallow: /b')[0]?.rules).toHaveLength(2);
  });
});

describe('ruleMatches', () => {
  it.each([
    ['/', '/anything/at/all', true],
    ['/private/', '/private/page', true],
    ['/private/', '/private', false],
    ['/private', '/privately', true],
    ['/*.pdf$', '/docs/rates.pdf', true],
    ['/*.pdf$', '/docs/rates.pdf?download=1', false],
    ['/*.pdf', '/docs/rates.pdf?download=1', true],
    ['/gives*?query=*', '/gives/now?query=x', true],
    ['/gives*?query=*', '/gives/now', false],
    ['/a*b*c', '/a-1-b-2-c-3', true],
    ['/a*b*c', '/a-1-c-2-b', false],
    ['/exact$', '/exact', true],
    ['/exact$', '/exact/more', false],
    ['*', '/anything', true],
    ['/search', '/Search', false],
    ['/a*$', '/abc', true],
  ] as const)('%s against %s → %s', (pattern, path, expected) => {
    expect(ruleMatches(pattern, path)).toBe(expected);
  });

  it('a pattern of many stars costs what it looks like, not exponentially more', () => {
    const pattern = `/${'*a'.repeat(200)}$`;
    const path = `/${'a'.repeat(5_000)}b`;
    const started = performance.now();
    expect(ruleMatches(pattern, path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('robotsVerdict — everyone, and us by name', () => {
  it('follows the rules for everyone when we are not named', () => {
    const groups = parseRobots(BANK_SITE);
    expect(robotsVerdict(groups, '/home-loans/interest-rates.html')).toEqual({ allowed: true });
    expect(robotsVerdict(groups, '/bin/secret')).toEqual({
      allowed: false,
      because: 'robots_disallowed',
    });
  });

  it('the longest matching rule wins, and an allow beats a disallow of the same length', () => {
    const groups = parseRobots(BANK_SITE);
    expect(robotsVerdict(groups, '/etc/designs/favicon.ico')).toEqual({ allowed: true });
    expect(robotsVerdict(groups, '/etc/other')).toMatchObject({ allowed: false });
    const tie = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page\n');
    expect(robotsVerdict(tie, '/page')).toEqual({ allowed: true });
  });

  it('rules naming our own agent replace the rules for everyone', () => {
    const groups = parseRobots(
      `User-agent: *\nDisallow: /\n\nUser-agent: ${ROBOTS_AGENT_TOKEN}\nAllow: /\nDisallow: /members/\n`,
    );
    expect(robotsVerdict(groups, '/rates')).toEqual({ allowed: true });
    expect(robotsVerdict(groups, '/members/area')).toEqual({
      allowed: false,
      because: 'robots_disallowed',
    });
  });

  it('our name matches whatever its case in the file', () => {
    const groups = parseRobots('User-agent: FunddCommandCentre\nDisallow: /\n');
    expect(robotsVerdict(groups, '/rates')).toMatchObject({ allowed: false });
  });

  it('a site that shuts everyone out shuts us out', () => {
    expect(robotsVerdict(parseRobots('User-agent: *\nDisallow: /\n'), '/')).toEqual({
      allowed: false,
      because: 'robots_disallowed',
    });
  });

  it('the robots file itself may always be read', () => {
    expect(robotsVerdict(parseRobots('User-agent: *\nDisallow: /\n'), '/robots.txt')).toEqual({
      allowed: true,
    });
  });

  it('the query string is part of what a rule is matched against', () => {
    const groups = parseRobots('User-agent: *\nDisallow: /*?session=\n');
    expect(robotsVerdict(groups, '/page?session=abc')).toMatchObject({ allowed: false });
    expect(robotsVerdict(groups, '/page')).toEqual({ allowed: true });
  });
});

describe('robotsVerdict — a door shut on AI assistants is shut on us (D96)', () => {
  it('a news site that allows everyone but disallows ChatGPT-User and anthropic-ai is not read', () => {
    const groups = parseRobots(NEWS_SITE);
    expect(robotsVerdict(groups, '/news/2026-10-09/mortgages/107237648')).toEqual({
      allowed: false,
      because: 'robots_ai_disallowed',
    });
  });

  it('WITHOUT that rule the same article would be read — the test fails if the rule is removed', () => {
    const groups = parseRobots(NEWS_SITE);
    expect(robotsVerdict(groups, '/news/2026-10-09/mortgages/107237648', { aiTokens: [] })).toEqual(
      { allowed: true },
    );
  });

  it('a bank that names AI assistants as welcome is read, and its private areas are not', () => {
    const groups = parseRobots(BANK_SITE);
    expect(robotsVerdict(groups, '/home-loans/interest-rates.html')).toEqual({ allowed: true });
    expect(robotsVerdict(groups, '/netbank/login')).toEqual({
      allowed: false,
      because: 'robots_ai_disallowed',
    });
    expect(robotsVerdict(groups, '/digital/home-loans/borrowing-power-calculator')).toEqual({
      allowed: true,
    });
  });

  it('a disallow for a TRAINING crawler alone does not stop a read for a person', () => {
    const groups = parseRobots(
      'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: CCBot\nDisallow: /\n',
    );
    expect(robotsVerdict(groups, '/article')).toEqual({ allowed: true });
  });

  it.each(AI_ASSISTANT_TOKENS)('honours a disallow addressed to %s', (token) => {
    const groups = parseRobots(`User-agent: *\nAllow: /\n\nUser-agent: ${token}\nDisallow: /\n`);
    expect(robotsVerdict(groups, '/page')).toEqual({
      allowed: false,
      because: 'robots_ai_disallowed',
    });
  });

  it('the general disallow is reported first when both apply', () => {
    const groups = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: Claude-User\nDisallow: /\n',
    );
    expect(robotsVerdict(groups, '/page')).toEqual({
      allowed: false,
      because: 'robots_disallowed',
    });
  });

  it('AI rules never fall back to the rules for everyone', () => {
    // No AI assistant is named, so only `*` is consulted, once.
    const groups = parseRobots('User-agent: *\nDisallow: /members/\n');
    expect(robotsVerdict(groups, '/members/x')).toEqual({
      allowed: false,
      because: 'robots_disallowed',
    });
    expect(robotsVerdict(groups, '/open')).toEqual({ allowed: true });
  });
});

describe('robotsFromResponse — what an answer to /robots.txt means', () => {
  it('a 200 is its rules', () => {
    const answer = robotsFromResponse(200, 'User-agent: *\nDisallow: /x\n');
    expect(answer.kind).toBe('rules');
    expect(answer.kind === 'rules' && answer.groups).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 410, 429])(
    'a %i means there are no rules: read freely',
    (status) => {
      expect(robotsFromResponse(status, '<html>Not found</html>')).toEqual({ kind: 'none' });
    },
  );

  it.each([500, 502, 503, 504, 301, 100])(
    'a %i means nobody knows the rules, so nothing is read',
    (status) => {
      expect(robotsFromResponse(status, '')).toEqual({ kind: 'unavailable' });
    },
  );
});
