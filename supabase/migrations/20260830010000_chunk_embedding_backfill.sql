-- Stage 3 part 5b (FND-340, D70): a chunk may exist without its embedding, and the backlog
-- has to be findable cheaply.
--
-- WHAT CHANGED IN BEHAVIOUR, and why it needed no column. Until 29 Aug, if the Voyage call
-- failed the summariser threw the summary away and left the range uncovered, so the next
-- sweep planned the same range and paid Haiku for the same text again. Measured on the live
-- project: 21 real turns, several paid summarisations, and ZERO chunks written — because the
-- Voyage account allows 3 requests per minute and a turn needs two when a chunk is due.
--
-- The Haiku call is roughly 1,600x the cost of the Voyage one ($0.001664 vs $0.000010,
-- measured). Discarding the expensive half because the cheap half failed is the wrong way
-- round. So the chunk is now written WITHOUT an embedding:
--
--   * `embedding` is already nullable and always was — the part-3 tombstone sets it to null,
--     so no column changes here;
--   * `turn_range` claims the range through `memory_chunks_no_overlap`, so the text can never
--     be summarised and charged for twice — that is the whole point;
--   * `match_memory_chunks` already filters `k.embedding is not null`, so an unembedded chunk
--     is invisible to retrieval and nothing half-formed can reach a reply;
--   * the Memory page shows it like any other note, which is right: it exists, the person can
--     read it and delete it, it just cannot be recalled semantically yet.
--
-- THE ONLY THING THE DATABASE NEEDS is a cheap way to ask "what is waiting?", because the
-- sweep asks on every run. Hence one partial index, which is also the clearest statement of
-- the predicate:
--
--     embedding is null AND deleted_at is null
--
-- Both halves matter. A TOMBSTONE (part 3, migration 20260827030000) also has a null
-- embedding — its content was destroyed on purpose — and must never be picked up and
-- re-embedded. `deleted_at is null` is what separates "waiting for its vector" from "removed
-- by a person", and it is why the backfill can never resurrect something somebody deleted.
--
-- Ordered by `created_at` so the backlog drains oldest-first: the note most likely to be
-- recalled is the one that has been missing longest.
--
-- Reversible:
--   drop index public.memory_chunks_needs_embedding_idx;

create index memory_chunks_needs_embedding_idx
  on public.memory_chunks (created_at)
  where embedding is null and deleted_at is null;

comment on index public.memory_chunks_needs_embedding_idx is
  'The backfill queue (D70): chunks whose summary was kept when the embedding call failed. Excludes tombstones, whose embedding is null because their content was destroyed on purpose and which must never be re-embedded.';

comment on column public.memory_chunks.embedding is
  'Voyage voyage-3, 1024 dimensions. NULL means one of two different things, told apart by deleted_at: with deleted_at NULL the summary was kept when the embedding call failed and is waiting for backfillChunkEmbeddings (D70); with deleted_at SET it is a tombstone whose content was destroyed by a person (D50). match_memory_chunks ignores both.';
