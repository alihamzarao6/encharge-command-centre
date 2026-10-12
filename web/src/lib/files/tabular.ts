/**
 * A grid of cells as text a model can read without guessing (Milestone 5 part 1, D92) — the
 * shared half of the Excel and CSV readers.
 *
 * A sheet is not prose. Flattened into sentences it loses the one thing that makes it a
 * sheet: which number sits under which heading on which row. So it is written as a table with
 * the REAL row numbers down the side and the column letters across the top, blank rows left
 * out but never renumbered, so "B14" in an answer is B14 in the file.
 *
 * And a model adding up a long column is unreliable. The totals a person most often asks for
 * are therefore computed HERE, in code, per numeric column, and written into the text — with
 * formula cells left out of the sum, because a "Total" row at the bottom of a column would
 * otherwise be counted twice.
 */
import { FILE_LIMITS } from '../../../../src/lib/files/limits.js';

export interface Cell {
  /** What the cell shows, as stored in the file. Never recalculated. */
  readonly text: string;
  /** The stored number, when the cell is one — dates and percentages excluded from sums. */
  readonly number: number | null;
  /** The formula text without the leading "=", when the cell has one. */
  readonly formula: string | null;
}

export interface TableRow {
  /** 1-based, as the file numbers it. */
  readonly rowNo: number;
  /** Indexed by column, 0 = A. Holes are empty cells. */
  readonly cells: readonly (Cell | undefined)[];
}

export interface Table {
  readonly name: string;
  /** "Sheet" for a workbook, "Table" for a CSV. */
  readonly noun: string;
  readonly rows: readonly TableRow[];
  readonly merged: readonly string[];
  readonly hidden: boolean;
  /** Set when the reader stopped early; the sentence says where. */
  readonly truncatedAt: number | null;
}

export interface RenderedPart {
  readonly label: string;
  readonly text: string;
}

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) return out;
  }
}

/** "AB12" → { column: 27, row: 12 }, or null when it is not a cell reference. */
export function parseCellRef(
  ref: string,
): { readonly column: number; readonly row: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref);
  if (match === null) return null;
  const letters = (match[1] ?? '').toUpperCase();
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) };
}

/** A float without the noise binary arithmetic leaves behind: 48210.500000000004 → 48210.5. */
export function tidyNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function oneLine(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

function renderCell(cell: Cell | undefined): string {
  if (cell === undefined) return '';
  const shown = oneLine(cell.text);
  if (cell.formula === null) return shown;
  const formula = oneLine(cell.formula);
  // The stored result is what the sheet showed; the formula says it was calculated.
  return shown === '' ? `{=${formula}} (no stored result)` : `${shown} {=${formula}}`;
}

interface ColumnSummary {
  readonly column: number;
  readonly heading: string | null;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly firstRow: number;
  readonly lastRow: number;
  readonly formulaCells: number;
}

const MIN_NUMBERS_FOR_SUMMARY = 3;

export function summariseColumns(rows: readonly TableRow[]): readonly ColumnSummary[] {
  const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const out: ColumnSummary[] = [];
  for (let column = 0; column < width; column += 1) {
    let heading: string | null = null;
    let count = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let firstRow = 0;
    let lastRow = 0;
    let formulaCells = 0;
    for (const row of rows) {
      const cell = row.cells[column];
      if (cell === undefined) continue;
      if (cell.number === null) {
        // The nearest text above the first number is what the column is called.
        if (count === 0 && cell.text.trim() !== '') heading = oneLine(cell.text);
        continue;
      }
      if (cell.formula !== null) {
        formulaCells += 1;
        continue;
      }
      if (count === 0) firstRow = row.rowNo;
      lastRow = row.rowNo;
      count += 1;
      sum += cell.number;
      min = Math.min(min, cell.number);
      max = Math.max(max, cell.number);
    }
    if (count >= MIN_NUMBERS_FOR_SUMMARY) {
      out.push({ column, heading, count, sum, min, max, firstRow, lastRow, formulaCells });
    }
  }
  return out;
}

function summaryLine(summary: ColumnSummary): string {
  const heading = summary.heading === null ? '' : ` "${summary.heading.slice(0, 60)}"`;
  const formulas =
    summary.formulaCells === 0
      ? ''
      : `; ${String(summary.formulaCells)} formula ${summary.formulaCells === 1 ? 'cell' : 'cells'} left out`;
  return `- ${columnLetter(summary.column)}${heading} (rows ${String(summary.firstRow)} to ${String(summary.lastRow)}): ${String(summary.count)} numbers, sum ${tidyNumber(summary.sum)}, min ${tidyNumber(summary.min)}, max ${tidyNumber(summary.max)}${formulas}`;
}

/** Room left in a part for rows, after its own heading lines. */
const PART_TARGET_CHARS = 40_000;

/**
 * One table → one or more labelled parts, each small enough to be stored as a page and each
 * carrying the column letters, so any part read on its own still makes sense.
 */
export function renderTable(table: Table): readonly RenderedPart[] {
  const rows = table.rows.filter((row) => row.cells.some((cell) => cell !== undefined));
  const quoted = `${table.noun} "${oneLine(table.name).slice(0, 80)}"`;
  if (rows.length === 0) {
    return [{ label: quoted, text: `${quoted} is empty.` }];
  }
  const width = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const filled = rows.reduce(
    (total, row) => total + row.cells.filter((cell) => cell !== undefined).length,
    0,
  );
  const header = `row\t${Array.from({ length: width }, (_, i) => columnLetter(i)).join('\t')}`;
  const lines = rows.map((row) => {
    const cells = row.cells.map(renderCell);
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return { rowNo: row.rowNo, text: `${String(row.rowNo)}\t${cells.join('\t')}` };
  });

  const first = rows[0]?.rowNo ?? 1;
  const last = rows[rows.length - 1]?.rowNo ?? first;
  const intro: string[] = [
    `${quoted}: rows ${String(first)} to ${String(last)}, columns A to ${columnLetter(width - 1)}, ${String(filled)} filled cells${table.hidden ? ' (a hidden sheet)' : ''}.`,
  ];
  if (table.merged.length > 0) {
    const shown = table.merged.slice(0, 40).join(', ');
    intro.push(
      `Merged cells (the value sits in the top-left cell of each range): ${shown}${table.merged.length > 40 ? ', …' : ''}`,
    );
  }
  const summaries = summariseColumns(rows);
  if (summaries.length > 0) {
    intro.push(
      'Column totals worked out by the app, not by the file (formula cells are left out so a total row is not counted twice):',
      ...summaries.map(summaryLine),
    );
  }
  if (table.truncatedAt !== null) {
    intro.push(
      `Only the first ${String(table.truncatedAt)} rows were read. The rest of this ${table.noun.toLowerCase()} is NOT here.`,
    );
  }

  const limit = Math.min(PART_TARGET_CHARS, FILE_LIMITS.maxPageChars - 2_000);
  const groups: { from: number; to: number; lines: string[] }[] = [];
  let current: { from: number; to: number; lines: string[] } | null = null;
  let size = 0;
  for (const line of lines) {
    // One absurdly long row still has to fit in a page.
    const text = line.text.length > limit ? `${line.text.slice(0, limit - 20)} […cut]` : line.text;
    if (current === null || size + text.length + 1 > limit) {
      current = { from: line.rowNo, to: line.rowNo, lines: [] };
      groups.push(current);
      size = 0;
    }
    current.lines.push(text);
    current.to = line.rowNo;
    size += text.length + 1;
  }

  return groups.map((group, index) => {
    const many = groups.length > 1;
    const label = many
      ? `${quoted} (part ${String(index + 1)} of ${String(groups.length)}, rows ${String(group.from)} to ${String(group.to)})`
      : quoted;
    const head =
      index === 0 ? intro : [`${label}. Continues the same ${table.noun.toLowerCase()}.`];
    return { label, text: [...head, header, ...group.lines].join('\n') };
  });
}

/** Text → parts of roughly `target` characters, cut at a paragraph or a line, never mid-word. */
export function splitIntoParts(text: string, target = 3_000): readonly string[] {
  const limit = Math.min(target, FILE_LIMITS.maxPageChars);
  if (text.length <= limit) return text.trim() === '' ? [] : [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = window.lastIndexOf('\n');
    if (cut < limit / 2) cut = window.lastIndexOf(' ');
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim() !== '') parts.push(rest.trim());
  return parts.filter((part) => part !== '');
}
