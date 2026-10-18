/**
 * The three public pages Google's consent screen links to (Milestone 5 part 3a), in a real
 * Chrome at 375 / 768 / 1280: they open with nobody signed in and no script running, nothing
 * scrolls sideways, and the links between them are big enough to tap. `vite preview` serves the
 * files by name; on Vercel, /about, /privacy and /terms are rewritten to them (vercel.json —
 * tests/unit/web/legal-pages.test.ts).
 */
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const SHOTS = fileURLToPath(new URL('../../docs/assets/milestone-5/', import.meta.url));

const PAGES = [
  { file: '/about.html', heading: 'Encharge Capital Command Centre', shot: 'legal-about' },
  { file: '/privacy.html', heading: 'Privacy Policy', shot: 'legal-privacy' },
  { file: '/terms.html', heading: 'Terms of Use', shot: 'legal-terms' },
] as const;

test.use({ javaScriptEnabled: false });

for (const { file, heading, shot } of PAGES) {
  test(`${file} reads signed out, without JavaScript, and fits the screen`, async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url());
    });
    const response = await page.goto(file);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole('link', { name: 'rossb@fundd.com.au' })).toBeVisible();
    // Its own stylesheet applied (the card has a border), and nothing fetched from elsewhere.
    await expect(page.locator('article')).toHaveCSS('border-top-style', 'solid');
    expect(external).toEqual([]);

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    for (const link of await page.getByRole('navigation').getByRole('link').all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    const body = await page.locator('body').evaluate((el) => getComputedStyle(el).fontSize);
    expect(body).toBe('16px');

    const width = page.viewportSize()?.width ?? 0;
    await page.screenshot({ path: `${SHOTS}${shot}-${String(width)}.png`, fullPage: true });
  });
}
