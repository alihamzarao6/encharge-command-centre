/**
 * Milestone 5 part 5: an attachment starts being learned the moment it is ready — AFTER the
 * files function has answered. These tests hold that it starts once per new attachment, never
 * for a duplicate or a repeated `finish`, rides `waitUntil`, and can neither slow nor fail the
 * attach itself.
 */
import { describe, expect, it } from 'vitest';

import { handleFilesRequest, type FilesPageResult } from '../../../src/lib/files/page.js';
import { capturingLogger } from '../llm/helpers.js';
import { CONV_ID, HASH, harness, uuid, type Harness } from './helpers.js';

function call(h: Harness, body: unknown): Promise<FilesPageResult> {
  return handleFilesRequest(h.deps, { token: 'token', body });
}

async function attach(
  h: Harness,
  hash = HASH('a'),
): Promise<{ fileId: string; finish: FilesPageResult }> {
  const begun = await call(h, {
    action: 'begin',
    requestId: uuid(),
    conversationId: CONV_ID,
    name: 'transcript.pdf',
    kind: 'pdf',
    byteSize: 4651,
    contentHash: hash,
    totalPages: 1,
    visionPages: 0,
  });
  if (begun.status !== 200 || begun.body.action !== 'begin') throw new Error('begin failed');
  const fileId = begun.body.fileId;
  await call(h, {
    action: 'append',
    fileId,
    pages: [{ pageNo: 1, label: 'Page 1', text: 'Week one.' }],
  });
  return { fileId, finish: await call(h, { action: 'finish', fileId }) };
}

function withLearning(
  h: Harness,
  learn: (fileId: string) => Promise<void>,
): { learned: string[]; kept: Promise<void>[] } {
  const learned: string[] = [];
  const kept: Promise<void>[] = [];
  Object.assign(h, {
    deps: {
      ...h.deps,
      learn: (fileId: string) => {
        learned.push(fileId);
        return learn(fileId);
      },
      waitUntil: (work: Promise<void>) => {
        kept.push(work);
      },
    },
  });
  return { learned, kept };
}

describe('learning starts when a file is attached', () => {
  it('once, for the new attachment, kept alive by waitUntil', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const seen = withLearning(h, () => Promise.resolve());
    const { fileId, finish } = await attach(h);
    expect(finish.status).toBe(200);
    expect(seen.learned).toEqual([fileId]);
    expect(seen.kept).toHaveLength(1);
    // Finishing again is "already": nothing starts twice.
    await call(h, { action: 'finish', fileId });
    expect(seen.learned).toEqual([fileId]);
  });

  it('the same file attached again here is the existing one: nothing new is learned', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const seen = withLearning(h, () => Promise.resolve());
    await attach(h, HASH('b'));
    const again = await attach(h, HASH('b'));
    expect(again.finish.status).toBe(200);
    expect(seen.learned).toHaveLength(1);
  });

  it('a learning step that rejects is logged and changes nothing about the attach', async () => {
    const { log, lines } = capturingLogger();
    const h = harness(log);
    const seen = withLearning(h, () => Promise.reject(new TypeError('voyage exploded: Week one.')));
    const { finish } = await attach(h);
    expect(finish.status).toBe(200);
    await Promise.all(seen.kept);
    const all = lines.join('\n');
    expect(all).toContain('learning a new attachment rejected');
    expect(all).toContain('TypeError');
    expect(all).not.toContain('Week one.');
  });

  it('a learning step that never finishes does not hold the answer', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    withLearning(h, () => new Promise<void>(() => undefined));
    const { finish } = await attach(h);
    expect(finish.status).toBe(200);
  });

  it('without a Voyage key (no `learn`) the attach is exactly as before', async () => {
    const { log } = capturingLogger();
    const h = harness(log);
    const { finish } = await attach(h);
    expect(finish.status).toBe(200);
  });
});
