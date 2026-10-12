/**
 * `extractFile` — the one door every file comes through — over the whole fixture set. This is
 * Part C's "the file itself" as a table: each row is a file a broker might really send and
 * what must happen to it. Nothing here is real client data (tests/fixtures/files).
 */
import { describe, expect, it } from 'vitest';

import { FILE_LIMITS, type RefusalCode } from '../../../src/lib/files/limits.js';
import { EXTRACTORS, extractFile, sha256Hex } from '../../../web/src/lib/files/extract.js';
import type { ExtractEngines, Extraction } from '../../../web/src/lib/files/types.js';
import {
  FAKE_IMAGE,
  accepted,
  allText,
  fakeImages,
  fixtureBytes,
  nodeEngines,
} from './filesHelpers.js';

function extract(name: string, engines: ExtractEngines = nodeEngines()): Promise<Extraction> {
  return extractFile({ name, bytes: fixtureBytes(name) }, engines);
}

describe('every accepted format is read', () => {
  const cases: readonly [file: string, kind: string, method: string | null, contains: string][] = [
    ['payslip-text-layer.pdf', 'pdf', 'pdf_text_layer', 'Net pay\t(blank)\t(blank)\t2,887.38'],
    ['rate-sheet-tables.pdf', 'pdf', 'pdf_text_layer', 'Home loan A0\t60-70%\t5.84\t6.01\t$0'],
    ['letter.docx', 'docx', 'docx_xml', 'Establishment fee | $600 | once'],
    ['statement.xlsx', 'xlsx', 'xlsx_xml', '4\tDate\tDescription\tAmount\tBalance'],
    ['macro-enabled.xlsm', 'xlsx', 'xlsx_xml', '4\tDate\tDescription\tAmount\tBalance'],
    [
      'transactions.csv',
      'csv',
      'csv_parse',
      '3\t2026-09-03\tSalary Sample Person\t3699.38\t6449.38',
    ],
    ['transactions-semicolon-bom.csv', 'csv', 'csv_parse', 'Miete; September'],
    ['rates.tsv', 'csv', 'csv_parse', '2\tBasic variable\t6.14%\t0'],
    ['notes.txt', 'text', 'plain_text', 'Wants to refinance before December.'],
    ['notes-utf16.txt', 'text', 'plain_text', 'עברית: הערה חשובה'],
  ];

  it.each(cases)('%s → %s', async (file, kind, method, contains) => {
    const result = accepted(await extract(file));
    expect(result.kind).toBe(kind);
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.every((page) => page.method === method)).toBe(true);
    expect(allText(result)).toContain(contains);
    // Storage positions are 1..N with no gaps, whatever the labels say.
    expect(result.pages.map((page) => page.pageNo)).toEqual(
      result.pages.map((_, index) => index + 1),
    );
    expect(result.totalPages).toBe(result.pages.length + result.vision.length);
    result.dispose();
  });

  it('there is exactly one extractor per kind', () => {
    for (const [kind, extractor] of Object.entries(EXTRACTORS)) expect(extractor.kind).toBe(kind);
  });
});

describe('photos and scans become pages to look at', () => {
  it.each([
    'photo-payslip-phone.jpg',
    'photo-payslip-clean.png',
    'photo-house.jpg',
    'photo-injection.jpg',
  ])('%s is one vision page, decoded before anyone is asked anything', async (file) => {
    const images = fakeImages();
    const result = accepted(await extract(file, nodeEngines(images)));
    expect(result.kind).toBe('image');
    expect(result.pages).toEqual([]);
    expect(result.vision.map((page) => [page.pageNo, page.label])).toEqual([[1, 'Photo']]);
    expect(images.decoded).toHaveLength(1);
    expect(await result.vision[0]?.image()).toEqual(FAKE_IMAGE);
    result.dispose();
  });

  it('a scanned PDF and a mixed one keep document order across text and vision pages', async () => {
    const mixed = accepted(await extract('mixed-text-and-scan.pdf'));
    expect(mixed.pages.map((page) => page.pageNo)).toEqual([1]);
    expect(mixed.vision.map((page) => page.pageNo)).toEqual([2]);
    expect(mixed.totalPages).toBe(2);
    const scan = accepted(await extract('scanned-statement.pdf'));
    expect(scan.vision.map((page) => page.pageNo)).toEqual([1, 2, 3]);
    mixed.dispose();
    scan.dispose();
  });

  it('a HEIC photo on a device that cannot open it is refused with the way out', async () => {
    const result = await extract('photo.heic');
    expect(result).toMatchObject({
      ok: false,
      kind: 'image',
      refusal: { code: 'heic_unsupported' },
    });
    expect(!result.ok && result.refusal.message).toContain('save it as a JPEG');
  });

  it('the same HEIC on a device that can open it is read', async () => {
    const images = fakeImages();
    images.undecodable.clear();
    expect((await extract('photo.heic', nodeEngines(images))).ok).toBe(true);
    expect(images.decoded).toEqual(['image/heic']);
  });

  it('a picture that will not decode is refused', async () => {
    const images = fakeImages();
    images.undecodable.add('image/jpeg');
    const result = await extract('photo-house.jpg', nodeEngines(images));
    expect(result).toMatchObject({ ok: false, refusal: { code: 'image_undecodable' } });
  });
});

describe('what is refused, and why', () => {
  const cases: readonly [file: string, code: RefusalCode][] = [
    ['empty.pdf', 'empty'],
    ['password-protected.pdf', 'password_pdf'],
    ['truncated.pdf', 'corrupt'],
    ['legacy.xls', 'legacy_office'],
    ['deck.pptx', 'presentation'],
    ['archive.zip', 'archive'],
    ['nested-archive.zip', 'archive'],
    ['expands-too-far.xlsx', 'expands_too_far'],
    ['page.html', 'active_content'],
    ['drawing.svg', 'active_content'],
    ['program.pdf', 'executable'],
    ['random.bin', 'unsupported'],
  ];

  it.each(cases)('%s → %s', async (file, code) => {
    const result = await extract(file);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal.code).toBe(code);
    // A refusal is a sentence for a person, and never quotes the file.
    expect(!result.ok && result.refusal.message.length).toBeGreaterThan(25);
  });
});

describe('a file whose extension lies', () => {
  it('a JPEG named .pdf is read as a picture and the person is told', async () => {
    const result = accepted(await extract('lies-about-extension.pdf'));
    expect(result.kind).toBe('image');
    expect(result.notes).toEqual([
      'This file is named .pdf but is really a picture, so it was read as a picture.',
    ]);
  });

  it('a PDF named .csv is read as a PDF', async () => {
    const result = accepted(
      await extractFile(
        { name: 'export.csv', bytes: fixtureBytes('payslip-text-layer.pdf') },
        nodeEngines(),
      ),
    );
    expect(result.kind).toBe('pdf');
    expect(allText(result)).toContain('Net pay');
  });

  it('a program named .pdf is refused as a program, not opened as a PDF', async () => {
    const result = await extract('program.pdf');
    expect(!result.ok && result.refusal.code).toBe('executable');
  });
});

describe('size', () => {
  const jpegOf = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    return bytes;
  };

  it('a file at exactly the limit is accepted', async () => {
    const result = await extractFile(
      { name: 'big.jpg', bytes: jpegOf(FILE_LIMITS.maxFileBytes) },
      nodeEngines(),
    );
    expect(result.ok).toBe(true);
  });

  it('a file one byte over is refused, and the sentence gives the size and the limit', async () => {
    const images = fakeImages();
    const result = await extractFile(
      { name: 'big.jpg', bytes: jpegOf(FILE_LIMITS.maxFileBytes + 1) },
      nodeEngines(images),
    );
    expect(result).toMatchObject({ ok: false, kind: null, refusal: { code: 'too_large' } });
    expect(!result.ok && result.refusal.message).toBe(
      'This file is 20.0 MB, which is over the 20 MB limit.',
    );
    // Refused on size alone: nothing was sniffed or decoded.
    expect(images.decoded).toEqual([]);
  });

  it('a zero-byte file is refused before anything else looks at it', async () => {
    const result = await extractFile(
      { name: 'nothing.pdf', bytes: new Uint8Array(0) },
      nodeEngines(),
    );
    expect(result).toMatchObject({ ok: false, kind: null, refusal: { code: 'empty' } });
  });

  it('a document longer than can be kept is refused as too long', async () => {
    const line = `${'word '.repeat(19).trim()}\n`;
    const huge = new TextEncoder().encode(
      line.repeat(Math.ceil((FILE_LIMITS.maxFileChars * 1.1) / line.length)),
    );
    const result = await extractFile({ name: 'huge.txt', bytes: huge }, nodeEngines());
    expect(result).toMatchObject({ ok: false, kind: 'text', refusal: { code: 'too_long' } });
  });

  it('a page too long to store is split into labelled sections rather than cut off', async () => {
    // One "line" with no paragraph break, longer than a stored page.
    const words = 'figure '.repeat(Math.ceil((FILE_LIMITS.maxPageChars * 2.2) / 7));
    const result = accepted(
      await extractFile(
        { name: 'long.csv', bytes: new TextEncoder().encode(`a,b\n1,"${words}"\n`) },
        nodeEngines(),
      ),
    );
    expect(result.pages.every((page) => page.text.length <= FILE_LIMITS.maxPageChars)).toBe(true);
    expect(result.pages.map((page) => page.pageNo)).toEqual(
      result.pages.map((_, index) => index + 1),
    );
  });
});

describe('text that carries something it should not', () => {
  it('invisible characters are stripped from what leaves the device', async () => {
    const hidden = `Net pay 2,887${String.fromCodePoint(0x200b)}.38 ${String.fromCodePoint(0x202e)}reversed${String.fromCodePoint(0xe0041)}`;
    const result = accepted(
      await extractFile(
        { name: 'note.txt', bytes: new TextEncoder().encode(hidden) },
        nodeEngines(),
      ),
    );
    expect(allText(result)).toBe('Net pay 2,887.38 reversed');
  });

  it('a name with a path, a null byte or markup never reaches a label as written', async () => {
    const name = `../../<b>pay${String.fromCodePoint(0)}slip</b>.csv`;
    const result = accepted(
      await extractFile({ name, bytes: new TextEncoder().encode('a,b\n1,2\n') }, nodeEngines()),
    );
    expect(result.pages[0]?.label).toBe('Table "b).csv"');
    expect(result.pages[0]?.label).not.toMatch(/[<>]|\.\./);
  });

  it('an extractor that throws is a refusal, not a crash', async () => {
    const engines: ExtractEngines = {
      pdfAssets: '/pdfjs/',
      pdf: () =>
        Promise.resolve({
          getDocument: () => {
            throw new TypeError('unexpected');
          },
        }),
      images: fakeImages(),
    };
    const result = await extractFile(
      { name: 'x.pdf', bytes: fixtureBytes('payslip-text-layer.pdf') },
      engines,
    );
    expect(result).toMatchObject({ ok: false, kind: 'pdf', refusal: { code: 'corrupt' } });
  });

  it('a document with no extractable text at all is refused, not attached empty', async () => {
    const result = await extractFile(
      { name: 'spaces.txt', bytes: new TextEncoder().encode(' \n\t\n  ') },
      nodeEngines(),
    );
    expect(result).toMatchObject({ ok: false, refusal: { code: 'no_text' } });
  });
});

describe('sha256Hex', () => {
  it('is the standard digest, stable for the same bytes and different for different ones', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const a = await sha256Hex(fixtureBytes('statement.xlsx'));
    expect(a).toBe(await sha256Hex(fixtureBytes('statement.xlsx')));
    expect(a).not.toBe(await sha256Hex(fixtureBytes('macro-enabled.xlsm')));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves the bytes it was given intact', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await sha256Hex(bytes);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });
});
