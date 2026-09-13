/**
 * The GoHighLevel → database sync (Milestone 4 part 1): fetch, map, upsert. One entry
 * point, `runGhlSync`, which never throws and always returns a report; the same report
 * lands in `ghl_sync_runs` so that when this breaks in three weeks the row explains it.
 *
 * Shape of a run:
 *
 *   1. claim the run slot — `begin_ghl_sync_run` refuses a second concurrent run
 *      (CONFLICT → status 'refused', nothing fetched) and retires an interrupted one;
 *   2. read the pipelines and find the configured pipeline BY ID — a wrong id is a loud
 *      failure, never "zero opportunities" (GHL answers 200 and an empty list for an
 *      unknown pipeline id, observed 12 Sep 2026);
 *   3. read every opportunity in that pipeline, to exhaustion, under the page cap;
 *   4. read each distinct contact behind them, under the contact cap. A contact that
 *      404s, fails validation, or fails on transport is counted and listed BY ID and the
 *      run continues (status 'partial'); a 401 / 403 / open breaker aborts the run —
 *      further calls would be pointless and a dead token must surface, not be buried
 *      under a hundred identical failures;
 *   5. read the custom-field definitions; keep the ones a synced contact carries or that
 *      sit in a configured folder. A failed read leaves the stored definitions untouched;
 *   6. apply the snapshot in ONE database transaction; removals are computed only from a
 *      complete, fully-valid opportunity read;
 *   7. finish the run with its status, counts and the ids of everything that failed.
 *
 * Idempotent: the same GHL state twice produces the same rows (content hash), and the
 * second run reports every opportunity and contact as `unchanged`.
 */
import { AppError, type Result } from '../../errors.js';
import type { Logger } from '../../logger.js';
import type { GhlClient } from './client.js';
import type { GhlConfig } from './config.js';
import {
  toContactRow,
  toCustomFieldRow,
  toOpportunityRow,
  toPipelineRow,
  toStageRow,
  type ContactRow,
  type CustomFieldRow,
  type Snapshot,
} from './map.js';

export type SyncTrigger = 'cli' | 'api' | 'schedule' | 'test';
export type SyncStatus = 'success' | 'partial' | 'failed';

export interface FetchCounts {
  readonly requests: number;
  readonly pages_fetched: number;
  readonly opportunities_fetched: number;
  readonly opportunities_rejected: number;
  readonly contacts_fetched: number;
  readonly contacts_failed: number;
  readonly contacts_rejected: number;
  readonly contacts_missing: number;
  readonly custom_fields_fetched: number;
}

export interface ApplyCounts {
  readonly stages_seen: number;
  readonly stages_added: number;
  readonly stages_updated: number;
  readonly stages_removed: number;
  readonly opportunities_inserted: number;
  readonly opportunities_updated: number;
  readonly opportunities_unchanged: number;
  readonly opportunities_removed: number;
  readonly contacts_inserted: number;
  readonly contacts_updated: number;
  readonly contacts_unchanged: number;
  readonly contacts_removed: number;
  readonly custom_fields_seen: number;
  readonly custom_fields_removed: number;
}

export interface SyncErrorEntry {
  readonly kind: 'pipeline' | 'opportunity' | 'contact' | 'custom_fields' | 'apply' | 'finish';
  /** A GHL id, never a name, email or phone. */
  readonly id: string | null;
  readonly code: string;
}

export interface BeginRunInput {
  readonly pipelineId: string;
  readonly trigger: SyncTrigger;
  readonly triggeredBy: string | null;
  readonly staleAfterSeconds: number;
}

export interface FinishRunInput {
  readonly runId: string;
  readonly status: SyncStatus;
  readonly errorCode: string | null;
  readonly error: string | null;
  readonly errors: readonly SyncErrorEntry[];
  readonly counts: FetchCounts;
}

export interface GhlSyncStore {
  /** CONFLICT when a run is already in progress for the pipeline. */
  beginRun(input: BeginRunInput): Promise<Result<{ runId: string; staleMarked: number }>>;
  applySnapshot(runId: string, snapshot: Snapshot): Promise<Result<ApplyCounts>>;
  finishRun(input: FinishRunInput): Promise<Result<void>>;
}

export interface SyncReport {
  readonly status: SyncStatus | 'refused';
  readonly runId: string | null;
  readonly pipelineId: string;
  readonly durationMs: number;
  readonly staleMarked: number;
  readonly fetch: FetchCounts;
  readonly apply: ApplyCounts | null;
  readonly errors: readonly SyncErrorEntry[];
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface GhlSyncDeps {
  readonly client: GhlClient;
  readonly store: GhlSyncStore;
  readonly config: GhlConfig;
  readonly log: Logger;
  readonly now?: () => number;
}

export interface RunOptions {
  readonly trigger: SyncTrigger;
  readonly triggeredBy?: string | null;
}

export class PipelineNotFoundError extends AppError {
  public constructor(pipelineId: string, pipelinesFound: number) {
    super(
      'CONFIG',
      `GHL_PIPELINE_ID ${pipelineId} is not a pipeline in this location (${pipelinesFound} found). Refusing to sync: an unknown id reads as an empty pipeline.`,
      { context: { pipelineId, pipelinesFound } },
    );
  }
}

export class ContactCapError extends AppError {
  public constructor(contacts: number, cap: number) {
    super(
      'INTERNAL',
      `the pipeline references ${contacts} contacts, above GHL_MAX_CONTACTS_PER_RUN (${cap}); refusing to sync a partial set silently`,
      { context: { reason: 'LIMIT', contacts, cap } },
    );
  }
}

/** Errors after which no further GHL call can succeed this run. */
const FATAL_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'CIRCUIT_OPEN']);

export async function runGhlSync(deps: GhlSyncDeps, options: RunOptions): Promise<SyncReport> {
  const { client, store, config } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const startedAt = now();
  const pipelineId = config.pipelineId;
  const log = deps.log.child({ component: 'ghl-sync', pipelineId, trigger: options.trigger });
  const errors: SyncErrorEntry[] = [];
  const counts = {
    pages_fetched: 0,
    opportunities_fetched: 0,
    opportunities_rejected: 0,
    contacts_fetched: 0,
    contacts_failed: 0,
    contacts_rejected: 0,
    contacts_missing: 0,
    custom_fields_fetched: 0,
  };
  const fetchCounts = (): FetchCounts => ({ requests: client.requestsMade(), ...counts });

  const begun = await store.beginRun({
    pipelineId,
    trigger: options.trigger,
    triggeredBy: options.triggeredBy ?? null,
    staleAfterSeconds: config.staleRunAfterSeconds,
  });
  if (!begun.ok) {
    if (begun.error.code === 'CONFLICT') {
      log.warn('ghl sync refused: another run is in progress', { error: begun.error });
      return {
        status: 'refused',
        runId: null,
        pipelineId,
        durationMs: now() - startedAt,
        staleMarked: 0,
        fetch: fetchCounts(),
        apply: null,
        errors,
        error: { code: begun.error.code, message: begun.error.message },
      };
    }
    log.error('ghl sync could not start: run row not created', { error: begun.error });
    return {
      status: 'failed',
      runId: null,
      pipelineId,
      durationMs: now() - startedAt,
      staleMarked: 0,
      fetch: fetchCounts(),
      apply: null,
      errors,
      error: { code: begun.error.code, message: begun.error.message },
    };
  }
  const { runId, staleMarked } = begun.value;
  log.info('ghl sync started', { runId, staleMarked });
  if (staleMarked > 0) {
    log.warn('previous interrupted run(s) marked failed', { runId, staleMarked });
  }

  const fail = async (failure: AppError, kind: SyncErrorEntry['kind']): Promise<SyncReport> => {
    errors.push({ kind, id: null, code: failure.code });
    const finished = await store.finishRun({
      runId,
      status: 'failed',
      errorCode: failure.code,
      error: failure.message,
      errors,
      counts: fetchCounts(),
    });
    if (!finished.ok) {
      errors.push({ kind: 'finish', id: null, code: finished.error.code });
      log.error('ghl sync run row could not be closed after a failure', {
        runId,
        error: finished.error,
      });
    }
    const durationMs = now() - startedAt;
    log.error('ghl sync failed', {
      runId,
      durationMs,
      step: kind,
      code: failure.code,
      error: failure,
      fetch: fetchCounts(),
    });
    return {
      status: 'failed',
      runId,
      pipelineId,
      durationMs,
      staleMarked,
      fetch: fetchCounts(),
      apply: null,
      errors,
      error: { code: failure.code, message: failure.message },
    };
  };

  // 2. The pipeline, by id.
  const pipelines = await client.getPipelines();
  if (!pipelines.ok) return fail(pipelines.error, 'pipeline');
  const pipeline = pipelines.value.find((p) => p.id === pipelineId);
  if (pipeline === undefined) {
    log.error('configured pipeline id not found in the location; nothing read', {
      pipelineId,
      pipelineIdsFound: pipelines.value.map((p) => p.id),
    });
    return fail(new PipelineNotFoundError(pipelineId, pipelines.value.length), 'pipeline');
  }

  // 3. Every opportunity in it.
  const listing = await client.listOpportunities(pipelineId);
  if (!listing.ok) return fail(listing.error, 'opportunity');
  counts.pages_fetched = listing.value.pages;
  counts.opportunities_fetched = listing.value.opportunities.length;
  counts.opportunities_rejected = listing.value.rejected.length;
  for (const rejected of listing.value.rejected) {
    errors.push({
      kind: 'opportunity',
      id: rejected.id,
      code: `REJECTED_${rejected.reason.toUpperCase()}`,
    });
  }
  const totalKnown = listing.value.total;
  const opportunitiesComplete =
    listing.value.rejected.length === 0 &&
    (totalKnown === null || listing.value.opportunities.length >= totalKnown);
  if (!opportunitiesComplete) {
    log.warn('opportunity read is not complete; removals will not be marked this run', {
      runId,
      fetched: listing.value.opportunities.length,
      rejected: listing.value.rejected.length,
      total: totalKnown,
    });
  }

  // 4. The contacts behind them.
  const contactIds = [
    ...new Set(
      listing.value.opportunities
        .map((o) => o.contactId)
        .filter((id): id is string => id !== null && id !== ''),
    ),
  ];
  if (contactIds.length > config.maxContactsPerRun) {
    return fail(new ContactCapError(contactIds.length, config.maxContactsPerRun), 'contact');
  }
  const contacts: ContactRow[] = [];
  const seenFieldIds = new Set<string>();
  for (const contactId of contactIds) {
    const fetched = await client.getContact(contactId);
    if (!fetched.ok) {
      if (FATAL_CODES.has(fetched.error.code)) return fail(fetched.error, 'contact');
      if (fetched.error.code === 'VALIDATION') {
        counts.contacts_rejected += 1;
        errors.push({ kind: 'contact', id: contactId, code: 'REJECTED_SHAPE' });
      } else {
        counts.contacts_failed += 1;
        errors.push({ kind: 'contact', id: contactId, code: fetched.error.code });
        log.warn('contact fetch failed; its previous row (if any) is kept', {
          runId,
          contactId,
          code: fetched.error.code,
        });
      }
      continue;
    }
    if (fetched.value === null) {
      counts.contacts_missing += 1;
      errors.push({ kind: 'contact', id: contactId, code: 'NOT_FOUND' });
      continue;
    }
    counts.contacts_fetched += 1;
    const row = toContactRow(fetched.value);
    for (const fieldId of Object.keys(row.custom_fields)) seenFieldIds.add(fieldId);
    contacts.push(row);
  }

  // 5. Custom-field definitions: the ones in play, plus the configured folders.
  let customFields: CustomFieldRow[] = [];
  let customFieldsComplete = false;
  const definitions = await client.getCustomFields();
  if (!definitions.ok) {
    if (FATAL_CODES.has(definitions.error.code)) return fail(definitions.error, 'custom_fields');
    errors.push({ kind: 'custom_fields', id: null, code: definitions.error.code });
    log.warn('custom field definitions could not be read; stored definitions left as they are', {
      runId,
      code: definitions.error.code,
    });
  } else {
    counts.custom_fields_fetched = definitions.value.definitions.length;
    const folders = new Set(config.customFieldFolderIds);
    customFields = definitions.value.definitions
      .filter((d) => seenFieldIds.has(d.id) || (d.parentId !== null && folders.has(d.parentId)))
      .map(toCustomFieldRow);
    customFieldsComplete = definitions.value.rejected.length === 0;
    for (const rejected of definitions.value.rejected) {
      errors.push({ kind: 'custom_fields', id: rejected.id, code: 'REJECTED_SHAPE' });
    }
  }

  // 6. One transaction.
  const snapshot: Snapshot = {
    pipeline: toPipelineRow(pipeline, config.locationId),
    stages: pipeline.stages.map(toStageRow),
    opportunities_complete: opportunitiesComplete,
    opportunities: listing.value.opportunities.map(toOpportunityRow),
    contacts,
    custom_fields_complete: customFieldsComplete,
    custom_fields: customFields,
  };
  const applied = await store.applySnapshot(runId, snapshot);
  if (!applied.ok) return fail(applied.error, 'apply');

  // 7. Close the run.
  const status: SyncStatus =
    counts.contacts_failed > 0 ||
    counts.contacts_rejected > 0 ||
    counts.contacts_missing > 0 ||
    counts.opportunities_rejected > 0 ||
    !customFieldsComplete
      ? 'partial'
      : 'success';
  const finished = await store.finishRun({
    runId,
    status,
    errorCode: null,
    error: null,
    errors,
    counts: fetchCounts(),
  });
  if (!finished.ok) {
    errors.push({ kind: 'finish', id: null, code: finished.error.code });
    log.error('ghl sync applied but the run row could not be closed', {
      runId,
      error: finished.error,
    });
  }
  const durationMs = now() - startedAt;
  const report: SyncReport = {
    status,
    runId,
    pipelineId,
    durationMs,
    staleMarked,
    fetch: fetchCounts(),
    apply: applied.value,
    errors,
    error: null,
  };
  log.info('ghl sync finished', {
    runId,
    status,
    durationMs,
    fetch: report.fetch,
    apply: applied.value,
    errorCount: errors.length,
    stageIds: pipeline.stages.map((s) => s.id),
  });
  return report;
}
