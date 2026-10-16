/**
 * Settings (Milestone 5 part 3a): for now, one section — Google Drive. Deliberately plain:
 * Milestone 5 part 4 is the proper settings screen, and it takes `DriveConnection` as it is,
 * placing it beside whatever else that part adds. Nothing here is a layout part 4 would have to
 * tear out.
 */
import type { Session } from '@supabase/supabase-js';
import type { ReactElement } from 'react';

import { DriveConnection } from './DriveConnection.js';

interface Props {
  readonly session: Session;
  readonly onSessionExpired: () => Promise<void>;
}

export function Settings({ session, onSessionExpired }: Props): ReactElement {
  return (
    <section className="settings" aria-labelledby="settings-title" data-testid="settings">
      <div className="settings__bar">
        <h1 id="settings-title" className="settings__title">
          Settings
        </h1>
      </div>
      <DriveConnection session={session} onSessionExpired={onSessionExpired} />
    </section>
  );
}
