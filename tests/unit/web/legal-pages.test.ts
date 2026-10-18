/**
 * The three public pages Google's consent screen links to (Milestone 5 part 3a):
 * https://command.enchargecapital.com.au/about, /privacy and /terms. Google checks them without
 * signing in and without running JavaScript, and the client is held to what they say — so they
 * are static pages routed ahead of the app, and every promise on them is pinned here to the
 * code or migration that keeps it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DRIVE_FILE_SCOPE } from '../../../src/lib/drive/limits.js';
import { FILE_LIMITS } from '../../../src/lib/files/limits.js';
import { PAGE_LIMITS } from '../../../src/lib/pages/limits.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PUBLIC = join(ROOT, 'web', 'public');
const PAGES = ['about', 'privacy', 'terms'] as const;
type PageName = (typeof PAGES)[number];

const html = (page: PageName): string => readFileSync(join(PUBLIC, `${page}.html`), 'utf8');
/** The words a reader sees: tags removed, whitespace collapsed. */
const text = (page: PageName): string =>
  html(page)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string }[];
};
const CONTACT = 'rossb@fundd.com.au';

describe('routing — each address is its page, not the sign-in screen', () => {
  it.each(PAGES)(
    '/%s is rewritten to its static file ahead of the rule that sends everything to the app',
    (page) => {
      const index = vercel.rewrites.findIndex((rewrite) => rewrite.source === `/${page}`);
      const catchAll = vercel.rewrites.findIndex((rewrite) => rewrite.source === '/(.*)');
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(catchAll);
      expect(vercel.rewrites[index]?.destination).toBe(`/${page}.html`);
      // Vite copies web/public into web/dist as it is.
      expect(existsSync(join(PUBLIC, `${page}.html`))).toBe(true);
    },
  );
});

describe.each(PAGES)('/%s — public, self-contained, readable without JavaScript', (page) => {
  it('runs no script and loads nothing but its own stylesheet', () => {
    expect(html(page)).not.toMatch(/<script/i);
    expect(html(page)).not.toMatch(/\ssrc=/i);
    expect(html(page)).not.toMatch(/\son[a-z]+=/i);
    const sheets = [...html(page).matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
    expect(sheets).toEqual(['/legal.css']);
    expect(existsSync(join(PUBLIC, 'legal.css'))).toBe(true);
  });

  it('links to the other two pages, marks its own, and links nowhere unexpected', () => {
    const links = [...html(page).matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const other of PAGES) expect(links).toContain(`/${other}`);
    expect(html(page)).toContain(`<a href="/${page}" aria-current="page">`);
    const allowed = [
      /^\/(about|privacy|terms)?$/,
      /^https:\/\/enchargecapital\.com\.au(\/privacy-policy\/)?$/,
      /^https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy$/,
      new RegExp(`^mailto:${CONTACT.replace(/\./g, '\\.')}$`),
    ];
    for (const link of links)
      expect(
        allowed.some((rule) => rule.test(link)),
        link,
      ).toBe(true);
  });

  it('names Encharge Capital, gives the one contact address, and nothing of the broker network', () => {
    expect(text(page)).toContain('Encharge Capital');
    expect(html(page)).toContain(`mailto:${CONTACT}`);
    // Encharge Capital runs it; Control Finance (Fundd) is the network he brokers for, and its
    // licence is not his to publish (reviewer, 18 Oct). Encharge publishes no ABN.
    expect(text(page)).not.toMatch(/Control Finance|389328|\bABN\b/i);
    expect(html(page)).not.toContain('ross@enchargecapital.com');
  });
});

describe('every promise is one the code keeps', () => {
  it('only the files a person picks: the one Drive scope the app asks for', () => {
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
    expect(text('terms')).toContain('only for access to the files you pick yourself');
    for (const page of PAGES) expect(text(page)).toMatch(/never lists/);
  });

  it('the text of a file is kept for as many days as files are kept', () => {
    const days = String(FILE_LIMITS.retentionDays);
    expect(text('terms')).toContain(`kept with the conversation for ${days} days`);
    expect(text('privacy')).toContain(`kept with the conversation for ${days} days`);
    expect(text('privacy')).toContain(`Text from attached or picked files: ${days} days`);
  });

  it('the text of a web page is kept for a day', () => {
    expect(PAGE_LIMITS.pageRetentionDays).toBe(1);
    expect(text('privacy')).toContain('Text from web pages: 24 hours');
  });

  it('a record of each Drive read goes after a day — the purge in the migration', () => {
    const migration = readFileSync(
      join(ROOT, 'supabase', 'migrations', '20261016010000_drive.sql'),
      'utf8',
    );
    expect(migration).toContain(
      "delete from public.drive_reads r where r.created_at < now() - interval '1 day'",
    );
    expect(text('privacy')).toContain(
      'record of each read (which file, its size) is deleted after 24 hours',
    );
  });

  it('says what outlives the 30 days, that the file is never stored, and that disconnecting revokes', () => {
    for (const page of ['privacy', 'terms'] as const) {
      expect(text(page)).toContain('kept until someone removes the file');
      expect(text(page)).toContain('never copied or stored');
      expect(text(page)).toMatch(/withdraws (its|the Command Centre's) access at Google/);
    }
  });

  it('names every service the text goes to, and where the database is', () => {
    expect(text('privacy')).toContain('Anthropic');
    expect(text('privacy')).toContain('Voyage AI');
    expect(text('privacy')).toContain('Supabase in Sydney');
    expect(text('privacy')).toContain('Limited Use requirements');
  });
});
