/**
 * A trailing `Note:` line is the assistant talking to Ross (VOICE.md, rules.ts
 * `format.asset-only`), never part of the copy. Copy-to-clipboard strips it so a note
 * addressed to him does not go out under his name; the screen still shows it, set apart.
 *
 * Mirrors src/lib/voice/conformance.ts `stripNotes` — the same rule the conformance suite
 * applies before checking copy. The test in tests/unit/web asserts the two agree.
 */
const NOTE_LINE = /^\s*Note:/i;

export interface SplitNotes {
  /** The copy: everything that is not a Note: line, trimmed. */
  readonly copy: string;
  /** The Note: lines, in order, without the prefix. Empty when there are none. */
  readonly notes: readonly string[];
}

export function splitNotes(text: string): SplitNotes {
  const lines = text.split('\n');
  const copy: string[] = [];
  const notes: string[] = [];
  for (const line of lines) {
    if (NOTE_LINE.test(line)) notes.push(line.replace(NOTE_LINE, '').trim());
    else copy.push(line);
  }
  return { copy: copy.join('\n').trim(), notes };
}

export function stripNotes(text: string): string {
  return splitNotes(text).copy;
}
