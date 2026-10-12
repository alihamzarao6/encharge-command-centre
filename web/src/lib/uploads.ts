/**
 * Attaching files to the conversation on screen (Milestone 5 part 1) — the queue, the
 * progress, the question before a scan is read, and what happens when any step fails.
 * Framework-free and subscribable, like thread.ts, so the Assistant page and the docked panel
 * show the same uploads and so every path here is unit-tested without a browser.
 *
 * One file at a time, in the order they were chosen. Two files dropped together are two
 * uploads, never a race: the second waits its turn, which is also what stops two uploads to
 * a brand-new conversation from opening two conversations.
 *
 * A file moves through: waiting → being read on this device → (a scan: "this will read N
 * pages and cost about $X — continue?") → its text sent → its page images read → attached.
 * It is attached WHOLE or not at all. If the connection drops, the budget runs out, or a page
 * will not read, the upload stops where it is and says how far it got; "Try again" resumes
 * from that page rather than paying for the earlier ones twice (the server answers a page it
 * already has from the record). Leaving it there attaches nothing: the half-stored upload is
 * removed by the server after fifteen minutes and was never visible as a file.
 *
 * `announcement` is the one sentence a screen reader is given (aria-live, polite): that a
 * file is being read, that it was attached, or that it was not and why.
 */
import {
  FILE_LIMITS,
  refusal,
  type FileKind,
  type RefusalCode,
} from '../../../src/lib/files/limits.js';
import { sanitiseFileName } from '../../../src/lib/files/text.js';
import type {
  AttachedFile,
  FilesFailure,
  FilesOutcome,
  FilesRequest,
  ReplyFor,
  VisionEstimate,
} from './filesApi.js';
import type { ExtractedPage, Extraction, ExtractionOk } from './files/types.js';

/** A file as the browser hands it over. `bytes` is not called until its turn comes. */
export interface BrowserFile {
  readonly name: string;
  readonly size: number;
  readonly bytes: () => Promise<Uint8Array>;
}

export type UploadPhase =
  /** Behind another upload. */
  | 'waiting'
  /** Being read on this device. */
  | 'reading'
  /** A scan: waiting for the person to say yes to the page count and the cost. */
  | 'confirm'
  /** Its text pages are being sent. */
  | 'sending'
  /** Its page images are being read by the assistant. */
  | 'looking'
  /** Finishing. */
  | 'finishing'
  /** Stopped. `retryable` says whether "Try again" is offered. */
  | 'failed'
  /** The file itself was refused. */
  | 'refused';

export interface UploadItem {
  readonly localId: string;
  /** A clean label, never the raw name the device reported. */
  readonly name: string;
  readonly byteSize: number;
  readonly kind: FileKind | null;
  readonly phase: UploadPhase;
  /** Pages done / pages in all, for whichever phase is running. 0/0 = not known yet. */
  readonly done: number;
  readonly total: number;
  /** The sentence for a failure or a refusal. */
  readonly message: string | null;
  readonly retryable: boolean;
  readonly estimate: VisionEstimate | null;
}

export interface UploadsState {
  /** The conversation these uploads and files belong to; null = a new one, not created yet. */
  readonly conversationId: string | null;
  readonly uploads: readonly UploadItem[];
  readonly files: readonly AttachedFile[];
  readonly filesState: 'idle' | 'loading' | 'error';
  /** The file being removed, so its button can say so. */
  readonly removing: string | null;
  /** One sentence about a removal that did not work. */
  readonly notice: string | null;
  /** For a screen reader. */
  readonly announcement: string;
}

export type FilesCall = <R extends FilesRequest>(
  request: R,
  signal?: AbortSignal,
) => Promise<FilesOutcome<ReplyFor<R['action']>>>;

export interface UploadsDeps {
  /** Reads a file on this device. Loaded on first use; never throws. */
  readonly extract: (
    input: { readonly name: string; readonly bytes: Uint8Array },
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ) => Promise<Extraction>;
  readonly hash: (bytes: Uint8Array) => Promise<string>;
  readonly call: FilesCall;
  /** The conversation's files, read under RLS; null = could not. */
  readonly loadFiles: (conversationId: string) => Promise<readonly AttachedFile[] | null>;
  readonly newRequestId: () => string;
  readonly now: () => number;
  /** An upload opened a conversation: the thread must be on it before the first message. */
  readonly adoptConversation: (conversationId: string) => void;
  readonly onSessionExpired: () => Promise<void>;
}

export interface UploadsStore {
  readonly getState: () => UploadsState;
  readonly subscribe: (listener: () => void) => () => void;
  /** The thread moved to another conversation (or a new one). */
  readonly setConversation: (conversationId: string | null) => void;
  readonly add: (files: readonly BrowserFile[]) => void;
  /** Yes to reading a scan. */
  readonly confirm: (localId: string) => void;
  /** Stop an upload, or take a stopped one off the list. Nothing of it is kept. */
  readonly cancel: (localId: string) => void;
  readonly retry: (localId: string) => void;
  readonly remove: (fileId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly clearNotice: () => void;
}

const ACTIVE: readonly UploadPhase[] = [
  'waiting',
  'reading',
  'confirm',
  'sending',
  'looking',
  'finishing',
];

/** An upload is still going: a message sent now would be answered without the file. */
export function isBusy(state: UploadsState): boolean {
  return state.uploads.some((item) => ACTIVE.includes(item.phase));
}

const INITIAL: UploadsState = {
  conversationId: null,
  uploads: [],
  files: [],
  filesState: 'idle',
  removing: null,
  notice: null,
  announcement: '',
};

/** What an upload is holding between steps. Never in the state: none of it is for the screen. */
interface Work {
  readonly file: BrowserFile;
  readonly requestId: string;
  readonly abort: AbortController;
  extraction: ExtractionOk | null;
  contentHash: string | null;
  extractMs: number;
  fileId: string | null;
  /** Resolves when the person answers the question about a scan. */
  answer: ((go: boolean) => void) | null;
  confirmed: boolean;
}

export const UPLOAD_MESSAGES = {
  notPrepared:
    'This device could not prepare that page to be read. Nothing was attached. Try from another device.',
  cancelled: 'Stopped. Nothing was attached.',
  cannotAfford: (estimate: VisionEstimate): string =>
    `Reading these ${String(estimate.pages)} pages would cost about ${money(estimate.estimateUsd)}, and today's budget of ${money(estimate.dailyCapUsd)} has ${money(Math.max(0, estimate.dailyCapUsd - estimate.spentTodayUsd))} left. Nothing was read. Try a shorter document, or again tomorrow.`,
  stoppedAt: (done: number, total: number, why: string): string =>
    `Stopped after ${String(done)} of ${String(total)} pages. ${why}`,
} as const;

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

let counter = 0;
function nextLocalId(): string {
  counter += 1;
  return `upload-${String(counter)}`;
}

function batches(pages: readonly ExtractedPage[]): ExtractedPage[][] {
  const out: ExtractedPage[][] = [];
  let current: ExtractedPage[] = [];
  let chars = 0;
  for (const page of pages) {
    if (
      current.length > 0 &&
      (current.length >= FILE_LIMITS.appendBatchPages ||
        chars + page.text.length > FILE_LIMITS.appendBatchChars)
    ) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(page);
    chars += page.text.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function createUploadsStore(deps: UploadsDeps): UploadsStore {
  let state: UploadsState = INITIAL;
  const listeners = new Set<() => void>();
  const work = new Map<string, Work>();
  let running = false;

  const set = (
    patch: Partial<UploadsState> | ((current: UploadsState) => Partial<UploadsState>),
  ): void => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const update = (localId: string, patch: Partial<UploadItem>): void => {
    set((current) => ({
      uploads: current.uploads.map((item) =>
        item.localId === localId ? { ...item, ...patch } : item,
      ),
    }));
  };
  const drop = (localId: string): void => {
    work.get(localId)?.extraction?.dispose();
    work.delete(localId);
    set((current) => ({ uploads: current.uploads.filter((item) => item.localId !== localId) }));
  };
  const nameOf = (localId: string): string =>
    state.uploads.find((item) => item.localId === localId)?.name ?? 'The file';

  const loadFiles = async (conversationId: string): Promise<void> => {
    set({ filesState: 'loading' });
    const loaded = await deps.loadFiles(conversationId);
    // The person may have moved on while the read was in flight.
    if (state.conversationId !== conversationId) return;
    if (loaded === null) set({ filesState: 'error' });
    else set({ files: loaded, filesState: 'idle' });
  };

  const stop = (
    localId: string,
    failure: FilesFailure,
    progress?: { done: number; total: number },
  ): void => {
    const message =
      progress === undefined || progress.total <= 1
        ? failure.message
        : UPLOAD_MESSAGES.stoppedAt(progress.done, progress.total, failure.message);
    if (failure.failure === 'refused') {
      update(localId, { phase: 'refused', message: failure.message, retryable: false });
    } else {
      update(localId, {
        phase: 'failed',
        message,
        retryable: failure.failure === 'retryable',
      });
    }
    set({ announcement: `${nameOf(localId)} was not attached. ${message}` });
  };

  const refuse = (
    localId: string,
    code: RefusalCode,
    message: string,
    kind: FileKind | null,
  ): void => {
    const item = state.uploads.find((upload) => upload.localId === localId);
    update(localId, { phase: 'refused', message, retryable: false, kind });
    set({ announcement: `${nameOf(localId)} was not attached. ${message}` });
    // So that "why did his upload fail" has an answer in the logs. Best effort; the refusal
    // has already been shown, and the report carries a size and a reason, never the file.
    void deps.call({
      action: 'refused',
      kind,
      byteSize: item?.byteSize ?? 0,
      reason: code,
      extractMs: work.get(localId)?.extractMs ?? 0,
    });
  };

  /** One upload, start (or resume) to finish. Returns when it is attached, stopped or refused. */
  const run = async (localId: string): Promise<void> => {
    const job = work.get(localId);
    if (job === undefined) return;
    const { signal } = job.abort;
    const cancelled = (): boolean => signal.aborted || !work.has(localId);

    // 1. Read it, here. Size first: a file that is too big is never even loaded.
    if (job.extraction === null) {
      if (job.file.size === 0) {
        refuse(localId, 'empty', refusal('empty').message, null);
        return;
      }
      if (job.file.size > FILE_LIMITS.maxFileBytes) {
        refuse(localId, 'too_large', refusal('too_large', job.file.size).message, null);
        return;
      }
      update(localId, { phase: 'reading', done: 0, total: 0, message: null });
      set({ announcement: `Reading ${nameOf(localId)}.` });
      const started = deps.now();
      let extraction: Extraction;
      let bytes: Uint8Array;
      try {
        bytes = await job.file.bytes();
        extraction = await deps.extract(
          { name: job.file.name, bytes },
          (done, total) => {
            if (!cancelled()) update(localId, { done, total });
          },
          signal,
        );
      } catch {
        refuse(localId, 'corrupt', refusal('corrupt').message, null);
        return;
      }
      job.extractMs = Math.round(deps.now() - started);
      if (cancelled()) {
        if (extraction.ok) extraction.dispose();
        return;
      }
      if (!extraction.ok) {
        refuse(localId, extraction.refusal.code, extraction.refusal.message, extraction.kind);
        return;
      }
      job.extraction = extraction;
      job.contentHash = await deps.hash(bytes);
      update(localId, { kind: extraction.kind });
    }
    const extraction = job.extraction;
    const visionPages = extraction.vision.length;

    // 2. A scan: say what it will read and what that costs, and wait for a yes (D90).
    if (visionPages >= FILE_LIMITS.visionConfirmFromPages && !job.confirmed) {
      const quote = await deps.call({ action: 'estimate', visionPages }, signal);
      if (cancelled()) return;
      if (quote.kind === 'error') {
        if (quote.failure === 'unauthenticated') await deps.onSessionExpired();
        stop(localId, quote);
        return;
      }
      if (!quote.reply.affordable) {
        const message = UPLOAD_MESSAGES.cannotAfford(quote.reply);
        update(localId, { phase: 'failed', message, retryable: true });
        set({ announcement: `${nameOf(localId)} was not attached. ${message}` });
        return;
      }
      update(localId, { phase: 'confirm', estimate: quote.reply, done: 0, total: visionPages });
      set({
        announcement: `${nameOf(localId)} is a scan of ${String(visionPages)} pages. Reading it costs about ${money(quote.reply.estimateUsd)}. Choose to read it or cancel.`,
      });
      const go = await new Promise<boolean>((resolve) => {
        job.answer = resolve;
      });
      job.answer = null;
      if (!go || cancelled()) return;
      job.confirmed = true;
    }

    // 3. Claim the upload. The same request id on a retry resumes it.
    //
    // This one call is NOT abortable. A claim abandoned in flight may still land, and a claim
    // that landed with nobody holding its id is an upload the server cannot be told to drop
    // (it would sit there until the fifteen-minute sweep). So a stop pressed now waits for
    // the answer, which is one short request, and then drops what it names.
    update(localId, { phase: 'sending', done: 0, total: extraction.totalPages, estimate: null });
    const begun = await deps.call({
      action: 'begin',
      requestId: job.requestId,
      conversationId: state.conversationId,
      name: sanitiseFileName(job.file.name),
      kind: extraction.kind,
      byteSize: job.file.size,
      contentHash: job.contentHash ?? '',
      totalPages: extraction.totalPages,
      visionPages,
      extractMs: job.extractMs,
    });
    if (begun.kind === 'ok' && state.conversationId === null) {
      // The claim opened a conversation, and the thread is still on "new": this is that
      // conversation, stopped or not — otherwise the next file or message opens a second one.
      // Set here BEFORE telling the thread, so the thread's own change of conversation is
      // recognised as this one and not as the person leaving.
      set({ conversationId: begun.reply.conversationId });
      deps.adoptConversation(begun.reply.conversationId);
    }
    if (cancelled()) {
      // Never a file that was already attached: `duplicate` names that one, not this upload.
      if (begun.kind === 'ok' && !begun.reply.duplicate) {
        void deps.call({ action: 'remove', fileId: begun.reply.fileId });
      }
      return;
    }
    if (begun.kind === 'error') {
      if (begun.failure === 'unauthenticated') await deps.onSessionExpired();
      stop(localId, begun);
      return;
    }
    job.fileId = begun.reply.fileId;
    if (begun.reply.duplicate) {
      set({ announcement: `${nameOf(localId)} is already attached to this conversation.` });
      drop(localId);
      await loadFiles(begun.reply.conversationId);
      return;
    }
    const stored = new Set(begun.reply.pagesStored);
    let done = stored.size;
    update(localId, { done });

    // 4. Its text.
    for (const batch of batches(extraction.pages.filter((page) => !stored.has(page.pageNo)))) {
      const sent = await deps.call(
        {
          action: 'append',
          fileId: job.fileId,
          pages: batch.map((page) => ({ pageNo: page.pageNo, label: page.label, text: page.text })),
        },
        signal,
      );
      if (cancelled()) return;
      if (sent.kind === 'error') {
        if (sent.failure === 'unauthenticated') await deps.onSessionExpired();
        stop(localId, sent, { done, total: extraction.totalPages });
        return;
      }
      done += batch.length;
      update(localId, { done });
    }

    // 5. Its pictures, one page at a time.
    const toLook = extraction.vision.filter((page) => !stored.has(page.pageNo));
    if (toLook.length > 0) update(localId, { phase: 'looking' });
    for (const page of toLook) {
      set({
        announcement: `Reading page ${String(done + 1)} of ${String(extraction.totalPages)} of ${nameOf(localId)}.`,
      });
      let image: Awaited<ReturnType<typeof page.image>>;
      try {
        image = await page.image();
      } catch {
        image = null;
      }
      if (cancelled()) return;
      if (image === null) {
        const message = UPLOAD_MESSAGES.stoppedAt(
          done,
          extraction.totalPages,
          UPLOAD_MESSAGES.notPrepared,
        );
        update(localId, { phase: 'failed', message, retryable: false });
        set({ announcement: `${nameOf(localId)} was not attached. ${message}` });
        return;
      }
      const read = await deps.call(
        {
          action: 'read_page',
          fileId: job.fileId,
          pageNo: page.pageNo,
          label: page.label,
          imageBase64: image.base64,
        },
        signal,
      );
      if (cancelled()) return;
      if (read.kind === 'error') {
        if (read.failure === 'unauthenticated') await deps.onSessionExpired();
        stop(localId, read, { done, total: extraction.totalPages });
        return;
      }
      done += 1;
      update(localId, { done });
    }

    // 6. Every page is in: make it a file.
    update(localId, { phase: 'finishing' });
    const finished = await deps.call({ action: 'finish', fileId: job.fileId }, signal);
    if (cancelled()) return;
    if (finished.kind === 'error') {
      if (finished.failure === 'unauthenticated') await deps.onSessionExpired();
      stop(localId, finished);
      return;
    }
    const attached = finished.reply.file;
    const notes = extraction.notes.length === 0 ? '' : ` ${extraction.notes.join(' ')}`;
    const pages = `${String(attached.pageCount)} ${attached.pageCount === 1 ? 'part' : 'parts'}`;
    set((current) => ({
      files: [...current.files.filter((file) => file.id !== attached.id), attached],
      announcement: `${nameOf(localId)} attached: ${pages}.${notes}`,
    }));
    drop(localId);
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const next = state.uploads.find((item) => item.phase === 'waiting');
        if (next === undefined) return;
        await run(next.localId);
      }
    } finally {
      running = false;
    }
  };

  /** Tell the server to forget an upload it had started. Best effort: it expires anyway. */
  const forget = (job: Work | undefined): void => {
    if (job?.fileId !== null && job?.fileId !== undefined) {
      void deps.call({ action: 'remove', fileId: job.fileId });
    }
  };

  const cancel = (localId: string): void => {
    const job = work.get(localId);
    if (job === undefined) return;
    job.abort.abort();
    job.answer?.(false);
    forget(job);
    const name = nameOf(localId);
    drop(localId);
    set({ announcement: `${name}: ${UPLOAD_MESSAGES.cancelled}` });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setConversation: (conversationId) => {
      if (conversationId === state.conversationId) return;
      // The person left: an upload belongs to the conversation it was started in, and one
      // that has not finished attaches nothing.
      for (const localId of [...work.keys()]) {
        const job = work.get(localId);
        job?.abort.abort();
        job?.answer?.(false);
        forget(job);
        job?.extraction?.dispose();
      }
      work.clear();
      set({
        conversationId,
        uploads: [],
        files: [],
        filesState: 'idle',
        removing: null,
        notice: null,
        announcement: '',
      });
      if (conversationId !== null) void loadFiles(conversationId);
    },

    add: (files) => {
      if (files.length === 0) return;
      const items: UploadItem[] = files.map((file) => {
        const localId = nextLocalId();
        work.set(localId, {
          file,
          requestId: deps.newRequestId(),
          abort: new AbortController(),
          extraction: null,
          contentHash: null,
          extractMs: 0,
          fileId: null,
          answer: null,
          confirmed: false,
        });
        return {
          localId,
          name: sanitiseFileName(file.name),
          byteSize: file.size,
          kind: null,
          phase: 'waiting',
          done: 0,
          total: 0,
          message: null,
          retryable: false,
          estimate: null,
        };
      });
      set((current) => ({ uploads: [...current.uploads, ...items] }));
      void pump();
    },

    confirm: (localId) => {
      work.get(localId)?.answer?.(true);
    },

    cancel,

    retry: (localId) => {
      const item = state.uploads.find((upload) => upload.localId === localId);
      if (item?.phase !== 'failed' || !work.has(localId)) return;
      update(localId, { phase: 'waiting', message: null });
      void pump();
    },

    remove: async (fileId) => {
      if (state.removing !== null) return;
      set({ removing: fileId, notice: null });
      const outcome = await deps.call({ action: 'remove', fileId });
      if (outcome.kind === 'error') {
        if (outcome.failure === 'unauthenticated') await deps.onSessionExpired();
        set({ removing: null, notice: outcome.message });
        return;
      }
      const name = state.files.find((file) => file.id === fileId)?.name ?? 'The file';
      set((current) => ({
        removing: null,
        files: current.files.map((file) =>
          file.id === fileId ? { ...file, status: 'removed' as const, name: null } : file,
        ),
        announcement: `${name} was removed from this conversation.`,
      }));
    },

    refresh: async () => {
      if (state.conversationId !== null) await loadFiles(state.conversationId);
    },

    clearNotice: () => {
      set({ notice: null });
    },
  };
}
