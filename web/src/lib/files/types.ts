/**
 * The one interface every format is read through (Milestone 5 part 1). A new format is a new
 * `FileExtractor` and one line in `extract.ts`'s table — nothing else in the upload path
 * knows what a PDF or a workbook is.
 *
 * An extraction is either pages of text, or pages that have to be LOOKED at (a photo, a
 * scanned page), or a refusal with a sentence. Vision pages are thunks: rendering a page
 * image is the expensive half, and it must not happen before the person has seen what
 * reading it will cost (D90).
 */
import type { ExtractionMethod, FileKind, Refusal } from '../../../../src/lib/files/limits.js';

export interface ExtractedPage {
  readonly pageNo: number;
  /** "Page 3", `Sheet "Rates"`, "Part 2" — what the model and the person call it. */
  readonly label: string;
  readonly text: string;
  readonly method: ExtractionMethod;
}

/** A JPEG, base64 without a data: prefix, already upright and scaled. */
export interface PageImage {
  readonly base64: string;
  readonly width: number;
  readonly height: number;
}

export interface VisionPage {
  readonly pageNo: number;
  readonly label: string;
  /** Null when this device could not render the page. */
  readonly image: () => Promise<PageImage | null>;
}

export interface ExtractionOk {
  readonly ok: true;
  readonly kind: FileKind;
  /** Text pages plus vision pages. */
  readonly totalPages: number;
  readonly pages: readonly ExtractedPage[];
  readonly vision: readonly VisionPage[];
  /** Things the person should know that are not failures: macros not run, a sheet cut short. */
  readonly notes: readonly string[];
  /** Releases whatever the extraction is holding open (a parsed PDF). Safe to call twice. */
  readonly dispose: () => void;
  /**
   * Milestone 5 part 2: a web page's own title, when it has one. A stranger's words: the
   * server cleans them before they are stored or shown (sanitiseTitle).
   */
  readonly title?: string | null;
}

export interface ExtractionRefused {
  readonly ok: false;
  /** What the bytes turned out to be, when that much was decided before the refusal. */
  readonly kind: FileKind | null;
  readonly refusal: Refusal;
}

export type Extraction = ExtractionOk | ExtractionRefused;

export interface ExtractInput {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
  /**
   * Milestone 5 part 2: the bytes were fetched from a link by the server, not chosen from
   * this device. Only then is a web page read (an uploaded .html file is still refused —
   * D83). The bytes still decide what the thing is.
   */
  readonly fromLink?: boolean;
  /** The server's cleaned `Content-Type` for those bytes: a hint for the encoding, no more. */
  readonly contentType?: string | null;
}

// --- the two things only a browser can do, injected so the rest runs under Node ----------

export interface PdfPageLike {
  /** Items are read defensively (pdf.ts): text runs carry `str`, markers do not. */
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>;
  cleanup(): unknown;
  /** Present on a real pdf.js page; used only to render a page that has no text layer. */
  getViewport?(params: { readonly scale: number }): {
    readonly width: number;
    readonly height: number;
  };
  render?(params: Readonly<Record<string, unknown>>): { readonly promise: Promise<unknown> };
}

export interface PdfDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
  destroy(): Promise<unknown>;
}

/** The slice of pdf.js this code uses. The real module satisfies it structurally. */
export interface PdfJsLike {
  getDocument(source: Readonly<Record<string, unknown>>): PdfLoadingTaskLike;
}

export interface ImageEngine {
  /** Decode, turn upright (EXIF), scale, re-encode as JPEG. Null when it cannot be decoded. */
  decode(bytes: Uint8Array, mediaType: string): Promise<PageImage | null>;
  /** Render one PDF page to a JPEG. Null when this device cannot. */
  renderPdfPage(page: PdfPageLike): Promise<PageImage | null>;
}

export interface ExtractEngines {
  /** Loads pdf.js on first use: nobody downloads a megabyte of PDF reader to send a CSV. */
  readonly pdf: () => Promise<PdfJsLike>;
  /** Where pdf.js's own data files are served from, with a trailing slash. Same origin. */
  readonly pdfAssets: string;
  readonly images: ImageEngine;
}

export interface FileExtractor {
  readonly kind: FileKind;
  extract(input: ExtractInput, engines: ExtractEngines): Promise<Extraction>;
}

export function refused(kind: FileKind | null, refusal: Refusal): ExtractionRefused {
  return { ok: false, kind, refusal };
}

export function noop(): void {
  // Nothing held open.
}
