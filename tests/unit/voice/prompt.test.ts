/**
 * The voice prompt builder (src/lib/voice/prompt.ts + rules.ts): traceability, the cache
 * shape, version pinning, and the things the prompt must and must not say.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSystemBlocks } from '../../../src/lib/llm/prompt.js';
import {
  MAX_BELOW_BREAKPOINT_CHARS,
  VOICE_PROMPT_VERSION,
  buildVoicePrefix,
  buildVoiceSystemBlocks,
  fnv1a32,
  voicePromptHash,
} from '../../../src/lib/voice/prompt.js';
import { BRAND_NAME, VOICE_SECTIONS, allRules } from '../../../src/lib/voice/rules.js';

describe('traceability (acceptance item 7)', () => {
  it('every rule carries a source, and ids are unique', () => {
    const rules = allRules();
    expect(rules.length).toBeGreaterThanOrEqual(25);
    for (const rule of rules) {
      expect(rule.source.length).toBeGreaterThan(0);
      expect(rule.text.trim()).toBe(rule.text);
      expect(rule.text.length).toBeGreaterThan(20);
    }
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only the delivery-mechanics rules are unsourced from the client docs', () => {
    const mechanics = allRules().filter((r) => r.source === 'mechanics');
    expect(mechanics.every((r) => r.id.startsWith('format.'))).toBe(true);
  });

  it('every rule id is in the traceability table in docs/VOICE.md', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'VOICE.md'),
      'utf8',
    );
    for (const rule of allRules()) {
      expect(doc, `docs/VOICE.md §2 is missing ${rule.id} — regenerate the table`).toContain(
        `\`${rule.id}\` | ${rule.source} |`,
      );
    }
  });

  it('every rule text appears verbatim in the assembled prefix', () => {
    const prefix = buildVoicePrefix();
    for (const rule of allRules()) {
      expect(prefix).toContain(rule.text);
    }
    for (const section of VOICE_SECTIONS) {
      expect(prefix).toContain(`## ${section.heading}`);
    }
  });
});

describe('content', () => {
  const prefix = buildVoicePrefix();

  it('states the brand, the pillars, the frameworks, the avatar, the ops rules and the boundary', () => {
    expect(prefix).toContain(BRAND_NAME);
    expect(prefix).toContain('40+ lenders');
    expect(prefix).toContain('first call to settlement');
    expect(prefix).toContain('Long-term partnership');
    expect(prefix).toContain('Red Brain');
    expect(prefix).toContain('Green Brain');
    expect(prefix).toContain('Rule of One');
    expect(prefix).toContain('under 28 characters');
    expect(prefix).toContain('H1 the service keyword');
    expect(prefix).toContain('25 to 38');
    expect(prefix).toContain('within five minutes');
    expect(prefix).toContain('within the next two days');
    expect(prefix).toContain('Never give personal credit advice');
    expect(prefix).toContain('Never invent a fact');
    expect(prefix).toContain('Australian English');
  });

  it('never carries the stale stack, a secret shape, or parked research-engine material', () => {
    expect(prefix).not.toMatch(/hubspot/i);
    expect(prefix).not.toMatch(/sk-ant-/);
    expect(prefix).not.toMatch(
      /rubric|decision[- ]maker|email verification|MillionVerifier|Serper/i,
    );
  });

  it('is long enough for Sonnet prompt caching (≥ 1,024 tokens at ~4 chars/token)', () => {
    expect(prefix.length).toBeGreaterThanOrEqual(1_024 * 4);
  });

  it('names its version in the first line', () => {
    expect(prefix.split('\n')[0]).toContain(`v${VOICE_PROMPT_VERSION}`);
    expect(VOICE_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});

describe('cache shape', () => {
  it('one cached prefix block by default; the LLM layer delegates to it', () => {
    const blocks = buildVoiceSystemBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache).toBe(true);
    expect(blocks[0]?.text).toBe(buildVoicePrefix());
    expect(buildSystemBlocks()).toEqual(blocks);
  });

  it('material below the breakpoint is a second, uncached, bounded block', () => {
    const blocks = buildVoiceSystemBlocks({ belowBreakpoint: '  Ross said: shorter hooks.  ' });
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ text: 'Ross said: shorter hooks.', cache: false });
    expect(buildVoiceSystemBlocks({ belowBreakpoint: '   ' })).toHaveLength(1);
    const long = buildVoiceSystemBlocks({
      belowBreakpoint: 'x'.repeat(MAX_BELOW_BREAKPOINT_CHARS + 1),
    });
    expect(long[1]?.text.length).toBe(MAX_BELOW_BREAKPOINT_CHARS);
  });
});

describe('version pin', () => {
  it('hash is deterministic and changes with the text', () => {
    expect(voicePromptHash()).toBe(fnv1a32(buildVoicePrefix()));
    expect(voicePromptHash()).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('a')).not.toBe(fnv1a32('b'));
    expect(fnv1a32('')).toBe('811c9dc5');
  });
});
