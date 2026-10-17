/**
 * The settings page's reads (Milestone 5 part 4): PostgREST selects as the signed-in person,
 * under the policies that already exist. No server path, no widened policy:
 *
 *   knowledge_sources  every learned document, for every active member of staff (part 5);
 *   connector_keys     the person's OWN keys and nobody else's (connector, stage 1);
 *   audit_log          every row, for every active member of staff (Stage 2) — selected by
 *                      action name, and only named keys out of before/after;
 *   app_users          the roster, for "added by" (Stage 3 part 4);
 *   ghl_stages / ghl_opportunities   names for a lead move (Milestone 4).
 *
 * A list read the page cannot do is an `unavailable` result with no rows — never a guess and
 * never an empty list that would look like "nothing learned".
 *
 * The client is passed in, so the tests drive these with a supabase-js client over a recorded
 * fetch and assert the exact requests (filters, order, range, the columns selected).
 */
import type { WebClient } from './database.js';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_COLUMNS,
  CONNECTOR_KEY_COLUMNS,
  DOCUMENT_ORDER,
  LEARNED_SOURCE_COLUMNS,
  RELATED_SOURCE_COLUMNS,
  pageWindow,
  type ActivityRow,
  type ConnectorKeyRow,
  type LearnedSourceRow,
  type RelatedSourceRow,
} from './settingsView.js';

export type Read<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'expired' }
  | { readonly kind: 'unavailable' };

interface PostgrestFailure {
  readonly code?: string;
  readonly message?: string;
}

function failed<T>(error: PostgrestFailure): Read<T> {
  // PostgREST's "JWT expired": the session ran out while the page was open.
  return error.code === 'PGRST301' ? { kind: 'expired' } : { kind: 'unavailable' };
}

export interface DocumentsPage {
  readonly rows: readonly LearnedSourceRow[];
  /** Copies and other reads of what is on this page, for the confirmation's words. */
  readonly related: readonly RelatedSourceRow[];
  readonly total: number;
}

export async function readDocuments(
  client: WebClient,
  page: number,
  size: number,
): Promise<Read<DocumentsPage>> {
  const { from, to } = pageWindow(page, size);
  let query = client
    .from('knowledge_sources')
    .select(LEARNED_SOURCE_COLUMNS, { count: 'exact' })
    .neq('status', 'forgotten');
  for (const order of DOCUMENT_ORDER) {
    query = query.order(order.column, { ascending: order.ascending });
  }
  const listed = await query.range(from, to);
  if (listed.error !== null) return failed(listed.error);
  const rows = listed.data;
  const hashes = [
    ...new Set(rows.map((row) => row.content_hash).filter((h): h is string => h !== null)),
  ];
  const urls = [
    ...new Set(rows.map((row) => row.source_url).filter((u): u is string => u !== null)),
  ];
  const related: RelatedSourceRow[] = [];
  if (hashes.length > 0) {
    const copies = await client
      .from('knowledge_sources')
      .select(RELATED_SOURCE_COLUMNS)
      .neq('status', 'forgotten')
      .in('content_hash', hashes)
      .limit(1000);
    // The copies decide whether Forget is offered, so without them the list is not shown.
    if (copies.error !== null) return failed(copies.error);
    related.push(...copies.data);
  }
  if (urls.length > 0) {
    const reads = await client
      .from('knowledge_sources')
      .select(RELATED_SOURCE_COLUMNS)
      .neq('status', 'forgotten')
      .in('source_url', urls)
      .limit(1000);
    // Other reads of an address only add a sentence to a confirmation: a failure costs that
    // sentence, never the list.
    if (reads.error === null) {
      const seen = new Set(related.map((row) => row.id));
      related.push(...reads.data.filter((row) => !seen.has(row.id)));
    }
  }
  return { kind: 'ok', value: { rows, related, total: listed.count ?? rows.length } };
}

/** The roster: who an id is. A failure costs the names, never the page. */
export async function readRoster(client: WebClient): Promise<ReadonlyMap<string, string>> {
  const roster = await client.from('app_users').select('user_id, email').limit(500);
  if (roster.error !== null) return new Map();
  return new Map(roster.data.map((row): [string, string] => [row.user_id, row.email]));
}

export async function readKeys(client: WebClient): Promise<Read<readonly ConnectorKeyRow[]>> {
  // No filter on whose: the policy returns the signed-in person's own rows and nothing else.
  const keys = await client
    .from('connector_keys')
    .select(CONNECTOR_KEY_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(200);
  if (keys.error !== null) return failed(keys.error);
  return { kind: 'ok', value: keys.data };
}

export interface ActivityPage {
  readonly rows: readonly ActivityRow[];
  readonly total: number;
  readonly stageNames: ReadonlyMap<string, string>;
  readonly leadNames: ReadonlyMap<string, string>;
}

export async function readActivity(
  client: WebClient,
  page: number,
  size: number,
): Promise<Read<ActivityPage>> {
  const { from, to } = pageWindow(page, size);
  const listed = await client
    .from('audit_log')
    .select(ACTIVITY_COLUMNS, { count: 'exact' })
    .in('action', [...ACTIVITY_ACTIONS])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to)
    .overrideTypes<ActivityRow[], { merge: false }>();
  if (listed.error !== null) return failed(listed.error);
  const rows = listed.data;
  const stageIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.from_stage, row.to_stage])
        .filter((id): id is string => id !== null),
    ),
  ];
  const leadIds = [
    ...new Set(rows.map((row) => row.opportunity).filter((id): id is string => id !== null)),
  ];
  // Names are a courtesy: when the mirror cannot be read the record still lists ("a lead").
  const stageNames = new Map<string, string>();
  if (stageIds.length > 0) {
    const stages = await client.from('ghl_stages').select('ghl_id, name').in('ghl_id', stageIds);
    if (stages.error === null) for (const s of stages.data) stageNames.set(s.ghl_id, s.name);
  }
  const leadNames = new Map<string, string>();
  if (leadIds.length > 0) {
    const leads = await client
      .from('ghl_opportunities')
      .select('ghl_id, name')
      .in('ghl_id', leadIds);
    if (leads.error === null) for (const l of leads.data) leadNames.set(l.ghl_id, l.name);
  }
  return {
    kind: 'ok',
    value: { rows, total: listed.count ?? rows.length, stageNames, leadNames },
  };
}
