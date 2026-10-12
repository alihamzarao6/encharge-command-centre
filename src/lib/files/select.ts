/**
 * Which pages of a long document go in front of the model for THIS question (Milestone 5
 * part 1, D88). Pure.
 *
 * A file that fits the turn's budget is never ranked — it goes in whole, because a whole
 * document is the only honest basis for "what do the deposits add up to". This is for the
 * file that does not fit: a 200-page lender policy, of which a turn can carry a dozen pages.
 *
 * Ranking is BM25 over the pages, by the words of the question — in code, in process, with no
 * call to anyone. Embeddings were considered and rejected (D88): the Voyage account's rate
 * limit already degrades memory (D69), and a policy document would not embed under it at all.
 * The trade is known: a paraphrase ("can a contractor borrow 90%") matches less well than the
 * document's own vocabulary ("self-employed", "LVR") would. So the model is always told which
 * pages it was shown and of how many (context.ts), and the rules tell it to say so.
 *
 * Text without spaces between words (Chinese, Japanese, Thai) is matched as whole runs, which
 * is weak; such a document over the budget is effectively read from its start.
 */

// Words that carry no topic. Deliberately small: a term this drops can never be searched for.
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'so',
  'tell',
  'that',
  'the',
  'their',
  'there',
  'these',
  'this',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

export const QUERY_MESSAGE_MAX_CHARS = 1_000;
export const QUERY_PREVIOUS_MAX_CHARS = 300;

/** Lowercase words and numbers of any script; one-character tokens and stopwords dropped. */
export function tokenise(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

/**
 * The words to rank by: this message, plus the previous user message — "and for a
 * company?" means nothing without the question before it (the reasoning memory recall uses).
 */
export function queryTerms(message: string, previousUserMessage: string | null): readonly string[] {
  const current = message.slice(0, QUERY_MESSAGE_MAX_CHARS);
  const previous = previousUserMessage?.slice(0, QUERY_PREVIOUS_MAX_CHARS) ?? '';
  return [...new Set(tokenise(`${previous} ${current}`))];
}

export interface RankablePage {
  readonly pageNo: number;
  readonly content: string;
}

export interface PageScore {
  readonly pageNo: number;
  readonly score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 score of every page for the terms, best first; ties keep document order. A page that
 * shares no term with the question scores 0 and is still returned, last.
 */
export function rankPages(
  pages: readonly RankablePage[],
  terms: readonly string[],
): readonly PageScore[] {
  if (pages.length === 0) return [];
  const wanted = new Set(terms);
  const frequencies: Map<string, number>[] = [];
  const lengths: number[] = [];
  const containing = new Map<string, number>();
  for (const page of pages) {
    const counts = new Map<string, number>();
    const tokens = tokenise(page.content);
    for (const token of tokens) {
      if (wanted.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const term of counts.keys()) containing.set(term, (containing.get(term) ?? 0) + 1);
    frequencies.push(counts);
    lengths.push(tokens.length);
  }
  const average = lengths.reduce((sum, n) => sum + n, 0) / pages.length || 1;

  const scored = pages.map((page, index): PageScore => {
    const counts = frequencies[index] ?? new Map<string, number>();
    const length = lengths[index] ?? 0;
    let score = 0;
    for (const [term, frequency] of counts) {
      const df = containing.get(term) ?? 0;
      const idf = Math.log(1 + (pages.length - df + 0.5) / (df + 0.5));
      score += (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / average));
    }
    return { pageNo: page.pageNo, score };
  });
  return scored.sort((a, b) => b.score - a.score || a.pageNo - b.pageNo);
}
