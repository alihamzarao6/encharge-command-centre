/**
 * The audience field (review, 27 Aug 2026): the summariser's trailing `Audience:` line is
 * split off, bounded and guarded; it goes into the embedded header and onto the chunk row;
 * the recalled line shows it. Fixture `summary-audience.json` is the REAL Haiku answer for
 * the live "Meta ad" conversation, recorded 27 Aug.
 */
import { describe, expect, it } from 'vitest';

import { createHttpClient, type FetchLike } from '../../../src/lib/http.js';
import { createClaudeClient } from '../../../src/lib/llm/client.js';
import { createVoyageEmbedder } from '../../../src/lib/memory/embed.js';
import { renderChunk } from '../../../src/lib/memory/retrieve.js';
import {
  AUDIENCE_MAX_CHARS,
  SUMMARY_SYSTEM_PROMPT,
  embeddingText,
  parseSummaryOutput,
  splitAudience,
  summariseMessages,
} from '../../../src/lib/memory/summarise.js';
import { summariseConversation, type MemoryDeps } from '../../../src/lib/memory/trigger.js';
import { capturingLogger, memoryUsageStore, testConfig } from '../llm/helpers.js';
import {
  CONVERSATION,
  POLICY,
  anthropicFixture,
  fakeChunkStore,
  messagesOf,
  voyageConfig,
  voyageFixture,
} from './helpers.js';

const NOTE =
  'The user asked for a Meta ad aimed at renters. The assistant drafted one and shortened it on request, removing the closing note.';

describe('splitAudience', () => {
  it('takes the trailing Audience line off the note; absent line → null', () => {
    expect(splitAudience(`${NOTE}\n\nAudience: renters aspiring to homeownership.`)).toEqual({
      note: NOTE,
      audience: 'renters aspiring to homeownership',
    });
    expect(splitAudience(`${NOTE}\naudience:   first  home buyers  `)).toEqual({
      note: NOTE,
      audience: 'first home buyers',
    });
    expect(splitAudience(NOTE)).toEqual({ note: NOTE, audience: null });
  });

  it('a placeholder ("none", "n/a", "general") or an empty line is null', () => {
    for (const p of ['none', 'N/A', 'not stated', 'general', '-', '']) {
      expect(splitAudience(`${NOTE}\nAudience: ${p}`).audience, p).toBeNull();
    }
  });

  it('an "Audience:" mention inside the note, not on the last line, is left in the note', () => {
    const inline = `${NOTE} Audience: was discussed briefly.\nThen the user moved on to timing.`;
    expect(splitAudience(inline)).toEqual({ note: inline, audience: null });
  });
});

describe('parseSummaryOutput', () => {
  it('validates the note as before and carries the audience', () => {
    const out = parseSummaryOutput(`${NOTE}\nAudience: tradies refinancing`, 2_000);
    expect(out).toEqual({ ok: true, value: { note: NOTE, audience: 'tradies refinancing' } });
  });

  it('rejects an over-long audience or one that carries an access claim, with a reason', () => {
    const long = parseSummaryOutput(
      `${NOTE}\nAudience: ${'x'.repeat(AUDIENCE_MAX_CHARS + 1)}`,
      2_000,
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.issues[0]?.path).toBe('audience');
    const access = parseSummaryOutput(
      `${NOTE}\nAudience: Mia, who should receive the same treatment as the user`,
      2_000,
    );
    expect(access.ok).toBe(false);
    if (!access.ok) expect(access.error.issues[0]?.message).toContain('access decision');
  });

  it('a bad note still fails on the note, whatever the audience says', () => {
    expect(parseSummaryOutput('Summary: too short\nAudience: renters', 2_000).ok).toBe(false);
  });

  it('the prompt asks for the line and says when to omit it', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('"Audience: "');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('Omit that line entirely');
  });
});

describe('the header and the recalled line', () => {
  it('embeddingText adds an Audience line when there is one, and nothing when null', () => {
    expect(embeddingText({ title: 'Meta ad', date: '2026-08-26', audience: 'renters' }, NOTE)).toBe(
      `Conversation: Meta ad\nDate: 2026-08-26\nAudience: renters\n\n${NOTE}`,
    );
    expect(embeddingText({ title: 'Meta ad', date: '2026-08-26', audience: '  ' }, NOTE)).toBe(
      `Conversation: Meta ad\nDate: 2026-08-26\n\n${NOTE}`,
    );
  });

  it('renderChunk shows the audience after the date', () => {
    const base = {
      id: 'k',
      conversationId: 'c',
      title: 'Meta ad',
      summary: NOTE,
      createdAt: new Date('2026-08-26T09:00:00Z'),
      similarity: 0.5,
    };
    expect(renderChunk({ ...base, audience: 'renters in Perth' }, 1)).toContain(
      '"Meta ad" (2026-08-26, for renters in Perth, similarity 0.50)',
    );
    expect(renderChunk({ ...base, audience: null }, 1)).toContain(
      '"Meta ad" (2026-08-26, similarity 0.50)',
    );
  });
});

describe('over the recorded audience answer, through the trigger', () => {
  it('the audience is parsed from Haiku, embedded in the header and stored on the chunk', async () => {
    const { log, lines } = capturingLogger();
    const sent: string[] = [];
    const fetch: FetchLike = (url, init) => {
      const body = typeof init.body === 'string' ? init.body : '';
      if (url.startsWith('https://anthropic.test')) {
        return Promise.resolve(
          new Response(anthropicFixture('summary-audience'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      sent.push(body);
      return Promise.resolve(
        new Response(voyageFixture('embeddings-ok'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const http = createHttpClient({
      fetch,
      retries: 0,
      sleep: () => Promise.resolve(),
      logger: log,
    });
    const usage = memoryUsageStore();
    const store = fakeChunkStore(messagesOf(10));
    const deps: MemoryDeps = {
      claude: createClaudeClient({
        config: testConfig(),
        http,
        usage,
        log,
        now: () => new Date('2026-08-25T12:00:00Z'),
      }),
      embedder: createVoyageEmbedder({ config: voyageConfig(), http, usage, log }),
      chunks: store,
      policy: POLICY,
      log,
      now: () => new Date('2026-08-25T12:00:00Z'),
    };
    const outcome = await summariseConversation(deps, CONVERSATION, { freshMessages: 0 });
    expect(outcome.ok).toBe(true);
    expect(store.chunks).toHaveLength(1);
    expect(store.chunks[0]?.audience).toBe('Renters aspiring to homeownership');
    expect(store.chunks[0]?.summary).not.toContain('Audience:');
    const voyageBody = JSON.parse(sent[0] ?? '{}') as { input: string[] };
    expect(voyageBody.input[0]).toContain(
      `Conversation: ${CONVERSATION.title}\nDate: 2026-08-25\nAudience: Renters aspiring to homeownership\n\n`,
    );
    expect(lines.join('\n')).not.toContain('Renters aspiring'); // text never logged
  });

  it('summariseMessages returns the audience alongside the note', async () => {
    const { log } = capturingLogger();
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(anthropicFixture('summary-audience'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const claude = createClaudeClient({
      config: testConfig(),
      http: createHttpClient({ fetch, retries: 0, logger: log }),
      usage: memoryUsageStore(),
      log,
      now: () => new Date('2026-08-25T12:00:00Z'),
    });
    const result = await summariseMessages(
      claude,
      {
        messages: [{ ordinal: 1, role: 'user', content: 'Write a Meta ad' }],
        range: { lo: 1, hi: 2 },
        maxChars: 2_000,
        userId: null,
        conversationId: null,
      },
      log,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.audience).toBe('Renters aspiring to homeownership');
    expect(result.value.text.endsWith('the note about missing information.')).toBe(true);
    expect(result.value.usage).toEqual({
      inputTokens: 955,
      outputTokens: 112,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});
