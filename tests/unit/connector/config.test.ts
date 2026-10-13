/**
 * The connector's settings, the body reader, and the one place the public path is configured
 * (MCP connector, stage 1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBodyCapped } from '../../../src/lib/connector/body.js';
import {
  CONNECTOR_DEFAULTS,
  FUNCTION_PATH,
  loadConnectorConfig,
} from '../../../src/lib/connector/config.js';
import { createConnectorDeps } from '../../../src/lib/connector/wiring.js';
import { capturingLogger } from '../llm/helpers.js';

const BASE = {
  GHL_PIPELINE_ID: 'M4unnMKBy0TgwCwOA6wS',
  SUPABASE_URL: 'https://project.supabase.test',
};

describe('loadConnectorConfig', () => {
  it('needs one thing: the pipeline id. Everything else has a default', () => {
    const config = loadConnectorConfig(BASE);
    expect(config.ok && config.value).toEqual({
      pipelineId: 'M4unnMKBy0TgwCwOA6wS',
      publicUrl: `https://project.supabase.test${FUNCTION_PATH}`,
      allowedOrigins: [],
      perMinute: 30,
      perDay: 1_000,
      timeoutMs: 8_000,
      maxBodyBytes: 64 * 1024,
    });
    expect(CONNECTOR_DEFAULTS).toMatchObject({ perMinute: 30, perDay: 1_000 });
  });

  it('refuses to start without a pipeline, or with something that is not an id', () => {
    for (const env of [
      {},
      { GHL_PIPELINE_ID: '  ' },
      { ...BASE, GHL_PIPELINE_ID: 'Finance Pipeline' },
    ]) {
      const config = loadConnectorConfig(env);
      expect(config.ok).toBe(false);
      expect(!config.ok && config.error.message).toContain('GHL_PIPELINE_ID');
    }
  });

  it('the public address is ONE setting: set it and nothing else changes', () => {
    const config = loadConnectorConfig({
      ...BASE,
      CONNECTOR_PUBLIC_URL: 'https://app.client-domain.test/mcp/',
    });
    expect(config.ok && config.value.publicUrl).toBe('https://app.client-domain.test/mcp');
    const bare = loadConnectorConfig({ GHL_PIPELINE_ID: 'p1' });
    expect(!bare.ok && bare.error.message).toBe('CONNECTOR_PUBLIC_URL or SUPABASE_URL is required');
    for (const bad of [
      'http://app.client-domain.test/mcp',
      'https://app.client-domain.test/mcp?key=1',
      'https://app.client-domain.test/mcp#x',
      'https://user:pass@app.client-domain.test/mcp',
      'not an address',
    ]) {
      const refused = loadConnectorConfig({ ...BASE, CONNECTOR_PUBLIC_URL: bad });
      expect(refused.ok, bad).toBe(false);
      // The message names the variable and never repeats the value.
      expect(!refused.ok && refused.error.message).toContain('CONNECTOR_PUBLIC_URL');
      expect(!refused.ok && refused.error.message).not.toContain('pass');
    }
  });

  it('the limits are settings with hard bounds', () => {
    const tuned = loadConnectorConfig({
      ...BASE,
      CONNECTOR_RATE_PER_MINUTE: '60',
      CONNECTOR_RATE_PER_DAY: '5000',
      CONNECTOR_TIMEOUT_MS: '3000',
    });
    expect(tuned.ok && tuned.value).toMatchObject({
      perMinute: 60,
      perDay: 5_000,
      timeoutMs: 3_000,
    });
    for (const [name, value] of [
      ['CONNECTOR_RATE_PER_MINUTE', '0'],
      ['CONNECTOR_RATE_PER_MINUTE', '121'],
      ['CONNECTOR_RATE_PER_MINUTE', 'lots'],
      ['CONNECTOR_RATE_PER_DAY', '10001'],
      ['CONNECTOR_RATE_PER_DAY', '1.5'],
      ['CONNECTOR_TIMEOUT_MS', '10'],
    ] as const) {
      const refused = loadConnectorConfig({ ...BASE, [name]: value });
      expect(!refused.ok && refused.error.message, `${name}=${value}`).toContain(name);
    }
  });

  it('allowed origins are origins, exactly', () => {
    const config = loadConnectorConfig({
      ...BASE,
      CONNECTOR_ALLOWED_ORIGINS: 'https://a.example, http://localhost:6274 ,,',
    });
    expect(config.ok && config.value.allowedOrigins).toEqual([
      'https://a.example',
      'http://localhost:6274',
    ]);
    for (const bad of ['a.example', 'https://a.example/path', '*', 'null']) {
      expect(loadConnectorConfig({ ...BASE, CONNECTOR_ALLOWED_ORIGINS: bad }).ok, bad).toBe(false);
    }
  });
});

describe('createConnectorDeps', () => {
  const { log } = capturingLogger();
  const env = {
    ...BASE,
    SUPABASE_ANON_KEY: 'anon-test-value',
    SUPABASE_SERVICE_ROLE_KEY: 'service-test-value',
  };

  it('wires a key check and one store, and nothing of GoHighLevel', () => {
    const deps = createConnectorDeps(env, log);
    expect(deps.ok).toBe(true);
    if (!deps.ok) return;
    expect(Object.keys(deps.value).sort()).toEqual(['authenticator', 'config', 'log', 'store']);
    expect(deps.value.config.pipelineId).toBe(BASE.GHL_PIPELINE_ID);
    expect(deps.value.authenticator.challenge()).toContain('Bearer');
  });

  it('a missing setting is named, and its value never is', () => {
    const noSupabase = createConnectorDeps({ GHL_PIPELINE_ID: 'p1' }, log);
    expect(noSupabase.ok).toBe(false);
    const noPipeline = createConnectorDeps({ ...env, GHL_PIPELINE_ID: undefined }, log);
    expect(!noPipeline.ok && noPipeline.error.message).toContain('GHL_PIPELINE_ID');
    expect(JSON.stringify(noPipeline)).not.toContain('service-test-value');
  });
});

describe('the public path — configured in one place', () => {
  const vercel = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'vercel.json'), 'utf8'),
  ) as {
    rewrites: { source: string; destination: string }[];
  };

  it('/mcp is rewritten to the connector function, ahead of the page that catches everything else', () => {
    expect(vercel.rewrites[0]).toEqual({
      source: '/mcp',
      destination: expect.stringMatching(
        /^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/connector$/,
      ) as string,
    });
    expect(vercel.rewrites.at(-1)).toEqual({ source: '/(.*)', destination: '/index.html' });
    expect(
      vercel.rewrites.filter((rewrite) => rewrite.destination.includes('supabase.co')),
    ).toHaveLength(1);
    expect(vercel.rewrites[0]?.destination.endsWith(FUNCTION_PATH)).toBe(true);
    // No query string and no key in configuration: the key travels in a header.
    expect(JSON.stringify(vercel)).not.toMatch(/[?&](key|token|apikey)=/i);
  });
});

describe('readBodyCapped', () => {
  const stream = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('reads a body under the limit, whole, across chunks', async () => {
    expect(
      await readBodyCapped(stream([bytes('{"a":'), bytes('"\u{1F3E0}"}')]), null, 100),
    ).toEqual({
      ok: true,
      text: '{"a":"\u{1F3E0}"}',
    });
    expect(await readBodyCapped(null, null, 100)).toEqual({ ok: true, text: '' });
    expect(await readBodyCapped(stream([bytes('x'.repeat(100))]), '100', 100)).toEqual({
      ok: true,
      text: 'x'.repeat(100),
    });
  });

  it('a declared length over the limit is refused before a byte is read', async () => {
    let pulled = false;
    // highWaterMark 0: the stream produces nothing until somebody actually reads it.
    const untouched = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(bytes('x'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    expect(await readBodyCapped(untouched, '65537', 65_536)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(pulled).toBe(false);
  });

  it('a body that lies about its length, or gives none, is dropped the moment it passes the limit', async () => {
    let sent = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(1_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readBodyCapped(endless, '10', 5_000)).toEqual({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(20);
    expect(await readBodyCapped(stream([bytes('x'.repeat(101))]), null, 100)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    // A length that is not a number is ignored, not trusted.
    expect(await readBodyCapped(stream([bytes('ok')]), 'lots', 100)).toEqual({
      ok: true,
      text: 'ok',
    });
  });

  it('bytes that are not UTF-8, or a stream that breaks, are unreadable — not a crash', async () => {
    expect(await readBodyCapped(stream([Uint8Array.from([0xff, 0xfe, 0xfd])]), null, 100)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    expect(await readBodyCapped(broken, null, 100)).toEqual({ ok: false, reason: 'unreadable' });
  });
});
