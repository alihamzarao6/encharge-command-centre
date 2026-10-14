/**
 * Milestone 5 part 2 in a real browser at three widths (375 / 768 / 1280): reading one web
 * page from a link. The pages are the committed, invented fixtures (tests/fixtures/web); the
 * scripted server "fetches" them and hands their bytes back as the real function does, and
 * they are then read by the REAL readers running in Chrome — the HTML reader, and pdf.js for
 * a document at a link. What the browser sends is checked at the (scripted) endpoint.
 *
 * The browser itself must never contact a page's site. Every test routes the fixtures' host
 * and counts: zero, always.
 *
 * Part C, "the interface":
 *   - a message that is only a link, a link inside a sentence, several links in one message,
 *     and a link he did not mean to be read;
 *   - progress while a page is being fetched, on a slow connection;
 *   - a very long address or title that must not break the layout;
 *   - the read and any refusal announced to a screen reader;
 *   - 375 / 768 / 1280 with no horizontal scroll, text inputs at 16px, reduced motion.
 *
 * Screenshots land in docs/assets/milestone-5/.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
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
  type ScriptedPage,
} from './mock.js';

const WEB = fileURLToPath(new URL('../fixtures/web/', import.meta.url));
const FILES = fileURLToPath(new URL('../fixtures/files/', import.meta.url));
const SHOTS = fileURLToPath(new URL('../../docs/assets/milestone-5/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const html = (name: string): string => readFileSync(`${WEB}${name}.html`, 'utf8');

const RATES = 'https://www.lender.example.org/home-loans/interest-rates';
const NEWS = 'https://www.daily.example.org/business/workplace-report';
const BANK = 'https://www.samplebank.example.org/home-loans/rates';
const OFFERS = 'https://www.offers.example.org/fixed-rates-this-spring';
const PORTAL = 'https://portal.broker.example.org/account';
const FEES = 'https://www.lender.example.org/docs/rate-sheet.pdf';
const MUTUAL = 'https://www.mutual.example.org/home-loans/offers';

const PAGES: Record<string, ScriptedPage> = {
  [RATES]: { body: html('rate-table') },
  [NEWS]: { body: html('paywall-structured') },
  [BANK]: { body: html('script-filled') },
  [OFFERS]: { body: html('injection-hidden') },
  [MUTUAL]: { body: html('injection-revealed') },
  [PORTAL]: {
    refused: 'page_login_required',
    message:
      'This page is behind a login, and the assistant cannot sign in. If you can open it yourself, save the page as a PDF and attach it, or paste the text here.',
  },
  [FEES]: {
    body: readFileSync(`${FILES}rate-sheet-tables.pdf`),
    contentType: 'application/pdf',
  },
};

const PLACEHOLDER = 'Ask for a post, an ad, a reply…';

function shot(page: Page, name: string): Promise<Buffer> {
  const width = page.viewportSize()?.width ?? 0;
  return page.screenshot({ path: `${SHOTS}${name}-${String(width)}.png`, fullPage: false });
}

/** As tests/e2e/files.spec.ts: the page does not scroll sideways, and nothing drawn here is clipped. */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const wide = Array.from(
      document.querySelectorAll(
        '.thread, .thread *, .composer, .composer *, .composer__note, .composer__ask, .composer__ask *, .links, .links *, .panel, .panel *',
      ),
    )
      .filter(
        (el) => !el.classList.contains('sr-only') && !el.classList.contains('composer__picker'),
      )
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
  expect(metrics.wide, JSON.stringify(metrics)).toEqual([]);
}

const CONVERSATION = {
  id: CONV_ID,
  title: 'Sample Person refinance',
  last_active_at: '2026-10-12T03:00:00Z',
};

interface Opened {
  readonly state: MockState;
  /** Every request this browser made to a page's own site. Must stay empty. */
  readonly siteRequests: string[];
}

/** Any request from the browser to the fixtures' sites is recorded and dropped. */
async function watchSites(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route(/^https?:\/\/[^/]*\.example\.org\//, async (route) => {
    seen.push(route.request().url());
    await route.abort();
  });
  return seen;
}

/** Signed in, on the Assistant, with one conversation open. */
async function openAssistant(page: Page, options: MockOptions = {}): Promise<Opened> {
  const siteRequests = await watchSites(page);
  const state = await installMock(page, {
    conversations: [CONVERSATION],
    pages: PAGES,
    ...options,
  });
  await signIn(page, '/assistant');
  await expect(page.getByRole('button', { name: '+ New', exact: true })).toBeVisible();
  // The list is a slide-in sheet on a phone and a sidebar from 768px.
  const menu = page.getByRole('button', { name: 'Open conversations' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('listitem').filter({ hasText: 'Sample Person refinance' }).click();
  await expect(page.locator('.thread-pane__title')).toHaveText(
    'ross.test — Sample Person refinance',
  );
  await expect(page.getByPlaceholder(PLACEHOLDER)).toBeVisible();
  return { state, siteRequests };
}

const box = (page: Page): Locator => page.getByPlaceholder(PLACEHOLDER);
const send = (page: Page): Locator => page.getByRole('button', { name: 'Send' });
const strip = (page: Page): Locator => page.getByTestId('link-strip');
const rows = (page: Page): Locator => strip(page).locator('li[data-state]');
const thread = (page: Page): Locator => page.getByTestId('thread');
const chips = (page: Page): Locator => thread(page).getByTestId('file');
const uploads = (page: Page): Locator => thread(page).getByTestId('upload');
const problem = (page: Page): Locator => thread(page).getByTestId('upload-problem').locator('p');
const announcer = (page: Page): Locator => page.getByTestId('upload-announcer');
const ask = (page: Page): Locator => page.getByTestId('link-ask');

const actions = (state: MockState): string[] =>
  state.fileCalls.map((call) => String(call.body['action']));
const callsOf = (state: MockState, action: string): Record<string, unknown>[] =>
  state.fileCalls.filter((call) => call.body['action'] === action).map((call) => call.body);
const appendedText = (state: MockState): string =>
  callsOf(state, 'append')
    .flatMap((body) => body['pages'] as { text: string }[])
    .map((page) => page.text)
    .join('\n');

const READ_AT = /read today at \d{1,2}:\d{2} (am|pm)/;

test.describe('a link in the message', () => {
  test('a link inside a sentence is offered, and nothing is opened until he says so', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    await box(page).fill(`What is the rate for an LVR under 60%? ${RATES} thanks`);
    await expect(rows(page)).toHaveCount(1);
    const row = rows(page).first();
    await expect(row).toHaveAttribute('data-state', 'unread');
    await expect(row.locator('.links__address')).toHaveText(
      'lender.example.org/home-loans/interest-rates',
    );
    await expect(row.locator('.links__address')).toHaveAttribute('title', RATES);
    await expect(row.locator('.links__state')).toHaveText('Not read yet');
    const read = row.getByRole('button', { name: 'Read this page: lender.example.org' });
    await expect(read).toHaveText('Read this page');
    expect((await read.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-offered');

    // Typing a link reads nothing. Not our server, and never the site.
    expect(state.pageFetches).toEqual([]);
    expect(state.fileCalls).toEqual([]);

    await read.click();
    await expect(chips(page)).toHaveCount(1);
    const chip = chips(page).first();
    await expect(chip).toHaveAttribute('data-source', 'link');
    await expect(chip.locator('.file__name')).toHaveText(
      'Home loan interest rates | Example Lender',
    );
    await expect(chip.locator('.file__meta')).toContainText('Web page · lender.example.org · ');
    await expect(chip.locator('.file__meta')).toContainText(READ_AT);
    // A page is kept for a day, and says so.
    await expect(chip.locator('.file__meta')).toContainText('Removed tomorrow');
    const original = chip.getByRole('link', { name: 'Open the page' });
    await expect(original).toHaveAttribute('href', RATES);
    await expect(original).toHaveAttribute('target', '_blank');
    await expect(original).toHaveAttribute('rel', /noopener/);
    await expect(original).toHaveAttribute('rel', /noreferrer/);
    await expect(announcer(page)).toHaveText(
      /^Page read: Home loan interest rates \| Example Lender, from lender\.example\.org\. \d+ parts?\.$/,
    );

    // Asked of OUR endpoint, pinned to Sydney; the address went nowhere else.
    expect(state.pageFetches.map((fetch) => fetch.url)).toEqual([RATES]);
    const call = state.fileCalls.find((entry) => entry.body['action'] === 'fetch_page');
    expect(call?.query).toBe('?forceFunctionRegion=ap-southeast-2');
    expect(call?.authorization).toMatch(/^Bearer /);
    expect(actions(state)).toEqual(['fetch_page', 'begin', 'append', 'finish']);
    // What was attached names the server's fetch, and carries the page's text — its table
    // included, an empty cell marked rather than closed up, and (14 Oct 2026) every value in
    // that row naming its heading.
    const begin = callsOf(state, 'begin')[0];
    expect(begin).toMatchObject({ kind: 'html', fetchId: state.pageFetches[0]?.requestId });
    expect(begin?.['title']).toBe('Home loan interest rates | Example Lender');
    expect(appendedText(state)).toContain('LVR 60% or less\t6.04% p.a.\t6.07% p.a.\t$0');
    expect(appendedText(state)).toContain(
      'LVR 80.01% to 90%\tInterest rate: 6.44% p.a.\tComparison rate: 6.47% p.a.\tMonthly fee: (blank)',
    );
    expect(siteRequests).toEqual([]);

    // The link in the box is now a page that has been read; the question is still there.
    await expect(rows(page).first()).toHaveAttribute('data-state', 'read');
    await expect(rows(page).first().locator('.links__state')).toHaveText(
      /^Read today at \d{1,2}:\d{2} (am|pm)$/,
    );
    await expect(rows(page).first().getByRole('button')).toHaveText('Read again');
    await expect(box(page)).toHaveValue(`What is the rate for an LVR under 60%? ${RATES} thanks`);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-read');

    // And Send now simply sends: there is nothing left to ask about.
    await send(page).click();
    await expect(ask(page)).toHaveCount(0);
    await expect.poll(() => state.chatCalls.length).toBe(1);
    expect(state.chatCalls[0]?.message).toBe(
      `What is the rate for an LVR under 60%? ${RATES} thanks`,
    );
    expect(state.pageFetches).toHaveLength(1);
    expect(siteRequests).toEqual([]);
  });

  test('a message that is only a link: read it, and the box is free for the question', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page, {
      chat: {
        respond: (_request, call) => ({
          sse: sseDone('For an LVR of 60% or less the variable rate is 6.04% p.a.', call),
        }),
      },
    });
    await box(page).fill(RATES);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    // The page is in the conversation; the address has done its job and is taken out.
    await expect(box(page)).toHaveValue('');
    await expect(strip(page)).toHaveCount(0);

    await box(page).fill('What is the variable rate under 60% LVR?');
    await send(page).click();
    await expect(thread(page).locator('[data-role="assistant"]').last()).toContainText('6.04%');
    const order = await thread(page).evaluate((node) =>
      Array.from(node.children).map(
        (el) => el.getAttribute('data-testid') ?? el.getAttribute('data-role') ?? '',
      ),
    );
    expect(order).toEqual(['file', 'user', 'assistant']);
    expect(state.pageFetches).toHaveLength(1);
    expect(siteRequests).toEqual([]);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-question-answered');
  });

  test('Send with a link that has not been read asks once: read it then send, or send without', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    const text = `Summarise the fixed rates on ${RATES}`;
    await box(page).fill(text);
    await send(page).click();
    await expect(ask(page)).toBeVisible();
    await expect(ask(page)).toContainText(
      'This message has a link that has not been read. The assistant cannot open it, and will say so unless the page is read first.',
    );
    // Nothing has gone anywhere yet, and the keyboard is on the first choice.
    expect(state.chatCalls).toEqual([]);
    expect(state.pageFetches).toEqual([]);
    const readThenSend = ask(page).getByRole('button', { name: 'Read it, then send' });
    await expect(readThenSend).toBeFocused();
    for (const button of await ask(page).getByRole('button').all()) {
      expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-ask');

    await readThenSend.click();
    await expect(chips(page)).toHaveCount(1);
    await expect.poll(() => state.chatCalls.length).toBe(1);
    expect(state.chatCalls[0]?.message).toBe(text);
    // Read first, sent second.
    expect(actions(state)).toEqual(['fetch_page', 'begin', 'append', 'finish']);
    await expect(ask(page)).toHaveCount(0);
    await expect(box(page)).toHaveValue('');
    expect(siteRequests).toEqual([]);
  });

  test('a link he did not mean to be read is sent as words, and no page is opened', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    const text = `Write a post telling people our rates page has moved to ${RATES}`;
    await box(page).fill(text);
    await send(page).click();
    await ask(page).getByRole('button', { name: 'Send without reading' }).click();
    await expect.poll(() => state.chatCalls.length).toBe(1);
    expect(state.chatCalls[0]?.message).toBe(text);
    expect(state.pageFetches).toEqual([]);
    expect(state.fileCalls).toEqual([]);
    await expect(chips(page)).toHaveCount(0);

    // And a link typed and then taken out again was never anything at all.
    await box(page).fill(`Look at ${NEWS}`);
    await expect(rows(page)).toHaveCount(1);
    await box(page).fill('Look at the news');
    await expect(strip(page)).toHaveCount(0);
    expect(state.pageFetches).toEqual([]);
    expect(siteRequests).toEqual([]);
  });

  test('several links in one message each get their own row, and the rest are counted', async ({
    page,
  }) => {
    const { state } = await openAssistant(page);
    await box(page).fill(
      `Compare ${RATES} and ${BANK} with ${NEWS} and ${OFFERS} and again ${RATES}`,
    );
    // Three at a time; the fourth is counted, and the repeat is the same link.
    await expect(rows(page)).toHaveCount(3);
    await expect(strip(page).locator('.links__more')).toHaveText(
      'One more link is in this message. Links are read a few at a time: read these first.',
    );
    // Two buttons that say the same thing are told apart by a screen reader.
    await expect(
      strip(page).getByRole('button', { name: 'Read this page: lender.example.org' }),
    ).toHaveCount(1);
    await expect(
      strip(page).getByRole('button', { name: 'Read this page: samplebank.example.org' }),
    ).toHaveCount(1);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-several');

    // Two pressed one after the other are read one after the other.
    await strip(page).getByRole('button', { name: 'Read this page: lender.example.org' }).click();
    await strip(page)
      .getByRole('button', { name: 'Read this page: samplebank.example.org' })
      .click();
    await expect(chips(page)).toHaveCount(2);
    expect(state.pageFetches.map((fetch) => fetch.url)).toEqual([RATES, BANK]);
    expect(actions(state)).toEqual([
      'fetch_page',
      'begin',
      'append',
      'finish',
      'fetch_page',
      'begin',
      'append',
      'finish',
    ]);
    await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'read');
    await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'read');
    await expect(rows(page).nth(2)).toHaveAttribute('data-state', 'unread');
  });

  test('the button is reached and pressed from the keyboard', async ({ page }) => {
    const { state } = await openAssistant(page);
    await box(page).fill(`Rates? ${RATES}`);
    await box(page).focus();
    // Back from the message box: the attach button, then the link's own button.
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(
      strip(page).getByRole('button', { name: 'Read this page: lender.example.org' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(chips(page)).toHaveCount(1);
    expect(state.pageFetches).toHaveLength(1);
  });
});

test.describe('a page that cannot be read', () => {
  test('an address that will not be opened says why beside it, and offers nothing', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    const cases: readonly (readonly [string, string])[] = [
      [
        'http://www.lender.example.org/rates',
        'Only secure pages are opened, and this link does not start with https://. Try the same address with https:// in front.',
      ],
      [
        'https://169.254.169.254/latest/meta-data/',
        "This link uses a numeric address in place of a site's name, so it was not opened. Paste the address with the site's name in it.",
      ],
      [
        'https://localhost/admin',
        'This link points at a private or local address, not a public website, so it was not opened.',
      ],
      [
        'https://ross:hunter2@www.lender.example.org/rates',
        'This link has a username or password written into it, so it was not opened. Paste the address without them.',
      ],
    ];
    for (const [address, sentence] of cases) {
      await box(page).fill(`Read ${address} for me`);
      const row = rows(page).first();
      await expect(row).toHaveAttribute('data-state', 'refused');
      await expect(row.locator('.links__state')).toHaveText(sentence);
      await expect(row.getByRole('button')).toHaveCount(0);
      // A password written into an address is never shown back.
      await expect(strip(page)).not.toContainText('hunter2');
    }
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-not-opened');
    // Nothing was asked of anyone, and Send does not offer to read what cannot be read.
    await send(page).click();
    await expect(ask(page)).toHaveCount(0);
    await expect.poll(() => state.chatCalls.length).toBe(1);
    expect(state.pageFetches).toEqual([]);
    expect(siteRequests).toEqual([]);
  });

  test('a page behind a login is refused in a sentence, announced, and nothing is attached', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    const sentence =
      'This page is behind a login, and the assistant cannot sign in. If you can open it yourself, save the page as a PDF and attach it, or paste the text here.';
    await box(page).fill(`What does my account page say? ${PORTAL}`);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(problem(page)).toHaveText(sentence);
    await expect(announcer(page)).toHaveText(`portal.broker.example.org was not read. ${sentence}`);
    await expect(chips(page)).toHaveCount(0);
    // Beside the link too, and not offered again: trying again would not change the answer.
    await expect(rows(page).first()).toHaveAttribute('data-state', 'failed');
    await expect(rows(page).first().locator('.links__state')).toHaveText(sentence);
    await expect(rows(page).first().getByRole('button')).toHaveCount(0);
    expect(actions(state)).toEqual(['fetch_page']);
    expect(siteRequests).toEqual([]);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-refused');
  });

  test('a paywalled article is refused by the reader, not half-read, and the fetch is closed', async ({
    page,
  }) => {
    const { state } = await openAssistant(page);
    const sentence =
      'This article is behind a paywall: only its opening lines are public, so it was not read. If you subscribe, save the article as a PDF and attach it, or paste the text here.';
    await box(page).fill(NEWS);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(problem(page)).toHaveText(sentence);
    await expect(announcer(page)).toHaveText(`daily.example.org was not read. ${sentence}`);
    await expect(chips(page)).toHaveCount(0);
    // Fetched, refused on this device, and the server told so: reason and size, never text.
    expect(actions(state)).toEqual(['fetch_page', 'refused']);
    const report = callsOf(state, 'refused')[0];
    expect(report).toMatchObject({
      reason: 'page_paywall',
      kind: 'html',
      fetchId: state.pageFetches[0]?.requestId,
    });
    expect(JSON.stringify(report)).not.toContain('Workplace report');
    // The link stays in the box: the message was only the link, and it was not read.
    await expect(box(page)).toHaveValue(NEWS);
  });

  test('"Read it, then send" with a page that will not read sends nothing, and says why', async ({
    page,
  }) => {
    const { state } = await openAssistant(page);
    await box(page).fill(`Summarise ${NEWS}`);
    await send(page).click();
    await ask(page).getByRole('button', { name: 'Read it, then send' }).click();
    await expect(page.getByTestId('not-sent')).toHaveText(
      'The message was not sent, because the page could not be read. The reason is beside the link. You can send it without the page, or try the page again.',
    );
    expect(state.chatCalls).toEqual([]);
    await expect(box(page)).toHaveValue(`Summarise ${NEWS}`);
    await expectNoHorizontalScroll(page);
    // He may still send it as it is: nothing is asked a second time.
    await send(page).click();
    await expect(ask(page)).toHaveCount(0);
    await expect.poll(() => state.chatCalls.length).toBe(1);
  });

  test('a site that does not answer can be tried again, and the second try is a new read', async ({
    page,
  }) => {
    const { state } = await openAssistant(page, {
      pages: {
        [RATES]: {
          failed: 504,
          message:
            'That page took too long to answer, so it was not read. Try again. If you can open it yourself, save the page as a PDF and attach it, or paste the text here.',
        },
      },
    });
    await box(page).fill(`Rates? ${RATES}`);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(problem(page)).toContainText('That page took too long to answer');
    await expect(rows(page).first()).toHaveAttribute('data-state', 'failed');
    // The site comes back.
    state.pages[RATES] = { body: html('rate-table') };
    await rows(page).first().getByRole('button', { name: 'Try again: lender.example.org' }).click();
    await expect(chips(page)).toHaveCount(1);
    await expect(uploads(page)).toHaveCount(0);
    expect(state.pageFetches).toHaveLength(2);
    expect(new Set(state.pageFetches.map((fetch) => fetch.requestId)).size).toBe(2);
  });
});

test.describe('what was read', () => {
  test('a page whose figures are filled in by a script is read in part, and says so', async ({
    page,
  }) => {
    const { state } = await openAssistant(page);
    await box(page).fill(BANK);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    const note = chips(page).first().getByTestId('file-partial');
    await expect(note).toHaveText(
      /^Read in part: \d+ figures on this page are filled in by the site after it loads, and could not be read\. To get them, save the page as a PDF and attach it\.$/,
    );
    await expect(note).toHaveAttribute('role', 'note');
    // Every place a figure should be is marked in what was sent; none is closed up or guessed.
    expect(appendedText(state)).toContain('[not in the page as fetched]');
    await expect(announcer(page)).toContainText('filled in by the site after it loads');
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-read-in-part');
  });

  test('a page that hides instructions in its markup: none of it leaves the browser, and its title is text', async ({
    page,
  }) => {
    const { state } = await openAssistant(page, {
      pages: {
        ...PAGES,
        [RATES]: {
          body: html('injection-visible'),
        },
      },
    });
    await box(page).fill(OFFERS);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    const sent = JSON.stringify(state.fileCalls.map((call) => call.body));
    // What a person can see was read…
    expect(sent).toContain('reduced its two year fixed rate to 5.79% p.a. for owner occupiers');
    // …and what the markup hides was not: no comment, attribute, off-screen or hidden text.
    for (const hidden of [
      'HIDDEN-COMMENT',
      'HIDDEN-ALT',
      'HIDDEN-ARIA-LABEL',
      'HIDDEN-OFFSCREEN',
      'HIDDEN-OPACITY',
      'HIDDEN-DISPLAY-NONE',
      'HIDDEN-NOSCRIPT',
      'HIDDEN-INLINE-DISPLAY-NONE',
      'HIDDEN-INLINE-ARIA',
      'HIDDEN-CELL-SPAN',
      'HIDDEN-ROW',
      'HIDDEN-TAB-LABEL',
      'PWNED',
      'attacker@example.org',
    ]) {
      expect(sent, hidden).not.toContain(hidden);
    }

    // A title that tries to close the wrapper and speak as the system is shown as text.
    await box(page).fill(RATES);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(2);
    const name = chips(page).nth(1).locator('.file__name');
    await expect(name).toContainText('Market update');
    await expect(name).not.toContainText('<');
    await expect(name).not.toContainText('>');
    expect(await thread(page).locator('untrusted_document, script, img').count()).toBe(0);
    await expectNoHorizontalScroll(page);
  });

  test('a page that fades itself in is read as sent, says so on screen, and sends nothing hidden any other way', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    await box(page).fill(MUTUAL);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    const chip = chips(page).first();
    await expect(chip.locator('.file__name')).toHaveText(
      'Home loan offers this month | Example Mutual',
    );
    // Told to everyone, under the page, for as long as the page is there — not read out once.
    const note = chip.getByTestId('file-as-sent');
    await expect(note).toBeVisible();
    await expect(note).toHaveText(
      'Read as the site sent it: this page shows its content only after its scripts run, so what was read may differ from what you see on the page. Check anything important against the page itself.',
    );
    await expect(note).toHaveAttribute('role', 'note');
    await expect(announcer(page)).toContainText(
      'This page shows its content only after its scripts run. It was read as the site sent it',
    );

    const sent = appendedText(state);
    // The reader's own first line, then the page.
    expect(sent.startsWith('[read as the site sent it]\n')).toBe(true);
    expect(sent).toContain('reduced its two year fixed rate to 5.79% p.a. for owner occupiers');
    expect(sent).toContain('2 years\t5.79% p.a.\t5.99% p.a.');
    // What was hidden by opacity is read on a page like this — as text. The wrapper holds it
    // (tests/unit/files/context-web.test.ts). Everything hidden any other way never left.
    expect(sent).toContain('FADED-INSTRUCTION');
    const all = JSON.stringify(state.fileCalls.map((call) => call.body));
    expect(all).not.toContain('VEILED-HIDDEN');
    expect(all).not.toContain('0.99%');
    // And it is text on screen, wherever it shows: nothing the page wrote became markup.
    expect(await thread(page).locator('untrusted_document, script, img').count()).toBe(0);
    expect(siteRequests).toEqual([]);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-read-as-sent');

    // A page read the ordinary way carries no such note.
    await box(page).fill(RATES);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(2);
    await expect(chips(page).nth(1).getByTestId('file-as-sent')).toHaveCount(0);
  });

  test('a PDF at a link is read by the same reader as an attached PDF, and kept as a document', async ({
    page,
  }) => {
    const { state, siteRequests } = await openAssistant(page);
    await box(page).fill(`What are the fees in ${FEES}`);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1, { timeout: 15_000 });
    const chip = chips(page).first();
    await expect(chip).toHaveAttribute('data-source', 'link');
    await expect(chip.locator('.file__name')).toHaveText('rate-sheet.pdf');
    await expect(chip.locator('.file__meta')).toContainText('PDF');
    await expect(chip.locator('.file__meta')).toContainText(
      'from lender.example.org, read today at',
    );
    // A document is kept as a document is: thirty days, not one.
    await expect(chip.locator('.file__meta')).toContainText('Kept for 30 more days');
    await expect(chip.getByRole('link', { name: 'Open the original' })).toHaveAttribute(
      'href',
      FEES,
    );
    const begin = callsOf(state, 'begin')[0];
    expect(begin).toMatchObject({ kind: 'pdf', name: 'rate-sheet.pdf' });
    expect(begin?.['fetchId']).toBe(state.pageFetches[0]?.requestId);
    expect(begin).not.toHaveProperty('title');
    expect(siteRequests).toEqual([]);
  });

  test('read again: a page that changed replaces the earlier copy; one that did not says so', async ({
    page,
  }) => {
    const { state } = await openAssistant(page);
    await box(page).fill(`Rates? ${RATES}`);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);

    // Nothing has changed on the site.
    await rows(page)
      .first()
      .getByRole('button', { name: 'Read again: lender.example.org' })
      .click();
    await expect(announcer(page)).toHaveText(
      'Home loan interest rates | Example Lender has not changed since it was last read.',
    );
    await expect(chips(page)).toHaveCount(1);
    await expect(thread(page).getByTestId('file-removed')).toHaveCount(0);

    // The lender changes a rate.
    state.pages[RATES] = { body: html('rate-table').replace('6.04% p.a.', '5.94% p.a.') };
    await rows(page)
      .first()
      .getByRole('button', { name: 'Read again: lender.example.org' })
      .click();
    await expect(announcer(page)).toHaveText(
      /^Page read: Home loan interest rates \| Example Lender, from lender\.example\.org\. \d+ parts?\. It replaces the earlier read of this page\.$/,
    );
    // One live copy: the earlier one is a line that names nothing.
    await expect(chips(page)).toHaveCount(1);
    await expect(thread(page).getByTestId('file-removed')).toHaveText(
      'A web page was read here and has been read again since. This earlier copy was removed.',
    );
    expect(appendedText(state)).toContain('5.94% p.a.');
    expect(state.pageFetches).toHaveLength(3);
    expect(new Set(state.pageFetches.map((fetch) => fetch.requestId)).size).toBe(3);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-read-again');
  });

  test('removing a page asks once, then leaves a line that does not name it', async ({ page }) => {
    const { state } = await openAssistant(page);
    await box(page).fill(RATES);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    await chips(page)
      .getByRole('button', { name: 'Remove Home loan interest rates | Example Lender' })
      .click();
    await expect(chips(page).locator('.file__confirm')).toContainText(
      'Remove this page? What was read from it is deleted.',
    );
    await chips(page).getByRole('button', { name: 'Remove page' }).click();
    await expect(thread(page).getByTestId('file-removed')).toHaveText(
      'A web page was read here and has since been removed.',
    );
    await expect(chips(page)).toHaveCount(0);
    await expect(thread(page)).not.toContainText('Example Lender');
    await expect(thread(page)).not.toContainText('lender.example.org');
    expect(callsOf(state, 'remove')).toHaveLength(1);
  });

  test('a page read earlier, one past its day, and one replaced are shown as what they are', async ({
    page,
  }) => {
    const base: ScriptedFile = {
      id: 'f3000000-0000-4000-8000-000000000001',
      conversation_id: CONV_ID,
      uploaded_by: USER_ID,
      name: 'Cash rate target | Example Reserve Bank',
      kind: 'html',
      byte_size: 61_204,
      page_count: 3,
      vision_pages: 0,
      status: 'ready',
      created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      expires_at: new Date(Date.now() + 21 * 3_600_000).toISOString(),
      source_url: 'https://www.reserve.example.org/statistics/cash-rate/',
      source_host: 'www.reserve.example.org',
      fetched_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      values_missing: 0,
      removed_reason: null,
    };
    await openAssistant(page, {
      files: [
        base,
        {
          ...base,
          id: 'f3000000-0000-4000-8000-000000000002',
          name: null,
          status: 'removed',
          source_url: null,
          source_host: null,
          fetched_at: null,
          removed_reason: 'expired',
          created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
        {
          ...base,
          id: 'f3000000-0000-4000-8000-000000000003',
          name: null,
          status: 'removed',
          source_url: null,
          source_host: null,
          fetched_at: null,
          removed_reason: 'replaced',
          created_at: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    });
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator('.file__meta')).toContainText(
      'Web page · reserve.example.org · read',
    );
    const gone = thread(page).getByTestId('file-removed');
    await expect(gone).toHaveCount(2);
    await expect(gone.nth(0)).toHaveText(
      'A web page was read here. Pages are kept for a day, so it has been removed. Read it again for the current version.',
    );
    await expect(gone.nth(1)).toHaveText(
      'A web page was read here and has been read again since. This earlier copy was removed.',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-in-thread');
  });
});

test.describe('progress, and stopping', () => {
  test('a slow page: progress is shown and announced, Send waits, and it can be stopped', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { state, siteRequests } = await openAssistant(page, {
      pages: { ...PAGES, [RATES]: { body: html('rate-table'), delayMs: 60_000 } },
    });
    await box(page).fill(`What is the two year fixed rate? ${RATES}`);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    const row = uploads(page).first();
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-source', 'link');
    // A real progress element, named for a screen reader, with nothing to measure yet.
    const bar = row.getByRole('progressbar', { name: 'Reading lender.example.org' });
    await expect(bar).toBeVisible();
    await expect(bar).not.toHaveAttribute('value', /.*/);
    await expect(row.locator('.file__status')).toHaveText('Opening the page…');
    await expect(announcer(page)).toHaveAttribute('aria-live', 'polite');
    await expect(announcer(page)).toHaveText('Opening lender.example.org.');
    await expect(rows(page).first()).toHaveAttribute('data-state', 'reading');
    await expect(rows(page).first().locator('.links__state')).toHaveText('Opening the page…');
    await expect(rows(page).first().getByRole('button')).toHaveCount(0);
    // A message sent now would be answered without the page.
    await expect(send(page)).toBeDisabled();
    await expect(page.getByTestId('send-blocked')).toHaveText(
      'Wait for the page from lender.example.org to be read before you send.',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-reading');

    // He changes his mind.
    await row.getByRole('button', { name: 'Stop reading lender.example.org' }).click();
    await expect(uploads(page)).toHaveCount(0);
    await expect(chips(page)).toHaveCount(0);
    await expect(announcer(page)).toHaveText('lender.example.org: Stopped. Nothing was attached.');
    await expect(send(page)).toBeEnabled();
    await expect(rows(page).first()).toHaveAttribute('data-state', 'unread');
    expect(actions(state)).toEqual(['fetch_page']);
    expect(siteRequests).toEqual([]);
  });

  test('reduced motion: the bar for a page being read does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAssistant(page, {
      pages: { ...PAGES, [RATES]: { body: html('rate-table'), delayMs: 60_000 } },
    });
    await box(page).fill(RATES);
    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(uploads(page).getByRole('progressbar')).toBeVisible();
    const result = await page.evaluate(() => {
      const bar = document.querySelector('.file__bar');
      const longest = (value: string): number =>
        Math.max(0, ...value.split(',').map((part) => parseFloat(part) || 0));
      const moving = Array.from(document.querySelectorAll('.links *, .composer__ask *, .file *'))
        .map((el) => getComputedStyle(el))
        .filter(
          (style) =>
            (style.animationName !== 'none' && longest(style.animationDuration) > 0.001) ||
            longest(style.transitionDuration) > 0.001,
        ).length;
      return {
        reduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        animation: bar === null ? '' : getComputedStyle(bar).animationName,
        moving,
      };
    });
    expect(result).toEqual({ reduce: true, animation: 'none', moving: 0 });
  });
});

test.describe('layout and accessibility', () => {
  test('a very long address and a very long title do not break the layout', async ({ page }) => {
    const long = `https://www.lender.example.org/${'a-very-long-section-name/'.repeat(30)}the-final-page-with-a-very-long-name.html?${'utm_campaign=spring-refinance-offer&'.repeat(20)}`;
    const title = `${'Supercalifragilisticexpialidocious'.repeat(8)} 住宅ローン金利のご案内 ${'معدلات الفائدة على قروض المنازل '.repeat(4)}`;
    const { state } = await openAssistant(page, {
      pages: {
        [long.slice(0, long.length)]: {
          body: html('rate-table').replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`),
        },
      },
    });
    expect(long.length).toBeGreaterThan(1_400);
    await box(page).fill(`Please read this ${long}`);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first().locator('.links__address')).toHaveAttribute('title', long);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-long-address');

    await rows(page)
      .first()
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    expect(state.pageFetches[0]?.url).toBe(long);
    // The whole title is there for a pointer or a screen reader; on screen it is cut.
    const name = chips(page).first().locator('.file__name');
    await expect(name).toHaveAttribute('title', /Supercalifragilistic/);
    await expectNoHorizontalScroll(page);

    // With the question open as well: the widest this part ever gets.
    await box(page).fill(`And this one ${long.replace('lender', 'other')}`);
    await send(page).click();
    await expect(ask(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-long-title');
  });

  test('text inputs stay at 16px and every control added here is a full tap target', async ({
    page,
  }) => {
    await openAssistant(page);
    await box(page).fill(`Compare ${RATES} ${PORTAL} http://old.example.org/x`);
    await rows(page)
      .nth(1)
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(problem(page)).toBeVisible();
    await rows(page)
      .nth(0)
      .getByRole('button', { name: /Read this page/ })
      .click();
    await expect(chips(page)).toHaveCount(1);
    await expectNoHorizontalScroll(page);
    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea, select')).map((el) =>
        parseFloat(getComputedStyle(el).fontSize),
      ),
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
    const targets = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.links button, .file button, .file__origin a')).map(
        (node) => ({
          label: (node.getAttribute('aria-label') ?? node.textContent).trim(),
          height: Math.round(node.getBoundingClientRect().height),
        }),
      ),
    );
    // Read again · Dismiss · Open the page · Remove.
    expect(targets.length, JSON.stringify(targets)).toBeGreaterThanOrEqual(4);
    for (const target of targets) {
      expect(target.height, JSON.stringify(target)).toBeGreaterThanOrEqual(44);
    }
    // The strip is a list a screen reader can count. It is not a live region itself: what
    // happened to a read is said once, through the one announcer the shell already has.
    await expect(strip(page)).toHaveAttribute('aria-label', 'Links in this message');
    await expect(announcer(page)).toHaveCount(1);
    expect(await strip(page).locator('[aria-live], [role="status"], [role="alert"]').count()).toBe(
      0,
    );
    expect(
      await strip(page).evaluate((node) => node.closest('[aria-live], [role="status"]')),
    ).toBeNull();
    await shot(page, 'links-mixed-states');
  });
});

test.describe('the assistant panel', () => {
  test('a link is read from the panel beside the numbers, and is the same page on the full page', async ({
    page,
  }) => {
    const siteRequests = await watchSites(page);
    const state = await installMock(page, { conversations: [CONVERSATION], pages: PAGES });
    await signIn(page, '/');
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await panel.getByPlaceholder(PLACEHOLDER).fill(`What is the variable rate? ${RATES}`);
    const row = panel.getByTestId('link-strip').locator('li[data-state]').first();
    await expect(row).toHaveAttribute('data-state', 'unread');
    await row.getByRole('button', { name: /Read this page/ }).click();
    const chip = page.getByTestId('panel-thread').getByTestId('file');
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.file__name')).toHaveText(
      'Home loan interest rates | Example Lender',
    );
    await expect(row).toHaveAttribute('data-state', 'read');
    expect(actions(state)).toEqual(['fetch_page', 'begin', 'append', 'finish']);
    expect(siteRequests).toEqual([]);
    await expectNoHorizontalScroll(page);
    await shot(page, 'links-panel');

    await panel.getByRole('button', { name: 'Full page' }).click();
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator('.file__name')).toHaveText(
      'Home loan interest rates | Example Lender',
    );
  });
});
