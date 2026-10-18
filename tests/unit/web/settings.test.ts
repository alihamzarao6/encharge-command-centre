/**
 * The settings page's words and its endpoint client (Milestone 5 part 4) — pure, under Node.
 * What a document row says, what the confirmation promises, what a key row says, how the spend
 * reads, what each activity line says, and how every answer from the endpoint is read.
 */
import { describe, expect, it } from 'vitest';

/** The one row a test built: a missing row fails the test here, not as a TypeError later. */
function only<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a row');
  return value;
}

import {
  callSettings,
  interpretSettingsResponse,
  readSettingsReply,
  SETTINGS_CLIENT_MESSAGES,
} from '../../../web/src/lib/settingsApi.js';
import {
  ACTIVITY_ACTIONS,
  buildActivityList,
  buildDocumentList,
  buildKeyList,
  buildSpendView,
  documentMeta,
  documentState,
  EMPTY_TEXT,
  forgetConfirmText,
  forgetResultText,
  answersHeldText,
  formatUsd,
  pageCount,
  pageSummary,
  pageWindow,
  personLabel,
  revokeConfirmText,
  type ActivityRow,
  type LearnedSourceRow,
  type RelatedSourceRow,
} from '../../../web/src/lib/settingsView.js';

const ZONE = 'Australia/Perth';
const NOW = Date.parse('2026-10-17T06:00:00Z');
const ME = 'a0000000-0000-4000-8000-000000000002';
const ROSS = 'a0000000-0000-4000-8000-000000000001';
const EMAILS = new Map([
  [ROSS, 'rossb@fundd.com.au'],
  [ME, 'me@example.test'],
]);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function source(over: Partial<LearnedSourceRow> = {}): LearnedSourceRow {
  return {
    id: 's1',
    name: 'Rate sheet October.pdf',
    kind: 'pdf',
    source_host: null,
    source_url: null,
    content_hash: HASH_A,
    uploaded_by: ME,
    learned_at: '2026-10-17T02:15:00Z',
    page_count: 12,
    chunk_count: 20,
    embedded_count: 20,
    status: 'ready',
    failure: null,
    ...over,
  };
}

function related(over: Partial<RelatedSourceRow> = {}): RelatedSourceRow {
  return {
    id: 's2',
    content_hash: HASH_A,
    source_url: null,
    uploaded_by: ME,
    learned_at: '2026-10-16T02:15:00Z',
    ...over,
  };
}

describe('paging', () => {
  it('turns a page into the inclusive row range PostgREST takes', () => {
    expect(pageWindow(1, 25)).toEqual({ from: 0, to: 24 });
    expect(pageWindow(3, 25)).toEqual({ from: 50, to: 74 });
    expect(pageWindow(0, 25)).toEqual({ from: 0, to: 24 });
  });

  it('counts pages and says where the reader is', () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(312, 25)).toBe(13);
    expect(pageSummary(2, 25, 312, 25)).toBe('Showing 26–50 of 312');
    expect(pageSummary(1, 25, 0, 0)).toBe('');
  });
});

describe('who', () => {
  it('names a colleague by email, the viewer as "you", and a gone account plainly', () => {
    expect(personLabel(ROSS, EMAILS, ME)).toBe('rossb@fundd.com.au');
    expect(personLabel(ME, EMAILS, ME)).toBe('you');
    expect(personLabel(null, EMAILS, ME)).toBe('someone no longer on the team');
    expect(personLabel('gone', EMAILS, ME)).toBe('someone no longer on the team');
  });
});

describe('learned documents', () => {
  it('says what it is, when it was read, who added it and how long — never a word of it', () => {
    const [doc] = buildDocumentList(
      [source()],
      [],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    expect(doc).toMatchObject({
      name: 'Rate sheet October.pdf',
      kindLabel: 'PDF',
      host: null,
      addedBy: 'you',
      pagesLabel: '12 pages',
      state: 'learned',
      stateLabel: 'Learned',
      otherCopies: 0,
      otherReadOf: null,
      deniedReason: null,
    });
    expect(documentMeta(only(doc))).toBe('PDF · added today at 10:15 am by you · 12 pages');
  });

  it('a web page names its site; a workbook counts sheets; one page is "1 page"', () => {
    const rows = buildDocumentList(
      [
        source({
          id: 'p',
          kind: 'html',
          source_host: 'www.lender.com.au',
          source_url: 'https://www.lender.com.au/rates',
          page_count: 1,
        }),
        source({ id: 'x', kind: 'xlsx', page_count: 3 }),
        source({ id: 'u', kind: 'mystery', page_count: 1 }),
      ],
      [],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    expect(documentMeta(only(rows[0]))).toMatch(
      /^Web page from www\.lender\.com\.au · .* · 1 page$/,
    );
    expect(rows[1]?.pagesLabel).toBe('3 sheets');
    expect(rows[2]?.kindLabel).toBe('Document');
  });

  it('a nameless row never shows as an empty line; a long or non-Latin name is kept whole', () => {
    const long = `${'Very long name '.repeat(13)}.pdf`;
    const rows = buildDocumentList(
      [
        source({ id: 'a', name: '   ' }),
        source({ id: 'b', name: long }),
        source({ id: 'c', name: 'نرخ‌نامه مهر ۱۴۰۵.pdf' }),
      ],
      [],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    expect(rows.map((row) => row.name)).toEqual([
      'Untitled document',
      long.trim(),
      'نرخ‌نامه مهر ۱۴۰۵.pdf',
    ]);
  });

  it('says how far learning has got, and why one could not be learned', () => {
    expect(
      documentState({ status: 'pending', failure: null, chunk_count: 0, embedded_count: 0 }),
    ).toEqual({
      state: 'learning',
      label: 'Waiting to be learned',
    });
    expect(
      documentState({ status: 'learning', failure: null, chunk_count: 40, embedded_count: 10 }),
    ).toEqual({
      state: 'learning',
      label: 'Still being learned (25% done)',
    });
    expect(
      documentState({ status: 'learning', failure: null, chunk_count: 3, embedded_count: 3 }).label,
    ).toBe('Still being learned (99% done)');
    expect(
      documentState({ status: 'failed', failure: 'no_text', chunk_count: 0, embedded_count: 0 })
        .label,
    ).toBe("Couldn't be learned: nothing in it could be read");
    expect(
      documentState({ status: 'failed', failure: 'text_gone', chunk_count: 0, embedded_count: 0 })
        .label,
    ).toMatch(/text was gone/);
    expect(
      documentState({ status: 'failed', failure: 'other', chunk_count: 0, embedded_count: 0 })
        .label,
    ).toBe("Couldn't be learned");
  });

  it('counts other copies of the same bytes, and other reads of the same address', () => {
    const page = source({
      id: 'p-new',
      kind: 'html',
      source_url: 'https://lender.example/rates',
      source_host: 'lender.example',
      content_hash: HASH_A,
    });
    const [doc] = buildDocumentList(
      [page],
      [
        related({ id: 'p-new', content_hash: HASH_A, source_url: 'https://lender.example/rates' }),
        related({ id: 'copy', content_hash: HASH_A, source_url: 'https://lender.example/rates' }),
        related({
          id: 'p-old',
          content_hash: HASH_B,
          source_url: 'https://lender.example/rates',
          learned_at: '2026-09-17T02:00:00Z',
        }),
      ],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    expect(doc?.otherCopies).toBe(1);
    expect(doc?.otherReadOf).toBe('17 Sept at 10:00 am');
  });

  it('offers forget where the server will agree, and says why where it will not', () => {
    const rows = buildDocumentList(
      [
        source({ id: 'mine' }),
        source({ id: 'his', uploaded_by: ROSS, content_hash: HASH_B }),
        source({ id: 'shared', content_hash: 'c'.repeat(64) }),
      ],
      [related({ id: 'twin', content_hash: 'c'.repeat(64), uploaded_by: ROSS })],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    expect(rows.map((row) => [row.verdict.allowed, row.deniedReason])).toEqual([
      [true, null],
      [false, 'Only the person who added this document, or an administrator, can forget it.'],
      [
        false,
        'Someone else added a copy of this document too, so only an administrator can forget it.',
      ],
    ]);
    const admin = buildDocumentList(
      [source({ uploaded_by: ROSS })],
      [],
      EMAILS,
      { userId: 'x', isAdmin: true },
      NOW,
      ZONE,
    );
    expect(admin[0]?.verdict.allowed).toBe(true);
    expect(admin[0]?.addedBy).toBe('rossb@fundd.com.au');
  });

  it('the confirmation says what goes, that it cannot be undone, and what stays', () => {
    const [plain] = buildDocumentList(
      [source()],
      [],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    const text = forgetConfirmText(only(plain));
    expect(text[0]).toBe(
      'Forget “Rate sheet October.pdf”? The assistant stops using it straight away, everywhere: what it learned from it and any summary of it are deleted, and so is its text in every conversation it is attached to.',
    );
    expect(text.at(-1)).toMatch(
      /can't be undone\. Answers it has already given in existing conversations will still show what it said, and the assistant can read them there\. Deleting those conversations is the only way to clear them\.$/,
    );
    expect(text).toHaveLength(2);

    const [busy] = buildDocumentList(
      [
        source({
          status: 'learning',
          chunk_count: 10,
          embedded_count: 2,
          source_url: 'https://l.example/r',
          kind: 'html',
          source_host: 'l.example',
        }),
      ],
      [
        related({ id: 'c' }),
        related({ id: 'o', content_hash: HASH_B, source_url: 'https://l.example/r' }),
      ],
      EMAILS,
      { userId: ME, isAdmin: false },
      NOW,
      ZONE,
    );
    const lines = forgetConfirmText(only(busy));
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('It was added 2 times. Every copy is forgotten together.');
    expect(lines[2]).toMatch(/still being learned/);
    expect(lines[3]).toMatch(/different read of the same page/);
  });

  it('the result says it is gone, and from how many conversations', () => {
    expect(forgetResultText('A.pdf', { outcome: 'forgotten', files: 0, sources: 1 })).toBe(
      'Forgotten: “A.pdf”. The assistant can no longer use it.',
    );
    expect(forgetResultText('A.pdf', { outcome: 'forgotten', files: 1, sources: 1 })).toMatch(
      /from 1 conversation\.$/,
    );
    expect(forgetResultText('A.pdf', { outcome: 'forgotten', files: 3, sources: 2 })).toMatch(
      /from 3 conversations\.$/,
    );
    expect(forgetResultText('A.pdf', { outcome: 'already' })).toBe(
      '“A.pdf” had already been forgotten.',
    );
  });

  it('then how many conversations still hold an answer from it — a number, never which — and what clears them', () => {
    const said = (held: number | null | undefined): string =>
      forgetResultText('A.pdf', {
        outcome: 'forgotten',
        files: 1,
        sources: 1,
        ...(held === undefined ? {} : { conversationsWithAnswers: held }),
      });
    expect(said(0)).toBe(
      'Forgotten: “A.pdf”. The assistant can no longer use it. Its text was removed from 1 conversation. No conversation holds an earlier answer from it.',
    );
    expect(said(1)).toMatch(
      / 1 conversation still holds an earlier answer from it\. Deleting that conversation is the only way to clear it\.$/,
    );
    expect(said(4)).toMatch(
      / 4 conversations still hold earlier answers from it\. Deleting those conversations is the only way to clear them\.$/,
    );
    expect(said(null)).toMatch(
      / Couldn't count the conversations that still hold earlier answers from it/,
    );
    // A server that does not send the count: nothing is claimed either way.
    expect(said(undefined)).toBe(
      'Forgotten: “A.pdf”. The assistant can no longer use it. Its text was removed from 1 conversation.',
    );
    expect(answersHeldText(2)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe('connector keys', () => {
  it('lists switched-on keys first, newest first, and never anything but the public id', () => {
    const keys = buildKeyList(
      [
        {
          id: '1',
          key_id: 'aaaaaaaaaaaa',
          label: 'Old',
          created_at: '2026-10-10T00:00:00Z',
          last_used_at: null,
          revoked_at: '2026-10-12T00:00:00Z',
        },
        {
          id: '2',
          key_id: 'bbbbbbbbbbbb',
          label: '',
          created_at: '2026-10-13T00:00:00Z',
          last_used_at: '2026-10-17T05:00:00Z',
          revoked_at: null,
        },
        {
          id: '3',
          key_id: 'cccccccccccc',
          label: 'Laptop',
          created_at: '2026-10-16T00:00:00Z',
          last_used_at: null,
          revoked_at: null,
        },
      ],
      NOW,
      ZONE,
    );
    expect(keys.map((k) => [k.keyId, k.label, k.on, k.stateLabel])).toEqual([
      ['cccccccccccc', 'Laptop', true, 'On'],
      ['bbbbbbbbbbbb', 'Unnamed key', true, 'On'],
      ['aaaaaaaaaaaa', 'Old', false, 'Switched off'],
    ]);
    expect(keys[0]?.detail).toBe('Key cccccccccccc · made yesterday at 8:00 am · never used');
    expect(keys[1]?.detail).toMatch(/last used today at 1:00 pm$/);
    expect(keys[2]?.detail).toMatch(/switched off 12 Oct at 8:00 am$/);
    expect(revokeConfirmText(only(keys[0]))).toMatch(
      /^Switch off “Laptop”\? Anything using this key is refused from its very next request\./,
    );
  });
});

describe('spending', () => {
  it('formats money the way a person reads it', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('under $0.01');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });

  it('shows each window against its cap, warns near it and says plainly when it is reached', () => {
    const base = {
      capDailyUsd: 5,
      capMonthlyUsd: 80,
      warnFraction: 0.8,
      dayStartedAt: '2026-10-17T00:00:00.000Z',
      monthStartedAt: '2026-10-01T00:00:00.000Z',
      asOf: '2026-10-17T05:59:00.000Z',
    };
    const calm = buildSpendView({ ...base, todayUsd: 0.43, monthUsd: 12.35 }, NOW, ZONE);
    expect(calm.today).toMatchObject({ tone: 'ok', sentence: '$0.43 of $5.00 — $4.57 left.' });
    expect(calm.month.fraction).toBeCloseTo(12.35 / 80);
    expect(calm.note).toMatch(/8:00 am to 8:00 am in Perth\. Checked today at 1:59 pm\.$/);
    const near = buildSpendView({ ...base, todayUsd: 4.2, monthUsd: 79.99 }, NOW, ZONE);
    expect([near.today.tone, near.month.tone]).toEqual(['warn', 'warn']);
    const over = buildSpendView({ ...base, todayUsd: 5, monthUsd: 81 }, NOW, ZONE);
    expect(over.today.tone).toBe('over');
    expect(over.month.fraction).toBe(1);
    expect(over.today.sentence).toMatch(/the cap is reached/);
    const zero = buildSpendView({ ...base, capDailyUsd: 0, todayUsd: 0, monthUsd: 0 }, NOW, ZONE);
    expect(zero.today).toMatchObject({ tone: 'over', fraction: 0 });
  });
});

describe('activity', () => {
  function row(action: string, over: Partial<ActivityRow> = {}): ActivityRow {
    return {
      id: action,
      actor: ROSS,
      action,
      entity_type: 'x',
      entity_id: null,
      created_at: '2026-10-17T01:00:00Z',
      opportunity: null,
      from_stage: null,
      to_stage: null,
      connector: null,
      file_kind: null,
      file_source: null,
      ...over,
    };
  }
  const context = {
    emailsById: EMAILS,
    viewerId: ME,
    stageNames: new Map([
      ['st-new', 'New Lead'],
      ['st-app', 'Application'],
    ]),
    leadNames: new Map([['opp-1', 'Jordan Lee']]),
  };

  it('says who moved which lead from where to where (the Milestone 4 part 4 trail)', () => {
    const [moved] = buildActivityList(
      [row('LEAD_STAGE_MOVED', { opportunity: 'opp-1', from_stage: 'st-new', to_stage: 'st-app' })],
      context,
      NOW,
      ZONE,
    );
    expect(moved).toEqual({
      id: 'LEAD_STAGE_MOVED',
      who: 'rossb@fundd.com.au',
      what: 'moved Jordan Lee from New Lead to Application',
      when: 'today at 9:00 am',
      at: '2026-10-17T01:00:00Z',
    });
    const [unknown] = buildActivityList(
      [row('LEAD_STAGE_MOVED', { opportunity: 'gone' })],
      context,
      NOW,
      ZONE,
    );
    expect(unknown?.what).toBe('moved a lead from a stage to a stage');
  });

  it('has words for every action it selects, and names the actor in every form it is written', () => {
    const lines = buildActivityList(
      ACTIVITY_ACTIONS.map((action) => row(action, { entity_id: ME, connector: 'abcdefghjkmn' })),
      context,
      NOW,
      ZONE,
    );
    for (const line of lines) expect(line.what).not.toBe('made a change');
    expect(lines.find((l) => l.id === 'CONNECTOR_KEY_ISSUED')?.what).toBe(
      'made a connector key (abcdefghjkmn)',
    );
    expect(lines.find((l) => l.id === 'USER_CREATED')?.what).toBe('added you to the team');
    expect(lines.find((l) => l.id === 'CONVERSATION_ADMIN_READ')?.what).toMatch(
      /private conversation/,
    );
    const actors = buildActivityList(
      [
        row('FILE_EXPIRED', { actor: 'system' }),
        row('CONNECTOR_KEY_REVOKED', { actor: 'terminal' }),
        row('KNOWLEDGE_FORGOTTEN', { actor: ME }),
        row('KNOWLEDGE_FORGOTTEN', { actor: 'service_role' }),
        row('SOMETHING_NEW'),
      ],
      context,
      NOW,
      ZONE,
    );
    expect(actors.map((a) => `${a.who} ${a.what}`)).toEqual([
      "The Command Centre deleted a file's text after its 30 days were up",
      'An operator, from the terminal switched off a connector key',
      'You forgot a learned document',
      'The Command Centre forgot a learned document',
      'rossb@fundd.com.au made a change',
    ]);
  });

  it('describes what a file event was without its name', () => {
    const lines = buildActivityList(
      [
        row('FILE_ATTACHED', { file_kind: 'pdf', file_source: 'upload' }),
        row('FILE_ATTACHED', { file_kind: 'docx', file_source: 'drive' }),
        row('FILE_ATTACHED', { file_kind: 'html', file_source: 'link' }),
        row('FILE_ATTACHED', { file_kind: null, file_source: null }),
      ],
      context,
      NOW,
      ZONE,
    );
    expect(lines.map((l) => l.what)).toEqual([
      'attached a PDF to a conversation',
      'attached a Word document from Google Drive to a conversation',
      'read a web page into a conversation',
      'attached a file to a conversation',
    ]);
  });

  it('never selects whole before/after images — only named keys', () => {
    // The trigger rows' images hold a note's words; this list never asks for them.
    expect(ACTIVITY_ACTIONS).not.toContain('INSERT');
    expect(ACTIVITY_ACTIONS).not.toContain('UPDATE');
    expect(ACTIVITY_ACTIONS).not.toContain('DELETE');
  });
});

describe('empty states say what to do', () => {
  it('each one names the action that fills it', () => {
    expect(EMPTY_TEXT.documents).toMatch(/Attach a file or paste a link/);
    expect(EMPTY_TEXT.keys).toMatch(/Make one/);
    expect(EMPTY_TEXT.activity).toMatch(/Moving a lead/);
  });
});

describe('the endpoint client', () => {
  const KEY = `fcc_abcdefghjkmn_${'Q'.repeat(43)}`;

  it('reads each reply it knows, and nothing it does not', () => {
    expect(
      readSettingsReply({
        action: 'forget_document',
        outcome: 'forgotten',
        sourceId: 's',
        sources: 1,
        files: 0,
        chunks: 4,
      }),
    ).toEqual({
      action: 'forget_document',
      outcome: 'forgotten',
      sourceId: 's',
      sources: 1,
      files: 0,
      chunks: 4,
    });
    expect(
      readSettingsReply({
        action: 'forget_document',
        outcome: 'forgotten',
        sourceId: 's',
        sources: 1,
      }),
    ).toBeNull();
    const forgot = {
      action: 'forget_document',
      outcome: 'forgotten',
      sourceId: 's',
      sources: 1,
      files: 1,
      chunks: 4,
    };
    expect(readSettingsReply({ ...forgot, conversationsWithAnswers: 3 })).toEqual({
      ...forgot,
      conversationsWithAnswers: 3,
    });
    expect(readSettingsReply({ ...forgot, conversationsWithAnswers: null })).toEqual({
      ...forgot,
      conversationsWithAnswers: null,
    });
    expect(readSettingsReply({ ...forgot, conversationsWithAnswers: -1 })).toBeNull();
    expect(readSettingsReply({ ...forgot, conversationsWithAnswers: '3' })).toBeNull();
    expect(
      readSettingsReply({
        action: 'revoke_key',
        outcome: 'already',
        keyId: 'abcdefghjkmn',
        revokedAt: 't',
      }),
    ).toEqual({
      action: 'revoke_key',
      outcome: 'already',
      keyId: 'abcdefghjkmn',
      revokedAt: 't',
    });
    expect(readSettingsReply({ action: 'revoke_key', outcome: 'revoked' })).toBeNull();
    expect(readSettingsReply(null)).toBeNull();
    expect(readSettingsReply({ action: 'mystery', outcome: 'x' })).toBeNull();
  });

  it('a made key must be whole and the one it says it is — never half a key on screen', () => {
    const ok = {
      action: 'create_key',
      outcome: 'created',
      keyId: 'abcdefghjkmn',
      label: 'L',
      createdAt: 't',
      key: KEY,
    };
    expect(readSettingsReply(ok)).toEqual(ok);
    expect(readSettingsReply({ ...ok, key: KEY.slice(0, 40) })).toBeNull();
    expect(readSettingsReply({ ...ok, keyId: 'zzzzzzzzzzzz' })).toBeNull();
    expect(readSettingsReply({ ...ok, keyId: 'NOT-AN-ID' })).toBeNull();
    expect(readSettingsReply({ ...ok, label: 3 })).toBeNull();
  });

  it('reads the spend only when every number is there', () => {
    const spend = {
      action: 'spend',
      outcome: 'read',
      capDailyUsd: 5,
      capMonthlyUsd: 80,
      warnFraction: 0.8,
      todayUsd: 0.1,
      monthUsd: 2,
      dayStartedAt: 'a',
      monthStartedAt: 'b',
      asOf: 'c',
    };
    expect(readSettingsReply(spend)).toEqual(spend);
    expect(readSettingsReply({ ...spend, todayUsd: -1 })).toBeNull();
    expect(readSettingsReply({ ...spend, asOf: null })).toBeNull();
  });

  it.each([
    [
      401,
      { error: { code: 'UNAUTHENTICATED', message: 'x', retryable: false } },
      'unauthenticated',
    ],
    [
      403,
      { error: { code: 'NOT_YOURS', message: 'Only an administrator…', retryable: false } },
      'notYours',
    ],
    [403, { error: { code: 'FORBIDDEN', message: 'x', retryable: false } }, 'forbidden'],
    [404, { error: { code: 'NOT_FOUND', message: 'gone', retryable: false } }, 'gone'],
    [
      400,
      { error: { code: 'BAD_LABEL', message: 'Give the key a name', retryable: false } },
      'refused',
    ],
    [409, { error: { code: 'TOO_MANY_KEYS', message: 'five', retryable: false } }, 'refused'],
    [503, { error: { code: 'UNAVAILABLE', message: 'later', retryable: true } }, 'retryable'],
    [500, { error: { code: 'INTERNAL', message: 'x', retryable: true } }, 'retryable'],
    [500, null, 'fatal'],
    [200, { nonsense: true }, 'retryable'],
  ])('%i → %s', (status, body, failure) => {
    const outcome = interpretSettingsResponse(status, body);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.failure).toBe(failure);
  });

  it('shows the server’s own sentence where the person can act on it', () => {
    const notYours = interpretSettingsResponse(403, {
      error: {
        code: 'NOT_YOURS',
        message: 'Only an administrator can forget this one.',
        retryable: false,
      },
    });
    expect(notYours.kind === 'error' && notYours.message).toBe(
      'Only an administrator can forget this one.',
    );
    const expired = interpretSettingsResponse(401, null);
    expect(expired.kind === 'error' && expired.message).toBe(
      SETTINGS_CLIENT_MESSAGES.sessionExpired,
    );
  });

  it('sends the session and the public key only, asks for no caching, and reads the reply', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const outcome = await callSettings(
      {
        settingsUrl: 'https://p.supabase.co/functions/v1/settings',
        anonKey: 'anon',
        fetch: ((url: string, init: RequestInit) => {
          seen.push({ url, init });
          return Promise.resolve(
            new Response(
              JSON.stringify({
                action: 'revoke_key',
                outcome: 'revoked',
                keyId: 'abcdefghjkmn',
                revokedAt: 't',
              }),
              {
                status: 200,
              },
            ),
          );
        }) as typeof fetch,
      },
      'session-token',
      { action: 'revoke_key', keyId: 'abcdefghjkmn' },
    );
    expect(outcome.kind).toBe('ok');
    expect(seen[0]?.url).toBe('https://p.supabase.co/functions/v1/settings');
    expect(seen[0]?.init.cache).toBe('no-store');
    expect(seen[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer session-token',
      apikey: 'anon',
    });
    expect(JSON.parse(typeof seen[0]?.init.body === 'string' ? seen[0].init.body : 'null')).toEqual(
      {
        action: 'revoke_key',
        keyId: 'abcdefghjkmn',
      },
    );
  });

  it('a dropped connection or a timeout says to check before retrying; a body that is not JSON is handled', async () => {
    const dropped = await callSettings(
      {
        settingsUrl: 'u',
        anonKey: 'a',
        fetch: () => Promise.reject(new TypeError('offline')),
      },
      't',
      { action: 'spend' },
    );
    expect(dropped).toMatchObject({ kind: 'error', failure: 'retryable', code: 'NETWORK' });
    const slow = await callSettings(
      {
        settingsUrl: 'u',
        anonKey: 'a',
        timeoutMs: 5,
        fetch: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })) as typeof fetch,
      },
      't',
      { action: 'spend' },
    );
    expect(slow).toMatchObject({
      kind: 'error',
      code: 'CLIENT_TIMEOUT',
      message: SETTINGS_CLIENT_MESSAGES.timeout,
    });
    const html = await callSettings(
      {
        settingsUrl: 'u',
        anonKey: 'a',
        fetch: () => Promise.resolve(new Response('<html>', { status: 502 })),
      },
      't',
      { action: 'spend' },
    );
    expect(html).toMatchObject({ kind: 'error', status: 502 });
  });
});
