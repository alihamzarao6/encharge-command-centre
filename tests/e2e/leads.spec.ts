/**
 * Milestone 4 part 3 in a real browser at three widths (see playwright.config.ts): the
 * pipeline board, the leads list, the view switch, the click-through to a lead, and the
 * refresh cooldown — against the scripted Supabase in mock.ts, so no stack, no key, no spend.
 *
 * Part D: item 11 (screenshots for the populated board, the populated list and the empty
 * state at 375 / 768 / 1280), item 14 (click-through from both views), and the cooldown
 * refusal in words. Part C, each as its own test: no leads at all · a stage with zero · every
 * lead in one stage · a stage not in the pipeline · a lead with no contact · a contact with
 * no name · no email and no phone · the bands absent · long, unicode and emoji · many leads
 * in one column · a large list · stale / running / failed / partial / capped carried through
 * · refresh from this screen · refresh inside the cooldown · loading with no layout jump · a
 * read error with a retry · an expired session · a deep link while signed out · search with
 * no matches · no horizontal scroll · inputs at 16px · keyboard reach and visible focus ·
 * colour never alone · reduced motion · the chat panel over both views.
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
  signIn,
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
    scrollLeft: document.documentElement.scrollLeft,
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
const LONG_NAME =
  'Bartholomew Montgomery-Fitzgerald-Whittingtonshire of the Very Long Family Name Trust Pty Ltd 🏡🏡🏡';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function run(overrides: Partial<ScriptedGhl['runs'][number]> = {}): ScriptedGhl['runs'][number] {
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
    ...overrides,
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

/** A FUNCTION, not a shared object: some tests mutate the mirror. */
function populated(): ScriptedGhl {
  return {
    pipelines: [{ ghl_id: FINANCE, name: 'Finance Pipeline', last_changed_at: ago(DAY) }],
    stages: STAGE_NAMES.map((name, i) => ({
      ghl_id: `stage-${String(i + 1).padStart(2, '0')}`,
      pipeline_ghl_id: FINANCE,
      name,
      position: i,
      removed_at: null,
    })),
    opportunities: [
      opp('o1', 'stage-01', { ghl_created_at: ago(40 * MIN) }),
      opp('o2', 'stage-01', { ghl_created_at: ago(20 * HOUR) }),
      opp('o3', 'stage-02', { ghl_created_at: ago(5 * DAY) }),
      opp('o4', 'stage-02', { ghl_created_at: ago(8 * DAY) }),
      opp('o5', 'stage-03', { ghl_created_at: ago(30 * DAY), contact_ghl_id: null }),
      opp('o6', 'stage-09', { status: 'won' }),
      opp('o7', 'stage-10', { status: 'lost' }),
      opp('o8', 'stage-01', { removed_at: ago(DAY) }),
    ],
    contacts: [
      person('contact-o1', 'Alex Tran', {
        custom_fields: {
          [LOAN_BALANCE_FIELD]: ['$500k–$750k'],
          [INTEREST_RATE_FIELD]: ['6.2% - 6.5%'],
        },
      }),
      person('contact-o2', 'Sam Ó Brádaigh 🏠', { email: null, phone: '0400 000 002' }),
      person('contact-o3', LONG_NAME, { custom_fields: { [LOAN_BALANCE_FIELD]: 'Over $1m' } }),
      // No name at all, no phone, no email: the opportunity's own name and a flag.
      person('contact-o4', null, { email: null, phone: null }),
    ],
    runs: [run()],
  };
}

async function openLeads(
  page: Page,
  path = '/leads',
  options: MockOptions = {},
): ReturnType<typeof installMock> {
  const state = await installMock(page, { ghl: populated(), ...options });
  await seedStoredSession(page);
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  return state;
}

const columns = (page: Page): ReturnType<Page['locator']> => page.locator('.board__col');
const cards = (page: Page): ReturnType<Page['locator']> => page.locator('.lead-card');
const rows = (page: Page): ReturnType<Page['locator']> => page.locator('.lt__row');
const boardButton = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Board' });
const listButton = (page: Page): ReturnType<Page['getByRole']> =>
  page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' });

test.describe('the board', () => {
  test('item 11: ten columns in pipeline order, the count in each, zeros shown, cards newest first', async ({
    page,
  }) => {
    const state = await openLeads(page, '/leads/board');
    await expect(columns(page)).toHaveCount(10);
    for (const [i, name] of STAGE_NAMES.entries()) {
      await expect(columns(page).nth(i).locator('.board__name')).toContainText(name);
    }
    const counts = await columns(page).locator('.board__count').allInnerTexts();
    expect(counts.map((c) => c.replace(/\s*leads?$/, ''))).toEqual([
      '2',
      '2',
      '1',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
    ]);
    // Won, lost and removed rows are not cards; every card carries its opportunity id.
    await expect(cards(page)).toHaveCount(5);
    const first = columns(page).nth(0);
    await expect(first.locator('.lead-card__name')).toHaveText(['Alex Tran', 'Sam Ó Brádaigh 🏠']);
    await expect(first.locator('.board__item').nth(0)).toHaveAttribute('data-opportunity-id', 'o1');
    await expect(first.locator('.board__cards')).toHaveAttribute('data-drop-target', 'stage-01');
    // An empty column is a column, and says so.
    await expect(columns(page).nth(3).locator('.board__empty')).toHaveText('No leads');
    // A card shows the loan balance where the form captured one, and nothing where it did not.
    await expect(first.locator('.lead-card').nth(0)).toContainText('$500k–$750k');
    await expect(first.locator('.lead-card').nth(1)).not.toContainText('$');
    // A stage is told apart by its number, not a colour.
    await expect(columns(page).nth(9).locator('.board__num')).toHaveText('10');
    expect(state.crmCalls).toHaveLength(0);
    expect(state.postgrestWrites).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await shot(page, 'leads-board');
  });

  test('every lead in one stage, and a stage not in the pipeline, are both columns', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.opportunities = ghl.opportunities.map((o) =>
      o.status === 'open' && o.removed_at === null ? { ...o, stage_ghl_id: 'stage-07' } : o,
    );
    ghl.opportunities.push(opp('u1', 'mystery-stage'), opp('u2', 'mystery-stage'));
    ghl.stages.push({
      ghl_id: 'stage-gone',
      pipeline_ghl_id: FINANCE,
      name: 'Old Stage',
      position: 99,
      removed_at: ago(DAY),
    });
    ghl.opportunities.push(opp('g1', 'stage-gone'));
    await openLeads(page, '/leads/board', { ghl });
    await expect(columns(page)).toHaveCount(12);
    await expect(columns(page).nth(6).locator('.board__count')).toContainText('5');
    await expect(columns(page).nth(6).locator('.lead-card')).toHaveCount(5);
    await expect(columns(page).nth(10)).toContainText('Old Stage (removed in GoHighLevel)');
    await expect(columns(page).nth(10)).toHaveClass(/board__col--odd/);
    await expect(columns(page).nth(11)).toContainText('Stage not in the pipeline');
    await expect(columns(page).nth(11).locator('.board__count')).toContainText('2');
    await expectNoHorizontalScroll(page);
  });

  test('a lead with no contact, a contact with no name, and one with no phone or email, all read sensibly', async ({
    page,
  }) => {
    await openLeads(page, '/leads/board');
    const noContact = page.locator('.board__item[data-opportunity-id="o5"] .lead-card');
    await expect(noContact.locator('.lead-card__name')).toHaveText('Lead o5');
    await expect(noContact).toContainText('contact details not synced');
    const noName = page.locator('.board__item[data-opportunity-id="o4"] .lead-card');
    await expect(noName.locator('.lead-card__name')).toHaveText('Lead o4');
    await expect(noName).not.toContainText('undefined');
    await expect(noName).toContainText('no phone or email on file');
  });

  test('many leads in one column: the column scrolls, the page does not, and the rest show on request', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.opportunities = Array.from({ length: 150 }, (_, i) =>
      opp(`many-${String(i)}`, 'stage-02', { contact_ghl_id: null, ghl_created_at: ago(i * MIN) }),
    );
    await openLeads(page, '/leads/board', { ghl });
    const column = columns(page).nth(1);
    await expect(column.locator('.board__count')).toContainText('150');
    await expect(column.locator('.lead-card')).toHaveCount(100);
    const list = column.locator('.board__cards');
    const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrollable).toBe(true);
    await column.getByRole('button', { name: 'Show 50 more' }).click();
    await expect(column.locator('.lead-card')).toHaveCount(150);
    const doc = await page.evaluate(() => ({
      h: document.documentElement.scrollHeight,
      c: document.documentElement.clientHeight,
    }));
    expect(doc.h, JSON.stringify(doc)).toBeLessThanOrEqual(doc.c);
    await expectNoHorizontalScroll(page);
  });

  test('a search on the board narrows every column and says so; no matches offers a way back', async ({
    page,
  }) => {
    await openLeads(page, '/leads/board');
    const search = page.getByRole('searchbox', { name: /Search leads/ });
    await search.fill('bradaigh');
    await expect(cards(page)).toHaveCount(1);
    await expect(columns(page).nth(0).locator('.board__count')).toContainText('1 of 2');
    await expect(page.getByRole('status').filter({ hasText: '1 of 5 leads match' })).toBeVisible();
    await search.fill('nobody by this name');
    await expect(cards(page)).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'No leads match' }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Clear the search' }).click();
    await expect(cards(page)).toHaveCount(5);
    await expect(search).toHaveValue('');
  });
});

test.describe('the list', () => {
  test('item 11: one row per lead, newest first, phone, email and the bands where captured', async ({
    page,
  }) => {
    await openLeads(page, '/leads/list');
    await expect(rows(page)).toHaveCount(5);
    await expect(rows(page).locator('.lt__link')).toHaveText([
      'Alex Tran',
      'Sam Ó Brádaigh 🏠',
      LONG_NAME,
      'Lead o4',
      'Lead o5',
    ]);
    const alex = rows(page).nth(0);
    await expect(alex).toContainText('New Lead');
    await expect(alex).toContainText('+61 400 000 001');
    await expect(alex).toContainText('contact-o1@example.com');
    await expect(alex).toContainText('$500k–$750k');
    await expect(alex).toContainText('6.2% - 6.5%');
    // Absent bands, phone or email are a dash, never "null" or "undefined".
    const sam = rows(page).nth(1);
    await expect(sam).toContainText('0400 000 002');
    await expect(sam.locator('.lt__none')).toHaveCount(3);
    await expect(sam).not.toContainText('null');
    await expect(rows(page).nth(4)).toContainText('contact details not synced');
    await expectNoHorizontalScroll(page);
    await expectInputsAtLeast16px(page);
    await shot(page, 'leads-list');
  });

  test('sortable: by name, by stage, oldest and newest — from the select on a phone, the headers from 768', async ({
    page,
  }) => {
    await openLeads(page, '/leads/list');
    const names = (): Promise<string[]> => rows(page).locator('.lt__link').allInnerTexts();
    const sort = page.getByRole('combobox', { name: 'Sort' });
    await sort.selectOption('name');
    expect(await names()).toEqual([
      'Alex Tran',
      LONG_NAME,
      'Lead o4',
      'Lead o5',
      'Sam Ó Brádaigh 🏠',
    ]);
    await sort.selectOption('oldest');
    expect(await names()).toEqual([
      'Lead o5',
      'Lead o4',
      LONG_NAME,
      'Sam Ó Brádaigh 🏠',
      'Alex Tran',
    ]);
    await sort.selectOption('stage');
    expect(await names()).toEqual([
      'Alex Tran',
      'Sam Ó Brádaigh 🏠',
      LONG_NAME,
      'Lead o4',
      'Lead o5',
    ]);
    if (width(page) >= 768) {
      const arrived = page.getByRole('columnheader', { name: /Arrived/ });
      await arrived.getByRole('button').click();
      await expect(arrived).toHaveAttribute('aria-sort', 'descending');
      expect(await names()).toEqual([
        'Alex Tran',
        'Sam Ó Brádaigh 🏠',
        LONG_NAME,
        'Lead o4',
        'Lead o5',
      ]);
      await arrived.getByRole('button').click();
      await expect(arrived).toHaveAttribute('aria-sort', 'ascending');
      expect((await names())[0]).toBe('Lead o5');
      await expect(sort).toHaveValue('oldest');
    } else {
      // The header row is not shown at this width; the select is the one control.
      await expect(page.locator('.lt__head')).toBeHidden();
    }
  });

  test('search by name, email or phone, and a stage filter; no matches says so and offers a way back', async ({
    page,
  }) => {
    await openLeads(page, '/leads/list');
    const search = page.getByRole('searchbox', { name: /Search leads/ });
    await search.fill('400 000 002');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).nth(0)).toContainText('Sam');
    await search.fill('contact-o1@');
    await expect(rows(page).nth(0)).toContainText('Alex');
    await search.fill('');
    await page.getByRole('combobox', { name: 'Stage' }).selectOption('stage-02');
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByRole('status').filter({ hasText: '2 of 5 leads match' })).toBeVisible();
    await search.fill('zzz');
    await expect(rows(page)).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'No leads match' }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Clear the search' }).click();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole('combobox', { name: 'Stage' })).toHaveValue('');
  });

  test('a large list renders a page at a time and the read cap is said out loud', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.opportunities = Array.from({ length: 2_000 }, (_, i) =>
      opp(`big-${String(i)}`, `stage-${String((i % 10) + 1).padStart(2, '0')}`, {
        contact_ghl_id: null,
        ghl_created_at: ago(i * MIN),
      }),
    );
    await openLeads(page, '/leads/list', { ghl });
    await expect(rows(page)).toHaveCount(100);
    await expect(page.getByText('Showing 100 of 2,000')).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Only the first 2,000 open leads were read' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Show 100 more' }).click();
    await expect(rows(page)).toHaveCount(200);
    await expectNoHorizontalScroll(page);
  });

  test('very long, unicode and emoji names and a long stage name never overflow', async ({
    page,
  }) => {
    const ghl = populated();
    const stage = ghl.stages[1];
    if (stage === undefined) throw new Error('unreachable');
    stage.name =
      'Waiting on the lender to come back about the valuation and the supporting documents 📄📄';
    await openLeads(page, '/leads/list', { ghl });
    await expect(rows(page).nth(2)).toContainText('Bartholomew');
    await expect(rows(page).nth(2)).toContainText('Waiting on the lender');
    await expectNoHorizontalScroll(page);
    await listButton(page).click();
    await boardButton(page).click();
    await expect(columns(page).nth(1)).toContainText('Waiting on the lender');
    const long = page.locator('.lead-card__name').filter({ hasText: 'Bartholomew' });
    const box = await long.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(30);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('the view switch and the click-through', () => {
  test('the default is the board on a desktop and the list on a phone; the choice is remembered', async ({
    page,
  }) => {
    await openLeads(page, '/leads');
    const phone = width(page) < 768;
    await expect(phone ? listButton(page) : boardButton(page)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(phone ? rows(page).first() : columns(page).first()).toBeVisible();
    // Switch, reload at the bare address: the switched-to view is what opens.
    await (phone ? boardButton(page) : listButton(page)).click();
    expect(new URL(page.url()).pathname).toBe(phone ? '/leads/board' : '/leads/list');
    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    await expect(phone ? boardButton(page) : listButton(page)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await page.evaluate(() => window.localStorage.getItem('fundd-leads-view'))).toBe(
      phone ? 'board' : 'list',
    );
  });

  test('a search typed on the board survives a switch to the list and back', async ({ page }) => {
    await openLeads(page, '/leads/board');
    await page.getByRole('searchbox', { name: /Search leads/ }).fill('alex');
    await expect(cards(page)).toHaveCount(1);
    await listButton(page).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole('searchbox', { name: /Search leads/ })).toHaveValue('alex');
    await boardButton(page).click();
    await expect(cards(page)).toHaveCount(1);
  });

  test('item 14: clicking a card opens the lead; Back returns to the board', async ({ page }) => {
    await openLeads(page, '/leads/board');
    await page.locator('.board__item[data-opportunity-id="o1"] .lead-card').click();
    expect(new URL(page.url()).pathname).toBe('/leads/o1');
    await expect(page.getByRole('heading', { name: 'Alex Tran', level: 1 })).toBeVisible();
    await expect(page.getByText('New Lead')).toBeVisible();
    await expect(page.getByRole('status')).toContainText('coming in the next part');
    await expect(page.getByText('Nothing is broken')).toBeVisible();
    await expect(page.getByText('$500k–$750k')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe('/leads/board');
    await expect(columns(page)).toHaveCount(10);
  });

  test('item 14: clicking a row opens the lead; the Back button returns to the list', async ({
    page,
  }) => {
    await openLeads(page, '/leads/list');
    await rows(page).nth(1).getByRole('link', { name: 'Sam Ó Brádaigh 🏠' }).click();
    expect(new URL(page.url()).pathname).toBe('/leads/o2');
    await expect(page.getByRole('heading', { name: 'Sam Ó Brádaigh 🏠', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /Back to leads/ }).click();
    expect(new URL(page.url()).pathname).toBe('/leads/list');
    await expect(rows(page)).toHaveCount(5);
  });

  test('a lead address that is not in the pipeline says so, and a deep link to a lead lands there after login', async ({
    page,
  }) => {
    await installMock(page, { ghl: populated() });
    await signIn(page, '/leads/o3');
    expect(new URL(page.url()).pathname).toBe('/leads/o3');
    await expect(page.getByRole('heading', { name: 'Bartholomew', level: 1 })).toBeVisible();
    await page.goto('/leads/not-here');
    await expect(
      page.getByRole('heading', { name: 'Not in the pipeline', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('closed or removed in GoHighLevel')).toBeVisible();
    await page.getByRole('button', { name: /Back to leads/ }).click();
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
  });

  test('a deep link to the board or the list while signed out is where the person lands after signing in', async ({
    page,
  }) => {
    await installMock(page, { ghl: populated() });
    await signIn(page, '/leads/list');
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/leads/list');
    await expect(rows(page)).toHaveCount(5);
    await page.goto('/leads/board');
    await expect(columns(page)).toHaveCount(10);
    // The nav entry is current, and the section survives a wrong-case address.
    await expect(
      page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /Leads/ }),
    ).toHaveAttribute('aria-current', 'page');
    await page.goto('/Leads/BOARD');
    await expect(columns(page)).toHaveCount(10);
    expect(new URL(page.url()).pathname).toBe('/leads/board');
  });
});

test.describe('freshness, carried through', () => {
  test('stale, failed, partial and capped are as visible here as on the overview', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.runs = [
      run({
        id: 'run-2',
        status: 'failed',
        applied_at: null,
        error_code: 'UNAUTHENTICATED',
        started_at: ago(MIN),
        finished_at: ago(MIN),
      }),
      run({
        applied_at: ago(2 * DAY),
        finished_at: ago(2 * DAY),
        started_at: ago(2 * DAY + 3_000),
      }),
    ];
    await openLeads(page, '/leads/list', { ghl });
    await expect(page.locator('.fresh')).toContainText('Old: Last refreshed 2 days ago');
    await expect(page.locator('.fresh')).toHaveClass(/fresh--old/);
    await expect(page.getByRole('alert')).toContainText(
      'The last refresh failed (UNAUTHENTICATED)',
    );
    await expect(page.getByRole('alert')).toContainText('rejected our access key');
    await expect(rows(page)).toHaveCount(5);

    const partial = populated();
    partial.runs = [run({ status: 'partial', contacts_failed: 1, contacts_missing: 1 })];
    partial.contacts = partial.contacts.filter((c) => c.ghl_id === 'contact-o1');
    await installMock(page, { ghl: partial });
    await page.reload();
    await expect(
      page.getByRole('status').filter({ hasText: 'could not read 2 contacts' }),
    ).toBeVisible();
    await expect(rows(page).nth(1)).toContainText('contact details not synced');
  });

  test('a refresh in progress is shown, Refresh is disabled, and the cards land when it finishes', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.runs = [
      run({
        id: 'run-2',
        status: 'running',
        applied_at: null,
        finished_at: null,
        started_at: ago(10_000),
      }),
      run(),
    ];
    const state = await openLeads(page, '/leads/board', { ghl });
    await expect(
      page.getByRole('status').filter({ hasText: 'Refreshing from GoHighLevel' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh running…' })).toBeDisabled();
    await expect(cards(page)).toHaveCount(5);
    state.ghl.opportunities.push(opp('o9', 'stage-04', { ghl_created_at: ago(MIN) }));
    const finished = state.ghl.runs[0];
    if (finished === undefined) throw new Error('unreachable');
    finished.status = 'success';
    finished.applied_at = ago(0);
    finished.finished_at = ago(0);
    await expect(cards(page)).toHaveCount(6, { timeout: 10_000 });
    await expect(columns(page).nth(3).locator('.board__count')).toContainText('1');
  });

  test('refresh from this screen goes through the server, re-reads, and then waits out the cooldown', async ({
    page,
  }) => {
    const state = await openLeads(page, '/leads/board');
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Refreshed from GoHighLevel' }),
    ).toContainText('5 open leads read');
    await expect(page.getByRole('status').filter({ hasText: 'Updated just now' })).toBeVisible();
    expect(state.crmCalls).toHaveLength(1);
    expect(state.crmCalls[0]?.body).toEqual({ action: 'sync' });
    expect(state.postgrestWrites).toHaveLength(0);
    // The run row now ends "just now": the button is disabled and the count is beside it.
    await expect(refresh).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /Next refresh in \d+ s/ }),
    ).toBeVisible();
  });

  test('a refresh attempted inside the cooldown is refused in the server’s words, never ignored', async ({
    page,
  }) => {
    // The browser believes the last refresh was 12 minutes ago; a colleague refreshed 20
    // seconds ago from another screen, so the server refuses with 429 and the rows say so.
    const state = await openLeads(page, '/leads/list', {
      crm: {
        respond: (_call, ghl) => {
          ghl.runs.unshift(
            run({
              id: 'run-colleague',
              started_at: ago(25_000),
              applied_at: ago(20_000),
              finished_at: ago(20_000),
            }),
          );
          return {
            status: 429,
            body: {
              error: {
                code: 'SYNC_COOLDOWN',
                message:
                  'The pipeline was refreshed 20 seconds ago. You can refresh again in 40 seconds.',
                retryable: true,
              },
              retryAfterSeconds: 40,
            },
          };
        },
      },
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'refreshed 20 seconds ago. You can refresh again in 40 seconds' }),
    ).toBeVisible();
    expect(state.crmCalls).toHaveLength(1);
    // Re-read: the colleague's run is now the newest, so the button waits it out here too.
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /Next refresh in \d+ s/ }),
    ).toBeVisible();
    await expect(rows(page)).toHaveCount(5);
  });
});

test.describe('data and interface states', () => {
  test('item 11: no data at all reads as "not set up yet", never as zero leads', async ({
    page,
  }) => {
    const state = await installMock(page);
    await seedStoredSession(page);
    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Not set up yet' })).toBeVisible();
    await expect(page.getByText('not an empty pipeline')).toBeVisible();
    await expect(columns(page)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    expect(state.crmCalls).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await shot(page, 'leads-empty');
  });

  test('a synced pipeline with no open leads is ten empty columns and an empty list, not "not set up"', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.opportunities = [];
    await openLeads(page, '/leads/board', { ghl });
    await expect(columns(page)).toHaveCount(10);
    await expect(cards(page)).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'No open leads in the pipeline' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Not set up yet' })).toHaveCount(0);
    await listButton(page).click();
    await expect(rows(page)).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'No open leads in the pipeline' }),
    ).toBeVisible();
  });

  test('loading on a slow connection: the bar is in place first and nothing moves when the data lands', async ({
    page,
  }) => {
    await installMock(page, { ghl: populated(), ghlDelayMs: 1_200 });
    await seedStoredSession(page);
    await page.goto('/leads/board');
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    const before = await page.locator('.overview__title').boundingBox();
    await expect(columns(page)).toHaveCount(10, { timeout: 10_000 });
    const after = await page.locator('.overview__title').boundingBox();
    expect(after?.x).toBeCloseTo(before?.x ?? -1, 0);
    expect(after?.y).toBeCloseTo(before?.y ?? -1, 0);
  });

  test('an error reading the leads is recoverable with a retry', async ({ page }) => {
    const state = await installMock(page, { ghl: populated(), ghlFailing: true });
    await seedStoredSession(page);
    await page.goto('/leads/list');
    await expect(page.getByRole('alert')).toContainText(/Couldn.t load your leads/);
    await expect(rows(page)).toHaveCount(0);
    state.ghlFailing = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a session that expires mid-way sends the person to login, not to an empty board', async ({
    page,
  }) => {
    const state = await openLeads(page, '/leads/board');
    await expect(cards(page)).toHaveCount(5);
    state.ghlUnauthorized = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Your session has expired');
    await expect(cards(page)).toHaveCount(0);
    expect(state.signOuts).toBeGreaterThanOrEqual(1);
  });

  test('keyboard: every card and row is a link, reachable in order, with a visible focus ring; arrows move the board', async ({
    page,
  }) => {
    await openLeads(page, '/leads/board');
    const first = page.locator('.board__item[data-opportunity-id="o1"] .lead-card');
    await first.focus();
    await expect(first).toBeFocused();
    expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Tab');
    await expect(page.locator('.board__item[data-opportunity-id="o2"] .lead-card')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Sam Ó Brádaigh 🏠', level: 1 })).toBeVisible();
    await page.goBack();
    const board = page.getByRole('region', { name: 'Pipeline board' });
    await board.focus();
    const before = await board.evaluate((el) => el.scrollLeft);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => board.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);

    await listButton(page).click();
    // Reached by the keyboard (a click on the view switch would leave focus-visible off).
    const link = rows(page).nth(0).getByRole('link');
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Alex Tran', level: 1 })).toBeVisible();
  });

  test('colour is never the only carrier, and reduced motion is respected', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const ghl = populated();
    ghl.runs = [run({ applied_at: ago(3 * HOUR), finished_at: ago(3 * HOUR) })];
    ghl.opportunities.push(opp('u1', 'mystery-stage'));
    await openLeads(page, '/leads/board', { ghl });
    await expect(page.locator('.fresh')).toContainText('Ageing:');
    // Stages: a number and a name in every heading; the odd column says so in words.
    for (let i = 0; i < 10; i += 1) {
      await expect(columns(page).nth(i).locator('.board__num')).toHaveText(String(i + 1));
    }
    await expect(columns(page).nth(10)).toContainText('Stage not in the pipeline');
    const shimmer = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'board__col board__col--skeleton';
      const wrap = document.createElement('div');
      wrap.className = 'board board--skeleton';
      wrap.append(probe);
      document.body.append(wrap);
      const duration = getComputedStyle(probe).animationDuration;
      wrap.remove();
      return duration;
    });
    expect(parseFloat(shimmer)).toBeLessThan(0.01);
  });

  test('the chat panel works over both views and does not trap scroll on a phone', async ({
    page,
  }) => {
    await openLeads(page, '/leads/board');
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await expect(panel).toBeVisible();
    await panel.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Who is new this week?');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(
      page.getByTestId('panel-thread').locator('[data-role="assistant"]').last(),
    ).toContainText('Reply 1 to: Who is new this week?');
    await expectInputsAtLeast16px(page);
    await expectNoHorizontalScroll(page);
    if (width(page) < 768) {
      await page.getByTestId('panel-thread').hover();
      await page.mouse.wheel(0, 400);
      expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
    }
    await page.getByRole('button', { name: 'Close assistant panel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(cards(page)).toHaveCount(5);
    await listButton(page).click();
    await page.getByRole('button', { name: /Ask/ }).click();
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('panel-thread').locator('[data-role="user"]')).toHaveCount(1);
    await expect(rows(page)).toHaveCount(5);
    await expectNoHorizontalScroll(page);
    await shot(page, 'leads-panel');
  });
});
