-- Stage 3 part 1 (FND-300): memory_chunks becomes a written table.
--
-- Three changes, one logical unit — everything the summariser needs the database to
-- guarantee before the first chunk lands:
--
-- 1. turn_range is NOT NULL and non-empty. A chunk is "a summary plus a pointer to the
--    messages it compresses" (SCHEMA.md §4); a chunk with no pointer cannot be
--    deduplicated, re-checked against its source, or shown on the Stage 3 memory page.
--    The range is half-open [lo, hi) over 1-based message ordinals within the
--    conversation (created_at, id order), lo >= 1.
--
-- 2. Chunks of one conversation can never overlap: an EXCLUDE constraint on
--    (conversation_id =, turn_range &&). This is the idempotency key for
--    summarisation — re-running the same range is refused by the database (23P01),
--    not merely avoided by application code, so a retry storm or two Edge Function
--    invocations racing on the same conversation cannot store the same turns twice.
--    Needs btree_gist for the uuid equality operator inside a GiST index; the extension
--    lives in `extensions` like the others (SCHEMA.md §8, extensions migration).
--
-- 3. ivfflat → HNSW on the embedding column. ivfflat partitions the space into `lists`
--    centroids computed FROM THE ROWS PRESENT AT CREATE INDEX TIME — built on an empty
--    table (which is what part 2 did, in good faith) it has no usable centroids, and
--    pgvector documents that it should be created only after the table has data and
--    rebuilt as the data grows. That would leave a "reindex once there are rows" chore
--    in the RUNBOOK that nobody remembers to do. HNSW has no training step, gives
--    better recall for the same query time, and pgvector recommends it as the default
--    for tables that grow incrementally, which is exactly a memory that fills one
--    conversation at a time. At this table's scale (thousands of rows at most) build
--    cost is irrelevant. The retrieval part (part 2) queries with `<=>` (cosine), the
--    operator class below.
--
-- Reversible:
--   drop index if exists public.memory_chunks_embedding_idx;
--   create index memory_chunks_embedding_idx on public.memory_chunks
--     using ivfflat (embedding extensions.vector_cosine_ops);
--   alter table public.memory_chunks drop constraint memory_chunks_no_overlap;
--   alter table public.memory_chunks drop constraint memory_chunks_turn_range_valid;
--   alter table public.memory_chunks alter column turn_range drop not null;
--   drop extension if exists btree_gist;

create extension if not exists btree_gist with schema extensions;

-- (1) The pointer is mandatory. The table has no rows yet (populated from this part),
--     so the NOT NULL needs no backfill.
alter table public.memory_chunks
  alter column turn_range set not null;

alter table public.memory_chunks
  add constraint memory_chunks_turn_range_valid
  check (not isempty(turn_range) and lower(turn_range) >= 1 and lower_inc(turn_range) and not upper_inc(turn_range));

-- (2) No two chunks of one conversation cover the same message.
alter table public.memory_chunks
  add constraint memory_chunks_no_overlap
  exclude using gist (conversation_id with =, turn_range with &&);

-- (3) HNSW replaces the untrained ivfflat.
drop index if exists public.memory_chunks_embedding_idx;
create index memory_chunks_embedding_idx on public.memory_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

comment on column public.memory_chunks.turn_range is
  'Half-open [lo, hi) over 1-based message ordinals of the conversation (created_at, id order). Chunks of one conversation never overlap (memory_chunks_no_overlap).';
