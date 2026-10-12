/**
 * Reading a PDF (Milestone 5 part 1, D84 and D90).
 *
 * Four different problems share the extension:
 *
 *  - A page WITH a text layer: the text items pdf.js reports are grouped back into lines by
 *    their baseline and ordered left to right, with a tab where there is a real gap — so a
 *    row of a statement or a rate sheet stays one row, its columns apart. A row with an empty
 *    cell is put back in its columns by position, or marked as uncertain when its position
 *    does not settle it (linesFromItems). Right-to-left lines are ordered right to left.
 *  - A page with NO text layer (a scan): nothing to extract. It becomes a vision page, to be
 *    looked at by the model once the person has agreed to what that costs.
 *  - A page whose text layer is GARBAGE: fonts without a Unicode map give back private-use
 *    characters and replacement marks. That is treated as no text layer, not passed on as if
 *    it were the document.
 *  - A PDF that cannot be opened: password-protected, truncated, not really a PDF. Each is a
 *    sentence, never silence.
 *
 * pdf.js is given only bytes. Scripts in a PDF are never run (`enableScripting` is off unless
 * a viewer turns it on, and this is not a viewer), `eval` is disabled, XFA forms are not
 * built, and nothing is fetched: no fonts, no character maps, no linked resources.
 */
import {
  EMPTY_CELL_MARK,
  FILE_LIMITS,
  UNCERTAIN_COLUMNS_MARK,
  refusal,
} from '../../../../src/lib/files/limits.js';
import { meaningfulChars } from '../../../../src/lib/files/text.js';
import {
  refused,
  type ExtractEngines,
  type ExtractInput,
  type ExtractedPage,
  type Extraction,
  type FileExtractor,
  type PdfLoadingTaskLike,
  type VisionPage,
} from './types.js';

/** Fewer real characters than this on a page and it has no usable text layer. */
export const MIN_PAGE_TEXT_CHARS = 20;
/** A gap wider than this (PDF units) between two items on a line is a column, not a space. */
const COLUMN_GAP = 12;
/** Baselines within this many units are the same line. */
const LINE_TOLERANCE = 3;

interface Placed {
  readonly x: number;
  readonly width: number;
  readonly text: string;
  readonly rtl: boolean;
}

function numberAt(value: unknown, index: number): number {
  if (!Array.isArray(value)) return 0;
  const item: unknown = value[index];
  return typeof item === 'number' && Number.isFinite(item) ? item : 0;
}

/** One cell of a line: touching text runs joined, with where it starts and ends. */
interface Cell {
  text: string;
  start: number;
  end: number;
}

/** Edges within this many units are the same edge: a column's cells line up to the unit. */
const ALIGN_TOLERANCE = 2.5;
/** A line needs this many cells before it is taken as showing a table's columns. */
const MIN_TABLE_COLUMNS = 3;

/** Where the cells of the widest rows seen so far began and ended, column by column. */
interface Columns {
  readonly starts: number[][];
  readonly ends: number[][];
}

function near(edges: readonly number[], value: number): boolean {
  return edges.some((edge) => Math.abs(edge - value) <= ALIGN_TOLERANCE);
}

/**
 * The column each cell of a short row sits in, or null when the page does not say. A cell
 * belongs to a column when its left edge, or its right edge (figures are often set flush
 * right), lines up with that column's in a full row above — and with no other column's.
 * Anything less than that for every cell is a guess, and a guess here is a rate under the
 * wrong heading.
 */
function placeCells(cells: readonly Cell[], columns: Columns): number[] | null {
  const placed: number[] = [];
  for (const cell of cells) {
    const matches: number[] = [];
    for (let index = 0; index < columns.starts.length; index += 1) {
      if (
        near(columns.starts[index] ?? [], cell.start) ||
        near(columns.ends[index] ?? [], cell.end)
      ) {
        matches.push(index);
      }
    }
    const column = matches[0];
    if (matches.length !== 1 || column === undefined) return null;
    if (column <= (placed.at(-1) ?? -1)) return null;
    placed.push(column);
  }
  return placed;
}

/**
 * Text items → lines, top to bottom, each ordered the way its script reads.
 *
 * A table row with an EMPTY cell is the hazard: joined naively, "Tool allowance | | | 55.00"
 * becomes "Tool allowance<tab>55.00" and the amount reads as the second column — on a rate
 * sheet, a rate under the wrong LVR band. So the widest rows on the page are remembered as
 * the table's columns, and a row with fewer cells is either put back in its columns by
 * position (each empty cell written as EMPTY_CELL_MARK, so every value sits under its own
 * heading where a model can count it), or — when its position does not settle it —
 * prefixed with UNCERTAIN_COLUMNS_MARK, which the rules tell the model to quote as it stands
 * and never to read a labelled value from.
 */
export function linesFromItems(items: readonly unknown[]): readonly string[] {
  const rows = new Map<number, Placed[]>();
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Readonly<Record<string, unknown>>;
    if (typeof item['str'] !== 'string' || item['str'].trim() === '') continue;
    const y = Math.round(numberAt(item['transform'], 5) / LINE_TOLERANCE) * LINE_TOLERANCE;
    const placed: Placed = {
      x: numberAt(item['transform'], 4),
      width:
        typeof item['width'] === 'number' && Number.isFinite(item['width']) ? item['width'] : 0,
      text: item['str'],
      rtl: item['dir'] === 'rtl',
    };
    const row = rows.get(y);
    if (row === undefined) rows.set(y, [placed]);
    else row.push(placed);
  }

  // A holder, not a `let`: an assignment inside the callback is invisible to narrowing.
  const table: { columns: Columns | null } = { columns: null };
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, runs]) => {
      const rtl = runs.filter((run) => run.rtl).length > runs.length / 2;
      runs.sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));
      const cells: Cell[] = [];
      let edge: number | null = null;
      for (const run of runs) {
        const last = cells.at(-1);
        const gap = edge === null ? 0 : rtl ? edge - (run.x + run.width) : run.x - edge;
        if (last === undefined || gap > COLUMN_GAP) {
          cells.push({ text: run.text, start: run.x, end: run.x + run.width });
        } else {
          last.text += last.text.endsWith(' ') || run.text.startsWith(' ') ? '' : ' ';
          last.text += run.text;
          last.start = Math.min(last.start, run.x);
          last.end = Math.max(last.end, run.x + run.width);
        }
        edge = rtl ? run.x : run.x + run.width;
      }
      const plain = cells
        .map((cell) => cell.text)
        .join('\t')
        .trimEnd();
      if (cells.length < 2) return plain;

      const width = table.columns?.starts.length ?? 0;
      if (cells.length >= MIN_TABLE_COLUMNS && cells.length >= width) {
        // A row at least as wide as any before it shows where the columns are.
        const known: Columns =
          table.columns !== null && cells.length === width
            ? table.columns
            : { starts: cells.map(() => []), ends: cells.map(() => []) };
        table.columns = known;
        cells.forEach((cell, index) => {
          known.starts[index]?.push(cell.start);
          known.ends[index]?.push(cell.end);
        });
        return plain;
      }
      if (table.columns === null) return plain;
      // Fewer cells than the table has columns: something is empty, and which is the question.
      const placed = rtl ? null : placeCells(cells, table.columns);
      if (placed === null) return `${UNCERTAIN_COLUMNS_MARK} ${plain}`;
      const out: string[] = Array.from({ length: width }, () => EMPTY_CELL_MARK);
      placed.forEach((column, index) => {
        out[column] = cells[index]?.text ?? '';
      });
      return out.join('\t');
    });
}

/**
 * True when a page's "text" is not text a person could read: mostly private-use characters,
 * replacement marks or stray controls — what a font with no Unicode map produces.
 */
// Private-use characters, the replacement mark, and stray control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what is being counted
const JUNK = /[\u{E000}-\u{F8FF}\u{FFFD}\u0000-\u0008\u000E-\u001F]/gu;

export function looksGarbled(text: string): boolean {
  const visible = text.replace(/\s/g, '');
  if (visible.length === 0) return false;
  const junk = (visible.match(JUNK) ?? []).length;
  return junk / visible.length > 0.2;
}

function errorName(caught: unknown): string {
  return caught instanceof Error ? caught.name : '';
}

/**
 * pdf.js loads with these and nothing else: bytes in, no scripts, and no request to anywhere
 * but `assets` — pdf.js's own data files, served from this app's origin. They are not
 * optional: without the character maps a CJK line in a PDF whose font is not embedded is
 * dropped silently, and without the decoders a JBIG2 or JPEG 2000 scan renders blank.
 */
export function pdfLoadOptions(
  bytes: Uint8Array,
  assets: string,
): Readonly<Record<string, unknown>> {
  return {
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    standardFontDataUrl: `${assets}standard_fonts/`,
    // pdf.js transfers the buffer to its worker; hand it a copy so the caller's bytes (which
    // are hashed afterwards) stay intact.
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  };
}

async function readPdf(input: ExtractInput, engines: ExtractEngines): Promise<Extraction> {
  let task: PdfLoadingTaskLike | null = null;
  const release = (): void => {
    const held = task;
    task = null;
    if (held !== null) void held.destroy().catch(() => undefined);
  };
  try {
    const pdfjs = await engines.pdf();
    task = pdfjs.getDocument(pdfLoadOptions(input.bytes, engines.pdfAssets));
    const document = await task.promise;
    const total = document.numPages;
    if (total > FILE_LIMITS.maxPages) {
      release();
      return refused('pdf', refusal('too_many_pages', total));
    }

    const pages: ExtractedPage[] = [];
    const vision: VisionPage[] = [];
    for (let pageNo = 1; pageNo <= total; pageNo += 1) {
      if (input.signal?.aborted === true) {
        release();
        return refused('pdf', refusal('corrupt'));
      }
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      const text = linesFromItems(content.items).join('\n');
      const label = `Page ${String(pageNo)}`;
      if (meaningfulChars(text) < MIN_PAGE_TEXT_CHARS || looksGarbled(text)) {
        vision.push({
          pageNo,
          label,
          // Rendered on demand, after the person has agreed to the cost (D90).
          image: async () => {
            const fresh = await document.getPage(pageNo);
            try {
              return await engines.images.renderPdfPage(fresh);
            } finally {
              fresh.cleanup();
            }
          },
        });
      } else {
        pages.push({ pageNo, label, text, method: 'pdf_text_layer' });
      }
      page.cleanup();
      input.onProgress?.(pageNo, total);
    }

    if (vision.length > FILE_LIMITS.maxVisionPages) {
      release();
      return refused('pdf', refusal('too_many_scanned_pages', vision.length));
    }
    return {
      ok: true,
      kind: 'pdf',
      totalPages: total,
      pages,
      vision,
      notes: [],
      dispose: release,
    };
  } catch (caught: unknown) {
    release();
    return refused(
      'pdf',
      refusal(errorName(caught) === 'PasswordException' ? 'password_pdf' : 'corrupt'),
    );
  }
}

export const pdfExtractor: FileExtractor = { kind: 'pdf', extract: readPdf };
