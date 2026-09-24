/**
 * The one rule about a note the browser and the server both enforce (Milestone 4 part 4).
 * Beside, not inside, `crm/ghl/`: the browser imports this module and nothing under
 * `crm/ghl/` may be named by anything under web/src (tests/security/ghl.test.ts).
 *
 * GoHighLevel accepted 5,000 and 20,000 characters on the live probe of 24 Sep 2026; a
 * "latest update" is a paragraph, and the mirror keeps every note, so the app caps lower.
 */
export const NOTE_MAX_LENGTH = 5_000;
