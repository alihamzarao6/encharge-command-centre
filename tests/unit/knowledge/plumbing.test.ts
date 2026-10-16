/**
 * The knowledge layer's plumbing: its configuration (defaults are the decisions on record, a
 * malformed value is refused by name), the drain's two-minute token (the D111 scheme with its
 * own secret), the endpoint the scheduler calls, the coverage record the screen reads, and the
 * wiring that builds it all only when there is a Voyage key.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NetworkError } from '../../../src/lib/errors.js';
import { KNOWLEDGE_DEFAULTS, loadKnowledgeConfig } from '../../../src/lib/knowledge/config.js';
import {
  DOCUMENT_COVERAGE,
  MAX_COVERAGE_PAGES,
  coverageNeedsNote,
  coveragePages,
  summaryRuns,
  type CoverageDocument,
  type DocumentCoverage,
} from '../../../src/lib/knowledge/coverage.js';
import { handleDrainRequest } from '../../../src/lib/knowledge/endpoint.js';
import { createLocalKnowledgeStore } from '../../../src/lib/knowledge/local-store.js';
import {
  DRAIN_SECRET_ENV,
  checkDrainToken,
  drainTokenFor,
  readDrainSecret,
} from '../../../src/lib/knowledge/schedule.js';
import {
  createChatKnowledge,
  createKnowledgeIngest,
  createTurnQuery,
} from '../../../src/lib/knowledge/wiring.js';
import { createChatDeps } from '../../../src/lib/llm/wiring.js';
import { createFilesPageDeps } from '../../../src/lib/files/wiring.js';
import { capturingLogger } from '../llm/helpers.js';
import { fakeEmbedder } from './helpers.js';

const SECRET = 's'.repeat(43);

describe('configuration', () => {
  it('defaults are the decisions on record, set for the free Voyage plan as measured', () => {
    expect(loadKnowledgeConfig({})).toEqual({ ok: true, value: KNOWLEDGE_DEFAULTS });
    expect(KNOWLEDGE_DEFAULTS.embed).toMatchObject({
      batchChars: 12_000,
      requestsPerRun: 2,
      gapMs: 25_000,
      cooldownSeconds: 65,
    });
    expect(KNOWLEDGE_DEFAULTS.retrieval).toMatchObject({
      candidates: 40,
      minSimilarity: 0.3,
      neighbours: 1,
    });
  });

  it('the paid plan is a change of numbers, not of code', () => {
    const paid = loadKnowledgeConfig({
      KNOWLEDGE_EMBED_BATCH_CHARS: '100000',
      KNOWLEDGE_EMBED_REQUESTS_PER_RUN: '20',
      KNOWLEDGE_EMBED_GAP_MS: '0',
      KNOWLEDGE_RETRIEVAL_MIN_SIMILARITY: '0.35',
    });
    expect(paid.ok && paid.value.embed).toMatchObject({
      batchChars: 100_000,
      requestsPerRun: 20,
      gapMs: 0,
    });
    expect(paid.ok && paid.value.retrieval.minSimilarity).toBe(0.35);
  });

  it('summaries can be turned off, or set to start at another size, by environment alone', () => {
    const off = loadKnowledgeConfig({
      KNOWLEDGE_SUMMARY: 'off',
      KNOWLEDGE_SUMMARY_MIN_CHARS: '50000',
      KNOWLEDGE_SUMMARY_BLOCK_CHARS: '30000',
    });
    expect(off.ok && off.value.summary).toMatchObject({
      enabled: false,
      minChars: 50_000,
      blockChars: 30_000,
      maxAttempts: KNOWLEDGE_DEFAULTS.summary.maxAttempts,
    });
    expect(loadKnowledgeConfig({ KNOWLEDGE_SUMMARY: 'on' })).toEqual({
      ok: true,
      value: KNOWLEDGE_DEFAULTS,
    });
  });

  it.each([
    ['KNOWLEDGE_EMBED_BATCH_CHARS', '500'],
    ['KNOWLEDGE_EMBED_BATCH_INPUTS', '200'],
    ['KNOWLEDGE_EMBED_REQUESTS_PER_RUN', '0'],
    ['KNOWLEDGE_EMBED_GAP_MS', '-1'],
    ['KNOWLEDGE_EMBED_TIMEOUT_MS', 'soon'],
    ['KNOWLEDGE_COOLDOWN_SECONDS', '0'],
    ['KNOWLEDGE_AUTH_COOLDOWN_SECONDS', '10'],
    ['KNOWLEDGE_LEASE_SECONDS', '9999'],
    ['KNOWLEDGE_CAPTURES_PER_RUN', '0'],
    ['KNOWLEDGE_RETRIEVAL_CANDIDATES', '1.5'],
    ['KNOWLEDGE_RETRIEVAL_MIN_SIMILARITY', '1.2'],
    ['KNOWLEDGE_RETRIEVAL_NEIGHBOURS', '9'],
    ['KNOWLEDGE_QUERY_TIMEOUT_MS', '10'],
    ['KNOWLEDGE_QUERY_REWRITE_TIMEOUT_MS', '5'],
    ['KNOWLEDGE_RETRIEVAL_ATTACHED_MIN_SIMILARITY', '-0.1'],
    ['KNOWLEDGE_QUERY_REWRITE', 'maybe'],
    ['KNOWLEDGE_SUMMARY', 'sometimes'],
    ['KNOWLEDGE_SUMMARY_MIN_CHARS', '-1'],
    ['KNOWLEDGE_SUMMARY_BLOCK_CHARS', '100'],
  ])('a malformed %s is refused by name', (name, value) => {
    const loaded = loadKnowledgeConfig({ [name]: value });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('CONFIG');
      expect(loaded.error.message).toContain(name);
      expect(loaded.error.message).not.toContain(value === '0' ? 'nothing' : value);
    }
  });
});

describe('the migration’s scheduler, read as text (the GHL schedule’s rules, D111)', () => {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'supabase',
      'migrations',
      '20261017010000_knowledge.sql',
    ),
    'utf8',
  );

  it('sends one request, from one place, only to an https address read from Vault at call time', () => {
    expect(sql.match(/net\.http_post\(/g)).toHaveLength(1);
    expect(sql.match(/vault\.decrypted_secrets/g)).toHaveLength(2);
    expect(sql).toContain("s.name = 'knowledge_drain_url'");
    expect(sql).toContain("s.name = 'knowledge_drain_secret'");
    expect(sql).toMatch(/\^https:\/\//);
    expect(sql).not.toMatch(/vault\.create_secret|vault\.update_secret/);
  });

  it('sends a token, never the secret, and the dispatcher is the owner’s alone', () => {
    expect(sql).toContain("'x-knowledge-drain-token', v_token");
    expect(sql).not.toMatch(/'x-knowledge-drain-token',\s*v_secret/);
    expect(sql).toMatch(
      /revoke all on function public\.dispatch_knowledge_drain\(\) from public, anon, authenticated, service_role;/,
    );
    expect(sql).not.toMatch(/grant execute on function public\.dispatch_knowledge_drain/);
    expect(sql).not.toMatch(/security definer/i);
  });

  it('the triggers inside `finish` and `remove` reach nothing outside the database', () => {
    const triggers = sql
      .slice(sql.indexOf('(7) The triggers'), sql.indexOf('(8) Learning'))
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(triggers).toContain('create trigger conversation_files_knowledge_enqueue_update');
    expect(triggers).not.toMatch(/net\.|vault\.|dispatch_knowledge_drain/);
  });

  it('files attached before the deploy are enqueued once, by the migration, owner only (17 Oct)', () => {
    // Without it, a long file attached before the deploy is never learned, and its own
    // conversation falls back to "couldn't be searched … only its opening pages".
    expect(sql.match(/select public\.knowledge_enqueue_ready_files\(\);/g)).toHaveLength(1);
    expect(sql).toMatch(
      /revoke all on function public\.knowledge_enqueue_ready_files\(\) from public, anon, authenticated, service_role;/,
    );
    expect(sql).not.toMatch(/grant execute on function public\.knowledge_enqueue_ready_files/);
  });
});

describe('the drain token', () => {
  it('accepts the token the database makes, within two minutes, with the secret this function holds', async () => {
    const now = 1_792_020_180_000;
    const token = await drainTokenFor(SECRET, now / 1_000);
    expect(token).toMatch(/^\d{10}\.[0-9a-f]{64}$/);
    expect(await checkDrainToken(token, SECRET, now + 60_000)).toEqual({ ok: true });
  });

  it('refuses everything else, and an unconfigured function accepts nothing', async () => {
    const now = 1_792_020_180_000;
    const token = await drainTokenFor(SECRET, now / 1_000);
    expect(await checkDrainToken(token, SECRET, now + 121_000)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(await checkDrainToken(token, 't'.repeat(43), now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(await checkDrainToken('nonsense', SECRET, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await checkDrainToken(null, SECRET, now)).toEqual({ ok: false, reason: 'nothing_sent' });
    expect(await checkDrainToken(token, null, now)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(await checkDrainToken(token, 'short', now)).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  it('the GoHighLevel schedule’s token does not open this door (different action in the HMAC)', async () => {
    const { scheduleTokenFor } = await import('../../../src/lib/crm/schedule.js');
    const now = 1_792_020_180_000;
    const crmToken = await scheduleTokenFor(SECRET, now / 1_000);
    expect(await checkDrainToken(crmToken, SECRET, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('reads its own secret only, and only one long enough to have been generated', () => {
    expect(readDrainSecret({ [DRAIN_SECRET_ENV]: SECRET })).toBe(SECRET);
    expect(readDrainSecret({ [DRAIN_SECRET_ENV]: 'short' })).toBeNull();
    expect(readDrainSecret({ CRM_SCHEDULE_SECRET: SECRET })).toBeNull();
  });
});

describe('the endpoint the scheduler calls', () => {
  const ingest = () => ({
    store: createLocalKnowledgeStore(),
    embedder: fakeEmbedder(),
    config: KNOWLEDGE_DEFAULTS.embed,
    log: capturingLogger().log,
  });

  it('a valid token runs one drain and answers with counts only', async () => {
    const token = await drainTokenFor(SECRET, Math.floor(Date.now() / 1_000));
    const result = await handleDrainRequest(
      { ingest: ingest(), secret: SECRET, log: capturingLogger().log },
      token,
    );
    expect(result).toEqual({
      status: 200,
      body: { drain: expect.objectContaining({ outcome: 'drained', requests: 0 }) as unknown },
    });
  });

  it('a bad token is 401 with no hint; an unconfigured function is 503; no Voyage key is 503', async () => {
    const { log, lines } = capturingLogger();
    expect((await handleDrainRequest({ ingest: ingest(), secret: SECRET, log }, 'x')).status).toBe(
      401,
    );
    expect(lines.join('\n')).toContain('"reason":"malformed"');
    expect((await handleDrainRequest({ ingest: ingest(), secret: null, log }, 'x')).status).toBe(
      503,
    );
    const token = await drainTokenFor(SECRET, Math.floor(Date.now() / 1_000));
    expect((await handleDrainRequest({ ingest: null, secret: SECRET, log }, token)).status).toBe(
      503,
    );
  });

  it('a drain whose lease cannot be read is a 500, not a pretend success', async () => {
    const broken = {
      ...ingest(),
      store: {
        ...createLocalKnowledgeStore(),
        claimDrain: () => Promise.resolve({ ok: false as const, error: new NetworkError('db') }),
      },
    };
    const token = await drainTokenFor(SECRET, Math.floor(Date.now() / 1_000));
    expect(
      (
        await handleDrainRequest(
          { ingest: broken, secret: SECRET, log: capturingLogger().log },
          token,
        )
      ).status,
    ).toBe(500);
  });
});

describe('the coverage record', () => {
  it('whole documents alone need no note; anything partial, missing, still learning or a failed search does', () => {
    const doc: CoverageDocument = {
      origin: 'attached',
      kind: 'pdf',
      mode: 'whole',
      pages: [1],
      total: 1,
    };
    const whole: DocumentCoverage = { v: 1, documents: [doc] };
    expect(coverageNeedsNote(whole)).toBe(false);
    expect(coverageNeedsNote(null)).toBe(false);
    expect(coverageNeedsNote(undefined)).toBe(false);
    expect(coverageNeedsNote({ ...whole, documents: [{ ...doc, mode: 'part' }] })).toBe(true);
    expect(coverageNeedsNote({ v: 1, documents: [], searchFailed: true })).toBe(true);
  });

  it('summarised page runs are sorted, touching runs joined, and the schema keeps them (17 Oct)', () => {
    expect(
      summaryRuns([
        { from: 8, to: 14 },
        { from: 1, to: 7 },
        { from: 20, to: 21 },
      ]),
    ).toEqual([
      { from: 1, to: 14 },
      { from: 20, to: 21 },
    ]);
    const doc = {
      origin: 'learned',
      kind: 'pdf',
      mode: 'part',
      pages: [4],
      total: 33,
      summary: [{ from: 1, to: 33 }],
    };
    expect(DOCUMENT_COVERAGE.parse({ v: 1, documents: [doc] }).documents[0]?.summary).toEqual([
      { from: 1, to: 33 },
    ]);
    expect(
      DOCUMENT_COVERAGE.safeParse({ v: 1, documents: [{ ...doc, summary: [{ from: 0, to: 3 }] }] })
        .success,
    ).toBe(false);
  });

  it('page lists are sorted, unique, and cut with the true count kept', () => {
    expect(coveragePages([3, 1, 3, 2])).toEqual({ pages: [1, 2, 3] });
    const many = coveragePages(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(many.pages).toHaveLength(MAX_COVERAGE_PAGES);
    expect(many.shownCount).toBe(300);
  });

  it('the schema refuses a name or anything it does not know', () => {
    expect(
      DOCUMENT_COVERAGE.safeParse({
        v: 1,
        documents: [
          { origin: 'attached', kind: 'pdf', mode: 'whole', pages: [1], total: 1, name: 'x.pdf' },
        ],
      }).success,
    ).toBe(true);
    const parsed = DOCUMENT_COVERAGE.parse({
      v: 1,
      documents: [
        { origin: 'attached', kind: 'pdf', mode: 'whole', pages: [1], total: 1, name: 'x.pdf' },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('x.pdf');
    expect(DOCUMENT_COVERAGE.safeParse({ v: 2, documents: [] }).success).toBe(false);
    expect(
      DOCUMENT_COVERAGE.safeParse({
        v: 1,
        documents: [{ origin: 'stolen', kind: 'pdf', mode: 'whole', pages: [], total: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe('wiring', () => {
  const SUPABASE = {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
  };
  const LLM = {
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_DAILY_SPEND_CAP_USD: '5',
    ANTHROPIC_MONTHLY_SPEND_CAP_USD: '50',
  };

  it('without a Voyage key nothing is built, and the chat and files endpoints run without knowledge', () => {
    const { log } = capturingLogger();
    expect(createKnowledgeIngest(SUPABASE, log)).toEqual({ ok: true, value: null });
    expect(createChatKnowledge(SUPABASE, log)).toEqual({ ok: true, value: null });
    const chat = createChatDeps({ ...SUPABASE, ...LLM }, log);
    expect(chat.ok && chat.value.query).toBeUndefined();
    const files = createFilesPageDeps({ ...SUPABASE, ...LLM }, log);
    expect(files.ok && files.value.learn).toBeUndefined();
  });

  it('with a key: the drain, the search and the per-turn query are built; a malformed knowledge value is a CONFIG error', () => {
    const { log } = capturingLogger();
    const env = { ...SUPABASE, ...LLM, VOYAGE_API_KEY: 'pa-test' };
    const ingest = createKnowledgeIngest(env, log);
    expect(ingest.ok && ingest.value?.config).toEqual(KNOWLEDGE_DEFAULTS.embed);
    const chat = createChatDeps(env, log);
    expect(chat.ok && typeof chat.value.query?.embed).toBe('function');
    const files = createFilesPageDeps(env, log, { waitUntil: () => undefined });
    expect(files.ok && typeof files.value.learn).toBe('function');
    expect(files.ok && typeof files.value.waitUntil).toBe('function');
    for (const bad of [{ KNOWLEDGE_EMBED_GAP_MS: 'x' }, { VOYAGE_BASE_URL: 'http://plain' }]) {
      expect(createKnowledgeIngest({ ...env, ...bad }, log).ok).toBe(false);
      expect(createChatKnowledge({ ...env, ...bad }, log).ok).toBe(false);
      expect(createChatDeps({ ...env, ...bad }, log).ok).toBe(false);
    }
    expect(createKnowledgeIngest({ VOYAGE_API_KEY: 'pa-test' }, log).ok).toBe(false);
  });

  it('the per-turn query gives up at its timeout and says so, rather than holding the reply', async () => {
    const { log } = capturingLogger();
    const query = createTurnQuery(
      {
        apiKey: 'pa-test',
        baseUrl: 'https://voyage.invalid',
        model: 'voyage-3',
        dimensions: 1024,
        timeoutMs: 50,
        retries: 0,
        pricePerMTok: 0.06,
        caps: { dailyUsd: 1, monthlyUsd: 5, warnFraction: 0.8 },
      },
      { url: 'https://never.invalid', anonKey: 'a', serviceRoleKey: 's', timeoutMs: 10_000 },
      50,
      log,
    );
    const started = Date.now();
    const result = await query.embed({
      text: 'week one',
      message: 'week one',
      previousUserMessage: null,
      userId: 'u',
      conversationId: null,
    });
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
