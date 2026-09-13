/**
 * Milestone 4 part 2 in a real browser at three widths (see playwright.config.ts): the
 * overview screen, the shell around it, and the assistant panel beside it — against the
 * scripted Supabase in mock.ts, so no stack, no key, no spend.
 *
 * Part D: item 12 (the default route after login is the data screen), item 13 (a message
 * sent in the panel is on the Assistant page, and the other way round), and the screenshots
 * at 375 / 768 / 1280 for the populated and the empty states.
 *
 * Part C, each as its own test: no data at all · zero in a stage · stale · running · failed ·
 * partial · long, unicode and large values · a stage not in the pipeline · loading with no
 * layout jump · a read error with a retry · an expired session · a deep link while signed
 * out · no horizontal scroll · inputs at 16px · keyboard reach, visible focus, a panel that
 * opens and closes from the keyboard · colour never alone · reduced motion · the panel
 * keeping the screen and the conversation across navigation · a reply that lands while the
 * person is elsewhere · the phone sheet not scrolling the screen behind it.
 *
 * Screenshots land in docs/assets/milestone-4/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
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

async function expectInputsAtLeast16px(page: Page): Promise<void> {
  const sizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea')).map((el) =>
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

/**
 * A FUNCTION, not a shared object: the scripted crm endpoint and some tests mutate the
 * mirror, and Playwright runs this file with `workers: 1` in one process.
 */
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
      {
        ghl_id: 'contact-o1',
        full_name: 'Alex Tran',
        first_name: null,
        last_name: null,
        removed_at: null,
      },
      {
        ghl_id: 'contact-o2',
        full_name: 'Sam Ó Brádaigh 🏠',
        first_name: null,
        last_name: null,
        removed_at: null,
      },
      {
        ghl_id: 'contact-o3',
        full_name: LONG_NAME,
        first_name: null,
        last_name: null,
        removed_at: null,
      },
      {
        ghl_id: 'contact-o4',
        full_name: null,
        first_name: 'Priya',
        last_name: 'Raman',
        removed_at: null,
      },
    ],
    runs: [run()],
  };
}

async function openOverview(page: Page, options: MockOptions = {}): ReturnType<typeof installMock> {
  const state = await installMock(page, { ghl: populated(), ...options });
  await seedStoredSession(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  return state;
}

const stagesList = (page: Page): ReturnType<Page['locator']> => page.locator('.stages__row');

test.describe('the overview is the landing screen', () => {
  test('item 12: signing in at / lands on the numbers, not on a chat; layout holds', async ({
    page,
  }) => {
    const state = await installMock(page, { ghl: populated() });
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    // The assistant's composer is not on this screen — it is behind the Ask button.
    await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ask/ })).toBeVisible();

    // Every figure traces to the scripted rows: five open leads, three of them this week.
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    await expect(page.locator('.tile__value').nth(1)).toHaveText('3');
    await expect(
      page.getByRole('status').filter({ hasText: 'Updated 12 minutes ago' }),
    ).toBeVisible();
    await expect(page.locator('.arrivals__row')).toHaveCount(5);
    await expect(page.locator('.arrivals__row').first()).toContainText('Alex Tran');
    expect(state.crmCalls).toHaveLength(0);
    expect(state.postgrestWrites).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await shot(page, 'overview-populated');
  });

  test('a refresh goes through the server, and the screen re-reads the mirror afterwards', async ({
    page,
  }) => {
    const state = await openOverview(page);
    const before = state.ghlReads.length;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Refreshed from GoHighLevel' }),
    ).toContainText('5 open leads read');
    await expect(page.getByRole('status').filter({ hasText: 'Updated just now' })).toBeVisible();
    expect(state.crmCalls).toHaveLength(1);
    expect(state.crmCalls[0]?.body).toEqual({ action: 'sync' });
    expect(state.crmCalls[0]?.authorization).toMatch(/^Bearer /);
    expect(state.ghlReads.length).toBeGreaterThan(before);
    // The browser never wrote a mirror row itself, and never spoke to GoHighLevel.
    expect(state.postgrestWrites).toHaveLength(0);
  });

  test('the Assistant is still complete at its own address', async ({ page }) => {
    await openOverview(page);
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: /Assistant/ })
      .click();
    expect(new URL(page.url()).pathname).toBe('/assistant');
    await expect(page.getByRole('heading', { name: 'What do you want to say?' })).toBeVisible();
    await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toBeVisible();
    // The page IS the assistant: no second copy of it in the top bar.
    await expect(page.getByRole('button', { name: /Ask/ })).toHaveCount(0);
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  });

  test('a deep link opened while signed out is where the person lands after signing in', async ({
    page,
  }) => {
    await installMock(page, { ghl: populated(), admin: true });
    await signIn(page, '/team');
    await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/team');
    // An address that exists for nothing lands on the overview, and the bar says so.
    await page.goto('/content');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });
});

test.describe('data states', () => {
  test('no data at all reads as "not set up yet" — never as zero leads, never as a broken page', async ({
    page,
  }) => {
    const state = await installMock(page);
    await seedStoredSession(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Not set up yet' })).toBeVisible();
    await expect(page.getByText('not an empty pipeline')).toBeVisible();
    await expect(page.locator('.tile__value')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    expect(state.crmCalls).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await shot(page, 'overview-empty');
  });

  test('a first refresh that failed is still "not set up", with the failure in words', async ({
    page,
  }) => {
    await installMock(page, {
      ghl: {
        pipelines: [],
        stages: [],
        opportunities: [],
        contacts: [],
        runs: [run({ status: 'failed', applied_at: null, error_code: 'UNAUTHENTICATED' })],
      },
    });
    await seedStoredSession(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Not set up yet' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      'The first refresh failed (UNAUTHENTICATED)',
    );
    await expect(page.getByRole('alert')).toContainText('rejected our access key');
  });

  test('zero leads in a stage is a zero on the list; won, lost and removed rows are not counted', async ({
    page,
  }) => {
    await openOverview(page);
    const rows = stagesList(page);
    await expect(rows).toHaveCount(10);
    await expect(rows.nth(0)).toContainText('New Lead');
    await expect(rows.nth(0).locator('.stages__count')).toContainText('2');
    await expect(rows.nth(1).locator('.stages__count')).toContainText('2');
    await expect(rows.nth(2).locator('.stages__count')).toContainText('1');
    for (const i of [3, 4, 5, 6, 7, 8, 9]) {
      await expect(rows.nth(i).locator('.stages__count')).toContainText('0');
    }
    // Won ("Settled") and lost stay at zero: they are not in the pipeline.
    await expect(rows.nth(8)).toContainText('Settled');
    await expect(rows.nth(8).locator('.stages__count')).toContainText('0');
  });

  test('every stage at zero is a legitimate state — zeros, not "not set up"', async ({ page }) => {
    const ghl = populated();
    ghl.opportunities = [];
    await openOverview(page, { ghl });
    await expect(page.locator('.tile__value').nth(0)).toHaveText('0');
    await expect(page.getByText('No open leads in the pipeline right now.')).toBeVisible();
    await expect(stagesList(page)).toHaveCount(10);
    await expect(page.getByRole('heading', { name: 'Not set up yet' })).toHaveCount(0);
  });

  test('a stage GoHighLevel removed, and a stage id the pipeline never listed, are shown with their counts', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.stages.push({
      ghl_id: 'stage-gone',
      pipeline_ghl_id: FINANCE,
      name: 'Old Stage',
      position: 99,
      removed_at: ago(DAY),
    });
    ghl.opportunities.push(
      opp('g1', 'stage-gone'),
      opp('u1', 'mystery-stage'),
      opp('u2', 'mystery-stage'),
    );
    await openOverview(page, { ghl });
    await expect(page.locator('.tile__value').nth(0)).toHaveText('8');
    const rows = stagesList(page);
    await expect(rows).toHaveCount(12);
    await expect(rows.nth(10)).toContainText('Old Stage (removed in GoHighLevel)');
    await expect(rows.nth(10).locator('.stages__count')).toContainText('1');
    await expect(rows.nth(11)).toContainText('Stage not in the pipeline');
    await expect(rows.nth(11).locator('.stages__count')).toContainText('2');
    await expectNoHorizontalScroll(page);
  });

  test('stale data is visible, not silent: ageing after an hour, old after a day', async ({
    page,
  }) => {
    const ageing = populated();
    ageing.runs = [run({ applied_at: ago(3 * HOUR), finished_at: ago(3 * HOUR) })];
    await openOverview(page, { ghl: ageing });
    const line = page.locator('.fresh');
    await expect(line).toContainText('Ageing: Last refreshed 3 hours ago');
    await expect(line).toHaveClass(/fresh--stale/);
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');

    const old = populated();
    old.runs = [run({ applied_at: ago(2 * DAY), finished_at: ago(2 * DAY) })];
    await installMock(page, { ghl: old });
    await page.reload();
    await expect(page.locator('.fresh')).toContainText('Old: Last refreshed 2 days ago');
    await expect(page.locator('.fresh')).toContainText('refresh before you rely on these');
    await expect(page.locator('.fresh')).toHaveClass(/fresh--old/);
    await shot(page, 'overview-stale');
  });

  test('a refresh in progress is shown without blocking the screen, and the numbers land when it finishes', async ({
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
    const state = await openOverview(page, { ghl });
    await expect(
      page.getByRole('status').filter({ hasText: 'Refreshing from GoHighLevel' }),
    ).toBeVisible();
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    await expect(page.getByRole('button', { name: 'Refresh running…' })).toBeDisabled();
    // The run finishes elsewhere (the CLI, a colleague) with one more lead: the poll finds it.
    state.ghl.opportunities.push(opp('o9', 'stage-04', { ghl_created_at: ago(MIN) }));
    const finished = state.ghl.runs[0];
    if (finished === undefined) throw new Error('unreachable');
    finished.status = 'success';
    finished.applied_at = ago(0);
    finished.finished_at = ago(0);
    await expect(page.locator('.tile__value').nth(0)).toHaveText('6', { timeout: 10_000 });
    await expect(
      page.getByRole('status').filter({ hasText: 'Refreshing from GoHighLevel' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  });

  test('a second refresh while one is running is refused, in words', async ({ page }) => {
    await openOverview(page, {
      crm: {
        respond: () => ({
          status: 409,
          body: {
            error: {
              code: 'SYNC_RUNNING',
              message: 'A refresh is already running.',
              retryable: true,
            },
          },
        }),
      },
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'A refresh is already running' }),
    ).toBeVisible();
  });

  test('the last refresh having failed is on the screen — the numbers may be wrong, and it says so', async ({
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
      run(),
    ];
    await openOverview(page, { ghl });
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The last refresh failed (UNAUTHENTICATED)');
    await expect(alert).toContainText('these numbers may be behind GoHighLevel');
    await expect(alert).toContainText('rejected our access key');
    // The numbers from the last good run are still there, with their age.
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    await expect(page.locator('.fresh')).toContainText('Updated 12 minutes ago');
    await expectNoHorizontalScroll(page);
    await shot(page, 'overview-failed');
  });

  test('a refresh that fails on the server says why, and the failure stays on the page', async ({
    page,
  }) => {
    await openOverview(page, {
      crm: {
        respond: (_call, ghl) => {
          ghl.runs.unshift(
            run({
              id: 'run-x',
              status: 'failed',
              applied_at: null,
              error_code: 'TIMEOUT',
              started_at: ago(0),
              finished_at: ago(0),
            }),
          );
          return {
            status: 502,
            body: {
              error: {
                code: 'TIMEOUT',
                message: "GoHighLevel didn't answer, so nothing was refreshed.",
                retryable: true,
              },
              runId: 'run-x',
            },
          };
        },
      },
    });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: "GoHighLevel didn't answer" }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('The last refresh failed (TIMEOUT)');
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
  });

  test('partial data: contacts the sync could not read are counted, and an arrival without its contact says so', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.runs = [run({ status: 'partial', contacts_failed: 1, contacts_missing: 1 })];
    ghl.contacts = ghl.contacts.filter((c) => c.ghl_id === 'contact-o1');
    await openOverview(page, { ghl });
    await expect(
      page.getByRole('status').filter({ hasText: 'could not read 2 contacts' }),
    ).toBeVisible();
    const arrivals = page.locator('.arrivals__row');
    await expect(arrivals.nth(0)).toContainText('Alex Tran');
    await expect(arrivals.nth(0)).not.toContainText('contact details not synced');
    await expect(arrivals.nth(1)).toContainText('Lead o2');
    await expect(arrivals.nth(1)).toContainText('contact details not synced');
    // The reverse — contact rows but no opportunity rows — is a legitimate zero.
    const reverse = populated();
    reverse.opportunities = [];
    await installMock(page, { ghl: reverse });
    await page.reload();
    await expect(page.locator('.tile__value').nth(0)).toHaveText('0');
  });
});

test.describe('content edge cases', () => {
  test('very long, unicode and emoji names, and a stage name that does not fit, never overflow', async ({
    page,
  }) => {
    const ghl = populated();
    const stage = ghl.stages[3];
    if (stage === undefined) throw new Error('unreachable');
    stage.name =
      'Waiting on the lender to come back about the valuation and the supporting documents 📄📄';
    ghl.pipelines[0] = {
      ghl_id: FINANCE,
      name: `Finance Pipeline — ${LONG_NAME}`,
      last_changed_at: ago(DAY),
    };
    await openOverview(page, { ghl });
    await expect(
      page.locator('.arrivals__row').filter({ hasText: 'Sam Ó Brádaigh 🏠' }),
    ).toBeVisible();
    await expect(page.locator('.arrivals__row').filter({ hasText: 'Bartholomew' })).toBeVisible();
    // Readable in full: the long name is on screen, not clipped to nothing.
    const long = page.locator('.arrivals__name').filter({ hasText: 'Bartholomew' });
    const box = await long.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(30);
    await expect(stagesList(page).nth(3)).toContainText('Waiting on the lender');
    await expectNoHorizontalScroll(page);
    await shot(page, 'overview-long-names');
  });

  test('four-digit counts hold the layout, and a read that hit its page size says so', async ({
    page,
  }) => {
    const ghl = populated();
    ghl.opportunities = Array.from({ length: 2_000 }, (_, i) =>
      opp(`big-${String(i)}`, `stage-${String((i % 10) + 1).padStart(2, '0')}`, {
        contact_ghl_id: null,
        ghl_created_at: ago(i * MIN),
      }),
    );
    await openOverview(page, { ghl });
    await expect(page.locator('.tile__value').nth(0)).toHaveText('2,000');
    await expect(page.locator('.tile__value').nth(1)).toHaveText('2,000');
    await expect(stagesList(page).nth(0).locator('.stages__count')).toContainText('200');
    await expect(
      page.getByRole('status').filter({ hasText: 'Only the first 2,000 open leads were read' }),
    ).toBeVisible();
    // The value sits inside its tile: no wrap, no overflow.
    const tile = await page.locator('.tile').nth(0).boundingBox();
    const value = await page.locator('.tile__value').nth(0).boundingBox();
    expect((value?.x ?? 0) + (value?.width ?? 0)).toBeLessThanOrEqual(
      (tile?.x ?? 0) + (tile?.width ?? 0) + 0.5,
    );
    await expectNoHorizontalScroll(page);
  });
});

test.describe('interface states', () => {
  test('loading on a slow connection: the shape is there first and nothing moves when the data lands', async ({
    page,
  }) => {
    await installMock(page, { ghl: populated(), ghlDelayMs: 1_200 });
    await seedStoredSession(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    const skeleton = page.locator('[aria-busy="true"]');
    await expect(skeleton).toBeVisible();
    const before = {
      title: await page.locator('.overview__title').boundingBox(),
      tile0: await page.locator('.tile').nth(0).boundingBox(),
      tile1: await page.locator('.tile').nth(1).boundingBox(),
      stages: await page.locator('.overview__stages').boundingBox(),
    };
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5', { timeout: 10_000 });
    const after = {
      title: await page.locator('.overview__title').boundingBox(),
      tile0: await page.locator('.tile').nth(0).boundingBox(),
      tile1: await page.locator('.tile').nth(1).boundingBox(),
      stages: await page.locator('.overview__stages').boundingBox(),
    };
    for (const key of ['title', 'tile0', 'tile1', 'stages'] as const) {
      expect(after[key]?.x, key).toBeCloseTo(before[key]?.x ?? -1, 0);
      expect(after[key]?.y, key).toBeCloseTo(before[key]?.y ?? -1, 0);
      expect(after[key]?.width, key).toBeCloseTo(before[key]?.width ?? -1, 0);
    }
  });

  test('a short window never gets a second, page-level scrollbar: the section scrolls, the page does not', async ({
    page,
  }) => {
    // 1280×630 is a 1920×945 laptop at 150% zoom — the client's. The stage rows scroll
    // inside the overview; their screen-reader-only spans must not lengthen the document.
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 630 });
    await openOverview(page);
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    const metrics = await page.evaluate(() => ({
      docScrollHeight: document.documentElement.scrollHeight,
      docClientHeight: document.documentElement.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
    }));
    expect(metrics.docScrollHeight, JSON.stringify(metrics)).toBeLessThanOrEqual(
      metrics.docClientHeight,
    );
    expect(metrics.bodyScrollHeight, JSON.stringify(metrics)).toBeLessThanOrEqual(
      metrics.docClientHeight,
    );
    await expectNoHorizontalScroll(page);
  });

  test('an error reading the overview is recoverable with a retry', async ({ page }) => {
    const state = await installMock(page, { ghl: populated(), ghlFailing: true });
    await seedStoredSession(page);
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText(/Couldn.t load your pipeline/);
    await expect(page.locator('.tile__value')).toHaveCount(0);
    state.ghlFailing = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a session that expires mid-way sends the person to login, not to an empty dashboard', async ({
    page,
  }) => {
    const state = await openOverview(page);
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    state.ghlUnauthorized = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Your session has expired');
    await expect(page.locator('.tile__value')).toHaveCount(0);
    expect(state.signOuts).toBeGreaterThanOrEqual(1);
  });

  test('no horizontal scroll, inputs at 16px, keyboard reach, visible focus, a panel that opens and closes from the keyboard', async ({
    page,
  }) => {
    await openOverview(page);
    await expectNoHorizontalScroll(page);

    // Tab from the top of the document until the Ask button has focus: it is reachable.
    await page.locator('body').press('Tab');
    const ask = page.getByRole('button', { name: /Ask/ });
    for (let i = 0; i < 12; i += 1) {
      if (await ask.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(ask).toBeFocused();
    // Focus is visible: the focus ring is a solid outline, not the default nothing.
    const outline = await ask.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');

    await page.keyboard.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await expect(panel).toBeVisible();
    await expect(ask).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toBeFocused();
    await expectInputsAtLeast16px(page);
    await expectNoHorizontalScroll(page);
    await shot(page, 'overview-panel');

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(ask).toBeFocused();
    await expect(ask).toHaveAttribute('aria-expanded', 'false');

    // The nav is reachable too, in order, and each entry says which is current.
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByRole('button', { name: /Overview/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await nav.getByRole('button', { name: /Memory/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();
  });

  test('colour is never the only carrier, and reduced motion is respected', async ({ page }) => {
    const ghl = populated();
    ghl.runs = [run({ applied_at: ago(3 * HOUR), finished_at: ago(3 * HOUR) })];
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openOverview(page, { ghl });
    // Freshness: a word for screen readers, a dot for the eye, and the age in words.
    await expect(page.locator('.fresh')).toContainText('Ageing:');
    await expect(page.locator('.fresh__dot')).toBeVisible();
    // A removed / unknown stage is marked in words, not only in italics.
    const transition = await page
      .locator('.stages__fill')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(transition)).toBeLessThan(0.01);
    const shimmer = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'tile tile--skeleton';
      document.body.append(probe);
      const duration = getComputedStyle(probe).animationDuration;
      probe.remove();
      return duration;
    });
    expect(parseFloat(shimmer)).toBeLessThan(0.01);
  });
});

test.describe('the panel', () => {
  test('item 13: a message sent in the panel is on the Assistant page, and the other way round', async ({
    page,
  }) => {
    const state = await openOverview(page);
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await panel
      .getByPlaceholder('Ask for a post, an ad, a reply…')
      .fill('Write a post about offset accounts');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(
      page.getByTestId('panel-thread').locator('[data-role="assistant"]').last(),
    ).toContainText('Reply 1 to: Write a post about offset accounts');
    // The numbers were never left.
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');

    await panel.getByRole('button', { name: 'Full page' }).click();
    expect(new URL(page.url()).pathname).toBe('/assistant');
    const thread = page.getByTestId('thread');
    await expect(thread.locator('[data-role="user"]')).toContainText(
      'Write a post about offset accounts',
    );
    await expect(thread.locator('[data-role="assistant"]')).toContainText('Reply 1 to');

    // And back: a message from the page is in the panel.
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Now an ad');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(thread.locator('[data-role="assistant"]')).toHaveCount(2);
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: /Overview/ })
      .click();
    await page.getByRole('button', { name: /Ask/ }).click();
    await expect(page.getByTestId('panel-thread').locator('[data-role="user"]')).toHaveCount(2);
    await expect(
      page.getByTestId('panel-thread').locator('[data-role="assistant"]').last(),
    ).toContainText('Reply 2 to: Now an ad');
    // One conversation: the second turn carried the first one's id.
    expect(state.chatCalls.map((c) => c.conversationId)).toEqual([undefined, expect.any(String)]);
  });

  test('opening the panel keeps the screen underneath; closing it returns to it unchanged', async ({
    page,
  }) => {
    await openOverview(page);
    const overview = page.locator('.overview');
    await overview.evaluate((el) => {
      el.scrollTop = 120;
    });
    const scrolled = await overview.evaluate((el) => el.scrollTop);
    await page.getByRole('button', { name: /Ask/ }).click();
    await expect(page.getByRole('complementary', { name: 'Assistant' })).toBeVisible();
    await expect(page.locator('.tile__value').nth(0)).toHaveText('5');
    await page.getByRole('button', { name: 'Close assistant panel' }).click();
    await expect(page.getByRole('complementary', { name: 'Assistant' })).toHaveCount(0);
    expect(await overview.evaluate((el) => el.scrollTop)).toBe(scrolled);
  });

  test('navigating between screens with the panel open keeps the conversation (768 and up)', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 768, 'on a phone the sheet covers the nav');
    await openOverview(page, { admin: true });
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await panel.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Still here?');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(
      page.getByTestId('panel-thread').locator('[data-role="assistant"]').last(),
    ).toContainText('Reply 1 to: Still here?');
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: /Team/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Team', level: 1 })).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(
      page.getByTestId('panel-thread').locator('[data-role="assistant"]').last(),
    ).toContainText('Reply 1 to: Still here?');
    await expectNoHorizontalScroll(page);
  });

  test('a reply that arrives while the person is on another screen is not lost', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await installMock(page, { ghl: populated() });
    await page.route('**/functions/v1/chat', async (route) => {
      await gate;
      await route.fallback();
    });
    await seedStoredSession(page);
    await page.goto('/');
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await panel.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Slow one');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('panel-thread').locator('[data-role="user"]')).toContainText(
      'Slow one',
    );
    await page.getByRole('button', { name: 'Close assistant panel' }).click();
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: /Memory/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();
    release();
    // The Ask button says a reply is waiting; opening the panel shows it.
    const ask = page.getByRole('button', { name: /Ask/ });
    await expect(ask).toContainText('a reply is waiting');
    await ask.click();
    await expect(
      page.getByTestId('panel-thread').locator('[data-role="assistant"]').last(),
    ).toContainText('Reply 1 to: Slow one');
    await expect(ask).not.toContainText('a reply is waiting');
  });

  test('on a phone the sheet scrolls its own thread, never the screen behind it', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'the sheet is the phone treatment');
    const ghl = populated();
    await openOverview(page, {
      ghl,
      messages: {
        'c0000000-0000-4000-8000-000000000001': Array.from({ length: 30 }, (_, i) => ({
          id: `m${String(i)}`,
          role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `Message ${String(i)} — long enough to need a scroll when there are thirty of them.`,
          created_at: `2026-09-01T00:${String(i).padStart(2, '0')}:00Z`,
        })),
      },
      conversations: [
        {
          id: 'c0000000-0000-4000-8000-000000000001',
          title: 'Long one',
          last_active_at: '2026-09-01T00:30:00Z',
        },
      ],
    });
    const overview = page.locator('.overview');
    await overview.evaluate((el) => {
      el.scrollTop = 80;
    });
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await expect(panel).toBeVisible();
    // The sheet covers the whole viewport on a phone.
    const box = await panel.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual((page.viewportSize()?.width ?? 0) - 1);
    // Send a long thread's worth of scrolling inside the sheet: the page does not move.
    await page.getByTestId('panel-thread').hover();
    await page.mouse.wheel(0, 600);
    expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
    expect(await page.evaluate(() => document.body.scrollTop)).toBe(0);
    expect(await overview.evaluate((el) => el.scrollTop)).toBe(80);
    await expectNoHorizontalScroll(page);
  });
});
