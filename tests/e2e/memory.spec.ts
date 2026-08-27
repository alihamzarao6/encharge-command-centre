/**
 * The Memory page in a real browser at 375 / 768 / 1280 (see playwright.config.ts), against
 * a scripted Supabase — no stack, no key, no spend.
 *
 * Part C, interface half:
 *   1/3 — a note added from the page appears in the list; an edit shows as ONE note whose
 *         earlier wording is still readable, never as two notes;
 *   2   — Forget takes the note out of the live list and puts it under Removed notes, where
 *         it can be added back — the wording on the confirm step is the promise;
 *   4   — a deleted conversation note is gone from the list;
 *   5   — a deactivated account never reaches the page at all;
 *   6   — every change went to /functions/v1/memory; PostgREST saw no write at all;
 *   7   — the layout holds at all three widths with no horizontal scroll.
 *
 * Screenshots land in docs/assets/stage-3/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONV_ID,
  USER_ID,
  installMock,
  seedStoredSession,
  signIn,
  type ScriptedChunk,
  type ScriptedFact,
  type MockOptions,
} from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/stage-3/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const TEAMMATE = '22222222-2222-4222-8222-222222222222';

function shot(page: Page, name: string): Promise<Buffer> {
  const width = page.viewportSize()?.width ?? 0;
  return page.screenshot({ path: `${SHOTS}${name}-${String(width)}.png`, fullPage: false });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const wide = Array.from(document.querySelectorAll('body *'))
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter((x) => x.right > limit + 0.5)
      .map(
        (x) =>
          `${x.el.tagName.toLowerCase()}.${(x.el.getAttribute('class') ?? '').split(' ')[0] ?? ''}@${String(Math.round(x.right))}`,
      );
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: limit,
      bodyScrollWidth: document.body.scrollWidth,
      wide: wide.slice(0, 8),
    };
  });
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
}

const RULE_OF_ONE = 'Finance content uses the Rule of One framework and ends with a direct CTA.';

function fact(overrides: Partial<ScriptedFact> & { id: string }): ScriptedFact {
  return {
    user_id: USER_ID,
    scope: 'workspace',
    key: 'writing:finance-content-framework',
    value: RULE_OF_ONE,
    superseded_by: null,
    created_at: '2026-08-27T02:00:00Z',
    ...overrides,
  };
}

function chunkRow(overrides: Partial<ScriptedChunk> & { id: string }): ScriptedChunk {
  return {
    conversation_id: CONV_ID,
    user_id: USER_ID,
    scope: 'workspace',
    summary:
      'Ross asked for a Meta ad contrasting rent going to a landlord with a mortgage building equity, then asked for the headline to be shorter and blunter. He kept the third option and said the first two were too soft for the audience he is after.',
    audience: 'renters aspiring to homeownership',
    created_at: '2026-08-26T02:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}

const CONVERSATIONS = [
  { id: CONV_ID, title: 'Renting vs buying ad', last_active_at: '2026-08-26T02:00:00Z' },
];

async function openMemory(page: Page, options: MockOptions = {}): ReturnType<typeof installMock> {
  const state = await installMock(page, { conversations: CONVERSATIONS, ...options });
  await seedStoredSession(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Memory' }).click();
  return state;
}

test.describe('memory — the empty state a first-time user sees', () => {
  test('says how memory gets filled, including the sentence nobody would guess', async ({
    page,
  }) => {
    await openMemory(page);
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /been taught anything yet/ })).toBeVisible();
    // The feature is a sentence you say in the chat. If the page does not say it, nobody
    // finds it.
    await expect(page.getByText('“Remember that…”')).toBeVisible();
    await expect(page.getByText('Memory is shared')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add a note' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'memory-empty');
  });

  test('a note can be added from the empty state, and it goes through the server', async ({
    page,
  }) => {
    const state = await openMemory(page);
    await page.getByRole('button', { name: '+ Add a note' }).click();
    await page
      .getByLabel('Tell it something to remember')
      .fill('Our posts always end with a direct call to action.');
    await page.getByRole('button', { name: 'Save note' }).click();

    await expect(page.getByRole('status')).toContainText('Saved under');
    expect(state.memoryCalls).toHaveLength(1);
    expect(state.memoryCalls[0]?.body).toMatchObject({ action: 'add' });
    expect(state.memoryCalls[0]?.authorization).toContain('Bearer ');
    expect(state.postgrestWrites).toStrictEqual([]);
    await expect(
      page.getByText('Our posts always end with a direct call to action.'),
    ).toBeVisible();
  });
});

test.describe('memory — standing notes', () => {
  const facts = [
    fact({ id: 'f-mine' }),
    fact({
      id: 'f-theirs',
      user_id: TEAMMATE,
      key: 'audience:first-home-buyers',
      value: 'The main audience is first home buyers in Perth on a single income.',
      created_at: '2026-08-25T02:00:00Z',
    }),
  ];

  test('shows what it was told, by whom, and when — and only offers Forget on your own', async ({
    page,
  }) => {
    await openMemory(page, { facts, chunks: [chunkRow({ id: 'k1' })] });
    await expect(page.getByRole('tab', { name: /You told it/ })).toBeVisible();
    await expect(page.getByText(RULE_OF_ONE)).toBeVisible();
    await expect(page.getByText('Added by you · 27 Aug 2026')).toBeVisible();
    await expect(page.getByText('Added by a teammate · 25 Aug 2026')).toBeVisible();
    // A non-admin sees Forget on their own note and not on the teammate's.
    await expect(page.getByRole('button', { name: 'Forget' })).toHaveCount(1);
    // Nothing that looks like a debugging tool.
    const text = (await page.locator('.mem').innerText()).toLowerCase();
    expect(text).not.toContain('similarity');
    expect(text).not.toContain('embedding');
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    await expectNoHorizontalScroll(page);
    await shot(page, 'memory-facts');
  });

  test("an admin can remove a teammate's note", async ({ page }) => {
    await openMemory(page, { facts, admin: true });
    await expect(page.getByRole('button', { name: 'Forget' })).toHaveCount(2);
  });

  test('Forget says what it will do, then moves the note to Removed notes', async ({ page }) => {
    const state = await openMemory(page, { facts });
    await page.getByRole('button', { name: 'Forget' }).click();
    // The wording on the confirm step is the promise the button makes.
    await expect(page.getByRole('alert')).toContainText('stops using it from your next message');
    await expect(page.getByRole('alert')).toContainText('add it back');
    await page.getByRole('button', { name: 'Forget it' }).click();

    await expect(page.getByRole('status')).toContainText('Forgotten');
    await expect(page.getByText(RULE_OF_ONE)).toHaveCount(0);
    expect(state.memoryCalls.at(-1)?.body).toMatchObject({ action: 'forget', factId: 'f-mine' });
    expect(state.postgrestWrites).toStrictEqual([]);

    await page.getByRole('button', { name: /Removed notes/ }).click();
    await expect(page.getByText(RULE_OF_ONE)).toBeVisible();
    await expect(page.getByText('Removed by you')).toBeVisible();
    await page.getByRole('button', { name: 'Add it back' }).click();
    await expect(page.getByRole('status')).toContainText('Back in use');
    await expect(page.getByText(RULE_OF_ONE)).toBeVisible();
  });

  test('an edit shows as one note with its earlier wording kept', async ({ page }) => {
    const withHistory = [
      fact({
        id: 'f-old',
        value: 'Finance content uses the PAS framework.',
        superseded_by: 'f-mine',
        created_at: '2026-08-20T02:00:00Z',
      }),
      fact({ id: 'f-mine' }),
    ];
    const state = await openMemory(page, { facts: withHistory });
    // One note on screen, not two.
    await expect(page.locator('.mem__card')).toHaveCount(1);
    await page.getByRole('button', { name: /Earlier wording \(1\)/ }).click();
    await expect(page.getByRole('heading', { name: 'How this note has changed' })).toBeVisible();
    await expect(page.getByText('Finance content uses the PAS framework.')).toBeVisible();
    await expect(page.getByText('in use now')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'memory-history');

    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Reword this note').fill('Finance content ends with one clear CTA.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('earlier wording is kept');
    expect(state.memoryCalls.at(-1)?.body).toMatchObject({ action: 'edit', factId: 'f-mine' });
    await expect(page.locator('.mem__card')).toHaveCount(1);
  });
});

test.describe('memory — notes from conversations', () => {
  test('lists them with their conversation, date and audience, and deletes one for good', async ({
    page,
  }) => {
    const state = await openMemory(page, {
      facts: [fact({ id: 'f-mine' })],
      chunks: [chunkRow({ id: 'k1' }), chunkRow({ id: 'k2', created_at: '2026-08-24T02:00:00Z' })],
    });
    await page.getByRole('tab', { name: /From conversations/ }).click();
    await expect(page.getByText('written automatically from real conversations')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Renting vs buying ad' })).toHaveCount(2);
    await expect(
      page.getByText('26 Aug 2026 · for renters aspiring to homeownership'),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'memory-chunks');

    await page.getByRole('button', { name: 'Read the whole note' }).first().click();
    await expect(page.getByText('too soft for the audience he is after')).toBeVisible();

    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await expect(page.getByRole('alert')).toContainText('cannot be undone');
    await page.getByRole('button', { name: 'Delete it' }).click();
    await expect(page.getByRole('status')).toContainText('will not be used again');
    await expect(page.locator('.mem__card')).toHaveCount(1);
    expect(state.memoryCalls.at(-1)?.body).toMatchObject({
      action: 'delete_chunk',
      chunkId: 'k1',
    });
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('opens the conversation a note came from', async ({ page }) => {
    await openMemory(page, {
      facts: [fact({ id: 'f-mine' })],
      chunks: [chunkRow({ id: 'k1' })],
      messages: {
        [CONV_ID]: [
          {
            id: 'm1',
            role: 'user',
            content: 'Write me a Meta ad about renting versus buying.',
            created_at: '2026-08-26T02:00:00Z',
          },
        ],
      },
    });
    await page.getByRole('tab', { name: /From conversations/ }).click();
    await page.getByRole('button', { name: 'Open conversation' }).click();
    await expect(page.getByText('Write me a Meta ad about renting versus buying.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Renting vs buying ad' })).toBeVisible();
  });
});

test.describe('memory — refusals', () => {
  test('a deactivated account never reaches the page', async ({ page }) => {
    const state = await installMock(page, { account: 'deactivated', facts: [fact({ id: 'f1' })] });
    await signIn(page);
    // The login screen states a refusal politely, as a status rather than an alarm.
    await expect(page.getByRole('status')).toContainText('deactivated');
    await expect(page.getByRole('button', { name: 'Memory' })).toHaveCount(0);
    expect(state.memoryCalls).toStrictEqual([]);
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('a refusal from the server is shown in plain words, and nothing on screen changes', async ({
    page,
  }) => {
    await openMemory(page, {
      facts: [fact({ id: 'f-theirs', user_id: TEAMMATE })],
      admin: true,
      memoryFailure: {
        status: 403,
        body: {
          error: {
            code: 'NOT_YOURS',
            message: 'Only the person who added this, or an administrator, can remove it.',
            retryable: false,
          },
        },
      },
    });
    await page.getByRole('button', { name: 'Forget' }).click();
    await page.getByRole('button', { name: 'Forget it' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Only the person who added this, or an administrator, can remove it.',
    );
    await expect(page.getByText(RULE_OF_ONE)).toBeVisible();
  });

  test('the cap is explained, never shown as a number', async ({ page }) => {
    await openMemory(page, {
      memoryFailure: {
        status: 402,
        body: {
          error: {
            code: 'SPEND_CAP',
            message:
              'The monthly Claude spend cap has been reached, so the note was not saved. An admin can raise the cap in configuration.',
            retryable: false,
          },
        },
      },
    });
    await page.getByRole('button', { name: '+ Add a note' }).click();
    await page.getByLabel('Tell it something to remember').fill('Always sign off as Fundd.');
    await page.getByRole('button', { name: 'Save note' }).click();
    const status = page.getByRole('status');
    await expect(status).toContainText('spend cap has been reached');
    await expect(status).not.toContainText('402');
  });
});
