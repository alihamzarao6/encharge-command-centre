/**
 * Turning the text of a web page into tags and text (Milestone 5 part 2).
 *
 * A tokenizer, not a browser. There is no DOM here, nothing is rendered, no script runs, no
 * stylesheet is applied and no address in the page is ever requested — a page is read the way
 * Part 1 reads a Word file's XML: as characters. That is what makes it safe to run on a page
 * anyone in the world may have written, and it is also why it runs unchanged under Node for
 * the tests and the command-line tool.
 *
 * It is forgiving in the way pages need: unclosed tags, unquoted attributes, stray `<`, a
 * comment that never ends. It is deliberately NOT a conforming HTML parser; the reader above
 * it (html.ts) needs to know where text is and what it is inside, not to build a tree.
 *
 * What never comes out of here as text: comments, the contents of `<script>` and `<style>`,
 * doctype and processing instructions. Attribute values come out attached to their tag, for
 * the reader to make decisions with (is this hidden? is this a navigation block?) — the reader
 * never writes one into the page's text.
 */
import { decodeEntities } from './htmlEntities.js';

export type HtmlAttributes = ReadonlyMap<string, string>;

export type HtmlToken =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'open';
      readonly name: string;
      readonly attrs: HtmlAttributes;
      readonly selfClosing: boolean;
    }
  | { readonly type: 'close'; readonly name: string }
  /** The text inside `<title>` or `<textarea>`: characters, never markup. */
  | { readonly type: 'rcdata'; readonly name: string; readonly text: string }
  /**
   * The start of a script's source. NEVER part of a page's text: the reader looks at it only
   * to recognise a page that says it is paywalled (its metadata) or that exists to send a
   * browser somewhere else. Cut to a fixed length; nothing in it is run.
   */
  | { readonly type: 'script'; readonly text: string };

/** Elements whose content is not markup and is never text a person reads. */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes']);
/** Elements whose content is characters only (references resolved, tags not parsed). */
const RCDATA = new Set(['title', 'textarea']);

const MAX_ATTRIBUTES = 128;
const MAX_ATTRIBUTE_CHARS = 8_192;
/** How much of one script is handed to the reader for recognition. */
export const MAX_SCRIPT_CHARS = 20_000;
const NO_ATTRIBUTES: HtmlAttributes = new Map();

const WHITESPACE = /\s/;
const NAME_START = /[a-zA-Z]/;

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.test(ch);
}

interface ParsedTag {
  readonly name: string;
  readonly attrs: HtmlAttributes;
  readonly selfClosing: boolean;
  /** Index just past the closing `>`, or the end of input. */
  readonly end: number;
}

/** `html[at]` is the first character of the tag name. */
function parseTag(html: string, at: number): ParsedTag {
  const length = html.length;
  let i = at;
  while (i < length) {
    const ch = html[i];
    if (isSpace(ch) || ch === '/' || ch === '>') break;
    i += 1;
  }
  const name = html.slice(at, i).toLowerCase();
  let attrs: Map<string, string> | null = null;
  let selfClosing = false;

  for (;;) {
    while (i < length && (isSpace(html[i]) || html[i] === '/')) {
      selfClosing = html[i] === '/';
      i += 1;
    }
    if (i >= length) break;
    if (html[i] === '>') {
      i += 1;
      break;
    }
    selfClosing = false;

    const nameStart = i;
    while (i < length) {
      const ch = html[i];
      if (isSpace(ch) || ch === '/' || ch === '>' || ch === '=') break;
      i += 1;
    }
    // A stray `=` with no name before it: step over it rather than loop on it.
    if (i === nameStart) {
      i += 1;
      continue;
    }
    const attrName = html.slice(nameStart, i).toLowerCase();
    while (i < length && isSpace(html[i])) i += 1;

    let value = '';
    if (html[i] === '=') {
      i += 1;
      while (i < length && isSpace(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        const stop = close === -1 ? length : close;
        value = html.slice(i + 1, Math.min(stop, i + 1 + MAX_ATTRIBUTE_CHARS));
        i = close === -1 ? length : close + 1;
      } else {
        const valueStart = i;
        while (i < length && !isSpace(html[i]) && html[i] !== '>') i += 1;
        value = html.slice(valueStart, Math.min(i, valueStart + MAX_ATTRIBUTE_CHARS));
      }
    }
    attrs ??= new Map();
    // The first occurrence wins, as in a browser; a tag with thousands of attributes is cut.
    if (attrs.size < MAX_ATTRIBUTES && !attrs.has(attrName)) {
      attrs.set(attrName, decodeEntities(value));
    }
  }
  return { name, attrs: attrs ?? NO_ATTRIBUTES, selfClosing, end: i };
}

/** The index of `</name` at or after `from`, compared without regard to case; -1 if none. */
function findClose(html: string, lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    const after = html[at + needle.length];
    if (after === undefined || after === '>' || after === '/' || isSpace(after)) return at;
    at = lower.indexOf(needle, at + needle.length);
  }
  return -1;
}

export function* tokenizeHtml(html: string): Generator<HtmlToken> {
  const length = html.length;
  // Lower-cased once, for the case-insensitive search for a closing `</script>`.
  const lower = html.toLowerCase();
  let i = 0;
  let textStart = 0;

  const flushText = function* (end: number): Generator<HtmlToken> {
    if (end > textStart) yield { type: 'text', text: decodeEntities(html.slice(textStart, end)) };
  };

  while (i < length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html[lt + 1];

    if (next === '!') {
      yield* flushText(lt);
      if (html.startsWith('<!--', lt)) {
        // `<!-->` and `<!--->` are empty comments.
        const close = html.startsWith('>', lt + 4)
          ? lt + 4
          : html.startsWith('->', lt + 4)
            ? lt + 5
            : html.indexOf('-->', lt + 4);
        // A comment that never closes swallows the rest of the page, as in a browser.
        i = close === -1 ? length : html[close] === '>' ? close + 1 : close + 3;
      } else {
        const close = html.indexOf('>', lt + 2);
        i = close === -1 ? length : close + 1;
      }
      textStart = i;
      continue;
    }

    if (next === '?') {
      yield* flushText(lt);
      const close = html.indexOf('>', lt + 2);
      i = close === -1 ? length : close + 1;
      textStart = i;
      continue;
    }

    if (next === '/') {
      const first = html[lt + 2];
      if (first !== undefined && NAME_START.test(first)) {
        yield* flushText(lt);
        const tag = parseTag(html, lt + 2);
        yield { type: 'close', name: tag.name };
        i = tag.end;
        textStart = i;
        continue;
      }
      // `</>` and `</3`: not a tag. `</ ` and the like are bogus comments.
      if (first === '>') {
        yield* flushText(lt);
        i = lt + 3;
        textStart = i;
        continue;
      }
      i = lt + 1;
      continue;
    }

    if (next !== undefined && NAME_START.test(next)) {
      yield* flushText(lt);
      const tag = parseTag(html, lt + 1);
      yield { type: 'open', name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing };
      i = tag.end;
      textStart = i;

      if (RAW_TEXT.has(tag.name) || RCDATA.has(tag.name)) {
        const close = findClose(html, lower, tag.name, i);
        const contentEnd = close === -1 ? length : close;
        if (RCDATA.has(tag.name)) {
          yield {
            type: 'rcdata',
            name: tag.name,
            text: decodeEntities(html.slice(i, contentEnd)),
          };
        } else if (tag.name === 'script' && contentEnd > i) {
          yield {
            type: 'script',
            text: html.slice(i, Math.min(contentEnd, i + MAX_SCRIPT_CHARS)),
          };
        }
        if (close === -1) {
          i = length;
        } else {
          const closing = parseTag(html, close + 2);
          i = closing.end;
        }
        yield { type: 'close', name: tag.name };
        textStart = i;
      } else if (tag.name === 'plaintext') {
        // Everything after `<plaintext>` is text and nothing ends it.
        i = length;
      }
      continue;
    }

    // A `<` that starts nothing: it is a character.
    i = lt + 1;
  }
  yield* flushText(length);
}
