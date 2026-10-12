/**
 * The SSRF guard (Milestone 5 part 2, Part C "SSRF and the network"). Every address form the
 * brief lists is here by name. These are the pure half; the half that proves the guard runs
 * again on every redirect hop — and that the same addresses reach the network when the guard
 * is taken out — is tests/unit/pages/fetch.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  PAGE_GUARD,
  checkResolvedAddresses,
  classifyAddress,
  isPublicAddress,
  parsePublicUrl,
  type AddressClass,
  type LinkRefusal,
} from '../../../src/lib/pages/guard.js';
import { PAGE_LIMITS } from '../../../src/lib/pages/limits.js';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

function refusalOf(raw: unknown): LinkRefusal | 'ACCEPTED' {
  const verdict = parsePublicUrl(raw);
  return verdict.ok ? 'ACCEPTED' : verdict.refusal;
}

describe('parsePublicUrl — an address a person would paste', () => {
  it('accepts an ordinary https page and reports what will be fetched', () => {
    const verdict = parsePublicUrl(
      '  https://www.Westpac.com.au/personal-banking/home-loans/all-interest-rates/?a=1#fixed  ',
    );
    expect(verdict).toEqual({
      ok: true,
      url: {
        href: 'https://www.westpac.com.au/personal-banking/home-loans/all-interest-rates/?a=1',
        host: 'www.westpac.com.au',
        origin: 'https://www.westpac.com.au',
        pathAndQuery: '/personal-banking/home-loans/all-interest-rates/?a=1',
        hasQuery: true,
      },
    });
  });

  it('gives a bare site a path, drops the fragment, and says when there is no query', () => {
    const verdict = parsePublicUrl('https://rba.gov.au#top');
    expect(verdict.ok && verdict.url).toEqual({
      href: 'https://rba.gov.au/',
      host: 'rba.gov.au',
      origin: 'https://rba.gov.au',
      pathAndQuery: '/',
      hasQuery: false,
    });
    const bare = parsePublicUrl('https://rba.gov.au/statistics/cash-rate/?');
    expect(bare.ok && bare.url.hasQuery).toBe(false);
  });

  it('treats an explicit :443 as the default port it is', () => {
    const verdict = parsePublicUrl('https://www.nab.com.au:443/personal');
    expect(verdict.ok && verdict.url.href).toBe('https://www.nab.com.au/personal');
  });

  it('reads an international name in its ASCII form', () => {
    const verdict = parsePublicUrl(`https://m${cp(0xfc)}nchen.example.org/`);
    expect(verdict.ok && verdict.url.host).toBe('xn--mnchen-3ya.example.org');
  });

  it('drops a trailing dot, so "host." cannot be a second spelling of "host"', () => {
    const verdict = parsePublicUrl('https://www.rba.gov.au./statistics/');
    expect(verdict.ok && verdict.url.host).toBe('www.rba.gov.au');
  });
});

describe('parsePublicUrl — refused, each for its own reason', () => {
  const cases: readonly (readonly [string, unknown, LinkRefusal])[] = [
    // --- a non-HTTP scheme
    ['http, not https', 'http://www.westpac.com.au/', 'link_not_https'],
    ['HTTP in capitals', 'HTTP://www.westpac.com.au/', 'link_not_https'],
    ['file://', 'file:///etc/passwd', 'link_invalid'],
    ['ftp://', 'ftp://ftp.example.com/rates.csv', 'link_invalid'],
    ['data:', 'data:text/html,<h1>hello</h1>', 'link_invalid'],
    ['javascript:', 'javascript:alert(1)', 'link_invalid'],
    ['gopher://', 'gopher://example.com/', 'link_invalid'],
    ['no scheme at all', 'www.westpac.com.au/home-loans', 'link_invalid'],
    ['a scheme-relative address', '//www.westpac.com.au/', 'link_invalid'],
    ['https with the slashes left out', 'https:www.westpac.com.au', 'link_invalid'],
    ['https with one slash', 'https:/www.westpac.com.au', 'link_invalid'],

    // --- embedded credentials
    ['a username and password', 'https://user:pass@www.example.com/', 'link_has_login'],
    ['a username alone', 'https://admin@www.example.com/', 'link_has_login'],
    [
      'a real site written as the username of another',
      'https://www.commbank.com.au@evil.example.com/',
      'link_has_login',
    ],

    // --- a non-standard port
    ['port 8443', 'https://www.example.com:8443/', 'link_port'],
    ['port 80 on https', 'https://www.example.com:80/', 'link_port'],
    ['port 22', 'https://www.example.com:22/', 'link_port'],

    // --- localhost, 127.0.0.1, ::1 and 0.0.0.0
    ['localhost', 'https://localhost/', 'link_private'],
    ['localhost with a trailing dot', 'https://localhost./', 'link_private'],
    ['LOCALHOST in capitals', 'https://LOCALHOST/admin', 'link_private'],
    ['a name under .localhost', 'https://app.localhost/', 'link_private'],
    ['127.0.0.1', 'https://127.0.0.1/', 'link_numeric'],
    ['127.1', 'https://127.1/', 'link_numeric'],
    ['::1', 'https://[::1]/', 'link_numeric'],
    ['0.0.0.0', 'https://0.0.0.0/', 'link_numeric'],
    ['0', 'https://0/', 'link_numeric'],

    // --- private ranges, and link-local including the cloud metadata address
    ['10.0.0.1', 'https://10.0.0.1/', 'link_numeric'],
    ['172.16.0.1', 'https://172.16.0.1/', 'link_numeric'],
    ['192.168.1.1', 'https://192.168.1.1/', 'link_numeric'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/', 'link_numeric'],
    ['an IPv6 private address', 'https://[fd00::1]/', 'link_numeric'],
    ['an IPv6 link-local address', 'https://[fe80::1]/', 'link_numeric'],
    ['an IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/', 'link_numeric'],
    // A PUBLIC number is refused too: an address is written with a site's name.
    ['a public IPv4 address', 'https://93.184.216.34/', 'link_numeric'],
    ['a public IPv6 address', 'https://[2606:2800:220:1:248:1893:25c8:1946]/', 'link_numeric'],

    // --- a decimal, octal or hex encoded IP address
    ['decimal 127.0.0.1', 'https://2130706433/', 'link_numeric'],
    ['hex 127.0.0.1', 'https://0x7f000001/', 'link_numeric'],
    ['hex, dotted', 'https://0x7f.0x0.0x0.0x1/', 'link_numeric'],
    ['hex, short form', 'https://0x7f.1/', 'link_numeric'],
    ['hex first part, decimal rest', 'https://0x7f.0.0.1/', 'link_numeric'],
    ['octal 127.0.0.1', 'https://017700000001/', 'link_numeric'],
    ['octal, dotted', 'https://0177.0.0.1/', 'link_numeric'],
    ['decimal metadata address', 'https://2852039166/', 'link_numeric'],
    ['percent-encoded 127.0.0.1', 'https://%31%32%37%2e%30%2e%30%2e%31/', 'link_numeric'],

    // --- names that only mean something inside a network
    ['a single-label name', 'https://intranet/', 'link_private'],
    ['percent-encoded localhost', 'https://%6c%6f%63%61%6c%68%6f%73%74/', 'link_private'],
    ['.local', 'https://printer.local/', 'link_private'],
    ['.internal', 'https://metadata.google.internal/', 'link_private'],
    ['.lan', 'https://nas.lan/', 'link_private'],
    ['.home.arpa', 'https://router.home.arpa/', 'link_private'],
    ['a cluster service name', 'https://kubernetes.default.svc.cluster.local/', 'link_private'],
    ['.onion', 'https://example.onion/', 'link_private'],
    ['.test', 'https://something.test/', 'link_private'],

    // --- not an address
    ['nothing', '', 'link_invalid'],
    ['only spaces', '   ', 'link_invalid'],
    ['a number', 42, 'link_invalid'],
    ['null', null, 'link_invalid'],
    ['a sentence', 'the westpac rates page', 'link_invalid'],
    ['a name with an underscore', 'https://bad_name.example.com/', 'link_invalid'],
    // The parser collapses the slashes and takes "path" as the host: a single-label name.
    ['three slashes and no host', 'https:///path', 'link_private'],
    ['a label that starts with a hyphen', 'https://-bad.example.com/', 'link_invalid'],
  ];

  it.each(cases)('%s', (_label, raw, expected) => {
    expect(refusalOf(raw)).toBe(expected);
  });

  it('refuses whitespace and control characters INSIDE an address, which the parser would drop', () => {
    // `https://exam<TAB>ple.com` parses as example.com: one address written, another fetched.
    expect(refusalOf(`https://www.exam${cp(9)}ple.com/`)).toBe('link_invalid');
    expect(refusalOf(`https://www.example.com/${cp(10)}path`)).toBe('link_invalid');
    expect(refusalOf(`https://www.example.com/a${cp(13)}b`)).toBe('link_invalid');
    expect(refusalOf(`https://www.example.com/a${cp(0)}b`)).toBe('link_invalid');
    // A newline picked up at the END of a paste is not inside the address: it is trimmed.
    expect(refusalOf(`https://www.example.com/page${cp(13, 10)}`)).toBe('ACCEPTED');
    expect(refusalOf('https://www.example.com/a b')).toBe('link_invalid');
    expect(refusalOf(`https://www.example.com/${cp(0x7f)}`)).toBe('link_invalid');
  });

  it('refuses a backslash, which the parser reads as a slash', () => {
    expect(refusalOf('https://www.example.com\\@evil.example.org/')).toBe('link_invalid');
    expect(refusalOf('https:\\\\www.example.com/')).toBe('link_invalid');
  });

  it('refuses an address longer than the limit, however it is spelt', () => {
    const long = `https://www.example.com/${'a'.repeat(PAGE_LIMITS.maxUrlChars)}`;
    expect(refusalOf(long)).toBe('link_invalid');
    const justUnder = `https://www.example.com/${'a'.repeat(PAGE_LIMITS.maxUrlChars - 30)}`;
    expect(refusalOf(justUnder)).toBe('ACCEPTED');
  });

  it('never throws, whatever it is handed', () => {
    for (const value of [
      undefined,
      {},
      [],
      Symbol('x'),
      1n,
      () => 'https://a.b',
      'https://[',
      '%',
    ]) {
      expect(() => parsePublicUrl(value)).not.toThrow();
      expect(parsePublicUrl(value).ok).toBe(false);
    }
  });
});

describe('classifyAddress — where a name actually points', () => {
  const v4: readonly (readonly [string, AddressClass])[] = [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.254', 'shared'],
    ['100.63.255.255', 'public'],
    ['100.128.0.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link_local'],
    ['169.254.169.254', 'link_local'],
    ['172.15.255.255', 'public'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', 'reserved'],
    ['192.167.255.255', 'public'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['198.20.0.1', 'public'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.7', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['1.1.1.1', 'public'],
    ['8.8.8.8', 'public'],
    ['203.2.218.214', 'public'],
  ];
  it.each(v4)('IPv4 %s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
    expect(isPublicAddress(address)).toBe(expected === 'public');
  });

  const v6: readonly (readonly [string, AddressClass])[] = [
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'link_local'],
    ['::ffff:192.168.1.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['::127.0.0.1', 'reserved'],
    ['::8.8.8.8', 'reserved'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    // The cloud metadata address, reached through a NAT64 gateway.
    ['64:ff9b::a9fe:a9fe', 'link_local'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'reserved'],
    ['100::1', 'reserved'],
    ['2001::1', 'reserved'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::1', 'reserved'],
    ['2002:c0a8:101::1', 'reserved'],
    ['3fff:0:1::1', 'documentation'],
    ['fc00::1', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['fe80::1', 'link_local'],
    ['febf::1', 'link_local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['4000::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'],
    ['2404:6800:4006:80a::200e', 'public'],
    ['[2404:6800:4006:80a::200e]', 'public'],
    ['2404:6800:4006:080A:0000:0000:0000:200E', 'public'],
  ];
  it.each(v6)('IPv6 %s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '1..2.3',
    '1.2.3.',
    '.1.2.3',
    '1:2:3',
    '1::2::3',
    '12345::1',
    '::g',
    'fe80::1%eth0',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7::8',
    '::1.2.3',
    '::1.2.3.4:5',
    '::ffff:256.0.0.1',
  ])('"%s" looks like an address, is not one, and is never public', (address) => {
    expect(classifyAddress(address)).toBe('malformed');
    expect(isPublicAddress(address)).toBe(false);
  });

  it('a name is not an address', () => {
    expect(classifyAddress('www.westpac.com.au')).toBe('not_an_address');
    expect(classifyAddress('localhost')).toBe('not_an_address');
    expect(isPublicAddress('www.westpac.com.au')).toBe(false);
  });
});

describe('checkResolvedAddresses — a hostname that resolves to any of the above', () => {
  it('passes a name whose every address is public', () => {
    expect(checkResolvedAddresses(['203.2.218.214', '2404:6800:4006:80a::200e'])).toEqual({
      ok: true,
    });
  });

  it.each([
    [['127.0.0.1'], 'loopback'],
    [['10.1.2.3'], 'private'],
    [['172.20.0.5'], 'private'],
    [['192.168.0.10'], 'private'],
    [['169.254.169.254'], 'link_local'],
    [['0.0.0.0'], 'unspecified'],
    [['::1'], 'loopback'],
    [['fd00::5'], 'private'],
    [['fe80::1'], 'link_local'],
    [['::ffff:10.0.0.1'], 'private'],
    [['not-an-ip'], 'not_an_address'],
    [['999.1.1.1'], 'malformed'],
  ] as const)('refuses %j', (addresses, found) => {
    expect(checkResolvedAddresses(addresses)).toEqual({
      ok: false,
      refusal: 'link_private',
      found,
    });
  });

  it('refuses a name with one public and one private address — it would sometimes connect inside', () => {
    expect(checkResolvedAddresses(['203.2.218.214', '10.0.0.5'])).toMatchObject({
      ok: false,
      refusal: 'link_private',
    });
    // The private one hiding in the IPv6 answers only.
    expect(checkResolvedAddresses(['203.2.218.214', 'fd00::1'])).toMatchObject({
      ok: false,
      refusal: 'link_private',
    });
  });

  it('a name that resolves to nothing is a site that was not found, not a private one', () => {
    expect(checkResolvedAddresses([])).toEqual({
      ok: false,
      refusal: 'site_not_found',
      found: 'none',
    });
  });

  it('the guard object is these two functions and nothing else', () => {
    expect(PAGE_GUARD.parse).toBe(parsePublicUrl);
    expect(PAGE_GUARD.addresses).toBe(checkResolvedAddresses);
  });
});
