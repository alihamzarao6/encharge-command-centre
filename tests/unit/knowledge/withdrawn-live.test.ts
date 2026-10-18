/**
 * A forgotten document speaking from the history — measured live, before and after (18 Oct
 * 2026), the method the credit-advice and decision-8 fixes used: the same follow-ups to the real
 * model, several times each, every reply judged in code, the replies kept word for word.
 *
 *   BEFORE (tests/fixtures/knowledge/withdrawn-before.json) — the earlier reply sent as said, as
 *   the code on `main` did: the model repeated the withdrawn figures as current and called its
 *   own correct reply made up.
 *   AFTER (tests/fixtures/knowledge/withdrawn-after.json) — the earlier reply as the stand-in
 *   with the withdrawn-reply rules, `npm run knowledge -- withdrawn`.
 *
 * The case is the recorded lookup reply about the rate page (tests/fixtures/files/lookups/
 * page-comparison-at-85.json, the real model's own words and figures) as the answer given while
 * the page was attached; the page is then forgotten. The reviewer's live case of 17 Oct was a
 * production conversation this build does not have; this is its shape, not his words.
 *
 * Every AFTER recording is pinned to the request the code builds TODAY — voice prefix, document
 * rules, web-page rules, withdrawn rules and the stand-in — so a change to any of them fails
 * here until it is re-recorded. The BEFORE recording is the record of the fault and is not
 * rebuilt. The judge is re-applied to both, so tightening it re-judges both.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AuthTokenUser, StaffRow, VerifyDeps } from '../../../src/lib/auth/verify.js';
import { ok, type Result } from '../../../src/lib/errors.js';
import { requestFingerprintSource } from '../../../src/lib/files/probe.js';
import {
  DOCUMENT_RULES_VERSION,
  WEB_RULES_VERSION,
  WITHDRAWN_RULES_VERSION,
} from '../../../src/lib/files/rules.js';
import {
  figuresIn,
  judgeWithdrawnReply,
  withdrawnFollowUps,
  withdrawnProbeDocuments,
  withdrawnProbeHistory,
  type WithdrawnMode,
} from '../../../src/lib/knowledge/probe.js';
import { WITHDRAWN_REPLY_STAND_IN } from '../../../src/lib/knowledge/withdrawn.js';
import {
  handleChatTurn,
  type ChatDeps,
  type ConversationRow,
  type ConversationStore,
  type HistoryMessage,
} from '../../../src/lib/llm/chat.js';
import type { ClaudeClient, Completion, CompletionRequest } from '../../../src/lib/llm/client.js';
import { capturingLogger } from '../llm/helpers.js';

const DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'knowledge');
const RERECORD = 'Record it again: npm run knowledge -- withdrawn --runs 6';

const VERDICT = z.object({
  presentsAsCurrent: z.boolean(),
  disowns: z.boolean(),
  withdraws: z.boolean(),
  reasons: z.array(z.string()),
});

const RECORD = z.object({
  recordedAt: z.string().min(1),
  model: z.string().nullable(),
  rulesVersion: z.object({ documents: z.string(), web: z.string(), withdrawn: z.string() }),
  standInSha256: z.string().regex(/^[0-9a-f]{64}$/),
  case: z.object({
    earlierQuestion: z.string().min(1),
    earlierReply: z.string().min(1),
    topic: z.string().min(1),
    quotedFigure: z.string().min(1),
    fromLink: z.boolean(),
  }),
  runs: z
    .array(
      z.object({
        question: z.string().min(1),
        reply: z.string(),
        requestSha256: z.string().regex(/^[0-9a-f]{64}$/),
        verdict: VERDICT,
        costUsd: z.number().min(0),
      }),
    )
    .min(1),
  summary: z.object({
    runs: z.number().int(),
    presentsAsCurrent: z.number().int(),
    disowns: z.number().int(),
    withdraws: z.number().int(),
  }),
  costUsd: z.number().min(0),
});

type Record_ = z.infer<typeof RECORD>;

function load(mode: WithdrawnMode): Record_ {
  const path = join(DIR, `withdrawn-${mode}.json`);
  expect(existsSync(path), `${path} is missing. ${RERECORD}`).toBe(true);
  return RECORD.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const USER_ID = '00000000-0000-4000-8000-0000000000c1';
const CONV_ID = '00000000-0000-4000-8000-00000000c0a1';
const STAFF: StaffRow = {
  user_id: USER_ID,
  email: 'terminal@knowledge.local',
  role: 'staff',
  is_active: true,
  is_admin: false,
};
const verify: VerifyDeps = {
  getUserFromToken: (): Promise<Result<AuthTokenUser | null>> =>
    Promise.resolve(ok({ id: USER_ID, email: STAFF.email })),
  getStaffRow: (): Promise<Result<StaffRow | null>> => Promise.resolve(ok(STAFF)),
};

function seeded(history: readonly HistoryMessage[]): ConversationStore {
  const row: ConversationRow = {
    id: CONV_ID,
    userId: USER_ID,
    scope: 'workspace',
    title: 'rates',
    deletedAt: null,
  };
  return {
    get: () => Promise.resolve(ok(row)),
    create: () => Promise.resolve(ok(row)),
    recentMessages: (_id, limit) => Promise.resolve(ok(history.slice(-limit))),
    appendTurn: () => Promise.resolve(ok({ userMessageId: 'u', assistantMessageId: 'a' })),
  };
}

const COMPLETION: Completion = {
  text: 'recorded elsewhere',
  model: 'claude-sonnet-5',
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0,
  requestId: 'req',
  attempts: 1,
};

/** The request the script sent for this follow-up, rebuilt with today's code through the handler. */
async function requestToday(
  record: Record_,
  mode: WithdrawnMode,
  question: string,
): Promise<CompletionRequest> {
  const calls: CompletionRequest[] = [];
  const claude: ClaudeClient = {
    complete: (request) => {
      calls.push(request);
      return Promise.resolve(ok(COMPLETION));
    },
  };
  const deps: ChatDeps = {
    verify,
    claude,
    conversations: seeded(withdrawnProbeHistory(record.case, mode)),
    log: capturingLogger().log,
    documents: withdrawnProbeDocuments(record.case),
  };
  const result = await handleChatTurn(deps, {
    token: 't',
    message: question,
    conversationId: CONV_ID,
  });
  expect(result.status).toBe(200);
  const request = calls[0];
  if (request === undefined) throw new Error('no request was built');
  return request;
}

describe('a forgotten document speaking from the history — before and after', () => {
  it('the case is real: the earlier reply carries figures, and the quoted one is among them', () => {
    const before = load('before');
    const figures = figuresIn(before.case.earlierReply);
    expect(figures.length).toBeGreaterThan(1);
    expect(figures).toContain(before.case.quotedFigure);
    expect(load('after').case).toEqual(before.case);
    expect(withdrawnFollowUps(before.case)).toEqual([
      ...new Set(before.runs.map((r) => r.question)),
    ]);
  });

  it('BEFORE: with the reply sent as said, the model presented the withdrawn figures as current AND disowned its correct reply', () => {
    const before = load('before');
    const judged = before.runs.map((run) =>
      judgeWithdrawnReply(run.reply, {
        earlierReply: before.case.earlierReply,
        question: run.question,
      }),
    );
    const current = judged.filter((v) => v.presentsAsCurrent).length;
    const disowned = judged.filter((v) => v.disowns).length;
    expect(current, 'replies presenting withdrawn figures as current').toBeGreaterThan(0);
    expect(disowned, 'replies calling the correct earlier reply made up or wrong').toBeGreaterThan(
      0,
    );
    // Both halves of the fault, in one recording, more than once each.
    expect(current).toBeGreaterThanOrEqual(before.runs.length / 3);
    expect(disowned).toBeGreaterThanOrEqual(2);
  });

  it('AFTER: the same follow-ups — no reply presents a withdrawn figure as current, none disowns the earlier reply, and each says the document was removed', () => {
    const after = load('after');
    expect(after.rulesVersion).toEqual({
      documents: DOCUMENT_RULES_VERSION,
      web: WEB_RULES_VERSION,
      withdrawn: WITHDRAWN_RULES_VERSION,
    });
    expect(after.standInSha256, `the stand-in changed. ${RERECORD}`).toBe(
      sha256(WITHDRAWN_REPLY_STAND_IN),
    );
    expect(after.runs.length).toBe(load('before').runs.length);
    for (const run of after.runs) {
      const verdict = judgeWithdrawnReply(run.reply, {
        earlierReply: after.case.earlierReply,
        question: run.question,
      });
      expect(verdict.presentsAsCurrent, `${run.question}\n${run.reply}`).toBe(false);
      expect(verdict.disowns, `${run.question}\n${run.reply}`).toBe(false);
    }
    const withdrew = after.runs.filter(
      (run) =>
        judgeWithdrawnReply(run.reply, {
          earlierReply: after.case.earlierReply,
          question: run.question,
        }).withdraws,
    ).length;
    expect(withdrew).toBeGreaterThanOrEqual(Math.ceil(after.runs.length * 0.75));
  });

  it('AFTER: every recording was made from the request the code builds today', async () => {
    const after = load('after');
    for (const question of new Set(after.runs.map((run) => run.question))) {
      const today = sha256(requestFingerprintSource(await requestToday(after, 'after', question)));
      for (const run of after.runs.filter((r) => r.question === question)) {
        expect(
          run.requestSha256,
          `${question}: the request changed since it was recorded. ${RERECORD}`,
        ).toBe(today);
      }
    }
  });

  it('the stand-in, not the earlier reply, is what the model saw in the AFTER requests', async () => {
    const after = load('after');
    const question = after.runs[0]?.question ?? '';
    const request = await requestToday(after, 'after', question);
    const turns = JSON.stringify(request.messages);
    expect(turns).toContain(WITHDRAWN_REPLY_STAND_IN);
    for (const figure of figuresIn(after.case.earlierReply).filter((f) => !question.includes(f))) {
      expect(turns).not.toContain(figure);
    }
    expect(request.system.map((block) => block.text).join('\n')).toContain('# Withdrawn replies');
    // And the BEFORE request carried the reply as said, with no such rules: the fault's shape.
    const before = await requestToday(after, 'before', question);
    expect(before.messages.some((turn) => turn.content === after.case.earlierReply)).toBe(true);
    expect(before.system.map((block) => block.text).join('\n')).not.toContain(
      '# Withdrawn replies',
    );
  });
});
