-- Milestone 5 part 5 — what the assistant knows, and what it admits (brief of 16 Oct 2026).
--
-- Until now a document belonged to its conversation (part 1's fixed decision): its text was
-- kept 30 days (a web page one day), was read from the store on every turn of THAT
-- conversation only, and anything over 48,000 characters reached the model as the pages that
-- shared words with the question. This migration is the storage half of reversing that:
-- a document or page, once read, is LEARNED — cut into chunks, embedded, kept — and every
-- conversation can retrieve it by meaning.
--
-- ---------------------------------------------------------------------------------------
-- WHY TWO NEW TABLES AND NOT `memory_chunks`
-- ---------------------------------------------------------------------------------------
-- The fixed decision is "use the memory system that already exists". What is reused, unchanged:
-- the pgvector type and cosine operator, Voyage voyage-3 at 1,024 dimensions through
-- src/lib/memory/embed.ts (its caps, its ledger), the per-turn query embedding, the D70 "store
-- now, embed later" pattern and the D111 scheduler. What is NOT reused is the row:
-- `memory_chunks` is a summary of a range of one conversation's messages. Its `turn_range` is
-- NOT NULL and the exclusion constraint on (conversation_id, turn_range) is the summariser's
-- idempotency key — a document chunk given a made-up range would collide with real summaries
-- of the same conversation. `match_memory_chunks` drops chunks of a deleted conversation,
-- which contradicts "knowledge persists". The Memory page lists every row. Putting documents
-- there would reshape all of that; a sibling table changes none of it.
--
-- ---------------------------------------------------------------------------------------
-- WHAT IS STORED
-- ---------------------------------------------------------------------------------------
--   knowledge_sources      one row per attachment that became ready (a file, a page from a
--                          link, a Drive file): its name, kind, address, hash, the date it
--                          was read, and how far learning has got. It keeps its own copy of
--                          those because the attachment row loses them at the 30-day (or
--                          one-day) purge, and what was learned outlives that (decision 4).
--   knowledge_chunks       the text, cut at roughly 1,500 characters inside one page, with
--                          the page's own label and where on the page it came from, and its
--                          embedding — NULL until the drain embeds it.
--   knowledge_drain_state  one row: who is draining now, and until when Voyage is resting.
--
-- Every chunk's provenance is the source row's (rule 12): the address or the file, when it
-- was read, how the page was read (`extraction_method`), how legible it was.
--
-- ---------------------------------------------------------------------------------------
-- WHO MAY READ IT
-- ---------------------------------------------------------------------------------------
-- Knowledge is the account's, not the uploader's (decision 3), and — like a chunk of a
-- private conversation since R27 — a document attached in a private conversation is learned
-- for the whole team. `knowledge_sources` is readable by active staff (the screen names a
-- document an answer drew on); `knowledge_chunks` and `knowledge_drain_state` have a policy
-- that is `false`: no browser session reads a word of the text, whoever it belongs to. Only
-- the server does, through `match_knowledge_chunks`, which refuses a caller who is not active
-- staff even though it runs as service_role.
--
-- ---------------------------------------------------------------------------------------
-- WHEN IT IS LEARNED, AND WHEN IT IS FORGOTTEN
-- ---------------------------------------------------------------------------------------
--   * An attachment becoming `ready` enqueues a source (trigger below). The files function
--     then captures the chunks at once — the text cannot be purged before it is learned —
--     and the drain embeds them in small, paced batches (Voyage's free plan answers three
--     requests a minute and refuses one request over ~39,000 characters, measured 16 Oct).
--   * A source is retrievable from OTHER conversations only when every chunk is embedded;
--     the flip to `ready` happens in the same statement as the last embedding.
--   * Removing a file is a person saying "do not use this": the trigger forgets every source
--     of the same content — chunks deleted, name, hash and address cleared, audited by id.
--   * Expiry is not removal: the 30-day purge clears the attachment's text and the knowledge
--     stays (decision 4). Deleting a conversation hard-deletes its attachment rows; the source
--     keeps going with `file_id` null (decided 16 Oct: knowledge persists).
--   * Reading the same address again, or attaching the same bytes again, does not delete the
--     older source: retrieval takes the newest READY one per address and per hash, so the
--     older copy keeps answering until the newer one is fully learned.
--
-- ---------------------------------------------------------------------------------------
-- WHY THERE IS NO HNSW INDEX ON knowledge_chunks.embedding
-- ---------------------------------------------------------------------------------------
-- An approximate index scan in pgvector takes its `ef_search` nearest rows (40) and applies
-- the WHERE clause afterwards. Retrieval excludes the files that already went in whole —
-- usually the closest text to the question — so those would fill the 40 and the answer would
-- be "nothing matched" when plenty did. The search is therefore exact: ORDER BY the distance
-- over the eligible rows, no index to take the shortcut. For one brokerage this is hundreds
-- of documents at most; 30,000 chunks × 1,024 dimensions is a few tens of milliseconds. If it
-- ever grows past ~100,000 chunks, add HNSW with `hnsw.iterative_scan` (pgvector ≥ 0.8).
--
-- Reversible:
--   select cron.unschedule('knowledge-drain');
--   drop function public.dispatch_knowledge_drain();
--   drop function public.release_knowledge_drain(uuid, text, integer);
--   drop function public.claim_knowledge_drain(uuid, integer);
--   drop function public.knowledge_summaries_of(uuid);
--   drop function public.knowledge_neighbours(uuid, integer[]);
--   drop function public.match_knowledge_chunks(extensions.vector, uuid, uuid[], uuid[], boolean, text[], integer, double precision, double precision);
--   drop function public.attach_knowledge_embeddings(uuid, jsonb);
--   drop function public.capture_knowledge_source(uuid, text, jsonb, boolean);
--   drop function public.fail_knowledge_summary(uuid, integer);
--   drop function public.add_knowledge_summaries(uuid, jsonb);
--   drop function public.fail_knowledge_source(uuid, text);
--   drop function public.copy_knowledge_from_twin(uuid, text);
--   drop trigger conversation_files_knowledge_forget on public.conversation_files;
--   drop trigger conversation_files_knowledge_enqueue_update on public.conversation_files;
--   drop trigger conversation_files_knowledge_enqueue_insert on public.conversation_files;
--   drop function public.knowledge_forget_on_remove();
--   drop function public.knowledge_enqueue_ready_files();
--   drop function public.knowledge_enqueue_on_ready();
--   drop function public.forget_knowledge(uuid, text, uuid, text);
--   alter table public.messages drop column document_coverage;
--   drop table public.knowledge_drain_state;
--   drop table public.knowledge_chunks;
--   drop table public.knowledge_sources;

-- ---------------------------------------------------------------------------------------
-- (1) knowledge_sources
-- ---------------------------------------------------------------------------------------

create table public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  -- The attachment it was learned from. Null once that row is gone (its conversation was
  -- deleted); the knowledge stays.
  file_id uuid references public.conversation_files (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  -- Who attached it. Null if that account is ever deleted; the knowledge stays.
  uploaded_by uuid references auth.users (id) on delete set null,
  -- Always the workspace's (decision 3). A column, so a future private document is a
  -- migration and not a rewrite of every policy.
  scope text not null default 'workspace'
    constraint knowledge_sources_scope_workspace check (scope = 'workspace'),
  kind text not null constraint knowledge_sources_kind_check
    check (kind in ('pdf', 'docx', 'xlsx', 'csv', 'text', 'image', 'html')),
  -- The attachment's sanitised display name, copied at enqueue. Gone when forgotten.
  name text constraint knowledge_sources_name_length check (name is null or char_length(name) between 1 and 200),
  content_hash text constraint knowledge_sources_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  source_url text constraint knowledge_sources_url_check
    check (source_url is null or (source_url ~ '^https://[^[:space:]]+$' and char_length(source_url) <= 2048)),
  source_host text constraint knowledge_sources_host_check
    check (source_host is null or char_length(source_host) between 1 and 253),
  -- What "the same document" means for retrieval: its address when it has one, else its bytes.
  version_key text constraint knowledge_sources_version_key_check
    check (version_key is null or char_length(version_key) between 1 and 2100),
  -- When the document was READ: a page's or Drive file's fetch time, an upload's ready time.
  -- What "this rate was read on…" is said from, on screen and to the model.
  learned_at timestamptz not null,
  page_count integer not null constraint knowledge_sources_page_count_check check (page_count >= 0),
  chunk_count integer not null default 0,
  embedded_count integer not null default 0,
  chunk_chars integer not null default 0,
  -- Which chunker cut it (src/lib/knowledge/chunk.ts). Chunks are copied between twins only
  -- when both were cut the same way.
  chunker_version text constraint knowledge_sources_chunker_check
    check (chunker_version is null or chunker_version ~ '^[0-9a-z.-]{1,32}$'),
  -- Its summary (src/lib/knowledge/summarise.ts), written once while it is learned, so "break
  -- down week one" on a 33-page transcript is answered from all of it, not a quarter of it:
  --   none:    short enough to need none (it fits the per-question budget almost whole);
  --   pending: captured, summary not written yet — nothing of it is embedded until it is;
  --   done:    the summary chunks are in knowledge_chunks (kind 'summary');
  --   failed:  the fast model could not write one after summary_attempts tries; it is learned
  --            without one.
  summary_status text not null default 'none' constraint knowledge_sources_summary_status_check
    check (summary_status in ('none', 'pending', 'done', 'failed')),
  summary_attempts integer not null default 0 constraint knowledge_sources_summary_attempts_check
    check (summary_attempts between 0 and 20),
  -- pending:   enqueued; no chunks yet.
  -- learning:  chunks captured; embedding in progress. Usable only in its own conversation.
  -- ready:     every chunk embedded; retrievable everywhere.
  -- failed:    could not be learned (`failure` says why, as a code).
  -- forgotten: removed by a person. A tombstone: no name, hash, address or chunks.
  status text not null default 'pending' constraint knowledge_sources_status_check
    check (status in ('pending', 'learning', 'ready', 'failed', 'forgotten')),
  failure text constraint knowledge_sources_failure_check
    check (failure is null or failure ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default now(),
  captured_at timestamptz,
  ready_at timestamptz,
  forgotten_at timestamptz,
  forgotten_by uuid references auth.users (id) on delete set null,
  forgotten_reason text constraint knowledge_sources_forgotten_reason_check
    check (forgotten_reason is null or forgotten_reason in ('user', 'operator')),
  constraint knowledge_sources_counts_check
    check (chunk_count >= 0 and embedded_count between 0 and chunk_count and chunk_chars >= 0),
  -- A ready source is whole: nothing half-learned is ever retrievable as if it were complete.
  constraint knowledge_sources_ready_check
    check (status <> 'ready' or (chunk_count > 0 and embedded_count = chunk_count and ready_at is not null)),
  constraint knowledge_sources_failed_check
    check ((status = 'failed') = (failure is not null)),
  -- The tombstone guarantee, held by the database: a forgotten source names nothing.
  constraint knowledge_sources_tombstone_check
    check (
      (status = 'forgotten' and name is null and content_hash is null and source_url is null
        and source_host is null and version_key is null and forgotten_at is not null
        and chunk_count = 0 and embedded_count = 0)
      or (status <> 'forgotten' and name is not null and content_hash is not null
        and version_key is not null)
    )
);

create unique index knowledge_sources_file_key
  on public.knowledge_sources (file_id) where file_id is not null;
create index knowledge_sources_work_idx
  on public.knowledge_sources (created_at) where status in ('pending', 'learning');
create index knowledge_sources_version_idx
  on public.knowledge_sources (version_key, learned_at) where status = 'ready';
create index knowledge_sources_hash_idx
  on public.knowledge_sources (content_hash, learned_at) where status = 'ready';
create index knowledge_sources_conversation_idx on public.knowledge_sources (conversation_id);
create index knowledge_sources_uploaded_by_idx on public.knowledge_sources (uploaded_by);

comment on table public.knowledge_sources is
  'Milestone 5 part 5. One row per attachment (file, web page, Drive file) the assistant has learned or is learning. Readable by active staff (names on screen); the text is in knowledge_chunks, which no browser reads. Written only by the triggers and functions in migration 20261017010000.';

-- ---------------------------------------------------------------------------------------
-- (2) knowledge_chunks
-- ---------------------------------------------------------------------------------------

create table public.knowledge_chunks (
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  -- 1..N: the passages in document order, then the summaries. Neighbours are passages ± 1.
  ordinal integer not null constraint knowledge_chunks_ordinal_check check (ordinal >= 1),
  -- passage: the document's own text, cut by chunk.ts. summary: what this app's fast model wrote
  -- about a run of its pages when it was learned (summarise.ts) — DATA like a passage, wrapped
  -- and defanged the same way, and never the document's own words.
  kind text not null default 'passage' constraint knowledge_chunks_kind_check
    check (kind in ('passage', 'summary')),
  -- The page it sits inside — a passage never crosses a page — with the document's own label.
  -- A summary's first page; page_to is its last (null for a passage).
  page_no integer not null constraint knowledge_chunks_page_no_check check (page_no >= 1),
  page_to integer,
  page_label text not null constraint knowledge_chunks_label_length
    check (char_length(page_label) between 1 and 300),
  -- Provenance (rule 12): how the page a passage came from was read, as the attachment
  -- recorded it; `model_summary` for a summary, which the fast model wrote.
  extraction_method text not null constraint knowledge_chunks_method_check
    check (extraction_method in
      ('pdf_text_layer', 'claude_vision', 'docx_xml', 'xlsx_xml', 'csv_parse', 'plain_text',
       'html_text', 'model_summary')),
  legibility text not null default 'full' constraint knowledge_chunks_legibility_check
    check (legibility in ('full', 'partial', 'none')),
  -- Where on the page: [char_start, char_end) of the page's text. Consecutive chunks of one
  -- page overlap; this is what lets them be joined without repeating the overlap.
  char_start integer not null constraint knowledge_chunks_start_check check (char_start >= 0),
  char_end integer not null,
  content text not null constraint knowledge_chunks_content_length
    check (char_length(content) between 1 and 4000),
  -- The section the document introduced and the chunker carried forward ("Week 3",
  -- src/lib/knowledge/chunk.ts) — or, only when its text introduces none, the one its NAME gives
  -- ("Week_1_-_Transcript.pdf" → "Week 1"). A kind and a number, no surrounding text: a name is
  -- untrusted and nothing else of it gets in. Part of the embedded header and of the page
  -- heading the model reads. Null when neither names one.
  section text constraint knowledge_chunks_section_length
    check (section is null or char_length(section) between 1 and 120),
  embedding extensions.vector (1024),
  embedded_at timestamptz,
  primary key (source_id, ordinal),
  -- For a summary the span is its own text (0, its length): it is not a slice of one page.
  constraint knowledge_chunks_span_check check (char_end > char_start),
  constraint knowledge_chunks_kind_shape_check check (
    (kind = 'passage' and page_to is null and extraction_method <> 'model_summary')
    or (kind = 'summary' and page_to >= page_no and extraction_method = 'model_summary'
        and char_start = 0 and char_end = char_length(content))
  ),
  constraint knowledge_chunks_embedded_check check ((embedding is null) = (embedded_at is null))
);

create index knowledge_chunks_unembedded_idx
  on public.knowledge_chunks (source_id, ordinal) where embedding is null;

comment on table public.knowledge_chunks is
  'Milestone 5 part 5. The text of learned documents, about 1,500 characters a row, never across a page, with its embedding (NULL until the drain embeds it). RLS is forced and the one policy is false: no browser session reads these rows. Searched only through match_knowledge_chunks, exactly (no approximate index — see the migration).';

-- ---------------------------------------------------------------------------------------
-- (3) knowledge_drain_state — one row: the lease and the rest Voyage asked for
-- ---------------------------------------------------------------------------------------

create table public.knowledge_drain_state (
  id boolean primary key default true constraint knowledge_drain_state_one_row check (id),
  lease_holder uuid,
  lease_until timestamptz,
  -- After a refusal from Voyage nothing is sent before this. It gives no Retry-After.
  cooldown_until timestamptz,
  last_run_at timestamptz,
  last_outcome text constraint knowledge_drain_state_outcome_check
    check (last_outcome is null or last_outcome ~ '^[a-z_]{1,48}$')
);

insert into public.knowledge_drain_state (id) values (true);

comment on table public.knowledge_drain_state is
  'Milestone 5 part 5. One row. Who holds the drain lease and until when, and until when Voyage is resting after a refusal. The cron job, the files function and the CLI all go through claim_knowledge_drain, so at most one drain sends to Voyage at a time.';

-- ---------------------------------------------------------------------------------------
-- (4) Row-level security
-- ---------------------------------------------------------------------------------------

alter table public.knowledge_sources enable row level security;
alter table public.knowledge_sources force row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_chunks force row level security;
alter table public.knowledge_drain_state enable row level security;
alter table public.knowledge_drain_state force row level security;

revoke all on public.knowledge_sources, public.knowledge_chunks, public.knowledge_drain_state
  from anon, authenticated;
-- The grant every table carries, so that it is row-level security that refuses, not a missing
-- privilege (tests/security/rls.test.ts).
grant select on public.knowledge_sources, public.knowledge_chunks, public.knowledge_drain_state
  to authenticated;
grant all on public.knowledge_sources, public.knowledge_chunks, public.knowledge_drain_state
  to service_role;

create policy knowledge_sources_staff_read on public.knowledge_sources
  for select to authenticated
  using (public.is_active_staff());

create policy knowledge_chunks_no_browser_read on public.knowledge_chunks
  for select to authenticated using (false);

create policy knowledge_drain_state_no_browser_read on public.knowledge_drain_state
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------------------
-- (5) What reached the model, kept with the reply it affected
-- ---------------------------------------------------------------------------------------
-- Ids and numbers only — which documents, which page numbers of how many, whether it was
-- still being learned. Never a name: a removed document must name nothing (the tombstone
-- rule), so the screen looks the name up at the time it shows the note.

alter table public.messages
  add column document_coverage jsonb
    constraint messages_document_coverage_check
    check (document_coverage is null
      or (jsonb_typeof(document_coverage) = 'object' and octet_length(document_coverage::text) <= 16384));

comment on column public.messages.document_coverage is
  'Milestone 5 part 5. On an assistant row: which documents the answer was written from and how much of each reached the model (ids, page numbers, counts — never a name or a word of text). Shown under the reply. Null when no document was involved.';

-- ---------------------------------------------------------------------------------------
-- (6) Forgetting
-- ---------------------------------------------------------------------------------------

create or replace function public.forget_knowledge(
  p_source_id uuid,
  p_content_hash text,
  p_actor uuid,
  p_reason text
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
  v_count integer := 0;
  v_chunks integer;
begin
  if p_reason not in ('user', 'operator') then
    raise exception 'reason must be user or operator' using errcode = '22023';
  end if;
  -- The source itself, and every other source of the same bytes: forgetting a document is
  -- forgetting it, not one copy of it.
  for v_id in
    select s.id from public.knowledge_sources s
    where s.status <> 'forgotten'
      and (s.id = p_source_id or (p_content_hash is not null and s.content_hash = p_content_hash))
    order by s.id
    for update
  loop
    delete from public.knowledge_chunks c where c.source_id = v_id;
    get diagnostics v_chunks = row_count;
    update public.knowledge_sources s
    set status = 'forgotten',
        name = null,
        content_hash = null,
        source_url = null,
        source_host = null,
        version_key = null,
        chunk_count = 0,
        embedded_count = 0,
        chunk_chars = 0,
        failure = null,
        forgotten_at = now(),
        forgotten_by = p_actor,
        forgotten_reason = p_reason
    where s.id = v_id;
    -- Ids and counts. Never the name, never the address, never a word of the content.
    insert into public.audit_log (actor, action, entity_type, entity_id, before)
    values (
      coalesce(p_actor::text, 'system'), 'KNOWLEDGE_FORGOTTEN', 'knowledge_sources', v_id,
      jsonb_build_object('chunks', v_chunks, 'reason', p_reason)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.forget_knowledge(uuid, text, uuid, text) is
  'Milestone 5 part 5. Forgets a learned document and every other copy of the same bytes: chunks deleted, the source left as a tombstone that names nothing, one audit row each (ids and counts). Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (7) The triggers on conversation_files
-- ---------------------------------------------------------------------------------------
-- Both run as whoever changed the attachment (service_role, inside finish/remove). They do
-- nothing that can fail on well-formed data and nothing that leaves the database: no Vault,
-- no pg_net. An attachment must never fail to attach because learning could not start.

create or replace function public.knowledge_enqueue_on_ready()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.knowledge_sources
    (file_id, conversation_id, uploaded_by, kind, name, content_hash, source_url, source_host,
     version_key, learned_at, page_count)
  values
    (new.id, new.conversation_id, new.uploaded_by, new.kind, new.name, new.content_hash,
     new.source_url, new.source_host,
     coalesce(new.source_url, 'sha:' || new.content_hash),
     coalesce(new.fetched_at, new.ready_at, now()),
     new.page_count)
  on conflict (file_id) where file_id is not null do nothing;
  return new;
end;
$$;

create trigger conversation_files_knowledge_enqueue_update
  after update of status on public.conversation_files
  for each row
  when (old.status is distinct from 'ready' and new.status = 'ready')
  execute function public.knowledge_enqueue_on_ready();

create trigger conversation_files_knowledge_enqueue_insert
  after insert on public.conversation_files
  for each row
  when (new.status = 'ready')
  execute function public.knowledge_enqueue_on_ready();

-- Files already ready when this migration runs never pass the triggers above: without this, a
-- long document attached before the deploy is never learned, and its own conversation falls
-- back to its opening pages. Run once, at the end of this migration. The drain takes the oldest
-- queued first, so the newest file is queued earliest: the conversations he is likeliest to go
-- back to are learned first.
create or replace function public.knowledge_enqueue_ready_files()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.knowledge_sources
    (file_id, conversation_id, uploaded_by, kind, name, content_hash, source_url, source_host,
     version_key, learned_at, page_count, created_at)
  select f.id, f.conversation_id, f.uploaded_by, f.kind, f.name, f.content_hash,
         f.source_url, f.source_host,
         coalesce(f.source_url, 'sha:' || f.content_hash),
         coalesce(f.fetched_at, f.ready_at, now()),
         f.page_count,
         now() - (row_number() over (
           order by coalesce(f.fetched_at, f.ready_at, f.created_at), f.id
         ))::integer * interval '1 millisecond'
    from public.conversation_files f
   where f.status = 'ready'
  on conflict (file_id) where file_id is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.knowledge_forget_on_remove()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_source uuid;
begin
  select s.id into v_source from public.knowledge_sources s where s.file_id = new.id;
  -- OLD still has the hash: remove_conversation_file clears it in the same update.
  perform public.forget_knowledge(v_source, old.content_hash, new.removed_by, 'user');
  return new;
end;
$$;

create trigger conversation_files_knowledge_forget
  after update of status on public.conversation_files
  for each row
  when (old.status = 'ready' and new.status = 'removed' and new.removed_reason = 'user')
  execute function public.knowledge_forget_on_remove();

-- ---------------------------------------------------------------------------------------
-- (8) Learning: capture, copy from a twin, fail, attach embeddings
-- ---------------------------------------------------------------------------------------

-- The same bytes, already learned with the same chunker: copy, do not pay Voyage again.
create or replace function public.copy_knowledge_from_twin(
  p_source_id uuid,
  p_chunker_version text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_source public.knowledge_sources%rowtype;
  v_twin public.knowledge_sources%rowtype;
begin
  select * into v_source from public.knowledge_sources s where s.id = p_source_id for update;
  if not found or v_source.status <> 'pending' then
    return false;
  end if;
  select * into v_twin
  from public.knowledge_sources s
  where s.status = 'ready'
    and s.id <> p_source_id
    and s.content_hash = v_source.content_hash
    and s.chunker_version = p_chunker_version
  order by s.ready_at desc
  limit 1;
  if not found then
    return false;
  end if;
  insert into public.knowledge_chunks
    (source_id, ordinal, kind, page_no, page_to, page_label, extraction_method, legibility,
     char_start, char_end, content, section, embedding, embedded_at)
  select p_source_id, c.ordinal, c.kind, c.page_no, c.page_to, c.page_label,
         c.extraction_method, c.legibility, c.char_start, c.char_end, c.content, c.section,
         c.embedding, c.embedded_at
  from public.knowledge_chunks c
  where c.source_id = v_twin.id;
  update public.knowledge_sources s
  set status = 'ready',
      chunk_count = v_twin.chunk_count,
      embedded_count = v_twin.chunk_count,
      chunk_chars = v_twin.chunk_chars,
      chunker_version = p_chunker_version,
      summary_status = v_twin.summary_status,
      captured_at = now(),
      ready_at = now()
  where s.id = p_source_id;
  return true;
end;
$$;

-- The chunks of a pending source, cut by the application. Idempotent: a source that is no
-- longer pending is left exactly as it is and its state returned. p_summarise: the document is
-- long enough to need a summary (the application decides) — nothing of it is embedded until the
-- summary is written or has failed for good, so it can never turn ready without it.
create or replace function public.capture_knowledge_source(
  p_source_id uuid,
  p_chunker_version text,
  p_chunks jsonb,
  p_summarise boolean
)
returns table (status text, chunk_count integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_source public.knowledge_sources%rowtype;
  v_count integer;
  v_chars integer;
begin
  select * into v_source from public.knowledge_sources s where s.id = p_source_id for update;
  if not found then
    raise exception 'knowledge source % does not exist', p_source_id using errcode = '02000';
  end if;
  if v_source.status <> 'pending' then
    return query select v_source.status, v_source.chunk_count;
    return;
  end if;
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'knowledge source % needs at least one chunk', p_source_id using errcode = '22023';
  end if;
  insert into public.knowledge_chunks
    (source_id, ordinal, page_no, page_label, extraction_method, legibility, char_start,
     char_end, content, section)
  select p_source_id, x.ordinal, x.page_no, x.page_label, x.extraction_method, x.legibility,
         x.char_start, x.char_end, x.content, x.section
  from jsonb_to_recordset(p_chunks) as x(
    ordinal integer, page_no integer, page_label text, extraction_method text,
    legibility text, char_start integer, char_end integer, content text, section text
  );
  select count(*), coalesce(sum(char_length(c.content)), 0) into v_count, v_chars
  from public.knowledge_chunks c where c.source_id = p_source_id;
  update public.knowledge_sources s
  set status = 'learning',
      chunk_count = v_count,
      chunk_chars = v_chars,
      chunker_version = p_chunker_version,
      summary_status = case when coalesce(p_summarise, false) then 'pending' else 'none' end,
      captured_at = now()
  where s.id = p_source_id;
  return query select 'learning'::text, v_count;
end;
$$;

-- The summary of a learning source whose summary is pending, appended after its passages.
-- Idempotent: anything else is left as it is. A forgotten source takes nothing.
create or replace function public.add_knowledge_summaries(
  p_source_id uuid,
  p_summaries jsonb
)
returns table (status text, chunk_count integer, summary_status text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_source public.knowledge_sources%rowtype;
  v_count integer;
  v_chars integer;
begin
  select * into v_source from public.knowledge_sources s where s.id = p_source_id for update;
  if not found then
    raise exception 'knowledge source % does not exist', p_source_id using errcode = '02000';
  end if;
  if v_source.status <> 'learning' or v_source.summary_status <> 'pending' then
    return query select v_source.status, v_source.chunk_count, v_source.summary_status;
    return;
  end if;
  if jsonb_typeof(p_summaries) <> 'array' or jsonb_array_length(p_summaries) = 0 then
    raise exception 'knowledge source % needs at least one summary', p_source_id using errcode = '22023';
  end if;
  insert into public.knowledge_chunks
    (source_id, ordinal, kind, page_no, page_to, page_label, extraction_method, legibility,
     char_start, char_end, content, section)
  select p_source_id, v_source.chunk_count + x.position, 'summary', x.page_no, x.page_to,
         x.page_label, 'model_summary', 'full', 0, char_length(x.content), x.content, x.section
  from jsonb_to_recordset(p_summaries) as x(
    position integer, page_no integer, page_to integer, page_label text, content text,
    section text
  );
  select count(*), coalesce(sum(char_length(c.content)), 0) into v_count, v_chars
  from public.knowledge_chunks c where c.source_id = p_source_id;
  update public.knowledge_sources s
  set chunk_count = v_count,
      chunk_chars = v_chars,
      summary_status = 'done'
  where s.id = p_source_id;
  return query select 'learning'::text, v_count, 'done'::text;
end;
$$;

-- One failed attempt at a pending summary. After p_max_attempts the document is learned without
-- one: a summary is worth waiting a few runs for, never worth a document stuck forever.
create or replace function public.fail_knowledge_summary(
  p_source_id uuid,
  p_max_attempts integer
)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
begin
  update public.knowledge_sources s
  set summary_attempts = least(s.summary_attempts + 1, 20),
      summary_status = case when s.summary_attempts + 1 >= greatest(p_max_attempts, 1)
                            then 'failed' else 'pending' end
  where s.id = p_source_id and s.status = 'learning' and s.summary_status = 'pending'
  returning s.summary_status into v_status;
  return coalesce(v_status, 'unchanged');
end;
$$;

-- A source that cannot be learned: its text was purged before capture, or it had none.
create or replace function public.fail_knowledge_source(
  p_source_id uuid,
  p_failure text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.knowledge_sources s
  set status = 'failed', failure = p_failure
  where s.id = p_source_id and s.status = 'pending';
  return found;
end;
$$;

-- Embeddings for some chunks of one learning source. The flip to `ready` is in the same
-- statement as the last of them. A source that is not `learning` — forgotten while the
-- batch was in flight, above all — takes nothing: what a person removed never comes back.
create or replace function public.attach_knowledge_embeddings(
  p_source_id uuid,
  p_embeddings jsonb
)
returns table (status text, embedded_count integer, chunk_count integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_source public.knowledge_sources%rowtype;
  v_embedded integer;
begin
  select * into v_source from public.knowledge_sources s where s.id = p_source_id for update;
  if not found then
    raise exception 'knowledge source % does not exist', p_source_id using errcode = '02000';
  end if;
  if v_source.status <> 'learning' then
    return query select v_source.status, v_source.embedded_count, v_source.chunk_count;
    return;
  end if;
  update public.knowledge_chunks c
  set embedding = x.embedding::extensions.vector,
      embedded_at = now()
  from jsonb_to_recordset(p_embeddings) as x(ordinal integer, embedding text)
  where c.source_id = p_source_id
    and c.ordinal = x.ordinal
    and c.embedding is null;
  select count(*) into v_embedded
  from public.knowledge_chunks c
  where c.source_id = p_source_id and c.embedding is not null;
  update public.knowledge_sources s
  set embedded_count = v_embedded,
      status = case when v_embedded = s.chunk_count then 'ready' else 'learning' end,
      ready_at = case when v_embedded = s.chunk_count then now() else null end
  where s.id = p_source_id;
  return query
    select case when v_embedded = v_source.chunk_count then 'ready' else 'learning' end,
           v_embedded, v_source.chunk_count;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- (9) Retrieval
-- ---------------------------------------------------------------------------------------
-- What may be retrieved for one turn:
--   A. the documents attached to THIS conversation that did not fit whole
--      (p_attached_file_ids), learning or ready — their embedded chunks, held to the lower
--      floor p_attached_min_similarity: the person is talking about them;
--   B. when p_include_learned, every other READY source that is the newest ready copy of its
--      address and of its bytes, unless it is the same document as one in A or one of the
--      files that already went in whole (p_exclude_file_ids), held to p_min_similarity.
--      p_include_learned is false when the turn's search rewrite judged the message not to be
--      about any document (src/lib/knowledge/query.ts): measured 17 Oct, "write a facebook post
--      for first home buyers" scored 0.38 against a coaching transcript and real questions
--      about it 0.29–0.49 — no floor alone tells the two apart.
-- A section the question NAMES (p_sections, e.g. {"Week 3"}): its chunks are taken first and
-- skip the floor — "week three" is a place in the document, not a meaning to approximate.
-- Measured 17 Oct: "week three main points" scored pages 33 and 32 above week three's own pages.
-- The caller must be active staff, checked here although the function runs as service_role.
-- The search is exact (see the header): each chunk is held to its floor, then the nearest
-- p_limit by distance. Each row says whether a NEAR-IDENTICAL chunk from a newer document is
-- among the results — last month's rate sheet beside this month's — so the older can be marked.

create or replace function public.match_knowledge_chunks(
  p_query extensions.vector(1024),
  p_user_id uuid,
  p_attached_file_ids uuid[],
  p_exclude_file_ids uuid[],
  p_include_learned boolean,
  p_sections text[],
  p_limit integer,
  p_min_similarity double precision,
  p_attached_min_similarity double precision
)
returns table (
  source_id uuid,
  ordinal integer,
  chunk_kind text,
  page_no integer,
  page_to integer,
  page_label text,
  extraction_method text,
  legibility text,
  char_start integer,
  char_end integer,
  content text,
  section text,
  similarity double precision,
  attached boolean,
  source_status text,
  file_id uuid,
  conversation_id uuid,
  name text,
  kind text,
  source_host text,
  learned_at timestamptz,
  page_count integer,
  chunk_count integer,
  embedded_count integer,
  newer_twin_learned_at timestamptz,
  named boolean
)
language sql
security invoker
stable
set search_path = public
as $$
  with staff as (
    select 1 from public.app_users u where u.user_id = p_user_id and u.is_active
  ),
  here_sources as (
    select s.* from public.knowledge_sources s
    where exists (select 1 from staff)
      and s.status in ('learning', 'ready')
      and s.file_id = any(coalesce(p_attached_file_ids, '{}'::uuid[]))
  ),
  whole as (
    select f.content_hash, coalesce(f.source_url, 'sha:' || f.content_hash) as version_key
    from public.conversation_files f
    where f.id = any(coalesce(p_exclude_file_ids, '{}'::uuid[])) and f.content_hash is not null
  ),
  learned as (
    select s.* from public.knowledge_sources s
    where coalesce(p_include_learned, false)
      and exists (select 1 from staff)
      and s.status = 'ready'
      and not exists (
        select 1 from public.knowledge_sources n
        where n.status = 'ready' and n.id <> s.id
          and (n.version_key = s.version_key or n.content_hash = s.content_hash)
          and (n.learned_at, n.id) > (s.learned_at, s.id)
      )
      and not exists (
        select 1 from here_sources a
        where a.version_key = s.version_key or a.content_hash = s.content_hash
      )
      and not exists (
        select 1 from whole w
        where w.version_key = s.version_key or w.content_hash = s.content_hash
      )
      -- `file_id is null` first: a source whose attachment row is gone must not be dropped
      -- by a NULL comparison against the list.
      and (s.file_id is null or not (s.file_id = any(coalesce(p_exclude_file_ids, '{}'::uuid[]))))
  ),
  eligible as (
    select a.*, true as is_attached from here_sources a
    union all
    select l.*, false as is_attached from learned l
  ),
  scored as (
    select c.source_id, c.ordinal, c.kind as chunk_kind, c.page_no, c.page_to, c.page_label,
           c.extraction_method, c.legibility,
           c.char_start, c.char_end, c.content, c.section, c.embedding,
           (c.embedding operator(extensions.<=>) p_query) as distance,
           e.is_attached, e.status as source_status, e.file_id, e.conversation_id, e.name, e.kind,
           e.source_host, e.learned_at, e.page_count, e.chunk_count, e.embedded_count
    from public.knowledge_chunks c
    join eligible e on e.id = c.source_id
    where c.embedding is not null
  ),
  named as (
    select s.*,
           (s.section is not null
             and string_to_array(s.section, ', ') && coalesce(p_sections, '{}'::text[])) as is_named
    from scored s
  ),
  nearest as materialized (
    select n.* from named n
    where n.is_named
       or 1 - n.distance >= case when n.is_attached then p_attached_min_similarity else p_min_similarity end
    order by n.is_named desc, n.distance, n.source_id, n.ordinal
    limit greatest(p_limit, 0)
  )
  select n.source_id, n.ordinal, n.chunk_kind, n.page_no, n.page_to, n.page_label,
         n.extraction_method, n.legibility,
         n.char_start, n.char_end, n.content, n.section, 1 - n.distance as similarity,
         n.is_attached, n.source_status, n.file_id, n.conversation_id, n.name, n.kind,
         n.source_host, n.learned_at, n.page_count, n.chunk_count, n.embedded_count,
         (select max(o.learned_at) from nearest o
          where o.source_id <> n.source_id
            and o.learned_at > n.learned_at
            and (o.embedding operator(extensions.<=>) n.embedding) <= 0.06) as newer_twin_learned_at,
         n.is_named
  from nearest n
  order by n.is_named desc, n.distance, n.source_id, n.ordinal;
$$;

-- The chunks either side of what retrieval chose, for continuity: one round trip for all of
-- them. Only from a source that is still learning or ready; text never of a forgotten one.
create or replace function public.knowledge_neighbours(
  p_source_id uuid,
  p_ordinals integer[]
)
returns table (
  source_id uuid,
  ordinal integer,
  page_no integer,
  page_label text,
  extraction_method text,
  legibility text,
  char_start integer,
  char_end integer,
  content text,
  section text
)
language sql
security invoker
stable
set search_path = public
as $$
  select c.source_id, c.ordinal, c.page_no, c.page_label, c.extraction_method, c.legibility,
         c.char_start, c.char_end, c.content, c.section
  from public.knowledge_chunks c
  join public.knowledge_sources s on s.id = c.source_id
  where c.source_id = p_source_id
    and c.ordinal = any(coalesce(p_ordinals, '{}'::integer[]))
    and c.kind = 'passage'
    and s.status in ('learning', 'ready')
  order by c.ordinal;
$$;

-- All of one document's summary, in page order: what an overview question ("break down week
-- one") is answered from. Only from a source that is learning or ready.
create or replace function public.knowledge_summaries_of(p_source_id uuid)
returns table (
  source_id uuid,
  ordinal integer,
  page_no integer,
  page_to integer,
  page_label text,
  content text,
  section text
)
language sql
security invoker
stable
set search_path = public
as $$
  select c.source_id, c.ordinal, c.page_no, c.page_to, c.page_label, c.content, c.section
  from public.knowledge_chunks c
  join public.knowledge_sources s on s.id = c.source_id
  where c.source_id = p_source_id
    and c.kind = 'summary'
    and s.status in ('learning', 'ready')
  order by c.page_no, c.ordinal;
$$;

-- ---------------------------------------------------------------------------------------
-- (10) The drain lease
-- ---------------------------------------------------------------------------------------

create or replace function public.claim_knowledge_drain(
  p_holder uuid,
  p_lease_seconds integer
)
returns table (claimed boolean, wait_ms integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_state public.knowledge_drain_state%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_state from public.knowledge_drain_state d where d.id for update;
  if v_state.cooldown_until is not null and v_state.cooldown_until > v_now then
    return query select false,
      ceil(extract(epoch from (v_state.cooldown_until - v_now)) * 1000)::integer;
    return;
  end if;
  if v_state.lease_until is not null and v_state.lease_until > v_now
     and v_state.lease_holder is distinct from p_holder then
    return query select false,
      ceil(extract(epoch from (v_state.lease_until - v_now)) * 1000)::integer;
    return;
  end if;
  update public.knowledge_drain_state d
  set lease_holder = p_holder,
      lease_until = v_now + make_interval(secs => greatest(p_lease_seconds, 1)),
      last_run_at = v_now
  where d.id;
  return query select true, 0;
end;
$$;

create or replace function public.release_knowledge_drain(
  p_holder uuid,
  p_outcome text,
  p_cooldown_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.knowledge_drain_state d
  set lease_holder = null,
      lease_until = null,
      last_outcome = p_outcome,
      cooldown_until = case
        when coalesce(p_cooldown_seconds, 0) > 0
          then clock_timestamp() + make_interval(secs => p_cooldown_seconds)
        else d.cooldown_until
      end
  where d.id and d.lease_holder = p_holder;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- (11) The schedule: pg_cron → pg_net → the `memory` function, action `knowledge-drain`
-- ---------------------------------------------------------------------------------------
-- The D111 pattern exactly: the secret lives in Vault and in the function's environment and
-- never travels; the request carries a two-minute token, `<second>.<HMAC-SHA256 of
-- "knowledge-drain:<second>">`. Inert until Vault holds `knowledge_drain_url` and
-- `knowledge_drain_secret` (RUNBOOK). Every minute, and only when there is something to learn,
-- no drain holds the lease and Voyage is not resting — an idle minute sends nothing.

create or replace function public.dispatch_knowledge_drain()
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
  v_at bigint;
  v_token text;
begin
  if not exists (
    select 1 from public.knowledge_sources s where s.status in ('pending', 'learning')
  ) then
    return 'idle';
  end if;
  if exists (
    select 1 from public.knowledge_drain_state d
    where d.id
      and ((d.lease_until is not null and d.lease_until > clock_timestamp())
        or (d.cooldown_until is not null and d.cooldown_until > clock_timestamp()))
  ) then
    return 'busy';
  end if;
  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s where s.name = 'knowledge_drain_url';
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s where s.name = 'knowledge_drain_secret';
  if coalesce(v_url, '') !~ '^https://' or char_length(coalesce(v_secret, '')) < 32 then
    return 'not_configured';
  end if;
  v_at := floor(extract(epoch from clock_timestamp()))::bigint;
  v_token := v_at::text || '.' || encode(
    extensions.hmac(convert_to('knowledge-drain:' || v_at::text, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'),
    'hex'
  );
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('action', 'knowledge-drain'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-knowledge-drain-token', v_token
    ),
    timeout_milliseconds := 150000
  );
  return 'requested';
end;
$$;

comment on function public.dispatch_knowledge_drain() is
  'Milestone 5 part 5. Run by pg_cron (job knowledge-drain) every minute: when a document is waiting to be learned, no drain holds the lease and Voyage is not resting, asks the memory Edge Function to drain through pg_net, with a two-minute token signed by a secret read from Vault (never sent). Does nothing until Vault holds knowledge_drain_url and knowledge_drain_secret. Owner only.';

-- ---------------------------------------------------------------------------------------
-- (12) Who may call what
-- ---------------------------------------------------------------------------------------

revoke all on function public.forget_knowledge(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.knowledge_enqueue_on_ready() from public, anon, authenticated;
revoke all on function public.knowledge_forget_on_remove() from public, anon, authenticated;
revoke all on function public.copy_knowledge_from_twin(uuid, text) from public, anon, authenticated;
revoke all on function public.capture_knowledge_source(uuid, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.fail_knowledge_source(uuid, text) from public, anon, authenticated;
revoke all on function public.add_knowledge_summaries(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fail_knowledge_summary(uuid, integer) from public, anon, authenticated;
revoke all on function public.attach_knowledge_embeddings(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.match_knowledge_chunks(extensions.vector, uuid, uuid[], uuid[], boolean, text[], integer, double precision, double precision) from public, anon, authenticated;
revoke all on function public.knowledge_neighbours(uuid, integer[]) from public, anon, authenticated;
revoke all on function public.knowledge_summaries_of(uuid) from public, anon, authenticated;
revoke all on function public.claim_knowledge_drain(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_knowledge_drain(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.dispatch_knowledge_drain() from public, anon, authenticated, service_role;
revoke all on function public.knowledge_enqueue_ready_files() from public, anon, authenticated, service_role;

grant execute on function public.forget_knowledge(uuid, text, uuid, text) to service_role;
grant execute on function public.copy_knowledge_from_twin(uuid, text) to service_role;
grant execute on function public.capture_knowledge_source(uuid, text, jsonb, boolean) to service_role;
grant execute on function public.fail_knowledge_source(uuid, text) to service_role;
grant execute on function public.add_knowledge_summaries(uuid, jsonb) to service_role;
grant execute on function public.fail_knowledge_summary(uuid, integer) to service_role;
grant execute on function public.attach_knowledge_embeddings(uuid, jsonb) to service_role;
grant execute on function public.match_knowledge_chunks(extensions.vector, uuid, uuid[], uuid[], boolean, text[], integer, double precision, double precision) to service_role;
grant execute on function public.knowledge_neighbours(uuid, integer[]) to service_role;
grant execute on function public.knowledge_summaries_of(uuid) to service_role;
grant execute on function public.claim_knowledge_drain(uuid, integer) to service_role;
grant execute on function public.release_knowledge_drain(uuid, text, integer) to service_role;

select cron.schedule(
  'knowledge-drain',
  '* * * * *',
  $$select public.dispatch_knowledge_drain()$$
);

-- Every file attached before this deploy, queued once (see section 7).
select public.knowledge_enqueue_ready_files();
