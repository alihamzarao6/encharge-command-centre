/**
 * Shared fakes for the GoHighLevel unit tests: a config with a deliberately fake token
 * that matches the logger's `pit-` redaction pattern (so "the token never appears" is a
 * real assertion), fixture loading, a programmable fake client and a recording fake store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError, err, ok, type Result } from '../../../../src/lib/errors.js';
import type {
  CustomFieldListing,
  GhlClient,
  OpportunityListing,
} from '../../../../src/lib/crm/ghl/client.js';
import type { GhlConfig } from '../../../../src/lib/crm/ghl/config.js';
import type { Snapshot } from '../../../../src/lib/crm/ghl/map.js';
import type {
  ApplyCounts,
  BeginRunInput,
  FinishRunInput,
  GhlSyncStore,
} from '../../../../src/lib/crm/ghl/sync.js';
import {
  CONTACT_RESPONSE_SCHEMA,
  CUSTOM_FIELD_DEFINITION_SCHEMA,
  OPPORTUNITY_SCHEMA,
  PIPELINES_RESPONSE_SCHEMA,
  type GhlContact,
  type GhlPipeline,
} from '../../../../src/lib/crm/ghl/types.js';

// Fake by construction: all zeros, matches the pit- pattern, is not and cannot be a real token.
export const FAKE_GHL_TOKEN = 'pit-00000000-0000-4000-8000-000000000000';
export const FINANCE_PIPELINE_ID = 'M4unnMKBy0TgwCwOA6wS';
export const LOCATION_ID = 'tgw5Q3BnoZoSsVOnRUxB';
export const STAGE1_FOLDER = 'BEFyPDjs8dlcpRuz3ZcL';
export const FORM_FOLDER = 'fA9zYqgDoZUUN5CKnb5G';

export function ghlConfig(overrides: Partial<GhlConfig> = {}): GhlConfig {
  return {
    token: FAKE_GHL_TOKEN,
    baseUrl: 'https://ghl.test',
    apiVersion: '2021-07-28',
    locationId: LOCATION_ID,
    pipelineId: FINANCE_PIPELINE_ID,
    customFieldFolderIds: [STAGE1_FOLDER, FORM_FOLDER],
    timeoutMs: 1_000,
    retries: 0,
    pageSize: 100,
    maxPages: 50,
    maxContactsPerRun: 2_000,
    staleRunAfterSeconds: 900,
    rateLimitFloor: 5,
    ...overrides,
  };
}

export function ghlFixture(name: string): string {
  return readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'fixtures', 'ghl', `${name}.json`),
    'utf8',
  );
}

export function ghlFixtureJson(name: string): unknown {
  return JSON.parse(ghlFixture(name)) as unknown;
}

/** The Finance Pipeline as the pipelines fixture describes it, already validated. */
export function fixturePipelines(name = 'pipelines'): GhlPipeline[] {
  return PIPELINES_RESPONSE_SCHEMA.parse(ghlFixtureJson(name)).pipelines;
}

export function fixtureOpportunities(name = 'opportunities-all'): OpportunityListing {
  const page = ghlFixtureJson(name) as { opportunities: unknown[]; meta?: { total?: number } };
  const opportunities = page.opportunities.map((o) => OPPORTUNITY_SCHEMA.parse(o));
  return { opportunities, pages: 1, total: page.meta?.total ?? null, rejected: [] };
}

export function fixtureContact(name: string): GhlContact {
  return CONTACT_RESPONSE_SCHEMA.parse(ghlFixtureJson(name)).contact;
}

export function fixtureCustomFields(name = 'custom-fields-clean'): CustomFieldListing {
  const body = ghlFixtureJson(name) as { customFields: unknown[] };
  return {
    definitions: body.customFields.map((f) => CUSTOM_FIELD_DEFINITION_SCHEMA.parse(f)),
    rejected: [],
  };
}

// ---------------------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------------------

export interface FakeGhlClient extends GhlClient {
  pipelines: Result<readonly GhlPipeline[]>;
  opportunities: Result<OpportunityListing>;
  contacts: Map<string, Result<GhlContact | null>>;
  customFields: Result<CustomFieldListing>;
  readonly calls: string[];
  requests: number;
}

export function fakeGhlClient(): FakeGhlClient {
  const contacts = new Map<string, Result<GhlContact | null>>([
    ['CONTACT000000000001', ok(fixtureContact('contact-1'))],
    ['CONTACT000000000002', ok(fixtureContact('contact-2'))],
    ['CONTACT000000000003', ok(fixtureContact('contact-3-minimal'))],
  ]);
  const client: FakeGhlClient = {
    pipelines: ok(fixturePipelines()),
    opportunities: ok(fixtureOpportunities()),
    contacts,
    customFields: ok(fixtureCustomFields()),
    calls: [],
    requests: 0,
    getPipelines: () => {
      client.calls.push('pipelines');
      client.requests += 1;
      return Promise.resolve(client.pipelines);
    },
    listOpportunities: (pipelineId) => {
      client.calls.push(`opportunities:${pipelineId}`);
      client.requests += 1;
      return Promise.resolve(client.opportunities);
    },
    getContact: (contactId) => {
      client.calls.push(`contact:${contactId}`);
      client.requests += 1;
      return Promise.resolve(
        client.contacts.get(contactId) ??
          err(new AppError('INTERNAL', `fake client has no contact ${contactId}`)),
      );
    },
    getCustomFields: () => {
      client.calls.push('customFields');
      client.requests += 1;
      return Promise.resolve(client.customFields);
    },
    requestsMade: () => client.requests,
  };
  return client;
}

// ---------------------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------------------

export const ZERO_APPLY: ApplyCounts = {
  stages_seen: 0,
  stages_added: 0,
  stages_updated: 0,
  stages_removed: 0,
  opportunities_inserted: 0,
  opportunities_updated: 0,
  opportunities_unchanged: 0,
  opportunities_removed: 0,
  contacts_inserted: 0,
  contacts_updated: 0,
  contacts_unchanged: 0,
  contacts_removed: 0,
  custom_fields_seen: 0,
  custom_fields_removed: 0,
};

export interface FakeSyncStore extends GhlSyncStore {
  beginResult: Result<{ runId: string; staleMarked: number }>;
  applyResult: Result<ApplyCounts>;
  finishResult: Result<void>;
  readonly begins: BeginRunInput[];
  readonly snapshots: { runId: string; snapshot: Snapshot }[];
  readonly finishes: FinishRunInput[];
}

export const RUN_ID = 'r0000000-0000-4000-8000-000000000001';

export function fakeSyncStore(): FakeSyncStore {
  const store: FakeSyncStore = {
    beginResult: ok({ runId: RUN_ID, staleMarked: 0 }),
    applyResult: ok({ ...ZERO_APPLY, stages_seen: 10, stages_added: 10 }),
    finishResult: ok(undefined),
    begins: [],
    snapshots: [],
    finishes: [],
    beginRun: (input) => {
      store.begins.push(input);
      return Promise.resolve(store.beginResult);
    },
    applySnapshot: (runId, snapshot) => {
      store.snapshots.push({ runId, snapshot });
      return Promise.resolve(store.applyResult);
    },
    finishRun: (input) => {
      store.finishes.push(input);
      return Promise.resolve(store.finishResult);
    },
  };
  return store;
}

export function conflict(): AppError {
  return new AppError('CONFLICT', 'a GoHighLevel sync is already running');
}

export function unauthenticated(): AppError {
  return new AppError('UNAUTHENTICATED', 'GoHighLevel rejected the token (401)');
}

export function transport(): AppError {
  return new AppError('NETWORK', 'ghl unreachable', { retryable: true });
}

export function validation(): AppError {
  return new AppError('VALIDATION', 'shape mismatch');
}

/** Narrow a possibly-missing value in a test without a non-null assertion. */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}
