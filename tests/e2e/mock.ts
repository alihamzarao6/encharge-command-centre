/**
 * A scripted Supabase for the browser tests. Intercepts every request the built app makes —
 * GoTrue (sign-in, session, sign-out), PostgREST (app_users, conversations, messages,
 * memory_facts, memory_chunks) and the three Edge Functions — and answers from an in-memory
 * script. Nothing leaves the machine; the app cannot tell the difference because the URLs and
 * shapes are the real ones.
 *
 * Milestone 5 part 1 added the files Edge Function and the `conversation_files` read. The
 * default is faithful to src/lib/files/page.ts on what the interface depends on: an upload is
 * claimed, takes pages, and becomes a file only when every declared page has arrived; the same
 * request id resumes; the same content is the same attachment. A page image it is sent is
 * checked to be a JPEG and measured, so a test can assert what actually left the browser.
 *
 * Milestone 5 part 2 added `fetch_page`: the scripted server "fetches" an address from the
 * test's own table of pages (`options.pages`) and answers as the real function does — the
 * page's bytes as the body, what it measured in the `x-page-meta` header — and keeps a
 * receipt. `begin` for a page is then held to that receipt, takes the address and the read
 * time from it and never from the browser, and `finish` replaces an older read of the same
 * address. The browser itself must never contact the page's site: a spec proves that by
 * routing the site's host and counting.
 *
 * PostgREST is READ-ONLY here, as it is in production: any non-GET is recorded in
 * `postgrestWrites` and answered 403 / 42501, so a test can assert that the interface changes
 * memory only through the verified server path.
 */
import type { Page, Route } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

import { E2E_SUPABASE_URL } from './playwright.config.js';

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const EMAIL = 'ross.test@example.com';
export const PASSWORD = 'correct-horse';
export const CONV_ID = 'c0000000-0000-4000-8000-000000000001';
/** The two custom-field ids seed.sql maps (the 19 Aug form fields), used by the leads suite. */
export const LOAN_BALANCE_FIELD = 'TANd0sfC9wRwuJKhSGFx';
export const INTEREST_RATE_FIELD = 'hX8JQblBT9iJhYEa348M';

/** A structurally valid JWT (three base64url parts) whose payload says `authenticated`. */
export function fakeAccessToken(): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: USER_ID,
    email: EMAIL,
    role: 'authenticated',
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.e2e-signature-not-real`;
}

export interface ScriptedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  /** Milestone 5 part 5: on an assistant row, what reached the model from documents. */
  document_coverage?: unknown;
}

/** Milestone 5 part 5: a learned document as the browser may read it — its name only. */
export interface ScriptedKnowledgeSource {
  id: string;
  name: string | null;
}

/** A row of `conversation_files`, as PostgREST returns the columns the interface selects. */
export interface ScriptedFile {
  id: string;
  conversation_id: string;
  uploaded_by: string;
  name: string | null;
  kind: string;
  byte_size: number;
  page_count: number;
  vision_pages: number;
  status: string;
  created_at: string;
  expires_at: string;
  /** Milestone 5 part 2. Absent on a scripted row = an uploaded file (null / 0). */
  source_url?: string | null;
  source_host?: string | null;
  fetched_at?: string | null;
  values_missing?: number;
  read_as_sent?: boolean;
  removed_reason?: string | null;
  /** Milestone 5 part 3a. Absent = not from Drive. */
  drive_file_id?: string | null;
}

/** Milestone 5 part 3a: what the scripted Drive endpoint finds for one Drive file id. */
export type ScriptedDriveFile =
  | {
      /** Drive's name for it when it is read. */
      name: string;
      body: string | Buffer;
      /** The name handed to the reader; default `name`. */
      fileName?: string;
      contentType?: string;
      googleType?: string | null;
      /** How long Google takes to hand it over. */
      delayMs?: number;
    }
  /** Refused (in the bin, a Form…): 422 with this code and sentence. */
  | { refused: string; message: string }
  /** Google did not answer usefully: this status, retryable. */
  | { failed: number; message: string };

export type ScriptedDriveStatus =
  | { state: 'unavailable' }
  | { state: 'not_connected' }
  | {
      state: 'connected';
      email: string;
      connectedAt: string;
      lastUsedAt: string | null;
      checked: boolean;
    }
  | { state: 'broken'; email: string; brokenAt: string; reason: string; message: string };

export interface DriveScript {
  /** Where the connection starts. Default: not connected. */
  status?: ScriptedDriveStatus;
  /** What Google holds, by Drive file id. */
  files?: Record<string, ScriptedDriveFile>;
  /** How connect_finish ends. Default: connected as broker@example.com. */
  finish?: { outcome: string; message: string; note?: string | null };
  /** Google cannot be reached when Drive is disconnected. */
  disconnectFails?: boolean;
}

/** What the scripted server finds at an address when it is asked to fetch it. */
export type ScriptedPage =
  | {
      /** The bytes the site answered with. */
      body: string | Buffer;
      /** Default: text/html; charset=utf-8. */
      contentType?: string;
      /** Where it ended after redirects. Default: the address asked for. */
      finalUrl?: string;
      /** How long the site took, on top of any `filesDelayMs`. */
      delayMs?: number;
    }
  /** The server refused the address or the page: 422, with this code and sentence. */
  | { refused: string; message: string }
  /** The site did not answer usefully: this status, retryable, with this sentence. */
  | { failed: number; message: string };

export interface FilesScript {
  /**
   * Called per POST /functions/v1/files, before the faithful default. Return a status and
   * body to answer with it, 'abort' to drop the connection, or undefined to let the default
   * answer.
   */
  respond: (
    body: Record<string, unknown>,
    call: number,
  ) => { status: number; body: unknown } | 'abort' | undefined;
}

/** One page image the browser sent to be read: proof of what left the device. */
export interface SentPageImage {
  fileId: string;
  pageNo: number;
  label: string;
  width: number;
  height: number;
  base64Chars: number;
}

/** Width and height of a JPEG, read from its frame header. 0×0 when it is not one. */
export function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return { width: 0, height: 0 };
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    const length = bytes.readUInt16BE(at + 2);
    // SOF0–SOF15, except the three that are not frame headers (DHT, JPG, DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return { width: 0, height: 0 };
}

export interface ChatScript {
  /**
   * Called per POST /functions/v1/chat; returns status + body (a plain JSON answer), or
   * `{ sse: [...] }` — an event stream, as the deployed function writes it. The mock honours
   * the request's Accept header like the function does: an `sse` script answered to a
   * caller that did not ask for a stream is served as JSON of its final event.
   */
  respond: (
    request: { message: string; conversationId?: string },
    call: number,
  ) =>
    | { status: number; body: unknown }
    | { sse: { event: string; data: unknown }[]; truncate?: boolean };
}

export function sseDone(
  reply: string,
  call: number,
  conversationId = CONV_ID,
): { event: string; data: unknown }[] {
  const pieces = reply.match(/.{1,6}/gs) ?? [];
  return [
    { event: 'start', data: { type: 'start', conversationId } },
    ...pieces.map((text) => ({ event: 'delta', data: { type: 'delta', text } })),
    {
      event: 'done',
      data: {
        type: 'done',
        reply: {
          conversationId,
          userMessageId: `u-${String(call)}`,
          assistantMessageId: `a-${String(call)}`,
          reply,
          model: 'claude-sonnet-5',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.001,
        },
      },
    },
  ];
}

/** Stage 3 part 3: the two memory tables the page selects, and the rows it starts with. */
export interface ScriptedFact {
  id: string;
  user_id: string;
  scope: string;
  key: string;
  value: string | null;
  superseded_by: string | null;
  created_at: string;
}

export interface ScriptedChunk {
  id: string;
  conversation_id: string;
  user_id: string;
  scope: string;
  summary: string;
  audience: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** Stage 3 part 4: a colleague on the roster the users page lists. */
export interface ScriptedStaff {
  user_id: string;
  email: string;
  role: string;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

/**
 * Milestone 4 part 2: the part-1 mirror of GoHighLevel as the overview reads it under RLS —
 * the five tables, shaped exactly as PostgREST returns the columns the screen selects.
 */
export interface ScriptedGhl {
  pipelines: { ghl_id: string; name: string; last_changed_at: string }[];
  stages: {
    ghl_id: string;
    pipeline_ghl_id: string;
    name: string;
    position: number;
    removed_at: string | null;
  }[];
  opportunities: {
    ghl_id: string;
    pipeline_ghl_id: string;
    stage_ghl_id: string;
    contact_ghl_id: string | null;
    name: string;
    status: string;
    ghl_created_at: string | null;
    removed_at: string | null;
  }[];
  contacts: {
    ghl_id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    removed_at: string | null;
    /** Milestone 4 part 3: the leads screen selects these too. Absent = null / {}. */
    email?: string | null;
    phone?: string | null;
    custom_fields?: Record<string, unknown>;
  }[];
  /** Milestone 4 part 3: the seeded field map. Absent = the two rows the seed carries. */
  fieldMap?: { internal_field: string; ghl_custom_field_id: string | null; entity: string }[];
  /** Milestone 4 part 4: the notes this app wrote through (ghl_notes). Absent = none. */
  notes?: ScriptedNote[];
  /** Milestone 4 part 4: custom-field definitions, for the detail's labels. Absent = none. */
  customFields?: {
    ghl_id: string;
    name: string;
    data_type: string;
    parent_id: string | null;
    removed_at: string | null;
  }[];
  runs: {
    id: string;
    pipeline_ghl_id: string;
    status: string;
    started_at: string;
    applied_at: string | null;
    finished_at: string | null;
    error_code: string | null;
    contacts_failed: number | null;
    contacts_missing: number | null;
    contacts_rejected: number | null;
    opportunities_rejected: number | null;
  }[];
}

export interface ScriptedNote {
  ghl_id: string;
  contact_ghl_id: string;
  opportunity_ghl_id: string;
  author_user_id: string | null;
  body: string;
  ghl_date_added: string | null;
  created_at: string;
}

/**
 * Milestone 4 part 4: a scripted answer to a move or a note. Return null to let the faithful
 * default run (the opportunity changes stage / the note is appended, as the server would).
 */
export interface CrmWriteScript {
  respond: (
    body: Record<string, unknown>,
    call: number,
    ghl: ScriptedGhl,
  ) => { status: number; body: unknown; delayMs?: number } | null;
}

export interface CrmScript {
  /** Called per POST /functions/v1/crm; may mutate `ghl` the way a real sync would. */
  respond: (call: number, ghl: ScriptedGhl) => { status: number; body: unknown };
}

export interface MockOptions {
  /** 'active' → app_users row readable; 'deactivated' → zero rows (RLS); 'banned' → GoTrue refuses. */
  account?: 'active' | 'deactivated' | 'banned' | 'wrong-password';
  /** The mirror tables. Absent = empty tables, which the overview reads as "not set up". */
  ghl?: ScriptedGhl;
  /** Every `ghl_*` read answers 401 (an expired session at PostgREST) until a test says otherwise. */
  ghlUnauthorized?: boolean;
  /** Every `ghl_*` read answers 500 until a test flips `state.ghlFailing`. */
  ghlFailing?: boolean;
  /** Every `ghl_*` read waits this long first — a slow connection. */
  ghlDelayMs?: number;
  crm?: CrmScript;
  /** Milestone 4 part 4: how the crm endpoint answers a move or a note. */
  crmWrite?: CrmWriteScript;
  admin?: boolean;
  /** Everyone BESIDES the signed-in user. Their own row is always present when active. */
  roster?: ScriptedStaff[];
  /** Force one status/body from the admin endpoint instead of the faithful default. */
  adminFailure?: { status: number; body: unknown };
  conversations?: {
    id: string;
    title: string | null;
    last_active_at: string;
    user_id?: string;
    /** Stage 3 part 5 (R27). 'workspace' unless a test says otherwise, as in production. */
    scope?: string;
  }[];
  /** Stage 3 part 5: other people's private conversations, as the admin listing returns them. */
  privateConversations?: {
    id: string;
    authorId: string;
    authorEmail: string | null;
    createdAt: string;
    lastActiveAt: string;
  }[];
  /** Keyed by conversation id: what an audited admin read hands back. */
  privateMessages?: Record<string, ScriptedMessage[]>;
  messages?: Record<string, ScriptedMessage[]>;
  chat?: ChatScript;
  facts?: ScriptedFact[];
  chunks?: ScriptedChunk[];
  /** Force one status/body from the memory endpoint instead of the faithful default. */
  memoryFailure?: { status: number; body: unknown };
  /** Milestone 5 part 1: files already attached to conversations. */
  files?: ScriptedFile[];
  /** Milestone 5 part 2: what is at each address, as the scripted server would fetch it. */
  pages?: Record<string, ScriptedPage>;
  filesScript?: FilesScript;
  /** Every call to the files endpoint waits this long first — a slow connection. */
  filesDelayMs?: number;
  /** What the estimate reports as already spent today. */
  spentTodayUsd?: number;
  /** Every chat reply waits this long first, so a test can act while a question is in flight. */
  chatDelayMs?: number;
  /** Milestone 5 part 3a: the Drive connection and what is in the Drive. */
  drive?: DriveScript;
  /** Milestone 5 part 5: learned documents, readable by name (migration 20261017010000). */
  knowledgeSources?: ScriptedKnowledgeSource[];
}

export interface MockState {
  readonly chatCalls: { message: string; conversationId?: string; authorization: string | null }[];
  readonly anthropicCalls: number;
  signOuts: number;
  /** Every POST to /functions/v1/memory — the only sanctioned way memory changes. */
  readonly memoryCalls: { body: Record<string, unknown>; authorization: string | null }[];
  /** Every POST to /functions/v1/admin — the only sanctioned way an account changes. */
  readonly adminCalls: { body: Record<string, unknown>; authorization: string | null }[];
  /** Any non-GET/HEAD request to PostgREST. This must stay empty in every test. */
  readonly postgrestWrites: { method: string; path: string }[];
  readonly facts: ScriptedFact[];
  readonly chunks: ScriptedChunk[];
  readonly staff: ScriptedStaff[];
  readonly conversations: {
    id: string;
    title: string | null;
    last_active_at: string;
    user_id?: string;
    scope?: string;
    deleted_at?: string | null;
  }[];
  /** Every admin read the app performed. Each one is an audit row in production. */
  readonly adminReads: string[];
  /** Every password the scripted admin endpoint has generated, so a test can look for leaks. */
  readonly issuedPasswords: string[];
  /** Milestone 4 part 2: the mirror as the overview reads it; a test may change it mid-way. */
  readonly ghl: ScriptedGhl;
  /** Every POST to /functions/v1/crm — the only sanctioned way the mirror is refreshed. */
  readonly crmCalls: { body: Record<string, unknown>; authorization: string | null }[];
  /** Every `ghl_*` read the app made, by table, so a test can prove nothing was read twice. */
  readonly ghlReads: string[];
  ghlUnauthorized: boolean;
  ghlFailing: boolean;
  ghlDelayMs: number;
  /** Every POST to /functions/v1/files — the only way a file is attached or removed. */
  readonly fileCalls: {
    body: Record<string, unknown>;
    authorization: string | null;
    /** The request's query string: a page read is pinned to a region through it. */
    query: string;
  }[];
  /** Every address the scripted server was asked to fetch, in order. */
  readonly pageFetches: { url: string; requestId: string }[];
  /** What is at each address; a test may change a page between two reads. */
  readonly pages: Record<string, ScriptedPage>;
  /** The `conversation_files` rows; a test may change them mid-way. */
  readonly files: ScriptedFile[];
  /** Every page image that reached the endpoint. */
  readonly pageImages: SentPageImage[];
  filesDelayMs: number;
  /** Milestone 5 part 3a: every POST to /functions/v1/drive. */
  readonly driveCalls: { body: Record<string, unknown>; authorization: string | null }[];
  /** The connection as the endpoint would report it; a test may change it mid-way. */
  driveStatus: ScriptedDriveStatus;
  /** What Google holds; a test may change a file between two reads. */
  readonly driveFiles: Record<string, ScriptedDriveFile>;
  /** Every visit to Google's consent page, as the browser made it. */
  readonly googleVisits: string[];
}

/**
 * Milestone 4 part 4: what the real crm endpoint does with a move or a note, as far as the
 * browser can tell — the opportunity's stage changes in the mirror (GoHighLevel first, then
 * the row), a note is appended with the signed-in author, and the reply carries ids and
 * flags only. A missing opportunity answers 410 as the server would.
 */
/** The ids of a PostgREST `id=in.(a,b)` filter. */
function idsIn(search: string): string[] {
  const match = /(?:^|[?&])id=in\.\(([^)]*)\)/.exec(decodeURIComponent(search));
  return (match?.[1] ?? '')
    .split(',')
    .map((id) => id.replace(/"/g, ''))
    .filter((id) => id !== '');
}

/** A body field as text; anything that is not a string is an empty string. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function faithfulWrite(
  body: Record<string, unknown>,
  call: number,
  ghl: ScriptedGhl,
): { status: number; body: unknown } {
  const opportunityId = asText(body['opportunityId']);
  const opp = ghl.opportunities.find((o) => o.ghl_id === opportunityId && o.removed_at === null);
  const writeId = `w-${String(call)}`;
  if (opp === undefined) {
    return {
      status: 410,
      body: {
        error: {
          code: 'OPPORTUNITY_GONE',
          message:
            'This lead was deleted in GoHighLevel since your screen loaded. Nothing was changed — refresh to update the board.',
          retryable: false,
        },
      },
    };
  }
  if (body['action'] === 'move') {
    const toStageId = asText(body['toStageId']);
    const from = opp.stage_ghl_id;
    const screen = typeof body['fromStageId'] === 'string' ? body['fromStageId'] : null;
    if (!ghl.stages.some((s) => s.ghl_id === toStageId && s.removed_at === null)) {
      return {
        status: 409,
        body: {
          error: {
            code: 'STAGE_UNKNOWN',
            message:
              'That stage is no longer in the pipeline. Nothing was changed — refresh to see the current stages.',
            retryable: false,
          },
        },
      };
    }
    opp.stage_ghl_id = toStageId;
    return {
      status: 200,
      body: {
        action: 'move',
        opportunityId,
        fromStageId: from,
        toStageId,
        changed: from !== toStageId,
        movedByOther: screen !== null && screen !== from,
        replay: false,
        landedAfterTimeout: false,
        mirrored: true,
        writeId,
        durationMs: 700,
      },
    };
  }
  const text = asText(body['body']).trim();
  if (text === '') {
    return {
      status: 400,
      body: {
        error: {
          code: 'EMPTY_NOTE',
          message: 'Write something before saving the note.',
          retryable: false,
        },
      },
    };
  }
  const now = new Date().toISOString();
  const note: ScriptedNote = {
    ghl_id: `note-${String(call)}`,
    contact_ghl_id: opp.contact_ghl_id ?? '',
    opportunity_ghl_id: opportunityId,
    author_user_id: USER_ID,
    body: text,
    ghl_date_added: now,
    created_at: now,
  };
  ghl.notes = [note, ...(ghl.notes ?? [])];
  return {
    status: 200,
    body: {
      action: 'note',
      opportunityId,
      noteId: note.ghl_id,
      body: text,
      createdAt: now,
      authorUserId: USER_ID,
      mirrored: true,
      writeId,
      durationMs: 400,
    },
  };
}

/** A mirror with nothing in it: the sync has never run. */
export function emptyGhl(): ScriptedGhl {
  return { pipelines: [], stages: [], opportunities: [], contacts: [], runs: [] };
}

function json(
  route: Route,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', ...extra },
    body: JSON.stringify(body),
  });
}

function sessionBody(): unknown {
  const token = fakeAccessToken();
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e-refresh',
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: EMAIL,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: '2026-08-01T00:00:00Z',
    },
  };
}

export async function installMock(page: Page, options: MockOptions = {}): Promise<MockState> {
  const account = options.account ?? 'active';
  const messages = options.messages ?? {};
  const me: ScriptedStaff = {
    user_id: USER_ID,
    email: EMAIL,
    role: 'staff',
    is_active: true,
    is_admin: options.admin === true,
    created_at: '2026-08-01T02:00:00Z',
  };
  const state: MockState = {
    chatCalls: [],
    anthropicCalls: 0,
    signOuts: 0,
    memoryCalls: [],
    adminCalls: [],
    postgrestWrites: [],
    facts: [...(options.facts ?? [])],
    chunks: [...(options.chunks ?? [])],
    staff: [me, ...(options.roster ?? [])],
    conversations: (options.conversations ?? []).map((c) => ({
      deleted_at: null,
      scope: 'workspace',
      ...c,
    })),
    adminReads: [],
    issuedPasswords: [],
    ghl: options.ghl ?? emptyGhl(),
    crmCalls: [],
    ghlReads: [],
    ghlUnauthorized: options.ghlUnauthorized === true,
    ghlFailing: options.ghlFailing === true,
    ghlDelayMs: options.ghlDelayMs ?? 0,
    fileCalls: [],
    pageFetches: [],
    pages: { ...(options.pages ?? {}) },
    files: [...(options.files ?? [])],
    pageImages: [],
    filesDelayMs: options.filesDelayMs ?? 0,
    driveCalls: [],
    driveStatus: options.drive?.status ?? { state: 'not_connected' },
    driveFiles: { ...(options.drive?.files ?? {}) },
    googleVisits: [],
  };
  /** The scripted drive endpoint's record of each read: what `begin` is checked against. */
  const driveReceipts = new Map<
    string,
    { fileId: string; name: string; byteSize: number; contentHash: string; fetchedAt: string }
  >();
  /** Where the app is served from, as its own requests say: Google sends him back there. */
  let appOrigin = 'http://127.0.0.1:4173';
  /** Uploads claimed and not yet finished, by file id. */
  const pendingFiles = new Map<
    string,
    {
      requestId: string;
      conversationId: string;
      contentHash: string;
      name: string;
      kind: string;
      byteSize: number;
      expected: number;
      stored: Set<number>;
      vision: number;
      /** Milestone 5 part 2: the receipt this upload was claimed against, if it came by link. */
      source: { url: string; host: string; fetchedAt: string } | null;
      /** How many places the reader marked as left empty by the page. */
      missing: number;
      /** The reader marked the page as read as the site sent it. */
      asSent: boolean;
      /** Milestone 5 part 3a: the Drive file this upload was claimed against, if any. */
      driveFileId: string | null;
    }
  >();
  /** The scripted server's record of each fetch: what `begin` is checked against. */
  const receipts = new Map<
    string,
    { finalUrl: string; host: string; byteSize: number; contentHash: string; fetchedAt: string }
  >();
  const NOT_LOADED = '[not in the page as fetched]';
  const AS_SENT = '[read as the site sent it]';
  /** As src/lib/files/text.ts does for a page's title: text, never markup. */
  const cleanTitle = (raw: string, fallback: string): string => {
    const cleaned = raw
      .replace(/[\t\n\r]/g, ' ')
      .replace(/</g, '(')
      .replace(/>/g, ')')
      .replace(/["`]/g, "'")
      .replace(/&/g, '+')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned === '') return fallback;
    const chars = Array.from(cleaned);
    return chars.length <= 120 ? cleaned : `${chars.slice(0, 119).join('')}…`;
  };
  let fileCall = 0;
  let fileSeq = 0;
  let chatCall = 0;
  let crmCall = 0;
  let crmWriteCall = 0;
  let newRow = 0;
  let newPerson = 0;

  // The assertion behind Part C item 2 and PHASE-ACCEPTANCE item 6: the browser never
  // talks to Anthropic. Any request there is counted and refused.
  await page.route('https://api.anthropic.com/**', async (route) => {
    (state as { anthropicCalls: number }).anthropicCalls += 1;
    await route.abort();
  });

  // Milestone 5 part 3a: Google's consent screen, stood in for. The browser is sent here by a
  // full-page navigation; Google would ask him, then send him to OUR callback, which sends him
  // to /settings with the attempt to finish. Both hops are folded into one redirect here: the
  // callback's own behaviour is the server's, tested in tests/unit/drive/page.test.ts.
  await page.route('https://accounts.google.com/**', async (route) => {
    const url = route.request().url();
    state.googleVisits.push(url);
    const attempt = new URL(url).searchParams.get('state') ?? '';
    await route.fulfill({
      status: 302,
      headers: { location: `${appOrigin}/settings?drive=returned&attempt=${attempt}` },
      body: '',
    });
  });

  await page.route(`${E2E_SUPABASE_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        },
      });
      return;
    }

    // ---- GoTrue ----
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      if (account === 'wrong-password') {
        await json(route, 400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        });
        return;
      }
      if (account === 'banned') {
        await json(route, 403, { code: 403, error_code: 'user_banned', msg: 'User is banned' });
        return;
      }
      await json(route, 200, sessionBody());
      return;
    }
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      await json(route, 200, sessionBody());
      return;
    }
    if (path === '/auth/v1/user') {
      await json(route, 200, (sessionBody() as { user: unknown }).user);
      return;
    }
    if (path === '/auth/v1/logout') {
      state.signOuts += 1;
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return;
    }

    // ---- PostgREST (selects only; the browser has no write privilege) ----
    // Part C item 6: the page must never write through PostgREST. Anything but a read is
    // recorded and refused exactly as the privilege layer would refuse it (42501).
    if (path.startsWith('/rest/v1/') && method !== 'GET' && method !== 'HEAD') {
      state.postgrestWrites.push({ method, path });
      await json(route, 403, {
        code: '42501',
        message: `permission denied for table ${path.replace('/rest/v1/', '')}`,
      });
      return;
    }

    // ---- the GoHighLevel mirror (Milestone 4 part 2) ----
    // Five selects under RLS, answered from `state.ghl` with the filters the overview sends
    // (`removed_at=is.null`, `status=eq.open`, `ghl_id=in.(…)`, `limit`) honoured, so a test
    // that scripts a removed or a won opportunity proves the screen never shows it.
    if (path.startsWith('/rest/v1/ghl_')) {
      const table = path.slice('/rest/v1/'.length);
      state.ghlReads.push(table);
      if (state.ghlDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.ghlDelayMs));
      }
      if (state.ghlUnauthorized) {
        await json(route, 401, { code: 'PGRST301', message: 'JWT expired' });
        return;
      }
      if (state.ghlFailing) {
        await json(route, 500, { code: 'XX000', message: 'scripted failure' });
        return;
      }
      const limit = Number(url.searchParams.get('limit') ?? '1000');
      const ghl = state.ghl;
      let rows: unknown[] = [];
      switch (table) {
        case 'ghl_pipelines':
          rows = ghl.pipelines;
          break;
        case 'ghl_stages':
          rows = ghl.stages;
          break;
        case 'ghl_opportunities': {
          const liveOnly = url.searchParams.get('removed_at') === 'is.null';
          const openOnly = url.searchParams.get('status') === 'eq.open';
          const one = /^eq\.(.+)$/.exec(url.searchParams.get('ghl_id') ?? '')?.[1] ?? null;
          rows = ghl.opportunities
            .filter(
              (o) =>
                (!liveOnly || o.removed_at === null) &&
                (!openOnly || o.status === 'open') &&
                (one === null || o.ghl_id === one),
            )
            // Part 4: the detail selects the whole row; a scripted row carries the columns
            // the board needs and the rest default to what a fresh sync writes.
            .map((o) => ({
              monetary_value: 0,
              source: null,
              assigned_to: null,
              ghl_updated_at: null,
              last_stage_change_at: null,
              last_status_change_at: null,
              ...o,
            }));
          break;
        }
        case 'ghl_contacts': {
          const filter = url.searchParams.get('ghl_id') ?? '';
          const single = /^eq\.(.+)$/.exec(filter)?.[1];
          const wanted =
            /^in\.\((.*)\)$/.exec(filter)?.[1]?.split(',') ??
            (single === undefined ? null : [single]);
          const liveContacts = url.searchParams.get('removed_at') === 'is.null';
          rows = ghl.contacts
            .filter((c) => wanted === null || wanted.includes(c.ghl_id))
            .filter((c) => !liveContacts || c.removed_at === null)
            .map((c) => ({
              source: null,
              dnd: null,
              tags: [],
              ghl_created_at: null,
              ghl_updated_at: null,
              ...c,
              email: c.email ?? null,
              phone: c.phone ?? null,
              custom_fields: c.custom_fields ?? {},
            }));
          break;
        }
        case 'ghl_notes': {
          const forOpp =
            /^eq\.(.+)$/.exec(url.searchParams.get('opportunity_ghl_id') ?? '')?.[1] ?? null;
          rows = (ghl.notes ?? [])
            .filter((n) => forOpp === null || n.opportunity_ghl_id === forOpp)
            .sort((a, b) =>
              (b.ghl_date_added ?? b.created_at).localeCompare(a.ghl_date_added ?? a.created_at),
            );
          break;
        }
        case 'ghl_custom_fields':
          rows = ghl.customFields ?? [];
          break;
        case 'ghl_field_map':
          // The seed's two form-answer rows (seed.sql), as the leads screen reads them.
          rows = (
            ghl.fieldMap ?? [
              {
                internal_field: 'loan_balance',
                ghl_custom_field_id: LOAN_BALANCE_FIELD,
                entity: 'contact',
              },
              {
                internal_field: 'current_interest_rate',
                ghl_custom_field_id: INTEREST_RATE_FIELD,
                entity: 'contact',
              },
            ]
          ).filter(
            (r) => url.searchParams.get('entity') !== 'eq.contact' || r.entity === 'contact',
          );
          break;
        case 'ghl_sync_runs':
          // Two reads (14 Oct 2026): the newest runs, and the newest run that APPLIED on its
          // own — however many failed runs sit on top of it.
          rows =
            url.searchParams.get('applied_at') === 'not.is.null'
              ? ghl.runs
                  .filter((r) => r.applied_at !== null)
                  .sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? ''))
              : [...ghl.runs].sort((a, b) => b.started_at.localeCompare(a.started_at));
          break;
        default:
          break;
      }
      await json(route, 200, rows.slice(0, limit));
      return;
    }

    if (path === '/rest/v1/app_users') {
      // A deactivated account reads ZERO rows — including its own. That is RLS, and it is
      // what App.tsx's sign-in check depends on (migration 20260828010000 kept it true).
      // An active one reads the whole roster: that is the part-4 widening, and nothing more.
      const single = url.search.includes(`user_id=eq.${USER_ID}`);
      const rows = account !== 'active' ? [] : single ? [me] : state.staff;
      await json(route, 200, rows);
      return;
    }
    if (path === '/rest/v1/conversations') {
      await json(
        route,
        200,
        state.conversations
          .filter((c) => (c.deleted_at ?? null) === null)
          .map((c) => ({
            id: c.id,
            title: c.title,
            last_active_at: c.last_active_at,
            scope: c.scope ?? 'workspace',
            user_id: c.user_id ?? USER_ID,
          })),
      );
      return;
    }
    if (path === '/rest/v1/messages') {
      const match = /conversation_id=eq\.([^&]+)/.exec(url.search);
      const id = match?.[1] ?? '';
      await json(
        route,
        200,
        (messages[id] ?? []).map((m) => ({
          ...m,
          conversation_id: id,
          document_coverage: m.document_coverage ?? null,
        })),
      );
      return;
    }

    // ---- knowledge_sources (Milestone 5 part 5): a name by id, for the note under a reply ----
    if (path === '/rest/v1/knowledge_sources') {
      const wanted = idsIn(url.search);
      await json(
        route,
        200,
        (options.knowledgeSources ?? []).filter((k) => wanted.includes(k.id)),
      );
      return;
    }

    if (path === '/rest/v1/memory_facts') {
      await json(route, 200, state.facts);
      return;
    }
    if (path === '/rest/v1/memory_chunks') {
      const live = url.search.includes('deleted_at=is.null');
      await json(
        route,
        200,
        live ? state.chunks.filter((c) => c.deleted_at === null) : state.chunks,
      );
      return;
    }

    // ---- the memory Edge Function (Stage 3 part 3) ----
    // Faithful to src/lib/memory/page.ts on the parts the interface depends on: append-only
    // with supersede, a self-reference for "forgotten", a tombstone for a deleted summary.
    if (path === '/functions/v1/memory' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.memoryCalls.push({
        body,
        authorization: request.headers()['authorization'] ?? null,
      });
      if (options.memoryFailure !== undefined) {
        await json(route, options.memoryFailure.status, options.memoryFailure.body);
        return;
      }
      const now = new Date().toISOString();
      const action = body['action'];
      if (action === 'add' || action === 'edit') {
        const existing =
          action === 'edit' ? state.facts.find((f) => f.id === body['factId']) : undefined;
        const key = existing?.key ?? 'writing:added-from-the-page';
        const value = String(action === 'edit' ? body['value'] : body['text']).trim();
        const live = state.facts.find((f) => f.key === key && f.superseded_by === null);
        newRow += 1;
        const id = `new-fact-${String(newRow)}`;
        // A live row is superseded; a forgotten row keeps its self-reference and the new
        // row simply becomes live again under the same key — that is "add it back".
        if (live !== undefined) live.superseded_by = id;
        state.facts.push({
          id,
          user_id: USER_ID,
          scope: 'workspace',
          key,
          value,
          superseded_by: null,
          created_at: now,
        });
        await json(route, 200, {
          action,
          outcome: 'saved',
          factId: id,
          key,
          value,
          replaced: live !== undefined,
        });
        return;
      }
      if (action === 'forget') {
        const row = state.facts.find((f) => f.id === body['factId']);
        if (row === undefined) {
          await json(route, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'That note is no longer there.',
              retryable: false,
            },
          });
          return;
        }
        row.superseded_by = row.id;
        await json(route, 200, { action: 'forget', outcome: 'forgotten', factId: row.id });
        return;
      }
      if (action === 'rename_conversation') {
        const row = state.conversations.find((c) => c.id === body['conversationId']);
        if (row === undefined) {
          await json(route, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'That conversation is no longer there.',
              retryable: false,
            },
          });
          return;
        }
        const title = String(body['title']).trim();
        const unchanged = row.title === title;
        row.title = title;
        await json(route, 200, {
          action,
          outcome: unchanged ? 'unchanged' : 'renamed',
          conversationId: row.id,
          title,
        });
        return;
      }
      if (action === 'delete_conversation') {
        const row = state.conversations.find((c) => c.id === body['conversationId']);
        const already = row === undefined || (row.deleted_at ?? null) !== null;
        // Faithful to the transaction: the conversation is soft-deleted, its conversation
        // notes are tombstoned, and standing notes are untouched.
        let tombstoned = 0;
        if (row !== undefined && !already) {
          row.deleted_at = now;
          for (const chunk of state.chunks) {
            if (chunk.conversation_id === row.id && chunk.deleted_at === null) {
              chunk.deleted_at = now;
              chunk.summary = '(removed from memory by a user)';
              chunk.audience = null;
              tombstoned += 1;
            }
          }
        }
        await json(route, 200, {
          action,
          outcome: already ? 'already' : 'deleted',
          conversationId: String(body['conversationId']),
          messagesDeleted: already ? 0 : 2,
          chunksTombstoned: tombstoned,
        });
        return;
      }
      if (action === 'set_conversation_privacy') {
        const row = state.conversations.find((c) => c.id === body['conversationId']);
        if (row === undefined) {
          await json(route, 404, {
            error: {
              code: 'NOT_FOUND',
              message: 'That conversation is no longer there.',
              retryable: false,
            },
          });
          return;
        }
        // Faithful to the server: only the author may, and an admin may not.
        if ((row.user_id ?? USER_ID) !== USER_ID) {
          await json(route, 403, {
            error: {
              code: 'NOT_YOURS',
              message: 'Only the person who started a conversation can change who sees it.',
              retryable: false,
            },
          });
          return;
        }
        const wanted = body['isPrivate'] === true ? 'user' : 'workspace';
        const unchanged = (row.scope ?? 'workspace') === wanted;
        row.scope = wanted;
        await json(route, 200, {
          action,
          outcome: unchanged ? 'unchanged' : 'changed',
          conversationId: row.id,
          isPrivate: wanted === 'user',
        });
        return;
      }
      if (action === 'admin_list_private') {
        if (options.admin !== true) {
          await json(route, 403, {
            error: {
              code: 'NOT_ADMIN',
              message: 'Only an administrator can do that.',
              retryable: false,
            },
          });
          return;
        }
        await json(route, 200, {
          action,
          outcome: 'listed',
          conversations: options.privateConversations ?? [],
        });
        return;
      }
      if (action === 'admin_read_conversation') {
        if (options.admin !== true) {
          await json(route, 403, {
            error: {
              code: 'NOT_ADMIN',
              message: 'Only an administrator can do that.',
              retryable: false,
            },
          });
          return;
        }
        const id = String(body['conversationId']);
        // In production this is where the audit row is written. Recording it here lets a
        // browser test assert that the app asks ONCE, on a tap, and never on a render.
        state.adminReads.push(id);
        const listed = (options.privateConversations ?? []).find((c) => c.id === id);
        await json(route, 200, {
          action,
          outcome: 'read',
          conversationId: id,
          title: 'A thread of hers',
          authorEmail: listed?.authorEmail ?? null,
          messages: (options.privateMessages?.[id] ?? []).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at,
          })),
        });
        return;
      }
      if (action === 'delete_chunk') {
        const row = state.chunks.find((c) => c.id === body['chunkId']);
        if (row !== undefined) row.deleted_at = now;
        await json(route, 200, {
          action: 'delete_chunk',
          outcome: 'deleted',
          chunkId: String(body['chunkId']),
        });
        return;
      }
      await json(route, 400, {
        error: { code: 'BAD_REQUEST', message: 'unknown action', retryable: false },
      });
      return;
    }

    // ---- the admin Edge Function (Stage 3 part 4) ----
    // Faithful to src/lib/auth/page.ts on everything the interface depends on: admin-only,
    // a one-time password returned exactly once, idempotent flag writes, and the refusals
    // that keep the workspace from reaching zero administrators.
    if (path === '/functions/v1/admin' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.adminCalls.push({
        body,
        authorization: request.headers()['authorization'] ?? null,
      });
      if (options.adminFailure !== undefined) {
        await json(route, options.adminFailure.status, options.adminFailure.body);
        return;
      }
      const refuse = (status: number, code: string, message: string): Promise<void> =>
        json(route, status, { error: { code, message, retryable: false } });

      if (!me.is_admin) {
        await refuse(403, 'NOT_ADMIN', 'Only an administrator can add or change people.');
        return;
      }
      const action = body['action'];
      const activeAdmins = (): number =>
        state.staff.filter((u) => u.is_active && u.is_admin).length;

      if (action === 'sign_ins') {
        await json(route, 200, {
          action,
          signIns: state.staff.map((u) => ({
            userId: u.user_id,
            lastSignInAt: u.user_id === USER_ID ? '2026-08-27T01:00:00Z' : null,
          })),
        });
        return;
      }
      if (action === 'create') {
        const raw = body['email'];
        const email = (typeof raw === 'string' ? raw : '').trim().toLowerCase();
        if (email === '') {
          await refuse(400, 'BAD_REQUEST', 'Enter their email address.');
          return;
        }
        if (state.staff.some((u) => u.email === email)) {
          await refuse(
            409,
            'ALREADY_EXISTS',
            'Someone with that email address is already on the list. Look for them below — they may just need their access restored.',
          );
          return;
        }
        newPerson += 1;
        const userId = `e2e00000-0000-4000-8000-00000000000${String(newPerson)}`;
        const password = `Zx7Kp2Qm9Rt4Vn6Ws8Yb3Hd${String(newPerson)}`.slice(0, 24);
        state.issuedPasswords.push(password);
        state.staff.push({
          user_id: userId,
          email,
          role: 'staff',
          is_active: true,
          is_admin: false,
          created_at: new Date().toISOString(),
        });
        await json(route, 200, { action, userId, email, oneTimePassword: password });
        return;
      }

      const target = state.staff.find((u) => u.user_id === body['userId']);
      if (target === undefined) {
        await refuse(400, 'BAD_REQUEST', 'userId must be a UUID.');
        return;
      }
      if (action === 'reset_password') {
        if (!target.is_active) {
          await refuse(
            403,
            'INACTIVE_TARGET',
            'This person no longer has access. Restore their access first.',
          );
          return;
        }
        const password = `Nq5Jw8Ct3Fy6Lm2Pd9Sb4Kg${String(state.issuedPasswords.length + 1)}`.slice(
          0,
          24,
        );
        state.issuedPasswords.push(password);
        await json(route, 200, {
          action,
          userId: target.user_id,
          email: target.email,
          oneTimePassword: password,
        });
        return;
      }
      if (
        action === 'deactivate' ||
        action === 'reactivate' ||
        action === 'promote' ||
        action === 'demote'
      ) {
        if (action === 'deactivate' && target.user_id === USER_ID) {
          await refuse(
            403,
            'SELF_DEACTIVATION',
            'You cannot remove your own access. Ask another administrator to do it for you.',
          );
          return;
        }
        if (action === 'demote' && target.user_id === USER_ID) {
          await refuse(
            403,
            'SELF_DEMOTION',
            'You cannot remove your own administrator rights. Ask another administrator to do it.',
          );
          return;
        }
        const removesAnAdmin =
          (action === 'deactivate' || action === 'demote') && target.is_admin && target.is_active;
        if (removesAnAdmin && activeAdmins() <= 1) {
          await refuse(
            403,
            'LAST_ADMIN',
            'The Command Centre must always have at least one administrator. Make someone else an administrator first.',
          );
          return;
        }
        if (action === 'promote' && !target.is_active) {
          await refuse(
            403,
            'INACTIVE_TARGET',
            'This person no longer has access. Restore their access first.',
          );
          return;
        }
        const before =
          action === 'promote' || action === 'demote' ? target.is_admin : target.is_active;
        const after = action === 'promote' || action === 'reactivate';
        if (action === 'promote' || action === 'demote') target.is_admin = after;
        else target.is_active = after;
        await json(route, 200, {
          action,
          outcome: before === after ? 'unchanged' : 'changed',
          userId: target.user_id,
          email: target.email,
          activeAdmins: activeAdmins(),
        });
        return;
      }
      await refuse(400, 'BAD_REQUEST', 'action must be one of create, deactivate, …');
      return;
    }

    // ---- the crm Edge Function (Milestone 4 part 2) ----
    // Faithful to src/lib/crm/ghl/page.ts on what the interface depends on: the default
    // answer is a successful run, written to the mirror's run rows the way the real sync
    // writes them, so the screen's re-read finds a fresh `applied_at`. A script replaces it.
    if (path === '/functions/v1/crm' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.crmCalls.push({ body, authorization: request.headers()['authorization'] ?? null });
      // ---- Milestone 4 part 4: a move or a note ----
      if (body['action'] === 'move' || body['action'] === 'note') {
        crmWriteCall += 1;
        const scripted = options.crmWrite?.respond(body, crmWriteCall, state.ghl) ?? null;
        if (scripted !== null) {
          if (scripted.delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
          }
          await json(route, scripted.status, scripted.body);
          return;
        }
        const answer = faithfulWrite(body, crmWriteCall, state.ghl);
        await json(route, answer.status, answer.body);
        return;
      }
      crmCall += 1;
      const script: CrmScript = options.crm ?? {
        respond: (call, ghl) => {
          const now = new Date().toISOString();
          const runId = `run-refresh-${String(call)}`;
          const pipeline = ghl.pipelines[0]?.ghl_id ?? 'M4unnMKBy0TgwCwOA6wS';
          ghl.runs.unshift({
            id: runId,
            pipeline_ghl_id: pipeline,
            status: 'success',
            started_at: now,
            applied_at: now,
            finished_at: now,
            error_code: null,
            contacts_failed: 0,
            contacts_missing: 0,
            contacts_rejected: 0,
            opportunities_rejected: 0,
          });
          const open = ghl.opportunities.filter(
            (o) => o.status === 'open' && o.removed_at === null,
          );
          return {
            status: 200,
            body: {
              action: 'sync',
              status: 'success',
              runId,
              durationMs: 1_200,
              opportunitiesFetched: open.length,
              contactsFetched: ghl.contacts.length,
              contactsUnread: 0,
            },
          };
        },
      };
      const answer = script.respond(crmCall, state.ghl);
      await json(route, answer.status, answer.body);
      return;
    }

    // ---- the chat Edge Function ----
    // ---- conversation_files (Milestone 5 part 1): name, kind, size — never the text ----
    if (path === '/rest/v1/conversation_files' && url.search.includes('id=in.')) {
      // Milestone 5 part 5: names by id, for the note under a reply (the tombstone has none).
      const wanted = idsIn(url.search);
      await json(
        route,
        200,
        state.files.filter((f) => wanted.includes(f.id)).map((f) => ({ id: f.id, name: f.name })),
      );
      return;
    }
    if (path === '/rest/v1/conversation_files') {
      const match = /conversation_id=eq\.([^&]+)/.exec(url.search);
      const id = match?.[1] ?? '';
      await json(
        route,
        200,
        state.files
          .filter(
            (f) => f.conversation_id === id && (f.status === 'ready' || f.status === 'removed'),
          )
          .map((f) => ({
            ...f,
            source_url: f.source_url ?? null,
            source_host: f.source_host ?? null,
            fetched_at: f.fetched_at ?? null,
            values_missing: f.values_missing ?? 0,
            read_as_sent: f.read_as_sent ?? false,
            removed_reason: f.removed_reason ?? null,
          })),
      );
      return;
    }

    // ---- the files Edge Function (Milestone 5 part 1) ----
    if (path === '/functions/v1/files' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.fileCalls.push({
        body,
        authorization: request.headers()['authorization'] ?? null,
        query: url.search,
      });
      fileCall += 1;
      if (state.filesDelayMs > 0) await new Promise((r) => setTimeout(r, state.filesDelayMs));
      const scripted = options.filesScript?.respond(body, fileCall);
      if (scripted === 'abort') {
        await route.abort();
        return;
      }
      if (scripted !== undefined) {
        await json(route, scripted.status, scripted.body);
        return;
      }
      const action = asText(body['action']);
      const fileId = asText(body['fileId']);
      const view = (f: ScriptedFile): Record<string, unknown> => ({
        id: f.id,
        conversationId: f.conversation_id,
        uploadedBy: f.uploaded_by,
        name: f.name,
        kind: f.kind,
        byteSize: f.byte_size,
        pageCount: f.page_count,
        charCount: 0,
        visionPages: f.vision_pages,
        status: f.status,
        createdAt: f.created_at,
        expiresAt: f.expires_at,
        sourceUrl: f.source_url ?? null,
        sourceHost: f.source_host ?? null,
        fetchedAt: f.fetched_at ?? null,
        valuesMissing: f.values_missing ?? 0,
        readAsSent: f.read_as_sent ?? false,
        driveFileId: f.drive_file_id ?? null,
      });
      const notFound = {
        error: {
          code: 'NOT_FOUND',
          message: 'That file or conversation is no longer available.',
          retryable: false,
        },
      };
      if (action === 'fetch_page') {
        const asked = asText(body['url']);
        const requestId = asText(body['requestId']);
        // One id opens one page, once (migration 20261012020000, claim_web_fetch).
        if (receipts.has(requestId) || state.pageFetches.some((f) => f.requestId === requestId)) {
          await json(route, 409, {
            error: {
              code: 'FETCH_EXPIRED',
              message: 'That page has to be opened again before it can be attached. Try again.',
              retryable: true,
            },
          });
          return;
        }
        state.pageFetches.push({ url: asked, requestId });
        const found = state.pages[asked];
        if (found === undefined) {
          await json(route, 422, {
            error: {
              code: 'PAGE_REFUSED',
              message: 'No website was found at that address. Check the link for a typing mistake.',
              retryable: false,
              refusal: 'site_not_found',
            },
          });
          return;
        }
        if ('refused' in found) {
          await json(route, 422, {
            error: {
              code: 'PAGE_REFUSED',
              message: found.message,
              retryable: false,
              refusal: found.refused,
            },
          });
          return;
        }
        if ('failed' in found) {
          await json(route, found.failed, {
            error: { code: 'PAGE_NOT_READ', message: found.message, retryable: true },
          });
          return;
        }
        if ((found.delayMs ?? 0) > 0) await new Promise((r) => setTimeout(r, found.delayMs));
        const bytes = typeof found.body === 'string' ? Buffer.from(found.body, 'utf8') : found.body;
        const final = new URL(found.finalUrl ?? asked);
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const contentType = found.contentType ?? 'text/html; charset=utf-8';
        receipts.set(requestId, {
          finalUrl: final.href,
          host: final.host,
          byteSize: bytes.length,
          contentHash,
          fetchedAt: new Date().toISOString(),
        });
        const meta = {
          action: 'fetch_page',
          fetchId: requestId,
          host: final.host,
          fileName: final.pathname.split('/').filter(Boolean).pop() ?? '',
          contentType,
          byteSize: bytes.length,
          contentHash,
        };
        await route.fulfill({
          status: 200,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'x-page-meta',
            'content-type': 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'content-disposition': 'attachment',
            'x-page-meta': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url'),
          },
          body: bytes,
        });
        return;
      }
      if (action === 'estimate') {
        const pages = Number(body['visionPages']);
        await json(route, 200, {
          action: 'estimate',
          pages,
          perPageUsd: 0.027132,
          estimateUsd: Math.round(pages * 0.027132 * 1e6) / 1e6,
          dailyCapUsd: 5,
          spentTodayUsd: options.spentTodayUsd ?? 0,
          affordable: true,
        });
        return;
      }
      if (action === 'begin') {
        const requestId = asText(body['requestId']);
        const conversationId = asText(body['conversationId']) || CONV_ID;
        const replay = [...pendingFiles.entries()].find(([, p]) => p.requestId === requestId);
        if (replay !== undefined) {
          await json(route, 200, {
            action: 'begin',
            fileId: replay[0],
            conversationId: replay[1].conversationId,
            status: 'reading',
            duplicate: false,
            pagesStored: [...replay[1].stored].sort((a, b) => a - b),
            file: null,
          });
          return;
        }
        const hash = asText(body['contentHash']);
        const fetchId = asText(body['fetchId']);
        const receipt = fetchId === '' ? undefined : receipts.get(fetchId);
        // Milestone 5 part 3a: a Drive file is attached only against the server's record of
        // the read, and is named as Drive named it.
        const driveReadId = asText(body['driveReadId']);
        const driveReceipt = driveReadId === '' ? undefined : driveReceipts.get(driveReadId);
        if (driveReadId !== '') {
          const matches =
            driveReceipt?.contentHash === hash &&
            driveReceipt.byteSize === Number(body['byteSize']);
          if (!matches) {
            await json(route, 409, {
              error: {
                code: 'FETCH_EXPIRED',
                message:
                  'That file has to be read from Google Drive again before it can be attached. Try again.',
                retryable: true,
              },
            });
            return;
          }
        } else if (fetchId !== '' || asText(body['kind']) === 'html') {
          // A page is attached only against the bytes the server itself fetched.
          const matches =
            receipt?.contentHash === hash && receipt.byteSize === Number(body['byteSize']);
          if (!matches) {
            await json(route, 409, {
              error: {
                code: 'FETCH_EXPIRED',
                message: 'That page has to be opened again before it can be attached. Try again.',
                retryable: true,
              },
            });
            return;
          }
        }
        const same = state.files.find(
          (f) =>
            f.conversation_id === conversationId &&
            f.status === 'ready' &&
            (f as ScriptedFile & { content_hash?: string }).content_hash === hash,
        );
        if (same !== undefined) {
          // The site was asked again and nothing had changed: that copy is as fresh as this read.
          if (receipt !== undefined) same.fetched_at = receipt.fetchedAt;
          if (driveReceipt !== undefined && same.drive_file_id === driveReceipt.fileId) {
            same.fetched_at = driveReceipt.fetchedAt;
            same.name = driveReceipt.name;
          }
          await json(route, 200, {
            action: 'begin',
            fileId: same.id,
            conversationId,
            status: 'ready',
            duplicate: true,
            pagesStored: [],
            file: view(same),
          });
          return;
        }
        fileSeq += 1;
        const id = `f1000000-0000-4000-8000-${String(fileSeq).padStart(12, '0')}`;
        pendingFiles.set(id, {
          requestId,
          conversationId,
          contentHash: hash,
          // A page is called by its own title, cleaned; with none, by the site it came from.
          name:
            driveReceipt !== undefined
              ? driveReceipt.name
              : asText(body['kind']) === 'html' && receipt !== undefined
                ? cleanTitle(asText(body['title']), receipt.host)
                : asText(body['name']),
          kind: asText(body['kind']),
          byteSize: Number(body['byteSize']),
          expected: Number(body['totalPages']),
          stored: new Set(),
          vision: 0,
          source:
            driveReceipt !== undefined
              ? {
                  url: `https://drive.google.com/file/d/${driveReceipt.fileId}/view`,
                  host: 'drive.google.com',
                  fetchedAt: driveReceipt.fetchedAt,
                }
              : receipt === undefined
                ? null
                : { url: receipt.finalUrl, host: receipt.host, fetchedAt: receipt.fetchedAt },
          missing: 0,
          asSent: false,
          driveFileId: driveReceipt?.fileId ?? null,
        });
        if (!state.conversations.some((c) => c.id === conversationId)) {
          state.conversations.unshift({
            id: conversationId,
            title: null,
            last_active_at: new Date().toISOString(),
            scope: 'workspace',
            deleted_at: null,
          });
        }
        await json(route, 200, {
          action: 'begin',
          fileId: id,
          conversationId,
          status: 'reading',
          duplicate: false,
          pagesStored: [],
          file: null,
        });
        return;
      }
      if (action === 'append' || action === 'read_page') {
        const pending = pendingFiles.get(fileId);
        if (pending === undefined) {
          await json(route, 404, notFound);
          return;
        }
        if (action === 'append') {
          const pages = (body['pages'] ?? []) as { pageNo: number; text?: string }[];
          for (const page of pages) {
            if (!pending.stored.has(page.pageNo)) {
              pending.missing += (page.text ?? '').split(NOT_LOADED).length - 1;
              if ((page.text ?? '').includes(AS_SENT)) pending.asSent = true;
            }
            pending.stored.add(page.pageNo);
          }
          await json(route, 200, { action: 'append', fileId, stored: pending.stored.size });
          return;
        }
        const image = asText(body['imageBase64']);
        const pageNo = Number(body['pageNo']);
        const size = jpegSize(image);
        if (!image.startsWith('/9j/') || size.width === 0) {
          await json(route, 400, {
            error: {
              code: 'BAD_REQUEST',
              message: 'imageBase64 must be a JPEG.',
              retryable: false,
            },
          });
          return;
        }
        const replayed = pending.stored.has(pageNo);
        if (!replayed) {
          state.pageImages.push({
            fileId,
            pageNo,
            label: asText(body['label']),
            width: size.width,
            height: size.height,
            base64Chars: image.length,
          });
          pending.stored.add(pageNo);
          pending.vision += 1;
        }
        await json(route, 200, {
          action: 'read_page',
          fileId,
          pageNo,
          pageKind: replayed ? null : 'document',
          legibility: 'full',
          chars: 400,
          replayed,
        });
        return;
      }
      if (action === 'finish') {
        const pending = pendingFiles.get(fileId);
        if (pending === undefined) {
          await json(route, 404, notFound);
          return;
        }
        if (pending.stored.size !== pending.expected) {
          await json(route, 409, {
            error: {
              code: 'INCOMPLETE',
              message: 'Not every page of this file arrived, so it was not attached. Try again.',
              retryable: true,
            },
          });
          return;
        }
        const now = Date.now();
        // A web page's text is kept a day; a document, thirty — wherever it came from.
        const keptDays = pending.kind === 'html' ? 1 : 30;
        const row: ScriptedFile & { content_hash: string } = {
          id: fileId,
          conversation_id: pending.conversationId,
          uploaded_by: USER_ID,
          name: pending.name,
          kind: pending.kind,
          byte_size: pending.byteSize,
          page_count: pending.expected,
          vision_pages: pending.vision,
          status: 'ready',
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + keptDays * 86_400_000).toISOString(),
          content_hash: pending.contentHash,
          source_url: pending.source?.url ?? null,
          source_host: pending.source?.host ?? null,
          fetched_at: pending.source?.fetchedAt ?? null,
          values_missing: pending.missing,
          read_as_sent: pending.asSent,
          removed_reason: null,
          drive_file_id: pending.driveFileId,
        };
        // A newer read of the same address takes the place of the older one.
        let replaced = 0;
        if (row.source_url !== null) {
          for (const older of state.files) {
            if (
              older.conversation_id === row.conversation_id &&
              older.status === 'ready' &&
              older.source_url === row.source_url
            ) {
              older.status = 'removed';
              older.name = null;
              older.source_url = null;
              older.source_host = null;
              older.fetched_at = null;
              older.drive_file_id = null;
              older.removed_reason = 'replaced';
              replaced += 1;
            }
          }
        }
        state.files.push(row);
        pendingFiles.delete(fileId);
        await json(route, 200, { action: 'finish', duplicate: false, replaced, file: view(row) });
        return;
      }
      if (action === 'remove') {
        const row = state.files.find((f) => f.id === fileId);
        const had = pendingFiles.delete(fileId);
        if (row?.status === 'ready') {
          row.status = 'removed';
          row.name = null;
          // A removed row names nothing: not the file, and not where it came from.
          row.source_url = null;
          row.source_host = null;
          row.fetched_at = null;
          row.drive_file_id = null;
          row.removed_reason = 'user';
          await json(route, 200, { action: 'remove', fileId, removed: true });
          return;
        }
        await json(route, 200, { action: 'remove', fileId, removed: had });
        return;
      }
      if (action === 'refused') {
        await json(route, 200, { action: 'refused', logged: true });
        return;
      }
      await json(route, 400, {
        error: { code: 'BAD_REQUEST', message: 'Invalid request: action.', retryable: false },
      });
      return;
    }

    // Milestone 5 part 3a: the drive endpoint, as the browser sees it. It holds the connection
    // and the Drive; the browser holds neither, and never contacts Google for a file.
    if (path === '/functions/v1/drive' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.driveCalls.push({ body, authorization: request.headers()['authorization'] ?? null });
      const origin = request.headers()['origin'];
      if (typeof origin === 'string' && origin !== '') appOrigin = origin;
      const action = asText(body['action']);
      const connectionError = (code: string, message: string, status = 409): Promise<void> =>
        json(route, status, { error: { code, message, retryable: false } });
      if (action === 'status') {
        await json(route, 200, { action: 'status', ...state.driveStatus });
        return;
      }
      if (action === 'connect_start') {
        const attempt = randomUUID();
        await json(route, 200, {
          action: 'connect_start',
          authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=e2e.apps.googleusercontent.com&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive.file')}&state=${attempt}`,
        });
        return;
      }
      if (action === 'connect_finish') {
        const finish = options.drive?.finish ?? {
          outcome: 'connected',
          message: 'Google Drive is connected as broker@example.com.',
        };
        if (finish.outcome === 'connected') {
          state.driveStatus = {
            state: 'connected',
            email: 'broker@example.com',
            connectedAt: new Date().toISOString(),
            lastUsedAt: null,
            checked: true,
          };
        }
        await json(route, 200, { action: 'connect_finish', note: null, ...finish });
        return;
      }
      if (action === 'disconnect') {
        if (options.drive?.disconnectFails === true) {
          await json(route, 503, {
            error: {
              code: 'GOOGLE_UNREACHABLE',
              message:
                "Google could not be reached, so Drive is still connected and Google still holds this app's access. Try again.",
              retryable: true,
            },
          });
          return;
        }
        const was = state.driveStatus.state;
        state.driveStatus = { state: 'not_connected' };
        driveReceipts.clear();
        await json(route, 200, {
          action: 'disconnect',
          disconnected: was === 'connected' || was === 'broken',
          message:
            was === 'connected' || was === 'broken'
              ? "Google Drive is disconnected, and Google has removed this app's access. Files already added to conversations stay there until they are removed, or for 30 days."
              : 'Google Drive was not connected, so there was nothing to disconnect.',
        });
        return;
      }
      if (action === 'picked') {
        await json(route, 200, { action: 'picked', logged: true });
        return;
      }
      if (action === 'read_file') {
        if (
          state.driveStatus.state === 'not_connected' ||
          state.driveStatus.state === 'unavailable'
        ) {
          await connectionError(
            'NOT_CONNECTED',
            'Google Drive is not connected, so nothing was read. Connect it in Settings, then pick the file again.',
          );
          return;
        }
        if (state.driveStatus.state === 'broken') {
          await connectionError(
            'CONNECTION_BROKEN',
            "Google Drive is no longer connected: Google stopped accepting this app's access. It may have been removed in your Google account, or not used for six months. Nothing was read. Connect it again in Settings.",
          );
          return;
        }
        const fileId = asText(body['fileId']);
        const requestId = asText(body['requestId']);
        const found = state.driveFiles[fileId];
        if (found === undefined) {
          await json(route, 422, {
            error: {
              code: 'DRIVE_REFUSED',
              message:
                'That file is no longer in your Google Drive, or this app was not given access to it. Pick it again from Drive.',
              retryable: false,
              refusal: 'drive_file_gone',
            },
          });
          return;
        }
        if ('refused' in found) {
          await json(route, 422, {
            error: {
              code: 'DRIVE_REFUSED',
              message: found.message,
              retryable: false,
              refusal: found.refused,
            },
          });
          return;
        }
        if ('failed' in found) {
          await json(route, found.failed, {
            error: { code: 'DRIVE_NOT_READ', message: found.message, retryable: true },
          });
          return;
        }
        if ((found.delayMs ?? 0) > 0) await new Promise((r) => setTimeout(r, found.delayMs));
        const bytes = typeof found.body === 'string' ? Buffer.from(found.body, 'utf8') : found.body;
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        driveReceipts.set(requestId, {
          fileId,
          name: found.name,
          byteSize: bytes.length,
          contentHash,
          fetchedAt: new Date().toISOString(),
        });
        const meta = {
          action: 'read_file',
          readId: requestId,
          name: found.name,
          fileName: found.fileName ?? found.name,
          contentType: found.contentType ?? 'text/plain',
          byteSize: bytes.length,
          contentHash,
          googleType: found.googleType ?? null,
          fileId,
        };
        await route.fulfill({
          status: 200,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'x-drive-meta',
            'content-type': 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'content-disposition': 'attachment',
            'x-drive-meta': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url'),
          },
          body: bytes,
        });
        return;
      }
      await json(route, 400, {
        error: { code: 'BAD_REQUEST', message: 'Invalid request: action.', retryable: false },
      });
      return;
    }

    if (path === '/functions/v1/chat' && method === 'POST') {
      const body = request.postDataJSON() as { message: string; conversationId?: string };
      state.chatCalls.push({ ...body, authorization: request.headers()['authorization'] ?? null });
      if ((options.chatDelayMs ?? 0) > 0) {
        await new Promise((r) => setTimeout(r, options.chatDelayMs));
      }
      const script = options.chat ?? {
        respond: (input, call) => ({
          status: 200,
          body: {
            conversationId: input.conversationId ?? CONV_ID,
            userMessageId: `u-${String(call)}`,
            assistantMessageId: `a-${String(call)}`,
            reply: `Reply ${String(call)} to: ${input.message}`,
            model: 'claude-sonnet-5',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.001,
          },
        }),
      };
      chatCall += 1;
      const answer = script.respond(body, chatCall);
      const wantsStream = (request.headers()['accept'] ?? '').includes('text/event-stream');
      if ('sse' in answer) {
        if (!wantsStream) {
          const last = answer.sse.at(-1)?.data as
            { reply?: unknown; status?: number; body?: unknown } | undefined;
          if (last?.reply !== undefined) await json(route, 200, last.reply);
          else await json(route, last?.status ?? 500, last?.body ?? {});
          return;
        }
        const text = answer.sse
          .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
          .join('');
        const bytes =
          answer.truncate === true ? text.slice(0, Math.floor(text.length * 0.6)) : text;
        await route.fulfill({
          status: 200,
          headers: {
            'access-control-allow-origin': '*',
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          },
          body: `: open\n\n${bytes}`,
        });
        return;
      }
      await json(route, answer.status, answer.body);
      return;
    }

    await json(route, 404, { message: `unmocked ${method} ${path}` });
  });

  return state;
}

/**
 * Sign in from `path`. Milestone 4 part 2 gave every section an address and made the
 * overview the landing screen; the assistant suites pass '/assistant' to land where they
 * used to, and the overview suite proves that '/' lands on the numbers.
 */
export async function signIn(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A stored session, as supabase-js writes it — a refresh on a phone starts from here. */
export async function seedStoredSession(page: Page): Promise<void> {
  const session = sessionBody();
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: 'fundd-command-centre-auth', value: JSON.stringify(session) },
  );
}
