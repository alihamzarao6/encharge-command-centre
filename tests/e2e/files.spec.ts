/**
 * Milestone 5 part 1 in a real browser at three widths (375 / 768 / 1280): attaching files to
 * a conversation. The files are the committed, invented fixtures (tests/fixtures/files); they
 * are read by the REAL readers running in Chrome — pdf.js and its worker, the canvas that
 * turns a photo upright, the zip and XML readers — and what the browser then sends is checked
 * at the (scripted) endpoint. Nothing leaves the machine.
 *
 * Part C, "the interface", and the browser's half of "the file itself" and "the run":
 *   - a control to attach, reachable by keyboard; drag-and-drop as well, not instead;
 *   - progress while it reads and uploads, announced to a screen reader;
 *   - the file in the thread afterwards with its name and size, and a way to remove it;
 *   - a scan asks first: how many pages, what it costs, continue or stop (D90);
 *   - every refusal is a sentence; nothing fails silently;
 *   - 375 / 768 / 1280 with no horizontal scroll, inputs at 16px, long names contained.
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
} from './mock.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/files/', import.meta.url));
const SHOTS = fileURLToPath(new URL('../../docs/assets/milestone-5/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const fixture = (name: string): string => `${FIXTURES}${name}`;

function shot(page: Page, name: string): Promise<Buffer> {
  const width = page.viewportSize()?.width ?? 0;
  return page.screenshot({ path: `${SHOTS}${name}-${String(width)}.png`, fullPage: false });
}

/**
 * The page does not scroll sideways (the check every suite makes), AND nothing this part
 * draws reaches past the edge of the screen: a clipped row passes the first check while
 * hiding half a button. The second is scoped to the thread and the composer because the bar
 * above the thread already loses its "+ New" at 768 with a conversation open (it is in the
 * committed stage-3 screenshots); that is reported, and not this part's to change.
 */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const wide = Array.from(
      document.querySelectorAll(
        '.thread, .thread *, .composer, .composer *, .composer__note, .panel, .panel *',
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

/** Signed in, on the Assistant, with one conversation open. */
async function openAssistant(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state = await installMock(page, { conversations: [CONVERSATION], ...options });
  await signIn(page, '/assistant');
  await expect(page.getByRole('button', { name: '+ New', exact: true })).toBeVisible();
  // The list is a slide-in sheet on a phone and a sidebar from 768px.
  const menu = page.getByRole('button', { name: 'Open conversations' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('listitem').filter({ hasText: 'Sample Person refinance' }).click();
  await expect(page.locator('.thread-pane__title')).toHaveText(
    'ross.test — Sample Person refinance',
  );
  await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toBeVisible();
  return state;
}

/** Signed in, on the Assistant, on a conversation that does not exist yet. */
async function openNewConversation(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state = await installMock(page, options);
  await signIn(page, '/assistant');
  await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toBeVisible();
  return state;
}

const picker = (page: Page): Locator => page.getByTestId('composer-input-files');
const thread = (page: Page): Locator => page.getByTestId('thread');
const chips = (page: Page): Locator => thread(page).getByTestId('file');
const uploads = (page: Page): Locator => thread(page).getByTestId('upload');
const problem = (page: Page): Locator => thread(page).getByTestId('upload-problem');
const announcer = (page: Page): Locator => page.getByTestId('upload-announcer');

const actions = (state: MockState): string[] =>
  state.fileCalls.map((call) => String(call.body['action']));
const callsOf = (state: MockState, action: string): Record<string, unknown>[] =>
  state.fileCalls.filter((call) => call.body['action'] === action).map((call) => call.body);
const appendedText = (state: MockState): string =>
  callsOf(state, 'append')
    .flatMap((body) => body['pages'] as { text: string }[])
    .map((page) => page.text)
    .join('\n');

test.describe('attaching a file', () => {
  test('the control is a button reached by keyboard, and a typed PDF is read and attached', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    const attach = page.getByRole('button', { name: 'Attach a file' });
    await expect(attach).toBeVisible();
    // A real tap target, and reachable without a mouse.
    const box = await attach.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    // One Tab back from the message box lands on it: the picker behind it is not a tab stop.
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(attach).toBeFocused();
    expect(await attach.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(fixture('payslip-text-layer.pdf'));

    const chip = chips(page);
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.file__name')).toHaveText('payslip-text-layer.pdf');
    await expect(chip.locator('.file__meta')).toHaveText(
      'PDF · 1 page · 5 KB · Kept for 30 more days',
    );
    await expect(chip.getByRole('button', { name: 'Remove payslip-text-layer.pdf' })).toBeVisible();
    await expect(uploads(page)).toHaveCount(0);

    // What left the browser: the text pdf.js read, rows intact — never the file.
    expect(actions(state)).toEqual(['begin', 'append', 'finish']);
    expect(callsOf(state, 'begin')[0]).toMatchObject({
      conversationId: CONV_ID,
      name: 'payslip-text-layer.pdf',
      kind: 'pdf',
      byteSize: 4651,
      totalPages: 1,
      visionPages: 0,
    });
    expect(String(callsOf(state, 'begin')[0]?.['contentHash'])).toMatch(/^[0-9a-f]{64}$/);
    expect(appendedText(state)).toContain('Ordinary hours\t76.00\t42.50\t3,230.00');
    expect(appendedText(state)).toContain('Net pay\t(blank)\t(blank)\t2,887.38');
    const sent = JSON.stringify(state.fileCalls);
    expect(sent).not.toContain('%PDF');
    // The browser never talks to the model, and never writes to the database.
    expect(state.anthropicCalls).toBe(0);
    expect(state.postgrestWrites).toEqual([]);

    await expectNoHorizontalScroll(page);
    await shot(page, 'files-attached');
  });

  test('Word, Excel, CSV and text are each read by their own reader', async ({ page }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles([
      fixture('letter.docx'),
      fixture('statement.xlsx'),
      fixture('transactions-semicolon-bom.csv'),
      fixture('notes-utf16.txt'),
    ]);
    await expect(chips(page)).toHaveCount(4);
    expect(callsOf(state, 'begin').map((body) => body['kind'])).toEqual([
      'docx',
      'xlsx',
      'csv',
      'text',
    ]);
    const text = appendedText(state);
    expect(text).toContain('Establishment fee | $600 | once');
    expect(text).toContain('4\tDate\tDescription\tAmount\tBalance');
    expect(text).toContain('18\t\tTotal\t5570.57 {=SUM(C5:C16)}');
    // The total is computed by the reader, not left to the model — and says what it left out.
    expect(text).toContain(
      '- C "Amount" (rows 5 to 16): 12 numbers, sum 5570.57, min -1450, max 3699.38; 1 formula cell left out',
    );
    expect(text).toContain('2\t01.09.2026\tMiete; September\t-1.450,00\t2.750,00');
    // Non-Latin text, right-to-left text and emoji arrive as they were written.
    expect(text).toContain('עברית: הערה חשובה');
    expect(text).toContain('العربية: ملاحظة مهمة');
    expect(text).toContain('👨‍👩‍👧');
    await expect(chips(page).nth(0).locator('.file__meta')).toContainText(
      'Word document · 1 part · 36 KB',
    );
    await expect(chips(page).nth(1).locator('.file__meta')).toContainText(
      /Excel workbook · \d parts · 7 KB/,
    );
    await expectNoHorizontalScroll(page);
  });

  test('a document that is almost all tables, and one in scripts pdf.js needs its character maps for', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles([fixture('rate-sheet-tables.pdf'), fixture('non-latin.pdf')]);
    await expect(chips(page)).toHaveCount(2);
    const text = appendedText(state);
    expect(text).toContain('Home loan A0\t60-70%\t5.84\t6.01\t$0');
    expect(text).toContain('Ελληνικά: Το ποσό του δανείου είναι 450.000');
    expect(text).toContain('Русский: Сумма кредита составляет 450 000');
    // Served from this app's own origin (web/vite.config.ts); without it this line is dropped.
    expect(text).toContain('贷款金额');
  });

  test('a file dropped onto the conversation is attached too', async ({ page }) => {
    const state = await openAssistant(page);
    const pane = page.locator('.thread-pane');
    const data = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(['Date,Amount\n2026-09-01,10\n2026-09-02,20\n2026-09-03,30\n'], 'dropped.csv', {
          type: 'text/csv',
        }),
      );
      return transfer;
    });
    await pane.dispatchEvent('dragenter', { dataTransfer: data });
    await expect(pane).toHaveClass(/is-dropping/);
    await pane.dispatchEvent('dragover', { dataTransfer: data });
    await pane.dispatchEvent('drop', { dataTransfer: data });
    await expect(pane).not.toHaveClass(/is-dropping/);
    await expect(chips(page).locator('.file__name')).toHaveText('dropped.csv');
    expect(appendedText(state)).toContain(
      '- B "Amount" (rows 2 to 4): 3 numbers, sum 60, min 10, max 30',
    );
  });

  test('a new conversation: the upload opens it, and the first message goes to the same one', async ({
    page,
  }) => {
    const state = await openNewConversation(page, {
      chat: {
        respond: (_request, call) => ({
          sse: sseDone('The payslip shows a net pay of 2,887.38.', call),
        }),
      },
    });
    await picker(page).setInputFiles(fixture('payslip-text-layer.pdf'));
    await expect(chips(page)).toHaveCount(1);
    // Begun with no conversation: the server made one.
    expect(callsOf(state, 'begin')[0]?.['conversationId']).toBeNull();

    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('What is the net pay?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(thread(page).locator('[data-role="assistant"]').last()).toContainText('2,887.38');
    expect(state.chatCalls[0]).toMatchObject({
      message: 'What is the net pay?',
      conversationId: CONV_ID,
    });
    // In the thread the file comes first, then the question about it, then the answer.
    const order = await thread(page).evaluate((node) =>
      Array.from(node.children).map(
        (el) => el.getAttribute('data-testid') ?? el.getAttribute('data-role') ?? '',
      ),
    );
    expect(order).toEqual(['file', 'user', 'assistant']);
    await shot(page, 'files-question-answered');
  });

  test('two files at once are two uploads, one after the other; the same file again is the same attachment', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles([fixture('payslip-text-layer.pdf'), fixture('rates.tsv')]);
    await expect(chips(page)).toHaveCount(2);
    expect(actions(state)).toEqual(['begin', 'append', 'finish', 'begin', 'append', 'finish']);

    await picker(page).setInputFiles(fixture('payslip-text-layer.pdf'));
    await expect(announcer(page)).toHaveText(
      'payslip-text-layer.pdf is already attached to this conversation.',
    );
    await expect(chips(page)).toHaveCount(2);
    await expect(uploads(page)).toHaveCount(0);
    // Recognised from its content: nothing was sent a second time.
    expect(actions(state).slice(6)).toEqual(['begin']);
  });
});

test.describe('photos and scans', () => {
  test('a phone photo is turned upright, scaled, re-encoded and read as one page', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles(fixture('photo-payslip-phone.jpg'));
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator('.file__meta')).toContainText(
      'Photo · 1 page · 75 KB · read from the image',
    );
    // One page, no question asked for a single photo.
    expect(actions(state)).toEqual(['begin', 'read_page', 'finish']);
    expect(state.pageImages).toHaveLength(1);
    const image = state.pageImages[0];
    // The fixture is stored on its side with an EXIF tag, as a phone stores it. What was sent
    // is a JPEG the right way up (taller than wide), no larger than the limit.
    expect(image?.height ?? 0).toBeGreaterThan(image?.width ?? 0);
    expect(Math.max(image?.width ?? 0, image?.height ?? 0)).toBeLessThanOrEqual(2048);
    expect(image?.label).toBe('Photo');
    // Re-encoding dropped the metadata: no EXIF block in what left the device.
    const sent = String(callsOf(state, 'read_page')[0]?.['imageBase64']);
    expect(Buffer.from(sent, 'base64').includes(Buffer.from('Exif'))).toBe(false);
    expect(readFileSync(fixture('photo-payslip-phone.jpg')).includes(Buffer.from('Exif'))).toBe(
      true,
    );
  });

  test('a picture that is not a document, and a file whose extension lies, are both sent as pictures', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles([
      fixture('photo-house.jpg'),
      fixture('lies-about-extension.pdf'),
    ]);
    await expect(chips(page)).toHaveCount(2);
    expect(callsOf(state, 'begin').map((body) => body['kind'])).toEqual(['image', 'image']);
    expect(state.pageImages).toHaveLength(2);
    await expect(announcer(page)).toContainText(
      'lies-about-extension.pdf attached: 1 part. This file is named .pdf but is really a picture',
    );
  });

  test('a scan asks first: how many pages, what it costs against today, continue or stop', async ({
    page,
  }) => {
    const state = await openAssistant(page, { spentTodayUsd: 1.25 });
    await picker(page).setInputFiles(fixture('scanned-statement.pdf'));
    const confirm = thread(page).getByTestId('upload-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "This is a scan. 3 pages will be read as images, which costs about $0.08 — around 2% of today's $5.00 budget. $1.25 of it has been used today.",
    );
    // Nothing has been claimed, rendered or sent to be read.
    expect(actions(state)).toEqual(['estimate']);
    expect(state.pageImages).toEqual([]);
    // A message sent now would be answered without the file: Send waits, and says why.
    await page
      .getByPlaceholder('Ask for a post, an ad, a reply…')
      .fill('What is the closing balance?');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(page.getByTestId('send-blocked')).toHaveText(
      'Choose whether to read scanned-statement.pdf before you send.',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'files-scan-confirm');

    await confirm.getByRole('button', { name: 'Read 3 pages' }).click();
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator('.file__meta')).toContainText(
      'PDF · 3 pages · 100 KB · 3 read from images',
    );
    expect(actions(state)).toEqual([
      'estimate',
      'begin',
      'read_page',
      'read_page',
      'read_page',
      'finish',
    ]);
    expect(state.pageImages.map((image) => image.pageNo)).toEqual([1, 2, 3]);
    for (const image of state.pageImages) {
      // Rendered by pdf.js to a page-shaped JPEG whose long edge is the limit (to the pixel,
      // give or take the rounding of a page that is not a whole number of points).
      expect(Math.max(image.width, image.height)).toBeGreaterThanOrEqual(2040);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(2048);
      expect(image.height).toBeGreaterThan(image.width);
    }
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  test('saying no to a scan reads nothing and attaches nothing', async ({ page }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles(fixture('scanned-statement.pdf'));
    await thread(page)
      .getByTestId('upload-confirm')
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(uploads(page)).toHaveCount(0);
    await expect(chips(page)).toHaveCount(0);
    await expect(announcer(page)).toHaveText(
      'scanned-statement.pdf: Stopped. Nothing was attached.',
    );
    expect(actions(state)).toEqual(['estimate']);
    expect(state.pageImages).toEqual([]);
  });

  test('a document with some typed pages and one scanned page sends text for the first and a picture for the second', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles(fixture('mixed-text-and-scan.pdf'));
    await expect(chips(page)).toHaveCount(1);
    // One page to look at: no question.
    expect(actions(state)).toEqual(['begin', 'append', 'read_page', 'finish']);
    expect(appendedText(state)).toContain('Net pay\t(blank)\t(blank)\t2,887.38');
    expect(state.pageImages.map((image) => image.pageNo)).toEqual([2]);
  });

  test("when today's budget cannot cover a scan, nothing is read and the numbers are given", async ({
    page,
  }) => {
    const state = await openAssistant(page, {
      filesScript: {
        respond: (body) =>
          body['action'] === 'estimate'
            ? {
                status: 200,
                body: {
                  action: 'estimate',
                  pages: 3,
                  perPageUsd: 0.027,
                  estimateUsd: 0.08,
                  dailyCapUsd: 5,
                  spentTodayUsd: 4.97,
                  affordable: false,
                },
              }
            : undefined,
      },
    });
    await picker(page).setInputFiles(fixture('scanned-statement.pdf'));
    await expect(problem(page)).toContainText(
      "Reading these 3 pages would cost about $0.08, and today's budget of $5.00 has $0.03 left. Nothing was read.",
    );
    expect(actions(state)).toEqual(['estimate']);
    await expect(chips(page)).toHaveCount(0);
  });
});

test.describe('a file that is not read', () => {
  const refusals: readonly [file: string, reason: string, sentence: string][] = [
    [
      'password-protected.pdf',
      'password_pdf',
      "This PDF is password-protected, so it can't be opened. Save a copy without the password and send that.",
    ],
    [
      'truncated.pdf',
      'corrupt',
      "This file is damaged or incomplete and couldn't be opened. Try exporting or downloading it again.",
    ],
    ['empty.pdf', 'empty', 'This file is empty (0 bytes), so there is nothing to read.'],
    [
      'legacy.xls',
      'legacy_office',
      'This is an old-format Office file (.doc, .xls or .ppt), or one protected with a password. Save it as .docx, .xlsx or PDF, without a password, and send that.',
    ],
    [
      'deck.pptx',
      'presentation',
      "PowerPoint files aren't read. Save the slides as a PDF and send that.",
    ],
    [
      'nested-archive.zip',
      'archive',
      "Archives (.zip and the like) aren't accepted. Send the files inside it one at a time.",
    ],
    ['program.pdf', 'executable', "This is a program, not a document, so it isn't read."],
    [
      'page.html',
      'active_content',
      "This is a web page or an SVG file, which can carry scripts, so it isn't read. Save it as a PDF and send that.",
    ],
    [
      'expands-too-far.xlsx',
      'expands_too_far',
      'This file unpacks to far more data than its size suggests, so it was not opened.',
    ],
    [
      'photo.heic',
      'heic_unsupported',
      "This is an iPhone HEIC photo, which this browser can't open. Send it from the iPhone itself, or save it as a JPEG first.",
    ],
  ];

  test('every refusal is a sentence, nothing is sent, and the reason is recorded', async ({
    page,
  }) => {
    const state = await openAssistant(page);
    await picker(page).setInputFiles(refusals.map(([file]) => fixture(file)));
    await expect(problem(page)).toHaveCount(refusals.length);
    for (const [index, [file, , sentence]] of refusals.entries()) {
      const row = uploads(page).nth(index);
      await expect(row.locator('.file__name')).toHaveText(file);
      await expect(row.getByTestId('upload-problem')).toContainText(sentence);
      // A refused file is not something to try again.
      await expect(row.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    }
    // Nothing was claimed and no page was sent: only the reasons, with a size each.
    await expect.poll(() => callsOf(state, 'refused').length).toBe(refusals.length);
    expect(new Set(actions(state))).toEqual(new Set(['refused']));
    expect(callsOf(state, 'refused').map((body) => body['reason'])).toEqual(
      refusals.map(([, reason]) => reason),
    );
    for (const body of callsOf(state, 'refused')) {
      expect(Object.keys(body).sort()).toEqual([
        'action',
        'byteSize',
        'extractMs',
        'kind',
        'reason',
      ]);
    }
    expect(JSON.stringify(state.fileCalls)).not.toContain('password-protected');
    await expect(chips(page)).toHaveCount(0);
    // A refused file does not hold up a message.
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('hello');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await expectNoHorizontalScroll(page);

    await uploads(page).first().getByRole('button', { name: 'Dismiss' }).click();
    await expect(uploads(page)).toHaveCount(refusals.length - 1);
  });

  test('a refusal is announced, and shown where the file would have been', async ({ page }) => {
    await openAssistant(page);
    await picker(page).setInputFiles(fixture('password-protected.pdf'));
    await expect(problem(page)).toHaveAttribute('role', 'alert');
    await expect(announcer(page)).toHaveText(
      "password-protected.pdf was not attached. This PDF is password-protected, so it can't be opened. Save a copy without the password and send that.",
    );
    await shot(page, 'files-refused');
  });

  test('a file at exactly the size limit is accepted; one byte over is refused with the numbers', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const state = await openAssistant(page);
    const limit = 20 * 1024 * 1024;
    const jpeg = readFileSync(fixture('photo-house.jpg'));
    const exact = Buffer.alloc(limit);
    jpeg.copy(exact);
    await picker(page).setInputFiles({
      name: 'exactly-20mb.jpg',
      mimeType: 'image/jpeg',
      buffer: exact,
    });
    await expect(chips(page)).toHaveCount(1, { timeout: 40_000 });
    await expect(chips(page).locator('.file__meta')).toContainText('Photo · 1 page · 20.0 MB');
    expect(callsOf(state, 'begin')[0]).toMatchObject({ byteSize: limit });

    const over = Buffer.alloc(limit + 1);
    jpeg.copy(over);
    await picker(page).setInputFiles({
      name: 'one-byte-over.jpg',
      mimeType: 'image/jpeg',
      buffer: over,
    });
    await expect(problem(page)).toContainText(
      'This file is 20.0 MB, which is over the 20 MB limit.',
    );
    await expect.poll(() => callsOf(state, 'refused').length).toBe(1);
    expect(callsOf(state, 'refused')[0]).toMatchObject({
      reason: 'too_large',
      byteSize: limit + 1,
    });
    // Refused on its size alone: it was never opened, so nothing else was sent.
    expect(callsOf(state, 'begin')).toHaveLength(1);
  });
});

test.describe('progress, and what happens when it stops', () => {
  test('a 300-page document on a slow connection: progress is shown and announced, and Send waits', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Every call takes 1.5 seconds until the test says otherwise: the upload is in flight for
    // as long as the assertions about an upload in flight need, rather than for a guessed while.
    const state = await openAssistant(page, { filesDelayMs: 1_500 });
    await picker(page).setInputFiles(fixture('policy-300-pages.pdf'));
    const row = uploads(page).first();
    await expect(row).toBeVisible();
    // A real progress element with a name a screen reader reads.
    const bar = row.getByRole('progressbar', { name: 'Attaching policy-300-pages.pdf' });
    await expect(bar).toBeVisible();
    await expect(row.locator('.file__status')).toContainText(/Reading the file…|Sending…/);
    await expect(announcer(page)).toHaveAttribute('aria-live', 'polite');
    await expect(announcer(page)).toHaveAttribute('aria-atomic', 'true');
    await expect(announcer(page)).toHaveText('Reading policy-300-pages.pdf.');

    await expect(row.locator('.file__status')).toContainText(/Sending… part \d+ of 300/, {
      timeout: 20_000,
    });
    await expect(bar).toHaveAttribute('value', /\d+/);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('What is the max LVR?');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await expect(page.getByTestId('send-blocked')).toHaveText(
      'Wait for policy-300-pages.pdf to finish before you send.',
    );
    await expectNoHorizontalScroll(page);
    await shot(page, 'files-uploading');

    state.filesDelayMs = 0;
    await expect(chips(page)).toHaveCount(1, { timeout: 25_000 });
    await expect(chips(page).locator('.file__meta')).toContainText('PDF · 300 pages · 929 KB');
    await expect(announcer(page)).toHaveText('policy-300-pages.pdf attached: 300 parts.');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    // Sent in batches, every page exactly once.
    const pages = callsOf(state, 'append').flatMap((body) => body['pages'] as { pageNo: number }[]);
    expect(callsOf(state, 'append').length).toBe(8);
    expect(pages.map((p) => p.pageNo)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(appendedText(state)).toContain('zebra clause');
  });

  test('the network dropping mid-upload: it says so, keeps nothing, and Try again finishes it', async ({
    page,
  }) => {
    let dropped = false;
    const state = await openAssistant(page, {
      filesScript: {
        respond: (body) => {
          if (body['action'] === 'append' && !dropped) {
            dropped = true;
            return 'abort';
          }
          return undefined;
        },
      },
    });
    await picker(page).setInputFiles(fixture('letter.docx'));
    await expect(problem(page)).toContainText(
      "Couldn't reach the Command Centre. Check your connection and try again.",
    );
    await expect(chips(page)).toHaveCount(0);
    expect(actions(state)).not.toContain('finish');

    await uploads(page).getByRole('button', { name: 'Try again' }).click();
    await expect(chips(page)).toHaveCount(1);
    const begins = callsOf(state, 'begin');
    // The same upload, resumed — not a second one.
    expect(begins).toHaveLength(2);
    expect(begins[0]?.['requestId']).toBe(begins[1]?.['requestId']);
  });

  test('a scan interrupted half-way resumes from the page it stopped at', async ({ page }) => {
    let failed = false;
    const state = await openAssistant(page, {
      filesScript: {
        respond: (body) => {
          if (body['action'] === 'read_page' && body['pageNo'] === 2 && !failed) {
            failed = true;
            return {
              status: 504,
              body: {
                error: {
                  code: 'TIMEOUT',
                  message: 'Reading this page took too long. Nothing was attached. Try again.',
                  retryable: true,
                },
              },
            };
          }
          return undefined;
        },
      },
    });
    await picker(page).setInputFiles(fixture('scanned-statement.pdf'));
    await thread(page)
      .getByTestId('upload-confirm')
      .getByRole('button', { name: 'Read 3 pages' })
      .click();
    await expect(problem(page)).toContainText(
      'Stopped after 1 of 3 pages. Reading this page took too long. Nothing was attached. Try again.',
    );
    await expect(chips(page)).toHaveCount(0);

    await uploads(page).getByRole('button', { name: 'Try again' }).click();
    await expect(chips(page)).toHaveCount(1);
    // Page 1 was read once. The question about the cost was asked once.
    expect(state.pageImages.map((image) => image.pageNo)).toEqual([1, 2, 3]);
    expect(callsOf(state, 'estimate')).toHaveLength(1);
    expect(callsOf(state, 'read_page').map((body) => body['pageNo'])).toEqual([1, 2, 2, 3]);
  });

  test('the budget running out mid-document: told plainly, nothing attached, nothing to retry', async ({
    page,
  }) => {
    const capped =
      "Today's budget for the assistant has been used up, so this page was not read and the file was not attached. It resets at midnight UTC.";
    const state = await openAssistant(page, {
      filesScript: {
        respond: (body) =>
          body['action'] === 'read_page' && body['pageNo'] === 3
            ? {
                status: 402,
                body: { error: { code: 'SPEND_CAP', message: capped, retryable: false } },
              }
            : undefined,
      },
    });
    await picker(page).setInputFiles(fixture('scanned-statement.pdf'));
    await thread(page)
      .getByTestId('upload-confirm')
      .getByRole('button', { name: 'Read 3 pages' })
      .click();
    await expect(problem(page)).toContainText(`Stopped after 2 of 3 pages. ${capped}`);
    await expect(uploads(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
    // Not a half-read file presented as a whole one: there is no file.
    await expect(chips(page)).toHaveCount(0);
    expect(actions(state)).not.toContain('finish');
    await expect(announcer(page)).toContainText('scanned-statement.pdf was not attached.');
    await shot(page, 'files-budget-reached');

    await uploads(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(uploads(page)).toHaveCount(0);
    expect(callsOf(state, 'remove')).toHaveLength(1);
  });

  test('stopping an upload part-way leaves nothing behind', async ({ page }) => {
    test.setTimeout(60_000);
    const state = await openAssistant(page, { filesDelayMs: 1_500 });
    await picker(page).setInputFiles(fixture('policy-300-pages.pdf'));
    await expect(uploads(page).locator('.file__status')).toContainText(/Sending… part \d+ of 300/, {
      timeout: 20_000,
    });
    await uploads(page)
      .getByRole('button', { name: 'Stop attaching policy-300-pages.pdf' })
      .click();
    await expect(uploads(page)).toHaveCount(0);
    await expect(announcer(page)).toHaveText(
      'policy-300-pages.pdf: Stopped. Nothing was attached.',
    );
    // The server is told to forget what it had been sent.
    await expect.poll(() => callsOf(state, 'remove').length).toBe(1);
    state.filesDelayMs = 0;
    const sentSoFar = callsOf(state, 'append').length;
    await page.waitForTimeout(2_000);
    // Nothing more was sent after Stop, and it never became a file.
    expect(callsOf(state, 'append')).toHaveLength(sentSoFar);
    expect(actions(state)).not.toContain('finish');
    await expect(chips(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('still here');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  });
});

test.describe('a file in the conversation afterwards', () => {
  const attached = (overrides: Partial<ScriptedFile> = {}): ScriptedFile => ({
    id: 'f2000000-0000-4000-8000-000000000001',
    conversation_id: CONV_ID,
    uploaded_by: USER_ID,
    name: 'payslip-september.pdf',
    kind: 'pdf',
    byte_size: 219_136,
    page_count: 2,
    vision_pages: 0,
    status: 'ready',
    created_at: '2026-10-12T02:00:00Z',
    expires_at: new Date(Date.now() + 29.5 * 86_400_000).toISOString(),
    ...overrides,
  });
  const MESSAGES = {
    [CONV_ID]: [
      { id: 'm1', role: 'user' as const, content: 'Morning.', created_at: '2026-10-12T01:00:00Z' },
      {
        id: 'm2',
        role: 'assistant' as const,
        content: 'Morning Ross.',
        created_at: '2026-10-12T01:00:05Z',
      },
      {
        id: 'm3',
        role: 'user' as const,
        content: 'What is the net pay?',
        created_at: '2026-10-12T02:01:00Z',
      },
      {
        id: 'm4',
        role: 'assistant' as const,
        content: 'The payslip shows a net pay of 2,887.38.',
        created_at: '2026-10-12T02:01:08Z',
      },
    ],
  };

  test('it is shown where it was attached, with its name, its size and how long it is kept', async ({
    page,
  }) => {
    await openAssistant(page, { files: [attached()], messages: MESSAGES });
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator('.file__meta')).toHaveText(
      'PDF · 2 pages · 214 KB · Kept for 30 more days',
    );
    const order = await thread(page).evaluate((node) =>
      Array.from(node.children).map(
        (el) => el.getAttribute('data-testid') ?? el.getAttribute('data-role') ?? '',
      ),
    );
    expect(order).toEqual(['user', 'assistant', 'file', 'user', 'assistant']);
    await expectNoHorizontalScroll(page);
    await shot(page, 'files-in-thread');
  });

  test('removing it asks once, then leaves a line with no name where it was', async ({ page }) => {
    const state = await openAssistant(page, { files: [attached()], messages: MESSAGES });
    await chips(page).getByRole('button', { name: 'Remove payslip-september.pdf' }).click();
    const confirm = chips(page).locator('.file__confirm');
    await expect(confirm).toContainText(
      'What was read from it is deleted. What the assistant has already said about it stays in this conversation.',
    );
    await confirm.getByRole('button', { name: 'Keep it' }).click();
    await expect(confirm).toHaveCount(0);
    expect(callsOf(state, 'remove')).toHaveLength(0);

    await chips(page).getByRole('button', { name: 'Remove payslip-september.pdf' }).click();
    await chips(page).getByRole('button', { name: 'Remove file' }).click();
    const gone = thread(page).getByTestId('file-removed');
    await expect(gone).toHaveText('A file was attached here and has since been removed.');
    await expect(chips(page)).toHaveCount(0);
    await expect(thread(page)).not.toContainText('payslip-september.pdf');
    await expect(announcer(page)).toHaveText(
      'payslip-september.pdf was removed from this conversation.',
    );
    expect(callsOf(state, 'remove')).toEqual([
      { action: 'remove', fileId: 'f2000000-0000-4000-8000-000000000001' },
    ]);
    // The answers already given stay in the thread.
    await expect(thread(page)).toContainText('The payslip shows a net pay of 2,887.38.');
    await shot(page, 'files-removed');
  });

  test("a colleague's file is visible in a shared conversation, without a Remove button", async ({
    page,
  }) => {
    const theirs = attached({ uploaded_by: '99999999-9999-4999-8999-999999999999' });
    await openAssistant(page, { files: [theirs], messages: MESSAGES });
    await expect(chips(page).locator('.file__name')).toHaveText('payslip-september.pdf');
    await expect(chips(page).getByRole('button', { name: /Remove/ })).toHaveCount(0);
  });

  test('an administrator can remove a file someone else attached', async ({ page }) => {
    const theirs = attached({ uploaded_by: '99999999-9999-4999-8999-999999999999' });
    await openAssistant(page, { files: [theirs], messages: MESSAGES, admin: true });
    await expect(
      chips(page).getByRole('button', { name: 'Remove payslip-september.pdf' }),
    ).toBeVisible();
  });

  test('a file already removed, and one past its 30 days, are a line of text and not a file', async ({
    page,
  }) => {
    await openAssistant(page, {
      messages: MESSAGES,
      files: [
        attached({ id: 'f2000000-0000-4000-8000-000000000002', status: 'removed', name: null }),
        // Past its date and not yet swept by the nightly purge: still never shown as a file.
        attached({
          id: 'f2000000-0000-4000-8000-000000000003',
          name: 'old-statement.pdf',
          created_at: '2026-10-12T02:00:30Z',
          expires_at: new Date(Date.now() - 3_600_000).toISOString(),
        }),
      ],
    });
    const gone = thread(page).getByTestId('file-removed');
    await expect(gone).toHaveCount(2);
    await expect(gone.nth(0)).toHaveText('A file was attached here and has since been removed.');
    await expect(gone.nth(1)).toHaveText(
      'A file was attached here. It was removed automatically after 30 days.',
    );
    await expect(thread(page)).not.toContainText('old-statement.pdf');
    await expect(chips(page)).toHaveCount(0);
  });

  test('a file removed while a question about it is in flight: the answer still arrives, and the file is gone', async ({
    page,
  }) => {
    const state = await openAssistant(page, {
      files: [attached()],
      chatDelayMs: 1_500,
      chat: {
        respond: (_request, call) => ({
          sse: sseDone('The payslip shows a net pay of 2,887.38.', call),
        }),
      },
    });
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('What is the net pay?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(thread(page).locator('[data-role="user"]')).toHaveCount(1);
    // The question has left. Now take the file away.
    await chips(page).getByRole('button', { name: 'Remove payslip-september.pdf' }).click();
    await chips(page).getByRole('button', { name: 'Remove file' }).click();
    await expect(thread(page).getByTestId('file-removed')).toHaveCount(1);
    await expect(thread(page).locator('[data-role="assistant"]').last()).toContainText('2,887.38');
    await expect(thread(page).locator('[data-status="failed"]')).toHaveCount(0);
    expect(state.chatCalls).toHaveLength(1);
    expect(callsOf(state, 'remove')).toHaveLength(1);
  });

  test('a reply that stopped at the length limit says so under the reply', async ({ page }) => {
    await openAssistant(page, {
      files: [attached()],
      chat: {
        respond: (request, call) => ({
          status: 200,
          body: {
            conversationId: request.conversationId ?? CONV_ID,
            userMessageId: `u-${String(call)}`,
            assistantMessageId: `a-${String(call)}`,
            reply: '01/09 EFTPOS -12.10\n02/09 EFTPOS -13.20\n03/09 EFTPOS',
            model: 'claude-sonnet-5',
            stopReason: 'max_tokens',
            usage: { inputTokens: 1, outputTokens: 1024, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.02,
          },
        }),
      },
    });
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('List every transaction');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(thread(page).getByTestId('truncated')).toHaveText(
      'This reply was cut off at the length limit. Ask for the rest to see what is missing.',
    );
  });
});

test.describe('layout and accessibility', () => {
  test('a very long file name, in any script, does not break the layout', async ({ page }) => {
    const long = `${'statement-of-account-for-sample-person-'.repeat(6)}final-FINAL-v2.csv`;
    const rtl = 'كشف-حساب-הערות-明細書-выписка.csv';
    await openAssistant(page);
    await picker(page).setInputFiles([
      { name: long, mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n3,4\n5,6\n') },
      { name: rtl, mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') },
    ]);
    await expect(chips(page)).toHaveCount(2);
    const name = chips(page).first().locator('.file__name');
    // Cut by the server-side limit, then by the row: the full label is in the title.
    await expect(name).toHaveAttribute('title', /^statement-of-account.*…\.csv$/);
    const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped).toBe(true);
    await expect(chips(page).nth(1).locator('.file__name')).toHaveText(rtl);
    await expectNoHorizontalScroll(page);
    await shot(page, 'files-long-name');
  });

  test('no horizontal scroll, text inputs at 16px, and the picker is not a tab stop', async ({
    page,
  }) => {
    await openAssistant(page, {
      files: [
        {
          id: 'f2000000-0000-4000-8000-0000000000a1',
          conversation_id: CONV_ID,
          uploaded_by: USER_ID,
          name: 'rate-sheet-october.pdf',
          kind: 'pdf',
          byte_size: 49_795,
          page_count: 2,
          vision_pages: 0,
          status: 'ready',
          created_at: '2026-10-12T02:00:00Z',
          expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
        },
      ],
    });
    await picker(page).setInputFiles([
      fixture('password-protected.pdf'),
      fixture('scanned-statement.pdf'),
    ]);
    await expect(thread(page).getByTestId('upload-confirm')).toBeVisible();
    await expectNoHorizontalScroll(page);
    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea, select')).map((el) =>
        parseFloat(getComputedStyle(el).fontSize),
      ),
    );
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
    await expect(picker(page)).toHaveAttribute('tabindex', '-1');
    await expect(picker(page)).toHaveAttribute('aria-hidden', 'true');
    // The attach button does not cost the box you type in: at 768 the thread is the narrowest
    // it gets (288px, beside the list) and the button moves to its own line instead.
    const box = await page.getByPlaceholder('Ask for a post, an ad, a reply…').boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(160);
    // Every button in a file row is a full tap target.
    const heights = await thread(page)
      .locator('.file button')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(2);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    await shot(page, 'files-mixed-states');
  });

  test('reduced motion: the progress bar does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const state = await openAssistant(page, { filesDelayMs: 1_500 });
    await picker(page).setInputFiles(fixture('letter.docx'));
    await expect(uploads(page).getByRole('progressbar')).toBeVisible();
    const result = await page.evaluate(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let rule = false;
      for (const sheet of Array.from(document.styleSheets)) {
        for (const top of Array.from(sheet.cssRules)) {
          if (
            !(top instanceof CSSMediaRule) ||
            !top.conditionText.includes('prefers-reduced-motion')
          )
            continue;
          for (const inner of Array.from(top.cssRules)) {
            if (
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes('.file__bar') &&
              inner.style.transition.startsWith('none')
            ) {
              rule = true;
            }
          }
        }
      }
      const bar = document.querySelector('.file__bar');
      return { reduce, rule, animation: bar === null ? '' : getComputedStyle(bar).animationName };
    });
    expect(result).toEqual({ reduce: true, rule: true, animation: 'none' });
    state.filesDelayMs = 0;
    await expect(chips(page)).toHaveCount(1, { timeout: 15_000 });
  });
});

test.describe('the assistant panel', () => {
  test('a file can be attached from the panel beside the numbers, and is the same file on the page', async ({
    page,
  }) => {
    const state = await installMock(page, { conversations: [CONVERSATION] });
    await signIn(page, '/');
    await page.getByRole('button', { name: /Ask/ }).click();
    const panel = page.getByRole('complementary', { name: 'Assistant' });
    await expect(panel.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    await page.getByTestId('panel-composer-files').setInputFiles(fixture('payslip-text-layer.pdf'));
    const chip = page.getByTestId('panel-thread').getByTestId('file');
    await expect(chip).toHaveCount(1);
    await expect(chip.locator('.file__name')).toHaveText('payslip-text-layer.pdf');
    expect(actions(state)).toEqual(['begin', 'append', 'finish']);
    await expectNoHorizontalScroll(page);
    await shot(page, 'files-panel');

    await panel.getByRole('button', { name: 'Full page' }).click();
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page).locator('.file__name')).toHaveText('payslip-text-layer.pdf');
  });
});
