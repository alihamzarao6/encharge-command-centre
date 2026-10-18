/**
 * A chat turn whose history holds a reply written from a document since forgotten
 * (src/lib/llm/chat.ts with knowledge/withdrawn.ts, 18 Oct 2026): the reply reaches the model
 * as the stand-in and nothing else, the withdrawn-reply rules go in the system prompt after the
 * document rules, the wire carries no flag, and a history with nothing withdrawn builds the
 * request byte for byte as before.
 */
import { describe, expect, it } from 'vitest';

import type { AuthTokenUser, StaffRow, VerifyDeps } from '../../../src/lib/auth/verify.js';
import { ok, type Result } from '../../../src/lib/errors.js';
import { createTurnDocuments, type TurnDocuments } from '../../../src/lib/files/context.js';
import {
  DOCUMENT_RULES,
  UNREAD_LINK_RULES,
  WITHDRAWN_REPLY_RULES,
} from '../../../src/lib/files/rules.js';
import { WITHDRAWN_REPLY_STAND_IN } from '../../../src/lib/knowledge/withdrawn.js';
import {
  handleChatTurn,
  turnRules,
  type AppendTurnInput,
  type ChatDeps,
  type ConversationRow,
  type ConversationStore,
  type HistoryMessage,
} from '../../../src/lib/llm/chat.js';
import type { ClaudeClient, Completion, CompletionRequest } from '../../../src/lib/llm/client.js';
import { buildVoicePrefix } from '../../../src/lib/voice/prompt.js';
import { capturingLogger } from './helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = 'c0000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-18T04:00:00Z');

const CONVERSATION: ConversationRow = {
  id: CONV_ID,
  userId: USER_ID,
  scope: 'workspace',
  title: 'Rates',
  deletedAt: null,
};

const verify: VerifyDeps = {
  getUserFromToken: (): Promise<Result<AuthTokenUser | null>> =>
    Promise.resolve(ok({ id: USER_ID, email: 'x@y.com' })),
  getStaffRow: (): Promise<Result<StaffRow | null>> =>
    Promise.resolve(
      ok({ user_id: USER_ID, email: 'x@y.com', role: 'staff', is_active: true, is_admin: false }),
    ),
};

const COMPLETION: Completion = {
  text: 'That came from a document that has since been removed, so I cannot check it now.',
  model: 'claude-sonnet-5',
  stopReason: 'end_turn',
  usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 2200 },
  costUsd: 0.011,
  requestId: 'req_1',
  attempts: 1,
};

const EARLIER_QUESTION = 'What is the comparison rate for someone borrowing 85% of the value?';
const EARLIER_REPLY =
  'At LVR 80.01% to 90%, the interest rate is 6.44% p.a. and the comparison rate is 6.47% p.a.';

function fakeClaude(): ClaudeClient & { calls: CompletionRequest[] } {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    complete: (request) => {
      calls.push(request);
      return Promise.resolve(ok(COMPLETION));
    },
  };
}

function fakeStore(
  history: readonly HistoryMessage[],
): ConversationStore & { appended: AppendTurnInput[] } {
  const appended: AppendTurnInput[] = [];
  return {
    appended,
    get: () => Promise.resolve(ok(CONVERSATION)),
    create: () => Promise.resolve(ok(CONVERSATION)),
    recentMessages: () => Promise.resolve(ok(history)),
    appendTurn: (input) => {
      appended.push(input);
      return Promise.resolve(ok({ userMessageId: 'u-1', assistantMessageId: 'a-1' }));
    },
  };
}

/** The conversation after the forget: nothing attached, but it had a file. */
function documentsAfterForget(everHadPage = false): TurnDocuments {
  return createTurnDocuments(
    { forTurn: () => Promise.resolve(ok({ files: [], everHadFile: true, everHadPage })) },
    48_000,
    () => NOW,
  );
}

function deps(
  history: readonly HistoryMessage[],
  everHadPage = false,
): ChatDeps & {
  claude: ReturnType<typeof fakeClaude>;
} {
  const claude = fakeClaude();
  return {
    verify,
    claude,
    conversations: fakeStore(history),
    log: capturingLogger().log,
    documents: documentsAfterForget(everHadPage),
  };
}

const AS_SAID: readonly HistoryMessage[] = [
  { role: 'user', content: EARLIER_QUESTION },
  { role: 'assistant', content: EARLIER_REPLY },
];
const WITHDRAWN: readonly HistoryMessage[] = [
  { role: 'user', content: EARLIER_QUESTION },
  { role: 'assistant', content: WITHDRAWN_REPLY_STAND_IN, withdrawn: true },
];

describe('a withdrawn reply in the history', () => {
  it('reaches the model as the stand-in only, with the withdrawn-reply rules after the document rules', async () => {
    const d = deps(WITHDRAWN);
    const result = await handleChatTurn(d, {
      token: 't',
      message: 'What was the comparison rate at 85% again?',
      conversationId: CONV_ID,
    });
    expect(result.status).toBe(200);
    const request = d.claude.calls[0];
    expect(request?.system.map((block) => block.text)).toEqual([
      buildVoicePrefix(),
      `${DOCUMENT_RULES}\n\n${WITHDRAWN_REPLY_RULES}`,
    ]);
    expect(request?.system[1]?.cache).toBe(false);
    expect(request?.messages).toEqual([
      { role: 'user', content: EARLIER_QUESTION },
      { role: 'assistant', content: WITHDRAWN_REPLY_STAND_IN },
      { role: 'user', content: 'What was the comparison rate at 85% again?' },
    ]);
    // The figures of the withdrawn reply are nowhere in the turns (the document rules' own
    // worked example of a labelled cell is the only "6.47" in the request), nor is the flag.
    expect(JSON.stringify(request?.messages)).not.toContain('6.47');
    expect(JSON.stringify(request?.messages)).not.toContain('6.44');
    expect(JSON.stringify(request)).not.toContain('"withdrawn"');
  });

  it('the rules follow the link rule when both apply, and the stand-in is never a user turn', async () => {
    const d = deps(
      [
        { role: 'user', content: 'What do they charge? https://www.lender.example.org/rates' },
        { role: 'assistant', content: WITHDRAWN_REPLY_STAND_IN, withdrawn: true },
      ],
      true,
    );
    await handleChatTurn(d, { token: 't', message: 'and the fee?', conversationId: CONV_ID });
    const system = d.claude.calls[0]?.system[1]?.text ?? '';
    expect(system.indexOf(DOCUMENT_RULES)).toBe(0);
    expect(system.indexOf('# Pages read from a link')).toBeGreaterThan(0);
    expect(system.indexOf(UNREAD_LINK_RULES)).toBeGreaterThan(
      system.indexOf('# Pages read from a link'),
    );
    expect(system.indexOf(WITHDRAWN_REPLY_RULES)).toBeGreaterThan(
      system.indexOf(UNREAD_LINK_RULES),
    );
    expect(system.endsWith(WITHDRAWN_REPLY_RULES)).toBe(true);
  });

  it('a history with nothing withdrawn builds exactly the request it always did', async () => {
    const d = deps(AS_SAID);
    await handleChatTurn(d, {
      token: 't',
      message: 'What was the comparison rate at 85% again?',
      conversationId: CONV_ID,
    });
    const request = d.claude.calls[0];
    expect(request?.system.map((block) => block.text)).toEqual([
      buildVoicePrefix(),
      DOCUMENT_RULES,
    ]);
    expect(request?.messages).toEqual([
      ...AS_SAID,
      { role: 'user', content: 'What was the comparison rate at 85% again?' },
    ]);
    expect(JSON.stringify(request)).not.toContain('Withdrawn replies');
  });

  it('turnRules adds the block for a withdrawn turn and nothing else changes', () => {
    const base = { message: 'hi', documents: null };
    expect(turnRules({ ...base, history: AS_SAID })).toBeUndefined();
    expect(turnRules({ ...base, history: WITHDRAWN })).toBe(WITHDRAWN_REPLY_RULES);
    expect(
      turnRules({
        ...base,
        history: WITHDRAWN,
        documents: { rules: DOCUMENT_RULES, block: null, excerpts: null, summary: null },
      }),
    ).toBe(`${DOCUMENT_RULES}\n\n${WITHDRAWN_REPLY_RULES}`);
  });

  it('the rules name the stand-in as the model sees it, and name no document', () => {
    expect(WITHDRAWN_REPLY_RULES).toContain('"[This reply has been withdrawn. …]"');
    expect(WITHDRAWN_REPLY_STAND_IN.startsWith('[This reply has been withdrawn.')).toBe(true);
    expect(WITHDRAWN_REPLY_RULES).not.toMatch(/\.pdf|\.xlsx|http/i);
    expect(WITHDRAWN_REPLY_RULES).toMatch(/never call it wrong, invented, fabricated/i);
    expect(WITHDRAWN_REPLY_RULES).toMatch(/do not repeat, reconstruct, estimate or confirm/i);
  });
});
