/**
 * The two things only a browser can do for reading files (Milestone 5 part 1): load pdf.js
 * with its worker, and turn a picture — a phone photo, or one page of a scanned PDF — into
 * the JPEG that is sent to be read.
 *
 * Everything else about a file is decided in modules that run under Node and are unit-tested
 * there (extract.ts and friends). This file is DOM and canvas from top to bottom, so it is
 * exercised by the browser suite (tests/e2e/files.spec.ts) with a real Chrome, real photos
 * and a real scanned PDF — the same arrangement as drag.ts.
 *
 * What happens to a picture here, before it leaves the device:
 *   - it is turned upright from its EXIF orientation (a phone stores a portrait photo on its
 *     side with a tag saying so; a model reading sideways text misreads it);
 *   - it is scaled so its long edge is at most 2,048 px — enough for small print, and it
 *     bounds what the page costs to read;
 *   - it is re-encoded as a JPEG, which drops every piece of metadata the original carried:
 *     the GPS position of where the photo was taken, the device, the time.
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { FILE_LIMITS, VISION_IMAGE_LONG_EDGE } from '../../../../src/lib/files/limits.js';
import type { ExtractEngines, ImageEngine, PageImage, PdfJsLike, PdfPageLike } from './types.js';

/** Tried in order until the encoded page fits the request limit. */
const JPEG_QUALITIES = [0.85, 0.7, 0.5] as const;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('could not read the encoded image'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // "data:image/jpeg;base64,<data>" — the data is what is sent.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}

async function encode(canvas: HTMLCanvasElement): Promise<PageImage | null> {
  for (const quality of JPEG_QUALITIES) {
    const blob = await toJpegBlob(canvas, quality);
    if (blob === null) return null;
    const base64 = await blobToBase64(blob);
    if (base64.length <= FILE_LIMITS.maxImageBase64Chars) {
      return { base64, width: canvas.width, height: canvas.height };
    }
  }
  return null;
}

function scaled(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  const factor = longest > VISION_IMAGE_LONG_EDGE ? VISION_IMAGE_LONG_EDGE / longest : 1;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

function canvasOf(
  width: number,
  height: number,
): {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
} | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  // A transparent PNG would otherwise come out black as a JPEG.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  return { canvas, context };
}

/** Free the pixel buffer now: a phone does not wait for the garbage collector. */
function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

const images: ImageEngine = {
  decode: async (bytes, mediaType) => {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mediaType }), {
        imageOrientation: 'from-image',
      });
    } catch {
      // This browser cannot decode this format (HEIC outside Safari, a damaged file).
      return null;
    }
    try {
      const size = scaled(bitmap.width, bitmap.height);
      const target = canvasOf(size.width, size.height);
      if (target === null) return null;
      target.context.drawImage(bitmap, 0, 0, size.width, size.height);
      const encoded = await encode(target.canvas);
      release(target.canvas);
      return encoded;
    } finally {
      bitmap.close();
    }
  },

  renderPdfPage: async (page: PdfPageLike) => {
    if (page.getViewport === undefined || page.render === undefined) return null;
    try {
      const natural = page.getViewport({ scale: 1 });
      const scale = VISION_IMAGE_LONG_EDGE / Math.max(natural.width, natural.height);
      const viewport = page.getViewport({ scale });
      const target = canvasOf(Math.round(viewport.width), Math.round(viewport.height));
      if (target === null) return null;
      await page.render({ canvas: target.canvas, canvasContext: target.context, viewport }).promise;
      const encoded = await encode(target.canvas);
      release(target.canvas);
      return encoded;
    } catch {
      return null;
    }
  },
};

let loading: Promise<PdfJsLike> | null = null;

/** pdf.js and its worker, downloaded the first time a PDF is attached and not before. */
function loadPdfJs(): Promise<PdfJsLike> {
  loading ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return loading;
}

export function browserEngines(): ExtractEngines {
  return {
    pdf: loadPdfJs,
    // pdf.js's own data files, copied next to the app at build time (web/vite.config.ts).
    pdfAssets: `${import.meta.env.BASE_URL}pdfjs/`,
    images,
  };
}
