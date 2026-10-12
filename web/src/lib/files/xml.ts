/**
 * A small XML tokenizer for the parts of a .docx / .xlsx this app reads (Milestone 5 part 1).
 *
 * Deliberately not a general XML parser. It walks tags and text in document order, strips
 * namespace prefixes, decodes the five predefined entities and numeric references — and that
 * is all. It reads no DTD and resolves no entity it was not born knowing, so an external
 * entity (XXE) or a "billion laughs" definition in a hostile file is inert text, not an
 * instruction to fetch or expand anything. Scanning is by index, never by a regex over the
 * whole document, so a malformed file costs time proportional to its length and no more.
 */

export type XmlToken =
  | {
      readonly type: 'open';
      /** Local name: `w:p` and `p` are both `p`. */
      readonly name: string;
      readonly attrs: Readonly<Record<string, string>>;
      readonly selfClosing: boolean;
    }
  | { readonly type: 'close'; readonly name: string }
  | { readonly type: 'text'; readonly text: string };

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,5});/g,
    (whole, body: string) => {
      if (body.startsWith('#')) {
        const code = body.startsWith('#x')
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return '';
        // Surrogates are not characters; String.fromCodePoint would hand back half of one.
        if (code >= 0xd800 && code <= 0xdfff) return '';
        return String.fromCodePoint(code);
      }
      return Object.hasOwn(NAMED, body) ? (NAMED[body] ?? whole) : whole;
    },
  );
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  for (;;) {
    const match = ATTRIBUTE.exec(source);
    if (match === null) break;
    const key = match[1];
    if (key === undefined) continue;
    attrs[localName(key)] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/** The index of the `>` that ends the tag starting at `from`, skipping quoted values. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let i = from; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

export function* xmlTokens(xml: string): Generator<XmlToken, void, undefined> {
  let at = 0;
  const length = xml.length;
  while (at < length) {
    const lt = xml.indexOf('<', at);
    if (lt === -1) {
      const rest = xml.slice(at);
      if (rest !== '') yield { type: 'text', text: decodeEntities(rest) };
      return;
    }
    if (lt > at) yield { type: 'text', text: decodeEntities(xml.slice(at, lt)) };

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return;
      at = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) return;
      yield { type: 'text', text: xml.slice(lt + 9, end) };
      at = end + 3;
      continue;
    }
    if (xml.startsWith('<!DOCTYPE', lt) || xml.startsWith('<!doctype', lt)) {
      // An internal subset ("[ ... ]") is where entities are declared. It is skipped whole:
      // nothing declared in it is ever expanded, and none of it is text.
      const close = xml.indexOf('>', lt);
      const subset = xml.indexOf('[', lt);
      const end = subset !== -1 && subset < close ? xml.indexOf(']>', subset) : close;
      if (end === -1) return;
      at = end + (subset !== -1 && subset < close ? 2 : 1);
      continue;
    }
    const end = tagEnd(xml, lt + 1);
    if (end === -1) return;
    const body = xml.slice(lt + 1, end);
    at = end + 1;
    // Declarations, processing instructions and DOCTYPEs are skipped whole: nothing in them
    // is ever acted on.
    if (body.startsWith('?') || body.startsWith('!')) continue;
    if (body.startsWith('/')) {
      yield { type: 'close', name: localName(body.slice(1).trim()) };
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const space = inner.search(/\s/);
    const name = localName(space === -1 ? inner : inner.slice(0, space));
    const attrs = space === -1 ? {} : parseAttributes(inner.slice(space + 1));
    yield { type: 'open', name, attrs, selfClosing };
  }
}
