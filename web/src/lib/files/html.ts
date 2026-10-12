/**
 * Reading a web page (Milestone 5 part 2, D98) — one more `FileExtractor`, beside the PDF,
 * Word and Excel readers, and behind the same interface.
 *
 * A page is mostly not the page: navigation, a cookie notice, a footer, scripts. What a
 * person means by "read this page" is the words they would see in the middle of it, with its
 * tables still tables. So this reader walks the tags (htmlTokens.ts — no DOM, nothing
 * rendered, nothing run, nothing requested) and keeps:
 *
 *   ONLY THE TEXT OF ELEMENTS, never an attribute. Not `alt`, not `title`, not `aria-label`,
 *   not `placeholder`, not a `data-*` value, not a comment, not a script. Those are where
 *   text is put that a reader of the page never sees, and so where an instruction aimed at
 *   the assistant would be put.
 *
 *   NOT WHAT THE MARKUP ITSELF SAYS IS HIDDEN: the `hidden` attribute, `aria-hidden="true"`,
 *   and an inline style that hides (display:none, visibility:hidden, zero opacity, zero size,
 *   pushed off screen). Text hidden only by a CLASS is read: a class is a stylesheet's
 *   business, a stylesheet cannot be judged without a browser, and on real pages it is where
 *   the content is — one lender wraps its whole rate page in a screen-reader class until its
 *   scripts start, and another names each rate table in a caption nobody sees (probe, 12 Oct
 *   2026; the reviewer's call the same day). Whatever is read is still only data: it reaches
 *   the model inside the wrapper (src/lib/files/context.ts), hidden or not.
 *
 *   HIDDEN IS A PROPERTY OF THE TEXT, not of the paragraph or the table it sits in. A hidden
 *   span in the middle of a visible sentence — the commonest shape an injected instruction
 *   takes — is dropped and the sentence closes up around it; a hidden cell or row is not in
 *   its table; a hidden tab names no panel. (Until 12 Oct 2026 it was decided per block, by
 *   whatever the block's first text sat in, and a hidden span after visible words was read.)
 *
 *   ONE EXCEPTION, for the page that FADES ITSELF IN. The same lender sends its whole
 *   server-rendered page with an inline `opacity:0` on every section — the starting state of
 *   an entrance animation its scripts then play. Read by the rule above, that page is empty.
 *   So where what is visible is next to nothing and what sits behind `opacity:0` is the
 *   page, the page is read with those declarations ignored, and the person is told it was
 *   read as sent. ONLY THOSE: text hidden any other way — `display:none`, `hidden`,
 *   `aria-hidden`, off screen, sized to nothing, clipped — is dropped there as everywhere,
 *   including inside a faded section, and so is every attribute, comment and script.
 *
 *   That is narrower than "read it as sent", and it is still a door: on such a page, text
 *   somebody hid with `opacity:0` and never meant to fade in is read too. No reading of
 *   markup can tell the two apart. What makes it harmless is not this file but the wrapper
 *   it reaches the model in (src/lib/files/context.ts): it is data, it cannot close the
 *   wrapper, and nothing it says can be acted on. tests/unit/web/files-html.test.ts,
 *   tests/unit/files/context-web.test.ts and tests/unit/llm/chat-pages.test.ts hold a page
 *   in exactly this shape, with an instruction hidden that way, to both halves of that.
 *
 *   A PAGE NESTED DEEPER THAN ANY REAL PAGE IS NOT READ. Past the depth this walk tracks, an
 *   element's "hidden" could not be honoured, so the page is refused whole.
 *
 *   THE LABEL ON A TAB IS A HEADING. A lender puts owner-occupier rates under one tab and
 *   investment rates under another, and the only thing that says which is which is the tab —
 *   a `<button>`, which is otherwise not prose. A tab's label is therefore carried to the
 *   panel it opens and written above it; an accordion's button is a heading where it stands.
 *   Without this the two sets of rates read as one list with nothing to tell them apart.
 *
 *   TABLES AS TABLES. A rate sheet is a table, and a figure under the wrong heading is a
 *   wrong rate. Rows keep their cells in order, a spanning cell is repeated into every
 *   column or row it covers, and an empty cell is written `(blank)` — part 1's mark and
 *   part 1's rule for reading it.
 *
 * And it says what it could NOT read. A place the site leaves for a script to fill in (three
 * of seven lender rate pages do this with their rates) is written into the text as
 * `[not in the page as fetched]` and counted, so the page is attached as read IN PART. A
 * paywall, a login page, a bot check, a page that only forwards a browser elsewhere, a
 * consent wall and a page with no text are refused, each with its own sentence: half a page
 * is never presented as a page.
 */
import { EMPTY_CELL_MARK, refusal } from '../../../../src/lib/files/limits.js';
import { meaningfulChars } from '../../../../src/lib/files/text.js';
import {
  NOT_LOADED_MARK,
  PAGE_LIMITS,
  READ_AS_SENT_MARK,
  type PageRefusalCode,
} from '../../../../src/lib/pages/limits.js';
import { tokenizeHtml, type HtmlAttributes } from './htmlTokens.js';
import { decodeText } from './plain.js';
import { noop, refused, type ExtractInput, type Extraction, type FileExtractor } from './types.js';

// ---------------------------------------------------------------------------------------
// Bytes → characters
// ---------------------------------------------------------------------------------------

function tryDecode(bytes: Uint8Array, label: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    // An encoding this device does not know, or bytes that are not in it.
    return null;
  }
}

/** The charset a page declares for itself in its first few kilobytes, if it does. */
export function declaredCharset(bytes: Uint8Array): string | null {
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 4_096); i += 1) {
    head += String.fromCharCode(bytes[i] ?? 0);
  }
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._:-]{2,40})/i.exec(head);
  return direct?.[1]?.toLowerCase() ?? null;
}

/**
 * A page's bytes as text. In order: a byte order mark; the charset the server's header
 * named; the charset the page names; and failing all of those, UTF-8 if the bytes are valid
 * UTF-8 and Windows-1252 if they are not (part 1's rule for a text file). A claim of UTF-8
 * that the bytes do not bear out is not believed.
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType: string | null = null): string {
  if (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    return decodeText(bytes).text;
  }
  const fromHeader = /charset\s*=\s*"?([a-z0-9._:-]{2,40})/i.exec(contentType ?? '')?.[1];
  for (const label of [fromHeader?.toLowerCase(), declaredCharset(bytes)]) {
    if (label === undefined || label === null) continue;
    const utf8 = label === 'utf-8' || label === 'utf8';
    const decoded = tryDecode(bytes, label, utf8);
    if (decoded !== null) return decoded;
  }
  return decodeText(bytes).text;
}

// ---------------------------------------------------------------------------------------
// What an element is
// ---------------------------------------------------------------------------------------

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  'frame',
]);

/** Never read, whatever is inside: not prose, or not the page's own content. */
const SKIPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'iframe',
  'object',
  'audio',
  'video',
  'map',
  'select',
  'datalist',
  'button',
  'textarea',
  'label',
  'nav',
  'aside',
  'dialog',
  'menu',
  'footer',
  'head',
  'frameset',
  'noframes',
  'xmp',
  'noembed',
]);

const SKIPPED_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'dialog',
  'alertdialog',
  'menu',
  'menubar',
  'toolbar',
  'tooltip',
]);

const BLOCK = new Set([
  'address',
  'article',
  'blockquote',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'html',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const HEADING_LEVEL: Readonly<Record<string, number>> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/** Opening one of these closes an open one of the same family (the end tag is optional). */
const IMPLIED_END: Readonly<
  Record<string, { close: readonly string[]; stopAt: readonly string[] }>
> = {
  li: { close: ['li'], stopAt: ['ul', 'ol'] },
  dt: { close: ['dt', 'dd'], stopAt: ['dl'] },
  dd: { close: ['dt', 'dd'], stopAt: ['dl'] },
  tr: { close: ['tr'], stopAt: ['table'] },
  td: { close: ['td', 'th'], stopAt: ['tr', 'table'] },
  th: { close: ['td', 'th'], stopAt: ['tr', 'table'] },
  thead: { close: ['thead', 'tbody', 'tfoot'], stopAt: ['table'] },
  tbody: { close: ['thead', 'tbody', 'tfoot'], stopAt: ['table'] },
  tfoot: { close: ['thead', 'tbody', 'tfoot'], stopAt: ['table'] },
  option: { close: ['option'], stopAt: ['select', 'datalist'] },
};

/** What a `<head>` may hold. Anything else means the head is over, closed or not. */
const HEAD_CONTENT = new Set([
  'head',
  'title',
  'meta',
  'link',
  'base',
  'script',
  'style',
  'noscript',
  'template',
]);

/** Elements a paragraph cannot contain: opening one ends an open `<p>`. */
const ENDS_PARAGRAPH = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

function tokensOf(attrs: HtmlAttributes): readonly string[] {
  return `${attrs.get('class') ?? ''} ${attrs.get('id') ?? ''}`
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
}

// Names a site gives the parts of a page that are not the page. ADVISORY: text inside one of
// these is dropped only if plenty is left without it (`chooseBlocks`), because a class is a
// guess — `<body class="menu-open">` must not empty the page.
const CHROME_START =
  /^(?:nav|navbar|navigation|menu|megamenu|breadcrumb|breadcrumbs|footer|sidebar|skiplink|skip-link|skip-to|social|share|sharing|advert|advertisement|modal|popup|newsletter|related)(?:$|[-_])/;
const CHROME_EXACT = new Set([
  'site-nav',
  'main-nav',
  'primary-nav',
  'global-nav',
  'top-nav',
  'side-nav',
  'site-footer',
  'page-footer',
  'global-footer',
  'site-header',
  'global-header',
  'masthead',
]);
const CONSENT = /(?:^|[-_])(?:cookie|cookies|consent|gdpr|onetrust|cookiebot|truste)(?:[-_]|$)/;

/** What an element's own markup says about whether its text can be seen. */
type Concealment =
  /** Nothing hides it. */
  | 'shown'
  /** Only `opacity:0`: where an entrance animation starts from. */
  | 'faded'
  /** Removed, invisible, sized to nothing, clipped away or off the screen. */
  | 'gone';

/**
 * Does an inline style hide the element? Only declarations that make text unseeable: gone,
 * invisible, transparent, sized to nothing, clipped away, or positioned off the screen.
 */
export function styleHides(style: string): boolean {
  return styleConceals(style) !== 'shown';
}

/** The same question, telling a fade's starting state apart from every other way to hide. */
export function styleConceals(style: string): Concealment {
  if (style === '') return 'shown';
  const rules = styleRules(style);
  return styleGone(rules) ? 'gone' : styleFaded(rules) ? 'faded' : 'shown';
}

type StyleRules = ReadonlyMap<string, string>;

/** An inline style as property → value. A property written twice keeps its last value. */
function styleRules(style: string): StyleRules {
  const rules = new Map<string, string>();
  for (const part of style.toLowerCase().split(';')) {
    const colon = part.indexOf(':');
    if (colon < 1) continue;
    rules.set(
      part.slice(0, colon).trim(),
      part
        .slice(colon + 1)
        .replace(/!\s*important/g, '')
        .trim(),
    );
  }
  return rules;
}

function styleNumber(
  rules: StyleRules,
  property: string,
): { readonly value: number; readonly percent: boolean } | null {
  const match = /^(-?\d*\.?\d+)\s*(px|em|rem|%|pt|vw|vh|ch|ex)?$/.exec(rules.get(property) ?? '');
  return match?.[1] === undefined ? null : { value: Number(match[1]), percent: match[2] === '%' };
}

/** Text at less than a tenth of full strength is not there to be read by a person. */
const UNSEEABLE_OPACITY = 0.1;

/**
 * Transparent, as a browser applies it: zero, a negative (which is zero), or so near
 * nothing that nobody could read it.
 */
function styleFaded(rules: StyleRules): boolean {
  const opacity = styleNumber(rules, 'opacity');
  if (opacity === null) return false;
  return (opacity.percent ? opacity.value / 100 : opacity.value) < UNSEEABLE_OPACITY;
}

/** Every way to hide but opacity. */
function styleGone(rules: StyleRules): boolean {
  const size = (property: string): number | null => styleNumber(rules, property)?.value ?? null;

  if (rules.get('display') === 'none') return true;
  const visibility = rules.get('visibility');
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (size('font-size') === 0) return true;
  if (rules.get('color') === 'transparent') return true;

  const clipsOverflow = (rules.get('overflow') ?? '').startsWith('hidden');
  const tiny = (property: string): boolean => {
    const value = size(property);
    return value !== null && value <= 1;
  };
  if (
    clipsOverflow &&
    (tiny('width') || tiny('height') || tiny('max-width') || tiny('max-height'))
  ) {
    return true;
  }
  if (/rect\(\s*(?:0|1px)[\s,]/.test(rules.get('clip') ?? '')) return true;
  if (/inset\(\s*(?:50|100)%/.test(rules.get('clip-path') ?? '')) return true;
  if (/scale\(\s*0(?:\.0+)?\s*(?:,\s*0(?:\.0+)?\s*)?\)/.test(rules.get('transform') ?? '')) {
    return true;
  }

  const position = rules.get('position');
  const placed = position === 'absolute' || position === 'fixed';
  for (const property of ['left', 'top', 'right', 'bottom', 'margin-left', 'margin-top']) {
    const value = size(property);
    if (value !== null && value <= -500 && (placed || property.startsWith('margin'))) return true;
  }
  const indent = size('text-indent');
  return indent !== null && indent <= -500;
}

function concealment(attrs: HtmlAttributes): Concealment {
  if (attrs.has('hidden')) return 'gone';
  if ((attrs.get('aria-hidden') ?? '').trim().toLowerCase() === 'true') return 'gone';
  return styleConceals(attrs.get('style') ?? '');
}

// An empty element whose names say "a figure goes here". Measured on the probe: 12, 293 and
// 244 on the three lender pages whose rates are filled in by script, 0 on the other fourteen.
const VALUE_WORDS =
  /(?:^|[^a-z])(?:rate|rates|percent|pct|price|pricing|amount|value|fee|fees|repayment|repayments|productdata|interest|balance|total)(?:[^a-z]|$)/i;
const VALUE_ELEMENTS = new Set(['span', 'td', 'th', 'strong', 'b', 'em', 'output', 'data']);

function looksLikeValueSlot(name: string, attrs: HtmlAttributes): boolean {
  if (!VALUE_ELEMENTS.has(name)) return false;
  for (const [key, value] of attrs) {
    if (key !== 'class' && key !== 'id' && !key.startsWith('data-')) continue;
    // A path is an address, not a name: "/home-loans/rates/banner.png" names nothing.
    if (value.includes('/')) continue;
    if (VALUE_WORDS.test(`${key}=${value}`)) return true;
  }
  return false;
}

/** `role` and a few class names mean "table" on pages that draw tables out of `<div>`s. */
function effectiveName(name: string, attrs: HtmlAttributes): string {
  const role = (attrs.get('role') ?? '').trim().toLowerCase();
  if (role === 'table' || role === 'grid' || role === 'treegrid') return 'table';
  if (role === 'row') return 'tr';
  if (role === 'cell' || role === 'gridcell') return 'td';
  if (role === 'columnheader' || role === 'rowheader') return 'th';
  if (name === 'table' && (role === 'presentation' || role === 'none')) return 'div';
  if (name === 'div' || name === 'span' || name === 'li' || name === 'ul') {
    const classes = (attrs.get('class') ?? '').toLowerCase().split(/\s+/);
    if (classes.includes('table-row') || classes.includes('d-table-row')) return 'tr';
    if (classes.includes('table-cell') || classes.includes('d-table-cell')) return 'td';
  }
  return name;
}

// ---------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------

interface Flags {
  /** Inside something the markup itself hides (`hidden`, `aria-hidden`, an inline style). */
  readonly hidden: boolean;
  readonly main: boolean;
  readonly article: boolean;
  /** Inside something a class name suggests is not the page's content. */
  readonly chrome: boolean;
  readonly consent: boolean;
}

interface Cell {
  text: string;
  readonly header: boolean;
  readonly colspan: number;
  readonly rowspan: number;
}

interface Row {
  readonly cells: Cell[];
  readonly head: boolean;
}

interface TableBuilder {
  readonly rows: Row[];
  row: Row | null;
  cell: Cell | null;
  caption: string;
  inCaption: boolean;
  inHead: boolean;
  /** Holds another table, so it is page layout, not data: its cells are read as prose. */
  layout: boolean;
  /** Made of loose rows with no table element around them. */
  readonly implied: boolean;
  readonly flags: Flags;
}

/** The words on a tab, collected while the tab is open and filed under what it opens. */
interface LabelCapture {
  readonly keys: readonly string[];
  text: string;
}

interface Frame extends Flags {
  /** The tag as written. */
  readonly tag: string;
  /** What it counts as (a `<div role="row">` is a row). */
  readonly name: string;
  readonly skip: boolean;
  readonly block: boolean;
  readonly link: boolean;
  readonly pre: boolean;
  /** Inside `<article>`, `<main>` or `<section>`: a `<header>` here is a headline, not a banner. */
  readonly sectioned: boolean;
  /** A table this element opened — its own, or one implied around loose rows inside it. */
  table: TableBuilder | null;
  readonly valueSlot: boolean;
  /** Text, or any element, was written inside it. */
  hadContent: boolean;
  /** Text inside goes to a tab's label rather than to the page. */
  readonly capture: LabelCapture | null;
  /** This element started that capture, and files it when it closes. */
  readonly ownsCapture: boolean;
  /**
   * Hidden by something other than a fade, here or above. Text that is `hidden` and not
   * `gone` is behind `opacity:0` and nothing else.
   */
  readonly gone: boolean;
}

type BlockKind = 'heading' | 'para' | 'item' | 'term' | 'pre' | 'table';

export interface HtmlBlock extends Flags {
  readonly kind: BlockKind;
  readonly level: number;
  readonly text: string;
  /** For a table: how many of its leading lines are headings, repeated if it is split. */
  readonly headerLines: number;
  readonly linkChars: number;
}

interface Signals {
  title: string | null;
  metaRefresh: boolean;
  scriptRedirect: boolean;
  paywallMarked: boolean;
  articlePage: boolean;
  passwordField: boolean;
  /** Nested deeper than the walk tracks: nothing read from it can be trusted. */
  tooDeep: boolean;
}

const MAX_DEPTH = 1_500;
const MAX_SPAN = 60;
const MAX_GRID_CELLS = 200_000;
const ROOT: Frame = {
  tag: '#root',
  name: '#root',
  skip: false,
  block: true,
  link: false,
  pre: false,
  sectioned: false,
  hidden: false,
  main: false,
  article: false,
  chrome: false,
  consent: false,
  table: null,
  valueSlot: false,
  hadContent: false,
  capture: null,
  ownsCapture: false,
  gone: false,
};

/** The elements a tab or an accordion heading is made of. */
function disclosure(
  tag: string,
  attrs: HtmlAttributes,
  role: string,
): { readonly kind: 'tab' | 'toggle'; readonly keys: readonly string[] } | null {
  const toggle = (attrs.get('data-toggle') ?? attrs.get('data-bs-toggle') ?? '').toLowerCase();
  const isTab = role === 'tab' || toggle === 'tab' || toggle === 'pill';
  const isToggle =
    toggle === 'collapse' ||
    (tag === 'button' && (attrs.has('aria-expanded') || attrs.has('aria-controls')));
  if (!isTab && !isToggle) return null;
  const keys: string[] = [];
  const id = attrs.get('id');
  // A panel names its tab with aria-labelledby; a tab names its panel with aria-controls,
  // or with an in-page address.
  if (id !== undefined && id !== '') keys.push(`by:${id}`);
  const controls = attrs.get('aria-controls');
  if (controls !== undefined && controls !== '') keys.push(`id:${controls}`);
  for (const name of ['href', 'data-target', 'data-bs-target']) {
    const target = attrs.get(name);
    if (target !== undefined && /^#[^\s#]+$/.test(target)) keys.push(`id:${target.slice(1)}`);
  }
  return { kind: isTab ? 'tab' : 'toggle', keys };
}

const LABEL_MAX_CHARS = 140;
/** A tab's label, written above the panel it opens. */
const TAB_HEADING_LEVEL = 4;

const SCRIPT_REDIRECT =
  /(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["'`]|location\.(?:replace|assign)\s*\(/;

/** A grid as lines of tab-separated cells, every line the same width. */
function lines(grid: readonly (readonly (string | undefined)[])[], width: number): string[] {
  return grid.map((line) =>
    Array.from({ length: width }, (_unused, column) => line[column] ?? EMPTY_CELL_MARK).join('\t'),
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function span(attrs: HtmlAttributes, name: string): number {
  const value = Number.parseInt(attrs.get(name) ?? '1', 10);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, MAX_SPAN) : 1;
}

interface Walked {
  /** What the markup does not hide. Hidden text is never a block. */
  readonly blocks: HtmlBlock[];
  readonly signals: Signals;
  /** How many letters sit behind `opacity:0` and nothing else. */
  readonly fadedLetters: number;
}

/**
 * `unfaded`: read the page as it will look once its entrance animations have played — an
 * inline `opacity:0` hides nothing. Every other way of hiding still does.
 */
function walk(html: string, unfaded = false): Walked {
  const stack: Frame[] = [ROOT];
  let fadedLetters = 0;
  const tables: TableBuilder[] = [];
  const blocks: HtmlBlock[] = [];
  const signals: Signals = {
    title: null,
    metaRefresh: false,
    scriptRedirect: false,
    paywallMarked: false,
    articlePage: false,
    passwordField: false,
    tooDeep: false,
  };

  let buffer = '';
  let bufferLinks = 0;
  let bufferFrame: Frame | null = null;
  let bufferKind: { readonly kind: BlockKind; readonly level: number } = { kind: 'para', level: 0 };
  /** An accordion button being read as a heading: its text is flushed when it closes. */
  let headingControl: Frame | null = null;
  /** Tab labels, by the id of the panel each opens (`id:`) or of the tab itself (`by:`). */
  const labels = new Map<string, string>();

  const top = (): Frame => stack[stack.length - 1] ?? ROOT;

  /** The table cell (or caption) text is going into right now, if any. */
  const openTable = (): TableBuilder | null => {
    const table = tables[tables.length - 1];
    if (table === undefined || table.layout) return null;
    return table.cell !== null || table.inCaption ? table : null;
  };

  const push = (
    kind: BlockKind,
    text: string,
    flags: Flags,
    extra: Partial<HtmlBlock> = {},
  ): void => {
    // Text is stopped where it is added; this stops what is written from somewhere else —
    // a tab's label above a hidden panel, the pieces of a table that was hidden.
    if (text === '' || flags.hidden) return;
    blocks.push({
      kind,
      level: 0,
      text,
      headerLines: 0,
      linkChars: 0,
      hidden: flags.hidden,
      main: flags.main,
      article: flags.article,
      chrome: flags.chrome,
      consent: flags.consent,
      ...extra,
    });
  };

  /** What kind of block the text now in the buffer is, from what it sits inside. */
  const kindHere = (): { readonly kind: BlockKind; readonly level: number } => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i];
      if (frame?.block !== true) continue;
      const level = HEADING_LEVEL[frame.name];
      if (level !== undefined) return { kind: 'heading', level };
      if (frame.name === 'li') return { kind: 'item', level: 0 };
      if (frame.name === 'dt') return { kind: 'term', level: 0 };
      if (frame.name === 'pre') return { kind: 'pre', level: 0 };
      if (frame.name === 'summary') return { kind: 'heading', level: 4 };
      break;
    }
    return { kind: 'para', level: 0 };
  };

  const flush = (): void => {
    if (buffer === '') return;
    // Prose after a run of loose rows: those rows are a finished table, and come first.
    const loose = tables[tables.length - 1];
    if (loose?.implied === true && loose.row === null && loose.cell === null) emitTable(loose);
    const owner = bufferFrame ?? top();
    const { kind, level } = bufferKind;
    const text =
      kind === 'pre'
        ? buffer.replace(/\s+$/, '')
        : buffer
            .split('\n')
            .map(collapse)
            .filter((line) => line !== '')
            .join('\n');
    push(kind, text, owner, { level, linkChars: bufferLinks });
    buffer = '';
    bufferLinks = 0;
    bufferFrame = null;
  };

  /** Something is inside every open element: none of them is an empty slot. */
  const markContent = (): void => {
    for (let i = stack.length - 1; i > 0; i -= 1) {
      const element = stack[i];
      if (element === undefined || element.hadContent) break;
      element.hadContent = true;
    }
  };

  const addText = (raw: string, frame: Frame): void => {
    if (raw === '') return;
    if (frame.hidden) {
      // Not read, wherever it sits: in a block of its own, in the middle of a sentence, in a
      // table cell, on a tab. All that is kept is how much of it is behind a fade alone.
      if (!frame.skip && !frame.gone) fadedLetters += meaningfulChars(raw);
      return;
    }
    if (frame.capture !== null) {
      if (frame.capture.text.length < LABEL_MAX_CHARS * 4) frame.capture.text += raw;
      return;
    }
    if (frame.skip) return;
    const table = openTable();
    if (/\S/.test(raw)) markContent();
    if (table !== null) {
      if (table.cell !== null) table.cell.text += raw;
      else table.caption += raw;
      return;
    }
    const text = frame.pre ? raw : raw.replace(/\s+/g, ' ');
    if (buffer === '' && text.trim() === '') return;
    if (buffer === '') {
      bufferFrame = frame;
      // Decided now, while the heading or list item the text sits in is still open.
      bufferKind =
        headingControl !== null && stack.includes(headingControl)
          ? { kind: 'heading', level: TAB_HEADING_LEVEL }
          : kindHere();
    }
    buffer += text;
    if (frame.link) bufferLinks += text.replace(/\s/g, '').length;
  };

  const endCell = (table: TableBuilder): void => {
    if (table.cell === null) return;
    table.cell.text = collapse(table.cell.text);
    (table.row ??= { cells: [], head: table.inHead }).cells.push(table.cell);
    table.cell = null;
  };
  const endRow = (table: TableBuilder): void => {
    endCell(table);
    if (table.row !== null && table.row.cells.length > 0) table.rows.push(table.row);
    table.row = null;
  };

  /** A table that turned out to hold another table: what it has collected is prose. */
  const makeLayout = (table: TableBuilder): void => {
    if (table.layout) return;
    const pending = [...table.rows, ...(table.row === null ? [] : [table.row])];
    push('para', collapse(table.caption), table.flags);
    for (const row of pending) {
      for (const cell of row.cells) push('para', cell.text, table.flags);
    }
    if (table.cell !== null) push('para', collapse(table.cell.text), table.flags);
    table.rows.length = 0;
    table.row = null;
    table.cell = null;
    table.caption = '';
    table.inCaption = false;
    table.layout = true;
  };

  const finishTable = (table: TableBuilder): void => {
    const index = tables.lastIndexOf(table);
    if (index !== -1) tables.splice(index, 1);
    if (table.layout) return;
    endRow(table);
    emitTable(table);
  };

  /** What a table has gathered so far, written out; the table is left empty. */
  const emitTable = (table: TableBuilder): void => {
    if (table.rows.length === 0 && table.caption === '') return;
    const caption = collapse(table.caption);
    const rows = table.rows.splice(0, table.rows.length);
    table.caption = '';

    // Spans are spread over every column and row they cover, so each row stands on its own.
    const grid: string[][] = [];
    let cellsPlaced = 0;
    rows.forEach((row, r) => {
      const line = (grid[r] ??= []);
      let column = 0;
      for (const cell of row.cells) {
        while (line[column] !== undefined) column += 1;
        const text = cell.text === '' ? EMPTY_CELL_MARK : cell.text.replace(/\t/g, ' ');
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          for (let dr = 0; dr < cell.rowspan && r + dr < rows.length; dr += 1) {
            if (cellsPlaced >= MAX_GRID_CELLS) break;
            const target = (grid[r + dr] ??= []);
            target[column + dc] ??= text;
            cellsPlaced += 1;
          }
        }
        column += cell.colspan;
      }
    });
    const width = grid.reduce((most, line) => Math.max(most, line.length), 0);

    // One row, or one column, is somebody arranging a page — not a table of anything.
    if (grid.length < 2 || width < 2) {
      push('para', caption, table.flags);
      const only = rows.length === 1 ? rows[0] : undefined;
      if (
        only !== undefined &&
        only.cells.length > 1 &&
        only.cells.every((cell) => cell.text.length <= 80)
      ) {
        // One row of short cells is a row of column headings whose table follows: kept on
        // one line, in order, so the rows beneath it can still be read against it.
        push('para', lines(grid, width)[0] ?? '', table.flags);
        return;
      }
      for (const row of rows) {
        for (const cell of row.cells) push(cell.header ? 'term' : 'para', cell.text, table.flags);
      }
      return;
    }

    let headerRows = 0;
    while (headerRows < rows.length - 1) {
      const row = rows[headerRows];
      if (row === undefined || !(row.head || row.cells.every((cell) => cell.header))) break;
      headerRows += 1;
    }
    const lead = caption === '' ? [] : [`Table: ${caption}`];
    push('table', [...lead, ...lines(grid, width)].join('\n'), table.flags, {
      headerLines: lead.length + headerRows,
    });
  };

  const newTable = (flags: Flags, implied: boolean): TableBuilder => ({
    rows: [],
    row: null,
    cell: null,
    caption: '',
    inCaption: false,
    inHead: false,
    layout: false,
    implied,
    flags,
  });

  const closeFrame = (frame: Frame): void => {
    if (frame.ownsCapture && frame.capture !== null) {
      const label = collapse(frame.capture.text).slice(0, LABEL_MAX_CHARS);
      if (label !== '') for (const key of frame.capture.keys) labels.set(key, label);
      return;
    }
    if (frame.capture !== null) return;
    if (frame === headingControl) {
      flush();
      headingControl = null;
    }
    if (frame.valueSlot && !frame.hadContent && !frame.skip && !frame.hidden) {
      // The site left this for a script to fill in. Say so, where the figure would be.
      addText(NOT_LOADED_MARK, frame);
    }
    if (frame.block && !frame.skip) flush();
    const table = tables[tables.length - 1];
    // A hidden cell, row or caption was never part of the table, so it does not end one.
    if (table !== undefined && !table.layout && !frame.skip && !frame.hidden) {
      if (frame.name === 'td' || frame.name === 'th') endCell(table);
      else if (frame.name === 'tr') endRow(table);
      else if (frame.name === 'thead') table.inHead = false;
      else if (frame.name === 'caption') table.inCaption = false;
    }
    if (frame.table !== null) finishTable(frame.table);
  };

  const popTo = (index: number): void => {
    while (stack.length > index) {
      const frame = stack.pop();
      if (frame !== undefined) closeFrame(frame);
    }
  };

  const impliedEnds = (name: string): void => {
    const rule = Object.hasOwn(IMPLIED_END, name) ? IMPLIED_END[name] : undefined;
    if (rule !== undefined) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const open = stack[i];
        if (open === undefined || rule.stopAt.includes(open.name)) break;
        if (rule.close.includes(open.name)) {
          popTo(i);
          break;
        }
      }
    }
    // `</head>` is optional, and often left out: anything that cannot live in a head ends it.
    // Without this a page with no `</head>` would be read as having no body at all.
    if (!HEAD_CONTENT.has(name)) {
      const head = stack.findIndex((frame) => frame.tag === 'head');
      if (head > 0) popTo(head);
    }
    if (ENDS_PARAGRAPH.has(name)) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const open = stack[i];
        if (open === undefined) break;
        if (open.name === 'p') {
          popTo(i);
          break;
        }
        // A paragraph does not reach out through the block it is in.
        if (open.block) break;
      }
    }
  };

  const open = (tag: string, attrs: HtmlAttributes): void => {
    const name = effectiveName(tag, attrs);
    impliedEnds(name);
    const parent = top();
    const role = (attrs.get('role') ?? '').trim().toLowerCase();

    // Things noticed about the page, wherever they sit.
    if (tag === 'meta') {
      const equiv = (attrs.get('http-equiv') ?? '').toLowerCase();
      const named = (attrs.get('name') ?? attrs.get('property') ?? '').toLowerCase();
      const content = (attrs.get('content') ?? '').toLowerCase();
      if (equiv === 'refresh' && /url\s*=/.test(content)) signals.metaRefresh = true;
      if (named === 'article:content_tier' && (content === 'locked' || content === 'metered')) {
        signals.paywallMarked = true;
      }
      if (named === 'og:type' && content === 'article') signals.articlePage = true;
      return;
    }
    const control = parent.capture === null ? disclosure(tag, attrs, role) : null;
    const skip =
      parent.skip ||
      // A button is not prose — unless it is the label on a tab or an accordion.
      (SKIPPED.has(tag) && control === null) ||
      SKIPPED_ROLES.has(role) ||
      // A page's banner. Inside an article it is the headline, and stays.
      (tag === 'header' && !parent.sectioned);
    const says = concealment(attrs);
    const gone = parent.gone || says === 'gone';
    // A fade is the only hiding declaration that is ever ignored, and only for a page that
    // is being read as it will look once it has faded in.
    const hidden = gone || parent.hidden || (says === 'faded' && !unfaded);
    // A tab that says what it opens: its words are kept for that panel, not written here.
    // A hidden tab says nothing.
    const capture: LabelCapture | null =
      parent.capture ??
      (control !== null && control.kind === 'tab' && control.keys.length > 0 && !skip && !hidden
        ? { keys: control.keys, text: '' }
        : null);

    // An element inside another means the outer one is not an empty slot for a figure.
    markContent();

    if (!skip && !hidden) {
      if (tag === 'input' && (attrs.get('type') ?? '').toLowerCase() === 'password') {
        signals.passwordField = true;
      }
      if (tag === 'br') {
        const table = openTable();
        if (table !== null) {
          if (table.cell !== null) table.cell.text += ' ';
        } else if (buffer !== '') {
          buffer += '\n';
        }
      }
      if (tag === 'hr') flush();
    }
    if (VOID.has(tag)) return;

    const names = tokensOf(attrs);
    const structural = tag === 'html' || tag === 'body' || tag === 'main' || tag === 'article';
    const frame: Frame = {
      tag,
      name,
      skip,
      block: BLOCK.has(name),
      link: parent.link || tag === 'a',
      pre: parent.pre || tag === 'pre',
      sectioned: parent.sectioned || tag === 'article' || tag === 'main' || tag === 'section',
      hidden,
      main: parent.main || tag === 'main' || role === 'main',
      article: parent.article || tag === 'article' || role === 'article',
      chrome:
        parent.chrome ||
        (!structural && names.some((token) => CHROME_START.test(token) || CHROME_EXACT.has(token))),
      consent: parent.consent || (!structural && names.some((token) => CONSENT.test(token))),
      table: null,
      valueSlot: !skip && looksLikeValueSlot(tag, attrs),
      hadContent: false,
      capture,
      ownsCapture: capture !== null && parent.capture === null,
      gone,
    };
    if (tag === 'article') signals.articlePage = true;

    // Past a depth no real page reaches the walk stops keeping track, and an element that
    // is not tracked cannot have its `hidden` honoured: its text would be read as if it sat
    // in the last element that was. Such a page is not read at all.
    if (stack.length >= MAX_DEPTH) {
      signals.tooDeep = true;
      return;
    }

    if (capture !== null) {
      stack.push(frame);
      return;
    }

    if (!skip && hidden) {
      // It opens no table, row or cell, takes no label, and is no heading. A block still
      // ends the sentence before it, as it would on the page.
      if (frame.block) flush();
    } else if (!skip) {
      if (frame.block || control !== null) flush();
      // The panel a tab opens: the tab's words go above it.
      const id = attrs.get('id');
      const named =
        labels.get(`by:${attrs.get('aria-labelledby') ?? ''}`) ??
        (id === undefined ? undefined : labels.get(`id:${id}`));
      if (named !== undefined) {
        push('heading', named, frame, { level: TAB_HEADING_LEVEL });
        labels.delete(`id:${id ?? ''}`);
      }
      // An accordion's button, or a tab with nothing to say what it opens: a heading here.
      if (control !== null) {
        bufferFrame = frame;
        bufferKind = { kind: 'heading', level: TAB_HEADING_LEVEL };
        headingControl = frame;
      }
      const current = tables[tables.length - 1];
      if (name === 'table') {
        // A table inside a table's cell: the outer one is layout.
        if (current !== undefined && (current.cell !== null || current.row !== null)) {
          makeLayout(current);
        }
        frame.table = newTable(frame, false);
        tables.push(frame.table);
      } else if (name === 'tr') {
        let table = current !== undefined && !current.layout ? current : undefined;
        if (tag !== 'tr') {
          // A row made of `<div>`s. Inside another table's open cell it is a table within a
          // table, and the outer one is layout.
          if (table !== undefined && table.cell !== null) {
            makeLayout(table);
            table = undefined;
          }
          // With no table around it, the element the rows sit in is the table, and it ends
          // when that element does.
          if (table === undefined && parent.table === null && parent !== ROOT) {
            parent.table = newTable(parent, true);
            tables.push(parent.table);
            table = parent.table;
          }
        }
        if (table !== undefined) {
          endRow(table);
          table.row = { cells: [], head: table.inHead };
        }
      } else if ((name === 'td' || name === 'th') && current !== undefined && !current.layout) {
        endCell(current);
        current.row ??= { cells: [], head: current.inHead };
        current.cell = {
          text: '',
          header: name === 'th',
          colspan: span(attrs, 'colspan'),
          rowspan: span(attrs, 'rowspan'),
        };
      } else if (name === 'thead' && current !== undefined) {
        current.inHead = true;
      } else if (name === 'caption' && current !== undefined && !current.layout) {
        current.inCaption = true;
      }
    }

    stack.push(frame);
  };

  const close = (tag: string): void => {
    if (tag === 'html' || tag === 'body') return;
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (stack[i]?.tag === tag) {
        popTo(i);
        return;
      }
    }
  };

  for (const token of tokenizeHtml(html)) {
    if (signals.tooDeep) break;
    switch (token.type) {
      case 'text':
        addText(token.text, top());
        break;
      case 'open':
        open(token.name, token.attrs);
        break;
      case 'close':
        close(token.name);
        break;
      case 'rcdata':
        // `<title>` lives in `<head>`, which is otherwise not read. A drawing has titles of
        // its own, and they are not the page's.
        if (
          token.name === 'title' &&
          signals.title === null &&
          !stack.some((frame) => frame.tag === 'svg')
        ) {
          const title = collapse(token.text);
          if (title !== '') signals.title = title;
        }
        break;
      case 'script':
        if (/"isAccessibleForFree"\s*:\s*"?false/i.test(token.text)) signals.paywallMarked = true;
        if (
          /"@type"\s*:\s*"(?:News|Reportage|Analysis|Opinion)?(?:News)?Article"/.test(token.text)
        ) {
          signals.articlePage = true;
        }
        if (SCRIPT_REDIRECT.test(token.text.slice(0, 4_000))) signals.scriptRedirect = true;
        break;
    }
  }
  popTo(1);
  flush();
  return { blocks, signals, fadedLetters };
}

// ---------------------------------------------------------------------------------------
// Which of it is the page
// ---------------------------------------------------------------------------------------

function lettersOf(blocks: readonly HtmlBlock[]): number {
  return blocks.reduce((sum, block) => sum + meaningfulChars(block.text), 0);
}

/** More text than this inside something named "cookie" is a policy, not a notice. */
const CONSENT_PAGE_LETTERS = 1_500;

/** A run of short blocks that are nothing but links is a menu, whatever it is called. */
function dropMenus(blocks: readonly HtmlBlock[]): HtmlBlock[] {
  const linky = (block: HtmlBlock): boolean => {
    const size = block.text.replace(/\s/g, '').length;
    return (
      (block.kind === 'item' || block.kind === 'para') &&
      size > 0 &&
      size <= 80 &&
      block.linkChars / size >= 0.8
    );
  };
  const out: HtmlBlock[] = [];
  let run: HtmlBlock[] = [];
  const settle = (): void => {
    if (run.length < 6) out.push(...run);
    run = [];
  };
  for (const block of blocks) {
    if (linky(block)) {
      run.push(block);
    } else {
      settle();
      out.push(block);
    }
  }
  settle();
  return out;
}

/**
 * This much text behind `opacity:0`, with next to nothing visible, is a page waiting to fade
 * in. The number separates that from a page that is simply empty; it is not a defence. What
 * makes any text safe to read is the wrapper it reaches the model in.
 */
const REVEALED_PAGE_LETTERS = 2 * PAGE_LIMITS.minReadableLetters;

/**
 * The page as the markup shows it — or, for a page that fades its whole self in, as it will
 * look once it has. `revealed` says which.
 */
function walkPage(html: string): Walked & { readonly revealed: boolean } {
  const first = walk(html);
  if (
    first.signals.tooDeep ||
    lettersOf(first.blocks) >= PAGE_LIMITS.minReadableLetters ||
    first.fadedLetters < REVEALED_PAGE_LETTERS
  ) {
    return { ...first, revealed: false };
  }
  // Read again with the fades ignored. Everything hidden any other way — inside a faded
  // section or beside it — is still hidden to this second reading.
  return { ...walk(html, true), revealed: true };
}

/**
 * From everything visible, the part that is the page. Each narrowing is taken only if
 * plenty is left afterwards: a guess that would throw most of the page away is not taken.
 */
export function chooseBlocks(all: readonly HtmlBlock[]): HtmlBlock[] {
  const total = lettersOf(all);
  const enough = (kept: readonly HtmlBlock[], share: number): boolean => {
    const letters = lettersOf(kept);
    return letters >= PAGE_LIMITS.minReadableLetters && letters >= total * share;
  };

  const beyondNotice = all.filter((block) => !block.consent);
  const noticeLetters = total - lettersOf(beyondNotice);
  let chosen =
    lettersOf(beyondNotice) >= PAGE_LIMITS.minReadableLetters ||
    noticeLetters < CONSENT_PAGE_LETTERS
      ? beyondNotice
      : [...all];

  const withoutChrome = chosen.filter((block) => !block.chrome);
  if (enough(withoutChrome, 0.4)) chosen = withoutChrome;

  // `<main>` is trusted only when most of the page is in it: one lender's `<main>` holds
  // 808 of its 35,103 characters, with the rates outside it.
  const inMain = chosen.filter((block) => block.main);
  if (enough(inMain, 0.6)) chosen = inMain;
  else {
    const inArticle = chosen.filter((block) => block.article);
    if (enough(inArticle, 0.6)) chosen = inArticle;
  }

  const withoutMenus = dropMenus(chosen);
  if (enough(withoutMenus, 0.4)) chosen = withoutMenus;

  // The same paragraph twice is a page drawn once for a phone and once for a desk.
  const seen = new Set<string>();
  return chosen.filter((block) => {
    if (block.text.length < 120) return true;
    if (seen.has(block.text)) return false;
    seen.add(block.text);
    return true;
  });
}

// ---------------------------------------------------------------------------------------
// Blocks → parts
// ---------------------------------------------------------------------------------------

export interface HtmlPart {
  readonly label: string;
  readonly text: string;
}

/** A part is cut at a heading once it is about this long… */
const PART_TARGET_CHARS = 6_000;
/** …and wherever it is, before it is this long. */
const PART_HARD_CHARS = 12_000;
const LABEL_CHARS = 90;
export const TOP_OF_PAGE_LABEL = 'Top of the page';
export const TABLE_CONTINUES =
  '(this table continues from the part before; its heading rows are repeated)';

function render(block: HtmlBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(block.level, 1), 4))} ${block.text}`;
    case 'item':
      return `- ${block.text}`;
    case 'term':
      return `${block.text}:`;
    case 'para':
    case 'pre':
    case 'table':
      return block.text;
  }
}

function shortLabel(text: string): string {
  const line = collapse(text.split('\n')[0] ?? '');
  return line.length <= LABEL_CHARS ? line : `${line.slice(0, LABEL_CHARS - 1).trimEnd()}…`;
}

/** A table too long for one part, cut between rows, its heading rows at the top of each. */
function splitTable(block: HtmlBlock): string[] {
  const lines = block.text.split('\n');
  const head = lines.slice(0, block.headerLines);
  const body = lines.slice(block.headerLines);
  const headChars = head.reduce((sum, line) => sum + line.length + 1, 0);
  const pieces: string[] = [];
  let current: string[] = [];
  let chars = headChars;
  for (const line of body) {
    if (current.length > 0 && chars + line.length + 1 > PART_TARGET_CHARS) {
      pieces.push(current.join('\n'));
      current = [];
      chars = headChars;
    }
    current.push(line);
    chars += line.length + 1;
  }
  if (current.length > 0) pieces.push(current.join('\n'));
  return pieces.map((piece, index) =>
    [...(index === 0 ? [] : [TABLE_CONTINUES]), ...head, piece].join('\n'),
  );
}

export function toParts(blocks: readonly HtmlBlock[]): HtmlPart[] {
  const parts: HtmlPart[] = [];
  let lines: string[] = [];
  let chars = 0;
  let heading: string | null = null;
  let lastHeading: string | null = null;
  let previousKind: BlockKind | null = null;

  const close = (): void => {
    if (lines.length === 0) return;
    const label =
      heading ?? (lastHeading === null ? TOP_OF_PAGE_LABEL : `${lastHeading} (continued)`);
    parts.push({ label: shortLabel(label), text: lines.join('').trim() });
    lines = [];
    chars = 0;
    heading = null;
    previousKind = null;
  };
  const add = (text: string, kind: BlockKind): void => {
    // List items sit on consecutive lines; everything else is a paragraph apart.
    const gap =
      lines.length === 0 ? '' : kind === 'item' && previousKind === 'item' ? '\n' : '\n\n';
    lines.push(`${gap}${text}`);
    chars += gap.length + text.length;
    previousKind = kind;
  };

  for (const block of blocks) {
    const text = render(block);
    if (block.kind === 'heading') {
      const major = block.level <= 2;
      if ((major && chars >= 1_500) || chars >= PART_TARGET_CHARS) close();
    }
    if (block.kind === 'table' && text.length > PART_HARD_CHARS) {
      const pieces = splitTable(block);
      pieces.forEach((piece, index) => {
        if (chars > 0 && chars + piece.length > PART_HARD_CHARS) close();
        if (index > 0) close();
        add(piece, 'table');
      });
      continue;
    }
    if (chars > 0 && chars + text.length > PART_HARD_CHARS) close();
    add(text, block.kind);
    if (block.kind === 'heading') {
      heading ??= block.text;
      lastHeading = block.text;
    }
  }
  close();
  return parts;
}

// ---------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------

export interface HtmlReading {
  /** The page's own title: untrusted text, cleaned by the caller before it is shown. */
  readonly title: string | null;
  readonly parts: readonly HtmlPart[];
  /** Letters and digits in what was kept. */
  readonly letters: number;
  /** Places left for a script to fill in. */
  readonly valuesMissing: number;
  /** The page hides its whole self until its scripts run, and was read as it was sent. */
  readonly revealed: boolean;
  /** Why the page is not attached, or null when it is. */
  readonly refusal: PageRefusalCode | null;
}

const PAYWALL_WORDS =
  /\b(?:already a subscriber|subscribe to (?:read|continue|unlock|keep reading)|subscribers? (?:with [\w ]{1,30} )?can (?:view|read)|to continue reading|log ?in to (?:read|continue)|sign in to (?:read|continue)|this (?:article|content|story) is (?:for|available to) subscribers|subscriber[- ]only|unlock this article|create a free account to (?:read|continue))/i;
const CHALLENGE_WORDS =
  /\b(?:just a moment|attention required|access denied|are you a (?:human|robot)|verify (?:that )?you are (?:a )?human|unusual traffic|pardon our interruption|checking your browser|request unsuccessful|enable javascript and cookies to continue)/i;
const LOGIN_WORDS = /\b(?:log ?in|sign ?in|log ?on)\b/i;

export function readHtml(html: string): HtmlReading {
  const { signals, blocks, revealed } = walkPage(html);
  const chosen = chooseBlocks(blocks);
  const letters = lettersOf(chosen);
  const allText = blocks.map((block) => block.text).join('\n');
  const allLetters = lettersOf(blocks);
  const title = signals.title ?? blocks.find((block) => block.kind === 'heading')?.text ?? null;
  const thin = letters < PAGE_LIMITS.minReadableLetters;

  let verdict: PageRefusalCode | null = null;
  if (signals.tooDeep) {
    verdict = 'page_malformed';
  } else if (signals.paywallMarked) {
    // The page says so itself.
    verdict = 'page_paywall';
  } else if (thin && (signals.metaRefresh || (signals.scriptRedirect && allLetters < 40))) {
    verdict = 'page_forwards';
  } else if (
    signals.passwordField &&
    allLetters < 1_500 &&
    LOGIN_WORDS.test(`${title ?? ''} ${allText}`)
  ) {
    verdict = 'page_login_required';
  } else if (allLetters < 600 && CHALLENGE_WORDS.test(`${title ?? ''} ${allText}`)) {
    verdict = 'page_blocked';
  } else if (thin && lettersOf(blocks.filter((block) => block.consent)) >= 60) {
    verdict = 'page_consent_wall';
  } else if (thin) {
    verdict = 'page_no_text';
  } else if (signals.articlePage && PAYWALL_WORDS.test(allText)) {
    // An article that stops after a few lines and then asks for a subscription. One paper
    // marks such a page as free in its own metadata (probe, 12 Oct 2026), so the page's
    // word for it is not enough; the page's shape is.
    const article = blocks.filter((block) => block.article);
    const body = lettersOf(article.length > 0 ? article : chosen);
    if (body < 3_000) verdict = 'page_paywall';
  }

  const parts = verdict === null ? toParts(chosen) : [];
  const first = parts[0];
  if (revealed && first !== undefined) {
    // Said in the text itself, so it is stored with the page and found there by the database.
    parts[0] = { label: first.label, text: `${READ_AS_SENT_MARK}\n${first.text}` };
  }

  return {
    title,
    parts,
    letters,
    valuesMissing: chosen.reduce(
      (sum, block) => sum + (block.text.split(NOT_LOADED_MARK).length - 1),
      0,
    ),
    revealed: verdict === null && revealed,
    refusal: verdict,
  };
}

export const REVEALED_PAGE_NOTE =
  'This page shows its content only after its scripts run. It was read as the site sent it, so check anything important against the page itself.';

/** What the person is told when figures on the page were left for a script to fill in. */
export function missingValuesNote(count: number): string {
  return `${count === 1 ? '1 figure on this page is' : `${String(count)} figures on this page are`} filled in by the site after it loads and could not be read. To get them, save the page as a PDF and attach it.`;
}

export const htmlExtractor: FileExtractor = {
  kind: 'html',
  extract: (input: ExtractInput): Promise<Extraction> => {
    const reading = readHtml(decodeHtmlBytes(input.bytes, input.contentType ?? null));
    if (reading.refusal !== null) {
      return Promise.resolve(refused('html', refusal(reading.refusal)));
    }
    return Promise.resolve({
      ok: true,
      kind: 'html',
      totalPages: reading.parts.length,
      pages: reading.parts.map((part, index) => ({
        pageNo: index + 1,
        label: part.label,
        text: part.text,
        method: 'html_text',
      })),
      vision: [],
      notes: [
        ...(reading.valuesMissing > 0 ? [missingValuesNote(reading.valuesMissing)] : []),
        ...(reading.revealed ? [REVEALED_PAGE_NOTE] : []),
      ],
      dispose: noop,
      title: reading.title,
    });
  },
};
