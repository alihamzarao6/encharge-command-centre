/**
 * The SSRF guard (Milestone 5 part 2, D97). Pure: no network, no clock.
 *
 * The person controls the address and the fetch runs inside our infrastructure, so an address
 * is treated as hostile until this file says otherwise. Two questions, asked separately
 * because they fail in different ways:
 *
 *  1. `parsePublicUrl` — is this an address we would ever open? https only, the default port
 *     only, no credentials, a site NAME (never a number), and not a name that only means
 *     something inside a network.
 *  2. `checkResolvedAddresses` — where does that name actually point? Every address it
 *     resolves to, IPv4 and IPv6, must be a public one. A public-looking name that resolves
 *     to 127.0.0.1 is the commonest way round the first question.
 *
 * Both are asked again on EVERY redirect hop (fetch.ts), because a public page that redirects
 * to a private address is the second commonest.
 *
 * The address judged is the one the URL parser produced, never the string that was typed:
 * `http://2130706433/`, `http://0x7f.1/` and `http://017700000001/` are all 127.0.0.1 by the
 * time anything connects (confirmed on the Edge runtime, 12 Oct 2026), and a check on the
 * text would pass every one of them.
 *
 * What this does NOT do is pin the connection to the address it checked: the runtime's fetch
 * resolves the name again. A name that answers differently the second time is not prevented;
 * it is made useless, because the fetch is https with the certificate verified against the
 * name — a service inside a network would have to present a valid certificate for the
 * attacker's own domain to be read (SECURITY.md §10).
 */
import { PAGE_LIMITS, type PageRefusalCode } from './limits.js';

export type LinkRefusal = Extract<
  PageRefusalCode,
  | 'link_invalid'
  | 'link_not_https'
  | 'link_has_login'
  | 'link_port'
  | 'link_numeric'
  | 'link_private'
>;

/** An address that passed the first question. */
export interface PublicUrl {
  /** What is requested: https, no credentials, no fragment. */
  readonly href: string;
  /** Lower case, ASCII (an international name is in its `xn--` form), no trailing dot. */
  readonly host: string;
  readonly origin: string;
  /** Path and query, as robots.txt rules are matched against. Always starts with `/`. */
  readonly pathAndQuery: string;
  readonly hasQuery: boolean;
}

export type UrlVerdict =
  | { readonly ok: true; readonly url: PublicUrl }
  | { readonly ok: false; readonly refusal: LinkRefusal };

function refuse(refusal: LinkRefusal): UrlVerdict {
  return { ok: false, refusal };
}

/**
 * Names that only resolve inside a network, or are reserved for not resolving at all. The
 * last label, or the last two for `home.arpa`. A single-label name is refused before this.
 */
const INTERNAL_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'test',
  'invalid',
  'example',
  'onion',
  'arpa',
];

// One label: letters, digits and inner hyphens. An international label arrives as `xn--…`.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// Tab, newline and friends are silently DROPPED by the URL parser, which makes them a way to
// write one address and have another parsed. A backslash is read as a slash. Neither belongs
// in an address anyone pastes.
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const FORBIDDEN = /[\u{0}-\u{20}\u{7F}\\]/u;

/**
 * Is this an address we would ever open? Never throws.
 */
export function parsePublicUrl(raw: unknown): UrlVerdict {
  if (typeof raw !== 'string') return refuse('link_invalid');
  const text = raw.trim();
  if (text === '' || text.length > PAGE_LIMITS.maxUrlChars) return refuse('link_invalid');
  if (FORBIDDEN.test(text)) return refuse('link_invalid');

  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === 'http') return refuse('link_not_https');
  // file:, ftp:, data:, javascript:, gopher:, and no scheme at all.
  if (scheme !== 'https') return refuse('link_invalid');
  // `https:example.com` and `https:/example.com` parse as if the slashes were there. An
  // address is written with them.
  if (!/^https:\/\//i.test(text)) return refuse('link_invalid');

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return refuse('link_invalid');
  }
  if (parsed.protocol !== 'https:') return refuse('link_invalid');
  if (parsed.username !== '' || parsed.password !== '') return refuse('link_has_login');
  // The parser has already dropped an explicit ":443".
  if (parsed.port !== '') return refuse('link_port');

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (host === '') return refuse('link_invalid');
  // An IPv6 literal keeps its brackets; any form of IPv4 has been normalised to four numbers.
  if (host.startsWith('[') || classifyAddress(host) !== 'not_an_address') {
    return refuse('link_numeric');
  }
  if (host.length > 253) return refuse('link_invalid');
  const labels = host.split('.');
  if (labels.some((label) => !LABEL.test(label))) return refuse('link_invalid');
  if (labels.length < 2) return refuse('link_private');
  const last = labels[labels.length - 1] ?? '';
  // A top-level name is never all digits; the parser would have read one as IPv4 or failed.
  if (/^\d+$/.test(last)) return refuse('link_numeric');
  if (INTERNAL_SUFFIXES.includes(last)) return refuse('link_private');

  const pathAndQuery = `${parsed.pathname === '' ? '/' : parsed.pathname}${parsed.search}`;
  const origin = `https://${host}`;
  const href = `${origin}${pathAndQuery}`;
  if (href.length > PAGE_LIMITS.maxUrlChars) return refuse('link_invalid');
  return {
    ok: true,
    url: { href, host, origin, pathAndQuery, hasQuery: parsed.search.length > 1 },
  };
}

// ---------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------

export type AddressClass =
  /** Routable on the public internet: the only class that is fetched. */
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'shared'
  | 'multicast'
  | 'documentation'
  | 'reserved'
  /** Looks like an address and is not a valid one. Never fetched. */
  | 'malformed'
  /** Not an address at all: a name. */
  | 'not_an_address';

function parseIpv4(text: string): readonly [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0, out[3] ?? 0];
}

function classifyIpv4(a: number, b: number, c: number): AddressClass {
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a === 127) return 'loopback';
  // Includes 169.254.169.254, the cloud metadata address.
  if (a === 169 && b === 254) return 'link_local';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'documentation';
  if (a === 192 && b === 88 && c === 99) return 'reserved';
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'documentation';
  if (a === 203 && b === 0 && c === 113) return 'documentation';
  if (a >= 224 && a <= 239) return 'multicast';
  // 240.0.0.0/4, which includes the broadcast address.
  if (a >= 240) return 'reserved';
  return 'public';
}

/** Eight 16-bit groups, or null. Accepts `::`, an IPv4 tail, upper case and brackets. */
function parseIpv6(input: string): readonly number[] | null {
  let text = input;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // A zone (`fe80::1%eth0`) names an interface on this machine: never a public address.
  if (text === '' || text.includes('%') || !text.includes(':')) return null;
  if (!/^[0-9a-f:.]+$/i.test(text)) return null;

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const expand = (half: string): number[] | null => {
    if (half === '') return [];
    const groups: number[] = [];
    const pieces = half.split(':');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] ?? '';
      if (piece.includes('.')) {
        // Dotted IPv4 is only valid as the last piece.
        if (i !== pieces.length - 1) return null;
        const v4 = parseIpv4(piece);
        if (v4 === null) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
        groups.push(Number.parseInt(piece, 16));
      }
    }
    return groups;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  // `::` stands for at least one group.
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function embeddedIpv4(high: number, low: number): AddressClass {
  return classifyIpv4(high >> 8, high & 0xff, low >> 8);
}

function classifyIpv6(groups: readonly number[]): AddressClass {
  const g = (index: number): number => groups[index] ?? 0;
  const firstSixZero = [0, 1, 2, 3, 4, 5].every((index) => g(index) === 0);

  if (groups.every((group) => group === 0)) return 'unspecified';
  if (firstSixZero && g(6) === 0 && g(7) === 1) return 'loopback';
  // ::ffff:a.b.c.d — an IPv4 address in IPv6 clothing: judged as the IPv4 address it is.
  if ([0, 1, 2, 3, 4].every((index) => g(index) === 0) && g(5) === 0xffff) {
    return embeddedIpv4(g(6), g(7));
  }
  // 64:ff9b::/96 — NAT64. A resolver on an IPv6-only network synthesises these for IPv4-only
  // sites, so the embedded address decides. 64:ff9b:1::/48 is the local-use variant.
  if (g(0) === 0x64 && g(1) === 0xff9b) {
    if ([2, 3, 4, 5].every((index) => g(index) === 0)) return embeddedIpv4(g(6), g(7));
    return 'reserved';
  }
  // ::a.b.c.d (deprecated "IPv4-compatible") and the rest of 0000::/8 route nowhere public.
  if (g(0) >> 8 === 0) return 'reserved';
  if (g(0) === 0x100 && g(1) === 0 && g(2) === 0 && g(3) === 0) return 'reserved';
  // 2001::/23 is protocol assignments: Teredo (which tunnels to an IPv4 address chosen by
  // whoever wrote the address), benchmarking, ORCHID. Nothing a website lives on.
  if (g(0) === 0x2001 && g(1) < 0x200) return 'reserved';
  if (g(0) === 0x2001 && g(1) === 0xdb8) return 'documentation';
  // 2002::/16 — 6to4, another IPv4 address in disguise.
  if (g(0) === 0x2002) return 'reserved';
  // 3fff::/20, the second documentation range.
  if (g(0) === 0x3fff && g(1) >> 12 === 0) return 'documentation';
  if ((g(0) & 0xfe00) === 0xfc00) return 'private';
  if ((g(0) & 0xffc0) === 0xfe80) return 'link_local';
  if ((g(0) & 0xffc0) === 0xfec0) return 'private';
  if (g(0) >> 8 === 0xff) return 'multicast';
  // Global unicast is 2000::/3. Everything else is unallocated.
  if ((g(0) & 0xe000) !== 0x2000) return 'reserved';
  return 'public';
}

/**
 * What kind of address this text is. Only `public` is ever fetched; a name is
 * `not_an_address`; anything that looks like an address and cannot be read as one is
 * `malformed` and treated as hostile.
 */
export function classifyAddress(text: string): AddressClass {
  const value = text.trim().toLowerCase();
  if (value.includes(':')) {
    const groups = parseIpv6(value);
    return groups === null ? 'malformed' : classifyIpv6(groups);
  }
  if (/^[\d.]+$/.test(value)) {
    const v4 = parseIpv4(value);
    return v4 === null ? 'malformed' : classifyIpv4(v4[0], v4[1], v4[2]);
  }
  return 'not_an_address';
}

export function isPublicAddress(text: string): boolean {
  return classifyAddress(text) === 'public';
}

export type AddressVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: Extract<PageRefusalCode, 'link_private' | 'site_not_found'>;
      /** The class of the first address that failed — for the log, never the address itself. */
      readonly found: AddressClass | 'none';
    };

/**
 * Where a name actually points. EVERY address must be public: a name with one public and one
 * private address is a name that sometimes connects inside the network.
 */
export function checkResolvedAddresses(addresses: readonly string[]): AddressVerdict {
  if (addresses.length === 0) return { ok: false, refusal: 'site_not_found', found: 'none' };
  for (const address of addresses) {
    const found = classifyAddress(address);
    if (found !== 'public') return { ok: false, refusal: 'link_private', found };
  }
  return { ok: true };
}

/** The two questions, as one object, so a test can swap the guard out and watch what gets through. */
export interface PageGuard {
  readonly parse: (raw: unknown) => UrlVerdict;
  readonly addresses: (addresses: readonly string[]) => AddressVerdict;
}

export const PAGE_GUARD: PageGuard = {
  parse: parsePublicUrl,
  addresses: checkResolvedAddresses,
};
