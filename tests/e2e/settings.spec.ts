/**
 * Milestone 5 part 4 in a real browser at three widths (375 / 768 / 1280): the settings page —
 * what the assistant has learned and forgetting it, the connections slot, connector keys shown
 * once, spending and the activity record. The settings backend is scripted as the real one
 * behaves from the browser's side (tests/e2e/settingsMock.ts).
 *
 * Part C, "the page" and "the interface":
 *   - three empty states that say what to do; long and non-Latin names; hundreds of rows, paged;
 *   - a person who may see less (not an administrator) sees what is theirs to act on;
 *   - the database unavailable while the page is open;
 *   - no horizontal page scroll; inputs at 16px or larger; every destructive control reachable
 *     and confirmable by keyboard; the confirmation and the result spoken; reduced motion.
 *
 * Screenshots land in docs/assets/milestone-5/settings-*.png — one per section, per width.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  USER_ID,
  installMock,
  signIn,
  type MockOptions,
  type MockState,
  type ScriptedStaff,
} from './mock.js';
import type { ScriptedAudit, ScriptedConnectorKey, ScriptedLearnedSource } from './settingsMock.js';

const SHOTS = fileURLToPath(new URL('../../docs/assets/milestone-5/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

const COLLEAGUE = '22222222-2222-4222-8222-222222222222';

function width(page: Page): string {
  return String(page.viewportSize()?.width ?? 0);
}

/**
 * One section's picture. A section taller than the screen is photographed as the screen with
 * that section scrolled to the top — an element shot of it inside the page's own scrolling box
 * comes out cut off, with the tab bar over it.
 */
async function shotOf(locator: Locator, page: Page, name: string): Promise<Buffer> {
  const path = `${SHOTS}settings-${name}-${width(page)}.png`;
  const box = await locator.boundingBox();
  const height = page.viewportSize()?.height ?? 0;
  if (box !== null && box.height > height * 0.75) {
    await locator.evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
    });
    return page.screenshot({ path });
  }
  return locator.screenshot({ path });
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    wide: Array.from(document.querySelectorAll('.settings *'))
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').split(' ')[0] ?? ''}`,
      )
      .slice(0, 8),
  }));
  expect(metrics.scrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.wide, JSON.stringify(metrics)).toEqual([]);
}

let counter = 0;
function learned(over: Partial<ScriptedLearnedSource> = {}): ScriptedLearnedSource {
  counter += 1;
  const n = String(counter).padStart(4, '0');
  return {
    id: `00000000-0000-4000-8000-00000000${n}`,
    name: `Document ${n}.pdf`,
    kind: 'pdf',
    source_host: null,
    source_url: null,
    content_hash: n.padEnd(64, 'a'),
    uploaded_by: USER_ID,
    learned_at: `2026-10-${String(1 + (counter % 16)).padStart(2, '0')}T0${String(counter % 9)}:00:00Z`,
    page_count: 4,
    chunk_count: 6,
    embedded_count: 6,
    status: 'ready',
    failure: null,
    ...over,
  };
}

const RATE_SHEET = learned({
  id: '11111111-0000-4000-8000-000000000001',
  name: 'Lender rate sheet — October 2026.pdf',
  learned_at: '2026-10-17T02:15:00Z',
  page_count: 12,
});
const WEB_PAGE = learned({
  id: '11111111-0000-4000-8000-000000000002',
  name: 'Home loan rates | Example Bank',
  kind: 'html',
  source_host: 'www.examplebank.com.au',
  source_url: 'https://www.examplebank.com.au/home-loans/rates',
  learned_at: '2026-10-16T23:40:00Z',
  page_count: 1,
});
const STILL_LEARNING = learned({
  id: '11111111-0000-4000-8000-000000000003',
  name: 'Coaching transcript week 3.pdf',
  learned_at: '2026-10-16T21:00:00Z',
  status: 'learning',
  page_count: 33,
  chunk_count: 80,
  embedded_count: 20,
});
const NEVER_LEARNED = learned({
  id: '11111111-0000-4000-8000-000000000004',
  name: 'Scanned blank.pdf',
  learned_at: '2026-10-16T20:00:00Z',
  status: 'failed',
  failure: 'no_text',
  chunk_count: 0,
  embedded_count: 0,
});
const HIS = learned({
  id: '11111111-0000-4000-8000-000000000005',
  name: 'Ross — broker notes.docx',
  kind: 'docx',
  uploaded_by: COLLEAGUE,
  learned_at: '2026-10-16T19:00:00Z',
});
const LONG_NAME = learned({
  id: '11111111-0000-4000-8000-000000000006',
  name: `${'Refinance_application_checklist_'.repeat(5)}FINAL_v12.pdf`.slice(0, 200),
  learned_at: '2026-10-16T18:00:00Z',
});
const NON_LATIN = learned({
  id: '11111111-0000-4000-8000-000000000007',
  name: 'نرخ‌نامه وام مسکن — مهر ۱۴۰۵.pdf',
  learned_at: '2026-10-16T17:00:00Z',
});
const PURGED = learned({
  id: '11111111-0000-4000-8000-000000000008',
  name: 'September rate sheet.pdf',
  // Read 45 days ago: its file was purged at 30; what was learned is still here, and forgettable.
  learned_at: '2026-09-02T02:00:00Z',
});

const DOCUMENTS = [
  RATE_SHEET,
  WEB_PAGE,
  STILL_LEARNING,
  NEVER_LEARNED,
  HIS,
  LONG_NAME,
  NON_LATIN,
  PURGED,
];

const ROSTER: ScriptedStaff[] = [
  {
    user_id: COLLEAGUE,
    email: 'rossb@fundd.com.au',
    role: 'staff',
    is_active: true,
    is_admin: true,
    created_at: '2026-08-01T00:00:00Z',
  },
];

function key(over: Partial<ScriptedConnectorKey> = {}): ScriptedConnectorKey {
  counter += 1;
  return {
    id: `key-${String(counter)}`,
    key_id:
      `abcdefghjk${String.fromCharCode(97 + (counter % 20))}${String.fromCharCode(98 + (counter % 20))}`.replace(
        /[ilo]/g,
        'm',
      ),
    user_id: USER_ID,
    label: 'Claude on my laptop',
    created_at: '2026-10-15T01:00:00Z',
    last_used_at: '2026-10-17T03:00:00Z',
    revoked_at: null,
    ...over,
  };
}

function audit(i: number, over: Partial<ScriptedAudit> = {}): ScriptedAudit {
  return {
    id: `a${String(i).padStart(5, '0')}`,
    actor: i % 2 === 0 ? USER_ID : COLLEAGUE,
    action: 'FILE_ATTACHED',
    entity_type: 'conversation_files',
    entity_id: null,
    created_at: new Date(Date.parse('2026-10-17T05:00:00Z') - i * 60_000).toISOString(),
    file_kind: 'pdf',
    file_source: 'upload',
    ...over,
  };
}

async function open(page: Page, options: MockOptions = {}): Promise<MockState> {
  const state = await installMock(page, { roster: ROSTER, ...options });
  await signIn(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByTestId('settings-documents').getByText('Loading…')).toHaveCount(0);
  await expect(page.getByTestId('settings-keys').getByText('Loading…')).toHaveCount(0);
  await expect(page.getByTestId('settings-activity').getByText('Loading…')).toHaveCount(0);
  return state;
}

const docs = (page: Page): Locator => page.getByTestId('settings-documents');
const keys = (page: Page): Locator => page.getByTestId('settings-keys');
const activity = (page: Page): Locator => page.getByTestId('settings-activity');
const spending = (page: Page): Locator => page.getByTestId('settings-spending');
const row = (page: Page, name: string): Locator =>
  page.getByTestId('learned-document').filter({ hasText: name });

test.describe('the settings page', () => {
  test('nothing yet: three empty states that say what to do, the slot, and a calm spend', async ({
    page,
  }) => {
    await open(page);
    await expect(page.getByTestId('documents-empty')).toHaveText(
      'Nothing learned yet. Attach a file or paste a link in the Assistant, and once it has been read it is learned and listed here — where you can also make it forget.',
    );
    await expect(page.getByTestId('keys-empty')).toContainText('No connector keys yet. Make one');
    await expect(page.getByTestId('activity-empty')).toContainText('Nothing recorded yet.');
    // The connections slot: its heading, its one line, and part 3a's Drive card inside it.
    const slot = page.getByTestId('settings-connections');
    await expect(slot.getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();
    await expect(slot.getByTestId('drive-connection')).toBeVisible();
    await expect(spending(page).getByTestId('spend-line')).toHaveCount(2);
    await expect(spending(page)).toContainText('$0.43 of $5.00 — $4.57 left.');
    // The sections, in order, as the jump list names them.
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link'),
    ).toHaveText(['What it has learned', 'Connections', 'Connector keys', 'Spending', 'Activity']);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `${SHOTS}settings-page-empty-${width(page)}.png` });
    await shotOf(docs(page), page, 'documents-empty');
    await shotOf(keys(page), page, 'keys-empty');
    await shotOf(activity(page), page, 'activity-empty');
    await shotOf(spending(page), page, 'spending');
    await shotOf(page.getByTestId('settings-connections'), page, 'connections-slot');
  });

  test('the list: name, kind, when, who, pages and state — newest first — and forget only where it is theirs', async ({
    page,
  }) => {
    const state = await open(page, { settings: { sources: DOCUMENTS } });
    await expect(page.getByTestId('learned-document').locator('.learned__name')).toHaveText(
      DOCUMENTS.map((d) => d.name ?? ''),
    );
    await expect(row(page, RATE_SHEET.name ?? '')).toContainText(
      /PDF · added .* by you · 12 pages/,
    );
    await expect(row(page, RATE_SHEET.name ?? '')).toContainText('Learned');
    await expect(row(page, WEB_PAGE.name ?? '')).toContainText(
      'Web page from www.examplebank.com.au',
    );
    await expect(row(page, STILL_LEARNING.name ?? '')).toContainText(
      'Still being learned (25% done)',
    );
    await expect(row(page, NEVER_LEARNED.name ?? '')).toContainText(
      "Couldn't be learned: nothing in it could be read",
    );
    // His document: listed (knowledge is the account's), named as his, and not hers to forget.
    const his = row(page, HIS.name ?? '');
    await expect(his).toContainText('by rossb@fundd.com.au');
    await expect(his.getByRole('button')).toHaveCount(0);
    await expect(his).toContainText(
      'Only the person who added this document, or an administrator, can forget it.',
    );
    // Every one of her own has a Forget button, named for the document it forgets.
    await expect(
      page.getByRole('button', { name: `Forget ${RATE_SHEET.name ?? ''}` }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Forget / })).toHaveCount(DOCUMENTS.length - 1);
    // The long name and the non-Latin one wrap inside the column, right-to-left kept.
    await expect(row(page, NON_LATIN.name ?? '').locator('.learned__name')).toHaveAttribute(
      'dir',
      'auto',
    );
    await expectNoHorizontalScroll(page);
    await shotOf(docs(page), page, 'documents');
    expect(JSON.stringify(state.settings.calls)).not.toContain('forget_document');
  });

  test('FORGET, by keyboard: asked once in plain words, Escape keeps it, then it goes and is said', async ({
    page,
  }) => {
    const state = await open(page, { settings: { sources: DOCUMENTS } });
    const button = page.getByRole('button', { name: `Forget ${RATE_SHEET.name ?? ''}` });
    await button.focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByTestId('forget-confirm');
    await expect(confirm).toHaveAttribute('role', 'alert');
    await expect(confirm).toContainText(
      `Forget “${RATE_SHEET.name ?? ''}”? The assistant stops using it straight away, everywhere`,
    );
    await expect(confirm).toContainText("This can't be undone.");
    // The safe choice has focus; Escape keeps it and returns to the row.
    await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await shotOf(row(page, RATE_SHEET.name ?? ''), page, 'forget-confirm');
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(state.settings.calls).toEqual([{ action: 'spend' }]);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Forget it' })).toBeFocused();
    await page.keyboard.press('Enter');
    const notice = page.getByTestId('documents-notice');
    await expect(notice).toHaveText(
      `Forgotten: “${RATE_SHEET.name ?? ''}”. The assistant can no longer use it. Its text was removed from 1 conversation.`,
    );
    // Spoken from the section's own polite live region, which also takes focus.
    await expect(notice.locator('..')).toHaveAttribute('aria-live', 'polite');
    await expect(notice.locator('..')).toBeFocused();
    await expect(row(page, RATE_SHEET.name ?? '')).toHaveCount(0);
    expect(state.settings.calls.at(-1)).toEqual({
      action: 'forget_document',
      sourceId: RATE_SHEET.id,
    });
    await shotOf(docs(page), page, 'forget-done');
  });

  test('forgetting one still being learned, one never learned, and one whose file was purged', async ({
    page,
  }) => {
    const state = await open(page, { settings: { sources: DOCUMENTS } });
    for (const doc of [STILL_LEARNING, NEVER_LEARNED, PURGED]) {
      await page.getByRole('button', { name: `Forget ${doc.name ?? ''}` }).click();
      if (doc === STILL_LEARNING) {
        await expect(page.getByTestId('forget-confirm')).toContainText(
          'It is still being learned. Learning stops',
        );
      }
      await page.getByRole('button', { name: 'Forget it' }).click();
      await expect(page.getByTestId('documents-notice')).toContainText(
        `Forgotten: “${doc.name ?? ''}”`,
      );
      await expect(row(page, doc.name ?? '')).toHaveCount(0);
    }
    expect(
      state.settings.sources
        .filter((s) => s.status === 'forgotten')
        .map((s) => s.id)
        .sort(),
    ).toEqual([STILL_LEARNING.id, NEVER_LEARNED.id, PURGED.id].sort());
  });

  test('the same document forgotten in another tab first: told it had already gone, and the list catches up', async ({
    page,
  }) => {
    const state = await open(page, { settings: { sources: DOCUMENTS } });
    await page.getByRole('button', { name: `Forget ${WEB_PAGE.name ?? ''}` }).click();
    // The other tab's forget lands while this one is asking.
    const other = state.settings.sources.find((s) => s.id === WEB_PAGE.id);
    if (other !== undefined) other.status = 'forgotten';
    await page.getByRole('button', { name: 'Forget it' }).click();
    await expect(page.getByTestId('documents-notice')).toHaveText(
      `“${WEB_PAGE.name ?? ''}” had already been forgotten.`,
    );
    await expect(row(page, WEB_PAGE.name ?? '')).toHaveCount(0);
  });

  test('a copy someone else added appears after the page loaded: the server refuses, in words', async ({
    page,
  }) => {
    const state = await open(page, { settings: { sources: DOCUMENTS } });
    state.settings.sources.push(
      learned({ uploaded_by: COLLEAGUE, content_hash: LONG_NAME.content_hash }),
    );
    await page.getByRole('button', { name: `Forget ${LONG_NAME.name ?? ''}` }).click();
    await page.getByRole('button', { name: 'Forget it' }).click();
    await expect(page.getByTestId('documents-notice')).toHaveText(
      'Only an administrator can forget this one: someone else added it, or a copy of it.',
    );
    await expect(row(page, LONG_NAME.name ?? '')).toHaveCount(1);
  });

  test('an administrator may forget anything, including a colleague’s, and every copy says so', async ({
    page,
  }) => {
    const copy = learned({
      uploaded_by: COLLEAGUE,
      content_hash: HIS.content_hash,
      name: HIS.name,
    });
    await open(page, { admin: true, settings: { sources: [...DOCUMENTS, copy] } });
    await page
      .getByRole('button', { name: `Forget ${HIS.name ?? ''}` })
      .first()
      .click();
    await expect(page.getByTestId('forget-confirm')).toContainText(
      'It was added 2 times. Every copy is forgotten together.',
    );
    await page.getByRole('button', { name: 'Forget it' }).click();
    await expect(row(page, HIS.name ?? '')).toHaveCount(0);
  });

  test('hundreds of documents: 25 to a page, newer and older, the total said', async ({ page }) => {
    const many = Array.from({ length: 260 }, (_, i) =>
      learned({
        learned_at: new Date(Date.parse('2026-10-17T05:00:00Z') - i * 3_600_000).toISOString(),
      }),
    );
    await open(page, { settings: { sources: many } });
    await expect(page.getByTestId('learned-document')).toHaveCount(25);
    const pager = page.getByRole('navigation', { name: 'Learned documents: pages' });
    await expect(pager).toContainText('Showing 1–25 of 260');
    await pager.getByRole('button', { name: 'Older →' }).click();
    await expect(pager).toContainText('Showing 26–50 of 260');
    await expect(page.getByTestId('learned-document').first()).toContainText(many[25]?.name ?? '');
    await expectNoHorizontalScroll(page);
    await shotOf(pager, page, 'documents-pager');
  });

  test('KEYS: made, shown once, copied — and after Done or a refresh it is nowhere', async ({
    page,
  }) => {
    const state = await open(page, { settings: { keys: [key({ label: 'Old desktop' })] } });
    const input = page.getByLabel('Name for a new key');
    // 16px or larger: a phone must not zoom into it.
    expect(
      Number.parseFloat(await input.evaluate((el) => getComputedStyle(el).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    await input.fill('Claude on my phone');
    await page.keyboard.press('Enter');
    const reveal = page.getByTestId('key-reveal');
    await expect(
      reveal.getByRole('heading', { name: 'Your new key: “Claude on my phone”' }),
    ).toBeFocused();
    const minted = state.settings.minted[0] ?? '';
    expect(minted).toMatch(/^fcc_[a-hjkmnp-z2-9]{12}_[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId('key-value')).toHaveText(minted);
    await expect(reveal).toContainText('This is the only time it is shown');
    await shotOf(reveal, page, 'key-shown-once');
    await reveal.getByRole('button', { name: 'Copy key' }).click();
    await expect(reveal).toContainText('Copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(minted);
    // A second key while one exists is simply a second key.
    await expect(page.getByTestId('connector-key')).toHaveCount(2);

    await reveal.getByRole('button', { name: 'Done — I have copied it' }).click();
    await expect(page.getByTestId('key-reveal')).toHaveCount(0);
    expect(await page.content()).not.toContain(minted);
    await shotOf(keys(page), page, 'keys');

    await page.reload();
    await expect(page.getByTestId('connector-key')).toHaveCount(2);
    const everywhere = await page.evaluate(() => {
      const dump = (store: Storage): string =>
        JSON.stringify(
          Array.from({ length: store.length }, (_, i) => [
            store.key(i),
            store.getItem(store.key(i) ?? ''),
          ]),
        );
      return `${document.documentElement.outerHTML}${dump(localStorage)}${dump(sessionStorage)}${location.href}`;
    });
    expect(everywhere).not.toContain(minted);
    expect(everywhere).not.toContain(minted.slice(minted.lastIndexOf('_') + 1));
  });

  test('SWITCH OFF, by keyboard; switching off one already off says so; at five the form says why', async ({
    page,
  }) => {
    const live = [1, 2, 3, 4, 5].map((n) => key({ label: `Key ${String(n)}` }));
    const state = await open(page, { settings: { keys: live } });
    await expect(page.getByLabel('Name for a new key')).toBeDisabled();
    await expect(keys(page)).toContainText(
      'You have 5 keys switched on, the most one person may have.',
    );
    const target = page.getByRole('button', { name: 'Switch off Key 3' });
    await target.focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByTestId('revoke-confirm');
    await expect(confirm).toHaveAttribute('role', 'alert');
    await expect(confirm).toContainText(
      'Anything using this key is refused from its very next request.',
    );
    await expect(page.getByRole('button', { name: 'Keep it on' })).toBeFocused();
    await shotOf(confirm, page, 'revoke-confirm');
    await page.keyboard.press('Escape');
    await expect(target).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('keys-notice')).toHaveText(
      'Switched off: “Key 3”. Anything using it is refused from now on.',
    );
    await expect(page.getByTestId('connector-key').filter({ hasText: 'Key 3' })).toHaveAttribute(
      'data-state',
      'off',
    );
    await expect(page.getByLabel('Name for a new key')).toBeEnabled();

    // Already switched off elsewhere (the terminal, another tab) before this press landed.
    const four = state.settings.keys.find((k) => k.label === 'Key 4');
    await page.getByRole('button', { name: 'Switch off Key 4' }).click();
    if (four !== undefined) four.revoked_at = '2026-10-17T05:00:00Z';
    await page.getByRole('button', { name: 'Switch it off' }).click();
    await expect(page.getByTestId('keys-notice')).toHaveText('“Key 4” was already switched off.');
  });

  test('a person who may see less: a colleague’s key is never listed, and is not theirs to switch off', async ({
    page,
  }) => {
    const state = await open(page, {
      settings: {
        keys: [key({ label: 'Mine' }), key({ label: 'Ross’s tablet', user_id: COLLEAGUE })],
      },
    });
    await expect(page.getByTestId('connector-key')).toHaveText([/Mine/]);
    expect(await page.content()).not.toContain('Ross’s tablet');
    const theirs = state.settings.keys.find((k) => k.user_id === COLLEAGUE);
    // Even asked directly, the endpoint answers "not yours, or gone".
    const answer = await page.evaluate(async (keyId) => {
      const response = await fetch('https://stack.e2e.invalid/functions/v1/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'revoke_key', keyId }),
      });
      return response.status;
    }, theirs?.key_id ?? '');
    expect(answer).toBe(404);
    expect(theirs?.revoked_at).toBeNull();
  });

  test('spending near and over the cap is said in words, not only colour', async ({ page }) => {
    await open(page, { settings: { spend: { todayUsd: 5, monthUsd: 70 } } });
    await expect(spending(page).getByTestId('spend-line')).toHaveText([
      /Today\$5\.00 of \$5\.00 — the cap is reached; the assistant refuses anything more until it resets\./,
      /This month\$70\.00 of \$80\.00 — \$10\.00 left\./,
    ]);
    await expect(spending(page)).toContainText('8:00 am to 8:00 am in Perth');
    await expect(spending(page).getByRole('button')).toHaveCount(0);
    await shotOf(spending(page), page, 'spending-over');
  });

  test('activity: who did what, newest first, hundreds of rows paged', async ({ page }) => {
    const rows = Array.from({ length: 240 }, (_, i) => audit(i));
    rows[0] = audit(0, {
      action: 'LEAD_STAGE_MOVED',
      entity_type: 'ghl_writes',
      opportunity: 'unknown-opportunity',
      from_stage: 'unknown-stage',
      to_stage: 'unknown-stage',
      file_kind: null,
      file_source: null,
    });
    rows[1] = audit(1, {
      action: 'CONNECTOR_KEY_ISSUED',
      entity_type: 'connector_keys',
      connector: 'abcdefghjkmn',
    });
    rows.push(audit(999, { action: 'UPDATE', entity_type: 'memory_facts' }));
    await open(page, { settings: { activity: rows } });
    const list = page.getByTestId('activity-row');
    await expect(list).toHaveCount(25);
    await expect(list.nth(0)).toContainText('You moved a lead from a stage to a stage');
    await expect(list.nth(1)).toContainText(
      'rossb@fundd.com.au made a connector key (abcdefghjkmn)',
    );
    await expect(list.nth(2)).toContainText('You attached a PDF to a conversation');
    const pager = page.getByRole('navigation', { name: 'Activity: pages' });
    await expect(pager).toContainText('Showing 1–25 of 240');
    await pager.getByRole('button', { name: 'Older →' }).click();
    await expect(pager).toContainText('Showing 26–50 of 240');
    await expect(activity(page)).not.toContainText('made a change');
    await expectNoHorizontalScroll(page);
    await shotOf(activity(page), page, 'activity');
  });

  test('the database unavailable while the page is open: each section says so and recovers', async ({
    page,
  }) => {
    const state = await open(page, { settings: { sources: DOCUMENTS, keys: [key()] } });
    state.settings.unavailable = true;
    await page.getByRole('button', { name: `Forget ${RATE_SHEET.name ?? ''}` }).click();
    await page.getByRole('button', { name: 'Forget it' }).click();
    await expect(page.getByTestId('documents-notice')).toHaveText(
      "Couldn't reach the Command Centre's records just now. Try again in a moment.",
    );
    // What was on screen stays on screen; nothing pretends to have gone.
    await expect(row(page, RATE_SHEET.name ?? '')).toHaveCount(1);
    await page.reload();
    // supabase-js retries a 503 on a read three times (1 s, 2 s, 4 s) before it reports one.
    await expect(page.getByTestId('documents-error')).toContainText(
      "Couldn't load this just now.",
      {
        timeout: 15_000,
      },
    );
    await expect(page.getByTestId('keys-error')).toBeVisible();
    await expect(page.getByTestId('activity-error')).toBeVisible();
    await expect(page.getByTestId('spending-error')).toBeVisible();
    await shotOf(docs(page), page, 'documents-unavailable');
    state.settings.unavailable = false;
    await page.getByTestId('documents-error').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('learned-document')).toHaveCount(DOCUMENTS.length);
  });

  test('reduced motion: nothing on the page moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, { settings: { sources: DOCUMENTS, keys: [key()] } });
    const moving = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll('.settings, .settings *'))
          .map((el) => getComputedStyle(el))
          .filter(
            (style) =>
              Number.parseFloat(style.transitionDuration) > 0.001 ||
              (style.animationName !== 'none' &&
                Number.parseFloat(style.animationDuration) > 0.001),
          ).length,
    );
    expect(moving).toBe(0);
  });
});
