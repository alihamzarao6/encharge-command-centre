/**
 * The scheduled refresh's own credential, and what a scheduled run reports about itself
 * (brief of 14 Oct 2026, "Keeping the data fresh"; docs/MEMORY.md D111, D116).
 *
 * The mirror used to refresh only when a person pressed Refresh. The client's own AI now reads
 * it through the connector and cannot press anything, so the database's scheduler asks for a
 * refresh every ten minutes: `pg_cron` runs one SQL function, which POSTs to the `crm` Edge
 * Function through `pg_net` (migration 20261014010000). That caller is not a person and has
 * no session, so it proves itself with a secret of its own.
 *
 * NOT the service-role key, which is what the platform's own guide uses for this. That key
 * opens every table; putting a copy inside the database to make a timer work would break the
 * rule that it lives only in the server's environment (CLAUDE.md rule 17). This secret opens
 * one door: start a sync, under the lock every other sync is under, and hear back ids and
 * counts. It is 32 random bytes, held as a function secret and in Vault, sent in a header of
 * its own so it can never be mistaken for a session token, and compared here as SHA-256
 * digests with no early exit — both sides are digested whatever was sent, so the time taken
 * says nothing about how much of it was right.
 *
 * This is the only module that reads CRM_SCHEDULE_SECRET (tests/security/ghl.test.ts asserts
 * it, the same rule as the GoHighLevel token). The value is never logged, never returned,
 * never part of an error message; `web/src` does not name it.
 */
import type { ApplyCounts } from './ghl/sync.js';

export const SCHEDULE_SECRET_ENV = 'CRM_SCHEDULE_SECRET';
export const SCHEDULE_SECRET_HEADER = 'x-crm-schedule-secret';
/** 32 random bytes are 43 characters in base64url; anything shorter was not generated. */
export const SCHEDULE_SECRET_MIN_LENGTH = 32;
export const SCHEDULED_SYNC_ACTION = 'scheduled-sync';

type Env = Readonly<Record<string, string | undefined>>;

/** The configured secret, or null when it is unset or too short to be one. */
export function readScheduleSecret(env: Env): string | null {
  const value = env[SCHEDULE_SECRET_ENV]?.trim() ?? '';
  return value.length >= SCHEDULE_SECRET_MIN_LENGTH ? value : null;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * True only when a secret is configured and the one sent is the same. An unconfigured
 * function accepts nothing: a missing secret must never mean "open".
 */
export async function scheduleSecretMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): Promise<boolean> {
  const sent = typeof provided === 'string' ? provided : '';
  const held = typeof expected === 'string' ? expected : '';
  const [a, b] = await Promise.all([sha256(sent), sha256(held)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0 && held.length >= SCHEDULE_SECRET_MIN_LENGTH;
}

export interface RunChanges {
  readonly opportunities: {
    readonly inserted: number;
    readonly updated: number;
    readonly removed: number;
  };
  readonly contacts: {
    readonly inserted: number;
    readonly updated: number;
    readonly removed: number;
  };
  readonly stages: { readonly added: number; readonly updated: number; readonly removed: number };
  readonly customFieldsRemoved: number;
  /** Every row the run inserted, changed or marked removed. 0 = GoHighLevel had not moved. */
  readonly total: number;
}

/** What a run changed in the mirror, from the counts the database returned. Counts only. */
export function changesOf(apply: ApplyCounts): RunChanges {
  const opportunities = {
    inserted: apply.opportunities_inserted,
    updated: apply.opportunities_updated,
    removed: apply.opportunities_removed,
  };
  const contacts = {
    inserted: apply.contacts_inserted,
    updated: apply.contacts_updated,
    removed: apply.contacts_removed,
  };
  const stages = {
    added: apply.stages_added,
    updated: apply.stages_updated,
    removed: apply.stages_removed,
  };
  const total =
    opportunities.inserted +
    opportunities.updated +
    opportunities.removed +
    contacts.inserted +
    contacts.updated +
    contacts.removed +
    stages.added +
    stages.updated +
    stages.removed +
    apply.custom_fields_removed;
  return {
    opportunities,
    contacts,
    stages,
    customFieldsRemoved: apply.custom_fields_removed,
    total,
  };
}
