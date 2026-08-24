/**
 * PLACEHOLDER system prompt. Stage 2 part 5 replaces this with the voice and brand layer
 * built from CLIENT-CONTEXT.md §1, §9, §10 and §11 with a traceability table.
 *
 * What is real here is the SHAPE: an ordered list of stable blocks, the last of which
 * carries a cache breakpoint. Part 5 drops its long, unchanging prefix into the same shape
 * and caching starts paying without touching client.ts. (Prompt caching needs ≥ 1,024
 * tokens on Sonnet — this placeholder is far shorter, so `cache_read_input_tokens` stays 0
 * until part 5. That is expected, not a bug.)
 */

export interface SystemBlock {
  readonly text: string;
  /** Put a cache breakpoint after this block. Only the stable prefix should say true. */
  readonly cache: boolean;
}

export const PLACEHOLDER_MARKER = '[PLACEHOLDER SYSTEM PROMPT — Stage 2 part 5 replaces this]';

export const PLACEHOLDER_SYSTEM_PROMPT = `${PLACEHOLDER_MARKER}
You are an assistant for a Perth mortgage brokerage. The brand voice, positioning rules and
copy frameworks have NOT been loaded yet. Answer plainly and briefly. Do not invent rates,
figures, lender names or claims. If asked for marketing copy, say the voice layer is not
configured yet.`;

export function buildSystemBlocks(): readonly SystemBlock[] {
  return [{ text: PLACEHOLDER_SYSTEM_PROMPT, cache: true }];
}
