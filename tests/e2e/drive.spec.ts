/**
 * Milestone 5 part 3a in a real browser at three widths (375 / 768 / 1280): connecting Google
 * Drive, saying how the connection stands, disconnecting, and a file from Drive in the thread —
 * shown, opened in Drive, and read again. The drive endpoint is scripted as the real one
 * behaves from the browser's side (tests/e2e/mock.ts); Google's consent screen is stood in for
 * by a redirect straight back, because a browser test cannot sign in to Google.
 *
 * The browser must never hold a Google credential: every test checks that nothing it sends or
 * stores carries a Google token shape.
 *
 * Part C, "the interface":
 *   - 375, 768, 1280, no horizontal page scroll;
 *   - the connect and disconnect states never ambiguous;
 *   - keyboard: every control reachable, the disconnect question focused;
 *   - a screen reader told what happened (the section's own live region; the upload announcer);
 *   - he cancels at Google; the return is stale; Google cannot be reached to disconnect;
 *   - a broken connection found by a read points at Settings.
 *
 * (Picking a file is the next step of this part, after the OnePick probe: it lands here then.)
 *
 * Screenshots land in docs/assets/milestone-5/.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONV_ID,
  USER_ID,
  installMock,
  signIn,
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

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    wide: Array.from(document.querySelectorAll('.settings *, .thread *, .nav *'))
      .filter(
        (el) => !el.classList.contains('sr-only') && !el.classList.contains('composer__picker'),
      )
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ')[0] ?? ''}`,
      )
      .slice(0, 8),
  }));
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.wide, JSON.stringify(metrics)).toEqual([]);
}

/** No Google credential in anything the browser sent, or in what it keeps. */
async function expectNoGoogleCredential(page: Page, state: MockState): Promise<void> {
  const sent = JSON.stringify(state.driveCalls) + JSON.stringify(state.fileCalls);
  const stored = await page.evaluate(() => {
    const dump = (store: Storage): string =>
      JSON.stringify(
        Array.from({ length: store.length }, (_, index) => {
          const key = store.key(index) ?? '';
          return [key, store.getItem(key)];
        }),
      );
    return dump(localStorage) + dump(sessionStorage);
  });
  // The app's own Supabase session is in storage by design; what must never be there is
  // anything of Google's — an access token, a refresh token, a client secret, an API key.
  for (const text of [sent, stored]) {
    expect(text).not.toMatch(/ya29\.|1\/\/0|GOCSPX-|AIza[0-9A-Za-z_-]{20}/);
  }
}

const section = (page: Page): Locator => page.getByTestId('drive-connection');
const headline = (page: Page): Locator => page.getByTestId('drive-headline');
const notice = (page: Page): Locator => page.getByTestId('drive-notice');

async function openSettings(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state = await installMock(page, options);
  await signIn(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByTestId('drive-loading')).toHaveCount(0);
  return state;
}

const CONNECTED = {
  state: 'connected' as const,
  email: 'broker@example.com',
  connectedAt: '2026-10-15T01:00:00Z',
  lastUsedAt: null,
  checked: true,
};

test.describe('the Drive section of Settings', () => {
  test('not connected: what connecting allows, and one button', async ({ page }) => {
    const state = await openSettings(page);
    await expect(headline(page)).toHaveText('Not connected');
    await expect(section(page)).toContainText(
      'This app can open only the files you pick, and nothing else in your Drive.',
    );
    await expect(section(page).getByRole('button')).toHaveText(['Connect Google Drive']);
    await expect(page.getByTestId('drive-state')).toHaveAttribute('data-state', 'not_connected');
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-not-connected');
    expect(state.driveCalls.map((call) => call.body['action'])).toEqual(['status']);
  });

  test('CONNECT: to Google and back, finished with his own session, and the address cleaned', async ({
    page,
  }) => {
    const state = await openSettings(page);
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(notice(page)).toHaveText('Google Drive is connected as broker@example.com.');
    await expect(headline(page)).toHaveText('Connected as broker@example.com');
    await expect(page.getByTestId('drive-state')).toHaveAttribute('data-state', 'connected');
    // The browser went to Google's own page, asking for drive.file and nothing else.
    expect(state.googleVisits).toHaveLength(1);
    expect(new URL(state.googleVisits[0] ?? '').searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/drive.file',
    );
    // Back on Settings, the attempt was finished with his signed-in session…
    const finish = state.driveCalls.find((call) => call.body['action'] === 'connect_finish');
    expect(finish?.authorization).toMatch(/^Bearer /);
    // …and nothing of the trip is left in the address bar.
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).pathname).toBe('/settings');
    await expectNoGoogleCredential(page, state);
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-connected');
  });

  test('he cancels at Google: said in words, and nothing is connected', async ({ page }) => {
    await openSettings(page, {
      drive: {
        finish: {
          outcome: 'cancelled',
          message: 'You cancelled at Google, so Drive was not connected. Nothing was changed.',
        },
      },
    });
    await page.getByRole('button', { name: 'Connect Google Drive' }).click();
    await expect(notice(page)).toHaveText(
      'You cancelled at Google, so Drive was not connected. Nothing was changed.',
    );
    await expect(headline(page)).toHaveText('Not connected');
    await expect(notice(page)).toHaveClass(/drive__notice--problem/);
  });

  test('a stale or replayed return changes nothing, says so, and is cleaned from the address', async ({
    page,
  }) => {
    const state = await installMock(page, { drive: { status: CONNECTED } });
    await signIn(page, '/settings?drive=stale');
    await expect(notice(page)).toHaveText(/expired or was already used, so nothing was changed/);
    await expect(headline(page)).toHaveText('Connected as broker@example.com');
    expect(new URL(page.url()).search).toBe('');
    expect(state.driveCalls.map((call) => call.body['action'])).not.toContain('connect_finish');
  });

  test('DISCONNECT: says what it does first, then Google is told, then it is gone', async ({
    page,
  }) => {
    const state = await openSettings(page, { drive: { status: CONNECTED } });
    await expect(headline(page)).toHaveText('Connected as broker@example.com');
    await page.getByRole('button', { name: 'Disconnect' }).click();
    const confirm = page.getByTestId('drive-confirm');
    await expect(confirm).toContainText(
      "Disconnecting tells Google to remove this app's access to your Drive.",
    );
    await expect(confirm).toContainText('stay until they are removed, or for 30 days');
    // The safe choice has the focus.
    await expect(page.getByRole('button', { name: 'Keep it connected' })).toBeFocused();
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-disconnect-confirm');
    await page.getByRole('button', { name: 'Disconnect Google Drive' }).click();
    await expect(notice(page)).toContainText("Google has removed this app's access");
    await expect(headline(page)).toHaveText('Not connected');
    expect(state.driveCalls.map((call) => call.body['action'])).toEqual([
      'status',
      'disconnect',
      'status',
    ]);
  });

  test('"Keep it connected" changes nothing', async ({ page }) => {
    const state = await openSettings(page, { drive: { status: CONNECTED } });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('button', { name: 'Keep it connected' }).click();
    await expect(page.getByTestId('drive-confirm')).toHaveCount(0);
    await expect(headline(page)).toHaveText('Connected as broker@example.com');
    expect(state.driveCalls.map((call) => call.body['action'])).toEqual(['status']);
  });

  test('Google unreachable when disconnecting: he is told it is STILL connected', async ({
    page,
  }) => {
    await openSettings(page, { drive: { status: CONNECTED, disconnectFails: true } });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.getByRole('button', { name: 'Disconnect Google Drive' }).click();
    await expect(notice(page)).toContainText('so Drive is still connected');
    await expect(headline(page)).toHaveText('Connected as broker@example.com');
  });

  test('BROKEN: not working, why, when, and the way back — never a quiet "connected"', async ({
    page,
  }) => {
    await openSettings(page, {
      drive: {
        status: {
          state: 'broken',
          email: 'broker@example.com',
          brokenAt: '2026-10-15T01:00:00Z',
          reason: 'grant_revoked',
          message:
            "Google stopped accepting this app's access. It may have been removed in your Google account, ended by your administrator, or not used for six months.",
        },
      },
    });
    await expect(headline(page)).toHaveText('Not working — broker@example.com');
    await expect(section(page)).toContainText('may have been removed in your Google account');
    await expect(section(page).getByRole('button')).toHaveText(['Connect again', 'Disconnect']);
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-broken');
  });

  test('connected, but Google could not confirm it just now: says so', async ({ page }) => {
    await openSettings(page, { drive: { status: { ...CONNECTED, checked: false } } });
    await expect(section(page)).toContainText(
      'Google could not be reached just now to confirm it still works',
    );
  });

  test('not set up on this Command Centre: said, with no button to press', async ({ page }) => {
    await openSettings(page, { drive: { status: { state: 'unavailable' } } });
    await expect(headline(page)).toHaveText(
      'Google Drive is not set up on this Command Centre yet',
    );
    await expect(section(page).getByRole('button')).toHaveCount(0);
  });

  test('by keyboard: Settings is in the navigation, and Connect is reached and pressed with Enter', async ({
    page,
  }) => {
    const state = await installMock(page);
    await signIn(page, '/');
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await nav.getByRole('button', { name: /Settings/ }).click();
    await expect(page).toHaveURL(/\/settings$/);
    const connect = page.getByRole('button', { name: 'Connect Google Drive' });
    await connect.focus();
    await expect(connect).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(headline(page)).toHaveText('Connected as broker@example.com');
    expect(state.googleVisits).toHaveLength(1);
  });
});

const DRIVE_TEXT = 'Two year fixed 5.79% p.a. Three year fixed 5.89% p.a.';
/** A fresh row each time: the scripted server changes the rows it is given (a read again replaces one). */
const driveFileRow = (): ScriptedFile => ({
  id: 'f2000000-0000-4000-8000-000000000001',
  conversation_id: CONV_ID,
  uploaded_by: USER_ID,
  name: 'Rate sheet',
  kind: 'text',
  byte_size: 2048,
  page_count: 1,
  vision_pages: 0,
  status: 'ready',
  created_at: '2026-10-16T01:00:00Z',
  expires_at: '2099-01-01T00:00:00Z',
  source_url: 'https://drive.google.com/file/d/DriveTextFile01/view',
  source_host: 'drive.google.com',
  fetched_at: '2026-10-16T01:00:00Z',
  drive_file_id: 'DriveTextFile01',
});

const CONVERSATION = {
  id: CONV_ID,
  title: 'Sample Person refinance',
  last_active_at: '2026-10-16T01:00:00Z',
};

async function openConversation(page: Page, options: MockOptions): Promise<MockState> {
  const state = await installMock(page, { conversations: [CONVERSATION], ...options });
  await signIn(page, '/assistant');
  await expect(page.getByRole('button', { name: '+ New', exact: true })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open conversations' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('listitem').filter({ hasText: 'Sample Person refinance' }).click();
  return state;
}

const thread = (page: Page): Locator => page.getByTestId('thread');

test.describe('a file from Google Drive in the thread', () => {
  test('says it came from Drive and when it was read, and opens in Drive', async ({ page }) => {
    await openConversation(page, { files: [driveFileRow()], drive: { status: CONNECTED } });
    const chip = thread(page).locator('[data-testid="file"][data-source="drive"]');
    await expect(chip).toHaveAttribute('aria-label', 'File from Google Drive Rate sheet');
    await expect(chip).toContainText(
      /from Google Drive, read \d{1,2} Oct at|from Google Drive, read (today|yesterday) at/,
    );
    const open = chip.getByRole('link', { name: 'Open in Google Drive' });
    await expect(open).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/DriveTextFile01/view',
    );
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', /noopener/);
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-file-in-thread');
  });

  test('READ AGAIN FROM DRIVE: read afresh through our server, attached, and the older copy replaced', async ({
    page,
  }) => {
    const state = await openConversation(page, {
      files: [driveFileRow()],
      drive: {
        status: CONNECTED,
        files: {
          DriveTextFile01: {
            name: 'Rate sheet (Oct)',
            body: DRIVE_TEXT,
            fileName: 'Rate sheet (Oct).txt',
          },
        },
      },
    });
    await thread(page).getByTestId('drive-read-again').click();
    await expect(page.getByTestId('upload-announcer')).toHaveText(
      'Rate sheet (Oct) attached from Google Drive: 1 part. It replaces the earlier read of this file.',
    );
    const chips = thread(page).locator('[data-testid="file"][data-source="drive"]');
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText('Rate sheet (Oct)');
    await expect(thread(page).getByTestId('file-removed')).toHaveText(
      'A file was read here and has been read again since. This earlier copy was removed.',
    );
    // The read went to OUR server, and begin was held to its record.
    const read = state.driveCalls.find((call) => call.body['action'] === 'read_file');
    expect(read?.body).toMatchObject({ fileId: 'DriveTextFile01' });
    const begin = state.fileCalls.find((call) => call.body['action'] === 'begin');
    expect(begin?.body['driveReadId']).toBe(read?.body['requestId']);
    // What was sent to be kept is the text this browser read, not the file.
    const appended = state.fileCalls.filter((call) => call.body['action'] === 'append');
    expect(JSON.stringify(appended)).toContain('Two year fixed 5.79% p.a.');
    await expectNoGoogleCredential(page, state);
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-read-again');
  });

  test("a colleague's Drive file can be opened in Drive, but is not read again from his", async ({
    page,
  }) => {
    await openConversation(page, {
      files: [{ ...driveFileRow(), uploaded_by: '99999999-9999-4999-8999-999999999999' }],
      drive: { status: CONNECTED },
    });
    const chip = thread(page).locator('[data-testid="file"][data-source="drive"]');
    await expect(chip.getByRole('link', { name: 'Open in Google Drive' })).toBeVisible();
    await expect(chip.getByTestId('drive-read-again')).toHaveCount(0);
  });

  test('A BROKEN CONNECTION found by a read: said in the thread and to a screen reader, pointing at Settings', async ({
    page,
  }) => {
    await openConversation(page, {
      files: [driveFileRow()],
      drive: {
        status: {
          state: 'broken',
          email: 'broker@example.com',
          brokenAt: '2026-10-15T01:00:00Z',
          reason: 'grant_revoked',
          message: 'x',
        },
      },
    });
    await thread(page).getByTestId('drive-read-again').click();
    const problem = thread(page).getByTestId('upload-problem');
    await expect(problem).toContainText('Google Drive is no longer connected');
    await expect(page.getByTestId('upload-announcer')).toContainText('no longer connected');
    // No "Try again" — it cannot help — and the way out instead.
    await expect(problem.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    const reconnect = problem.getByRole('link', { name: 'Connect Google Drive in Settings' });
    await expectNoHorizontalScroll(page);
    await shot(page, 'drive-broken-in-thread');
    await reconnect.click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(headline(page)).toHaveText('Not working — broker@example.com');
  });

  test('a file Drive refuses is refused in words, and the reason announced', async ({ page }) => {
    await openConversation(page, {
      files: [driveFileRow()],
      drive: {
        status: CONNECTED,
        files: {
          DriveTextFile01: {
            refused: 'drive_in_bin',
            message:
              'That file is in your Google Drive bin. Restore it in Drive, then pick it again.',
          },
        },
      },
    });
    await thread(page).getByTestId('drive-read-again').click();
    await expect(thread(page).getByTestId('upload-problem')).toContainText(
      'in your Google Drive bin',
    );
    await expect(page.getByTestId('upload-announcer')).toContainText('in your Google Drive bin');
  });

  test('a slow Google: the wait is said while it lasts, and Send waits for it', async ({
    page,
  }) => {
    await openConversation(page, {
      files: [driveFileRow()],
      drive: {
        status: CONNECTED,
        files: { DriveTextFile01: { name: 'Rate sheet', body: DRIVE_TEXT, delayMs: 2_500 } },
      },
    });
    await thread(page).getByTestId('drive-read-again').click();
    await expect(thread(page).getByTestId('upload')).toContainText('Getting it from Google Drive…');
    await expect(page.getByTestId('send-blocked')).toHaveText(
      'Wait for Rate sheet to come in from Google Drive before you send.',
    );
    await expect(page.getByTestId('upload-announcer')).toContainText('attached from Google Drive', {
      timeout: 15_000,
    });
  });
});
