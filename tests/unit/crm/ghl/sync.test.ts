/**
 * The sync (src/lib/crm/ghl/sync.ts) over a fake client and a recording store — the run
 * edge cases of the M4 part 1 brief: a second run refused, an unknown pipeline id failing
 * loudly, a dead token aborting mid-run, a contact that vanished / failed / was malformed
 * making the run partial and listed by id, removals held back from an incomplete read,
 * the caps refusing rather than truncating, and the snapshot being exactly what the
 * database is asked to apply.
 */
import { describe, expect, it } from 'vitest';

import { AppError, err, ok } from '../../../../src/lib/errors.js';
import { runGhlSync } from '../../../../src/lib/crm/ghl/sync.js';
import { capturingLogger } from '../../llm/helpers.js';
import {
  FINANCE_PIPELINE_ID,
  FORM_FOLDER,
  RUN_ID,
  STAGE1_FOLDER,
  conflict,
  fakeGhlClient,
  fakeSyncStore,
  fixtureOpportunities,
  fixturePipelines,
  ghlConfig,
  transport,
  unauthenticated,
  validation,
  must,
} from './helpers.js';

function harness(overrides: Parameters<typeof ghlConfig>[0] = {}) {
  const client = fakeGhlClient();
  const store = fakeSyncStore();
  const { log, lines } = capturingLogger();
  let tick = 1_000;
  const deps = { client, store, config: ghlConfig(overrides), log, now: () => (tick += 250) };
  return { client, store, lines, deps };
}

describe('a successful run', () => {
  it('claims the slot, reads by id, applies one snapshot and closes the run', async () => {
    const h = harness();
    const report = await runGhlSync(h.deps, { trigger: 'test', triggeredBy: 'u1' });

    expect(report.status).toBe('success');
    expect(report.runId).toBe(RUN_ID);
    expect(report.error).toBeNull();
    expect(report.errors).toEqual([]);
    expect(h.store.begins).toEqual([
      {
        pipelineId: FINANCE_PIPELINE_ID,
        trigger: 'test',
        triggeredBy: 'u1',
        staleAfterSeconds: 900,
      },
    ]);
    // Two opportunities share a contact and one has none: two contact reads, not four.
    expect(h.client.calls).toEqual([
      'pipelines',
      `opportunities:${FINANCE_PIPELINE_ID}`,
      'contact:CONTACT000000000001',
      'contact:CONTACT000000000002',
      'customFields',
    ]);

    expect(h.store.snapshots).toHaveLength(1);
    const snapshot = must(h.store.snapshots[0]).snapshot;
    expect(must(h.store.snapshots[0]).runId).toBe(RUN_ID);
    expect(snapshot.pipeline).toEqual({
      ghl_id: FINANCE_PIPELINE_ID,
      name: 'Finance Pipeline',
      location_id: 'tgw5Q3BnoZoSsVOnRUxB',
      ghl_updated_at: '2026-08-24T01:38:07.564Z',
    });
    expect(snapshot.stages.map((s) => s.ghl_id)).toEqual(
      must(fixturePipelines().find((p) => p.id === FINANCE_PIPELINE_ID)).stages.map((s) => s.id),
    );
    expect(snapshot.opportunities_complete).toBe(true);
    expect(snapshot.opportunities.map((o) => o.ghl_id)).toEqual([
      'OPP0000000000000001',
      'OPP0000000000000002',
      'OPP0000000000000003',
      'OPP0000000000000004',
    ]);
    expect(snapshot.contacts.map((c) => c.ghl_id)).toEqual([
      'CONTACT000000000001',
      'CONTACT000000000002',
    ]);
    expect(snapshot.custom_fields_complete).toBe(true);
    // Definitions kept: every field in the two configured folders (9 + 3) plus the one a
    // synced contact carries outside them (the Message field); the decoy in another folder
    // that nobody carries is left out.
    const kept = snapshot.custom_fields.map((f) => f.ghl_id).sort();
    expect(kept).toHaveLength(13);
    expect(kept).toContain('3ma6Czg50bY5yhJ18zrD');
    expect(kept).not.toContain('7pR62a3yZcOtnmF2sJrQ');
    expect(
      snapshot.custom_fields.every(
        (f) =>
          f.parent_id === STAGE1_FOLDER ||
          f.parent_id === FORM_FOLDER ||
          f.ghl_id === '3ma6Czg50bY5yhJ18zrD',
      ),
    ).toBe(true);

    expect(h.store.finishes).toEqual([
      {
        runId: RUN_ID,
        status: 'success',
        errorCode: null,
        error: null,
        errors: [],
        counts: {
          requests: 5,
          pages_fetched: 1,
          opportunities_fetched: 4,
          opportunities_rejected: 0,
          contacts_fetched: 2,
          contacts_failed: 0,
          contacts_rejected: 0,
          contacts_missing: 0,
          custom_fields_fetched: 14,
        },
      },
    ]);
    expect(report.apply).toEqual(h.store.applyResult.ok ? h.store.applyResult.value : null);
    expect(report.durationMs).toBeGreaterThan(0);
    const finished = h.lines.find((l) => l.includes('ghl sync finished'));
    expect(finished).toContain('"status":"success"');
    expect(finished).toContain('"stageIds"');
    for (const line of h.lines) expect(line).not.toContain('synthetic@example.com');
  });

  it('a renamed and reordered pipeline changes nothing about how stages are keyed', async () => {
    const h = harness();
    h.client.pipelines = ok(fixturePipelines('pipelines-changed'));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('success');
    const stages = must(h.store.snapshots[0]).snapshot.stages;
    expect(stages.find((s) => s.ghl_id === '51c98561-cd26-49a9-a001-97536c31dd0a')?.name).toBe(
      'Lead In ',
    );
    expect(stages.some((s) => s.ghl_id === '9cef8b67-1171-4347-9275-36e1055a97aa')).toBe(false);
    expect(must(h.store.snapshots[0]).snapshot.pipeline.name).toBe('Fundd Pipeline ');
  });

  it('an empty pipeline applies an empty, complete snapshot and succeeds', async () => {
    const h = harness();
    h.client.opportunities = ok(fixtureOpportunities('opportunities-empty'));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('success');
    const snapshot = must(h.store.snapshots[0]).snapshot;
    expect(snapshot.opportunities).toEqual([]);
    expect(snapshot.contacts).toEqual([]);
    expect(snapshot.opportunities_complete).toBe(true);
    expect(h.client.calls).not.toContain('contact:CONTACT000000000001');
  });

  it('a deleted opportunity is simply absent from a complete snapshot — the database marks it', async () => {
    const h = harness();
    h.client.opportunities = ok(fixtureOpportunities('opportunities-all-changed'));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('success');
    const snapshot = must(h.store.snapshots[0]).snapshot;
    expect(snapshot.opportunities_complete).toBe(true);
    expect(snapshot.opportunities.map((o) => o.ghl_id)).not.toContain('OPP0000000000000002');
    expect(h.client.calls).not.toContain('contact:CONTACT000000000002');
  });
});

describe('the run being refused or unable to start', () => {
  it('a second concurrent run is refused before any GHL call', async () => {
    const h = harness();
    h.store.beginResult = err(conflict());
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('refused');
    expect(report.runId).toBeNull();
    expect(report.error?.code).toBe('CONFLICT');
    expect(h.client.calls).toEqual([]);
    expect(h.store.snapshots).toEqual([]);
    expect(h.store.finishes).toEqual([]);
    expect(h.lines.some((l) => l.includes('another run is in progress'))).toBe(true);
  });

  it('a store that cannot create the run row fails without fetching', async () => {
    const h = harness();
    h.store.beginResult = err(transport());
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(report.runId).toBeNull();
    expect(h.client.calls).toEqual([]);
  });
});

describe('failing loudly', () => {
  it('an unknown pipeline id fails the run with CONFIG — never "zero opportunities"', async () => {
    const h = harness({ pipelineId: 'doesnotexist000000' });
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('CONFIG');
    expect(report.error?.message).toContain('doesnotexist000000');
    expect(h.client.calls).toEqual(['pipelines']);
    expect(h.store.snapshots).toEqual([]);
    expect(h.store.finishes[0]).toMatchObject({ status: 'failed', errorCode: 'CONFIG' });
    expect(
      h.lines.some((l) => l.includes('"level":"error"') && l.includes('pipeline id not found')),
    ).toBe(true);
  });

  it('a dead token on the first call fails the run as UNAUTHENTICATED', async () => {
    const h = harness();
    h.client.pipelines = err(unauthenticated());
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('UNAUTHENTICATED');
    expect(h.store.finishes[0]).toMatchObject({ status: 'failed', errorCode: 'UNAUTHENTICATED' });
  });

  it('a dead token mid-way through the contacts aborts the run and stops calling', async () => {
    const h = harness();
    h.client.contacts.set('CONTACT000000000001', err(unauthenticated()));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('UNAUTHENTICATED');
    expect(h.client.calls).toEqual([
      'pipelines',
      `opportunities:${FINANCE_PIPELINE_ID}`,
      'contact:CONTACT000000000001',
    ]);
    expect(h.store.snapshots).toEqual([]);
    expect(report.errors).toEqual([{ kind: 'contact', id: null, code: 'UNAUTHENTICATED' }]);
  });

  it('an opportunity read failure fails the run and applies nothing', async () => {
    const h = harness();
    h.client.opportunities = err(transport());
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(h.store.snapshots).toEqual([]);
    expect(h.store.finishes[0]?.status).toBe('failed');
  });

  it('the contact cap refuses rather than syncing a partial set', async () => {
    const h = harness({ maxContactsPerRun: 1 });
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('INTERNAL');
    expect(report.error?.message).toContain('GHL_MAX_CONTACTS_PER_RUN');
    expect(h.client.calls.filter((c) => c.startsWith('contact:'))).toEqual([]);
  });

  it('a failed apply fails the run and the snapshot is not counted as applied', async () => {
    const h = harness();
    h.store.applyResult = err(new AppError('HTTP_STATUS', 'apply_ghl_snapshot: boom'));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('failed');
    expect(report.apply).toBeNull();
    expect(h.store.finishes[0]).toMatchObject({ status: 'failed', errorCode: 'HTTP_STATUS' });
  });

  it('a run row that cannot be closed is logged and listed, and the data still applied', async () => {
    const h = harness();
    h.store.finishResult = err(transport());
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('success');
    expect(report.errors).toEqual([{ kind: 'finish', id: null, code: 'NETWORK' }]);
    expect(h.lines.some((l) => l.includes('could not be closed'))).toBe(true);
  });
});

describe('partial runs — counted, listed by id, never silent', () => {
  it('a contact that GHL no longer has (404) makes the run partial and is listed', async () => {
    const h = harness();
    h.client.contacts.set('CONTACT000000000002', ok(null));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('partial');
    expect(report.fetch.contacts_missing).toBe(1);
    expect(report.errors).toEqual([
      { kind: 'contact', id: 'CONTACT000000000002', code: 'NOT_FOUND' },
    ]);
    expect(must(h.store.snapshots[0]).snapshot.contacts.map((c) => c.ghl_id)).toEqual([
      'CONTACT000000000001',
    ]);
    // The opportunity still syncs with its contact id; the row is what is missing.
    expect(
      must(h.store.snapshots[0]).snapshot.opportunities.find(
        (o) => o.ghl_id === 'OPP0000000000000002',
      )?.contact_ghl_id,
    ).toBe('CONTACT000000000002');
  });

  it('a contact fetch that fails on transport is counted as failed and the run continues', async () => {
    const h = harness();
    h.client.contacts.set('CONTACT000000000001', err(transport()));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('partial');
    expect(report.fetch.contacts_failed).toBe(1);
    expect(report.fetch.contacts_fetched).toBe(1);
    expect(report.errors).toEqual([
      { kind: 'contact', id: 'CONTACT000000000001', code: 'NETWORK' },
    ]);
    expect(h.store.finishes[0]?.status).toBe('partial');
  });

  it('a malformed contact is rejected, counted, and never half-written', async () => {
    const h = harness();
    h.client.contacts.set('CONTACT000000000001', err(validation()));
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('partial');
    expect(report.fetch.contacts_rejected).toBe(1);
    expect(report.errors).toEqual([
      { kind: 'contact', id: 'CONTACT000000000001', code: 'REJECTED_SHAPE' },
    ]);
    expect(must(h.store.snapshots[0]).snapshot.contacts.map((c) => c.ghl_id)).toEqual([
      'CONTACT000000000002',
    ]);
  });

  it('a rejected opportunity makes the read incomplete: removals are held back this run', async () => {
    const h = harness();
    const listing = fixtureOpportunities();
    h.client.opportunities = ok({
      ...listing,
      rejected: [{ id: 'OPP00000000000000BAD', reason: 'shape' }],
    });
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('partial');
    expect(report.fetch.opportunities_rejected).toBe(1);
    expect(report.errors).toContainEqual({
      kind: 'opportunity',
      id: 'OPP00000000000000BAD',
      code: 'REJECTED_SHAPE',
    });
    expect(must(h.store.snapshots[0]).snapshot.opportunities_complete).toBe(false);
    expect(h.lines.some((l) => l.includes('removals will not be marked'))).toBe(true);
  });

  it('fewer opportunities than GHL reported in total is also an incomplete read', async () => {
    const h = harness();
    h.client.opportunities = ok({ ...fixtureOpportunities(), total: 5 });
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('success');
    expect(must(h.store.snapshots[0]).snapshot.opportunities_complete).toBe(false);
  });

  it('a failed definitions read leaves the stored definitions untouched and makes the run partial', async () => {
    const h = harness();
    h.client.customFields = err(transport());
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('partial');
    expect(report.errors).toEqual([{ kind: 'custom_fields', id: null, code: 'NETWORK' }]);
    const snapshot = must(h.store.snapshots[0]).snapshot;
    expect(snapshot.custom_fields).toEqual([]);
    expect(snapshot.custom_fields_complete).toBe(false);
    expect(snapshot.opportunities_complete).toBe(true);
  });

  it('a rejected definition keeps the others and holds back definition removals', async () => {
    const h = harness();
    const listing = h.client.customFields.ok ? h.client.customFields.value : null;
    h.client.customFields = ok({
      definitions: must(listing).definitions,
      rejected: [{ id: 'BROKENFIELD000000001', reason: 'shape' }],
    });
    const report = await runGhlSync(h.deps, { trigger: 'test' });
    expect(report.status).toBe('partial');
    expect(must(h.store.snapshots[0]).snapshot.custom_fields_complete).toBe(false);
    expect(must(h.store.snapshots[0]).snapshot.custom_fields.length).toBe(13);
  });
});
