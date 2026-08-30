/**
 * Naming and deleting a conversation, in a real browser at 375 / 768 / 1280 against a
 * scripted Supabase (see mock.ts) — no stack, no key, no spend.
 *
 * Part C, interface half:
 *   6 — a rename shows immediately and touches nothing else;
 *   7 — the delete confirm says exactly what a delete does, and the page says afterwards
 *       what actually went;
 *   8 — both changes went to /functions/v1/memory; PostgREST saw no write at all;
 *   9 — the layout holds at all three widths, WITH FIFTY CONVERSATIONS rather than four.
 *
 * Screenshots land in docs/assets/stage-3/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONV_ID,
  EMAIL,
  USER_ID,
  installMock,
  seedStoredSession,
  type MockOptions,
} from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/stage-3/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';
const OTHER_CONV = 'c0000000-0000-4000-8000-000000000002';

function shot(page: Page, name: string): Promise<Buffer> {
  const width = page.viewportSize()?.width ?? 0;
  return page.screenshot({ path: `${SHOTS}${name}-${String(width)}.png`, fullPage: false });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: limit,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
}

/** The list is a slide-in sheet on a phone and a sidebar from 768px. */
async function openList(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Open conversations' });
  if (await menu.isVisible()) await menu.click();
  // `exact` because the admin section's heading is 'Private conversations', which a
  // loose match also finds (part 5).
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
}

const TWO = [
  { id: CONV_ID, title: null, last_active_at: '2026-08-27T02:00:00Z' },
  {
    id: OTHER_CONV,
    title: 'Started by someone else',
    last_active_at: '2026-08-26T02:00:00Z',
    user_id: SOMEONE_ELSE,
  },
];

async function open(page: Page, options: MockOptions = {}) {
  const state = await installMock(page, { conversations: TWO, ...options });
  await seedStoredSession(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '+ New', exact: true })).toBeVisible();
  return state;
}

test.describe('whose conversation is whose', () => {
  const ROSTER = [
    {
      user_id: SOMEONE_ELSE,
      email: 'zoe@fundd.com.au',
      role: 'staff',
      is_active: true,
      is_admin: false,
      created_at: '2026-08-10T02:00:00Z',
    },
  ];

  test('every row is named for its AUTHOR, not for the person looking', async ({ page }) => {
    await open(page, { roster: ROSTER });
    await openList(page);

    // The signed-in user is ross.test@example.com; the other conversation is Zoe's. Both
    // rows carry their own author, which is the entire point of the prefix.
    await expect(page.getByText('ross.test — Untitled conversation')).toBeVisible();
    await expect(page.getByText('zoe — Started by someone else')).toBeVisible();
    expect(EMAIL.startsWith('ross.test')).toBe(true);

    await shot(page, 'conversations-authored');
    await expectNoHorizontalScroll(page);
  });

  test('renaming edits only the part after the prefix, and the prefix is not in the field', async ({
    page,
  }) => {
    const state = await open(page, {
      roster: ROSTER,
      conversations: [
        { id: CONV_ID, title: 'Offset accounts post', last_active_at: '2026-08-27T02:00:00Z' },
      ],
    });
    await openList(page);
    await expect(page.getByText('ross.test — Offset accounts post')).toBeVisible();

    const row = page.locator('.convos__row', { hasText: 'Offset accounts post' });
    await row.getByRole('button', { name: 'Rename' }).click();

    // The field holds the NAME only; the prefix sits beside it, visibly fixed.
    const field = page.getByLabel('Name this conversation');
    await expect(field).toHaveValue('Offset accounts post');
    await expect(page.locator('.convos__rename-prefix')).toHaveText('ross.test — ');
    await shot(page, 'conversation-rename-prefix');

    await field.fill('Refinance ads for October');
    await page.getByRole('button', { name: 'Save name' }).click();

    // What was SENT is the name alone — the prefix is derived, never stored.
    expect(state.memoryCalls[0]?.body['title']).toBe('Refinance ads for October');
    await expect(page.getByText('ross.test — Refinance ads for October')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the filter finds a colleague by name, which is the first thing anyone tries', async ({
    page,
  }) => {
    await open(page, {
      roster: ROSTER,
      conversations: [
        // A distinct id space from OTHER_CONV: a collision duplicates a React key and
        // leaves a stale row behind, which is a fixture bug that reads like a filter bug.
        ...Array.from({ length: 12 }, (_v, i) => ({
          id: `c1110000-0000-4000-8000-0000000${String(i).padStart(5, '0')}`,
          title: `Mine number ${String(i)}`,
          last_active_at: '2026-08-27T02:00:00Z',
        })),
        {
          id: OTHER_CONV,
          title: 'Her refinance thread',
          last_active_at: '2026-08-26T02:00:00Z',
          user_id: SOMEONE_ELSE,
        },
      ],
    });
    await openList(page);
    const filter = page.getByLabel('Find a conversation by name');
    await filter.fill('zoe');
    await expect(page.locator('.convos__row')).toHaveCount(1);
    await expect(page.getByText('zoe — Her refinance thread')).toBeVisible();
  });
});

test.describe('naming a conversation', () => {
  test('6/8: a rename shows straight away, from the list, through the server path only', async ({
    page,
  }) => {
    const state = await open(page);
    await openList(page);
    await expect(page.getByText('Untitled conversation')).toBeVisible();

    const row = page.locator('.convos__row', { hasText: 'Untitled conversation' });
    await row.getByRole('button', { name: 'Rename' }).click();
    await shot(page, 'conversation-rename');
    await page.getByLabel('Name this conversation').fill('Refinance ads for October');
    await page.getByRole('button', { name: 'Save name' }).click();

    await expect(page.getByText('Refinance ads for October')).toBeVisible();
    await expect(page.getByText('Untitled conversation')).toHaveCount(0);
    expect(state.memoryCalls.map((c) => c.body['action'])).toStrictEqual(['rename_conversation']);
    expect(state.memoryCalls[0]?.body['title']).toBe('Refinance ads for October');
    expect(state.postgrestWrites).toStrictEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test('D75: renaming is the AUTHOR’s — not a colleague’s, and not an admin’s', async ({
    page,
  }) => {
    // CHANGED 30 Aug. This used to assert the opposite: D60 made naming open to everyone,
    // because nothing generated a title and a name was a correction. Part 4a auto-titles every
    // conversation and part 4 put staff on the system, so neither half holds — a name is now
    // how its author finds their own thread, and rewriting somebody else's is moving their
    // furniture.
    const state = await open(page);
    await openList(page);
    const theirs = page.locator('.convos__row', { hasText: 'Started by someone else' });
    await expect(theirs.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(theirs.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // Their own row still offers it.
    const mine = page.locator('.convos__row', { hasText: 'ross.test —' });
    await expect(mine.getByRole('button', { name: 'Rename' })).toBeVisible();
    expect(state.memoryCalls).toStrictEqual([]);
  });

  test('D75: an ADMIN is not offered Rename on somebody else’s conversation either', async ({
    page,
  }) => {
    // The one place this differs from Delete, which an admin DOES get: deleting is a removal
    // the workspace may need an administrator to make. Renaming never is.
    await open(page, { admin: true });
    await openList(page);
    const theirs = page.locator('.convos__row', { hasText: 'Started by someone else' });
    await expect(theirs.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(theirs.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  });

  test('an ADMIN is offered Delete on a conversation somebody else started', async ({ page }) => {
    await open(page, { admin: true });
    await openList(page);
    const theirs = page.locator('.convos__row', { hasText: 'Started by someone else' });
    await expect(theirs.getByRole('button', { name: 'Delete' })).toBeVisible();
  });

  test('the thread header renames the conversation you are looking at', async ({ page }) => {
    const state = await open(page, {
      messages: {
        [CONV_ID]: [
          { id: 'm1', role: 'user', content: 'Write me an ad', created_at: '2026-08-27T02:00:00Z' },
        ],
      },
    });
    await openList(page);
    await page.locator('.convos__item', { hasText: 'Untitled conversation' }).click();
    // The thread header's own Rename, not the row's — on a phone the sheet has just closed.
    const bar = page.locator('.thread-pane__bar');
    await bar.getByRole('button', { name: 'Rename' }).click();
    await bar.getByLabel('Name this conversation').fill('Named from the thread');
    await bar.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Named from the thread' })).toBeVisible();
    expect(state.memoryCalls.map((c) => c.body['action'])).toStrictEqual(['rename_conversation']);
  });
});

test.describe('deleting a conversation', () => {
  test('7: the confirm says what goes and what stays, and nothing happens until it is taken', async ({
    page,
  }) => {
    const state = await open(page);
    await openList(page);
    const row = page.locator('.convos__row', { hasText: 'Untitled conversation' });
    await row.getByRole('button', { name: 'Delete' }).click();

    const confirm = page.getByRole('alert');
    await expect(confirm).toContainText('messages are removed for good');
    await expect(confirm).toContainText('notes the assistant wrote about it');
    await expect(confirm).toContainText('Standing notes');
    await expect(confirm).toContainText('are kept');
    await shot(page, 'conversation-delete-confirm');
    await expectNoHorizontalScroll(page);

    // Backing out changes nothing at all.
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByText('Untitled conversation')).toBeVisible();
    expect(state.memoryCalls).toStrictEqual([]);
  });

  test('7/8: taking the confirm removes it from the list and says what survived', async ({
    page,
  }) => {
    const state = await open(page);
    await openList(page);
    const row = page.locator('.convos__row', { hasText: 'Untitled conversation' });
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete it' }).click();

    await expect(page.getByText('Untitled conversation')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('messages are gone for good');
    await expect(page.getByRole('status')).toContainText('Memory page');
    expect(state.memoryCalls.map((c) => c.body['action'])).toStrictEqual(['delete_conversation']);
    expect(state.postgrestWrites).toStrictEqual([]);
    // The other conversation is untouched.
    await expect(page.getByText('Started by someone else')).toBeVisible();
    await shot(page, 'conversation-deleted');
  });

  test('deleting the conversation you are reading empties the thread rather than leaving it', async ({
    page,
  }) => {
    await open(page, {
      messages: {
        [CONV_ID]: [
          { id: 'm1', role: 'user', content: 'Write me an ad', created_at: '2026-08-27T02:00:00Z' },
        ],
      },
    });
    await openList(page);
    await page.locator('.convos__item', { hasText: 'Untitled conversation' }).click();
    await expect(page.getByText('Write me an ad')).toBeVisible();

    await openList(page);
    const row = page.locator('.convos__row', { hasText: 'Untitled conversation' });
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete it' }).click();

    await expect(page.getByText('Write me an ad')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();
  });

  test('a server refusal is shown in the words the server chose', async ({ page }) => {
    const state = await open(page, {
      memoryFailure: {
        status: 403,
        body: {
          error: {
            code: 'NOT_YOURS',
            message:
              'Only the person who started this conversation, or an administrator, can delete it.',
            retryable: false,
          },
        },
      },
    });
    await openList(page);
    const row = page.locator('.convos__row', { hasText: 'Untitled conversation' });
    await row.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete it' }).click();
    await expect(page.getByRole('status')).toContainText('who started this conversation');
    await expect(page.getByText('Untitled conversation')).toBeVisible();
    expect(state.postgrestWrites).toStrictEqual([]);
  });
});

test.describe('a long list', () => {
  const FIFTY = Array.from({ length: 50 }, (_v, i) => ({
    id: `c0000000-0000-4000-8000-0000000${String(i).padStart(5, '0')}`,
    title:
      i % 3 === 0
        ? null
        : `${i % 2 === 0 ? 'Refinance' : 'First home buyer'} conversation number ${String(i)}`,
    last_active_at: `2026-08-${String(1 + (i % 27)).padStart(2, '0')}T02:00:00Z`,
    user_id: USER_ID,
  }));

  test('9: fifty conversations scroll, filter and hold the layout at every width', async ({
    page,
  }) => {
    await open(page, { conversations: FIFTY });
    await openList(page);

    // The filter appears only because the list is long, and it says how long.
    const filter = page.getByLabel('Find a conversation by name');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveAttribute('placeholder', 'Find among 50…');
    await expectNoHorizontalScroll(page);
    await shot(page, 'conversations-fifty');

    await filter.fill('First home');
    await expect(page.locator('.convos__row')).toHaveCount(17);
    await expectNoHorizontalScroll(page);

    // A name nobody has: the empty state explains WHY, rather than just saying "none".
    await filter.fill('zzzz');
    await expect(page.getByText(/found by date, not by name/)).toBeVisible();
    await shot(page, 'conversations-filter-empty');
    await expectNoHorizontalScroll(page);
  });

  test('the empty state still holds when there are none at all', async ({ page }) => {
    await open(page, { conversations: [] });
    await openList(page);
    await expect(
      page.getByText('No conversations yet. Your first message starts one.'),
    ).toBeVisible();
    await expect(page.getByLabel('Find a conversation by name')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('coming back to a conversation (D76)', () => {
  test('a reload lands back in the conversation you were in, not on a new one', async ({
    page,
  }) => {
    // A phone browser evicts a backgrounded tab; returning to it reloads the page. That is
    // what `page.reload()` reproduces here — every piece of React state goes, and without the
    // fix the person landed on "New conversation" and their thread appeared to be gone.
    await open(page, {
      conversations: [
        { id: CONV_ID, title: 'Offset accounts post', last_active_at: '2026-08-27T02:00:00Z' },
      ],
      messages: {
        [CONV_ID]: [
          {
            id: 'm1',
            role: 'user',
            content: 'Write me a post about offset accounts',
            created_at: '2026-08-27T02:00:00Z',
          },
        ],
      },
    });
    await openList(page);
    await page.locator('.convos__item', { hasText: 'Offset accounts post' }).click();
    await expect(page.getByText('Write me a post about offset accounts')).toBeVisible();

    await page.reload();

    await expect(page.getByRole('heading', { name: /Offset accounts post/ })).toBeVisible();
    await expect(page.getByText('Write me a post about offset accounts')).toBeVisible();
  });

  test('a reply that landed while you were away is simply there on return', async ({ page }) => {
    // The fetch died with the page, but the SERVER finished and saved the turn. Re-reading the
    // thread is what surfaces it — no message about anything going wrong, because nothing did.
    const state = await open(page, {
      conversations: [
        { id: CONV_ID, title: 'Offset accounts post', last_active_at: '2026-08-27T02:00:00Z' },
      ],
      messages: {
        [CONV_ID]: [
          { id: 'm1', role: 'user', content: 'A question', created_at: '2026-08-27T02:00:00Z' },
          {
            id: 'm2',
            role: 'assistant',
            content: 'The answer that landed while you were away',
            created_at: '2026-08-27T02:00:05Z',
          },
        ],
      },
    });
    await openList(page);
    await page.locator('.convos__item', { hasText: 'Offset accounts post' }).click();
    await page.reload();

    await expect(page.getByText('The answer that landed while you were away')).toBeVisible();
    await expect(page.getByText(/was not saved/)).toHaveCount(0);
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('starting a new conversation forgets the old one, so + New really is new', async ({
    page,
  }) => {
    await open(page, {
      conversations: [
        { id: CONV_ID, title: 'Offset accounts post', last_active_at: '2026-08-27T02:00:00Z' },
      ],
    });
    await openList(page);
    await page.locator('.convos__item', { hasText: 'Offset accounts post' }).click();
    await expect(page.getByRole('heading', { name: /Offset accounts post/ })).toBeVisible();

    await page.getByRole('button', { name: '+ New', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();
  });
});
