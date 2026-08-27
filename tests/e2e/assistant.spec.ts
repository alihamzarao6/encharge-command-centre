/**
 * Part C, in a real browser at three widths (see playwright.config.ts for the projects):
 *
 *   2. an unauthenticated visitor cannot reach the assistant or trigger a Claude call
 *   3. a deactivated user is refused and cannot send (banned at GoTrue; and the RLS case:
 *      a valid session whose app_users row is unreadable)
 *   5. cap reached (402) renders the plain-language message, not a code
 *   6. an empty model reply renders an error, never a blank bubble
 *   7. copy-to-clipboard works, including on the phone viewport
 *   8. the layout holds at 375 / 768 / 1280 with no horizontal scroll
 *
 * plus: wrong password and unknown email read identically; session persists across a
 * reload; a 401 mid-turn keeps the draft across login; network failure keeps the message
 * with Retry; second message carries the conversation id (item 4's server half is
 * tests/unit/llm/chat.test.ts). Screenshots land in docs/assets/stage-2/.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONV_ID,
  EMAIL,
  PASSWORD,
  installMock,
  seedStoredSession,
  signIn,
  sseDone,
} from './mock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/stage-2/', import.meta.url));
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

test.describe('login', () => {
  test('wrong password and unknown email read identically; layout holds', async ({ page }) => {
    await installMock(page, { account: 'wrong-password' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectInputsAtLeast16px(page);
    await expectNoHorizontalScroll(page);
    await shot(page, 'login');

    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('x');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const unknown = await page.getByRole('alert').textContent();

    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    const wrong = await page.getByRole('alert').textContent();

    expect(unknown).toBe('The email or password is incorrect.');
    expect(wrong).toBe(unknown);
  });

  test('item 2: an unauthenticated visitor sees login only and no Claude call is possible', async ({
    page,
  }) => {
    const state = await installMock(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByPlaceholder('Ask for a post, an ad, a reply…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    expect(state.chatCalls).toHaveLength(0);
    expect(state.anthropicCalls).toBe(0);
  });

  test('item 3a: a deactivated (banned) account is refused with a clear message', async ({
    page,
  }) => {
    const state = await installMock(page, { account: 'banned' });
    await signIn(page);
    await expect(page.getByRole('alert')).toHaveText(
      'This account has been deactivated. Contact your administrator.',
    );
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    expect(state.chatCalls).toHaveLength(0);
  });

  test('item 3b: a valid session with no readable app_users row is signed out, cannot send', async ({
    page,
  }) => {
    const state = await installMock(page, { account: 'deactivated' });
    await seedStoredSession(page);
    await page.goto('/');
    await expect(page.getByRole('status')).toHaveText(
      'This account has been deactivated. Contact your administrator.',
    );
    await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0);
    expect(state.signOuts).toBeGreaterThanOrEqual(1);
    expect(state.chatCalls).toHaveLength(0);
  });

  test('session persists across a reload', async ({ page }) => {
    await installMock(page);
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'What do you want to say?' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'What do you want to say?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
});

test.describe('assistant', () => {
  test('empty state, a turn, copy, second message carries the conversation; layout holds', async ({
    page,
  }, testInfo) => {
    const state = await installMock(page);
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'What do you want to say?' })).toBeVisible();
    await expectInputsAtLeast16px(page);
    await expectNoHorizontalScroll(page);
    await shot(page, 'empty');

    const composer = page.getByPlaceholder('Ask for a post, an ad, a reply…');
    await composer.fill('Write me a Facebook post about offset accounts');
    // What a turn feels like: his message must be on screen before any network answer —
    // measured as wall time from the tap to the user bubble (the progress bubble follows in
    // the same render; the mocked backend answers too fast to observe it separately).
    const tapped = Date.now();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('[data-role="user"]')).toHaveCount(1);
    const feedbackMs = Date.now() - tapped;
    testInfo.annotations.push({ type: 'tap-to-feedback-ms', description: String(feedbackMs) });
    process.stdout
      .write(`tap-to-feedback-ms=${String(feedbackMs)} width=${String(page.viewportSize()?.width ?? 0)}
`);
    expect(feedbackMs).toBeLessThan(1_000);
    const reply = page.locator('[data-role="assistant"]').first();
    await expect(reply).toContainText('Reply 1 to: Write me a Facebook post about offset accounts');
    expect(state.chatCalls[0]).toMatchObject({
      message: 'Write me a Facebook post about offset accounts',
    });
    expect(state.chatCalls[0]?.conversationId).toBeUndefined();
    expect(state.chatCalls[0]?.authorization).toMatch(/^Bearer /);

    // item 7: copy on the reply, at every viewport including 375.
    await reply.getByRole('button', { name: 'Copy reply' }).click();
    await expect(reply.getByRole('button', { name: 'Copy reply' })).toHaveText('✓ Copied');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe('Reply 1 to: Write me a Facebook post about offset accounts');

    // item 4 (client half): the second message names the conversation the first created.
    await composer.fill('Make it shorter');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('[data-role="assistant"]').nth(1)).toContainText('Reply 2');
    expect(state.chatCalls[1]).toMatchObject({
      message: 'Make it shorter',
      conversationId: CONV_ID,
    });
    expect(state.anthropicCalls).toBe(0);

    // The thread scrolls inside its own box; the page itself never grows.
    const pageScroll = await page.evaluate(() => ({
      docScroll: document.documentElement.scrollHeight,
      inner: window.innerHeight,
    }));
    expect(pageScroll.docScroll).toBeLessThanOrEqual(pageScroll.inner + 1);
    await expectNoHorizontalScroll(page);
    await shot(page, 'conversation');
    testInfo.annotations.push({ type: 'copied', description: clipboard });
  });

  test('item 5: cap reached renders plain words, not a code', async ({ page }) => {
    await installMock(page, {
      chat: {
        respond: () => ({
          status: 402,
          body: {
            error: {
              code: 'SPEND_CAP',
              message:
                'The monthly Claude spend cap has been reached. No request was sent. An admin can raise the cap in configuration.',
              retryable: false,
            },
          },
        }),
      },
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Write a post');
    await page.getByRole('button', { name: 'Send' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(
      'The monthly Claude budget for the assistant has been used up, so this message was not sent.',
    );
    const text = (await alert.textContent()) ?? '';
    expect(text).not.toMatch(/402|SPEND_CAP/);
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
    await expect(page.locator('[data-status="failed"]')).toContainText('Write a post');
    await expectNoHorizontalScroll(page);
    await shot(page, 'cap-reached');
  });

  test('item 6: an empty reply renders an error, never a blank bubble', async ({ page }) => {
    await installMock(page, {
      chat: {
        respond: (input, call) =>
          call === 1
            ? {
                status: 200,
                body: {
                  conversationId: CONV_ID,
                  userMessageId: 'u',
                  assistantMessageId: 'a',
                  reply: '   ',
                  model: 'claude-sonnet-5',
                  stopReason: 'max_tokens',
                  usage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  },
                  costUsd: 0.001,
                },
              }
            : {
                status: 502,
                body: {
                  error: {
                    code: 'EMPTY_REPLY',
                    message:
                      'The assistant returned an empty reply. Nothing was saved. Please try again.',
                    retryable: true,
                  },
                },
              },
      },
    });
    await signIn(page);
    const composer = page.getByPlaceholder('Ask for a post, an ad, a reply…');
    await composer.fill('First');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('alert')).toContainText('The assistant returned an empty reply.');
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);

    // Retry resends the same text; the server-side 502 EMPTY_REPLY reads the same way.
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert')).toContainText('The assistant returned an empty reply.');
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
    await expect(page.locator('[data-role="user"]')).toHaveCount(1);
    const bubbles = await page.locator('.bubble__content').allTextContents();
    for (const b of bubbles) expect(b.trim()).not.toBe('');
  });

  test('network failure keeps the message with Retry; retry succeeds', async ({ page }) => {
    let failNext = true;
    const state = await installMock(page, {
      chat: {
        respond: (input, call) => ({
          status: 200,
          body: {
            conversationId: CONV_ID,
            userMessageId: `u-${String(call)}`,
            assistantMessageId: `a-${String(call)}`,
            reply: `Reply to: ${input.message}`,
            model: 'claude-sonnet-5',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.001,
          },
        }),
      },
    });
    await page.route('**/functions/v1/chat', async (route) => {
      if (failNext) {
        failNext = false;
        await route.abort('connectionfailed');
      } else {
        await route.fallback();
      }
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Keep me');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('alert')).toContainText("Couldn't reach the assistant.");
    await expect(page.locator('[data-status="failed"]')).toContainText('Keep me');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('[data-role="assistant"]')).toContainText('Reply to: Keep me');
    expect(state.chatCalls.map((c) => c.message)).toEqual(['Keep me']);
  });

  test('a 401 mid-turn sends him to login and restores the message after sign-in', async ({
    page,
  }) => {
    let calls = 0;
    await installMock(page, {
      chat: {
        respond: (input) => {
          calls += 1;
          return calls === 1
            ? {
                status: 401,
                body: {
                  error: {
                    code: 'UNAUTHENTICATED',
                    message: 'Sign in to continue.',
                    retryable: false,
                  },
                },
              }
            : {
                status: 200,
                body: {
                  conversationId: CONV_ID,
                  userMessageId: 'u',
                  assistantMessageId: 'a',
                  reply: `Reply to: ${input.message}`,
                  model: 'claude-sonnet-5',
                  stopReason: 'end_turn',
                  usage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                  },
                  costUsd: 0.001,
                },
              };
        },
      },
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Do not lose this');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Your session has expired. Sign in again — your message has been kept.',
    );
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    const composer = page.getByPlaceholder('Ask for a post, an ad, a reply…');
    await expect(composer).toHaveValue('Do not lose this');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'Reply to: Do not lose this',
    );
  });

  test('conversation list: return to an earlier conversation, start a new one', async ({
    page,
  }) => {
    await installMock(page, {
      conversations: [
        { id: CONV_ID, title: 'Offset accounts post', last_active_at: '2026-08-25T02:00:00Z' },
      ],
      messages: {
        [CONV_ID]: [
          {
            id: 'm1',
            role: 'user',
            content: 'Write about offsets',
            created_at: '2026-08-25T01:00:00Z',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'Offsets, explained.',
            created_at: '2026-08-25T01:00:05Z',
          },
        ],
      },
    });
    await signIn(page);
    const width = page.viewportSize()?.width ?? 0;
    if (width < 768) {
      await page.getByRole('button', { name: 'Open conversations' }).click();
    }
    await page.getByRole('listitem').filter({ hasText: 'Offset accounts post' }).click();
    await expect(page.locator('[data-role="assistant"]')).toContainText('Offsets, explained.');
    await expect(page.locator('.thread-pane__title')).toHaveText('Offset accounts post');
    await page.getByRole('button', { name: '+ New', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What do you want to say?' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the not-yet sections are visible, labelled with their stage, and honest', async ({
    page,
  }) => {
    await installMock(page);
    await signIn(page);
    // Stage 3 part 3: Memory is live now, so the honest placeholders are Content and Ads.
    await page.getByRole('button', { name: /Memory/ }).click();
    await expect(page.getByRole('heading', { name: 'Memory' })).toBeVisible();
    await expect(page.getByText('not yet built')).toHaveCount(0);
    await page.getByRole('button', { name: /Content/ }).click();
    await expect(page.getByText('Stage 5 · not yet built')).toBeVisible();
    await page.getByRole('button', { name: /Ads/ }).click();
    await expect(page.getByText('Stage 5 · not yet built')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: /Assistant/ }).click();
    await expect(page.getByRole('heading', { name: 'What do you want to say?' })).toBeVisible();
  });
});

test.describe('streaming', () => {
  test('a streamed reply grows in place; Copy appears only once it is complete', async ({
    page,
  }) => {
    const reply = 'Banks knocked you back? Forty lenders say otherwise. Book a chat.';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await installMock(page, {
      chat: { respond: (_input, call) => ({ sse: sseDone(reply, call) }) },
    });
    // Hold the response until the test has looked at the streaming state.
    await page.route('**/functions/v1/chat', async (route) => {
      const text = sseDone(reply, 1)
        .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
        .join('');
      const [head, tail] = [
        text.slice(0, Math.floor(text.length / 2)),
        text.slice(Math.floor(text.length / 2)),
      ];
      // Playwright cannot chunk a fulfilled body over time, so the "partial" state is
      // proven by the unit suite; here the first-token-to-full ordering and the Copy gate
      // are proven by fulfilling once and observing the states the app passes through.
      await gate;
      await route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': 'text/event-stream; charset=utf-8',
        },
        body: `: open\n\n${head}${tail}`,
      });
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Write a post');
    await page.getByRole('button', { name: 'Send' }).click();
    // Before any byte: progress bubble, no reply bubble, no Copy on a reply.
    await expect(page.getByRole('status')).toContainText('Writing');
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
    release();
    const bubble = page.locator('[data-role="assistant"][data-status="saved"]');
    await expect(bubble).toContainText(reply);
    await expect(bubble.getByRole('button', { name: 'Copy reply' })).toBeVisible();
    await expect(page.locator('[data-status="streaming"]')).toHaveCount(0);
  });

  test('a stream that dies mid-reply shows the partial text with a clear failure, never a silent stop', async ({
    page,
  }) => {
    const reply = 'Here is the first half of a post that will be cut off before it finishes.';
    await installMock(page, {
      chat: { respond: (_input, call) => ({ sse: sseDone(reply, call), truncate: true }) },
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Write a post');
    await page.getByRole('button', { name: 'Send' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('The connection dropped part-way through the reply.');
    const partial = page.getByTestId('partial');
    await expect(partial).toContainText('Incomplete reply — not saved');
    const shown = (await partial.locator('.bubble__content').textContent()) ?? '';
    expect(shown.length).toBeGreaterThan(0);
    expect(reply.startsWith(shown)).toBe(true);
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy reply' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('a server error event after the stream started reads in plain words (cap message unchanged)', async ({
    page,
  }) => {
    await installMock(page, {
      chat: {
        respond: () => ({
          sse: [
            { event: 'start', data: { type: 'start', conversationId: CONV_ID } },
            { event: 'delta', data: { type: 'delta', text: 'A few words' } },
            {
              event: 'error',
              data: {
                type: 'error',
                status: 502,
                body: { error: { code: 'EMPTY_REPLY', message: 'Empty.', retryable: true } },
                partialText: '',
              },
            },
          ],
        }),
      },
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Write a post');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByRole('alert')).toContainText('The assistant returned an empty reply.');
    await expect(page.locator('[data-role="assistant"]')).toHaveCount(0);
  });

  test('Copy strips a trailing Note: line; the note is shown, set apart', async ({ page }) => {
    const reply =
      'Offset accounts, explained in one line.\n\nNote: confirm the rate with Ross before posting.';
    await installMock(page, {
      chat: { respond: (_input, call) => ({ sse: sseDone(reply, call) }) },
    });
    await signIn(page);
    await page.getByPlaceholder('Ask for a post, an ad, a reply…').fill('Write a post');
    await page.getByRole('button', { name: 'Send' }).click();
    const bubble = page.locator('[data-role="assistant"][data-status="saved"]');
    await expect(bubble.getByTestId('notes')).toContainText(
      'confirm the rate with Ross before posting.',
    );
    await bubble.getByRole('button', { name: 'Copy reply' }).click();
    await expect(bubble.getByRole('button', { name: 'Copy reply' })).toHaveText('✓ Copied');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe('Offset accounts, explained in one line.');
    expect(clipboard).not.toMatch(/Note:/);
  });
});
