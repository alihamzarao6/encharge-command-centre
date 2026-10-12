/**
 * The limits and the words for reading a web page from a link (Milestone 5 part 2) — imported
 * by the browser AND by the Edge Function, as files/limits.ts is, so a number the interface
 * promises is the number the server enforces. Pure constants and pure functions.
 *
 * Every refusal is a sentence in two halves: what happened, and what the person can do
 * instead. "I could not open that page" is a correct answer (the brief's fixed decision 3);
 * an answer made up from the address, or from half a page presented as a whole one, is not.
 * None of these sentences ever contains a word of a page's content.
 */

const MB = 1024 * 1024;

export const PAGE_LIMITS = {
  maxUrlChars: 2_048,
  /**
   * Redirects followed before giving up. SECURITY.md §10 said 3 before anything was measured;
   * the probe found a real address (a lender's broker site) that takes exactly 3, and every
   * hop is checked again, so the cap protects time rather than safety.
   */
  maxRedirects: 5,
  /** To the first byte of each hop. */
  firstByteTimeoutMs: 10_000,
  /** The whole read: every hop, the robots file and the body. */
  totalTimeoutMs: 20_000,
  /** A page of markup or text. The largest in the probe was 1.82 MB. */
  maxTextBytes: 5 * MB,
  /** A PDF, a workbook, a picture: the same as an attached file (FILE_LIMITS.maxFileBytes). */
  maxDocumentBytes: 20 * MB,
  /** What is read of a robots.txt; the rest is ignored, as the standard allows. */
  robotsMaxBytes: 512 * 1024,
  robotsTimeoutMs: 8_000,
  robotsCacheMs: 10 * 60_000,
  /** Pages one person may open in a minute. */
  readsPerMinute: 10,
  /** Between two reads of the same host, by anyone (SECURITY.md §10). */
  hostGapMs: 2_000,
  /** Links offered beside the message box at once. */
  linksOffered: 3,
  /** How long a fetch may wait to be turned into an attachment. */
  receiptMinutes: 15,
  /** Days a web page's text is kept (D95). A document reached by a link keeps a file's 30. */
  pageRetentionDays: 1,
  /** Fewer letters and digits than this after cleaning is not a page worth attaching. */
  minReadableLetters: 200,
} as const;

/** Where a read runs. Australian sites answer Australian addresses (the probe, 12 Oct). */
export const READ_REGION = 'ap-southeast-2';

/**
 * Who we say we are. Honest by rule (CLAUDE.md §7) and by measurement: a browser-like agent
 * turned a 200 into a 403 on the probe.
 */
export const DEFAULT_USER_AGENT =
  'FunddCommandCentre/1.0 (+https://fundd.com.au; reads one page when a signed-in user pastes its link)';

/** Our name in a robots.txt, lower case. */
export const ROBOTS_AGENT_TOKEN = 'funddcommandcentre';

/**
 * The names a site uses to address an AI assistant fetching a page for the person using it.
 * A disallow addressed to any of these is honoured as if it named us (D96): we are one of
 * them, and what is read goes to Anthropic's model. Training crawlers (GPTBot, ClaudeBot,
 * CCBot) are a different thing and are not in this list.
 */
export const AI_ASSISTANT_TOKENS = [
  'claude-user',
  'claude-web',
  'anthropic-ai',
  'chatgpt-user',
  'perplexity-user',
  'mistralai-user',
  'meta-externalfetcher',
  'duckassistbot',
] as const;

/** Written where a page leaves a place for a script to fill in a figure. */
export const NOT_LOADED_MARK = '[not in the page as fetched]';

/**
 * Written as the first line of a page that shows nothing until its scripts run and was read
 * with its `opacity:0` declarations ignored (web/src/lib/files/html.ts). The database finds
 * it in the stored text and sets `conversation_files.read_as_sent`, which is what the screen
 * and the model are told from.
 */
export const READ_AS_SENT_MARK = '[read as the site sent it]';

/**
 * Why a page was not read. Each is final for that address as it stands: asking again gets the
 * same answer. Failures that may pass (the site is slow, our own rate limit) are not here —
 * they are retryable errors with their own sentences (PAGE_RETRY_MESSAGES).
 */
export const PAGE_REFUSAL_CODES = [
  'link_invalid',
  'link_not_https',
  'link_has_login',
  'link_port',
  'link_numeric',
  'link_private',
  'link_redirect_blocked',
  'robots_disallowed',
  'robots_ai_disallowed',
  'site_not_found',
  'too_many_redirects',
  'redirect_loop',
  'page_not_found',
  'page_login_required',
  'page_forbidden',
  'page_blocked',
  'page_unexpected_status',
  'page_too_large',
  'page_paywall',
  'page_forwards',
  'page_consent_wall',
  'page_no_text',
  'page_malformed',
] as const;
export type PageRefusalCode = (typeof PAGE_REFUSAL_CODES)[number];

export function isPageRefusalCode(value: unknown): value is PageRefusalCode {
  return typeof value === 'string' && (PAGE_REFUSAL_CODES as readonly string[]).includes(value);
}

/** The way round that works for almost every page that cannot be read. */
export const WAY_ROUND =
  'If you can open it yourself, save the page as a PDF and attach it, or paste the text here.';

const FIXED: Readonly<Record<Exclude<PageRefusalCode, 'page_too_large'>, string>> = {
  link_invalid:
    "That isn't a web address the assistant can open. Check the link and paste it again.",
  link_not_https:
    'Only secure pages are opened, and this link does not start with https://. Try the same address with https:// in front.',
  link_has_login:
    'This link has a username or password written into it, so it was not opened. Paste the address without them.',
  link_port:
    'This link points at a non-standard port, which the assistant does not open. Paste the ordinary address of the page.',
  link_numeric:
    "This link uses a numeric address in place of a site's name, so it was not opened. Paste the address with the site's name in it.",
  link_private:
    'This link points at a private or local address, not a public website, so it was not opened.',
  link_redirect_blocked: `This link passes the request on to an address the assistant does not open, so the page was not read. ${WAY_ROUND}`,
  robots_disallowed: `This site's rules ask automated readers not to open this page, so it was not read. ${WAY_ROUND}`,
  robots_ai_disallowed: `This site asks AI assistants not to read its pages, so it was not opened. ${WAY_ROUND}`,
  site_not_found: 'No website was found at that address. Check the link for a typing mistake.',
  too_many_redirects:
    'This link kept passing the request on to other addresses and never arrived at a page. Open it in your browser and paste the address you end up on.',
  redirect_loop:
    'This link goes round in a circle and never arrives at a page, which is what many sites do when you need to be signed in. Open it in your browser, then save the page as a PDF and attach it.',
  page_not_found:
    'That page does not exist: the site answered "not found". Check the link, or find the page again on the site and paste its current address.',
  page_login_required: `This page is behind a login, and the assistant cannot sign in. ${WAY_ROUND}`,
  page_forbidden: `The site refused to show this page to the assistant. ${WAY_ROUND}`,
  page_blocked: `This site blocks automated readers, so the page could not be opened. ${WAY_ROUND}`,
  page_unexpected_status: `The site answered in a way the assistant could not use, so the page was not read. ${WAY_ROUND}`,
  page_paywall:
    'This article is behind a paywall: only its opening lines are public, so it was not read. If you subscribe, save the article as a PDF and attach it, or paste the text here.',
  page_forwards:
    'This page only passes a browser on to another address, and that is not followed. Open it in your browser and paste the address you end up on.',
  page_consent_wall: `This page shows only a cookie or consent notice until someone agrees to it, so there was nothing to read. ${WAY_ROUND}`,
  page_no_text: `This page was opened, but what the site sent had no readable text in it. It may be drawn by scripts after it loads, or be a picture. ${WAY_ROUND}`,
  page_malformed: `This page is built in a way the assistant cannot read reliably, so it was not read. ${WAY_ROUND}`,
};

function megabytes(bytes: number): string {
  const mb = bytes / MB;
  return `${mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)} MB`;
}

/** `detail` is the limit, in bytes, that the page went past. */
export function pageRefusalMessage(code: PageRefusalCode, detail = 0): string {
  if (code === 'page_too_large') {
    const limit = detail > 0 ? detail : PAGE_LIMITS.maxTextBytes;
    return `This page is larger than the ${megabytes(limit)} the assistant reads from a link, so it was not opened. Download it and attach the part you need.`;
  }
  return FIXED[code];
}

/** Failures that may pass. The read can be tried again as it is. */
export const PAGE_RETRY_CODES = [
  'page_timeout',
  'site_unreachable',
  'site_error',
  'site_resting',
  'robots_unavailable',
  'too_many_reads',
] as const;
export type PageRetryCode = (typeof PAGE_RETRY_CODES)[number];

export const PAGE_RETRY_MESSAGES: Readonly<Record<PageRetryCode, string>> = {
  page_timeout: `That page took too long to answer, so it was not read. Try again. ${WAY_ROUND}`,
  site_unreachable: 'That site could not be reached just now, so the page was not read. Try again.',
  site_error:
    'That site is having a problem of its own right now, so the page was not read. Try again in a few minutes.',
  site_resting:
    'That site has not been answering, so it was not asked again just yet. Try again in a minute.',
  robots_unavailable:
    "The site's rules for automated readers could not be checked just now, so the page was not opened. Try again in a minute.",
  too_many_reads:
    'A lot of pages have been opened in the last minute. Wait a moment, then try again.',
};
