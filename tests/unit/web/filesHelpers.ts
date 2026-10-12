/**
 * Shared pieces for the file-reading unit tests: the committed fixtures (all invented —
 * tests/fixtures/files/make_fixtures.py), the real pdf.js running under Node, and a stand-in
 * for the one thing Node cannot do, which is decode and render pictures on a canvas. The
 * browser suite covers that half with a real Chrome.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import type {
  ExtractEngines,
  ExtractionOk,
  Extraction,
  ImageEngine,
  PageImage,
  PdfJsLike,
} from '../../../web/src/lib/files/types.js';

export const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'files');

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

export const FAKE_IMAGE: PageImage = { base64: '/9j/not-a-real-image', width: 1448, height: 2048 };

export interface FakeImages extends ImageEngine {
  readonly decoded: string[];
  rendered: number;
  /** Media types this pretend device cannot open. */
  readonly undecodable: Set<string>;
}

export function fakeImages(): FakeImages {
  const engine: FakeImages = {
    decoded: [],
    rendered: 0,
    undecodable: new Set(['image/heic', 'image/avif']),
    decode: (_bytes, mediaType) => {
      engine.decoded.push(mediaType);
      return Promise.resolve(engine.undecodable.has(mediaType) ? null : FAKE_IMAGE);
    },
    renderPdfPage: () => {
      engine.rendered += 1;
      return Promise.resolve(FAKE_IMAGE);
    },
  };
  return engine;
}

/** The real pdf.js (its Node build), exactly as the browser build is used. */
export const realPdfJs: PdfJsLike = { getDocument };

/** pdf.js reads its own data files (character maps, image decoders) from here under Node. */
export const PDF_ASSETS = `${join(import.meta.dirname, '..', '..', '..', 'node_modules', 'pdfjs-dist')}/`;

export function nodeEngines(images: ImageEngine = fakeImages()): ExtractEngines {
  return { pdf: () => Promise.resolve(realPdfJs), pdfAssets: PDF_ASSETS, images };
}

/** Narrow to a successful extraction or fail the test with the refusal that came back. */
export function accepted(extraction: Extraction): ExtractionOk {
  if (!extraction.ok) {
    throw new Error(`expected the file to be read, but it was refused: ${extraction.refusal.code}`);
  }
  return extraction;
}

export function allText(extraction: ExtractionOk): string {
  return extraction.pages.map((page) => page.text).join('\n');
}
