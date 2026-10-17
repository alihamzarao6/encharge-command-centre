import { describe, expect, it } from 'vitest';

import {
  dropTest,
  scrubFixtureDescription,
  scrubReferences,
} from '../../../scripts/client-export/scrub.js';
import {
  directiveReplacement,
  stripBlockComments,
  stripForPath,
  stripHashLines,
  stripHtmlComments,
  stripSqlComments,
  stripTsComments,
} from '../../../scripts/client-export/strip.js';

describe('stripTsComments', () => {
  it('removes line, block and doc comments and the lines they leave empty', () => {
    const src = [
      '/**',
      ' * Header (D12).',
      ' */',
      "import { x } from './x.js';",
      '',
      '// why this exists',
      'export const y = x + 1; // trailing',
      '',
    ].join('\n');
    expect(stripTsComments(src, 'a.ts')).toBe(
      ["import { x } from './x.js';", '', 'export const y = x + 1;', ''].join('\n'),
    );
  });

  it('never touches comment-shaped text inside strings, templates or regexes', () => {
    const src = [
      "const a = 'http://example.com // not a comment';",
      'const b = `/* still text */ ${a} // also text`;',
      'const c = /\\/\\/ not a comment/;',
      '',
    ].join('\n');
    expect(stripTsComments(src, 'a.ts')).toBe(src);
  });

  it('keeps blank lines and trailing spaces inside a template string', () => {
    const src = 'const t = `line one  \n\n\nline two`;\n// gone\nexport { t };\n';
    expect(stripTsComments(src, 'a.ts')).toBe(
      'const t = `line one  \n\n\nline two`;\nexport { t };\n',
    );
  });

  it('leaves JSX text alone and removes an empty {/* */} expression entirely', () => {
    const src = [
      'export const A = () => (',
      '  <p>',
      '    {/* a note */}',
      '    see https://example.com // literally',
      '  </p>',
      ');',
      '',
    ].join('\n');
    const out = stripTsComments(src, 'a.tsx');
    expect(out).not.toContain('a note');
    expect(out).not.toContain('{}');
    expect(out).toContain('see https://example.com // literally');
  });

  it('keeps a line break where a multi-line comment separated code', () => {
    const out = stripTsComments('const a = 1 /* one\ntwo */ const b = 2;\n', 'a.ts');
    expect(out).toBe('const a = 1\n const b = 2;\n');
  });

  it('keeps directives without their free-text reasons', () => {
    const src = [
      '// eslint-disable-next-line no-control-regex -- the point (D90)',
      'const r = /[\\x00]/;',
      '',
    ].join('\n');
    expect(stripTsComments(src, 'a.ts')).toBe(
      ['// eslint-disable-next-line no-control-regex', 'const r = /[\\x00]/;', ''].join('\n'),
    );
  });

  it('leaves a neutral comment in a block that held only comments (lint: no-empty)', () => {
    const src = [
      'try {',
      '  run();',
      '} catch {',
      '  // already gone — nothing to do (D12)',
      '  /* second */',
      '}',
      'const noop = (): void => { /* nothing */ };',
      '',
    ].join('\n');
    expect(stripTsComments(src, 'a.ts')).toBe(
      [
        'try {',
        '  run();',
        '} catch {',
        '  // ignore',
        '}',
        'const noop = (): void => { /* intentionally empty */ };',
        '',
      ].join('\n'),
    );
  });

  it('keeps a shebang', () => {
    expect(stripTsComments('#!/usr/bin/env node\n// x\nrun();\n', 'a.js')).toBe(
      '#!/usr/bin/env node\nrun();\n',
    );
  });

  it('refuses a source holding a NUL character rather than guess', () => {
    expect(() => stripTsComments('const a = "\u0000"; // x\n', 'a.ts')).toThrow(/NUL/);
  });
});

describe('directiveReplacement', () => {
  it.each([
    ['/* eslint-disable a,\n   b --\n   reason */', '/* eslint-disable a, b */'],
    ['// @ts-nocheck -- Deno globals', '// @ts-nocheck'],
    ['/* @vite-ignore */', '/* @vite-ignore */'],
    ['/// <reference types="vite/client" />', '/// <reference types="vite/client" />'],
  ])('%s', (input, expected) => {
    expect(directiveReplacement(input)).toBe(expected);
  });

  it('is undefined for an ordinary comment', () => {
    expect(directiveReplacement('// just prose')).toBeUndefined();
  });
});

describe('stripSqlComments', () => {
  it('removes -- and nested block comments, keeping quoted text', () => {
    const src = [
      '-- header',
      'select \'-- kept\', "a--b" /* outer /* inner */ still */ from t; -- trailing',
      "select E'it\\'s -- kept';",
      '',
    ].join('\n');
    expect(stripSqlComments(src)).toBe(
      ['select \'-- kept\', "a--b"  from t;', "select E'it\\'s -- kept';", ''].join('\n'),
    );
  });

  it('strips inside a dollar-quoted body but not its strings', () => {
    const src = [
      'create function f() returns text language plpgsql as $$',
      'begin',
      '  -- explain',
      "  return 'a -- b';",
      'end;',
      '$$;',
      '',
    ].join('\n');
    expect(stripSqlComments(src)).toBe(
      [
        'create function f() returns text language plpgsql as $$',
        'begin',
        "  return 'a -- b';",
        'end;',
        '$$;',
        '',
      ].join('\n'),
    );
  });
});

describe('the other formats', () => {
  it('hash lines go, inline # stays', () => {
    expect(stripHashLines('# note\nKEY=a#b\n  # indented\nB=1\n')).toBe('KEY=a#b\nB=1\n');
  });

  it('CSS block comments go, quoted text stays', () => {
    expect(stripBlockComments('/* x */\na { content: "/* y */"; }\n', false)).toBe(
      'a { content: "/* y */"; }\n',
    );
  });

  it('HTML comments go', () => {
    expect(stripHtmlComments('<!-- x -->\n<p>a</p>\n')).toBe('<p>a</p>\n');
  });

  it('dispatches by path and copies unknown types untouched', () => {
    expect(stripForPath('a/b.png', 'x')).toBeUndefined();
    expect(stripForPath('supabase/config.toml', '# a\nb = 1\n')).toBe('b = 1\n');
    expect(stripForPath('tsconfig.json', '{\n  // a\n  "b": 1\n}\n')).toBe('{\n  "b": 1\n}\n');
  });
});

describe('scrubReferences', () => {
  it.each([
    ["fail('the brand is Fundd (D25)')", "fail('the brand is Fundd')"],
    ["'not set (Stage 3, R5); the chat'", "'not set; the chat'"],
    ["'(append-only, D10). Current'", "'(append-only). Current'"],
    ["'Milestone 5 parts 1, 2 and 3a (D85, D95, D121). Deletes'", "'Deletes'"],
    ["'14 Oct 2026 (D111). Run by'", "'Run by'"],
    ["it('D72: an admin', ...)", "it('an admin', ...)"],
    ["it('11. Stage 3 part 5 (R27): the invariant')", "it('11. the invariant')"],
    ["it('D72 never masks it')", "it('the rule never masks it')"],
    ["'rotate it now (docs/RUNBOOK.md §4).'", "'rotate it now.'"],
    ["'the three added in Stage 3 part 4'", "'the three added'"],
    ["source: 'CLIENT-CONTEXT §9'", "source: 'brand guide §9'"],
  ])('%s', (input, expected) => {
    expect(scrubReferences(input)).toBe(expected);
  });

  it('leaves ad labels, spreadsheet cells, call arguments and dated data alone', () => {
    const untouched = [
      "const GOOGLE_LABELS = ['H1', 'H2', 'H3', 'D1', 'D2'] as const;",
      "expect(text).toContain('A1:D1');",
      'const v = f(D10);',
      "'created since 14 Oct 2026'",
    ];
    for (const line of untouched) expect(scrubReferences(line)).toBe(line);
  });

  it('moves e2e screenshots out of the docs folder', () => {
    expect(scrubReferences("new URL('../../docs/assets/milestone-5/', import.meta.url)")).toBe(
      "new URL('.output/screenshots/', import.meta.url)",
    );
  });

  it('touches only the description line of a fixture', () => {
    const src = '{\n  "description": "Prompts (Stage 2 part 5, FND-240). Each",\n  "x": "(D40)"\n}';
    expect(scrubFixtureDescription(src)).toBe(
      '{\n  "description": "Prompts. Each",\n  "x": "(D40)"\n}',
    );
  });
});

describe('dropTest', () => {
  const src = [
    "import { readFileSync } from 'node:fs';",
    "import { describe, expect, it } from 'vitest';",
    '',
    "describe('x', () => {",
    "  it('reads the internal doc', () => {",
    "    expect(readFileSync('a', 'utf8')).toBe('');",
    '  });',
    '',
    "  it('stays', () => {",
    '    expect(1).toBe(1);',
    '  });',
    '});',
    '',
  ].join('\n');

  it('removes the named test and the import only it used', () => {
    const out = dropTest(src, 'a.test.ts', 'reads the internal doc');
    expect(out).not.toContain('reads the internal doc');
    expect(out).not.toContain('readFileSync');
    expect(out).toContain("it('stays'");
    expect(out).toContain("import { describe, expect, it } from 'vitest';");
  });

  it('refuses when the test is not there, so a rename upstream cannot pass silently', () => {
    expect(() => dropTest(src, 'a.test.ts', 'no such test')).toThrow(/no test titled/);
  });
});
