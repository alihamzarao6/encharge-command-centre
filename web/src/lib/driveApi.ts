/**
 * The calls the browser makes about Google Drive (Milestone 5 part 3a): POSTs to our `drive`
 * endpoint, with the person's own session. The browser holds no Google credential of any kind
 * — no token, no code, no secret — and never contacts Google for a file; the endpoint does,
 * and hands over the bytes.
 *
 * `readDriveFile` is the one reply here that is not JSON: the file's bytes, with what the
 * server measured about them in a header — the same pattern as `fetchPage` (filesApi.ts), and
 * checked the same way before it is believed: the length and the SHA-256 the server reported
 * must be the length and the SHA-256 of what arrived.
 *
 * Pure where it can be, so every sentence a person sees is unit-tested without a browser. The
 * server's own sentence is kept wherever it sent one (src/lib/drive/limits.ts).
 */
import { DRIVE_META_HEADER, decodeDriveMeta } from '../../../src/lib/drive/meta.js';
import type { ConnectOutcome } from '../../../src/lib/drive/limits.js';
import { FILES_API_MESSAGES, interpretFilesFailure, type FilesFailure } from './filesApi.js';

export type DriveStatus =
  | { readonly state: 'unavailable' }
  | { readonly state: 'not_connected' }
  | {
      readonly state: 'connected';
      readonly email: string;
      readonly connectedAt: string;
      readonly lastUsedAt: string | null;
      readonly checked: boolean;
    }
  | {
      readonly state: 'broken';
      readonly email: string;
      readonly brokenAt: string;
      readonly reason: string;
      readonly message: string;
    };

export type DriveRequest =
  | { readonly action: 'status' }
  | { readonly action: 'connect_start' }
  | { readonly action: 'connect_finish'; readonly attempt: string }
  | { readonly action: 'disconnect' }
  | { readonly action: 'picked'; readonly count: number };

export type DriveReply =
  | ({ readonly action: 'status' } & DriveStatus)
  | { readonly action: 'connect_start'; readonly authorizeUrl: string }
  | {
      readonly action: 'connect_finish';
      readonly outcome: ConnectOutcome;
      readonly message: string;
      readonly note: string | null;
    }
  | { readonly action: 'disconnect'; readonly disconnected: boolean; readonly message: string }
  | { readonly action: 'picked'; readonly logged: true };

export type DriveReplyFor<A extends DriveRequest['action']> = Extract<DriveReply, { action: A }>;

/** A failure, as for files, plus whether the way out is the Drive section of Settings. */
export interface DriveFailure extends FilesFailure {
  readonly reconnect: boolean;
}

export type DriveOutcome<R> = { readonly kind: 'ok'; readonly reply: R } | DriveFailure;

/** A file as it arrives from our server: its bytes, and what the server says of them. */
export interface DriveFile {
  readonly readId: string;
  /** Drive's name for it, cleaned: what to show. */
  readonly name: string;
  /** The name to hand the reader (an export carries its extension). */
  readonly fileName: string;
  readonly contentType: string | null;
  readonly contentHash: string;
  /** "Google Doc" for an exported Google file; null for an ordinary one. */
  readonly googleType: string | null;
  /** The Drive file actually read (a shortcut's target, when he picked a shortcut). */
  readonly fileId: string;
  readonly bytes: Uint8Array;
}

export const DRIVE_CLIENT_TIMEOUT_MS = 30_000;
/** A read: the server allows Google 90 s, and a 20 MB file then has to arrive here. */
export const DRIVE_READ_TIMEOUT_MS = 150_000;

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'NOT_CONNECTED',
  'CONNECTION_BROKEN',
  'NOT_CONFIGURED',
]);

export const DRIVE_API_MESSAGES = {
  incompleteFile: 'The file did not arrive whole from Google Drive, so it was not read. Try again.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** What a refusal or failure from the drive endpoint means for the person. */
export function interpretDriveFailure(status: number, body: unknown): DriveFailure {
  const base = interpretFilesFailure(status, body);
  const reconnect = CONNECTION_CODES.has(base.code);
  // A broken or missing connection is not fixed by "Try again": it is fixed in Settings.
  return reconnect ? { ...base, failure: 'fatal', reconnect } : { ...base, reconnect };
}

function transport(timedOut: boolean): DriveFailure {
  return {
    kind: 'error',
    failure: 'retryable',
    message: timedOut ? FILES_API_MESSAGES.timeout : FILES_API_MESSAGES.network,
    code: timedOut ? 'CLIENT_TIMEOUT' : 'NETWORK',
    status: null,
    reconnect: false,
  };
}

const COMPLETE: Readonly<
  Record<DriveRequest['action'], (body: Record<string, unknown>) => boolean>
> = {
  status: (body) =>
    ['unavailable', 'not_connected', 'connected', 'broken'].includes(String(body['state'])) &&
    (body['state'] !== 'connected' || typeof body['email'] === 'string') &&
    (body['state'] !== 'broken' || typeof body['message'] === 'string'),
  connect_start: (body) =>
    typeof body['authorizeUrl'] === 'string' &&
    body['authorizeUrl'].startsWith('https://accounts.google.com/'),
  connect_finish: (body) =>
    typeof body['outcome'] === 'string' && typeof body['message'] === 'string',
  disconnect: (body) =>
    typeof body['disconnected'] === 'boolean' && typeof body['message'] === 'string',
  picked: () => true,
};

export function interpretDriveResponse<A extends DriveRequest['action']>(
  action: A,
  status: number,
  body: unknown,
): DriveOutcome<DriveReplyFor<A>> {
  if (status !== 200) return interpretDriveFailure(status, body);
  if (!isRecord(body) || body['action'] !== action || !COMPLETE[action](body)) {
    return {
      kind: 'error',
      failure: 'retryable',
      message: FILES_API_MESSAGES.unknown,
      code: 'BAD_RESPONSE',
      status,
      reconnect: false,
    };
  }
  return { kind: 'ok', reply: body as DriveReplyFor<A> };
}

export interface DriveDeps {
  readonly driveUrl: string;
  readonly anonKey: string;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  /** SHA-256 of the bytes, hex. Injected so the check runs the same under Node. */
  readonly hash?: (bytes: Uint8Array) => Promise<string>;
}

async function withDeadline<T>(
  limit: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  onTransport: (timedOut: boolean) => T,
): Promise<T> {
  const controller = new AbortController();
  const clock = { timedOut: false };
  const timer = setTimeout(() => {
    clock.timedOut = true;
    controller.abort();
  }, limit);
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort);
  try {
    return await run(controller.signal);
  } catch {
    return onTransport(clock.timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** One JSON call. Never throws: a transport failure is a retryable outcome. */
export function callDrive<R extends DriveRequest>(
  deps: DriveDeps,
  accessToken: string,
  request: R,
  signal?: AbortSignal,
): Promise<DriveOutcome<DriveReplyFor<R['action']>>> {
  return withDeadline(
    deps.timeoutMs ?? DRIVE_CLIENT_TIMEOUT_MS,
    signal,
    async (inner) => {
      const response = await deps.fetch(deps.driveUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          apikey: deps.anonKey,
        },
        body: JSON.stringify(request),
        signal: inner,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return interpretDriveResponse<R['action']>(request.action, response.status, body);
    },
    transport,
  );
}

function hexOf(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readBytes(
  response: Response,
  expected: number,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    received += step.value.length;
    onProgress?.(received, expected);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Ask our server to read one file from his Drive. Never throws. */
export function readDriveFile(
  deps: DriveDeps,
  accessToken: string,
  request: { readonly requestId: string; readonly fileId: string },
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<DriveOutcome<DriveFile>> {
  return withDeadline<DriveOutcome<DriveFile>>(
    deps.timeoutMs ?? DRIVE_READ_TIMEOUT_MS,
    signal,
    async (inner) => {
      const response = await deps.fetch(deps.driveUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          apikey: deps.anonKey,
        },
        body: JSON.stringify({
          action: 'read_file',
          requestId: request.requestId,
          fileId: request.fileId,
        }),
        signal: inner,
      });
      const meta =
        response.status === 200 ? decodeDriveMeta(response.headers.get(DRIVE_META_HEADER)) : null;
      if (meta === null) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return response.status === 200
          ? {
              kind: 'error',
              failure: 'retryable',
              message: FILES_API_MESSAGES.unknown,
              code: 'BAD_RESPONSE',
              status: 200,
              reconnect: false,
            }
          : interpretDriveFailure(response.status, body);
      }
      const { readId, name, fileName, byteSize, contentHash, contentType, googleType, fileId } =
        meta;
      if (
        typeof readId !== 'string' ||
        typeof name !== 'string' ||
        typeof fileName !== 'string' ||
        typeof byteSize !== 'number' ||
        typeof contentHash !== 'string' ||
        typeof fileId !== 'string'
      ) {
        return {
          kind: 'error',
          failure: 'retryable',
          message: FILES_API_MESSAGES.unknown,
          code: 'BAD_RESPONSE',
          status: 200,
          reconnect: false,
        };
      }
      const bytes = await readBytes(response, byteSize, onProgress);
      const digest =
        deps.hash === undefined
          ? hexOf(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))
          : await deps.hash(bytes);
      if (bytes.length !== byteSize || digest !== contentHash) {
        return {
          kind: 'error',
          failure: 'retryable',
          message: DRIVE_API_MESSAGES.incompleteFile,
          code: 'INCOMPLETE_FILE',
          status: 200,
          reconnect: false,
        };
      }
      return {
        kind: 'ok',
        reply: {
          readId,
          name,
          fileName,
          contentType: typeof contentType === 'string' ? contentType : null,
          contentHash,
          googleType: typeof googleType === 'string' ? googleType : null,
          fileId,
          bytes,
        },
      };
    },
    transport,
  );
}
