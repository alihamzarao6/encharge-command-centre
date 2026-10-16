/**
 * The chat turn with knowledge (Milestone 5 part 5): ONE query embedding per turn, shared by
 * memory recall and the document search (the free Voyage plan allows three requests a minute,
 * so a second would halve how often the assistant can be asked anything); a brand-new
 * conversation drawing on what was learned; and memory recall still embedding for itself when
 * no shared vector is offered.
 */
import { describe, expect, it } from 'vitest';

import { NetworkError, err, ok, type Result } from '../../../src/lib/errors.js';
import { createTurnDocuments } from '../../../src/lib/files/context.js';
import { KNOWLEDGE_DEFAULTS } from '../../../src/lib/knowledge/config.js';
import { createLocalKnowledgeStore } from '../../../src/lib/knowledge/local-store.js';
import {
  handleChatTurn,
  type ChatDeps,
  type ConversationRow,
  type ConversationStore,
  type HistoryMessage,
  type TurnMemory,
} from '../../../src/lib/llm/chat.js';
import { RETRIEVAL_DEFAULTS } from '../../../src/lib/memory/config.js';
import type { FactStore } from '../../../src/lib/memory/facts.js';
import { recallForTurn } from '../../../src/lib/memory/retrieve.js';
import { completion, scriptedClaude, verifyAs } from '../files/helpers.js';
import { TEAMMATE, USER, bagOfWords, fakeEmbedder } from '../knowledge/helpers.js';
import { capturingLogger } from './helpers.js';

function conversations(): ConversationStore & { appended: unknown[] } {
  const rows = new Map<string, ConversationRow>();
  const appended: unknown[] = [];
  return {
    appended,
    get: (id) => Promise.resolve(ok(rows.get(id) ?? null)),
    create: (userId, title) => {
      const row: ConversationRow = {
        id: 'c2000000-0000-4000-8000-000000000001',
        userId,
        scope: 'workspace',
        title,
        deletedAt: null,
      };
      rows.set(row.id, row);
      return Promise.resolve(ok(row));
    },
    recentMessages: (): Promise<Result<readonly HistoryMessage[]>> => Promise.resolve(ok([])),
    appendTurn: (input) => {
      appended.push(input);
      return Promise.resolve(ok({ userMessageId: 'u', assistantMessageId: 'a' }));
    },
  };
}

const facts: FactStore = {
  currentFacts: () => Promise.resolve(ok([])),
  upsert: () => Promise.reject(new Error('not used')),
  setSource: () => Promise.resolve(ok(undefined)),
};

describe('one query embedding per turn', () => {
  it('memory recall and the document search share it: Voyage is asked once', async () => {
    let queries = 0;
    const store = createLocalKnowledgeStore({ activeStaff: [TEAMMATE] });
    const recallEmbedder = fakeEmbedder();
    const memory: TurnMemory = {
      recall: (input) =>
        recallForTurn(
          {
            claude: scriptedClaude(),
            embedder: recallEmbedder,
            facts,
            search: { search: () => Promise.resolve(ok([])) },
            config: RETRIEVAL_DEFAULTS,
            log: capturingLogger().log,
          },
          input,
        ),
      attachSource: () => Promise.resolve(ok(undefined)),
    };
    const store2 = conversations();
    const deps: ChatDeps = {
      verify: verifyAs(TEAMMATE),
      claude: scriptedClaude(ok(completion('hello'))),
      conversations: store2,
      log: capturingLogger().log,
      memory,
      documents: createTurnDocuments(
        { forTurn: () => Promise.resolve(ok({ files: [], everHadFile: false })) },
        48_000,
        () => new Date(),
        {
          sourcesForFiles: (ids) => store.sourcesForFiles(ids),
          match: (q, p) => store.match(q, p),
          neighbours: (s, o) => store.neighbours(s, o),
          summaries: (s) => store.summariesOf(s),
          anyReady: () => store.anyReady(),
          config: KNOWLEDGE_DEFAULTS.retrieval,
          log: capturingLogger().log,
        },
      ),
      query: {
        embed: (input) => {
          queries += 1;
          return Promise.resolve(
            ok({
              vector: bagOfWords(input.text),
              text: input.text,
              aboutDocuments: true,
              overview: false,
            }),
          );
        },
      },
    };
    const result = await handleChatTurn(deps, {
      token: 't',
      message: 'what do we know about week one',
    });
    expect(result.status).toBe(200);
    expect(queries).toBe(1);
    // Recall used the shared vector: its own embedder was never called.
    expect(recallEmbedder.calls).toHaveLength(0);
    // Nothing learned and nothing attached: the turn is saved without a coverage record.
    expect(store2.appended[0]).not.toHaveProperty('documentCoverage');
  });

  it('without a shared vector (no `query` wired) recall embeds for itself, as it always did', async () => {
    const embedder = fakeEmbedder();
    const outcome = await recallForTurn(
      {
        claude: scriptedClaude(),
        embedder,
        facts,
        search: { search: () => Promise.resolve(ok([])) },
        config: RETRIEVAL_DEFAULTS,
        log: capturingLogger().log,
      },
      {
        userId: USER,
        scope: 'workspace',
        conversationId: null,
        historyMessages: 0,
        message: 'week one',
        previousUserMessage: null,
      },
    );
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]?.inputType).toBe('query');
    expect(outcome.summary.degraded).toEqual([]);
  });

  it('a shared vector that failed degrades recall exactly as its own failure would', async () => {
    const embedder = fakeEmbedder();
    const outcome = await recallForTurn(
      {
        claude: scriptedClaude(),
        embedder,
        facts,
        search: { search: () => Promise.resolve(ok([])) },
        config: RETRIEVAL_DEFAULTS,
        log: capturingLogger().log,
      },
      {
        userId: USER,
        scope: 'workspace',
        conversationId: null,
        historyMessages: 0,
        message: 'week one',
        previousUserMessage: null,
        queryVector: () => Promise.resolve(err(new NetworkError('voyage 429'))),
      },
    );
    expect(embedder.calls).toHaveLength(0);
    expect(outcome.summary.degraded).toEqual(['embed']);
  });
});
