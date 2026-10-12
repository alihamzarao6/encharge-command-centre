/**
 * Plain text and CSV (Milestone 5 part 1, D84).
 *
 * Decoding first, because "text" is not one thing: a byte order mark says which Unicode
 * encoding; without one the bytes are tried as UTF-8 strictly, and only if that fails as
 * Windows-1252 — what Excel on Windows still writes for "CSV (Comma delimited)". A wrong
 * guess would turn every "é" into "Ã©" and every "–" into mojibake, silently.
 *
 * CSV is "comma-separated" only by name. Australian and European exports use semicolons, bank
 * exports use tabs or pipes, and Excel writes a `sep=` line to say which. The delimiter is
 * therefore detected — the one that splits the first lines into the same number of columns —
 * and the table is then rendered exactly as a spreadsheet is (tabular.ts), totals included.
 */
import { refusal } from '../../../../src/lib/files/limits.js';
import { renderTable, splitIntoParts, type Cell, type TableRow } from './tabular.js';
import { noop, refused, type ExtractInput, type Extraction, type FileExtractor } from './types.js';

export interface DecodedText {
  readonly text: string;
  readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

export const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

/** Rows read from one CSV before it is cut short. */
export const MAX_CSV_ROWS = 50_000;

/** RFC 4180 with whichever delimiter: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(
  text: string,
  delimiter: string,
  maxRows = MAX_CSV_ROWS,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const length = text.length;
  while (i < length) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The delimiter that makes the first lines agree with each other. Honours Excel's `sep=`
 * line. Falls back to a comma, which reads a one-column file correctly either way.
 */
export function detectDelimiter(text: string): {
  readonly delimiter: Delimiter;
  readonly skipLines: number;
} {
  const firstLine = /^[^\r\n]*/.exec(text)?.[0] ?? '';
  const declared = /^sep=(.)$/i.exec(firstLine.trim());
  if (declared !== null) {
    const found = DELIMITERS.find((candidate) => candidate === declared[1]);
    if (found !== undefined) return { delimiter: found, skipLines: 1 };
  }
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const candidate of DELIMITERS) {
    const sample = parseDelimited(text.slice(0, 20_000), candidate, 25).filter(
      (row) => row.length > 1 || (row[0] ?? '').trim() !== '',
    );
    if (sample.length === 0) continue;
    const counts = new Map<number, number>();
    for (const row of sample) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    let columns = 1;
    let agreeing = 0;
    for (const [width, rows] of counts) {
      if (width > 1 && rows > agreeing) {
        columns = width;
        agreeing = rows;
      }
    }
    // Consistency first, then width: a delimiter that splits most lines the same way wins.
    const score = columns > 1 ? (agreeing / sample.length) * 1000 + columns : 0;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { delimiter: best, skipLines: 0 };
}

const PLAIN_NUMBER = /^[-+]?\(?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?$/;
const EUROPEAN_NUMBER = /^[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d+$/;

/**
 * A field as a number, only when it is unmistakably one. "(1,200.00)" is minus 1200 in an
 * accountant's export; with a semicolon delimiter "1.234,56" is 1234.56. A percentage, a
 * date, a phone number or an account number is left as text and stays out of every sum.
 */
export function parseNumber(field: string, delimiter: string): number | null {
  const value = field.trim();
  if (value === '' || value.length > 24) return null;
  // Leading zeros mean an identifier (a BSB, a phone number), not a quantity.
  if (/^[-+]?0\d/.test(value)) return null;
  if (PLAIN_NUMBER.test(value)) {
    const negative = value.startsWith('-') || (value.includes('(') && value.endsWith(')'));
    const number = Number(value.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(number)) return null;
    return negative ? -number : number;
  }
  if (delimiter !== ',' && EUROPEAN_NUMBER.test(value)) {
    const number = Number(value.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function readCsvBytes(bytes: Uint8Array, name: string): Extraction {
  const decoded = decodeText(bytes);
  const { delimiter, skipLines } = detectDelimiter(decoded.text);
  const parsed = parseDelimited(decoded.text, delimiter, MAX_CSV_ROWS + 1 + skipLines);
  const truncated = parsed.length > MAX_CSV_ROWS + skipLines;
  const body = parsed.slice(skipLines, MAX_CSV_ROWS + skipLines);

  const rows: TableRow[] = [];
  body.forEach((fields, index) => {
    const cells = fields.map((field): Cell | undefined => {
      const text = field.trim();
      if (text === '') return undefined;
      return { text, number: parseNumber(text, delimiter), formula: null };
    });
    if (cells.some((cell) => cell !== undefined)) {
      // Line numbers count the `sep=` line too: they are the file's own.
      rows.push({ rowNo: index + 1 + skipLines, cells });
    }
  });
  if (rows.length === 0) return refused('csv', refusal('no_text'));

  const pages = renderTable({
    name,
    noun: 'Table',
    rows,
    merged: [],
    hidden: false,
    truncatedAt: truncated ? MAX_CSV_ROWS + skipLines : null,
  });
  return {
    ok: true,
    kind: 'csv',
    totalPages: pages.length,
    pages: pages.map((page, index) => ({
      pageNo: index + 1,
      label: page.label,
      text: page.text,
      method: 'csv_parse',
    })),
    vision: [],
    notes: truncated
      ? [`This file is very long: only its first ${String(MAX_CSV_ROWS)} rows were read.`]
      : [],
    dispose: noop,
  };
}

export function readTextBytes(bytes: Uint8Array): Extraction {
  const decoded = decodeText(bytes);
  // A "text" file that is mostly replacement characters was never text.
  const broken = (decoded.text.match(/\u{FFFD}/gu) ?? []).length;
  if (broken > Math.max(8, decoded.text.length / 50))
    return refused('text', refusal('unsupported'));
  const parts = splitIntoParts(decoded.text.replace(/\r\n?/g, '\n').trim());
  if (parts.length === 0) return refused('text', refusal('no_text'));
  return {
    ok: true,
    kind: 'text',
    totalPages: parts.length,
    pages: parts.map((text, index) => ({
      pageNo: index + 1,
      label: parts.length === 1 ? 'Text' : `Part ${String(index + 1)} of ${String(parts.length)}`,
      text,
      method: 'plain_text',
    })),
    vision: [],
    notes: [],
    dispose: noop,
  };
}

export const csvExtractor: FileExtractor = {
  kind: 'csv',
  extract: (input: ExtractInput): Promise<Extraction> =>
    Promise.resolve(readCsvBytes(input.bytes, input.name)),
};

export const textExtractor: FileExtractor = {
  kind: 'text',
  extract: (input: ExtractInput): Promise<Extraction> =>
    Promise.resolve(readTextBytes(input.bytes)),
};
