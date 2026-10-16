/**
 * supabase-js adapter for learned knowledge (Milestone 5 part 5): the functions migration
 * 20261017010000 added, and the reads the drain needs. Server-side only — service role, the one
 * path that may read `knowledge_chunks` or `conversation_file_pages`. Same discipline as the
 * other stores: a hard fetch timeout, no blind retries of writes, every failure a typed Result.
 *
 * The database decides what must not be decided twice: whether a source is still pending
 * (capture), whether it is still learning (an embedding batch for a forgotten document is
 * dropped), whether the lease is free, whether the caller of a search is active staff.
 *
 * Nothing here puts a document's name or a word of its text into an error or a log field.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

import { fetchWithTimeout, type SupabaseAuthConfig } from '../auth/clients.js';
import { AppError, NetworkError, ensureError, err, ok, type Result } from '../errors.js';
import {
  EXTRACTION_METHODS,
  isFileKind,
  type ExtractionMethod,
  type FileKind,
  type Legibility,
} from '../files/limits.js';
import type { ChunkablePage, DocumentChunk } from './chunk.js';

export type SourceStatus = 'pending' | 'learning' | 'ready' | 'failed' | 'forgotten';

/* eslint-disable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style -- supabase-js schema shape (auth/clients.ts) */
type SourceDbRow = {
  id: string;
  file_id: string | null;
  conversation_id: string | null;
  uploaded_by: string | null;
  scope: string;
  kind: string;
  name: string | null;
  content_hash: string | null;
  source_url: string | null;
  source_host: string | null;
  version_key: string | null;
  learned_at: string;
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  chunk_chars: number;
  chunker_version: string | null;
  summary_status: string;
  summary_attempts: number;
  status: string;
  failure: string | null;
  created_at: string;
  captured_at: string | null;
  ready_at: string | null;
  forgotten_at: string | null;
  forgotten_by: string | null;
  forgotten_reason: string | null;
};

type ChunkDbRow = {
  source_id: string;
  ordinal: number;
  kind: string;
  page_no: number;
  page_to: number | null;
  page_label: string;
  extraction_method: string;
  legibility: string;
  char_start: number;
  char_end: number;
  content: string;
  section: string | null;
  embedding: string | null;
  embedded_at: string | null;
};

type FilePageDbRow = {
  file_id: string;
  page_no: number;
  label: string;
  content: string;
  extraction_method: string;
  legibility: string;
};

type FileStatusDbRow = { id: string; status: string };

type MatchDbRow = {
  source_id: string;
  ordinal: number;
  chunk_kind: string;
  page_no: number;
  page_to: number | null;
  page_label: string;
  extraction_method: string;
  legibility: string;
  char_start: number;
  char_end: number;
  content: string;
  section: string | null;
  similarity: number;
  attached: boolean;
  source_status: string;
  file_id: string | null;
  conversation_id: string | null;
  name: string | null;
  kind: string;
  source_host: string | null;
  learned_at: string;
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  newer_twin_learned_at: string | null;
  named: boolean;
};

type SummaryDbRow = {
  source_id: string;
  ordinal: number;
  page_no: number;
  page_to: number;
  page_label: string;
  content: string;
  section: string | null;
};

type NeighbourDbRow = Omit<
  MatchDbRow,
  | 'chunk_kind'
  | 'page_to'
  | 'similarity'
  | 'attached'
  | 'source_status'
  | 'file_id'
  | 'conversation_id'
  | 'name'
  | 'kind'
  | 'source_host'
  | 'learned_at'
  | 'page_count'
  | 'chunk_count'
  | 'embedded_count'
  | 'newer_twin_learned_at'
  | 'named'
>;

type KnowledgeDatabase = {
  public: {
    Tables: {
      knowledge_sources: {
        Row: SourceDbRow;
        Insert: Partial<SourceDbRow>;
        Update: Partial<SourceDbRow>;
        Relationships: [];
      };
      knowledge_chunks: {
        Row: ChunkDbRow;
        Insert: Partial<ChunkDbRow>;
        Update: Partial<ChunkDbRow>;
        Relationships: [];
      };
      conversation_file_pages: {
        Row: FilePageDbRow;
        Insert: Partial<FilePageDbRow>;
        Update: Partial<FilePageDbRow>;
        Relationships: [];
      };
      conversation_files: {
        Row: FileStatusDbRow;
        Insert: Partial<FileStatusDbRow>;
        Update: Partial<FileStatusDbRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      copy_knowledge_from_twin: {
        Args: { p_source_id: string; p_chunker_version: string };
        Returns: boolean;
      };
      capture_knowledge_source: {
        Args: {
          p_source_id: string;
          p_chunker_version: string;
          p_chunks: ChunkJson[];
          p_summarise: boolean;
        };
        Returns: { status: string; chunk_count: number }[];
      };
      fail_knowledge_source: {
        Args: { p_source_id: string; p_failure: string };
        Returns: boolean;
      };
      add_knowledge_summaries: {
        Args: { p_source_id: string; p_summaries: SummaryJson[] };
        Returns: { status: string; chunk_count: number; summary_status: string }[];
      };
      fail_knowledge_summary: {
        Args: { p_source_id: string; p_max_attempts: number };
        Returns: string;
      };
      knowledge_summaries_of: {
        Args: { p_source_id: string };
        Returns: SummaryDbRow[];
      };
      attach_knowledge_embeddings: {
        Args: { p_source_id: string; p_embeddings: { ordinal: number; embedding: string }[] };
        Returns: { status: string; embedded_count: number; chunk_count: number }[];
      };
      match_knowledge_chunks: {
        Args: {
          p_query: string;
          p_user_id: string;
          p_attached_file_ids: string[];
          p_exclude_file_ids: string[];
          p_include_learned: boolean;
          p_sections: string[];
          p_limit: number;
          p_min_similarity: number;
          p_attached_min_similarity: number;
        };
        Returns: MatchDbRow[];
      };
      knowledge_neighbours: {
        Args: { p_source_id: string; p_ordinals: number[] };
        Returns: NeighbourDbRow[];
      };
      claim_knowledge_drain: {
        Args: { p_holder: string; p_lease_seconds: number };
        Returns: { claimed: boolean; wait_ms: number }[];
      };
      release_knowledge_drain: {
        Args: { p_holder: string; p_outcome: string; p_cooldown_seconds: number };
        Returns: boolean;
      };
      forget_knowledge: {
        Args: {
          p_source_id: string;
          p_content_hash: string | null;
          p_actor: string | null;
          p_reason: string;
        };
        Returns: number;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type ChunkJson = {
  ordinal: number;
  page_no: number;
  page_label: string;
  extraction_method: string;
  legibility: string;
  char_start: number;
  char_end: number;
  content: string;
  section: string | null;
};

type SummaryJson = {
  position: number;
  page_no: number;
  page_to: number;
  page_label: string;
  content: string;
  section: string | null;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions,
   @typescript-eslint/consistent-indexed-object-style */

export type KnowledgeServiceClient = SupabaseClient<KnowledgeDatabase>;

export const DEFAULT_KNOWLEDGE_STORE_TIMEOUT_MS = 20_000;

export function createKnowledgeServiceClient(config: SupabaseAuthConfig): KnowledgeServiceClient {
  return createClient<KnowledgeDatabase>(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout(config.timeoutMs ?? DEFAULT_KNOWLEDGE_STORE_TIMEOUT_MS) },
  });
}

// ---------------------------------------------------------------------------------------
// The shapes the rest of the module works in
// ---------------------------------------------------------------------------------------

export interface PendingSource {
  readonly id: string;
  readonly fileId: string | null;
  /** The attachment's name: untrusted; only a section label is ever taken from it (chunk.ts). */
  readonly name: string;
}

/** A learning document whose summary is still to be written. */
export interface SummarySource {
  readonly id: string;
  /** Untrusted; goes to the summariser inside the wrapper, never logged. */
  readonly name: string;
  readonly kind: FileKind;
  readonly pageCount: number;
}

/** One stored passage, as the summariser reads the document back. */
export interface PassageRow {
  readonly ordinal: number;
  readonly pageNo: number;
  readonly pageLabel: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly content: string;
  readonly section: string | null;
}

/** One summary to store: a run of pages, in the fast model's words. */
export interface SummaryInput {
  /** 1..N in page order; stored after the passages. */
  readonly position: number;
  readonly pageNo: number;
  readonly pageTo: number;
  readonly pageLabel: string;
  readonly content: string;
  readonly section: string | null;
}

export type SummaryStatus = 'none' | 'pending' | 'done' | 'failed';

/** How a passage's page was read — or, for a summary, that the fast model wrote it. */
export type ChunkMethod = ExtractionMethod | 'model_summary';
export type ChunkKind = 'passage' | 'summary';

export interface BatchChunk {
  readonly ordinal: number;
  readonly pageLabel: string;
  readonly section: string | null;
  readonly content: string;
}

export interface EmbedBatch {
  readonly sourceId: string;
  /** For the embedded header only; never logged. */
  readonly sourceName: string;
  readonly chunks: readonly BatchChunk[];
  /** Chunks of this source still waiting, this batch included. */
  readonly waiting: number;
}

export interface AttachOutcome {
  readonly status: SourceStatus;
  readonly embeddedCount: number;
  readonly chunkCount: number;
}

/** One chunk retrieval chose, with what its document is. */
export interface MatchedChunk {
  readonly sourceId: string;
  readonly ordinal: number;
  /** A passage of the document's own text, or a summary of a run of its pages. */
  readonly chunkKind: ChunkKind;
  readonly pageNo: number;
  /** A summary's last page; null for a passage. */
  readonly pageTo: number | null;
  readonly pageLabel: string;
  readonly method: ChunkMethod;
  readonly legibility: Legibility;
  readonly charStart: number;
  readonly charEnd: number;
  readonly content: string;
  /** The section the chunker labelled it with ("Week three"), or null. Document text: rendered defanged. */
  readonly section: string | null;
  readonly similarity: number;
  /** One of the conversation's own attachments, rather than something learned elsewhere. */
  readonly attached: boolean;
  readonly sourceStatus: 'learning' | 'ready';
  readonly fileId: string | null;
  readonly conversationId: string | null;
  /** The document's display name, as attached. Untrusted text: rendered defanged, never logged. */
  readonly name: string;
  readonly kind: FileKind;
  readonly sourceHost: string | null;
  readonly learnedAt: string;
  readonly pageCount: number;
  readonly chunkCount: number;
  readonly embeddedCount: number;
  /** A near-identical passage is in a document read later than this one. */
  readonly newerTwinLearnedAt: string | null;
  /** It is in a section the question named ("Week 3"): taken first, whatever its similarity. */
  readonly named: boolean;
}

export type NeighbourChunk = Pick<
  MatchedChunk,
  | 'sourceId'
  | 'ordinal'
  | 'chunkKind'
  | 'pageNo'
  | 'pageTo'
  | 'pageLabel'
  | 'method'
  | 'legibility'
  | 'charStart'
  | 'charEnd'
  | 'content'
  | 'section'
>;

export interface MatchParams {
  readonly userId: string;
  /** This conversation's attachments that did not fit whole: searched even while learning. */
  readonly attachedFileIds: readonly string[];
  /** This conversation's attachments that went in whole: never searched again. */
  readonly excludeFileIds: readonly string[];
  /**
   * Search what was learned in OTHER conversations too. False when the search rewrite judged the
   * message not to be about any document (knowledge/query.ts): only this conversation's own
   * attachments are searched then.
   */
  readonly includeLearned: boolean;
  /** Sections the question names, spelled as chunk.ts spells them ("Week 3"). */
  readonly sections: readonly string[];
  readonly limit: number;
  /** The floor for what was learned elsewhere. */
  readonly minSimilarity: number;
  /** The floor for this conversation's own attachments: the person is talking about them. */
  readonly attachedMinSimilarity: number;
}

/** How far learning has got for one of the conversation's own attachments. */
export interface FileLearning {
  readonly fileId: string;
  readonly sourceId: string;
  readonly status: SourceStatus;
  readonly chunkCount: number;
  readonly embeddedCount: number;
}

export interface KnowledgeStore {
  sourceForFile(
    fileId: string,
  ): Promise<Result<(PendingSource & { readonly status: SourceStatus }) | null>>;
  sourcesForFiles(fileIds: readonly string[]): Promise<Result<readonly FileLearning[]>>;
  pendingSources(limit: number): Promise<Result<readonly PendingSource[]>>;
  copyFromTwin(sourceId: string, chunkerVersion: string): Promise<Result<boolean>>;
  /** A ready attachment's pages, in order; null when the attachment or its text is gone. */
  pagesOfFile(fileId: string): Promise<Result<readonly ChunkablePage[] | null>>;
  capture(
    sourceId: string,
    chunkerVersion: string,
    chunks: readonly DocumentChunk[],
    summarise: boolean,
  ): Promise<Result<{ readonly status: SourceStatus; readonly chunkCount: number }>>;
  fail(sourceId: string, failure: string): Promise<Result<boolean>>;
  /** Learning documents whose summary is still to be written, oldest first. */
  summaryPending(limit: number): Promise<Result<readonly SummarySource[]>>;
  /** A document's stored passages in order: what its summary is written from. */
  passagesOf(sourceId: string): Promise<Result<readonly PassageRow[]>>;
  addSummaries(
    sourceId: string,
    summaries: readonly SummaryInput[],
  ): Promise<
    Result<{
      readonly status: SourceStatus;
      readonly chunkCount: number;
      readonly summaryStatus: SummaryStatus;
    }>
  >;
  /** One failed attempt; 'failed' once there have been `maxAttempts`. */
  failSummary(sourceId: string, maxAttempts: number): Promise<Result<SummaryStatus | 'unchanged'>>;
  /** All of one document's summary, in page order. */
  summariesOf(sourceId: string): Promise<Result<readonly NeighbourChunk[]>>;
  /** The next chunks to embed: the oldest learning document's, in order, up to the limits. */
  nextBatch(
    maxChars: number,
    maxInputs: number,
    header: (name: string, chunk: BatchChunk) => string,
  ): Promise<Result<EmbedBatch | null>>;
  attachEmbeddings(
    sourceId: string,
    embeddings: readonly { readonly ordinal: number; readonly vector: readonly number[] }[],
  ): Promise<Result<AttachOutcome>>;
  claimDrain(
    holder: string,
    leaseSeconds: number,
  ): Promise<Result<{ readonly claimed: boolean; readonly waitMs: number }>>;
  releaseDrain(holder: string, outcome: string, cooldownSeconds: number): Promise<Result<boolean>>;
  forget(sourceId: string, actor: string | null): Promise<Result<number>>;
  match(query: readonly number[], params: MatchParams): Promise<Result<readonly MatchedChunk[]>>;
  neighbours(
    sourceId: string,
    ordinals: readonly number[],
  ): Promise<Result<readonly NeighbourChunk[]>>;
  /** Whether anything at all is learned and searchable — decides whether a failed search is worth a word. */
  anyReady(): Promise<Result<boolean>>;
  /** Names of the most recently read documents, learned or being learned — hints for the search rewrite. */
  recentNames(limit: number): Promise<Result<readonly string[]>>;
}

const STATUSES: readonly SourceStatus[] = ['pending', 'learning', 'ready', 'failed', 'forgotten'];

function asStatus(value: string): SourceStatus | null {
  return (STATUSES as readonly string[]).includes(value) ? (value as SourceStatus) : null;
}

function asMethod(value: string): ExtractionMethod | null {
  return (EXTRACTION_METHODS as readonly string[]).includes(value)
    ? (value as ExtractionMethod)
    : null;
}

const SUMMARY_STATUSES: readonly SummaryStatus[] = ['none', 'pending', 'done', 'failed'];

function asSummaryStatus(value: string): SummaryStatus | null {
  return (SUMMARY_STATUSES as readonly string[]).includes(value) ? (value as SummaryStatus) : null;
}

function asLegibility(value: string): Legibility {
  return value === 'partial' || value === 'none' ? value : 'full';
}

function mapPostgrest(error: PostgrestError, operation: string): AppError {
  if (error.code === '') {
    return new NetworkError(`${operation}: transport failure`, {
      context: { operation, detail: error.message },
    });
  }
  return new AppError('HTTP_STATUS', `${operation}: database refused`, {
    context: { operation, supabaseCode: error.code },
  });
}

function mapThrown(caught: unknown, operation: string): AppError {
  return new NetworkError(`${operation}: transport failure`, {
    context: { operation },
    cause: ensureError(caught),
  });
}

function internal(operation: string, what: string): AppError {
  return new AppError('INTERNAL', `${operation}: ${what}`, { context: { operation } });
}

/** Pages read per request when cutting a document into chunks. */
const PAGE_READ = 100;
/** The most pages a file may have (conversation_files_expected_pages_check). */
const PAGE_READ_LIMIT = 2_000;
/** Passages read per request when a summary is written. */
const PASSAGE_READ = 500;
const PASSAGE_READ_LIMIT = 20_000;

function asChunkMethod(value: string): ChunkMethod | null {
  return value === 'model_summary' ? value : asMethod(value);
}

function toNeighbour(row: NeighbourDbRow): NeighbourChunk | null {
  const method = asMethod(row.extraction_method);
  if (method === null) return null;
  return {
    sourceId: row.source_id,
    ordinal: row.ordinal,
    chunkKind: 'passage',
    pageNo: row.page_no,
    pageTo: null,
    pageLabel: row.page_label,
    method,
    legibility: asLegibility(row.legibility),
    charStart: row.char_start,
    charEnd: row.char_end,
    content: row.content,
    section: row.section,
  };
}

export function supabaseKnowledgeStore(client: KnowledgeServiceClient): KnowledgeStore {
  return {
    sourceForFile: async (fileId) => {
      const op = 'knowledge_sources.forFile';
      try {
        const { data, error } = await client
          .from('knowledge_sources')
          .select('id, file_id, status, name')
          .eq('file_id', fileId)
          .maybeSingle();
        if (error !== null) return err(mapPostgrest(error, op));
        if (data === null) return ok(null);
        const status = asStatus(data.status);
        if (status === null) return err(internal(op, 'status outside its check constraint'));
        return ok({ id: data.id, fileId: data.file_id, name: data.name ?? '', status });
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    sourcesForFiles: async (fileIds) => {
      const op = 'knowledge_sources.forFiles';
      if (fileIds.length === 0) return ok([]);
      try {
        const { data, error } = await client
          .from('knowledge_sources')
          .select('id, file_id, status, chunk_count, embedded_count')
          .in('file_id', [...fileIds]);
        if (error !== null) return err(mapPostgrest(error, op));
        const out: FileLearning[] = [];
        for (const row of data) {
          const status = asStatus(row.status);
          if (status === null || row.file_id === null) continue;
          out.push({
            fileId: row.file_id,
            sourceId: row.id,
            status,
            chunkCount: row.chunk_count,
            embeddedCount: row.embedded_count,
          });
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    pendingSources: async (limit) => {
      const op = 'knowledge_sources.pending';
      try {
        const { data, error } = await client
          .from('knowledge_sources')
          .select('id, file_id, name')
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(limit);
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data.map((row) => ({ id: row.id, fileId: row.file_id, name: row.name ?? '' })));
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    copyFromTwin: async (sourceId, chunkerVersion) => {
      const op = 'knowledge.copyFromTwin';
      try {
        const { data, error } = await client.rpc('copy_knowledge_from_twin', {
          p_source_id: sourceId,
          p_chunker_version: chunkerVersion,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    pagesOfFile: async (fileId) => {
      const op = 'knowledge.pagesOfFile';
      try {
        const file = await client
          .from('conversation_files')
          .select('id, status')
          .eq('id', fileId)
          .maybeSingle();
        if (file.error !== null) return err(mapPostgrest(file.error, op));
        if (file.data?.status !== 'ready') return ok(null);
        const pages: ChunkablePage[] = [];
        for (let offset = 0; offset < PAGE_READ_LIMIT; offset += PAGE_READ) {
          const { data, error } = await client
            .from('conversation_file_pages')
            .select('file_id, page_no, label, content, extraction_method, legibility')
            .eq('file_id', fileId)
            .order('page_no', { ascending: true })
            .range(offset, offset + PAGE_READ - 1);
          if (error !== null) return err(mapPostgrest(error, op));
          for (const row of data) {
            const method = asMethod(row.extraction_method);
            if (method === null) continue;
            pages.push({
              pageNo: row.page_no,
              label: row.label,
              content: row.content,
              method,
              legibility: asLegibility(row.legibility),
            });
          }
          if (data.length < PAGE_READ) break;
        }
        return ok(pages.length === 0 ? null : pages);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    capture: async (sourceId, chunkerVersion, chunks, summarise) => {
      const op = 'knowledge.capture';
      try {
        const { data, error } = await client.rpc('capture_knowledge_source', {
          p_source_id: sourceId,
          p_chunker_version: chunkerVersion,
          p_chunks: chunks.map((chunk) => ({
            ordinal: chunk.ordinal,
            page_no: chunk.pageNo,
            page_label: chunk.pageLabel,
            extraction_method: chunk.method,
            legibility: chunk.legibility,
            char_start: chunk.charStart,
            char_end: chunk.charEnd,
            content: chunk.content,
            section: chunk.section,
          })),
          p_summarise: summarise,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        const row = data[0];
        const status = row === undefined ? null : asStatus(row.status);
        if (row === undefined || status === null) return err(internal(op, 'no state returned'));
        return ok({ status, chunkCount: row.chunk_count });
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    summaryPending: async (limit) => {
      const op = 'knowledge.summaryPending';
      try {
        const { data, error } = await client
          .from('knowledge_sources')
          .select('id, name, kind, page_count')
          .eq('status', 'learning')
          .eq('summary_status', 'pending')
          .order('created_at', { ascending: true })
          .limit(limit);
        if (error !== null) return err(mapPostgrest(error, op));
        const out: SummarySource[] = [];
        for (const row of data) {
          if (row.name === null || !isFileKind(row.kind)) continue;
          out.push({ id: row.id, name: row.name, kind: row.kind, pageCount: row.page_count });
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    passagesOf: async (sourceId) => {
      const op = 'knowledge.passagesOf';
      try {
        const out: PassageRow[] = [];
        for (let offset = 0; offset < PASSAGE_READ_LIMIT; offset += PASSAGE_READ) {
          const { data, error } = await client
            .from('knowledge_chunks')
            .select('ordinal, page_no, page_label, char_start, char_end, content, section')
            .eq('source_id', sourceId)
            .eq('kind', 'passage')
            .order('ordinal', { ascending: true })
            .range(offset, offset + PASSAGE_READ - 1);
          if (error !== null) return err(mapPostgrest(error, op));
          for (const row of data) {
            out.push({
              ordinal: row.ordinal,
              pageNo: row.page_no,
              pageLabel: row.page_label,
              charStart: row.char_start,
              charEnd: row.char_end,
              content: row.content,
              section: row.section,
            });
          }
          if (data.length < PASSAGE_READ) break;
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    addSummaries: async (sourceId, summaries) => {
      const op = 'knowledge.addSummaries';
      try {
        const { data, error } = await client.rpc('add_knowledge_summaries', {
          p_source_id: sourceId,
          p_summaries: summaries.map((s) => ({
            position: s.position,
            page_no: s.pageNo,
            page_to: s.pageTo,
            page_label: s.pageLabel,
            content: s.content,
            section: s.section,
          })),
        });
        if (error !== null) return err(mapPostgrest(error, op));
        const row = data[0];
        const status = row === undefined ? null : asStatus(row.status);
        const summaryStatus = row === undefined ? null : asSummaryStatus(row.summary_status);
        if (row === undefined || status === null || summaryStatus === null)
          return err(internal(op, 'no state returned'));
        return ok({ status, chunkCount: row.chunk_count, summaryStatus });
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    failSummary: async (sourceId, maxAttempts) => {
      const op = 'knowledge.failSummary';
      try {
        const { data, error } = await client.rpc('fail_knowledge_summary', {
          p_source_id: sourceId,
          p_max_attempts: maxAttempts,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        if (data === 'unchanged') return ok('unchanged');
        const status = asSummaryStatus(data);
        if (status === null) return err(internal(op, 'summary status outside its check'));
        return ok(status);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    summariesOf: async (sourceId) => {
      const op = 'knowledge.summariesOf';
      try {
        const { data, error } = await client.rpc('knowledge_summaries_of', {
          p_source_id: sourceId,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(
          data.map((row): NeighbourChunk => ({
            sourceId: row.source_id,
            ordinal: row.ordinal,
            chunkKind: 'summary',
            pageNo: row.page_no,
            pageTo: row.page_to,
            pageLabel: row.page_label,
            method: 'model_summary',
            legibility: 'full',
            charStart: 0,
            charEnd: row.content.length,
            content: row.content,
            section: row.section,
          })),
        );
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    fail: async (sourceId, failure) => {
      const op = 'knowledge.fail';
      try {
        const { data, error } = await client.rpc('fail_knowledge_source', {
          p_source_id: sourceId,
          p_failure: failure,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    nextBatch: async (maxChars, maxInputs, header) => {
      const op = 'knowledge.nextBatch';
      try {
        const sources = await client
          .from('knowledge_sources')
          .select('id, name, chunk_count, embedded_count')
          .eq('status', 'learning')
          // Nothing is embedded before the summary is written (or has failed for good): the
          // flip to ready comes with the last vector, so it must come after the summary's.
          .neq('summary_status', 'pending')
          .order('created_at', { ascending: true })
          .limit(1);
        if (sources.error !== null) return err(mapPostgrest(sources.error, op));
        const source = sources.data[0];
        if (source?.name == null) return ok(null);
        const chunks = await client
          .from('knowledge_chunks')
          .select('ordinal, page_label, section, content')
          .eq('source_id', source.id)
          .is('embedding', null)
          .order('ordinal', { ascending: true })
          .limit(maxInputs);
        if (chunks.error !== null) return err(mapPostgrest(chunks.error, op));
        const picked: BatchChunk[] = [];
        let chars = 0;
        for (const row of chunks.data) {
          const chunk = {
            ordinal: row.ordinal,
            pageLabel: row.page_label,
            section: row.section,
            content: row.content,
          };
          const size = header(source.name, chunk).length;
          // The first chunk always goes: one chunk (≤ 1,800 characters) is under any limit.
          if (picked.length > 0 && chars + size > maxChars) break;
          picked.push(chunk);
          chars += size;
        }
        if (picked.length === 0) return ok(null);
        return ok({
          sourceId: source.id,
          sourceName: source.name,
          chunks: picked,
          waiting: source.chunk_count - source.embedded_count,
        });
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    attachEmbeddings: async (sourceId, embeddings) => {
      const op = 'knowledge.attachEmbeddings';
      try {
        const { data, error } = await client.rpc('attach_knowledge_embeddings', {
          p_source_id: sourceId,
          // pgvector accepts the JSON array form; the function casts each one.
          p_embeddings: embeddings.map((e) => ({
            ordinal: e.ordinal,
            embedding: JSON.stringify(e.vector),
          })),
        });
        if (error !== null) return err(mapPostgrest(error, op));
        const row = data[0];
        const status = row === undefined ? null : asStatus(row.status);
        if (row === undefined || status === null) return err(internal(op, 'no state returned'));
        return ok({ status, embeddedCount: row.embedded_count, chunkCount: row.chunk_count });
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    claimDrain: async (holder, leaseSeconds) => {
      const op = 'knowledge.claimDrain';
      try {
        const { data, error } = await client.rpc('claim_knowledge_drain', {
          p_holder: holder,
          p_lease_seconds: leaseSeconds,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        const row = data[0];
        if (row === undefined) return err(internal(op, 'no answer'));
        return ok({ claimed: row.claimed, waitMs: row.wait_ms });
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    releaseDrain: async (holder, outcome, cooldownSeconds) => {
      const op = 'knowledge.releaseDrain';
      try {
        const { data, error } = await client.rpc('release_knowledge_drain', {
          p_holder: holder,
          p_outcome: outcome,
          p_cooldown_seconds: cooldownSeconds,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    forget: async (sourceId, actor) => {
      const op = 'knowledge.forget';
      try {
        const source = await client
          .from('knowledge_sources')
          .select('content_hash')
          .eq('id', sourceId)
          .maybeSingle();
        if (source.error !== null) return err(mapPostgrest(source.error, op));
        const { data, error } = await client.rpc('forget_knowledge', {
          p_source_id: sourceId,
          p_content_hash: source.data?.content_hash ?? null,
          p_actor: actor,
          p_reason: 'operator',
        });
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    match: async (query, params) => {
      const op = 'knowledge.match';
      try {
        const { data, error } = await client.rpc('match_knowledge_chunks', {
          p_query: JSON.stringify(query),
          p_user_id: params.userId,
          p_attached_file_ids: [...params.attachedFileIds],
          p_exclude_file_ids: [...params.excludeFileIds],
          p_include_learned: params.includeLearned,
          p_sections: [...params.sections],
          p_limit: params.limit,
          p_min_similarity: params.minSimilarity,
          p_attached_min_similarity: params.attachedMinSimilarity,
        });
        if (error !== null) return err(mapPostgrest(error, op));
        const out: MatchedChunk[] = [];
        for (const row of data) {
          const method = asChunkMethod(row.extraction_method);
          const chunkKind =
            row.chunk_kind === 'summary'
              ? 'summary'
              : row.chunk_kind === 'passage'
                ? 'passage'
                : null;
          const status =
            row.source_status === 'learning' || row.source_status === 'ready'
              ? row.source_status
              : null;
          if (
            method === null ||
            chunkKind === null ||
            status === null ||
            !isFileKind(row.kind) ||
            row.name === null
          ) {
            continue;
          }
          out.push({
            sourceId: row.source_id,
            ordinal: row.ordinal,
            chunkKind,
            pageNo: row.page_no,
            pageTo: row.page_to,
            pageLabel: row.page_label,
            method,
            legibility: asLegibility(row.legibility),
            charStart: row.char_start,
            charEnd: row.char_end,
            content: row.content,
            section: row.section,
            similarity: row.similarity,
            attached: row.attached,
            sourceStatus: status,
            fileId: row.file_id,
            conversationId: row.conversation_id,
            name: row.name,
            kind: row.kind,
            sourceHost: row.source_host,
            learnedAt: row.learned_at,
            pageCount: row.page_count,
            chunkCount: row.chunk_count,
            embeddedCount: row.embedded_count,
            newerTwinLearnedAt: row.newer_twin_learned_at,
            named: row.named,
          });
        }
        return ok(out);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    neighbours: async (sourceId, ordinals) => {
      const op = 'knowledge.neighbours';
      if (ordinals.length === 0) return ok([]);
      try {
        const { data, error } = await client.rpc('knowledge_neighbours', {
          p_source_id: sourceId,
          p_ordinals: [...ordinals],
        });
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data.map(toNeighbour).filter((row): row is NeighbourChunk => row !== null));
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    recentNames: async (limit) => {
      const op = 'knowledge.recentNames';
      try {
        const { data, error } = await client
          .from('knowledge_sources')
          .select('name')
          .in('status', ['learning', 'ready'])
          .order('learned_at', { ascending: false })
          .limit(limit);
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data.map((row) => row.name).filter((name): name is string => name !== null));
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
    anyReady: async () => {
      const op = 'knowledge.anyReady';
      try {
        const { data, error } = await client
          .from('knowledge_sources')
          .select('id')
          .eq('status', 'ready')
          .limit(1);
        if (error !== null) return err(mapPostgrest(error, op));
        return ok(data.length > 0);
      } catch (caught: unknown) {
        return err(mapThrown(caught, op));
      }
    },
  };
}
