/**
 * robots.txt (Milestone 5 part 2, D96). Pure: text in, a verdict out.
 *
 * A site's robots file is honoured always (CLAUDE.md §7). Three sets of rules can apply to a
 * read, and the answer is the strictest of them:
 *
 *  - rules addressed to OUR agent by name, when a site has any;
 *  - otherwise the rules for everyone (`*`);
 *  - and, whichever of those applied, a disallow addressed to an AI assistant fetching a page
 *    for the person using it (`Claude-User`, `ChatGPT-User`, …). No site knows our name, so
 *    reading only the letter would let us through a door the site has plainly shut on
 *    assistants like this one. ABC, the AFR and realestate.com.au shut it; CommBank and ING
 *    name the same agents as welcome (probe, 12 Oct 2026).
 *
 * Matching follows RFC 9309: the longest matching rule wins, an allow beats a disallow of the
 * same length, `*` matches any run of characters and a trailing `$` anchors the end. A file
 * that is not a robots file at all (a site answering every address with its home page) has no
 * groups and therefore allows everything, which is what the standard says of a missing file.
 */
import { AI_ASSISTANT_TOKENS, ROBOTS_AGENT_TOKEN } from './limits.js';

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  /** Lower case. `*` is everyone. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

const MAX_LINES = 20_000;
const MAX_PATTERN_CHARS = 2_000;

export function parseRobots(text: string): readonly RobotsGroup[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  // Consecutive user-agent lines share one group; a rule line ends the run.
  let namingAgents = false;

  const lines = text.split(/\r\n|\r|\n/, MAX_LINES);
  for (const raw of lines) {
    const hash = raw.indexOf('#');
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!namingAgents || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value !== '') current.agents.push(value.toLowerCase());
      namingAgents = true;
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      namingAgents = false;
      // A rule before any user-agent line belongs to nobody.
      if (current === null) continue;
      // "Disallow:" with nothing after it means nothing is disallowed.
      if (value === '' || value.length > MAX_PATTERN_CHARS) continue;
      current.rules.push({ allow: key === 'allow', pattern: value });
      continue;
    }
    // Sitemap, crawl-delay, host and anything unknown: not a rule, and it does not end a
    // run of user-agent lines (RFC 9309 §2.2.1).
  }
  return groups.filter((group) => group.agents.length > 0);
}

/** Does `pattern` match the start of `path`? `*` is any run; a final `$` is the end. */
export function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');

  // Walked by hand rather than compiled to a regular expression: a robots file is somebody
  // else's text, and a pattern of fifty stars must cost what it looks like it costs.
  let at = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (index === 0) {
      if (!path.startsWith(part)) return false;
      at = part.length;
      continue;
    }
    const last = index === parts.length - 1;
    if (last && anchored) {
      // The final piece must sit at the very end.
      if (part.length > path.length - at) return false;
      return path.endsWith(part);
    }
    const found = path.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return anchored ? at === path.length : true;
}

function decide(rules: readonly RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}

function rulesFor(groups: readonly RobotsGroup[], token: string): readonly RobotsRule[] | null {
  const named = groups.filter((group) => group.agents.includes(token));
  return named.length === 0 ? null : named.flatMap((group) => group.rules);
}

export type RobotsVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly because: 'robots_disallowed' | 'robots_ai_disallowed';
    };

export interface RobotsOptions {
  readonly agentToken?: string;
  readonly aiTokens?: readonly string[];
}

/** May this path be read? `path` is the path and query, starting with `/`. */
export function robotsVerdict(
  groups: readonly RobotsGroup[],
  path: string,
  options: RobotsOptions = {},
): RobotsVerdict {
  // The robots file itself is always readable (RFC 9309 §2.2.2).
  if (path === '/robots.txt') return { allowed: true };
  const agentToken = (options.agentToken ?? ROBOTS_AGENT_TOKEN).toLowerCase();
  const aiTokens = options.aiTokens ?? AI_ASSISTANT_TOKENS;

  const own = rulesFor(groups, agentToken) ?? rulesFor(groups, '*') ?? [];
  if (!decide(own, path)) return { allowed: false, because: 'robots_disallowed' };

  for (const token of aiTokens) {
    const rules = rulesFor(groups, token.toLowerCase());
    if (rules !== null && !decide(rules, path)) {
      return { allowed: false, because: 'robots_ai_disallowed' };
    }
  }
  return { allowed: true };
}

/**
 * What a robots.txt answer means (RFC 9309 §2.3.1): a file → its rules; "not there" (any
 * 4xx) → no rules, read freely; the site failing to answer (5xx, a timeout) → nobody knows
 * the rules, so nothing is read.
 */
export type RobotsAnswer =
  | { readonly kind: 'rules'; readonly groups: readonly RobotsGroup[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

export function robotsFromResponse(status: number, body: string): RobotsAnswer {
  if (status >= 200 && status < 300) return { kind: 'rules', groups: parseRobots(body) };
  if (status >= 400 && status < 500) return { kind: 'none' };
  return { kind: 'unavailable' };
}
