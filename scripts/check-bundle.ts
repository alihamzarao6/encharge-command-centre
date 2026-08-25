/**
 * The assertion parts 3 and 4 deferred until a bundle existed (TASKS 2.6.3, SECURITY §2):
 * the built client contains no service role key, no Anthropic key, and no fragment of the
 * voice prompt. Greps the REAL build output (web/dist), not the source.
 *
 * Three kinds of check, because a secret can leak three ways:
 *   1. Shape — any string that looks like an Anthropic key, a Supabase secret key, or a
 *      JWT whose payload claims `service_role`, whatever variable it came from.
 *   2. Value — the actual keys from the environment this build ran in, if present. A build
 *      on the deploy machine has them in .env; the grep proves they did not travel.
 *   3. Voice — distinctive sentences from src/lib/voice/rules.ts and the prompt version tag.
 *      The prompt is the client's paid deliverable and assembles server-side only.
 *
 * Exit 1 on any hit. Prints what it looked for and where, so the report can paste it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { VOICE_PROMPT_VERSION } from '../src/lib/voice/prompt.js';
import { VOICE_SECTIONS } from '../src/lib/voice/rules.js';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'web', 'dist');

interface Finding {
  readonly file: string;
  readonly check: string;
  readonly snippet: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Real key SHAPES. The logger's redaction pattern `sk-ant-` alone is not a key. */
const SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'anthropic-key-shape', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'supabase-secret-key-shape', pattern: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  {
    name: 'jwt-shape',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

function decodeJwtRole(token: string): string | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && 'role' in parsed) {
      return typeof parsed.role === 'string' ? parsed.role : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Sentences of the voice prompt long enough to be unmistakable. */
export function voiceProbes(): readonly string[] {
  const probes: string[] = [`v${VOICE_PROMPT_VERSION}`];
  for (const section of VOICE_SECTIONS) {
    for (const rule of section.rules) {
      const sentence = rule.text.split(/(?<=[.!?])\s/)[0] ?? rule.text;
      if (sentence.length >= 40) probes.push(sentence);
    }
  }
  return probes;
}

export function scan(
  files: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Finding[] {
  const findings: Finding[] = [];
  const probes = voiceProbes();
  const values = [
    ['SUPABASE_SERVICE_ROLE_KEY', env['SUPABASE_SERVICE_ROLE_KEY']],
    ['ANTHROPIC_API_KEY', env['ANTHROPIC_API_KEY']],
  ] as const;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    for (const shape of SHAPES) {
      const matches = text.match(shape.pattern) ?? [];
      for (const match of matches) {
        if (shape.name === 'jwt-shape') {
          const role = decodeJwtRole(match);
          // The anon key is a JWT and is allowed; only a service_role claim is a leak.
          if (role !== 'service_role') continue;
        }
        findings.push({ file: rel, check: shape.name, snippet: `${match.slice(0, 12)}…` });
      }
    }
    for (const [name, value] of values) {
      if (value !== undefined && value.length >= 16 && text.includes(value)) {
        findings.push({ file: rel, check: `value:${name}`, snippet: '[redacted]' });
      }
    }
    for (const probe of probes) {
      if (text.includes(probe)) {
        findings.push({ file: rel, check: 'voice-prompt', snippet: probe.slice(0, 40) });
      }
    }
  }
  return findings;
}

function main(): void {
  const files = walk(DIST);
  if (files.length === 0) {
    process.stderr.write('check-bundle: web/dist is empty — run `npm run web:build` first\n');
    process.exitCode = 1;
    return;
  }
  const probes = voiceProbes();
  const findings = scan(files, process.env);
  const lines = [
    `check-bundle: scanned ${String(files.length)} file(s) under web/dist`,
    ...files.map((f) => `  ${relative(ROOT, f)} (${String(statSync(f).size)} bytes)`),
    `  shapes: ${SHAPES.map((s) => s.name).join(', ')}`,
    `  values: SUPABASE_SERVICE_ROLE_KEY ${process.env['SUPABASE_SERVICE_ROLE_KEY'] === undefined ? '(unset — shape check only)' : '(present, checked)'}, ANTHROPIC_API_KEY ${process.env['ANTHROPIC_API_KEY'] === undefined ? '(unset — shape check only)' : '(present, checked)'}`,
    `  voice probes: ${String(probes.length)} sentences + version tag v${VOICE_PROMPT_VERSION}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (findings.length === 0) {
    process.stdout.write(
      'check-bundle: 0 hits — no service role key, no Anthropic key, no voice prompt\n',
    );
    return;
  }
  for (const f of findings) {
    process.stdout.write(`  HIT ${f.check} in ${f.file}: ${f.snippet}\n`);
  }
  process.stdout.write(`check-bundle: ${String(findings.length)} hit(s) — FAILED\n`);
  process.exitCode = 1;
}

main();
