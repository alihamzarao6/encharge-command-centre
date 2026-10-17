/**
 * Newer / older, for a list on the settings page that can run to hundreds of rows. Both lists are
 * newest first, so the words say which way a button goes in time rather than "next".
 */
import type { ReactElement } from 'react';

import { pageCount, pageSummary } from '../lib/settingsView.js';

interface Props {
  /** What the list is, for the navigation's accessible name ("Learned documents"). */
  readonly label: string;
  readonly page: number;
  readonly size: number;
  readonly total: number;
  readonly shown: number;
  readonly busy: boolean;
  readonly onPage: (page: number) => void;
}

export function SettingsPager({
  label,
  page,
  size,
  total,
  shown,
  busy,
  onPage,
}: Props): ReactElement | null {
  const pages = pageCount(total, size);
  if (total <= size && page === 1) return null;
  return (
    <nav className="pager" aria-label={`${label}: pages`}>
      <button
        type="button"
        className="button button--small"
        disabled={busy || page <= 1}
        onClick={() => {
          onPage(page - 1);
        }}
      >
        ← Newer
      </button>
      <span className="pager__where">
        {pageSummary(page, size, total, shown)}
        <span className="pager__page">
          {' '}
          · page {String(page)} of {String(pages)}
        </span>
      </span>
      <button
        type="button"
        className="button button--small"
        disabled={busy || page >= pages}
        onClick={() => {
          onPage(page + 1);
        }}
      >
        Older →
      </button>
    </nav>
  );
}
