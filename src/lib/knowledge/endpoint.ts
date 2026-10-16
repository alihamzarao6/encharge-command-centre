/**
 * The `knowledge-drain` action of the `memory` Edge Function (Milestone 5 part 5): what the
 * database's scheduler calls every minute while a document is waiting to be learned.
 *
 * It answers only a valid two-minute token (schedule.ts) and only with ids and counts. Every
 * refusal is the same 401 with no hint of which check failed, except "not configured", which
 * is a 503 so a misdeployment shows up as itself in the function's logs.
 */
import type { Logger } from '../logger.js';
import { drainKnowledge, type DrainReport, type KnowledgeIngestDeps } from './ingest.js';
import { checkDrainToken } from './schedule.js';

export interface DrainEndpointDeps {
  /** Null without a Voyage key: nothing can be learned. */
  readonly ingest: KnowledgeIngestDeps | null;
  readonly secret: string | null;
  readonly log: Logger;
  readonly now?: () => number;
}

export type DrainEndpointResult =
  | { readonly status: 200; readonly body: { readonly drain: DrainReport } }
  | {
      readonly status: 401 | 500 | 503;
      readonly body: { readonly error: { readonly code: string; readonly message: string } };
    };

export async function handleDrainRequest(
  deps: DrainEndpointDeps,
  token: string | null,
): Promise<DrainEndpointResult> {
  const log = deps.log.child({ component: 'knowledge.endpoint' });
  const checked = await checkDrainToken(token, deps.secret, (deps.now ?? Date.now)());
  if (!checked.ok) {
    log.warn('knowledge drain request refused', { reason: checked.reason });
    if (checked.reason === 'not_configured') {
      return {
        status: 503,
        body: { error: { code: 'NOT_CONFIGURED', message: 'The drain is not configured.' } },
      };
    }
    return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Not allowed.' } } };
  }
  if (deps.ingest === null) {
    log.warn('knowledge drain asked for, but there is no Voyage key');
    return {
      status: 503,
      body: { error: { code: 'NO_EMBEDDINGS', message: 'Embeddings are not configured.' } },
    };
  }
  const drained = await drainKnowledge(deps.ingest);
  if (!drained.ok) {
    return {
      status: 500,
      body: { error: { code: drained.error.code, message: 'The drain failed.' } },
    };
  }
  return { status: 200, body: { drain: drained.value } };
}
