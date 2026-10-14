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
 * counts. It is 32 random bytes, held as a function secret and in Vault.
 *
 * THE SECRET NEVER TRAVELS. What the database sends is a TOKEN: the second it was made, and
 * the HMAC-SHA256 of "scheduled-sync:<that second>" keyed with the secret —
 * `1792020180.<64 hex>` — in a header of its own. The function makes the same HMAC with its
 * own copy, compares in constant time, and refuses a token more than two minutes from its own
 * clock. Why (14 Oct 2026): on a real Supabase stack the API roles hold SELECT on `pg_net`'s
 * request queue, a platform grant this project cannot revoke, and the request sits there for
 * the moment before it is sent. Whoever could read it would hold a token that expires in two
 * minutes and can do nothing but start the same sync under the same lock. The first build sent
 * the secret itself; CI's security suite caught the grant before anything was deployed.
 *
 * This is the only module that reads CRM_SCHEDULE_SECRET (tests/security/ghl-schedule.test.ts
 * asserts it, the same rule as the GoHighLevel token). The value is never logged, never
 * returned, never part of an error message; `web/src` does not name it.
 */
import type { ApplyCounts } from './ghl/sync.js';

export const SCHEDULE_SECRET_ENV = 'CRM_SCHEDULE_SECRET';
export const SCHEDULE_TOKEN_HEADER = 'x-crm-schedule-token';
/** 32 random bytes are 43 characters in base64url; anything shorter was not generated. */
export const SCHEDULE_SECRET_MIN_LENGTH = 32;
/** How far a token's second may be from the function's clock, either way. */
export const SCHEDULE_TOKEN_MAX_SKEW_SECONDS = 120;
export const SCHEDULED_SYNC_ACTION = 'scheduled-sync';

type Env = Readonly<Record<string, string | undefined>>;

/** The configured secret, or null when it is unset or too short to be one. */
export function readScheduleSecret(env: Env): string | null {
  const value = env[SCHEDULE_SECRET_ENV]?.trim() ?? '';
  return value.length >= SCHEDULE_SECRET_MIN_LENGTH ? value : null;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** HMAC-SHA256 of "scheduled-sync:<second>" keyed with the secret, as 64 hex characters. */
async function signature(secret: string, atSeconds: number): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${SCHEDULED_SYNC_ACTION}:${String(atSeconds)}`),
  );
  return toHex(new Uint8Array(signed));
}

/**
 * The token for a second, exactly as `dispatch_ghl_sync()` makes it in SQL with pgcrypto's
 * `hmac()`. The function does not send tokens; the tests use this to make one, and the stack
 * test checks the database's token against it.
 */
export async function scheduleTokenFor(secret: string, atSeconds: number): Promise<string> {
  return `${String(atSeconds)}.${await signature(secret, atSeconds)}`;
}

const TOKEN_SHAPE = /^(\d{1,12})\.([0-9a-f]{64})$/;

export type ScheduleTokenCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'not_configured' | 'nothing_sent' | 'malformed' | 'stale' | 'mismatch';
    };

/**
 * Is this the token the database would have made, with the secret this function holds, within
 * two minutes of now? An unconfigured function accepts nothing: a missing secret must never
 * mean "open". The signature is compared without an early exit.
 */
export async function checkScheduleToken(
  token: string | null | undefined,
  held: string | null | undefined,
  nowMs: number,
): Promise<ScheduleTokenCheck> {
  if (typeof held !== 'string' || held.length < SCHEDULE_SECRET_MIN_LENGTH) {
    return { ok: false, reason: 'not_configured' };
  }
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'nothing_sent' };
  const match = TOKEN_SHAPE.exec(token);
  const atText = match?.[1];
  const sent = match?.[2];
  if (atText === undefined || sent === undefined) return { ok: false, reason: 'malformed' };
  const atSeconds = Number(atText);
  if (Math.abs(nowMs / 1_000 - atSeconds) > SCHEDULE_TOKEN_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const expected = await signature(held, atSeconds);
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= expected.charCodeAt(i) ^ sent.charCodeAt(i);
  }
  return difference === 0 ? { ok: true } : { ok: false, reason: 'mismatch' };
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
