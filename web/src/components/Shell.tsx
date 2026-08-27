/**
 * The dashboard shell: brand header, a section nav, one live section. On a phone the nav
 * is a bottom tab bar (thumb reach); from 768px it is a sidebar. Sections that later stages
 * deliver are listed — the client asked for something that reads like a CRM — but each is
 * marked with its stage and opens a page that says so. No dead links, no fake data.
 */
import type { Session } from '@supabase/supabase-js';
import { useState, type ReactElement } from 'react';

import type { PendingDraft } from '../lib/draft.js';
import type { AppUserRow } from '../lib/supabase.js';
import { Assistant } from './Assistant.js';
import { Memory } from './Memory.js';
import { NotYet } from './NotYet.js';

export type SectionId = 'assistant' | 'memory' | 'content' | 'ads';

export interface Section {
  readonly id: SectionId;
  readonly label: string;
  readonly live: boolean;
  readonly stage: string;
  readonly blurb: string;
}

const ASSISTANT: Section = {
  id: 'assistant',
  label: 'Assistant',
  live: true,
  stage: 'Stage 2',
  blurb:
    'Talk to the assistant in your voice. Copy any reply straight into Facebook or Ads Manager.',
};

export const SECTIONS: readonly Section[] = [
  ASSISTANT,
  {
    id: 'memory',
    label: 'Memory',
    live: true,
    stage: 'Stage 3',
    blurb:
      'What the assistant remembers about the business, and the facts it has learned from you — reviewable and correctable.',
  },
  {
    id: 'content',
    label: 'Content',
    live: false,
    stage: 'Stage 5',
    blurb:
      'Social posts and carousels generated in voice, with a review step before anything is published.',
  },
  {
    id: 'ads',
    label: 'Ads',
    live: false,
    stage: 'Stage 5',
    blurb: 'Meta ad copy — hook, body, CTA — in variants, ready for Ads Manager.',
  },
];

interface Props {
  readonly session: Session;
  readonly staff: AppUserRow;
  readonly onSignOut: () => Promise<void>;
  readonly onSessionExpired: (pending: PendingDraft | null) => Promise<void>;
}

const ICONS: Readonly<Record<SectionId, string>> = {
  assistant: '💬',
  memory: '🧠',
  content: '📝',
  ads: '📣',
};

export function Shell({ session, staff, onSignOut, onSessionExpired }: Props): ReactElement {
  const [section, setSection] = useState<SectionId>('assistant');
  /**
   * Set only when the Memory page asks to open the conversation a note came from, and
   * cleared by any ordinary navigation — otherwise leaving Memory and coming back to the
   * Assistant later would silently reopen a conversation nobody asked for this time.
   */
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const active = SECTIONS.find((s) => s.id === section) ?? ASSISTANT;

  const goTo = (id: SectionId): void => {
    setPendingConversationId(null);
    setSection(id);
  };
  const openConversation = (conversationId: string): void => {
    setPendingConversationId(conversationId);
    setSection('assistant');
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            F
          </span>
          <div>
            <div className="brand__name">Fundd</div>
            <div className="brand__sub">Command Centre</div>
          </div>
        </div>
        <div className="topbar__user">
          <span className="topbar__email" title={staff.email}>
            {staff.email}
          </span>
          <button
            className="button button--ghost"
            type="button"
            onClick={() => {
              void onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="nav" aria-label="Sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`nav__item${s.id === section ? ' nav__item--active' : ''}${s.live ? '' : ' nav__item--soon'}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => {
              goTo(s.id);
            }}
          >
            <span className="nav__icon" aria-hidden="true">
              {ICONS[s.id]}
            </span>
            <span className="nav__label">{s.label}</span>
            {!s.live && <span className="nav__badge">{s.stage}</span>}
          </button>
        ))}
      </nav>

      <main className="main">
        {section === 'assistant' && (
          <Assistant
            session={session}
            openConversationId={pendingConversationId}
            onSessionExpired={onSessionExpired}
          />
        )}
        {section === 'memory' && (
          <Memory
            session={session}
            staff={staff}
            onOpenConversation={openConversation}
            onSessionExpired={() => onSessionExpired(null)}
          />
        )}
        {!active.live && <NotYet section={active} />}
      </main>
    </div>
  );
}
