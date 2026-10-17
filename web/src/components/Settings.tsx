/**
 * Settings (Milestone 5 part 4): one page, one route (/settings), sections within it — decision 1.
 *
 *   What the assistant has learned   list, and forget (LearnedDocuments)
 *   Connections                      THE SLOT — Milestone 5 part 3a's; see ConnectionsSlot below
 *   Connector keys                   make, list, switch off (ConnectorKeys)
 *   Spending                         read-only (Spending)
 *   Activity                         read-only, paged (Activity)
 *
 * No team or user management here (decision 3): that is the Team page, and stays there.
 *
 * Every section reads under row-level security as the signed-in person and changes things only
 * through the settings endpoint; each loads, fails and recovers on its own, so one section that
 * cannot be read never blanks the page.
 */
import type { Session } from '@supabase/supabase-js';
import { useMemo, type ReactElement, type ReactNode } from 'react';

import type { SettingsActor } from '../../../src/lib/settings/access.js';
import { SECTION_TEXT } from '../lib/settingsView.js';
import type { AppUserRow } from '../lib/supabase.js';
import { Activity } from './Activity.js';
import { ConnectorKeys } from './ConnectorKeys.js';
import { DriveConnection } from './DriveConnection.js';
import { LearnedDocuments } from './LearnedDocuments.js';
import { Spending } from './Spending.js';

interface Props {
  readonly session: Session;
  readonly staff: AppUserRow;
  readonly onSessionExpired: () => Promise<void>;
}

/**
 * THE CONNECTIONS SLOT — the contract Milestone 5 part 3a builds against (this part does not
 * build connections, decision 2):
 *
 *   - Where: the second section of /settings, between "What the assistant has learned" and
 *     "Connector keys". Its place does not move when connections are added.
 *   - What it renders itself: a `<section id="connections">` labelled by its `<h2>` "Connections"
 *     and one line under it — and nothing else. It holds no state and calls nothing.
 *   - What goes in it: `children`, as given. Each connection is its own self-contained card: it
 *     takes `session` and `onSessionExpired` and nothing else from the page, renders as a
 *     `.settings__section`, loads and fails on its own, announces through its own
 *     `aria-live="polite"` region (never `role="status"`), and owns its confirmations.
 *     Its heading should be an `<h3>`, under this `<h2>`.
 *   - /settings is where Google's consent screen returns to, so whatever finishes a connection
 *     must be mounted here on first render — as `DriveConnection` is today.
 */
export function ConnectionsSlot({ children }: { readonly children?: ReactNode }): ReactElement {
  return (
    <section
      id="connections"
      className="settings__group"
      aria-labelledby="connections-heading"
      data-testid="settings-connections"
    >
      <h2 id="connections-heading" className="settings__group-heading">
        Connections
      </h2>
      <p className="settings__intro">{SECTION_TEXT.connectionsIntro}</p>
      {children}
    </section>
  );
}

const SECTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'learned', label: 'What it has learned' },
  { id: 'connections', label: 'Connections' },
  { id: 'keys', label: 'Connector keys' },
  { id: 'spending', label: 'Spending' },
  { id: 'activity', label: 'Activity' },
];

export function Settings({ session, staff, onSessionExpired }: Props): ReactElement {
  // Stable identity: each section's first load depends on it.
  const actor: SettingsActor = useMemo(
    () => ({ userId: staff.user_id, isAdmin: staff.is_admin }),
    [staff.user_id, staff.is_admin],
  );
  return (
    <section className="settings" aria-labelledby="settings-title" data-testid="settings">
      <div className="settings__bar">
        <h1 id="settings-title" className="settings__title">
          Settings
        </h1>
      </div>
      <nav className="settings__jump" aria-label="Settings sections">
        <ul>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <LearnedDocuments session={session} actor={actor} onSessionExpired={onSessionExpired} />
      <ConnectionsSlot>
        <DriveConnection session={session} onSessionExpired={onSessionExpired} />
      </ConnectionsSlot>
      <ConnectorKeys session={session} onSessionExpired={onSessionExpired} />
      <Spending session={session} onSessionExpired={onSessionExpired} />
      <Activity viewerId={staff.user_id} onSessionExpired={onSessionExpired} />
    </section>
  );
}
