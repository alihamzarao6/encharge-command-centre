/**
 * Assembles the voice system prompt from rules.ts (Stage 2 part 5). Pure.
 *
 * Shape: ONE long, unchanging block above the cache breakpoint (the whole voice), and an
 * optional short block below it for material that changes per call or per user (Stage 3
 * memory facts, part-6 operator corrections). Prompt caching on Sonnet needs ≥ 1,024 tokens
 * in the cached prefix; the assembled prefix is ~2,500 tokens, so the seam part 4 left in
 * client.ts starts paying from the first call of this part.
 *
 * Versioning: VOICE_PROMPT_VERSION is bumped by hand on every change to the rules; the
 * content hash is computed from the assembled text. The conformance fixtures record both,
 * and the suite fails if the assembled prompt no longer matches what the fixtures were
 * recorded against — a changed prompt with unchanged fixtures proves nothing. The hash is a
 * pin, not a security control, so a dependency-free FNV-1a is enough (it must also run
 * unchanged under Deno in the Edge Function, which rules out node:crypto).
 */
import type { SystemBlock } from '../llm/prompt.js';
import { BRAND_NAME, VOICE_SECTIONS, type VoiceSection } from './rules.js';

/** Bump on every rule change. Date-based so the version log in docs/VOICE.md reads in order. */
export const VOICE_PROMPT_VERSION = '2026-08-25.4';

export const MAX_BELOW_BREAKPOINT_CHARS = 4_000;

export interface VoiceSystemOptions {
  /**
   * Text placed BELOW the cache breakpoint: per-call or per-user material that must not
   * invalidate the cached prefix. Empty or whitespace-only is omitted entirely.
   */
  readonly belowBreakpoint?: string;
}

function renderSection(section: VoiceSection): string {
  const lines = section.rules.map((rule) => `- ${rule.text}`);
  return `## ${section.heading}\n${lines.join('\n')}`;
}

/** The cached prefix: identical on every call until the version changes. */
export function buildVoicePrefix(sections: readonly VoiceSection[] = VOICE_SECTIONS): string {
  const body = sections.map(renderSection).join('\n\n');
  return `# ${BRAND_NAME} voice and brand (v${VOICE_PROMPT_VERSION})\n\n${body}`;
}

/** FNV-1a, 32-bit, over UTF-16 code units. Deterministic across Node and Deno. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function voicePromptHash(): string {
  return fnv1a32(buildVoicePrefix());
}

export function buildVoiceSystemBlocks(options: VoiceSystemOptions = {}): readonly SystemBlock[] {
  const blocks: SystemBlock[] = [{ text: buildVoicePrefix(), cache: true }];
  const below = options.belowBreakpoint?.trim() ?? '';
  if (below !== '') {
    // Bounded so a runaway memory block cannot quietly swamp the request (and the cap).
    blocks.push({ text: below.slice(0, MAX_BELOW_BREAKPOINT_CHARS), cache: false });
  }
  return blocks;
}
