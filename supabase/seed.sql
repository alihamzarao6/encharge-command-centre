-- Seed (SCHEMA.md §8, task 2.2.10). Synthetic and staff-only — NO client data, ever.
-- Contents: the two staff allowlist rows (the developer and Ross) and the ten Finance
-- Pipeline stage rows in ghl_field_map. Idempotent: every insert is an upsert-or-skip, so
-- replaying the seed can never duplicate a row (CLAUDE.md rule 9).
--
-- Runs as postgres, which carries BYPASSRLS — that is why these inserts succeed against
-- tables with FORCE row level security and no insert policies (verified against the live
-- project's role attributes, 24 Aug).

-- ---------------------------------------------------------------------------------------
-- Auth scaffolding for the two staff accounts.
--
-- app_users.user_id references auth.users, so the allowlist cannot be seeded without auth
-- rows to point at. These are deliberately unusable placeholders: encrypted_password is
-- empty, so no one can log in as them. Stage 2 part 3 (auth) replaces the credentials via
-- the Auth admin API against these same fixed UUIDs — the UUIDs are the stable identity
-- that memory rows will hang off, and they must not change once rows exist.
--
-- The empty-string token columns are not noise: GoTrue's user queries error on NULL in
-- those columns when rows are created outside its own API.
-- ---------------------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a0000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'rossb@fundd.com.au', '', now(),
    '{"provider": "email", "providers": ["email"]}', '{}', now(), now(),
    '', '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'a0000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'alihamzarao14@gmail.com', '', now(),
    '{"provider": "email", "providers": ["email"]}', '{}', now(), now(),
    '', '', '', '', '', '', '', ''
  )
on conflict (id) do nothing;

-- Both seeded accounts are admins (is_admin, part 3): Ross owns the workspace and the
-- developer administers it during the build. Every later account defaults to false and is
-- promoted only by a deliberate admin action. `role` is a label, not a permission.
insert into public.app_users (user_id, email, role, is_active, is_admin)
values
  ('a0000000-0000-4000-8000-000000000001', 'rossb@fundd.com.au', 'owner', true, true),
  ('a0000000-0000-4000-8000-000000000002', 'alihamzarao14@gmail.com', 'developer', true, true)
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------------------
-- The ten Finance Pipeline stage rows (entity = 'stage', D28).
--
-- Real stage IDs, read from GoHighLevel on 24 Aug 2026 (authorized read; pipeline
-- `M4unnMKBy0TgwCwOA6wS`, location `tgw5Q3BnoZoSsVOnRUxB`). Nine stages were delivered by
-- the Stage 1 build; "Appointment Booked" was found missing, and was created via an
-- approved API write the same day (MEMORY.md 24 Aug) — its ID is the one non-Stage-1 ID
-- below.
--
-- Matching is on ID, NEVER on name: this account has already produced a trailing space
-- ("Contacted "), a misspelling ("Assest Finance") and a U+00A0 non-breaking space
-- (MEMORY.md 12 Aug). ghl_field_key holds the human-readable stage name for reference
-- only; nothing may ever match against it. If a stage is ever recreated in GHL it gets a
-- NEW id — update this seed (and the live row) from a fresh read, never by assumption.
-- ---------------------------------------------------------------------------------------

insert into public.ghl_field_map (internal_field, ghl_custom_field_id, ghl_field_key, entity)
values
  ('new_lead',             '51c98561-cd26-49a9-a001-97536c31dd0a', 'New Lead',               'stage'),
  ('appointment_booked',   '3a47fe3c-57d1-41d4-bc89-20241eb978f4', 'Appointment Booked',     'stage'),
  ('contacted',            'f2393065-3038-4fba-bdf1-8c39b7b18183', 'Contacted',              'stage'),
  ('qualified',            '5d215f52-d09d-45c8-a192-a2555ce46317', 'Qualified',              'stage'),
  ('docs_requested',       '8727dd26-4e4d-4faf-b198-14e181c12e9e', 'Docs Requested',         'stage'),
  ('docs_received',        '924f9bfc-3156-4440-a624-3eb10f506c6c', 'Docs Received',          'stage'),
  ('submitted_to_lender',  'dea94c3a-84d0-40e4-a722-6ff3db4c8af9', 'Submitted to Lender',    'stage'),
  ('approved',             '2c356add-69e4-458e-b940-a7aaa9947159', 'Approved',               'stage'),
  ('settled',              '9cef8b67-1171-4347-9275-36e1055a97aa', 'Settled',                'stage'),
  ('lost_not_proceeding',  '2ee75d16-1407-43cf-811e-957e0e2adc3a', 'Lost / Not Proceeding',  'stage')
on conflict (entity, internal_field) do nothing;
