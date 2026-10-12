/**
 * Links in what the person is typing (Milestone 5 part 2, D94). Pure.
 *
 * A link is RECOGNISED here and nothing more. It is never opened because it appeared: this
 * assistant's main work is drafting, and drafts are full of links that are not there to be
 * read — his own site in a post, a booking link, an email he pasted that has "confirm" and
 * "unsubscribe" links in it. Fetching one of those is at best a cost and at worst an action
 * he did not take. So a link gets an offer beside the message box ("Read this page"), and a
 * read happens only when he takes it.
 *
 * The address rules are the server's own (src/lib/pages/guard.ts, imported, not copied), so
 * a link the server would refuse is refused here in the same words before anything is sent.
 * The server still decides: this is so the person is told at once, not so the browser is
 * trusted.
 */
import { parsePublicUrl, type LinkRefusal } from '../../../src/lib/pages/guard.js';
import { PAGE_LIMITS, pageRefusalMessage } from '../../../src/lib/pages/limits.js';

export interface DraftLink {
  /** The address as it will be sent: what the guard made of what was typed. */
  readonly url: string;
  /** Exactly what was typed, so it can be taken back out of the box. */
  readonly typed: string;
  /** "westpac.com.au" — for a person, not for a request. */
  readonly host: string;
  /** Host and a shortened path: enough to tell two links apart on a phone. */
  readonly display: string;
  /** Why this address will not be opened, in the server's words; null when it would be. */
  readonly refusal: { readonly code: LinkRefusal; readonly message: string } | null;
}

// A web address in running text. Angle brackets, quotes and whitespace end it.
const LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DISPLAY_PATH_CHARS = 38;

/**
 * Sentence punctuation after a link is the sentence's, not the link's: "see
 * https://a.example/b." A closing bracket is the link's only if the link opened one.
 */
function trimTrailing(link: string): string {
  let out = link;
  for (;;) {
    const last = out.at(-1) ?? '';
    if ('.,;:!?…'.includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null;
    if (opener !== null && out.split(last).length > out.split(opener).length) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

function shortPath(path: string): string {
  const clean = path.replace(/\/+$/, '');
  if (clean === '') return '';
  if (clean.length <= DISPLAY_PATH_CHARS) return clean;
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  const tail = last.length > DISPLAY_PATH_CHARS - 4 ? last.slice(-(DISPLAY_PATH_CHARS - 4)) : last;
  return `/…/${tail}`;
}

function describe(typed: string): DraftLink {
  const verdict = parsePublicUrl(typed);
  if (verdict.ok) {
    const host = verdict.url.host.replace(/^www\./, '');
    return {
      url: verdict.url.href,
      typed,
      host,
      display: `${host}${shortPath(verdict.url.pathAndQuery.split('?')[0] ?? '')}`,
      refusal: null,
    };
  }
  // Refused: still shown, by whatever of it can be read, so he can see which link is meant.
  let host = typed.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? typed;
  host = host.replace(/^[^@]*@/, '').replace(/^www\./, '');
  const display = host.length > 48 ? `${host.slice(0, 47)}…` : host;
  return {
    url: typed,
    typed,
    host: display,
    display,
    refusal: { code: verdict.refusal, message: pageRefusalMessage(verdict.refusal) },
  };
}

/** The links in a draft, in the order written, each once. */
export function findLinks(text: string): readonly DraftLink[] {
  const seen = new Set<string>();
  const out: DraftLink[] = [];
  for (const match of text.matchAll(LINK)) {
    const typed = trimTrailing(match[0]);
    // "https://" and a few characters is somebody still typing.
    if (typed.replace(/^https?:\/\//i, '').length < 4) continue;
    const link = describe(typed);
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    out.push(link);
  }
  return out;
}

/** How many of a draft's links are offered at once; the rest wait their turn. */
export function offered(links: readonly DraftLink[]): {
  readonly shown: readonly DraftLink[];
  readonly more: number;
} {
  const shown = links.slice(0, PAGE_LIMITS.linksOffered);
  return { shown, more: links.length - shown.length };
}

/** True when the draft is nothing but links: there is no question in it to send. */
export function onlyLinks(text: string): boolean {
  const links = findLinks(text);
  if (links.length === 0) return false;
  let rest = text;
  for (const link of links) rest = rest.split(link.typed).join(' ');
  return rest.replace(/[\s.,;:!?()[\]{}<>"'`-]+/g, '') === '';
}

/** The draft with one link taken out, and the space it left closed up. */
export function withoutLink(text: string, link: DraftLink): string {
  return text
    .split(link.typed)
    .join(' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim();
}
