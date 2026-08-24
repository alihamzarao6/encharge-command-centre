-- Explicit privilege layer for service_role (Stage 2 part 3, FND-220).
--
-- Found while wiring auth: the part-2 RLS migration states the privilege layer for anon
-- (nothing) and authenticated (SELECT only) but is silent about service_role — it relied
-- on inherited grants, which is exactly the environment divergence that broke CI on the
-- first part-2 push (hosted pre-grants via default privileges; the local/CI stack grants
-- nothing). BYPASSRLS skips row policies, not table privileges: on a fresh local stack an
-- Edge Function or server-side script using the service role key through PostgREST would
-- be refused with 42501 before touching a row.
--
-- So the grant is stated, for the same reason the authenticated grants are: explicit,
-- environment-independent, asserted by tests/security/rls.test.ts so a future migration
-- that adds a table without its service_role grant fails CI loudly.
--
-- service_role is the sanctioned write path (SECURITY.md §4): Edge Functions and n8n only,
-- never a browser. RLS policies still deny writes to anon/authenticated everywhere.
-- No sequences exist (uuid PKs); function EXECUTE is granted to PUBLIC by default.
--
-- Reversible: revoke all on all tables in schema public from service_role;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
