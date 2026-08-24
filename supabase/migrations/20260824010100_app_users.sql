-- app_users — the staff allowlist (SCHEMA.md §7, task 2.2.4).
-- Everything else keys off this table: a Supabase Auth account that is not here with
-- is_active = true sees nothing (RLS migration) and cannot reach the chat endpoint
-- (Stage 2 part 3).
--
-- The primary key is user_id, not a surrogate id: the table is strictly 1:1 with
-- auth.users and a second identity for the same person would be a join nobody needs.
-- (Deliberate, recorded deviation from the id-uuid convention in SCHEMA.md; flagged in
-- the part-2 report.)
--
-- on delete cascade: an allowlist row is meaningless without its auth account. The memory
-- tables deliberately do NOT cascade (see the memory-layer migration) — deactivation
-- (is_active = false), not deletion, is how a person leaves; their workspace-scoped
-- memory stays, because the client was promised one shared brain (D33).
--
-- Reversible: drop table public.app_users;

create table public.app_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  role text not null default 'staff',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
