/**
 * Learning a document (Milestone 5 part 5): from an attachment that just became ready, to
 * chunks the whole account can retrieve by meaning.
 *
 * Two steps, deliberately apart because they fail for different reasons:
 *
 *   CAPTURE — cut the attachment's stored pages into chunks (chunk.ts) and store them, with no
 *   call to anyone. Done the moment the file is attached (the files function, after it has
 *   answered), so a page whose text is kept one day can never be purged before it was
 *   learned. The same bytes already learned with the same chunker are COPIED instead, chunks
 *   and embeddings both: attaching a file twice costs no Voyage request.
 *
 *   EMBED — send the chunks to Voyage in batches and attach the vectors. On the free plan this
 *   is the slow part (three requests a minute, ~12,000 characters a request), so it is a
 *   queue: a run takes the database lease, sends at most `requestsPerRun` batches
 *   `gapMs` apart, and stops at the first refusal, resting the queue for `cooldownSeconds`
 *   before anyone may try again. Nothing inside a run retries: the embedder used here is built
 *   with no retries, because a retried 429 is three requests where one was refused.
 *
 *   SUMMARISE — a document too long to reach a question nearly whole gets a summary, written once
 *   by the fast model (summarise.ts) between capture and embedding: nothing of it is embedded
 *   until the summary is in, so it cannot turn ready without one. A run writes at most one.
 *
 * A document becomes retrievable from other conversations only when its last chunk is
 * embedded (the database flips it in the same statement), so an interrupted run leaves a
 * document that is visibly still being learned — never a half document passing as whole.
 *
 * Every outcome is logged with ids, counts, sizes and timings. Never a name, never text.
 */
import { HttpStatusError, ensureError, err, ok, type AppError, type Result } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ClaudeClient } from '../llm/client.js';
import type { Embedder } from '../memory/embed.js';
import { CHUNKER_VERSION, chunkPages, embeddingText } from './chunk.js';
import type { KnowledgeEmbedConfig, KnowledgeSummaryConfig } from './config.js';
import type { KnowledgeStore, PendingSource } from './store.js';
import { summariseSource } from './summarise.js';

export const KNOWLEDGE_EMBED_OPERATION = 'knowledge.embed';

export interface KnowledgeIngestDeps {
  readonly store: KnowledgeStore;
  /** Built with retries 0 and the ingestion timeout (wiring.ts). */
  readonly embedder: Embedder;
  readonly config: KnowledgeEmbedConfig;
  /** The fast model that writes summaries; absent (no key, or turned off) means none are written. */
  readonly summaries?: { readonly claude: ClaudeClient; readonly config: KnowledgeSummaryConfig };
  readonly log: Logger;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
}

export type CaptureOutcome =
  'captured' | 'copied' | 'text_gone' | 'no_text' | 'not_pending' | 'failed';

export type DrainOutcome =
  /** Nothing waiting to be embedded. */
  | 'drained'
  /** The run used its requests; more is waiting for the next run. */
  | 'more'
  /** Another drain holds the lease, or Voyage is resting. */
  | 'busy'
  | 'rate_limited'
  | 'unavailable'
  | 'unauthorised'
  | 'spend_cap'
  | 'invalid_response'
  | 'store_failed';

export interface DrainReport {
  readonly outcome: DrainOutcome;
  readonly captured: number;
  readonly copied: number;
  readonly failedCaptures: number;
  readonly requests: number;
  readonly chunksEmbedded: number;
  readonly sourcesReady: number;
  /** Summaries written this run (at most one document's). */
  readonly summarised: number;
  readonly costUsd: number;
  readonly elapsedMs: number;
  /** When busy: how long until the lease or the rest ends. */
  readonly waitMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** One pending source → chunks. Idempotent; never throws. */
export async function captureSource(
  deps: KnowledgeIngestDeps,
  source: PendingSource,
): Promise<CaptureOutcome> {
  const log = deps.log.child({ component: 'knowledge.capture', sourceId: source.id });
  const started = (deps.now ?? Date.now)();
  const copied = await deps.store.copyFromTwin(source.id, CHUNKER_VERSION);
  if (copied.ok && copied.value) {
    log.info('knowledge copied from the same bytes, no embedding needed', {
      elapsedMs: (deps.now ?? Date.now)() - started,
    });
    return 'copied';
  }
  if (!copied.ok) log.warn('twin check failed; capturing instead', { error: copied.error });

  const pages = source.fileId === null ? ok(null) : await deps.store.pagesOfFile(source.fileId);
  if (!pages.ok) {
    log.error('pages could not be read for capture', { error: pages.error });
    return 'failed';
  }
  if (pages.value === null) {
    const failed = await deps.store.fail(source.id, 'text_gone');
    log.warn('attachment text gone before it was learned', { marked: failed.ok && failed.value });
    return 'text_gone';
  }
  // The name may give the section when the text introduces none (chunk.ts sectionFromName).
  const chunks = chunkPages(pages.value, source.name);
  if (chunks.length === 0) {
    const failed = await deps.store.fail(source.id, 'no_text');
    log.warn('nothing to learn: no words on any page', {
      pages: pages.value.length,
      marked: failed.ok && failed.value,
    });
    return 'no_text';
  }
  const chunkChars = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
  const summarise =
    deps.summaries !== undefined &&
    deps.summaries.config.enabled &&
    chunkChars >= deps.summaries.config.minChars;
  const stored = await deps.store.capture(source.id, CHUNKER_VERSION, chunks, summarise);
  if (!stored.ok) {
    log.error('chunks not stored', { error: stored.error, chunks: chunks.length });
    return 'failed';
  }
  log.info('knowledge captured', {
    outcome: stored.value.status === 'learning' ? 'captured' : 'not_pending',
    pages: pages.value.length,
    chunks: stored.value.chunkCount,
    chars: chunkChars,
    summarise,
    elapsedMs: (deps.now ?? Date.now)() - started,
  });
  return stored.value.status === 'learning' ? 'captured' : 'not_pending';
}

interface Refusal {
  readonly outcome: DrainOutcome;
  readonly cooldownSeconds: number;
}

/** What a failed embedding call means for the queue. */
export function classifyEmbedFailure(error: AppError, config: KnowledgeEmbedConfig): Refusal {
  switch (error.code) {
    case 'RATE_LIMITED':
      return { outcome: 'rate_limited', cooldownSeconds: config.cooldownSeconds };
    case 'SPEND_CAP':
      // The Voyage cap is daily and monthly; an hour is long enough not to hammer the ledger.
      return { outcome: 'spend_cap', cooldownSeconds: 3_600 };
    case 'VALIDATION':
      return { outcome: 'invalid_response', cooldownSeconds: config.cooldownSeconds };
    case 'HTTP_STATUS': {
      const code = error instanceof HttpStatusError ? error.status : 0;
      if (code === 401 || code === 403) {
        return { outcome: 'unauthorised', cooldownSeconds: config.authCooldownSeconds };
      }
      return { outcome: 'unavailable', cooldownSeconds: config.cooldownSeconds };
    }
    case 'TIMEOUT':
    case 'NETWORK':
    case 'CIRCUIT_OPEN':
    case 'CONFIG':
    case 'UNKNOWN_THROWN':
    case 'INTERNAL':
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'CONFLICT':
    case 'MODEL_REFUSAL':
      return { outcome: 'unavailable', cooldownSeconds: config.cooldownSeconds };
  }
}

/**
 * One run of the queue: capture what is pending, then embed in paced batches. Holds the lease
 * for the whole run and always gives it back, with the rest Voyage asked for. Never throws.
 */
export async function drainKnowledge(deps: KnowledgeIngestDeps): Promise<Result<DrainReport>> {
  const log = deps.log.child({ component: 'knowledge.drain' });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const started = now();
  const holder = (deps.newId ?? (() => crypto.randomUUID()))();
  const config = deps.config;

  const claim = await deps.store.claimDrain(holder, config.leaseSeconds);
  if (!claim.ok) {
    log.error('drain lease unavailable', { error: claim.error });
    return err(claim.error);
  }
  if (!claim.value.claimed) {
    const report: DrainReport = {
      outcome: 'busy',
      captured: 0,
      copied: 0,
      failedCaptures: 0,
      requests: 0,
      chunksEmbedded: 0,
      sourcesReady: 0,
      summarised: 0,
      costUsd: 0,
      elapsedMs: now() - started,
      waitMs: claim.value.waitMs,
    };
    log.info('knowledge drain skipped', { outcome: 'busy', waitMs: claim.value.waitMs });
    return ok(report);
  }

  let outcome: DrainOutcome = 'drained';
  let cooldownSeconds = 0;
  let captured = 0;
  let copied = 0;
  let failedCaptures = 0;
  let requests = 0;
  let chunksEmbedded = 0;
  let sourcesReady = 0;
  let summarised = 0;
  let costUsd = 0;
  try {
    const pending = await deps.store.pendingSources(config.capturesPerRun);
    if (pending.ok) {
      for (const source of pending.value) {
        const result = await captureSource(deps, source);
        if (result === 'captured') captured += 1;
        else if (result === 'copied') copied += 1;
        else if (result !== 'not_pending') failedCaptures += 1;
      }
    } else {
      log.error('pending documents could not be read', { error: pending.error });
    }

    // One document's summary per run, before anything is embedded; the deadline below leaves
    // the embedding for the next run when the summary took most of this one.
    const waiting = await deps.store.summaryPending(deps.summaries === undefined ? 50 : 1);
    if (!waiting.ok) {
      log.error('documents waiting for a summary could not be read', { error: waiting.error });
    } else if (deps.summaries?.config.enabled !== true) {
      // Nothing here can write one: never leave a document waiting for a summary for ever.
      for (const source of waiting.value) await deps.store.failSummary(source.id, 0);
    } else {
      for (const source of waiting.value) {
        const report = await summariseSource(
          {
            store: deps.store,
            claude: deps.summaries.claude,
            config: deps.summaries.config,
            log: deps.log,
            ...(deps.now === undefined ? {} : { now: deps.now }),
          },
          source,
        );
        costUsd += report.costUsd;
        if (report.outcome === 'done') summarised += 1;
      }
    }

    // The run must end inside its lease: the next request has to fit, with its pause.
    const deadline = started + config.leaseSeconds * 1_000 - 5_000;
    for (;;) {
      const batch = await deps.store.nextBatch(
        config.batchChars,
        config.batchInputs,
        embeddingText,
      );
      if (!batch.ok) {
        log.error('next batch could not be read', { error: batch.error });
        outcome = 'store_failed';
        break;
      }
      if (batch.value === null) {
        outcome = 'drained';
        break;
      }
      if (requests >= config.requestsPerRun) {
        outcome = 'more';
        break;
      }
      const pause = requests === 0 ? 0 : config.gapMs;
      if (now() + pause + config.timeoutMs > deadline) {
        outcome = 'more';
        break;
      }
      if (pause > 0) await sleep(pause);

      const { sourceId, sourceName, chunks, waiting } = batch.value;
      const texts = chunks.map((chunk) => embeddingText(sourceName, chunk));
      const sentAt = now();
      const embedded = await deps.embedder.embed({
        texts,
        inputType: 'document',
        operation: KNOWLEDGE_EMBED_OPERATION,
        userId: null,
        conversationId: null,
      });
      requests += 1;
      if (!embedded.ok) {
        const refusal = classifyEmbedFailure(embedded.error, config);
        outcome = refusal.outcome;
        cooldownSeconds = refusal.cooldownSeconds;
        const fields = {
          sourceId,
          outcome,
          inputs: texts.length,
          chars: texts.reduce((n, t) => n + t.length, 0),
          ms: now() - sentAt,
          cooldownSeconds,
          error: embedded.error,
        };
        if (outcome === 'unauthorised' || outcome === 'spend_cap') {
          log.error('knowledge embedding refused; the queue is resting', fields);
        } else {
          log.warn('knowledge embedding refused; the queue is resting', fields);
        }
        break;
      }
      costUsd += embedded.value.costUsd;
      const vectors = embedded.value.vectors;
      const attached = await deps.store.attachEmbeddings(
        sourceId,
        chunks.map((chunk, index) => ({ ordinal: chunk.ordinal, vector: vectors[index] ?? [] })),
      );
      if (!attached.ok) {
        log.error('embeddings not stored', { sourceId, error: attached.error });
        outcome = 'store_failed';
        break;
      }
      chunksEmbedded += chunks.length;
      if (attached.value.status === 'ready') sourcesReady += 1;
      log.info('knowledge batch embedded', {
        sourceId,
        inputs: chunks.length,
        chars: texts.reduce((n, t) => n + t.length, 0),
        tokens: embedded.value.totalTokens,
        costUsd: embedded.value.costUsd,
        ms: now() - sentAt,
        waitingBefore: waiting,
        embedded: attached.value.embeddedCount,
        of: attached.value.chunkCount,
        status: attached.value.status,
      });
    }
  } catch (caught: unknown) {
    log.error('knowledge drain threw', { error: ensureError(caught) });
    outcome = 'store_failed';
  } finally {
    const released = await deps.store.releaseDrain(holder, outcome, cooldownSeconds);
    if (!released.ok)
      log.error('drain lease not released; it expires on its own', { error: released.error });
  }

  const report: DrainReport = {
    outcome,
    captured,
    copied,
    failedCaptures,
    requests,
    chunksEmbedded,
    sourcesReady,
    summarised,
    costUsd,
    elapsedMs: now() - started,
  };
  log.info('knowledge drain run', { ...report });
  return ok(report);
}

/**
 * The files function's fast path, after it has answered: capture this one attachment at once,
 * then run the queue. Never throws and never rejects — it runs under `waitUntil`.
 */
export async function learnAttachment(deps: KnowledgeIngestDeps, fileId: string): Promise<void> {
  const log = deps.log.child({ component: 'knowledge.learn', fileId });
  try {
    const source = await deps.store.sourceForFile(fileId);
    if (!source.ok) {
      log.error('learning not started: source unreadable; the schedule will pick it up', {
        error: source.error,
      });
    } else if (source.value === null) {
      log.warn('no knowledge source for a ready attachment');
    } else if (source.value.status === 'pending') {
      await captureSource(deps, source.value);
    }
    const drained = await drainKnowledge(deps);
    if (!drained.ok) log.error('drain after attach failed', { error: drained.error });
  } catch (caught: unknown) {
    log.error('learning after attach threw', { error: ensureError(caught) });
  }
}
