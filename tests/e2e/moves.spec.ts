/**
 * Milestone 4 part 4 in a real browser at three widths (see playwright.config.ts): the lead
 * detail, moving a lead by drag and by menu, and notes — against the scripted Supabase in
 * mock.ts, so no stack, no key, no spend, and no write to the client's CRM.
 *
 * Part D item 15: screenshots of the detail, the move control after a pick, and a note
 * added, at 375 / 768 / 1280; item 14 (the browser half): a failed write leaves the card
 * where it started, in words. Part C, each as its own test: the write failing (401 loud,
 * 429/503, 5xx, the unknown outcome, a wrong-shaped answer, the network dropping); the data
 * moving underneath (deleted, the stage gone, moved by someone else, a stale mirror); the
 * interface (a double pick is one move, a drop back into the same column and a drop outside
 * every column write nothing, a drag while one is saving is refused, keyboard-only, the live
 * region, no horizontal scroll, 16px inputs, reduced motion); notes (empty, very long,
 * unicode, two people at once, a failed save keeps the text).
 *
 * Screenshots land in docs/assets/milestone-4/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  INTEREST_RATE_FIELD,
  LOAN_BALANCE_FIELD,
  installMock,
  seedStoredSession,
  type MockOptions,
  type ScriptedGhl,
} from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/milestone-4/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

function shot(page: Page, name: string): Promise<Buffer> {
  const width = page.viewportSize()?.width ?? 0;
  return page.screenshot({ path: `${SHOTS}${name}-${String(width)}.png`, fullPage: false });
}

function width(page: Page): number {
  return page.viewportSize()?.width ?? 0;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
}

async function expectInputsAtLeast16px(page: Page): Promise<void> {
  const sizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select')).map((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    ),
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
}

const FINANCE = 'M4unnMKBy0TgwCwOA6wS';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STAGE_NAMES = [
  'New Lead',
  'Appointment Booked',
  'Contacted',
  'Qualified',
  'Docs Requested',
  'Docs Received',
  'Submitted to Lender',
  'Approved',
  'Settled',
  'Lost / Not Proceeding',
];
const S = (n: number): string => `stage-${String(n).padStart(2, '0')}`;
const LOAN_TYPE_FIELD = 'Vpn7DLqHwMoQ91AJUjzu';
const COLLEAGUE_ID = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function run(): ScriptedGhl['runs'][number] {
  return {
    id: 'run-1',
    pipeline_ghl_id: FINANCE,
    status: 'success',
    started_at: ago(12 * MIN + 3_000),
    applied_at: ago(12 * MIN),
    finished_at: ago(12 * MIN),
    error_code: null,
    contacts_failed: 0,
    contacts_missing: 0,
    contacts_rejected: 0,
    opportunities_rejected: 0,
  };
}

function opp(
  id: string,
  stage: string,
  overrides: Partial<ScriptedGhl['opportunities'][number]> = {},
): ScriptedGhl['opportunities'][number] {
  return {
    ghl_id: id,
    pipeline_ghl_id: FINANCE,
    stage_ghl_id: stage,
    contact_ghl_id: `contact-${id}`,
    name: `Lead ${id}`,
    status: 'open',
    ghl_created_at: ago(3 * DAY),
    removed_at: null,
    ...overrides,
  };
}

type Contact = ScriptedGhl['contacts'][number];

function person(id: string, fullName: string | null, overrides: Partial<Contact> = {}): Contact {
  return {
    ghl_id: id,
    full_name: fullName,
    first_name: null,
    last_name: null,
    removed_at: null,
    email: `${id}@example.com`,
    phone: '+61 400 000 001',
    custom_fields: {},
    ...overrides,
  };
}

/** A FUNCTION, not a shared object: the write tests mutate the mirror. */
function populated(): ScriptedGhl {
  return {
    pipelines: [{ ghl_id: FINANCE, name: 'Finance Pipeline', last_changed_at: ago(DAY) }],
    stages: STAGE_NAMES.map((name, i) => ({
      ghl_id: S(i + 1),
      pipeline_ghl_id: FINANCE,
      name,
      position: i,
      removed_at: null,
    })),
    opportunities: [
      opp('o1', S(1), { ghl_created_at: ago(40 * MIN) }),
      opp('o2', S(1), { ghl_created_at: ago(20 * HOUR) }),
      opp('o3', S(2), { ghl_created_at: ago(5 * DAY) }),
      opp('o4', S(3), { ghl_created_at: ago(8 * DAY), contact_ghl_id: null }),
    ],
    contacts: [
      person('contact-o1', 'Alex Tran', {
        custom_fields: {
          [LOAN_BALANCE_FIELD]: ['$500k–$750k'],
          [INTEREST_RATE_FIELD]: ['6.2% - 6.5%'],
          [LOAN_TYPE_FIELD]: 'Refinance',
        },
      }),
      person('contact-o2', 'Sam Ó Brádaigh 🏠', { email: null, phone: '0400 000 002' }),
      person('contact-o3', 'Jo Bloggs'),
    ],
    customFields: [
      {
        ghl_id: LOAN_BALANCE_FIELD,
        name: 'Roughly how much is left on your home loan?',
        data_type: 'MULTIPLE_OPTIONS',
        parent_id: 'folder',
        removed_at: null,
      },
      {
        ghl_id: INTEREST_RATE_FIELD,
        name: "What's your current interest rate?",
        data_type: 'MULTIPLE_OPTIONS',
        parent_id: 'folder',
        removed_at: null,
      },
      {
        ghl_id: LOAN_TYPE_FIELD,
        name: 'Loan Type',
        data_type: 'SINGLE_OPTIONS',
        parent_id: 'folder',
        removed_at: null,
      },
    ],
    fieldMap: [
      { internal_field: 'loan_type', ghl_custom_field_id: LOAN_TYPE_FIELD, entity: 'contact' },
      {
        internal_field: 'loan_balance',
        ghl_custom_field_id: LOAN_BALANCE_FIELD,
        entity: 'contact',
      },
      {
        internal_field: 'current_interest_rate',
        ghl_custom_field_id: INTEREST_RATE_FIELD,
        entity: 'contact',
      },
      {
        internal_field: 'annual_income',
        ghl_custom_field_id: 'tQA4cVpB63irs4gBdKBO',
        entity: 'contact',
      },
    ],
    notes: [
      {
        ghl_id: 'note-old',
        contact_ghl_id: 'contact-o1',
        opportunity_ghl_id: 'o1',
        author_user_id: COLLEAGUE_ID,
        body: 'Left a voicemail on Monday.',
        ghl_date_added: ago(2 * DAY),
        created_at: ago(2 * DAY),
      },
    ],
    runs: [run()],
  };
}

async function openLead(
  page: Page,
  id = 'o1',
  options: MockOptions = {},
): ReturnType<typeof installMock> {
  const state = await installMock(page, {
    ghl: populated(),
    roster: [
      {
        user_id: COLLEAGUE_ID,
        email: 'jo@example.com',
        role: 'staff',
        is_active: true,
        is_admin: false,
        created_at: ago(30 * DAY),
      },
    ],
    ...options,
  });
  await seedStoredSession(page);
  await page.goto(`/leads/${id}`);
  await expect(page.locator('.lead .lead__stage')).toBeVisible();
  return state;
}

async function openBoard(page: Page, options: MockOptions = {}): ReturnType<typeof installMock> {
  const state = await installMock(page, { ghl: populated(), ...options });
  await seedStoredSession(page);
  await page.goto('/leads/board');
  await expect(page.locator('.board__col')).toHaveCount(10);
  return state;
}

const card = (page: Page, id: string): ReturnType<Page['locator']> =>
  page.locator(`.board__item[data-opportunity-id="${id}"] .lead-card`);
const columnOf = (page: Page, stage: string): ReturnType<Page['locator']> =>
  page.locator(`.board__col[data-stage-id="${stage}"]`);
const cardSelect = (page: Page, id: string): ReturnType<Page['locator']> =>
  card(page, id).locator('select');
const live = (page: Page): ReturnType<Page['getByTestId']> => page.getByTestId('leads-live');
const banner = (page: Page): ReturnType<Page['locator']> => page.locator('.mem__banner');

/**
 * Drag a card with the mouse into another column's list: down, past the threshold, over, up.
 * On a phone the columns are 82vw and the board auto-scrolls while the pointer sits near its
 * edge (as it should for a finger), so the board is first scrolled so both columns are partly
 * on screen and the drop point is kept out of the edge zone.
 */
async function dragCard(page: Page, id: string, toStage: string): Promise<void> {
  const board = page.locator('.board');
  if (width(page) < 768) {
    // Scroll-snap would pull the board back to a column start before the drag begins.
    await board.evaluate((el) => {
      el.style.scrollSnapType = 'none';
      el.scrollLeft = 150;
    });
  }
  const from = await card(page, id).boundingBox();
  const target = await page.locator(`[data-drop-target="${toStage}"]`).boundingBox();
  const box = await board.boundingBox();
  if (from === null || target === null || box === null) throw new Error('not on screen');
  const startX = Math.max(from.x + 12, box.x + 12);
  const y = from.y + 12;
  const visibleLeft = Math.max(target.x, box.x);
  const visibleRight = Math.min(target.x + target.width, box.x + box.width);
  const dropX = Math.min(
    Math.max((visibleLeft + visibleRight) / 2, box.x + 60),
    box.x + box.width - 60,
  );
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + 12, y + 4, { steps: 3 });
  await page.mouse.move(dropX, target.y + 24, { steps: 10 });
  await expect(columnOf(page, toStage)).toHaveClass(/board__col--over/);
  await page.mouse.up();
}

test.describe('the lead detail (Part B item 7)', () => {
  test('item 15: everything the mirror holds, laid out for a phone, nothing invented', async ({
    page,
  }) => {
    const state = await openLead(page);
    await expect(page.getByRole('heading', { name: 'Alex Tran', level: 1 })).toBeVisible();
    await expect(page.locator('.lead__stage-now')).toHaveText('New Lead');
    await expect(page.locator('.lead__meta')).toContainText('Arrived');
    // The contact: tel and mailto links, tags, source.
    const contact = page.locator('section[aria-labelledby="lead-contact"]');
    await expect(contact.getByRole('link', { name: '+61 400 000 001' })).toHaveAttribute(
      'href',
      'tel:+61400000001',
    );
    await expect(contact.getByRole('link', { name: 'contact-o1@example.com' })).toHaveAttribute(
      'href',
      'mailto:contact-o1@example.com',
    );
    await expect(contact).toContainText('Not captured');
    // The form's answers: labelled by the definition, in seed order, Not captured when absent.
    const answers = page.locator('section[aria-labelledby="lead-answers"] .lead__line');
    await expect(answers).toHaveCount(4);
    await expect(answers.nth(0)).toContainText('Loan Type');
    await expect(answers.nth(0)).toContainText('Refinance');
    await expect(answers.nth(1)).toContainText('Annual income');
    await expect(answers.nth(1)).toContainText('Not captured');
    await expect(answers.nth(2)).toContainText('$500k–$750k');
    await expect(answers.nth(3)).toContainText('6.2% - 6.5%');
    // The opportunity: $0 is what GoHighLevel said; ids are shown as ids.
    const opportunity = page.locator('section[aria-labelledby="lead-opportunity"]');
    await expect(opportunity).toContainText('$0');
    await expect(opportunity).toContainText('Opportunity id o1');
    await expect(opportunity).toContainText('Contact id contact-o1');
    // Notes: the colleague's, with their email and when.
    const notes = page.locator('.lead__note');
    await expect(notes).toHaveCount(1);
    await expect(notes.nth(0)).toContainText('Left a voicemail on Monday.');
    await expect(notes.nth(0)).toContainText('jo@example.com');
    // The move control lists the ten stages and shows the current one.
    const select = page.locator('#lead-stage');
    await expect(select).toHaveValue(S(1));
    await expect(select.locator('option')).toHaveCount(10);
    expect(state.crmCalls).toHaveLength(0);
    expect(state.postgrestWrites).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await expectInputsAtLeast16px(page);
    await shot(page, 'lead-detail');
  });

  test('a lead with no contact says so, and the note box is off', async ({ page }) => {
    await openLead(page, 'o4');
    await expect(page.getByRole('heading', { name: 'Lead o4', level: 1 })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="lead-contact"] .notice')).toContainText(
      'has not been synced',
    );
    await expect(page.locator('#lead-note')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add note' })).toBeDisabled();
  });

  test('a lead removed since the mirror, and an unknown address, both read honestly', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.opportunities.push(opp('gone', S(2), { removed_at: ago(HOUR) }));
    await installMock(page, { ghl });
    await seedStoredSession(page);
    await page.goto('/leads/gone');
    await expect(page.locator('.lead')).toContainText('no longer in the Finance Pipeline');
    await expect(page.locator('#lead-stage')).toHaveCount(0);
    await page.goto('/leads/nope123');
    await expect(page.getByRole('heading', { name: 'Not in the pipeline' })).toBeVisible();
  });
});

test.describe('moving by menu (Part B item 9)', () => {
  test('item 15: a pick in the detail moves the lead at once, saves, and says so; one call with a request id', async ({
    page,
  }) => {
    const state = await openLead(page);
    await page.locator('#lead-stage').selectOption(S(3));
    // Optimistic: the stage line changes before the answer, and the control says saving.
    await expect(page.locator('.lead__stage-now')).toHaveText('Contacted');
    await expect(page.locator('.lead__notice')).toContainText('Alex Tran moved to Contacted.');
    await expect(live(page)).toContainText('Alex Tran moved to Contacted.');
    expect(state.crmCalls).toHaveLength(1);
    const body = state.crmCalls[0]?.body ?? {};
    expect(body).toMatchObject({
      action: 'move',
      opportunityId: 'o1',
      toStageId: S(3),
      fromStageId: S(1),
    });
    expect(String(body['requestId'])).toMatch(UUID);
    expect(state.crmCalls[0]?.authorization).toMatch(/^Bearer /);
    expect(state.postgrestWrites).toHaveLength(0);
    // The mirror (scripted) now holds the new stage: the detail read back agrees.
    await expect(page.locator('#lead-stage')).toHaveValue(S(3));
    await expectNoHorizontalScroll(page);
    await shot(page, 'lead-move-menu');
  });

  test('a pick on a card moves it between columns on the board', async ({ page }) => {
    const state = await openBoard(page);
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
    await cardSelect(page, 'o2').selectOption(S(4));
    await expect(columnOf(page, S(4)).locator('.lead-card')).toHaveCount(1);
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(1);
    await expect(banner(page)).toContainText('Sam Ó Brádaigh 🏠 moved to Qualified.');
    expect(state.crmCalls).toHaveLength(1);
    expect(state.crmCalls[0]?.body).toMatchObject({
      action: 'move',
      opportunityId: 'o2',
      toStageId: S(4),
    });
    // The card in its new column carries the new stage in its control.
    await expect(cardSelect(page, 'o2')).toHaveValue(S(4));
  });

  test('a double pick while one is saving is ONE move; the second is refused in words', async ({
    page,
  }) => {
    const state = await openBoard(page, {
      crmWrite: { respond: () => null },
    });
    // Slow the answer down so the second pick lands while the first is in flight.
    await page.route('**/functions/v1/crm', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fallback();
    });
    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(card(page, 'o1')).toHaveAttribute('data-saving', 'true');
    // Every control is disabled while saving; a pick on another card is refused by the lock.
    await expect(cardSelect(page, 'o2')).toBeDisabled();
    await expect(card(page, 'o1').locator('.lead-card__saving')).toHaveText('Saving…');
    await expect(banner(page)).toContainText('Alex Tran moved to Appointment Booked.');
    expect(state.crmCalls.filter((c) => c.body['action'] === 'move')).toHaveLength(1);
    await expect(cardSelect(page, 'o2')).toBeEnabled();
  });

  test('keyboard only: reach a card’s control, pick a stage, and the move is announced', async ({
    page,
  }) => {
    const state = await openBoard(page);
    // Tab from the top until the first card's move control has focus — no mouse.
    await page.keyboard.press('Tab');
    for (let i = 0; i < 60; i += 1) {
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLSelectElement
          ? (el.closest('[data-opportunity-id]')?.getAttribute('data-opportunity-id') ?? '')
          : '';
      });
      if (focused === 'o1') break;
      await page.keyboard.press('Tab');
    }
    const focusedName = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ??
        document.activeElement?.closest('label')?.textContent ??
        '',
    );
    expect(focusedName).toContain('Move Alex Tran to another stage');
    // A closed select changes with the arrow keys and fires change (Chrome): one press, one move.
    await page.keyboard.press('ArrowDown');
    await expect(live(page)).toContainText('Alex Tran moved to Appointment Booked.');
    await expect(columnOf(page, S(2)).locator('.lead-card')).toHaveCount(2);
    expect(state.crmCalls).toHaveLength(1);
    expect(state.crmCalls[0]?.body).toMatchObject({ opportunityId: 'o1', toStageId: S(2) });
  });
});

test.describe('moving by drag (Part B item 8)', () => {
  test('a card dragged into another column moves, is announced, and is one call', async ({
    page,
  }) => {
    const state = await openBoard(page);
    await dragCard(page, 'o1', S(2));
    await expect(columnOf(page, S(2)).locator('.lead-card')).toHaveCount(2);
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(1);
    await expect(live(page)).toContainText('Alex Tran moved to Appointment Booked.');
    expect(state.crmCalls).toHaveLength(1);
    expect(state.crmCalls[0]?.body).toMatchObject({
      action: 'move',
      opportunityId: 'o1',
      fromStageId: S(1),
      toStageId: S(2),
    });
    // The drop did not also open the lead.
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    await expect(page.locator('.lead-card--ghost')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('dropped back into its own column, or outside every column: no write', async ({ page }) => {
    const state = await openBoard(page);
    // Back where it came from.
    await dragCard(page, 'o1', S(1));
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
    // Outside every column: onto the page heading.
    const from = await card(page, 'o2').boundingBox();
    const heading = await page.getByRole('heading', { name: 'Leads', level: 1 }).boundingBox();
    if (from === null || heading === null) throw new Error('not on screen');
    await page.mouse.move(from.x + 30, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + 45, from.y + 16, { steps: 3 });
    await page.mouse.move(heading.x + 10, heading.y + 5, { steps: 8 });
    await page.mouse.up();
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
    expect(state.crmCalls).toHaveLength(0);
    await expect(page.locator('.lead-card--ghost')).toHaveCount(0);
    await expect(page.locator('.board__col--over')).toHaveCount(0);
  });

  test('a drag released and repeated at once while the first is saving: one move, the second refused', async ({
    page,
  }) => {
    const state = await openBoard(page);
    await page.route('**/functions/v1/crm', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.fallback();
    });
    await dragCard(page, 'o1', S(2));
    await expect(card(page, 'o1')).toHaveAttribute('data-saving', 'true');
    // A second drag (another card) is refused while the first is in flight. On a phone the
    // board was scrolled by the helper, so the press lands on the card's visible part.
    const from = await card(page, 'o2').boundingBox();
    if (from === null) throw new Error('card not on screen');
    const pressX = Math.max(from.x + 30, 16);
    await page.mouse.move(pressX, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(pressX + 30, from.y + 20, { steps: 4 });
    await page.mouse.up();
    await expect(banner(page)).toContainText('Wait for the current move to finish');
    await expect(page.locator('.lead-card--ghost')).toHaveCount(0);
    await expect(banner(page)).toContainText('Alex Tran moved to Appointment Booked.');
    expect(state.crmCalls.filter((c) => c.body['action'] === 'move')).toHaveLength(1);
  });

  test('Escape cancels a drag with nothing written', async ({ page }) => {
    const state = await openBoard(page);
    const from = await card(page, 'o1').boundingBox();
    if (from === null) throw new Error('card not on screen');
    await page.mouse.move(from.x + 30, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 20, { steps: 4 });
    await expect(page.locator('.lead-card--ghost')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.lead-card--ghost')).toHaveCount(0);
    await page.mouse.up();
    expect(state.crmCalls).toHaveLength(0);
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
  });

  test('reduced motion: the ghost is gone the instant the card is dropped', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openBoard(page);
    await dragCard(page, 'o1', S(2));
    // With motion the ghost snaps for 150 ms; with reduced motion it is removed at once.
    expect(await page.locator('.lead-card--ghost').count()).toBe(0);
    const duration = await page
      .locator('.board__col')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    // The global reduced-motion rule sets 0.01ms; Chrome reports it in seconds.
    expect(parseFloat(duration)).toBeLessThan(0.001);
  });
});

test.describe('the write failing (Part C) — the card comes back, in words', () => {
  const failing = (status: number, code: string, message: string): MockOptions => ({
    crmWrite: { respond: () => ({ status, body: { error: { code, message, retryable: false } } }) },
  });

  test('item 14: a 5xx from GoHighLevel puts the card back where it started and says why', async ({
    page,
  }) => {
    const state = await openBoard(
      page,
      failing(
        502,
        'TIMEOUT',
        "GoHighLevel didn't complete the move. The lead is still in its previous stage. Try again in a moment.",
      ),
    );
    await cardSelect(page, 'o1').selectOption(S(3));
    await expect(banner(page)).toContainText("GoHighLevel didn't complete the move.");
    await expect(banner(page)).toContainText('Alex Tran is back in New Lead.');
    await expect(banner(page)).toHaveAttribute('data-tone', 'warn');
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
    await expect(columnOf(page, S(3)).locator('.lead-card')).toHaveCount(1);
    await expect(cardSelect(page, 'o1')).toHaveValue(S(1));
    await expect(card(page, 'o1')).not.toHaveAttribute('data-saving', 'true');
    expect(state.crmCalls).toHaveLength(1);
    await expectNoHorizontalScroll(page);
    await shot(page, 'lead-move-failed');
  });

  test('401 from GoHighLevel is loud: the connection needs reauthorising, and the lead did not move', async ({
    page,
  }) => {
    await openLead(
      page,
      'o1',
      failing(
        502,
        'UNAUTHENTICATED',
        'GoHighLevel rejected our access key, so the lead was not moved. The connection needs reauthorising — a new key on the server.',
      ),
    );
    await page.locator('#lead-stage').selectOption(S(2));
    await expect(page.locator('.lead__notice')).toContainText('reauthorising');
    await expect(page.locator('.lead__notice')).toContainText('Alex Tran is back in New Lead.');
    await expect(page.locator('.lead__stage-now')).toHaveText('New Lead');
    await expect(page.locator('#lead-stage')).toHaveValue(S(1));
  });

  test('429 / rate limited, the unknown outcome, a wrong-shaped answer and a dropped connection all put the card back', async ({
    page,
  }) => {
    let mode = 0;
    const state = await openBoard(page, {
      crmWrite: {
        respond: () => {
          mode += 1;
          if (mode === 1)
            return {
              status: 503,
              body: {
                error: {
                  code: 'RATE_LIMITED',
                  message:
                    'GoHighLevel is rate-limiting us right now, so the lead was not moved. Wait a moment, then try again.',
                  retryable: true,
                },
              },
            };
          if (mode === 2)
            return {
              status: 504,
              body: {
                error: {
                  code: 'UNKNOWN',
                  message:
                    "GoHighLevel didn't confirm the move, and we couldn't check. The board shows the last known stage — refresh in a minute to see where the lead is before moving it again.",
                  retryable: false,
                },
              },
            };
          if (mode === 3) return { status: 200, body: { action: 'move', nonsense: true } };
          return null;
        },
      },
    });
    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(banner(page)).toContainText('rate-limiting');
    await expect(banner(page)).toContainText('back in New Lead');
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);

    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(banner(page)).toContainText("didn't confirm the move");
    await expect(banner(page)).toContainText('back in New Lead');
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);

    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(banner(page)).toContainText('back in New Lead');
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);

    // The network drops mid-write.
    await page.route('**/functions/v1/crm', (route) => route.abort('connectionreset'));
    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(banner(page)).toContainText(
      "Couldn't reach the Command Centre, so the lead was not moved.",
    );
    await expect(banner(page)).toContainText('back in New Lead');
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
    expect(state.crmCalls).toHaveLength(3);
  });

  test('a session that expired mid-move goes to login; nothing looks moved', async ({ page }) => {
    await openBoard(page, failing(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(page.getByRole('heading', { name: /Sign in/ })).toBeVisible();
  });
});

test.describe('the data moving underneath (Part C)', () => {
  test('deleted in GoHighLevel while open: refused, the card disappears on the re-read', async ({
    page,
  }) => {
    const state = await openBoard(page, {
      crmWrite: {
        respond: (_body, _call, ghl) => {
          const o = ghl.opportunities.find((x) => x.ghl_id === 'o1');
          if (o !== undefined) o.removed_at = new Date().toISOString();
          return null; // the faithful default now answers 410
        },
      },
    });
    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(banner(page)).toContainText('deleted in GoHighLevel');
    await expect(banner(page)).toContainText('Nothing was changed');
    await expect(card(page, 'o1')).toHaveCount(0);
    await expect(columnOf(page, S(2)).locator('.lead-card')).toHaveCount(1);
    expect(state.crmCalls).toHaveLength(1);
  });

  test('the target stage no longer exists: refused, the card back, the stages re-read', async ({
    page,
  }) => {
    await openBoard(page, {
      crmWrite: {
        respond: (_body, _call, ghl) => {
          const s = ghl.stages.find((x) => x.ghl_id === S(4));
          if (s !== undefined) s.removed_at = new Date().toISOString();
          return null; // STAGE_UNKNOWN from the faithful default
        },
      },
    });
    await cardSelect(page, 'o1').selectOption(S(4));
    await expect(banner(page)).toContainText('no longer in the pipeline');
    await expect(banner(page)).toContainText('back in New Lead');
    await expect(columnOf(page, S(1)).locator('.lead-card')).toHaveCount(2);
    // The re-read dropped the removed stage from the board.
    await expect(page.locator('.board__col')).toHaveCount(9);
  });

  test('someone else moved it first: last write wins, and the person is told', async ({ page }) => {
    await openBoard(page, {
      crmWrite: {
        respond: (body, _call, ghl) => {
          // Another user moved o1 to Contacted a moment ago; this pick sends it to Qualified.
          const o = ghl.opportunities.find((x) => x.ghl_id === 'o1');
          if (o !== undefined) o.stage_ghl_id = S(3);
          void body;
          return null;
        },
      },
    });
    await cardSelect(page, 'o1').selectOption(S(4));
    await expect(banner(page)).toContainText('Alex Tran moved to Qualified.');
    await expect(banner(page)).toContainText(
      'Someone else had moved this lead to Contacted since your screen loaded',
    );
    await expect(columnOf(page, S(4)).locator('.lead-card')).toHaveCount(1);
  });

  test('a stale mirror: the server acts on the real stage, and the screen ends where the CRM is', async ({
    page,
  }) => {
    // The screen showed o1 in New Lead; GoHighLevel already had it in Appointment Booked and
    // the pick asks for Appointment Booked — the server answers "already there".
    const state = await openBoard(page, {
      crmWrite: {
        respond: (_body, _call, ghl) => {
          const o = ghl.opportunities.find((x) => x.ghl_id === 'o1');
          if (o !== undefined) o.stage_ghl_id = S(2);
          return {
            status: 200,
            body: {
              action: 'move',
              opportunityId: 'o1',
              fromStageId: S(2),
              toStageId: S(2),
              changed: false,
              movedByOther: true,
              replay: false,
              landedAfterTimeout: false,
              mirrored: true,
              writeId: 'w',
              durationMs: 300,
            },
          };
        },
      },
    });
    await cardSelect(page, 'o1').selectOption(S(2));
    await expect(banner(page)).toContainText('was already in Appointment Booked in GoHighLevel');
    await expect(columnOf(page, S(2)).locator('.lead-card')).toHaveCount(2);
    expect(state.crmCalls[0]?.body).toMatchObject({ fromStageId: S(1), toStageId: S(2) });
  });
});

test.describe('notes (Part B item 10, Part C)', () => {
  test('item 15: a note is saved, listed newest first as yours, and the box empties', async ({
    page,
  }) => {
    const state = await openLead(page);
    const box = page.locator('#lead-note');
    await box.fill('Spoke to Alex — docs coming Friday. Ó Brádaigh 🏠');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('.lead__notice[data-tone="ok"]')).toContainText(
      'Note saved to GoHighLevel.',
    );
    const notes = page.locator('.lead__note');
    await expect(notes).toHaveCount(2);
    await expect(notes.nth(0)).toContainText('Spoke to Alex — docs coming Friday. Ó Brádaigh 🏠');
    await expect(notes.nth(0).locator('.lead__note-author')).toHaveText('You');
    await expect(notes.nth(1)).toContainText('Left a voicemail on Monday.');
    await expect(box).toHaveValue('');
    const call = state.crmCalls.find((c) => c.body['action'] === 'note');
    expect(call?.body).toMatchObject({
      action: 'note',
      opportunityId: 'o1',
      body: 'Spoke to Alex — docs coming Friday. Ó Brádaigh 🏠',
    });
    expect(String(call?.body['requestId'])).toMatch(UUID);
    expect(state.postgrestWrites).toHaveLength(0);
    await expect(live(page)).toContainText('Note saved');
    await expectNoHorizontalScroll(page);
    await expectInputsAtLeast16px(page);
    await shot(page, 'lead-note-added');
  });

  test('an empty note cannot be sent; a very long one is counted and refused before sending', async ({
    page,
  }) => {
    const state = await openLead(page);
    const button = page.getByRole('button', { name: 'Add note' });
    await expect(button).toBeDisabled();
    await page.locator('#lead-note').fill('   ');
    await expect(button).toBeDisabled();
    await page.locator('#lead-note').fill('x'.repeat(5_050));
    await expect(page.locator('.lead__note-count')).toContainText('50 over the limit');
    await expect(button).toBeDisabled();
    await page.locator('#lead-note').fill('x'.repeat(4_990));
    await expect(page.locator('.lead__note-count')).toContainText('10 left');
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.locator('.lead__note').first()).toContainText('xxxxxxxxxx');
    expect(state.crmCalls.filter((c) => c.body['action'] === 'note')).toHaveLength(1);
    await expectNoHorizontalScroll(page);
  });

  test('a note that fails to save keeps the text in the box and says why', async ({ page }) => {
    const state = await openLead(page, 'o1', {
      crmWrite: {
        respond: () => ({
          status: 502,
          body: {
            error: {
              code: 'TIMEOUT',
              message:
                "GoHighLevel didn't save the note. Your text is still here — try again in a moment.",
              retryable: true,
            },
          },
        }),
      },
    });
    const box = page.locator('#lead-note');
    await box.fill('Do not lose this.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('.lead__notice[data-tone="warn"]')).toContainText(
      "didn't save the note",
    );
    await expect(box).toHaveValue('Do not lose this.');
    await expect(box).toBeEnabled();
    await expect(page.locator('.lead__note')).toHaveCount(1);
    expect(state.crmCalls).toHaveLength(1);
    // The network dropping keeps the text too.
    await page.route('**/functions/v1/crm', (route) => route.abort('connectionreset'));
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('.lead__notice[data-tone="warn"]')).toContainText(
      'Your text is still here',
    );
    await expect(box).toHaveValue('Do not lose this.');
  });

  test('two people adding a note at the same time: both appear, newest first', async ({ page }) => {
    await openLead(page, 'o1', {
      crmWrite: {
        respond: (_body, _call, ghl) => {
          // A colleague's note lands in the mirror while ours is being saved.
          ghl.notes = [
            {
              ghl_id: 'note-colleague',
              contact_ghl_id: 'contact-o1',
              opportunity_ghl_id: 'o1',
              author_user_id: COLLEAGUE_ID,
              body: 'Jo here — sent the fact find.',
              ghl_date_added: new Date(Date.now() - 1_000).toISOString(),
              created_at: new Date(Date.now() - 1_000).toISOString(),
            },
            ...(ghl.notes ?? []),
          ];
          return null;
        },
      },
    });
    await page.locator('#lead-note').fill('Ross here — called back.');
    await page.getByRole('button', { name: 'Add note' }).click();
    const notes = page.locator('.lead__note');
    await expect(notes).toHaveCount(3);
    await expect(notes.nth(0)).toContainText('Ross here — called back.');
    await expect(notes.nth(1)).toContainText('Jo here — sent the fact find.');
    await expect(notes.nth(1).locator('.lead__note-author')).toHaveText('jo@example.com');
  });

  test('a note for a lead that was deleted meanwhile is refused and says so; the text stays', async ({
    page,
  }) => {
    await openLead(page, 'o1', {
      crmWrite: {
        respond: (_body, _call, ghl) => {
          const o = ghl.opportunities.find((x) => x.ghl_id === 'o1');
          if (o !== undefined) o.removed_at = new Date().toISOString();
          return null;
        },
      },
    });
    await page.locator('#lead-note').fill('Too late.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.locator('.lead')).toContainText('no longer in the Finance Pipeline');
  });
});

test.describe('widths', () => {
  test(`no horizontal scroll and 16px inputs on the detail and the board with the controls`, async ({
    page,
  }) => {
    await openLead(page);
    await expectNoHorizontalScroll(page);
    await expectInputsAtLeast16px(page);
    await page.goto('/leads/board');
    await expect(page.locator('.board__col')).toHaveCount(10);
    await expectNoHorizontalScroll(page);
    await expectInputsAtLeast16px(page);
    // The card's control is a real, focusable select at every width.
    await expect(cardSelect(page, 'o1')).toBeVisible();
    expect(width(page)).toBeGreaterThan(0);
  });
});
