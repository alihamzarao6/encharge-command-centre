-- app_users.is_admin — the second (and last) authorization fact (Stage 2 part 3, FND-220).
--
-- Two facts exist about a staff account: is it allowlisted (is_active), and may it manage
-- users (is_admin). Nothing more. `role` stays a descriptive label ('owner', 'developer',
-- 'staff') with NO permission semantics — deriving permissions from labels would be a
-- roles system by the back door, which part 3 explicitly forbids.
--
-- Admin gates exactly two operations, both server-side: creating a staff user and
-- deactivating one (src/lib/auth/admin.ts). The check is on the CALLER's row, verified
-- from their JWT before the service role does anything.
--
-- Default false: a newly added staff member can chat, not administer. The two seeded
-- accounts (Ross, the developer) are flagged admin in seed.sql.
--
-- Reversible: alter table public.app_users drop column is_admin;

alter table public.app_users
  add column is_admin boolean not null default false;
