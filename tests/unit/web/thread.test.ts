/**
 * The shared conversation store (web/src/lib/thread.ts): one thread, two surfaces.
 *
 * Part D item 13 at the unit level: two subscribers — standing in for the docked panel and
 * the Assistant page — read one store, and a message sent through one is in the other's
 * snapshot before the reply has finished arriving. Plus the behaviour that moved here from
 * Assistant.tsx, re-proven: the D76 in-flight record, the streaming bubble, the failed
 * bubble with Retry, the 401 that hands the draft across the login screen, and the
 * "you left mid-send" restore.
 */
import { describe, expect, it } from 'vitest';

import type { ChatOutcome, StreamHandlers, TurnInput } from '../../../web/src/lib/chatApi.js';
import { PENDING_KEY, type DraftStorage, type PendingDraft } from '../../../web/src/lib/draft.js';
import {
  LEFT_MID_SEND_NOTICE,
  createThreadStore,
  type ThreadDeps,
  type ThreadMessage,
  type ThreadState,
} from '../../../web/src/lib/thread.js';

const CONV = 'c0000000-0000-4000-8000-000000000001';

function memoryStorage(): DraftStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function saved(id: string, role: 'user' | 'assistant', content: string): ThreadMessage {
  return { localId: id, id, role, content, status: 'saved' };
}

interface Script {
  readonly deltas?: readonly string[];
  readonly outcome: (input: TurnInput) => ChatOutcome;
  /** Resolves when the store may finish the turn; lets a test look mid-stream. */
  readonly gate?: Promise<void>;
}

interface Harness {
  readonly store: ReturnType<typeof createThreadStore>;
  readonly storage: ReturnType<typeof memoryStorage>;
  readonly turns: TurnInput[];
  readonly expired: (PendingDraft | null)[];
  readonly snapshots: { readonly page: ThreadState[]; readonly panel: ThreadState[] };
  readonly messages: Map<string, readonly ThreadMessage[] | null>;
}

function makeHarness(script: Script): Harness {
  const storage = memoryStorage();
  const turns: TurnInput[] = [];
  const expired: (PendingDraft | null)[] = [];
  const messages = new Map<string, readonly ThreadMessage[] | null>();
  const deps: ThreadDeps = {
    storage,
    loadMessages: (id) => {
      const scripted = messages.get(id);
      return Promise.resolve(scripted === undefined ? [] : scripted);
    },
    streamTurn: async (input: TurnInput, handlers: StreamHandlers) => {
      turns.push(input);
      const outcome = script.outcome(input);
      if (outcome.kind === 'ok' || script.deltas !== undefined) handlers.onStart?.(CONV);
      for (const delta of script.deltas ?? []) handlers.onDelta(delta);
      await script.gate;
      return outcome;
    },
    getAccessToken: () => Promise.resolve('token'),
    onSessionExpired: (pending) => {
      expired.push(pending);
      return Promise.resolve();
    },
  };
  const store = createThreadStore(deps);
  const snapshots = { page: [] as ThreadState[], panel: [] as ThreadState[] };
  store.subscribe(() => snapshots.page.push(store.getState()));
  store.subscribe(() => snapshots.panel.push(store.getState()));
  return { store, storage, turns, expired, snapshots, messages };
}

const REPLY_OK = (text: string): ChatOutcome => ({
  kind: 'ok',
  conversationId: CONV,
  userMessageId: 'u-1',
  assistantMessageId: 'a-1',
  reply: text,
});

describe('one thread, two surfaces', () => {
  it('a message sent through one subscriber is in the other before the reply completes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ deltas: ['Hel', 'lo'], outcome: () => REPLY_OK('Hello'), gate });

    const sending = h.store.send('Write a post', null);
    await Promise.resolve();
    await Promise.resolve();
    // Mid-stream: both surfaces see the user's message and the growing reply.
    const mid = h.store.getState();
    expect(mid.sending).toBe(true);
    // A page mounting now must show THIS thread, not run its first-load restore over it.
    expect(mid.initialised).toBe(true);
    expect(mid.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'Write a post', 'sending'],
      ['assistant', 'Hello', 'streaming'],
    ]);
    expect(h.snapshots.panel.at(-1)).toBe(h.snapshots.page.at(-1));
    expect(h.snapshots.panel.at(-1)).toBe(mid);

    release();
    await sending;
    const done = h.store.getState();
    expect(done.sending).toBe(false);
    expect(done.activeId).toBe(CONV);
    expect(done.turnsSaved).toBe(1);
    expect(done.messages.map((m) => [m.role, m.content, m.status, m.id])).toEqual([
      ['user', 'Write a post', 'saved', 'u-1'],
      ['assistant', 'Hello', 'saved', 'a-1'],
    ]);
    // A reply landed: the shell may say so until a surface showing the thread marks it seen.
    expect(done.unseenReply).toBe(true);
    h.store.markSeen();
    expect(h.store.getState().unseenReply).toBe(false);
    // Two subscribers, one state object: they cannot disagree.
    expect(h.snapshots.page.length).toBe(h.snapshots.panel.length);
    expect(h.snapshots.page.at(-1)).toBe(h.snapshots.panel.at(-1));
  });

  it('the second message carries the conversation id the first one was given', async () => {
    const h = makeHarness({ outcome: () => REPLY_OK('ok') });
    await h.store.send('one', null);
    await h.store.send('two', null);
    expect(h.turns.map((t) => t.conversationId)).toEqual([null, CONV]);
    expect(h.store.getState().messages).toHaveLength(4);
  });

  it('the in-flight record is written before the turn leaves and cleared after it lands', async () => {
    const seen: { during: string | null } = { during: null };
    const h = makeHarness({
      outcome: () => {
        seen.during = h.storage.map.get(PENDING_KEY) ?? null;
        return REPLY_OK('ok');
      },
    });
    await h.store.send('keep me', null);
    expect(seen.during).not.toBeNull();
    expect(JSON.parse(seen.during ?? '{}')).toMatchObject({ text: 'keep me' });
    expect(h.storage.map.has(PENDING_KEY)).toBe(false);
  });
});

describe('failures', () => {
  it('a failed turn stays on screen as a failed bubble; Retry resends the same text once', async () => {
    let calls = 0;
    const h = makeHarness({
      outcome: () => {
        calls += 1;
        return calls === 1
          ? {
              kind: 'error',
              failure: 'retryable',
              message: 'no network',
              code: 'NETWORK',
              status: null,
            }
          : REPLY_OK('second time lucky');
      },
    });
    await h.store.send('try', null);
    const failed = h.store.getState();
    expect(failed.sending).toBe(false);
    expect(failed.messages).toHaveLength(1);
    expect(failed.messages[0]).toMatchObject({ status: 'failed', error: { code: 'NETWORK' } });
    expect(failed.unseenReply).toBe(true);
    expect(h.storage.map.has(PENDING_KEY)).toBe(false);

    const message = failed.messages[0];
    if (message === undefined) throw new Error('unreachable');
    h.store.retry(message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retried = h.store.getState();
    expect(h.turns.map((t) => t.message)).toEqual(['try', 'try']);
    expect(retried.messages.map((m) => [m.status, m.localId])).toEqual([
      ['saved', message.localId],
      ['saved', 'a-1'],
    ]);
  });

  it('a 401 mid-turn hands the draft across the login screen and shows nothing broken', async () => {
    const h = makeHarness({
      outcome: () => ({
        kind: 'error',
        failure: 'unauthenticated',
        message: 'expired',
        code: 'UNAUTHENTICATED',
        status: 401,
      }),
    });
    await h.store.open(CONV);
    await h.store.send('still mine', null);
    expect(h.expired).toEqual([{ conversationId: CONV, text: 'still mine' }]);
    expect(h.store.getState().sending).toBe(false);
  });

  it('discard removes a failed bubble; a second send while one is in flight is ignored', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ outcome: () => REPLY_OK('ok'), gate });
    const first = h.store.send('first', null);
    await Promise.resolve();
    await h.store.send('second', null);
    release();
    await first;
    expect(h.turns.map((t) => t.message)).toEqual(['first']);
    const [user] = h.store.getState().messages;
    if (user === undefined) throw new Error('unreachable');
    h.store.discard(user.localId);
    expect(h.store.getState().messages.map((m) => m.localId)).toEqual(['a-1']);
  });

  it('empty text is not sent', async () => {
    const h = makeHarness({ outcome: () => REPLY_OK('ok') });
    await h.store.send('   ', null);
    expect(h.turns).toEqual([]);
  });
});

describe('opening and restoring', () => {
  it('open loads the thread, keeps the previous draft under its own key, and remembers where you are', async () => {
    const h = makeHarness({ outcome: () => REPLY_OK('ok') });
    h.messages.set(CONV, [saved('m1', 'user', 'hi'), saved('m2', 'assistant', 'hello')]);
    h.store.setDraft('unsent words for a new conversation');
    await h.store.open(CONV);
    const opened = h.store.getState();
    expect(opened.activeId).toBe(CONV);
    expect(opened.threadState).toBe('idle');
    expect(opened.messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(opened.draft).toBe('');
    expect(opened.initialised).toBe(true);
    await h.store.open(null);
    expect(h.store.getState().draft).toBe('unsent words for a new conversation');
    expect(h.store.getState().messages).toEqual([]);
  });

  it('a thread that cannot be read is an error state, not an empty conversation', async () => {
    const h = makeHarness({ outcome: () => REPLY_OK('ok') });
    h.messages.set(CONV, null);
    await h.store.open(CONV);
    expect(h.store.getState().threadState).toBe('error');
  });

  it('restore: a turn the server saved is simply there; one it did not is back in the box with a sentence', async () => {
    const h = makeHarness({ outcome: () => REPLY_OK('ok') });
    h.messages.set(CONV, [saved('m1', 'user', 'landed'), saved('m2', 'assistant', 'yes')]);
    await h.store.restore(CONV, { conversationId: CONV, text: 'landed' });
    expect(h.store.getState().notice).toBeNull();
    expect(h.store.getState().draft).toBe('');

    await h.store.restore(CONV, { conversationId: CONV, text: 'never arrived' });
    expect(h.store.getState().draft).toBe('never arrived');
    expect(h.store.getState().notice).toBe(LEFT_MID_SEND_NOTICE);
    h.store.clearNotice();
    expect(h.store.getState().notice).toBeNull();
  });

  it('clear shows nothing without forgetting the draft store; adoptDraft takes orphaned words', async () => {
    const h = makeHarness({ outcome: () => REPLY_OK('ok') });
    await h.store.open(CONV);
    h.store.clear();
    expect(h.store.getState()).toMatchObject({ activeId: null, messages: [], threadState: 'idle' });
    h.store.adoptDraft('words with no conversation');
    expect(h.store.getState()).toMatchObject({
      draft: 'words with no conversation',
      initialised: true,
    });
  });
});
