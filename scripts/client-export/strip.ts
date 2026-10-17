/**
 * Comment removal for the client export. Pure: text in, text out.
 *
 * Every remover works from a real tokenizer — the TypeScript parser for code, a small lexer for
 * SQL, CSS and JSONC — so a `//` or `--` inside a string, a template, a regex, a dollar-quoted
 * body or JSX text is never mistaken for a comment. Tooling directives survive (a dropped
 * `eslint-disable` or `@ts-nocheck` would change what lint and the compiler do), stripped of
 * their free-text reasons.
 */
import ts from 'typescript';

interface Range {
  readonly pos: number;
  readonly end: number;
  readonly replacement: string;
}

const DIRECTIVE =
  /^(?:\/\/\/?|\/\*+)\s*(eslint-disable(?:-next-line|-line)?|eslint-enable|@ts-nocheck|@ts-expect-error|@ts-ignore|@ts-check|prettier-ignore|[vc]8 ignore|istanbul ignore|@vite-ignore|deno-lint-ignore(?:-file)?|<reference\b)/;

/**
 * What a directive comment becomes: the directive and its rule list, no reason. Undefined when
 * the comment is not a directive and should go.
 */
export function directiveReplacement(comment: string): string | undefined {
  const match = DIRECTIVE.exec(comment);
  if (match === null) return undefined;
  const isBlock = comment.startsWith('/*');
  const body = (isBlock ? comment.replace(/^\/\*+/, '').replace(/\*+\/$/, '') : comment)
    .replace(/^\/\/\/?/, '')
    .trim();
  if (body.startsWith('<reference')) return comment;
  const head = (body.split(/\s--\s|\s--$/)[0] ?? body).replace(/\s+/g, ' ').trim();
  const kept = head.startsWith('@ts-expect-error') || head.startsWith('@ts-ignore') ? body : head;
  return isBlock ? `/* ${kept.replace(/,$/, '')} */` : `// ${kept}`;
}

/** Marks where something was removed, so only those lines are tidied afterwards. */
const MARK = '\u0000';

/**
 * Apply removals. Only lines a removal touched are tidied: one left holding nothing but
 * whitespace is dropped, trailing space before a removed end-of-line comment goes, and a blank
 * line that dropping created next to another blank is merged. Every untouched line — including
 * blank lines and trailing spaces inside template strings — is kept byte for byte.
 */
function applyRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text;
  if (text.includes(MARK)) throw new Error('source contains a NUL character; refusing to strip');
  const sorted = [...ranges].sort((a, b) => a.pos - b.pos);
  let out = '';
  let cursor = 0;
  for (const r of sorted) {
    if (r.pos < cursor) continue;
    const removed = text.slice(r.pos, r.end);
    const lineStart = text.lastIndexOf('\n', r.pos - 1) + 1;
    const lineEnd = text.indexOf('\n', r.end);
    const codeBefore = text.slice(lineStart, r.pos).trim() !== '';
    const codeAfter = text.slice(r.end, lineEnd === -1 ? text.length : lineEnd).trim() !== '';
    // A comment spanning lines is a line break to the grammar (ASI); keep one if code is on both sides.
    const keepBreak = removed.includes('\n') && codeBefore && codeAfter && r.replacement === '';
    out += text.slice(cursor, r.pos) + MARK + (keepBreak ? '\n' + MARK : r.replacement);
    cursor = r.end;
  }
  out += text.slice(cursor);
  return tidy(out);
}

function tidy(marked: string): string {
  const lines = marked.split('\n');
  const kept: string[] = [];
  let droppedSinceLast = false;
  let droppedAtStart = true;
  for (const line of lines) {
    if (!line.includes(MARK)) {
      const blank = line.trim() === '';
      const prevBlank = kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '';
      if (blank && droppedSinceLast && (prevBlank || (kept.length === 0 && droppedAtStart))) {
        droppedSinceLast = false;
        continue;
      }
      kept.push(line);
      droppedSinceLast = false;
      droppedAtStart = false;
      continue;
    }
    const cleaned = line
      .split(MARK)
      .join('')
      .replace(/[ \t]+$/, '');
    if (cleaned.trim() === '') {
      droppedSinceLast = true;
      continue;
    }
    kept.push(cleaned);
    droppedSinceLast = false;
    droppedAtStart = false;
  }
  return kept.join('\n');
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** TypeScript / JavaScript / TSX: every comment range the parser reports, directives rewritten. */
export function stripTsComments(text: string, path: string): string {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const found = new Map<number, ts.CommentRange>();
  const jsxText: (readonly [number, number])[] = [];
  const emptyJsx: Range[] = [];
  const emptyBlocks: (readonly [number, number, boolean])[] = [];

  const collect = (pos: number): void => {
    for (const r of ts.getLeadingCommentRanges(text, pos) ?? []) found.set(r.pos, r);
    for (const r of ts.getTrailingCommentRanges(text, pos) ?? []) found.set(r.pos, r);
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    if (ts.isJsxExpression(node) && node.expression === undefined) {
      emptyJsx.push({ pos: node.getStart(sf), end: node.end, replacement: '' });
    }
    if (ts.isBlock(node) && node.statements.length === 0) {
      emptyBlocks.push([node.getStart(sf), node.end, ts.isCatchClause(node.parent)]);
    }
    collect(node.pos);
    collect(node.end);
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);

  const insideJsxText = (r: ts.CommentRange): boolean =>
    jsxText.some(([pos, end]) => r.pos >= pos && r.end <= end);

  // An empty block that held only a comment keeps a neutral one: lint's no-empty and
  // no-empty-function accept a commented block, and the emptiness is deliberate.
  const placeholderFor = (r: ts.CommentRange): string | undefined => {
    const block = emptyBlocks.find(([pos, end]) => r.pos > pos && r.end < end);
    if (block === undefined) return undefined;
    const first = [...found.values()]
      .filter((c) => c.pos > block[0] && c.end < block[1])
      .sort((a, b) => a.pos - b.pos)[0];
    if (first?.pos !== r.pos) return '';
    const word = block[2] ? 'ignore' : 'intentionally empty';
    return r.kind === ts.SyntaxKind.SingleLineCommentTrivia ? `// ${word}` : `/* ${word} */`;
  };

  const ranges: Range[] = [...emptyJsx];
  for (const r of found.values()) {
    if (insideJsxText(r)) continue;
    if (emptyJsx.some((e) => r.pos >= e.pos && r.end <= e.end)) continue;
    const comment = text.slice(r.pos, r.end);
    if (comment.startsWith('#!')) continue;
    const replacement = directiveReplacement(comment);
    if (replacement === comment) continue;
    ranges.push({ pos: r.pos, end: r.end, replacement: replacement ?? placeholderFor(r) ?? '' });
  }
  return applyRanges(text, ranges);
}

/**
 * C-family lexer for CSS and JSONC: `/* *\/` (and `//` when allowed), skipping quoted strings.
 */
export function stripBlockComments(text: string, lineComments: boolean): string {
  const ranges: Range[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(text, i, c, true);
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      ranges.push({ pos: i, end: stop, replacement: '' });
      i = stop;
    } else if (lineComments && c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      ranges.push({ pos: i, end: stop, replacement: '' });
      i = stop;
    } else {
      i += 1;
    }
  }
  return applyRanges(text, ranges);
}

function skipQuoted(text: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (backslash && c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (!backslash && text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return i;
}

/**
 * PostgreSQL: `--` and nested `/* *\/`, outside '…' (with '' and E'…' escapes), "…" identifiers
 * and dollar quotes. A dollar-quoted body is a function body, so it is stripped too, recursively.
 */
export function stripSqlComments(text: string): string {
  return applyRanges(text, sqlRanges(text, 0, text.length));
}

function sqlRanges(text: string, from: number, to: number): Range[] {
  const ranges: Range[] = [];
  let i = from;
  while (i < to) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      const stop = nl === -1 || nl > to ? to : nl;
      ranges.push({ pos: i, end: stop, replacement: '' });
      i = stop;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < to && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      ranges.push({ pos: i, end: j, replacement: '' });
      i = j;
    } else if (c === "'") {
      const escaped = i > 0 && /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      i = skipQuoted(text, i, "'", escaped);
    } else if (c === '"') {
      i = skipQuoted(text, i, '"', false);
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      const prev = text[i - 1] ?? '';
      if (tag === null || /[A-Za-z0-9_]/.test(prev)) {
        i += 1;
        continue;
      }
      const open = tag[0];
      const bodyStart = i + open.length;
      const close = text.indexOf(open, bodyStart);
      const bodyEnd = close === -1 ? to : close;
      ranges.push(...sqlRanges(text, bodyStart, bodyEnd));
      i = close === -1 ? to : close + open.length;
    } else {
      i += 1;
    }
  }
  return ranges;
}

/**
 * `#` comment lines (TOML, YAML, shell, ignore files, .env). Whole lines only — an inline `#`
 * can be data (a colour, a URL fragment, a shell parameter), so it is left alone. A shebang stays.
 */
export function stripHashLines(text: string): string {
  const ranges: Range[] = [];
  let start = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#') && !(start === 0 && t.startsWith('#!'))) {
      ranges.push({ pos: start, end: start + line.length, replacement: '' });
    }
    start += line.length + 1;
  }
  return applyRanges(text, ranges);
}

/** HTML outside fixtures: `<!-- -->`. */
export function stripHtmlComments(text: string): string {
  const ranges: Range[] = [];
  const re = /<!--[\s\S]*?-->/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    ranges.push({ pos: m.index, end: m.index + m[0].length, replacement: '' });
  }
  return applyRanges(text, ranges);
}

const HASH_FILES = new Set([
  '.gitignore',
  '.prettierignore',
  '.gitattributes',
  '.nvmrc',
  '.env.example',
  'pre-commit',
]);

/** Dispatch by file name. Undefined means the file is copied byte for byte. */
export function stripForPath(path: string, text: string): string | undefined {
  const name = path.split('/').pop() ?? path;
  if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !name.endsWith('.d.ts'))
    return stripTsComments(text, path);
  if (name.endsWith('.d.ts')) return stripTsComments(text, path);
  if (name.endsWith('.sql')) return stripSqlComments(text);
  if (name.endsWith('.css')) return stripBlockComments(text, false);
  if (/(?:^|\/)(?:tsconfig[^/]*|deno)\.json$/.test(path)) return stripBlockComments(text, true);
  if (/\.(?:toml|ya?ml)$/.test(name) || HASH_FILES.has(name)) return stripHashLines(text);
  if (name.endsWith('.html')) return stripHtmlComments(text);
  return undefined;
}
