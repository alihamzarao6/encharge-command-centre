-- Extensions (SCHEMA.md §8, task 2.2.3).
-- All three live in the `extensions` schema — the Supabase convention, present on hosted,
-- local and CI stacks alike. Every use site schema-qualifies the type/opclass instead of
-- relying on search_path, so a session with a stripped search_path still resolves them.
--
-- pgcrypto: gen_random_uuid() has been core since PG13, but pgcrypto stays declared because
--   SECURITY.md §2 and future digest()/hmac() use expect it, and declaring it is free.
-- pg_trgm:  trigram matching (fuzzy name lookups; the gin_trgm indexes come with the tables
--   that need them).
-- vector:   pgvector for the Stage 3 memory embeddings (voyage-3, 1024 dims).
--
-- Reversible: drop extension if exists <name>; (safe only while no dependent objects exist).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists vector with schema extensions;
