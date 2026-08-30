/**
 * The Team page in a real browser at 375 / 768 / 1280 (see playwright.config.ts), against a
 * scripted Supabase — no stack, no key, no spend.
 *
 * Part C, interface half:
 *   1/2 — an admin adds someone; the password is shown ONCE on a panel that says so, and is
 *         gone from the page the moment it is dismissed;
 *   3   — a non-admin sees the roster and no controls at all — and the endpoint is never
 *         called on their behalf;
 *   4   — the interface does not offer the two actions that would reach zero administrators,
 *         and when the server refuses one anyway the refusal is shown in words;
 *   8   — every change went to /functions/v1/admin; PostgREST saw no write at all;
 *   9   — the layout holds at all three widths with no horizontal scroll.
 *
 * Screenshots land in docs/assets/stage-3/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EMAIL,
  USER_ID,
  installMock,
  seedStoredSession,
  type MockOptions,
  type ScriptedStaff,
} from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/stage-3/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const ZOE = '22222222-2222-4222-8222-222222222222';
const ALEX = '33333333-3333-4333-8333-333333333333';

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

function staff(
  overrides: Partial<ScriptedStaff> & { user_id: string; email: string },
): ScriptedStaff {
  return {
    role: 'staff',
    is_active: true,
    is_admin: false,
    created_at: '2026-08-10T02:00:00Z',
    ...overrides,
  };
}

/**
 * A FUNCTION, not a shared array. The scripted admin endpoint mutates the staff rows it is
 * given (promote flips `is_admin`, deactivate flips `is_active`), and Playwright runs this
 * file with `workers: 1` in one process — so a module-level array of objects leaks state from
 * one test into the next. The promote test used to leave `zoe` an administrator for
 * everything after it, which only became visible once a later test cared whether she was one.
 */
function roster(): ScriptedStaff[] {
  return [
    staff({ user_id: ZOE, email: 'zoe@fundd.com.au' }),
    staff({ user_id: ALEX, email: 'alex@fundd.com.au', is_active: false }),
  ];
}

async function openTeam(page: Page, options: MockOptions = {}) {
  const state = await installMock(page, { admin: true, roster: roster(), ...options });
  await seedStoredSession(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Team' }).click();
  await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
  return state;
}

test.describe('the Team page', () => {
  test('1/8: an admin sees everyone, with the two facts that matter about each', async ({
    page,
  }) => {
    const state = await openTeam(page);

    // The signed-in person's own address is also in the top bar, so scope to the list.
    await expect(page.locator('.team__card', { hasText: EMAIL })).toBeVisible();
    await expect(page.getByText('zoe@fundd.com.au', { exact: true })).toBeVisible();
    await expect(page.getByText('alex@fundd.com.au', { exact: true })).toBeVisible();

    // Status and dates, not ids and not internal flags.
    await expect(page.getByText(/Administrator · added/)).toBeVisible();
    await expect(page.getByText(/No longer has access · added/)).toBeVisible();
    await expect(page.getByText('2 with access, 1 without · 1 administrator')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(USER_ID);
    await expect(page.locator('body')).not.toContainText('is_admin');

    // Sign-in times: the one thing the roster read cannot answer, so the page asks the server.
    await expect(page.getByText(/last signed in 27 Aug 2026/)).toBeVisible();
    await expect(page.getByText(/last signed in Never/).first()).toBeVisible();
    expect(state.adminCalls.map((c) => c.body['action'])).toStrictEqual(['sign_ins']);

    await shot(page, 'team-list');
    await expectNoHorizontalScroll(page);
  });

  test('1/2: adding someone shows the password once, then it is gone from the page', async ({
    page,
  }) => {
    const state = await openTeam(page);

    await page.getByRole('button', { name: '+ Add someone' }).click();
    await page.getByLabel('Their work email address').fill('newstarter@fundd.com.au');
    await shot(page, 'team-add');
    await page.getByRole('button', { name: 'Create account' }).click();

    // The hand-over panel: whose it is, the password, and the promise about it.
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toContainText('newstarter@fundd.com.au');
    await expect(page.getByRole('alertdialog')).toContainText('cannot be shown again');
    await expect(page.getByRole('alertdialog')).toContainText('Not by email');
    const password = state.issuedPasswords[0] ?? '';
    expect(password).not.toBe('');
    await expect(page.getByRole('alertdialog')).toContainText(password);
    await shot(page, 'team-password');
    await expectNoHorizontalScroll(page);

    // Dismissed: the password is nowhere on the page any more, and nowhere in storage.
    await page.getByRole('button', { name: /Done/ }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(password);
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
    }));
    expect(stored.local).not.toContain(password);
    expect(stored.session).not.toContain(password);

    // The new person is on the list, and PostgREST was never written to.
    await expect(page.getByText('newstarter@fundd.com.au', { exact: true })).toBeVisible();
    expect(state.postgrestWrites).toStrictEqual([]);
    expect(state.adminCalls.map((c) => c.body['action'])).toContain('create');
  });

  test('a duplicate email is refused in words that say what to do instead', async ({ page }) => {
    await openTeam(page);
    await page.getByRole('button', { name: '+ Add someone' }).click();
    await page.getByLabel('Their work email address').fill('zoe@fundd.com.au');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('status')).toContainText('already on the list');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('3: a non-admin sees the roster and no controls at all', async ({ page }) => {
    const state = await openTeam(page, { admin: false });

    await expect(page.getByText('zoe@fundd.com.au', { exact: true })).toBeVisible();
    await expect(page.getByText(/Only an administrator can add someone/)).toBeVisible();

    for (const label of [
      '+ Add someone',
      'Remove access',
      'Restore access',
      'Make administrator',
      'Remove administrator',
      'Reset password',
    ]) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    }
    // Not merely hidden buttons: the page never asks the server anything on their behalf.
    expect(state.adminCalls).toStrictEqual([]);
    expect(state.postgrestWrites).toStrictEqual([]);
    // And with no sign-in times to show, the column is absent rather than full of dashes.
    await expect(page.getByText(/last signed in/)).toHaveCount(0);

    await shot(page, 'team-member-view');
    await expectNoHorizontalScroll(page);
  });

  test('D72: Remove access is not offered on another ADMINISTRATOR, only once demoted', async ({
    page,
  }) => {
    // The reported case exactly: two administrators, and one is offered a control that would
    // take the other out of the building in a single tap.
    const state = await openTeam(page, {
      roster: [staff({ user_id: ZOE, email: 'zoe@fundd.com.au', is_admin: true })],
    });
    await expect(page.getByText('2 with access · 2 administrators')).toBeVisible();

    const zoe = page.locator('.team__card', { hasText: 'zoe@fundd.com.au' });
    // Demote and Reset password stay. Remove access does not.
    await expect(zoe.getByRole('button', { name: 'Remove administrator' })).toBeVisible();
    await expect(zoe.getByRole('button', { name: 'Reset password' })).toBeVisible();
    await expect(zoe.getByRole('button', { name: 'Remove access' })).toHaveCount(0);

    await shot(page, 'team-admin-no-remove');
    await expectNoHorizontalScroll(page);

    // Demote her, and the control appears — the rule is friction, not a dead end.
    await zoe.getByRole('button', { name: 'Remove administrator' }).click();
    await zoe.getByRole('button', { name: 'Remove administrator' }).click();
    await expect(page.getByText('2 with access · 1 administrator')).toBeVisible();
    await expect(zoe.getByRole('button', { name: 'Remove access' })).toBeVisible();
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('D72: a non-admin is still offered nothing, even with two administrators on screen', async ({
    page,
  }) => {
    // Tightening what an admin may do must not hand a member anything. Checked with an admin
    // colleague on screen, which is the shape the new rule is about.
    const state = await openTeam(page, {
      admin: false,
      roster: [staff({ user_id: ZOE, email: 'zoe@fundd.com.au', is_admin: true })],
    });
    for (const label of [
      'Remove access',
      'Restore access',
      'Make administrator',
      'Remove administrator',
      'Reset password',
      '+ Add someone',
    ]) {
      await expect(page.getByRole('button', { name: label }), label).toHaveCount(0);
    }
    expect(state.adminCalls).toStrictEqual([]);
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('the roster cards line up with the button above them (no stray list padding)', async ({
    page,
  }) => {
    // The cards sat ~40px right of "+ Add someone" because `.team__list` reset `list-style`
    // but not the UA stylesheet's `padding-inline-start`. Measured, not eyeballed.
    await openTeam(page);
    const button = await page.getByRole('button', { name: '+ Add someone' }).boundingBox();
    const card = await page.locator('.team__card').first().boundingBox();
    expect(button).not.toBeNull();
    expect(card).not.toBeNull();
    if (button === null || card === null) return;
    expect(Math.abs(card.x - button.x), 'left edges line up').toBeLessThanOrEqual(1);
    expect(Math.abs(card.width - button.width), 'and so do the widths').toBeLessThanOrEqual(1);
  });

  test('4: the page never offers the two actions that would reach zero administrators', async ({
    page,
  }) => {
    await openTeam(page);
    // The signed-in admin is the ONLY administrator. Their own row offers a password reset
    // and nothing else — no "Remove access", no "Remove administrator".
    const mine = page.locator('.team__card', { hasText: EMAIL });
    await expect(mine.getByRole('button', { name: 'Reset password' })).toBeVisible();
    await expect(mine.getByRole('button', { name: 'Remove access' })).toHaveCount(0);
    await expect(mine.getByRole('button', { name: 'Remove administrator' })).toHaveCount(0);
    await expect(mine.getByText('You', { exact: true })).toBeVisible();

    // Promote a second admin and the picture changes — for them, not for you.
    const zoe = page.locator('.team__card', { hasText: 'zoe@fundd.com.au' });
    await zoe.getByRole('button', { name: 'Make administrator' }).click();
    await expect(page.getByRole('alert')).toContainText('including yours');
    await shot(page, 'team-promote-confirm');
    await zoe.getByRole('button', { name: 'Make administrator' }).click();
    await expect(page.getByRole('status')).toContainText('can now add and remove people');
    await expect(zoe.getByRole('button', { name: 'Remove administrator' })).toBeVisible();
    await expect(mine.getByRole('button', { name: 'Remove administrator' })).toHaveCount(0);
  });

  test('4: when the SERVER refuses a change, the reason is shown as written', async ({ page }) => {
    const state = await openTeam(page, {
      adminFailure: {
        status: 403,
        body: {
          error: {
            code: 'LAST_ADMIN',
            message:
              'The Command Centre must always have at least one administrator. Make someone else an administrator first.',
            retryable: false,
          },
        },
      },
    });
    const zoe = page.locator('.team__card', { hasText: 'zoe@fundd.com.au' });
    await zoe.getByRole('button', { name: 'Remove access' }).click();
    await zoe.getByRole('button', { name: 'Remove access' }).click();
    await expect(page.getByRole('status')).toContainText('at least one administrator');
    expect(state.postgrestWrites).toStrictEqual([]);
  });

  test('deactivating says what survives, and restoring says the old password works', async ({
    page,
  }) => {
    await openTeam(page);
    const zoe = page.locator('.team__card', { hasText: 'zoe@fundd.com.au' });

    await zoe.getByRole('button', { name: 'Remove access' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Nothing they taught the assistant is removed',
    );
    await shot(page, 'team-deactivate-confirm');
    await zoe.getByRole('button', { name: 'Remove access' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Everything they taught the assistant stays',
    );

    // Now she reads as deactivated and the only thing offered is putting it back.
    await expect(zoe).toContainText('No longer has access');
    await expect(zoe.getByRole('button', { name: 'Reset password' })).toHaveCount(0);
    await zoe.getByRole('button', { name: 'Restore access' }).click();
    await zoe.getByRole('button', { name: 'Restore access' }).click();
    await expect(page.getByRole('status')).toContainText('password they already had');
  });

  test('a reset password is shown once, on the same panel, and says the old one has stopped', async ({
    page,
  }) => {
    const state = await openTeam(page);
    const zoe = page.locator('.team__card', { hasText: 'zoe@fundd.com.au' });
    await zoe.getByRole('button', { name: 'Reset password' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'current password stops working immediately',
    );
    await zoe.getByRole('button', { name: 'Reset password' }).click();

    await expect(page.getByRole('alertdialog')).toContainText('New password for zoe@fundd.com.au');
    const password = state.issuedPasswords[0] ?? '';
    await expect(page.getByRole('alertdialog')).toContainText(password);
    await page.getByRole('button', { name: /Done/ }).click();
    await expect(page.locator('body')).not.toContainText(password);
  });

  test('9: the layout holds with a long email and a long roster', async ({ page }) => {
    await openTeam(page, {
      roster: [
        ...roster(),
        ...Array.from({ length: 20 }, (_v, i) =>
          staff({
            user_id: `44444444-4444-4444-8444-4444444444${String(i).padStart(2, '0')}`,
            email: `a-very-long-address-for-testing-${String(i)}@a-long-domain.example.com.au`,
          }),
        ),
      ],
    });
    await expectNoHorizontalScroll(page);
    await shot(page, 'team-long-list');
  });
});
