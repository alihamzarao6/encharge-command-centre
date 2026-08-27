/**
 * The memory page's two pure layers, with no browser:
 *   web/src/lib/memoryApi.ts  — the request shape, what each status means, what the person
 *                               is told, and that a transport failure is an outcome rather
 *                               than a thrown error;
 *   web/src/lib/memoryView.ts — rows into what is on screen: live / removed / replaced, the
 *                               history of one note, and who is offered a Remove button.
 *
 * Part C item 3's interface half (an edited note shows as one note with a visible history)
 * and item 5's interface half (a person is not offered what the server will refuse).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  MEMORY_MESSAGES,
  callMemory,
  interpretMemoryResponse,
  type MemoryRequest,
} from '../../../web/src/lib/memoryApi.js';
import {
  buildChunkList,
  buildFactLists,
  categoryLabel,
  chunkPreview,
  factState,
  formatMemoryDate,
  topicLabel,
  type MemoryChunkRow,
  type MemoryFactRow,
} from '../../../web/src/lib/memoryView.js';

const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';
const ACTOR = { userId: ME, isAdmin: false };

function fact(overrides: Partial<MemoryFactRow> & { id: string }): MemoryFactRow {
  return {
    user_id: ME,
    scope: 'workspace',
    key: 'writing:finance-content',
    value: 'Finance content uses the Rule of One framework.',
    superseded_by: null,
    created_at: '2026-08-27T02:00:00Z',
    ...overrides,
  };
}

function chunk(overrides: Partial<MemoryChunkRow> & { id: string }): MemoryChunkRow {
  return {
    conversation_id: 'conv-1',
    user_id: ME,
    scope: 'workspace',
    summary: 'The user asked for a Meta ad about renting and wanted the headline shortened.',
    audience: 'renters aspiring to homeownership',
    created_at: '2026-08-26T02:00:00Z',
    deleted_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// memoryApi
// ---------------------------------------------------------------------------------------

describe('interpretMemoryResponse', () => {
  it('reads each successful action back into a typed reply', () => {
    expect(
      interpretMemoryResponse(200, {
        action: 'add',
        outcome: 'saved',
        factId: 'f1',
        key: 'writing:tone',
        value: 'Plain words.',
        replaced: true,
      }),
    ).toStrictEqual({
      kind: 'ok',
      reply: {
        action: 'add',
        outcome: 'saved',
        factId: 'f1',
        key: 'writing:tone',
        value: 'Plain words.',
        replaced: true,
      },
    });
    expect(
      interpretMemoryResponse(200, { action: 'forget', outcome: 'forgotten', factId: 'f1' }),
    ).toMatchObject({ kind: 'ok' });
    expect(
      interpretMemoryResponse(200, {
        action: 'delete_chunk',
        outcome: 'deleted',
        chunkId: 'c1',
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(
      interpretMemoryResponse(200, { action: 'add', outcome: 'declined', reason: 'a question' }),
    ).toMatchObject({ kind: 'ok', reply: { outcome: 'declined' } });
  });

  it('a 200 that is not one of those shapes is a failure, not a shrug', () => {
    expect(interpretMemoryResponse(200, { action: 'add' })).toMatchObject({
      kind: 'error',
      code: 'BAD_RESPONSE',
    });
    expect(interpretMemoryResponse(200, null)).toMatchObject({ kind: 'error' });
    expect(interpretMemoryResponse(200, { action: 'forget', outcome: 'nonsense' })).toMatchObject({
      kind: 'error',
    });
  });

  it('401 asks for a fresh sign-in; 403 distinguishes "no access" from "not yours"', () => {
    expect(interpretMemoryResponse(401, {})).toMatchObject({
      failure: 'unauthenticated',
      message: MEMORY_MESSAGES.sessionExpired,
    });
    expect(
      interpretMemoryResponse(403, {
        error: { code: 'FORBIDDEN', message: 'x', retryable: false },
      }),
    ).toMatchObject({ failure: 'forbidden' });
    expect(
      interpretMemoryResponse(403, {
        error: {
          code: 'NOT_YOURS',
          message: 'Only the person who added this, or an administrator, can remove it.',
          retryable: false,
        },
      }),
    ).toMatchObject({
      failure: 'notYours',
      message: 'Only the person who added this, or an administrator, can remove it.',
    });
  });

  it('402 shows the cap message the operator wrote — a person can act on it', () => {
    const outcome = interpretMemoryResponse(402, {
      error: {
        code: 'SPEND_CAP',
        message: 'The monthly Claude spend cap has been reached, so the note was not saved.',
        retryable: false,
      },
    });
    expect(outcome).toMatchObject({ failure: 'cap' });
    if (outcome.kind !== 'error') return;
    expect(outcome.message).toContain('spend cap');
    expect(outcome.message).not.toContain('402');
  });

  it('404 and 409 both mean "the page is out of date", which is what it says', () => {
    expect(interpretMemoryResponse(404, {})).toMatchObject({ failure: 'stale' });
    expect(
      interpretMemoryResponse(409, {
        error: { code: 'ALREADY_REPLACED', message: 'Reload the page.', retryable: false },
      }),
    ).toMatchObject({ failure: 'stale', message: 'Reload the page.' });
  });

  it("an unknown status falls back to the envelope's own retryable flag", () => {
    expect(
      interpretMemoryResponse(418, { error: { code: 'ODD', message: 'x', retryable: true } }),
    ).toMatchObject({ failure: 'retryable', code: 'ODD' });
    expect(interpretMemoryResponse(500, {})).toMatchObject({
      failure: 'fatal',
      message: MEMORY_MESSAGES.unknown,
    });
  });
});

describe('callMemory', () => {
  const deps = (fetchImpl: typeof fetch, timeoutMs?: number): Parameters<typeof callMemory>[0] => ({
    memoryUrl: 'https://stack.test/functions/v1/memory',
    anonKey: 'anon-key-not-a-secret',
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

  it('posts the action as JSON with the session token and the anon key', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ action: 'forget', outcome: 'forgotten', factId: 'f1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

    const request: MemoryRequest = { action: 'forget', factId: 'f1' };
    const outcome = await callMemory(deps(fetchImpl), 'access-token', request);

    expect(outcome).toMatchObject({ kind: 'ok' });
    expect(seen[0]?.url).toBe('https://stack.test/functions/v1/memory');
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.body).toBe(JSON.stringify(request));
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer access-token');
    expect(headers['apikey']).toBe('anon-key-not-a-secret');
  });

  it('a body that is not JSON still becomes a typed outcome', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('<html>gateway</html>', { status: 502 }))) as typeof fetch;
    const outcome = await callMemory(deps(fetchImpl), 'token', { action: 'forget', factId: 'f1' });
    expect(outcome).toMatchObject({ kind: 'error', status: 502 });
  });

  it('a dropped connection is a retryable outcome, never a thrown error', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('failed to fetch'))) as typeof fetch;
    const outcome = await callMemory(deps(fetchImpl), 'token', { action: 'forget', factId: 'f1' });
    expect(outcome).toStrictEqual({
      kind: 'error',
      failure: 'retryable',
      message: MEMORY_MESSAGES.network,
      code: 'NETWORK',
      status: null,
    });
  });

  it('a request that never answers is abandoned and says so', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as unknown as typeof fetch;
    const outcome = await callMemory(deps(fetchImpl, 5), 'token', {
      action: 'forget',
      factId: 'f1',
    });
    expect(outcome).toMatchObject({ code: 'CLIENT_TIMEOUT', message: MEMORY_MESSAGES.timeout });
  });
});

// ---------------------------------------------------------------------------------------
// memoryView
// ---------------------------------------------------------------------------------------

describe('labels', () => {
  it('shows the category as a word a person uses, not the stored slug', () => {
    expect(categoryLabel('writing:finance-content')).toBe('Writing');
    expect(categoryLabel('process:reply-length')).toBe('How it works');
    expect(categoryLabel('nonsense')).toBe('Note');
  });

  it('turns the topic slug back into a phrase', () => {
    expect(topicLabel('writing:finance-content-framework')).toBe('Finance content framework');
    expect(topicLabel('personal:name')).toBe('Name');
    expect(topicLabel('nokey')).toBe('nokey');
  });

  it('dates read in Perth, where the client is', () => {
    // 27 Aug 2026 00:30 UTC is already the 27th in Perth (UTC+8), and 26 Aug 15:00 UTC is
    // the 26th there — a UTC-rendered date would say the 26th and the 26th.
    expect(formatMemoryDate('2026-08-26T20:00:00Z')).toBe('27 Aug 2026');
    expect(formatMemoryDate('not-a-date')).toBe('');
  });
});

describe('factState', () => {
  it('reads all three states off one column', () => {
    expect(factState({ id: 'a', superseded_by: null })).toBe('live');
    expect(factState({ id: 'a', superseded_by: 'a' })).toBe('forgotten');
    expect(factState({ id: 'a', superseded_by: 'b' })).toBe('replaced');
  });
});

describe('buildFactLists', () => {
  it('live notes come back newest first, with their whole history oldest first', () => {
    const rows = [
      fact({ id: 'v1', created_at: '2026-08-20T02:00:00Z', superseded_by: 'v2' }),
      fact({ id: 'v2', created_at: '2026-08-25T02:00:00Z' }),
      fact({
        id: 'other',
        key: 'audience:first-home-buyers',
        created_at: '2026-08-26T02:00:00Z',
      }),
    ];
    const lists = buildFactLists(rows, ACTOR);
    expect(lists.live.map((f) => f.id)).toStrictEqual(['other', 'v2']);
    expect(lists.history['writing:finance-content']?.map((f) => f.id)).toStrictEqual(['v1', 'v2']);
    expect(lists.forgotten).toStrictEqual([]);
  });

  it('a forgotten note leaves the live list and appears once under removed', () => {
    const rows = [
      fact({ id: 'v1', created_at: '2026-08-20T02:00:00Z', superseded_by: 'v2' }),
      fact({ id: 'v2', created_at: '2026-08-25T02:00:00Z', superseded_by: 'v2' }),
    ];
    const lists = buildFactLists(rows, ACTOR);
    expect(lists.live).toStrictEqual([]);
    expect(lists.forgotten.map((f) => f.id)).toStrictEqual(['v2']);
    expect(lists.forgotten[0]?.state).toBe('forgotten');
    // The whole story is still readable under the note.
    expect(lists.history['writing:finance-content']).toHaveLength(2);
  });

  it('a note forgotten and then stated again is live, and not also listed as removed', () => {
    const rows = [
      fact({ id: 'v1', created_at: '2026-08-20T02:00:00Z', superseded_by: 'v1' }),
      fact({ id: 'v2', created_at: '2026-08-25T02:00:00Z' }),
    ];
    const lists = buildFactLists(rows, ACTOR);
    expect(lists.live.map((f) => f.id)).toStrictEqual(['v2']);
    expect(lists.forgotten).toStrictEqual([]);
  });

  it("offers Remove on your own notes and not on a teammate's, unless you are an admin", () => {
    const rows = [
      fact({ id: 'mine' }),
      fact({ id: 'theirs', user_id: THEM, key: 'offer:sessions' }),
    ];
    const asStaff = buildFactLists(rows, ACTOR);
    expect(asStaff.live.map((f) => ({ id: f.id, canRemove: f.canRemove, byYou: f.byYou }))).toEqual(
      expect.arrayContaining([
        { id: 'mine', canRemove: true, byYou: true },
        { id: 'theirs', canRemove: false, byYou: false },
      ]),
    );
    const asAdmin = buildFactLists(rows, { userId: ME, isAdmin: true });
    expect(asAdmin.live.every((f) => f.canRemove)).toBe(true);
  });

  it('a null value renders as empty rather than as the word "null"', () => {
    const lists = buildFactLists([fact({ id: 'v1', value: null })], ACTOR);
    expect(lists.live[0]?.value).toBe('');
  });
});

describe('chunkPreview', () => {
  it('leaves a short note alone', () => {
    expect(chunkPreview('Short note.')).toBe('Short note.');
  });

  it('cuts a long note at a word boundary and marks it', () => {
    const long = `${'word '.repeat(60)}end`;
    const preview = chunkPreview(long, 40);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(41);
    expect(preview).not.toContain('wor…');
  });

  it('collapses the whitespace a summariser sometimes leaves', () => {
    expect(chunkPreview('  two   lines\n  here ')).toBe('two lines here');
  });

  it('does not leave the punctuation of the sentence it cut into', () => {
    // '…blunter.…' reads like a typo; '…blunter…' reads like a cut.
    expect(chunkPreview('He asked for it shorter and blunter. Then he changed his mind.', 37)).toBe(
      'He asked for it shorter and blunter…',
    );
  });
});

describe('buildChunkList', () => {
  const titles = new Map<string, string | null>([['conv-1', 'Renting vs buying ad']]);

  it('shows the conversation it came from, the date and the audience', () => {
    const [view] = buildChunkList([chunk({ id: 'c1' })], titles, ACTOR);
    expect(view).toMatchObject({
      id: 'c1',
      conversationId: 'conv-1',
      conversationTitle: 'Renting vs buying ad',
      audience: 'renters aspiring to homeownership',
      when: '26 Aug 2026',
      byYou: true,
      canRemove: true,
    });
  });

  it('a note whose conversation is gone still lists, with no title to open', () => {
    const [view] = buildChunkList(
      [chunk({ id: 'c1', conversation_id: 'vanished' })],
      titles,
      ACTOR,
    );
    expect(view?.conversationTitle).toBeNull();
  });

  it('never shows a deleted note, whatever the query returned', () => {
    const views = buildChunkList(
      [chunk({ id: 'c1', deleted_at: '2026-08-27T00:00:00Z' }), chunk({ id: 'c2' })],
      titles,
      ACTOR,
    );
    expect(views.map((v) => v.id)).toStrictEqual(['c2']);
  });

  it("does not offer Delete on a teammate's note to a non-admin", () => {
    const [view] = buildChunkList([chunk({ id: 'c1', user_id: THEM })], titles, ACTOR);
    expect(view?.canRemove).toBe(false);
    expect(view?.byYou).toBe(false);
  });
});
