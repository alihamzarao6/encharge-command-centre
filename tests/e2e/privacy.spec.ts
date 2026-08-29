/**
 * Private conversations in a real browser at 375 / 768 / 1280 against a scripted Supabase
 * (see mock.ts) — no stack, no key, no spend. Stage 3 part 5, FND-340, R27.
 *
 * Part A, interface half:
 *   - the toggle is offered on the author's own conversations and NOT on anyone else's,
 *     including to an administrator;
 *   - the sentence a person reads before the tap says BOTH halves — private messages, and
 *     what the assistant learns still shared. This is the assertion that matters most,
 *     because the second half is the one nobody would guess;
 *   - a private row says so at a glance;
 *   - an administrator can open somebody else's private conversation, is told that the read
 *     was recorded, and gets no composer under it;
 *   - the Memory page names a note's private source as private, not as removed;
 *   - every change went to /functions/v1/memory and PostgREST saw no write at all;
 *   - the layout holds at all three widths.
 *
 * Screenshots land in docs/assets/stage-3/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONV_ID, installMock, seedStoredSession, type MockOptions } from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/stage-3/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const ZOE = '22222222-2222-4222-8222-222222222222';
const HER_CONV = 'c0000000-0000-4000-8000-000000000009';

const ROSTER = [
  {
    user_id: ZOE,
    email: 'zoe@fundd.com.au',
    role: 'staff',
    is_active: true,
    is_admin: false,
    created_at: '2026-08-10T02:00:00Z',
  },
];

const MINE = {
  id: CONV_ID,
  title: 'Offset accounts post',
  last_active_at: '2026-08-27T02:00:00Z',
};

const HERS = {
  id: HER_CONV,
  title: 'Started by someone else',
  last_active_at: '2026-08-26T02:00:00Z',
  user_id: ZOE,
};

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

async function openList(page: Page): Promise<void> {
  // On a phone the list is a sheet that stays open after an action, and tapping the menu
  // button behind it is intercepted by the sheet itself — so open it only if it is shut.
  const sheet = page.locator('.convos--open');
  const menu = page.getByRole('button', { name: 'Open conversations' });
  if ((await sheet.count()) === 0 && (await menu.isVisible())) await menu.click();
  // `exact` because the admin section's heading is 'Private conversations', which a
  // loose match also finds (part 5).
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
}

async function open(page: Page, options: MockOptions = {}) {
  const state = await installMock(page, {
    conversations: [MINE, HERS],
    roster: ROSTER,
    ...options,
  });
  await seedStoredSession(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '+ New', exact: true })).toBeVisible();
  return state;
}

test.describe('making a conversation private', () => {
  test('the control is on my own row and on nobody else’s', async ({ page }) => {
    await open(page);
    await openList(page);

    const mine = page.locator('.convos__row', { hasText: 'Offset accounts post' });
    await expect(mine.getByRole('button', { name: 'Make it just mine' })).toBeVisible();

    const hers = page.locator('.convos__row', { hasText: 'Started by someone else' });
    await expect(hers.getByRole('button', { name: 'Make it just mine' })).toHaveCount(0);

    await shot(page, 'privacy-toggle-list');
    await expectNoHorizontalScroll(page);
  });

  test('AN ADMINISTRATOR IS NOT OFFERED IT EITHER — the one power admin does not get', async ({
    page,
  }) => {
    await open(page, { admin: true });
    await openList(page);
    const hers = page.locator('.convos__row', { hasText: 'Started by someone else' });
    // An admin CAN delete it (below); they cannot change who sees it.
    await expect(hers.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(hers.getByRole('button', { name: 'Make it just mine' })).toHaveCount(0);
  });

  test('the confirm says both halves: the messages go private, what it learns does not', async ({
    page,
  }) => {
    await open(page);
    await openList(page);
    const mine = page.locator('.convos__row', { hasText: 'Offset accounts post' });
    await mine.getByRole('button', { name: 'Make it just mine' }).click();

    const confirm = page.locator('.convos__confirm');
    await expect(confirm).toContainText('Make this conversation just yours?');
    await expect(confirm).toContainText('Only you and an administrator');
    // The half a person would otherwise learn afterwards, which is the whole reason this
    // sentence exists rather than a bare "Are you sure?".
    await expect(confirm).toContainText('What the assistant learns here is still shared');
    await expect(confirm).toContainText('anything you ask it to remember');

    await shot(page, 'privacy-confirm');
    await expectNoHorizontalScroll(page);
  });

  test('it goes private, says so on the row, and the change went through the server path', async ({
    page,
  }) => {
    const state = await open(page);
    await openList(page);
    const mine = page.locator('.convos__row', { hasText: 'Offset accounts post' });
    await mine.getByRole('button', { name: 'Make it just mine' }).click();
    await page
      .locator('.convos__confirm')
      .getByRole('button', { name: 'Make it just mine' })
      .click();

    await expect(page.getByText('This conversation is now just yours')).toBeVisible();
    await openList(page);
    await expect(
      page
        .locator('.convos__row', { hasText: 'Offset accounts post' })
        .locator('.convos__item-private'),
    ).toHaveText('Just you');
    await expect(
      page.locator('.convos__row', { hasText: 'Offset accounts post' }).getByRole('button', {
        name: 'Share with the team',
      }),
    ).toBeVisible();

    // The only sanctioned write path, and the browser held nothing but SELECT.
    expect(state.memoryCalls.map((c) => c.body['action'])).toStrictEqual([
      'set_conversation_privacy',
    ]);
    expect(state.memoryCalls[0]?.body['isPrivate']).toBe(true);
    expect(state.postgrestWrites).toStrictEqual([]);

    await shot(page, 'privacy-private-row');
    await expectNoHorizontalScroll(page);
  });

  test('and it goes back, with a sentence that says what becomes visible', async ({ page }) => {
    const state = await open(page, {
      conversations: [{ ...MINE, scope: 'user' }, HERS],
    });
    await openList(page);
    const mine = page.locator('.convos__row', { hasText: 'Offset accounts post' });
    await mine.getByRole('button', { name: 'Share with the team' }).click();
    await expect(page.locator('.convos__confirm')).toContainText('while it was private');
    await page
      .locator('.convos__confirm')
      .getByRole('button', { name: 'Share with the team' })
      .click();

    await expect(page.getByText('This conversation is visible to the team again')).toBeVisible();
    expect(state.memoryCalls[0]?.body['isPrivate']).toBe(false);
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('the same control is in the thread bar from 768 up, and not on a phone', async ({
    page,
  }) => {
    // The bar at 375 already holds ☰ Conversations, the title, Rename and + New; a fifth
    // control collapses the title to nothing. So the toggle is a tablet-and-up convenience
    // and the list row is the one that exists at every width. Both halves asserted here,
    // because "we hid it on mobile" is only acceptable while the other one is reachable.
    await open(page, { messages: { [CONV_ID]: [] } });
    await openList(page);
    await page.locator('.convos__item', { hasText: 'Offset accounts post' }).click();

    const inBar = page.locator('.thread-pane__privacy');
    const width = page.viewportSize()?.width ?? 0;
    if (width < 768) {
      await expect(inBar).toBeHidden();
      await openList(page);
      await expect(
        page
          .locator('.convos__row', { hasText: 'Offset accounts post' })
          .getByRole('button', { name: 'Make it just mine' }),
      ).toBeVisible();
      return;
    }

    await inBar.click();
    await expect(page.getByText('Anyone on the team can open this conversation')).toBeVisible();
    await expect(page.getByText('What the assistant learns here is still shared')).toBeVisible();
    await shot(page, 'privacy-thread-panel');
    await expectNoHorizontalScroll(page);
  });
});

test.describe('an administrator reading somebody else’s private conversation', () => {
  const PRIVATE_LIST = [
    {
      id: HER_CONV,
      authorId: ZOE,
      authorEmail: 'zoe@fundd.com.au',
      createdAt: '2026-08-26T01:00:00Z',
      lastActiveAt: '2026-08-26T02:00:00Z',
    },
  ];
  const HER_MESSAGES = {
    [HER_CONV]: [
      {
        id: 'm1',
        role: 'user' as const,
        content: 'Something she would rather the team did not read',
        created_at: '2026-08-26T01:00:00Z',
      },
    ],
  };

  test('a non-admin is not shown the section at all', async ({ page }) => {
    await open(page, { conversations: [MINE] });
    await openList(page);
    await expect(page.getByRole('heading', { name: 'Private conversations' })).toHaveCount(0);
  });

  test('an admin sees a listing with no names in it, and is told why', async ({ page }) => {
    const state = await open(page, {
      admin: true,
      conversations: [MINE],
      privateConversations: PRIVATE_LIST,
      privateMessages: HER_MESSAGES,
    });
    await openList(page);
    await expect(page.getByRole('heading', { name: 'Private conversations' })).toBeVisible();
    await expect(page.getByText('each time you do it is recorded')).toBeVisible();

    await page.getByRole('button', { name: 'Show them' }).click();
    await expect(page.getByText('zoe — A private conversation')).toBeVisible();
    // A title is content, so the listing carries none — hers is never on screen here.
    await expect(page.getByText('Started by someone else')).toHaveCount(0);
    // Listing is not reading: no read has been performed yet.
    expect(state.adminReads).toStrictEqual([]);

    await shot(page, 'privacy-admin-list');
    await expectNoHorizontalScroll(page);
  });

  test('opening one reads it ONCE, says it was recorded, and offers no composer', async ({
    page,
  }) => {
    const state = await open(page, {
      admin: true,
      conversations: [MINE],
      privateConversations: PRIVATE_LIST,
      privateMessages: HER_MESSAGES,
    });
    await openList(page);
    await page.getByRole('button', { name: 'Show them' }).click();
    await page.getByText('zoe — A private conversation').click();

    await expect(
      page.getByText('You are reading a private conversation because you are an administrator'),
    ).toBeVisible();
    await expect(page.getByText('Something she would rather the team did not read')).toBeVisible();
    // An admin reads; they do not join in. Located by the composer itself rather than by
    // its label: getByLabel matches on substring, so 'Message' also finds "Copy message".
    await expect(page.locator('.composer')).toHaveCount(0);
    // Once, on the tap — never again on a re-render.
    expect(state.adminReads).toStrictEqual([HER_CONV]);
    expect(state.postgrestWrites).toStrictEqual([]);

    await shot(page, 'privacy-admin-read');
    await expectNoHorizontalScroll(page);

    await page.getByRole('button', { name: 'Close it' }).click();
    await expect(page.getByText('Something she would rather the team did not read')).toHaveCount(0);
    expect(state.adminReads).toStrictEqual([HER_CONV]);
  });
});

test.describe('the memory page when a note’s conversation is private', () => {
  test('names it as private, not as removed, and offers no way in', async ({ page }) => {
    await open(page, {
      // The chunk's conversation is not in the list the browser can read — which, since
      // part 5, is what a private source looks like from outside.
      conversations: [MINE],
      chunks: [
        {
          id: 'k1',
          conversation_id: HER_CONV,
          user_id: ZOE,
          scope: 'workspace',
          summary: 'A note the whole team can read, from a conversation they cannot open.',
          audience: 'first home buyers',
          created_at: '2026-08-26T02:00:00Z',
          deleted_at: null,
        },
      ],
    });
    await page.getByRole('button', { name: 'Memory' }).click();
    await page.getByRole('tab', { name: /From conversations/ }).click();

    await expect(page.getByRole('heading', { name: 'A private conversation' })).toBeVisible();
    await expect(page.getByText('private to the person who started it')).toBeVisible();
    await expect(page.getByText('A note the whole team can read')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open conversation' })).toHaveCount(0);

    await shot(page, 'privacy-memory-card');
    await expectNoHorizontalScroll(page);
  });
});
