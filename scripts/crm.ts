/**
 * GoHighLevel sync runner (Milestone 4 part 1). READ-ONLY against GoHighLevel.
 *
 *   npm run crm -- read            read the configured pipeline from the LIVE account and
 *                                  print a summary of the snapshot the sync would apply —
 *                                  ids, counts, and a hash of the whole snapshot — with
 *                                  NO database involved. Run it twice and compare the hash:
 *                                  that is the "two consecutive reads agree" evidence.
 *   npm run crm -- sync            run a full sync into the database (the trigger Part 2
 *                                  will call from the server). Needs SUPABASE_* and GHL_*.
 *   npm run crm -- runs [--limit N]
 *                                  print the most recent sync runs, newest first.
 *
 * Output is JSON on stdout and contains no secret and no person's details: GHL ids and
 * counts only (CLAUDE.md rule 20).
 */
import { createHash } from 'node:crypto';

import { loadSupabaseAuthConfig } from '../src/lib/auth/clients.js';
import { createGhlClient } from '../src/lib/crm/ghl/client.js';
import { loadGhlConfig } from '../src/lib/crm/ghl/config.js';
import {
  canonicalJson,
  toContactRow,
  toOpportunityRow,
  toPipelineRow,
  toStageRow,
  type Snapshot,
} from '../src/lib/crm/ghl/map.js';
import {
  createGhlServiceClient,
  listGhlSyncRuns,
  supabaseGhlSyncStore,
} from '../src/lib/crm/ghl/store.js';
import { runGhlSync } from '../src/lib/crm/ghl/sync.js';
import { createHttpClient } from '../src/lib/http.js';
import { logger } from '../src/lib/logger.js';

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`crm: ${message}\n`);
  process.exit(1);
}

function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env — the real environment applies.
  }
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const log = logger.child({ script: 'crm' });

  const ghlConfig = loadGhlConfig(process.env);
  if (!ghlConfig.ok) fail(ghlConfig.error.message);
  const http = createHttpClient({ timeoutMs: ghlConfig.value.timeoutMs, logger: log });
  const client = createGhlClient({ config: ghlConfig.value, http, log });

  switch (command) {
    case 'read': {
      const pipelines = await client.getPipelines();
      if (!pipelines.ok) fail(`pipelines: ${pipelines.error.code} — ${pipelines.error.message}`);
      const pipeline = pipelines.value.find((p) => p.id === ghlConfig.value.pipelineId);
      if (pipeline === undefined) {
        fail(
          `GHL_PIPELINE_ID ${ghlConfig.value.pipelineId} not found; ids present: ${pipelines.value.map((p) => p.id).join(', ')}`,
        );
      }
      const listing = await client.listOpportunities(pipeline.id);
      if (!listing.ok) fail(`opportunities: ${listing.error.code} — ${listing.error.message}`);
      const contactIds = [
        ...new Set(
          listing.value.opportunities
            .map((o) => o.contactId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const contacts: ReturnType<typeof toContactRow>[] = [];
      const contactFailures: { id: string; code: string }[] = [];
      for (const id of contactIds) {
        const contact = await client.getContact(id);
        if (!contact.ok) {
          contactFailures.push({ id, code: contact.error.code });
          continue;
        }
        if (contact.value === null) {
          contactFailures.push({ id, code: 'NOT_FOUND' });
          continue;
        }
        contacts.push(toContactRow(contact.value));
      }
      const definitions = await client.getCustomFields();
      const snapshot: Snapshot = {
        pipeline: toPipelineRow(pipeline, ghlConfig.value.locationId),
        stages: pipeline.stages.map(toStageRow),
        opportunities_complete: listing.value.rejected.length === 0,
        opportunities: listing.value.opportunities.map(toOpportunityRow),
        contacts,
        custom_fields_complete: definitions.ok && definitions.value.rejected.length === 0,
        custom_fields: [],
      };
      const byStage: Record<string, number> = {};
      for (const o of snapshot.opportunities) {
        byStage[o.stage_ghl_id] = (byStage[o.stage_ghl_id] ?? 0) + 1;
      }
      const fieldIdsSeen = new Set(contacts.flatMap((c) => Object.keys(c.custom_fields)));
      out({
        pipeline: { id: snapshot.pipeline.ghl_id, name: snapshot.pipeline.name },
        stages: snapshot.stages.map((s) => ({ id: s.ghl_id, position: s.position, name: s.name })),
        opportunities: {
          fetched: snapshot.opportunities.length,
          pages: listing.value.pages,
          total: listing.value.total,
          rejected: listing.value.rejected,
          byStage,
          byStatus: countBy(snapshot.opportunities.map((o) => o.status)),
          monetaryValues: countBy(
            snapshot.opportunities.map((o) =>
              o.monetary_value === null ? 'null' : o.monetary_value === 0 ? 'zero' : 'non-zero',
            ),
          ),
          hashes: snapshot.opportunities.map((o) => ({ id: o.ghl_id, hash: o.content_hash })),
        },
        contacts: {
          fetched: contacts.length,
          failures: contactFailures,
          withEmail: contacts.filter((c) => c.email !== null).length,
          withPhone: contacts.filter((c) => c.phone !== null).length,
          customFieldIdsSeen: [...fieldIdsSeen].sort(),
          hashes: contacts.map((c) => ({ id: c.ghl_id, hash: c.content_hash })),
        },
        customFieldDefinitions: definitions.ok
          ? { fetched: definitions.value.definitions.length, rejected: definitions.value.rejected }
          : { error: definitions.error.code },
        snapshotHash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'),
        requests: client.requestsMade(),
      });
      return;
    }
    case 'sync': {
      const supabase = loadSupabaseAuthConfig(process.env);
      if (!supabase.ok) fail(supabase.error.message);
      const store = supabaseGhlSyncStore(createGhlServiceClient(supabase.value));
      const report = await runGhlSync(
        { client, store, config: ghlConfig.value, log },
        { trigger: 'cli' },
      );
      out(report);
      if (report.status === 'failed' || report.status === 'refused') process.exit(2);
      return;
    }
    case 'runs': {
      const supabase = loadSupabaseAuthConfig(process.env);
      if (!supabase.ok) fail(supabase.error.message);
      const limit = Number(flag(rest, '--limit') ?? '10');
      const runs = await listGhlSyncRuns(createGhlServiceClient(supabase.value), limit);
      if (!runs.ok) fail(`${runs.error.code} — ${runs.error.message}`);
      out(runs.value);
      return;
    }
    case undefined:
    default:
      fail('usage: npm run crm -- read | sync | runs [--limit N]');
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

main().catch((caught: unknown) => {
  fail(caught instanceof Error ? caught.message : 'unknown failure');
});
