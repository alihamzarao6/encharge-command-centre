/**
 * Reading a file, whatever it is (Milestone 5 part 1): size, then what the bytes are, then
 * the one extractor for that kind, then the checks every kind owes — cleaned text, page and
 * length limits, and a refusal rather than an empty attachment when nothing came out.
 *
 * Adding a format is one entry in `EXTRACTORS` and one case in `sniff.ts`. Nothing above
 * this file (the upload queue, the interface, the server) knows the difference between a
 * workbook and a photograph beyond its `kind`.
 *
 * Runs entirely in the browser. For every kind except a photo or a scanned page, the file's
 * bytes stop here: what leaves the device is the text (D84).
 */
import { FILE_LIMITS, refusal, type FileKind } from '../../../../src/lib/files/limits.js';
import { sanitiseExtractedText, sanitiseFileName } from '../../../../src/lib/files/text.js';
import { docxExtractor } from './docx.js';
import { htmlExtractor } from './html.js';
import { pdfExtractor } from './pdf.js';
import { csvExtractor, textExtractor } from './plain.js';
import { sniff, type ImageMediaType } from './sniff.js';
import { splitIntoParts } from './tabular.js';
import {
  refused,
  type ExtractEngines,
  type ExtractInput,
  type ExtractedPage,
  type Extraction,
  type FileExtractor,
  type VisionPage,
} from './types.js';
import { xlsxExtractor } from './xlsx.js';

function imageExtractor(mediaType: ImageMediaType): FileExtractor {
  return {
    kind: 'image',
    extract: async (input, engines): Promise<Extraction> => {
      // Decoded now, not later: "this browser cannot open that photo" must be known before
      // anyone is asked to agree to anything.
      const image = await engines.images.decode(input.bytes, mediaType);
      if (image === null) {
        return refused(
          'image',
          refusal(
            mediaType === 'image/heic' || mediaType === 'image/avif'
              ? 'heic_unsupported'
              : 'image_undecodable',
          ),
        );
      }
      return {
        ok: true,
        kind: 'image',
        totalPages: 1,
        pages: [],
        vision: [{ pageNo: 1, label: 'Photo', image: () => Promise.resolve(image) }],
        notes: [],
        dispose: () => undefined,
      };
    },
  };
}

/** One extractor per kind. A new format is an addition here, not a rewrite anywhere. */
export const EXTRACTORS: Readonly<Record<Exclude<FileKind, 'image'>, FileExtractor>> = {
  pdf: pdfExtractor,
  docx: docxExtractor,
  xlsx: xlsxExtractor,
  csv: csvExtractor,
  text: textExtractor,
  // Milestone 5 part 2: a web page, reached only by a link the server fetched (sniff.ts).
  html: htmlExtractor,
};

/**
 * Clean every text page, split one that is too long to store, then number text and vision
 * pages together in document order. `pageNo` is the storage position, 1..N with no gaps; the
 * LABEL is what carries the document's own name for a page ("Page 7", `Sheet "Rates"`), so a
 * split page or a skipped blank one never makes an answer cite the wrong place.
 */
function arrangePages(
  pages: readonly ExtractedPage[],
  vision: readonly VisionPage[],
): { readonly pages: ExtractedPage[]; readonly vision: VisionPage[] } {
  type Entry =
    | { readonly at: number; readonly text: ExtractedPage }
    | { readonly at: number; readonly look: VisionPage };
  const entries: Entry[] = vision.map((page) => ({ at: page.pageNo, look: page }));
  for (const page of pages) {
    const text = sanitiseExtractedText(page.text);
    if (text === '') continue;
    if (text.length <= FILE_LIMITS.maxPageChars) {
      entries.push({ at: page.pageNo, text: { ...page, text } });
      continue;
    }
    const parts = splitIntoParts(text, FILE_LIMITS.maxPageChars - 200);
    parts.forEach((part, index) => {
      entries.push({
        // Keeps the sections of one page together, in order, ahead of the next page.
        at: page.pageNo + (index + 1) / (parts.length + 1),
        text: {
          ...page,
          label: `${page.label} (section ${String(index + 1)} of ${String(parts.length)})`,
          text: part,
        },
      });
    });
  }
  entries.sort((a, b) => a.at - b.at);
  const outPages: ExtractedPage[] = [];
  const outVision: VisionPage[] = [];
  entries.forEach((entry, index) => {
    if ('text' in entry) outPages.push({ ...entry.text, pageNo: index + 1 });
    else outVision.push({ ...entry.look, pageNo: index + 1 });
  });
  return { pages: outPages, vision: outVision };
}

export async function extractFile(
  input: ExtractInput,
  engines: ExtractEngines,
): Promise<Extraction> {
  const { bytes } = input;
  if (bytes.length === 0) return refused(null, refusal('empty'));
  if (bytes.length > FILE_LIMITS.maxFileBytes) {
    return refused(null, refusal('too_large', bytes.length));
  }
  const name = sanitiseFileName(input.name);
  const sniffed = sniff(bytes, name, {
    fromLink: input.fromLink === true,
    contentType: input.contentType ?? null,
  });
  if (!sniffed.ok) return refused(sniffed.kind, sniffed.refusal);

  const extractor =
    sniffed.kind === 'image'
      ? imageExtractor(sniffed.mediaType ?? 'image/jpeg')
      : EXTRACTORS[sniffed.kind];
  let extraction: Extraction;
  try {
    extraction = await extractor.extract({ ...input, name }, engines);
  } catch {
    // An extractor that throws has met bytes it could not make sense of. The file is the
    // problem, and the person is told so — never a blank screen.
    return refused(sniffed.kind, refusal('corrupt'));
  }
  if (!extraction.ok) return extraction;

  const { pages, vision } = arrangePages(extraction.pages, extraction.vision);
  const totalPages = pages.length + vision.length;
  const chars = pages.reduce((sum, page) => sum + page.text.length, 0);
  const fail = (code: Parameters<typeof refusal>[0], detail = 0): Extraction => {
    extraction.dispose();
    return refused(extraction.kind, refusal(code, detail));
  };
  if (totalPages === 0) return fail(extraction.kind === 'html' ? 'page_no_text' : 'no_text');
  if (chars > FILE_LIMITS.maxFileChars) return fail('too_long');
  if (totalPages > FILE_LIMITS.maxPages) {
    // Only a PDF has pages of its own. Everything else was cut into parts here, and telling
    // someone their text file "has 504 pages" would be a number they cannot find anywhere.
    return extraction.kind === 'pdf' ? fail('too_many_pages', totalPages) : fail('too_long');
  }
  if (vision.length > FILE_LIMITS.maxVisionPages) {
    return fail('too_many_scanned_pages', vision.length);
  }

  return {
    ...extraction,
    pages,
    vision,
    totalPages,
    notes: sniffed.note === null ? extraction.notes : [sniffed.note, ...extraction.notes],
  };
}

/** SHA-256 of the original bytes, hex. The same file sent twice is recognised by this. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
