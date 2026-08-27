/**
 * System prompt for the chat path. The SHAPE is what client.ts depends on: an ordered list
 * of blocks, with a cache breakpoint after the stable prefix. The CONTENT is the voice and
 * brand layer in src/lib/voice/ (Stage 2 part 5), built from CLIENT-CONTEXT.md §1, §9, §10
 * and §11 with every rule citing its section.
 *
 * Kept as a separate module so the LLM layer imports a shape, not a brand: the voice can
 * change version without client.ts or chat.ts knowing.
 */
import { buildVoiceSystemBlocks } from '../voice/prompt.js';

export interface SystemBlock {
  readonly text: string;
  /** Put a cache breakpoint after this block. Only the stable prefix should say true. */
  readonly cache: boolean;
}

/**
 * `belowBreakpoint` (Stage 3 part 2) is the recalled-memory block: per-turn, uncached,
 * after the voice prefix so the prefix's cache entry is untouched by it.
 */
export function buildSystemBlocks(belowBreakpoint?: string): readonly SystemBlock[] {
  return buildVoiceSystemBlocks(belowBreakpoint === undefined ? {} : { belowBreakpoint });
}
