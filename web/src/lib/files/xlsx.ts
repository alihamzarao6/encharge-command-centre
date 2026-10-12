/**
 * Reading an Excel workbook (.xlsx / .xlsm) — Milestone 5 part 1, D84 and D92.
 *
 * Our own reader rather than a library: the obvious one (`xlsx` on npm) has been frozen at a
 * version with known vulnerabilities for years, and a parser of files strangers send is the
 * last place to accept that. A workbook is a zip of XML; what a broker's sheet needs from it
 * is small and well defined — every sheet, every cell's STORED value, which cells are
 * formulas, which are dates, and which ranges are merged.
 *
 * Honest about three things:
 *  - Nothing is recalculated. A formula cell shows the result Excel saved with the file, or
 *    says it has none.
 *  - Macros are never run and never read; a macro-enabled workbook is read for its cells and
 *    the person is told macros were ignored.
 *  - A sheet too large to read whole is cut at a stated row, and the text says so.
 */
import { refusal } from '../../../../src/lib/files/limits.js';
import {
  renderTable,
  parseCellRef,
  tidyNumber,
  type Cell,
  type Table,
  type TableRow,
} from './tabular.js';
import { noop, refused, type ExtractInput, type Extraction, type FileExtractor } from './types.js';
import { xmlTokens } from './xml.js';
import { MACROS_NOTE, entryText, hasMacros, readZipEntries } from './zip.js';

/** Cells read from one sheet before it is cut short. */
export const MAX_CELLS_PER_SHEET = 200_000;
export const MAX_SHEETS = 60;

interface SheetRef {
  readonly name: string;
  readonly path: string;
  readonly hidden: boolean;
}

interface CellStyle {
  readonly isDate: boolean;
  readonly isPercent: boolean;
  readonly decimals: number;
}

const PLAIN_STYLE: CellStyle = { isDate: false, isPercent: false, decimals: 0 };

// Built-in number formats that are dates or times (ECMA-376 §18.8.30).
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

function decimalsOf(format: string): number {
  const match = /\.(0+)/.exec(format);
  return match?.[1]?.length ?? 0;
}

function styleFromFormat(id: number, code: string | undefined): CellStyle {
  if (code === undefined) {
    if (BUILTIN_DATE_FORMATS.has(id)) return { isDate: true, isPercent: false, decimals: 0 };
    if (id === 9) return { isDate: false, isPercent: true, decimals: 0 };
    if (id === 10) return { isDate: false, isPercent: true, decimals: 2 };
    return PLAIN_STYLE;
  }
  // Quoted text and bracketed sections ([Red], [$-409]) are not format letters.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  if (bare.includes('%')) return { isDate: false, isPercent: true, decimals: decimalsOf(bare) };
  if (/[ymdhs]/i.test(bare) && !/general/i.test(bare)) {
    return { isDate: true, isPercent: false, decimals: 0 };
  }
  return PLAIN_STYLE;
}

function readStyles(xml: string | null): readonly CellStyle[] {
  if (xml === null) return [];
  const custom = new Map<number, string>();
  const styles: CellStyle[] = [];
  let inCellXfs = false;
  for (const token of xmlTokens(xml)) {
    if (token.type === 'open') {
      if (token.name === 'numFmt') {
        const id = Number(token.attrs['numFmtId']);
        const code = token.attrs['formatCode'];
        if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
      } else if (token.name === 'cellXfs') {
        inCellXfs = !token.selfClosing;
      } else if (token.name === 'xf' && inCellXfs) {
        const id = Number(token.attrs['numFmtId'] ?? '0');
        styles.push(styleFromFormat(Number.isInteger(id) ? id : 0, custom.get(id)));
      }
    } else if (token.type === 'close' && token.name === 'cellXfs') {
      inCellXfs = false;
    }
  }
  return styles;
}

function readSharedStrings(xml: string | null): readonly string[] {
  if (xml === null) return [];
  const strings: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  for (const token of xmlTokens(xml)) {
    if (token.type === 'open') {
      if (token.name === 'si') {
        current = '';
        if (token.selfClosing) {
          strings.push('');
          current = null;
        }
      } else if (token.name === 'rPh' && !token.selfClosing) {
        // Phonetic guides (furigana) are a reading aid, not the cell's text.
        phonetic += 1;
      } else if (token.name === 't') {
        inText = !token.selfClosing && phonetic === 0;
      }
    } else if (token.type === 'close') {
      if (token.name === 'si' && current !== null) {
        strings.push(current);
        current = null;
      } else if (token.name === 'rPh') {
        phonetic = Math.max(0, phonetic - 1);
      } else if (token.name === 't') {
        inText = false;
      }
    } else if (inText && current !== null) {
      current += token.text;
    }
  }
  return strings;
}

function readRelationships(xml: string | null): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (xml === null) return out;
  for (const token of xmlTokens(xml)) {
    if (token.type === 'open' && token.name === 'Relationship') {
      const id = token.attrs['Id'];
      const target = token.attrs['Target'];
      if (id !== undefined && target !== undefined) out.set(id, target);
    }
  }
  return out;
}

function resolveSheetPath(target: string): string {
  // Targets are relative to xl/ ("worksheets/sheet1.xml") or absolute ("/xl/worksheets/…").
  const cleaned = target.replace(/\\/g, '/');
  if (cleaned.startsWith('/')) return cleaned.slice(1);
  return `xl/${cleaned.replace(/^\.\//, '')}`;
}

function readWorkbook(
  xml: string,
  relationships: ReadonlyMap<string, string>,
): { readonly sheets: readonly SheetRef[]; readonly date1904: boolean } {
  const sheets: SheetRef[] = [];
  let date1904 = false;
  for (const token of xmlTokens(xml)) {
    if (token.type !== 'open') continue;
    if (token.name === 'workbookPr') {
      const flag = token.attrs['date1904'];
      date1904 = flag === '1' || flag === 'true';
    } else if (token.name === 'sheet') {
      const target = relationships.get(token.attrs['id'] ?? '');
      if (target === undefined) continue;
      const state = token.attrs['state'];
      sheets.push({
        name: token.attrs['name'] ?? `Sheet ${String(sheets.length + 1)}`,
        path: resolveSheetPath(target),
        hidden: state === 'hidden' || state === 'veryHidden',
      });
    }
  }
  return { sheets, date1904 };
}

const DAY_MS = 86_400_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** An Excel serial date as ISO text. Excel's 1900 system counts a 29 Feb 1900 that never was. */
export function serialToIso(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial)) return String(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = Math.floor(serial);
  const adjusted = !date1904 && days < 60 ? days + 1 : days;
  const seconds = Math.round((serial - days) * 86_400);
  const date = new Date(epoch + adjusted * DAY_MS + seconds * 1000);
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  if (days === 0 && seconds > 0) return time;
  const day = `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return seconds === 0 ? day : `${day} ${time}`;
}

function buildCell(
  type: string,
  raw: string,
  inline: string,
  formula: string | null,
  style: CellStyle,
  shared: readonly string[],
  date1904: boolean,
): Cell | undefined {
  const value = raw.trim();
  switch (type) {
    case 's': {
      const index = Number(value);
      const text = Number.isInteger(index) ? (shared[index] ?? '') : '';
      return text === '' && formula === null ? undefined : { text, number: null, formula };
    }
    case 'inlineStr':
      return inline === '' && formula === null
        ? undefined
        : { text: inline, number: null, formula };
    case 'str':
    case 'e':
    case 'd':
      return raw === '' && formula === null ? undefined : { text: raw, number: null, formula };
    case 'b':
      return { text: value === '1' ? 'TRUE' : 'FALSE', number: null, formula };
    default: {
      if (value === '') {
        return formula === null ? undefined : { text: '', number: null, formula };
      }
      const number = Number(value);
      if (!Number.isFinite(number)) return { text: value, number: null, formula };
      if (style.isDate) return { text: serialToIso(number, date1904), number: null, formula };
      if (style.isPercent) {
        return { text: `${(number * 100).toFixed(style.decimals)}%`, number: null, formula };
      }
      return { text: tidyNumber(number), number, formula };
    }
  }
}

function readSheet(
  xml: string,
  ref: SheetRef,
  shared: readonly string[],
  styles: readonly CellStyle[],
  date1904: boolean,
): Table {
  const rows = new Map<number, (Cell | undefined)[]>();
  const merged: string[] = [];
  let cells = 0;
  let truncatedAt: number | null = null;

  let rowNo = 0;
  let nextColumn = 0;
  let cellColumn = 0;
  let cellType = 'n';
  let cellStyle: CellStyle = PLAIN_STYLE;
  let inCell = false;
  let capture: 'v' | 'f' | 't' | null = null;
  let value = '';
  let inline = '';
  let formula: string | null = null;

  const closeCell = (): void => {
    const built = buildCell(cellType, value, inline, formula, cellStyle, shared, date1904);
    if (built !== undefined) {
      let row = rows.get(rowNo);
      if (row === undefined) {
        row = [];
        rows.set(rowNo, row);
      }
      row[cellColumn] = built;
      cells += 1;
    }
    inCell = false;
  };

  for (const token of xmlTokens(xml)) {
    if (truncatedAt !== null && token.type === 'open' && token.name !== 'mergeCell') continue;
    if (token.type === 'open') {
      if (token.name === 'row') {
        const declared = Number(token.attrs['r']);
        rowNo = Number.isInteger(declared) && declared > 0 ? declared : rowNo + 1;
        nextColumn = 0;
        if (cells >= MAX_CELLS_PER_SHEET) truncatedAt = rowNo - 1;
      } else if (token.name === 'c') {
        const position = parseCellRef(token.attrs['r'] ?? '');
        cellColumn = position === null ? nextColumn : position.column;
        nextColumn = cellColumn + 1;
        cellType = token.attrs['t'] ?? 'n';
        const styleIndex = Number(token.attrs['s'] ?? '-1');
        cellStyle = styles[styleIndex] ?? PLAIN_STYLE;
        value = '';
        inline = '';
        formula = null;
        inCell = true;
        if (token.selfClosing) closeCell();
      } else if (inCell && token.name === 'v') {
        capture = token.selfClosing ? null : 'v';
      } else if (inCell && token.name === 'f') {
        // A shared formula's dependants carry no text of their own: say it is one anyway.
        formula = token.selfClosing ? '(shared formula)' : '';
        capture = token.selfClosing ? null : 'f';
      } else if (inCell && token.name === 't') {
        capture = token.selfClosing ? null : 't';
      } else if (token.name === 'mergeCell') {
        const range = token.attrs['ref'];
        if (range !== undefined && merged.length < 500) merged.push(range);
      }
    } else if (token.type === 'close') {
      if (token.name === 'c' && inCell) closeCell();
      else if (token.name === 'v' || token.name === 'f' || token.name === 't') capture = null;
    } else if (capture === 'v') {
      value += token.text;
    } else if (capture === 'f') {
      formula = (formula ?? '') + token.text;
    } else if (capture === 't') {
      inline += token.text;
    }
  }

  const ordered: TableRow[] = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([no, row]) => ({ rowNo: no, cells: Array.from(row) }));
  return { name: ref.name, noun: 'Sheet', rows: ordered, merged, hidden: ref.hidden, truncatedAt };
}

function wanted(name: string): boolean {
  return (
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' ||
    name === 'xl/styles.xml' ||
    (name.startsWith('xl/worksheets/') && name.endsWith('.xml') && !name.includes('/_rels/'))
  );
}

/** Synchronous at heart; the promise is the extractor interface's shape. */
export function readWorkbookBytes(bytes: Uint8Array): Extraction {
  const read = readZipEntries(bytes, wanted);
  if (!read.ok) return refused('xlsx', refusal(read.reason));
  const workbookXml = entryText(read.files, 'xl/workbook.xml');
  if (workbookXml === null) return refused('xlsx', refusal('corrupt'));

  const relationships = readRelationships(entryText(read.files, 'xl/_rels/workbook.xml.rels'));
  const workbook = readWorkbook(workbookXml, relationships);
  const shared = readSharedStrings(entryText(read.files, 'xl/sharedStrings.xml'));
  const styles = readStyles(entryText(read.files, 'xl/styles.xml'));

  const notes: string[] = hasMacros(read.names) ? [MACROS_NOTE] : [];
  const pages: { label: string; text: string }[] = [];
  let anyCells = false;
  for (const ref of workbook.sheets.slice(0, MAX_SHEETS)) {
    const xml = entryText(read.files, ref.path);
    // A chart sheet or a macro sheet has no worksheet part: there are no cells to read.
    if (xml === null) continue;
    const table = readSheet(xml, ref, shared, styles, workbook.date1904);
    if (table.rows.length > 0) anyCells = true;
    if (table.truncatedAt !== null) {
      notes.push(
        `The sheet "${ref.name}" is very large: only its first ${String(table.truncatedAt)} rows were read.`,
      );
    }
    pages.push(...renderTable(table));
  }
  if (workbook.sheets.length > MAX_SHEETS) {
    notes.push(
      `This workbook has ${String(workbook.sheets.length)} sheets: only the first ${String(MAX_SHEETS)} were read.`,
    );
  }
  if (!anyCells) return refused('xlsx', refusal('no_text'));
  return {
    ok: true,
    kind: 'xlsx',
    totalPages: pages.length,
    pages: pages.map((page, index) => ({
      pageNo: index + 1,
      label: page.label,
      text: page.text,
      method: 'xlsx_xml',
    })),
    vision: [],
    notes,
    dispose: noop,
  };
}

export const xlsxExtractor: FileExtractor = {
  kind: 'xlsx',
  extract: (input: ExtractInput): Promise<Extraction> =>
    Promise.resolve(readWorkbookBytes(input.bytes)),
};
