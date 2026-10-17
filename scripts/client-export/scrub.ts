/**
 * Planning references left in strings once the comments are gone: test titles, log messages,
 * SQL `comment on` text, labels. Pure, and applied identically to source and tests, so a string
 * an assertion compares against changes on both sides at once — the export's own test run is
 * the proof that nothing it touched was load-bearing.
 *
 * D1–D3 are never treated as references: in this codebase they are Google ad description lines
 * (H1 · H2 · H3 · D1 · D2) and spreadsheet cells (A1:D1), not decisions.
 */
import ts from 'typescript';

const MONTH = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*`;
const PARTS = String.raw`\d+[a-z]?(?:(?:,\s*|\s+and\s+)\d+[a-z]?)*`;

/** One reference: a decision, a risk, a ticket, a delivery stage, a date stamp, a doc section. */
const REF = [
  String.raw`D(?:[4-9]|[1-9]\d{1,2})(?:\s+stands)?`,
  String.raw`R\d{1,2}`,
  String.raw`FND-\d+`,
  String.raw`(?:[Mm]ilestone|[Ss]tage)\s+\d+(?:\s+parts?\s+${PARTS})?(?:\s+review)?`,
  String.raw`\d{1,2}\s+${MONTH}\s+20\d\d`,
  String.raw`(?:docs\/)?[A-Z][A-Za-z-]*(?:\.md)?\s+§\s?\d+[a-z]?(?:\.\d+)*`,
  String.raw`docs\/[A-Za-z-]+\.md`,
  String.raw`TASKS\s+\d+(?:\.\d+)+`,
].join('|');
const LIST = String.raw`(?:${REF})(?:(?:\s*[,;/]\s*|\s+and\s+)(?:${REF}))*`;

type Rule = readonly [RegExp, string];

/** Applied in order. Each one is the narrowest pattern that covers the cases found. */
const RULES: readonly Rule[] = [
  // Labels on the voice rules: where a rule came from, renamed for a reader without the docs.
  [/'CLIENT-CONTEXT §(\d+)'/g, "'brand guide §$1'"],
  [/'MEMORY D(\d+)'/g, "'brand decision $1'"],
  [/'MEMORY R(\d+)'/g, "'house rule $1'"],
  [/'FND-240 brief §(\d+)'/g, "'content brief §$1'"],
  // Screenshots go to the gitignored output folder instead of the internal docs.
  [
    /new URL\('\.\.\/\.\.\/docs\/assets\/(?:stage|milestone)-\d+\/', import\.meta\.url\)/g,
    "new URL('.output/screenshots/', import.meta.url)",
  ],
  [/docs\/assets\/stage-\d+\/\*\.png/g, 'tests/e2e/.output/screenshots/*.png'],
  [/\bstage-2-screenshots\b/g, 'e2e-screenshots'],
  // One-offs whose wording only made sense next to the delivery plan.
  [/ \(the Milestone 4 part 4 trail\)/g, ' (the move trail)'],
  [/\(Stage 2 shape\)/g, '(no-memory shape)'],
  [/a later milestone/g, 'a later release'],
  [/a parked SCHEMA\.md section/g, 'a parked schema section'],
  [/MCP connector, stage 1\. /g, ''],
  // " (D85, D95)", " (Stage 3 part 5b, D70)", " (docs/RUNBOOK.md §4)".
  [new RegExp(String.raw`[ \t]+\(${LIST}\)`, 'g'), ''],
  // "(append-only, D10)" → "(append-only)".
  [new RegExp(String.raw`\s*[,;]\s*${LIST}(?=\))`, 'g'), ''],
  // "added in Stage 3 part 4" → "added". Delivery stages only: "since 14 Oct 2026" can be data.
  [
    new RegExp(
      String.raw`\s+(?:in|since|from)\s+(?:[Mm]ilestone|[Ss]tage)\s+\d+(?:\s+parts?\s+${PARTS})?\b`,
      'g',
    ),
    '',
  ],
  // A string that opens with a reference: 'D72: …', '11. Stage 3 part 5: …', 'Milestone 5 part 1. …'.
  [new RegExp(String.raw`(['"\`])(\d+\.\s+)?${LIST}\s*[:.]\s+`, 'g'), '$1$2'],
  // 'D72 does not …' → 'the rule does not …'.
  [/(['"`])D\d{2,3}\s+(?=[a-z])/g, '$1the rule '],
];

export function scrubReferences(text: string): string {
  let next = text;
  for (const [pattern, replacement] of RULES) next = next.replace(pattern, replacement);
  return next;
}

/** Fixture JSON keeps its data; only its human-written description is scrubbed. */
export function scrubFixtureDescription(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*"description":/.test(line) ? scrubReferences(line) : line))
    .join('\n');
}

/**
 * Remove the test call whose title starts with `title` (a whole `it(...)` / `test(...)`
 * statement, found by the parser), then any named import the removal left unused.
 */
export function dropTest(text: string, path: string, title: string): string {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let target: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      target === undefined &&
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ['it', 'test'].includes(node.expression.expression.text)
    ) {
      const first = node.expression.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first) && first.text.startsWith(title)) {
        target = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (target === undefined) throw new Error(`dropTest: no test titled "${title}" in ${path}`);
  const removed = text.slice(0, target.getStart(sf)) + text.slice(target.end).replace(/^\n/, '');
  return pruneImports(removed, path);
}

function pruneImports(text: string, path: string): string {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: { pos: number; end: number; replacement: string }[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const rest = text.slice(0, statement.getStart(sf)) + text.slice(statement.end);
    const used = bindings.elements.filter((el) =>
      new RegExp(String.raw`\b${el.name.text}\b`).test(rest),
    );
    if (used.length === bindings.elements.length) continue;
    const end = text[statement.end] === '\n' ? statement.end + 1 : statement.end;
    if (used.length === 0) {
      edits.push({ pos: statement.getStart(sf), end, replacement: '' });
    } else {
      const names = used.map((el) => el.getText(sf)).join(', ');
      edits.push({ pos: bindings.getStart(sf), end: bindings.end, replacement: `{ ${names} }` });
    }
  }
  let next = text;
  for (const e of edits.sort((a, b) => b.pos - a.pos)) {
    next = next.slice(0, e.pos) + e.replacement + next.slice(e.end);
  }
  return next;
}
