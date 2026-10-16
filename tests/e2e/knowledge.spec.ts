/**
 * Milestone 5 part 5 — the note under an answer that says what the assistant actually had
 * (fixed decision 7), at 375, 768 and 1280. Against the scripted backend: the chat reply carries
 * the coverage record exactly as src/lib/llm/chat.ts returns it, and the saved message carries it
 * exactly as the database stores it (ids and numbers, no names), so these tests also prove the
 * names are looked up on reload — and that a removed document names nothing.
 *
 * Screenshots: docs/assets/milestone-5/knowledge-*.png.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONV_ID,
  USER_ID,
  installMock,
  signIn,
  sseDone,
  type MockOptions,
  type MockState,
  type ScriptedFile,
} from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/milestone-5/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

function shot(page: Page, name: string): Promise<Buffer> {
  const width = page.viewportSize()?.width ?? 0;
  return page.screenshot({ path: `${SHOTS}${name}-${String(width)}.png`, fullPage: false });
}

const FILE_ID = 'f5000000-0000-4000-8000-000000000001';
const SOURCE_ID = 'a5000000-0000-4000-8000-000000000001';
const OTHER_SOURCE = 'a5000000-0000-4000-8000-000000000002';

const TRANSCRIPT: ScriptedFile = {
  id: FILE_ID,
  conversation_id: CONV_ID,
  uploaded_by: USER_ID,
  name: 'Course transcript — 12-week mortgage broker growth program (full).pdf',
  kind: 'pdf',
  byte_size: 412_000,
  page_count: 33,
  vision_pages: 0,
  status: 'ready',
  created_at: '2026-10-15T23:40:00Z',
  expires_at: '2026-11-14T23:40:00Z',
};

const PARTIAL = {
  v: 1,
  documents: [
    {
      file: FILE_ID,
      source: SOURCE_ID,
      origin: 'attached',
      kind: 'pdf',
      mode: 'part',
      pages: [1, 2, 3, 4, 5, 6, 9],
      total: 33,
    },
  ],
};

const LEARNED = {
  v: 1,
  documents: [
    {
      source: SOURCE_ID,
      origin: 'learned',
      kind: 'pdf',
      mode: 'part',
      pages: [1, 2, 3, 4, 5, 6],
      total: 33,
      learnedAt: '2026-10-15T23:40:00Z',
    },
  ],
};

/** 17 Oct: an overview question answered from the summary written while it was learned. */
const SUMMARY = {
  v: 1,
  documents: [
    {
      source: SOURCE_ID,
      origin: 'learned',
      kind: 'pdf',
      mode: 'part',
      pages: [2, 3],
      total: 33,
      learnedAt: '2026-10-15T23:40:00Z',
      summary: [{ from: 1, to: 33 }],
    },
  ],
};

const STILL_LEARNING = {
  v: 1,
  documents: [
    {
      file: FILE_ID,
      source: SOURCE_ID,
      origin: 'attached',
      kind: 'pdf',
      mode: 'part',
      pages: [1, 2, 3],
      total: 33,
      learning: { done: 40, total: 132 },
    },
  ],
};

const SEARCH_FAILED = {
  v: 1,
  searchFailed: true,
  documents: [
    {
      file: FILE_ID,
      source: SOURCE_ID,
      origin: 'attached',
      kind: 'pdf',
      mode: 'opening',
      pages: [1, 2, 3, 4, 5, 6, 7],
      total: 33,
      reason: 'search_failed',
    },
  ],
};

const WHOLE = {
  v: 1,
  documents: [
    { file: FILE_ID, origin: 'attached', kind: 'pdf', mode: 'whole', pages: [1], total: 1 },
  ],
};

const NAMES = { [FILE_ID]: TRANSCRIPT.name ?? '', [SOURCE_ID]: TRANSCRIPT.name ?? '' };

/** sseDone with the reply's `documents`, as the chat function sends it. */
function sseWith(
  reply: string,
  call: number,
  documents: unknown,
  conversationId = CONV_ID,
): { event: string; data: unknown }[] {
  const events = sseDone(reply, call, conversationId);
  const done = events.at(-1) as {
    event: string;
    data: { type: string; reply: Record<string, unknown> };
  };
  return [
    ...events.slice(0, -1),
    { event: 'done', data: { ...done.data, reply: { ...done.data.reply, documents } } },
  ];
}

const CONVERSATION = {
  id: CONV_ID,
  title: 'Course transcript',
  last_active_at: '2026-10-16T00:00:00Z',
};

async function openConversation(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state = await installMock(page, {
    conversations: [CONVERSATION],
    files: [TRANSCRIPT],
    ...options,
  });
  await signIn(page, '/assistant');
  await expect(page.getByRole('button', { name: '+ New', exact: true })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open conversations' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('listitem').filter({ hasText: 'Course transcript' }).click();
  await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toBeVisible();
  return state;
}

async function ask(page: Page, question: string): Promise<Locator> {
  await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
  const answer = page.getByTestId('thread').locator('[data-role="assistant"]').last();
  await expect(answer).toBeVisible();
  return answer;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    note: Array.from(document.querySelectorAll('.bubble__coverage')).map(
      (el) => el.getBoundingClientRect().right,
    ),
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  for (const right of widths.note) expect(right).toBeLessThanOrEqual(widths.client + 0.5);
}

test.describe('the note under an answer', () => {
  test('only part of a long document reached the model: said plainly, under the answer it affected', async ({
    page,
  }) => {
    await openConversation(page, {
      chat: {
        respond: (_r, call) => ({
          sse: sseWith(
            'Week one is about setting up your pipeline and your first 50 calls.',
            call,
            { coverage: PARTIAL, chars: 41_000, names: NAMES },
          ),
        }),
      },
    });
    const answer = await ask(page, 'break down weak one for me');
    const note = answer.getByTestId('coverage');
    await expect(note).toHaveAttribute('role', 'note');
    await expect(note).toHaveText(
      `Only part of “${TRANSCRIPT.name ?? ''}” reached the assistant for this answer: pages 1–6, 9 of its 33 pages. Each question gets the parts that best match it, up to a fixed amount — ask about the specific topic you need to bring other parts in.`,
    );
    // In the answer's own bubble — not on the file item, and not anywhere else.
    await expect(page.getByTestId('file').getByTestId('coverage')).toHaveCount(0);
    await expect(page.getByTestId('coverage')).toHaveCount(1);
    await expectNoHorizontalScroll(page);
    await shot(page, 'knowledge-partial');
  });

  test('a new, empty conversation answered from a document it never saw attached: says where and when it came from', async ({
    page,
  }) => {
    await installMock(page, {
      chat: {
        respond: (_r, call) => ({
          sse: sseWith('From the course transcript: week one covers your pipeline set-up…', call, {
            coverage: LEARNED,
            chars: 38_000,
            names: NAMES,
          }),
        }),
      },
    });
    await signIn(page, '/assistant');
    const answer = await ask(page, 'break down week one of the course for me');
    await expect(answer.getByTestId('coverage')).toHaveText(
      `Also drew on “${TRANSCRIPT.name ?? ''}”, added 16 Oct 2026 in another conversation: pages 1–6 of its 33 pages.`,
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'knowledge-learned');
  });

  test('an overview answered from the summary: what it covered, what was seen in full, whose words they are', async ({
    page,
  }) => {
    await installMock(page, {
      chat: {
        respond: (_r, call) => ({
          sse: sseWith('Week one, from the summary of the whole call: your pipeline first…', call, {
            coverage: SUMMARY,
            chars: 14_000,
            names: NAMES,
          }),
        }),
      },
    });
    await signIn(page, '/assistant');
    const answer = await ask(page, 'break down weak one for me');
    await expect(answer.getByTestId('coverage')).toHaveText(
      `Also drew on “${TRANSCRIPT.name ?? ''}”, added 16 Oct 2026 in another conversation: a summary of all 33 pages, written by the app when it was learned, and pages 2–3 in full.`,
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'knowledge-summary');
  });

  test('still being learned: how far, and when asking again will search all of it', async ({
    page,
  }) => {
    await openConversation(page, {
      chat: {
        respond: (_r, call) => ({
          sse: sseWith('From what has been learned so far, week one…', call, {
            coverage: STILL_LEARNING,
            chars: 12_000,
            names: NAMES,
          }),
        }),
      },
    });
    const answer = await ask(page, 'break down week one for me');
    await expect(answer.getByTestId('coverage')).toContainText(
      'is still being learned (40 of 132 sections so far), so this answer drew only on pages 1–3 of its 33 pages. Ask again in a few minutes',
    );
    await shot(page, 'knowledge-learning');
  });

  test('the search could not run: the opening pages, said to be exactly that', async ({ page }) => {
    await openConversation(page, {
      chat: {
        respond: (_r, call) => ({
          sse: sseWith('I could not search the transcript just now…', call, {
            coverage: SEARCH_FAILED,
            chars: 40_000,
            names: NAMES,
          }),
        }),
      },
    });
    const answer = await ask(page, 'what does week seven cover');
    await expect(answer.getByTestId('coverage')).toContainText(
      'This answer saw only the opening pages of “',
    );
    await expect(answer.getByTestId('coverage')).toContainText(
      "(pages 1–7 of its 33 pages), not the parts that match your question: the search that picks those wasn't available just now. Ask again in a minute.",
    );
    await shot(page, 'knowledge-search-failed');
  });

  test('the whole document reached the model: no note at all', async ({ page }) => {
    await openConversation(page, {
      chat: {
        respond: (_r, call) => ({
          sse: sseWith('The net pay is 2,887.38.', call, {
            coverage: WHOLE,
            chars: 900,
            names: NAMES,
          }),
        }),
      },
    });
    const answer = await ask(page, 'what is the net pay');
    await expect(answer).toContainText('2,887.38');
    await expect(page.getByTestId('coverage')).toHaveCount(0);
    await shot(page, 'knowledge-whole-no-note');
  });

  test('the note survives a reload: stored as ids and numbers, the name looked up again', async ({
    page,
  }) => {
    await openConversation(page, {
      messages: {
        [CONV_ID]: [
          {
            id: 'm1',
            role: 'user',
            content: 'break down weak one for me',
            created_at: '2026-10-16T00:01:00Z',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'Week one is about setting up your pipeline.',
            created_at: '2026-10-16T00:01:09Z',
            document_coverage: PARTIAL,
          },
          {
            id: 'm3',
            role: 'user',
            content: 'and from the rate sheet?',
            created_at: '2026-10-16T00:02:00Z',
          },
          {
            id: 'm4',
            role: 'assistant',
            content: 'The rate sheet that was removed said…',
            created_at: '2026-10-16T00:02:09Z',
            document_coverage: {
              v: 1,
              documents: [
                {
                  source: OTHER_SOURCE,
                  origin: 'learned',
                  kind: 'pdf',
                  mode: 'part',
                  pages: [2],
                  total: 4,
                  learnedAt: '2026-10-01T02:00:00Z',
                },
              ],
            },
          },
        ],
      },
      knowledgeSources: [
        { id: SOURCE_ID, name: TRANSCRIPT.name },
        { id: OTHER_SOURCE, name: null },
      ],
    });
    const notes = page.getByTestId('thread').getByTestId('coverage');
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toContainText(
      `Only part of “${TRANSCRIPT.name ?? ''}” reached the assistant`,
    );
    // Forgotten since: the record had no name to begin with, and the lookup finds none.
    await expect(notes.last()).toHaveText(
      'Also drew on a document that has since been removed, added 1 Oct 2026 in another conversation: page 2 of its 4 pages.',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'knowledge-after-reload');
  });
});
