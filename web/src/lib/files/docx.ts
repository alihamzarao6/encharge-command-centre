/**
 * Reading a Word document (.docx / .docm) — Milestone 5 part 1, D84.
 *
 * `word/document.xml`, walked in document order: paragraphs become lines, a table row
 * becomes one line with its cells separated by " | ", headings keep a mark. Word has no
 * reliable pages — pagination is decided by whatever prints it — so the text is cut into
 * parts of a few thousand characters at paragraph boundaries and each is called "Part n".
 *
 * Not read, and said so nowhere but here: headers, footers, footnotes, comments and tracked
 * DELETIONS (`w:delText`). Field codes (`w:instrText`) are skipped too — they are the
 * formula, not the text a reader sees. Macros are never run.
 */
import { refusal } from '../../../../src/lib/files/limits.js';
import { splitIntoParts } from './tabular.js';
import { noop, refused, type ExtractInput, type Extraction, type FileExtractor } from './types.js';
import { xmlTokens } from './xml.js';
import { MACROS_NOTE, entryText, hasMacros, readZipEntries } from './zip.js';

/** `word/document.xml` as lines of text. Exported for the unit tests. */
export function documentXmlToText(xml: string): string {
  const lines: string[] = [];
  let paragraph = '';
  let heading = false;
  let inText = false;
  let fallback = 0;
  let tableDepth = 0;
  let row: string[] = [];
  let cell: string[] = [];

  const endParagraph = (): void => {
    const text = paragraph.replace(/[ \t]+$/g, '');
    paragraph = '';
    const line = heading && text.trim() !== '' ? `# ${text.trim()}` : text;
    heading = false;
    if (tableDepth > 0) {
      if (line.trim() !== '') cell.push(line.trim());
    } else {
      lines.push(line);
    }
  };

  for (const token of xmlTokens(xml)) {
    if (token.type === 'open') {
      // A modern drawing and its legacy fallback carry the SAME text twice: read one.
      if (token.name === 'Fallback') {
        if (!token.selfClosing) fallback += 1;
        continue;
      }
      if (fallback > 0) continue;
      switch (token.name) {
        case 't':
          inText = !token.selfClosing;
          break;
        case 'tab':
          paragraph += '\t';
          break;
        case 'br':
        case 'cr':
          paragraph += '\n';
          break;
        case 'pStyle':
          if (/^heading\s?\d/i.test(token.attrs['val'] ?? '') || token.attrs['val'] === 'Title') {
            heading = true;
          }
          break;
        case 'tbl':
          if (!token.selfClosing) tableDepth += 1;
          break;
        case 'tr':
          if (tableDepth === 1) row = [];
          break;
        case 'tc':
          if (tableDepth === 1) cell = [];
          break;
        case 'p':
          if (token.selfClosing) endParagraph();
          break;
        default:
          break;
      }
    } else if (token.type === 'close') {
      if (token.name === 'Fallback') {
        fallback = Math.max(0, fallback - 1);
        continue;
      }
      if (fallback > 0) continue;
      switch (token.name) {
        case 't':
          inText = false;
          break;
        case 'p':
          endParagraph();
          break;
        case 'tc':
          // A nested table's cells fold into the cell that holds it.
          if (tableDepth === 1) row.push(cell.join(' / '));
          break;
        case 'tr':
          if (tableDepth === 1 && row.some((value) => value !== '')) lines.push(row.join(' | '));
          break;
        case 'tbl':
          tableDepth = Math.max(0, tableDepth - 1);
          if (tableDepth === 0) lines.push('');
          break;
        default:
          break;
      }
    } else if (inText && fallback === 0) {
      paragraph += token.text;
    }
  }
  if (paragraph.trim() !== '') endParagraph();
  return lines.join('\n');
}

export function readDocumentBytes(bytes: Uint8Array): Extraction {
  const read = readZipEntries(bytes, (name) => name === 'word/document.xml');
  if (!read.ok) return refused('docx', refusal(read.reason));
  const xml = entryText(read.files, 'word/document.xml');
  if (xml === null) return refused('docx', refusal('corrupt'));
  const parts = splitIntoParts(
    documentXmlToText(xml)
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  if (parts.length === 0) return refused('docx', refusal('no_text'));
  return {
    ok: true,
    kind: 'docx',
    totalPages: parts.length,
    pages: parts.map((text, index) => ({
      pageNo: index + 1,
      label:
        parts.length === 1 ? 'Document' : `Part ${String(index + 1)} of ${String(parts.length)}`,
      text,
      method: 'docx_xml',
    })),
    vision: [],
    notes: hasMacros(read.names) ? [MACROS_NOTE] : [],
    dispose: noop,
  };
}

export const docxExtractor: FileExtractor = {
  kind: 'docx',
  extract: (input: ExtractInput): Promise<Extraction> =>
    Promise.resolve(readDocumentBytes(input.bytes)),
};
