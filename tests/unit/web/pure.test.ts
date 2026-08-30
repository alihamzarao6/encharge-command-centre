/**
 * The small pure pieces of the browser app: draft persistence across a session expiry,
 * the login messages (wrong password and unknown email must read identically), the build
 * config guard, and copy-to-clipboard with its fallback.
 */
import { describe, expect, it } from 'vitest';

import { copyText } from '../../../web/src/lib/clipboard.js';
import { resolveWebConfig } from '../../../web/src/lib/config.js';
import {
  MAX_DRAFT_CHARS,
  OPEN_KEY,
  PENDING_KEY,
  clearPending,
  draftKey,
  loadDraft,
  loadOpenConversation,
  saveDraft,
  saveOpenConversation,
  savePending,
  takePending,
  type DraftStorage,
} from '../../../web/src/lib/draft.js';
import {
  LOGIN_MESSAGES,
  classifyLoginError,
  validateLoginInput,
} from '../../../web/src/lib/login.js';

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

describe('drafts', () => {
  it('round-trips per conversation and clears on blank', () => {
    const storage = memoryStorage();
    saveDraft(storage, null, 'new one');
    saveDraft(storage, 'c1', 'in c1');
    expect(loadDraft(storage, null)).toBe('new one');
    expect(loadDraft(storage, 'c1')).toBe('in c1');
    expect(loadDraft(storage, 'c2')).toBe('');
    saveDraft(storage, 'c1', '   ');
    expect(storage.map.has(draftKey('c1'))).toBe(false);
  });

  it('caps a draft at the message limit', () => {
    const storage = memoryStorage();
    saveDraft(storage, null, 'x'.repeat(MAX_DRAFT_CHARS + 500));
    expect(loadDraft(storage, null)).toHaveLength(MAX_DRAFT_CHARS);
  });

  it('a pending message survives one hop and is consumed on take', () => {
    const storage = memoryStorage();
    savePending(storage, { conversationId: 'c1', text: 'kept' });
    expect(takePending(storage)).toEqual({ conversationId: 'c1', text: 'kept' });
    expect(takePending(storage)).toBeNull();
    savePending(storage, { conversationId: null, text: 'new' });
    expect(takePending(storage)).toEqual({ conversationId: null, text: 'new' });
  });

  it('ignores a corrupt pending record', () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_KEY, '{not json');
    expect(takePending(storage)).toBeNull();
    storage.setItem(PENDING_KEY, JSON.stringify({ text: 5 }));
    expect(takePending(storage)).toBeNull();
  });

  it('never throws when storage is missing or broken', () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => {
      saveDraft(broken, null, 'x');
      savePending(broken, { conversationId: null, text: 'x' });
    }).not.toThrow();
    expect(loadDraft(broken, null)).toBe('');
    expect(takePending(broken)).toBeNull();
    expect(loadDraft(null, null)).toBe('');
    expect(takePending(null)).toBeNull();
  });
});

describe('login messages', () => {
  it('wrong password and unknown email produce the same message', () => {
    const wrongPassword = classifyLoginError({
      code: 'invalid_credentials',
      status: 400,
      message: 'Invalid login credentials',
    });
    const unknownEmail = classifyLoginError({
      code: 'invalid_credentials',
      status: 400,
      message: 'Invalid login credentials',
    });
    expect(wrongPassword).toBe('credentials');
    expect(unknownEmail).toBe('credentials');
    expect(LOGIN_MESSAGES.credentials).not.toMatch(/exist|unknown|no account/i);
  });

  it('a banned (deactivated) account is refused with its own message', () => {
    expect(classifyLoginError({ code: 'user_banned', status: 403, message: 'banned' })).toBe(
      'deactivated',
    );
    expect(LOGIN_MESSAGES.deactivated).toMatch(/deactivated/i);
  });

  it('a transport failure is not blamed on the password', () => {
    expect(classifyLoginError({ message: 'Failed to fetch' })).toBe('unavailable');
    expect(classifyLoginError({ status: 503, message: 'down' })).toBe('unavailable');
    expect(classifyLoginError({ status: 429, message: 'slow down' })).toBe('credentials');
  });

  it('validates that both fields are present', () => {
    expect(validateLoginInput('', 'x')).toBe(false);
    expect(validateLoginInput('a@b.c', '')).toBe(false);
    expect(validateLoginInput(' a@b.c ', 'p')).toBe(true);
  });
});

describe('web config', () => {
  it('derives the chat, memory and admin URLs and strips a trailing slash', () => {
    expect(
      resolveWebConfig({
        VITE_SUPABASE_URL: 'https://x.supabase.co/',
        VITE_SUPABASE_ANON_KEY: 'k',
      }),
    ).toEqual({
      supabaseUrl: 'https://x.supabase.co',
      anonKey: 'k',
      memoryUrl: 'https://x.supabase.co/functions/v1/memory',
      adminUrl: 'https://x.supabase.co/functions/v1/admin',
      chatUrl: 'https://x.supabase.co/functions/v1/chat',
    });
  });

  it('refuses a build with either value missing', () => {
    expect(() => resolveWebConfig({})).toThrow(/VITE_SUPABASE_URL/);
    expect(() =>
      resolveWebConfig({ VITE_SUPABASE_URL: 'https://x', VITE_SUPABASE_ANON_KEY: ' ' }),
    ).toThrow();
  });
});

describe('copyText', () => {
  it('uses the async clipboard when it works', async () => {
    const written: string[] = [];
    const ok = await copyText(
      { clipboard: { writeText: (t) => (written.push(t), Promise.resolve()) }, document: null },
      'post',
    );
    expect(ok).toBe(true);
    expect(written).toEqual(['post']);
  });

  it('reports false when nothing can copy, never throws', async () => {
    const ok = await copyText(
      { clipboard: { writeText: () => Promise.reject(new Error('denied')) }, document: null },
      'post',
    );
    expect(ok).toBe(false);
    expect(await copyText({ clipboard: null, document: null }, 'post')).toBe(false);
  });
});

describe('which conversation is open (D76)', () => {
  function store(): DraftStorage & { readonly map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
      removeItem: (k) => {
        map.delete(k);
      },
    };
  }

  it('remembers the conversation, so a discarded tab comes back to it', () => {
    const s = store();
    saveOpenConversation(s, 'conv-1');
    expect(loadOpenConversation(s)).toBe('conv-1');
  });

  it('forgets it when the person starts a new conversation', () => {
    const s = store();
    saveOpenConversation(s, 'conv-1');
    saveOpenConversation(s, null);
    expect(loadOpenConversation(s)).toBeNull();
    expect(s.map.has(OPEN_KEY)).toBe(false);
  });

  it('an empty stored value reads as nothing, not as a conversation called ""', () => {
    const s = store();
    s.setItem(OPEN_KEY, '');
    expect(loadOpenConversation(s)).toBeNull();
  });

  it('survives storage that throws, because a lost place is not worth a crash', () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('private browsing');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => {
      saveOpenConversation(broken, 'conv-1');
    }).not.toThrow();
    expect(loadOpenConversation(broken)).toBeNull();
    expect(loadOpenConversation(null)).toBeNull();
  });

  it('clearPending removes an in-flight record without disturbing the open conversation', () => {
    const s = store();
    saveOpenConversation(s, 'conv-1');
    savePending(s, { conversationId: 'conv-1', text: 'half-sent' });
    clearPending(s);
    expect(takePending(s)).toBeNull();
    expect(loadOpenConversation(s)).toBe('conv-1');
  });
});
