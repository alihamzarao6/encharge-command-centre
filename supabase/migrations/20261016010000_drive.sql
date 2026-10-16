-- Milestone 5 part 3a — a file picked from his own Google Drive (brief of 15 Oct 2026;
-- docs/MEMORY.md 15 Oct entry, D119–D127).
--
-- Part 1 reads a file he uploads; part 2 a page he links to. This part lets him pick a file out
-- of his own Google Drive. Drive is a new way for BYTES to arrive, not a new way to read them:
-- the `drive` Edge Function fetches (or exports) the file with his token, hands the bytes to the
-- browser, the browser reads them with part 1's readers and sends back text, and the file
-- becomes one more row in `conversation_files` — kept like an upload (D121), never as bytes.
--
-- What this migration adds:
--
--   * `drive_connections` — one per person: which Google account, its refresh token SEALED
--     (AES-256-GCM in the function, D124: the database never holds a usable token, and the key
--     is not in the database), and whether Google still honours it (D122). The one policy is
--     `false`: no signed-in session reads a row. A person learns their own status from the
--     function, which reads it as the server.
--   * `drive_oauth_states` — one per "Connect", single-use, ten minutes. Google's code is held
--     here, sealed, between the callback and the signed-in `finish` that alone may turn it into
--     a token (D123). A code that is never finished is never exchanged, and simply expires at
--     Google.
--   * `drive_reads` — the server's record of each file it fetched from Drive for someone: who,
--     which Drive file, what Google called its type, what it was exported as, the size and the
--     SHA-256 of the bytes handed over. `begin` attaches those bytes and no others (FL007), and
--     takes the Drive file, the name and the time from this record — exactly as part 2's
--     `web_fetches` does for a page. A record dies with its connection: after a disconnect,
--     nothing fetched before it can still be attached.
--   * `conversation_files.drive_file_id` — the Drive file a row was read from. The row's
--     `source_url` is the ONE canonical address of that file, so part 2's rule "a newer read of
--     the same address replaces an older one" replaces an older read of the same Drive file
--     (D121). Gone when the row is removed, like the address.
--
-- Deploy order (RUNBOOK §1i): this migration, then the `drive` and `files` functions, then the
-- web app. `begin_conversation_file` keeps accepting every call the deployed `files` function
-- makes (the new parameter has a default), so nothing breaks in between.
--
-- Reversible:
--   drop function public.claim_drive_read(uuid, uuid, text, integer);
--   drop function public.complete_drive_read(uuid, uuid, text, text, text, text, text, bigint, text, timestamptz, integer);
--   drop function public.create_drive_oauth_state(uuid, text, text, integer, integer);
--   drop function public.return_drive_oauth_state(text, text, text);
--   drop function public.take_drive_oauth_state(uuid, uuid);
--   drop function public.save_drive_connection(uuid, uuid, uuid, text, text, text, text);
--   drop function public.mark_drive_connection_broken(uuid, uuid, text);
--   drop function public.delete_drive_connection(uuid, uuid);
--   drop table public.drive_reads; drop table public.drive_oauth_states; drop table public.drive_connections;
--   (then restore begin_/finish_/remove_/purge_conversation_file(s) from 20261012020000)
--   update public.conversation_files set source_url = null, source_host = null, fetched_at = null
--     where drive_file_id is not null and status = 'removed';
--   alter table public.conversation_files drop constraint conversation_files_drive_source_check,
--     drop column drive_file_id;   (and re-add the tombstone check as 20261012020000 wrote it)

-- ---------------------------------------------------------------------------------------
-- (1) Which Drive file a conversation file came from
-- ---------------------------------------------------------------------------------------

alter table public.conversation_files
  add column drive_file_id text
    constraint conversation_files_drive_file_id_check
    check (drive_file_id is null or drive_file_id ~ '^[A-Za-z0-9_-]{8,200}$');

-- A row from Drive names exactly one address for that file, so the same file read twice in a
-- conversation is the same address twice (finish replaces the older read).
alter table public.conversation_files
  add constraint conversation_files_drive_source_check check (
    drive_file_id is null
    or (source_host = 'drive.google.com'
        and source_url = 'https://drive.google.com/file/d/' || drive_file_id || '/view')
  );

-- The tombstone guarantee now covers the Drive file too: a removed row names nothing.
alter table public.conversation_files drop constraint conversation_files_tombstone_check;
alter table public.conversation_files add constraint conversation_files_tombstone_check
  check (
    (status = 'removed' and name is null and content_hash is null and removed_at is not null
      and source_url is null and drive_file_id is null)
    or (status <> 'removed' and name is not null and content_hash is not null)
  );

comment on column public.conversation_files.drive_file_id is
  'Milestone 5 part 3a. The Google Drive file this row was read from, copied from the server''s record of the read (drive_reads) — never from anything a browser sends. Null for an upload or a link, and null again once removed. The row''s source_url is that file''s one canonical address.';

-- ---------------------------------------------------------------------------------------
-- (2) drive_connections — one per person
-- ---------------------------------------------------------------------------------------

create table public.drive_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Which token this row holds NOW. A new token gets a new id, so a write meant for an older
  -- token (marking it broken, deleting it after Google revoked it) never lands on a newer one.
  -- The function makes the id and seals the token against it (D124).
  token_id uuid not null,
  -- Drive's permission id for the account: stable, and the same whichever address it uses.
  -- It is what tells "the same account again" from "a different account" (D125).
  google_account_id text not null constraint drive_connections_account_check
    check (char_length(google_account_id) between 1 and 128),
  -- Shown to the person so the page can say WHICH account is connected (D126). Never logged.
  google_email text not null constraint drive_connections_email_check
    check (char_length(google_email) between 3 and 320),
  -- `v1.<iv>.<ciphertext+tag>`, base64url. Opens only with the key in the function's secrets,
  -- and only for this user and this token id (the associated data). The length is checked
  -- apart from the pattern: PostgreSQL's regular expressions allow no repetition count over
  -- 255 (found replaying this file on PostgreSQL 17 before it ever ran on a stack).
  refresh_token_sealed text not null constraint drive_connections_sealed_check
    check (refresh_token_sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$'
           and char_length(refresh_token_sealed) between 60 and 8100),
  -- What Google said it granted. Checked to contain drive.file and nothing wider before a row
  -- is ever written (the brief's decision 1).
  granted_scope text not null constraint drive_connections_scope_check
    check (char_length(granted_scope) between 1 and 2000),
  -- broken: Google stopped honouring the token (D122). Kept so the page can say when and why;
  -- the next Connect replaces it.
  status text not null default 'active' constraint drive_connections_status_check
    check (status in ('active', 'broken')),
  broken_reason text constraint drive_connections_broken_reason_check
    check (broken_reason is null or broken_reason ~ '^[a-z_]{1,48}$'),
  broken_at timestamptz,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint drive_connections_broken_check check (
    (status = 'active' and broken_reason is null and broken_at is null)
    or (status = 'broken' and broken_reason is not null and broken_at is not null)
  )
);

comment on table public.drive_connections is
  'Milestone 5 part 3a. One Google Drive connection per person: the account, its refresh token SEALED by the drive function (never readable from the database alone), what was granted, and whether Google still honours it. The one policy is false: no signed-in session reads a row; the drive function reports a person''s own status. Written only through save_ / mark_ / delete_drive_connection (service_role).';

alter table public.drive_connections enable row level security;
alter table public.drive_connections force row level security;

revoke all on public.drive_connections from anon, authenticated;
-- The grant every table carries, so that it is row-level security that refuses, not a missing
-- privilege (tests/security/rls.test.ts) — and the policy that refuses everyone.
grant select on public.drive_connections to authenticated;
grant all on public.drive_connections to service_role;

create policy drive_connections_no_browser_read on public.drive_connections
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------------------
-- (3) drive_oauth_states — one per "Connect", single-use, ten minutes
-- ---------------------------------------------------------------------------------------

create table public.drive_oauth_states (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 of the `state` sent to Google, hex. The value itself is never stored.
  state_hash text not null constraint drive_oauth_states_hash_check
    check (state_hash ~ '^[0-9a-f]{64}$'),
  -- Who pressed Connect. Only a signed-in finish by this same person exchanges the code (D123).
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The PKCE verifier, sealed against this state.
  verifier_sealed text not null constraint drive_oauth_states_verifier_check
    check (verifier_sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$'
           and char_length(verifier_sealed) between 60 and 2100),
  -- Google's code, sealed against this state. Set by the callback; never sent anywhere but
  -- Google's token endpoint, and only by finish.
  code_sealed text constraint drive_oauth_states_code_check
    check (code_sealed is null
           or (code_sealed ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$'
               and char_length(code_sealed) between 40 and 8100)),
  -- What Google said instead of a code (`access_denied` when he cancelled), as a code.
  callback_error text constraint drive_oauth_states_error_check
    check (callback_error is null or callback_error ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  returned_at timestamptz,
  constraint drive_oauth_states_returned_check check (
    (returned_at is null and code_sealed is null and callback_error is null)
    or (returned_at is not null and ((code_sealed is null) <> (callback_error is null)))
  )
);

create unique index drive_oauth_states_hash_key on public.drive_oauth_states (state_hash);
create index drive_oauth_states_user_idx on public.drive_oauth_states (user_id, created_at);
create index drive_oauth_states_expiry_idx on public.drive_oauth_states (expires_at);

comment on table public.drive_oauth_states is
  'Milestone 5 part 3a. One row per press of Connect: who pressed it, the hash of the state sent to Google, the PKCE verifier and (after the callback) Google''s code, both sealed. Single-use: the callback may return to it once, and finish takes it — deleting it — once, and only as the same signed-in person. RLS forced; the one policy is false.';

alter table public.drive_oauth_states enable row level security;
alter table public.drive_oauth_states force row level security;

revoke all on public.drive_oauth_states from anon, authenticated;
grant select on public.drive_oauth_states to authenticated;
grant all on public.drive_oauth_states to service_role;

create policy drive_oauth_states_no_browser_read on public.drive_oauth_states
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------------------
-- (4) drive_reads — the server's record of each file it fetched from Drive
-- ---------------------------------------------------------------------------------------

create table public.drive_reads (
  -- The browser's id for one request to read a file. Never reused: a second try is a new row.
  id uuid primary key,
  -- Dies with the connection: after a disconnect nothing fetched under it can be attached.
  user_id uuid not null references public.drive_connections (user_id) on delete cascade,
  drive_file_id text not null constraint drive_reads_file_check
    check (drive_file_id ~ '^[A-Za-z0-9_-]{8,200}$'),
  -- started: asked, no answer yet. fetched: bytes were handed to the browser.
  -- refused: Drive, or the reader, refused the file, for the reason in `outcome`.
  -- failed: Google did not answer usefully; may be tried again.
  status text not null default 'started' constraint drive_reads_status_check
    check (status in ('started', 'fetched', 'refused', 'failed')),
  -- A reason code from src/lib/drive/limits.ts. Never a sentence, never file content.
  outcome text constraint drive_reads_outcome_check
    check (outcome is null or outcome ~ '^[a-z_]{1,48}$'),
  -- The file's name in Drive at the moment it was read, cleaned. Taken by `begin` as the
  -- attachment's name. Never logged.
  name text constraint drive_reads_name_check
    check (name is null or char_length(name) between 1 and 200),
  -- What Drive called the file, and what it was exported as (null for a file that was
  -- downloaded as it is).
  google_mime text constraint drive_reads_google_mime_check
    check (google_mime is null or char_length(google_mime) <= 160),
  exported_as text constraint drive_reads_exported_check
    check (exported_as is null or char_length(exported_as) <= 160),
  byte_size bigint constraint drive_reads_byte_size_check
    check (byte_size is null or byte_size >= 0),
  content_hash text constraint drive_reads_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  -- When Drive says the file last changed. Shown nowhere yet; kept for "why did it differ".
  modified_at timestamptz,
  duration_ms integer,
  created_at timestamptz not null default now(),
  fetched_at timestamptz,
  constraint drive_reads_fetched_check
    check (status <> 'fetched'
      or (name is not null and byte_size is not null and content_hash is not null
          and fetched_at is not null))
);

create index drive_reads_user_idx on public.drive_reads (user_id, created_at);
create index drive_reads_created_idx on public.drive_reads (created_at);

comment on table public.drive_reads is
  'Milestone 5 part 3a. One row per file a person asked to have read from their Google Drive: which file, its type, what it was exported as, the size and SHA-256 of what was handed to the browser, how it ended. No content. begin_conversation_file attaches against it. Deleted with the connection, and after a day by purge_conversation_files. RLS forced; the one policy is false.';

alter table public.drive_reads enable row level security;
alter table public.drive_reads force row level security;

revoke all on public.drive_reads from anon, authenticated;
grant select on public.drive_reads to authenticated;
grant all on public.drive_reads to service_role;

create policy drive_reads_no_browser_read on public.drive_reads
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------------------
-- (5) The connection attempt: create, return (the callback), take (finish)
-- ---------------------------------------------------------------------------------------

-- Raises DV001 when the person already has `p_max_open` attempts open: a loop pressing
-- Connect must not fill a table.
create or replace function public.create_drive_oauth_state(
  p_user_id uuid,
  p_state_hash text,
  p_verifier_sealed text,
  p_ttl_seconds integer,
  p_max_open integer
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_open integer;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('drive_oauth:' || p_user_id::text, 0));
  delete from public.drive_oauth_states s
  where s.user_id = p_user_id and s.expires_at <= clock_timestamp();
  select count(*) into v_open
  from public.drive_oauth_states s
  where s.user_id = p_user_id;
  if v_open >= p_max_open then
    raise exception 'user % has % connection attempts open', p_user_id, v_open
      using errcode = 'DV001';
  end if;
  insert into public.drive_oauth_states (state_hash, user_id, verifier_sealed, expires_at)
  values (p_state_hash, p_user_id, p_verifier_sealed,
          clock_timestamp() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.create_drive_oauth_state(uuid, text, text, integer, integer) is
  'Milestone 5 part 3a. Records one press of Connect (the state''s hash and the sealed PKCE verifier) for p_ttl_seconds. Raises DV001 past p_max_open open attempts per person. service_role only.';

-- The callback. ONCE per state, and only while it is fresh: a second arrival of the same
-- callback, a replayed one or an invented one finds nothing and changes nothing. Exactly one
-- of p_code_sealed / p_error is given.
create or replace function public.return_drive_oauth_state(
  p_state_hash text,
  p_code_sealed text,
  p_error text
)
returns table (id uuid, user_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    update public.drive_oauth_states s
    set returned_at = clock_timestamp(),
        code_sealed = p_code_sealed,
        callback_error = case when p_code_sealed is null then coalesce(p_error, 'no_code') else null end
    where s.state_hash = p_state_hash
      and s.returned_at is null
      and s.expires_at > clock_timestamp()
    returning s.id, s.user_id;
end;
$$;

comment on function public.return_drive_oauth_state(text, text, text) is
  'Milestone 5 part 3a. The OAuth callback: holds Google''s sealed code (or its error) against a fresh state that has not returned before. Zero rows for anything else — replayed, doubled, expired or unknown. service_role only.';

-- Finish. The attempt is TAKEN — deleted — whatever the outcome, so it can be finished once.
-- Only `ok` hands back what is needed to exchange the code; a different signed-in person gets
-- `wrong_user` and nothing else, and the code dies unexchanged (D123).
create or replace function public.take_drive_oauth_state(
  p_id uuid,
  p_user_id uuid
)
returns table (
  outcome text,
  state_hash text,
  verifier_sealed text,
  code_sealed text,
  callback_error text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.drive_oauth_states%rowtype;
begin
  delete from public.drive_oauth_states s where s.id = p_id returning * into v_row;
  if not found then
    return query select 'missing'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_row.user_id <> p_user_id then
    return query select 'wrong_user'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_row.expires_at <= clock_timestamp() then
    return query select 'expired'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_row.returned_at is null then
    return query select 'not_returned'::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_row.callback_error is not null then
    return query select 'declined'::text, null::text, null::text, null::text, v_row.callback_error;
    return;
  end if;
  return query select 'ok'::text, v_row.state_hash, v_row.verifier_sealed, v_row.code_sealed, null::text;
end;
$$;

comment on function public.take_drive_oauth_state(uuid, uuid) is
  'Milestone 5 part 3a. Takes (deletes) one connection attempt and says how it stands: ok (with the sealed verifier and code), wrong_user, expired, not_returned, declined (with Google''s error code) or missing. Only ok returns anything sealed. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (6) The connection: save, mark broken, delete
-- ---------------------------------------------------------------------------------------

-- Saves a new token for this person. `p_expected_token_id` is the token the caller saw (null =
-- it saw none): if the row has changed since — another Connect finished in between — nothing
-- is written and DV002 is raised, so the caller can undo its own token at Google rather than
-- leave a grant with no row behind it. Revoking the PREVIOUS account's token is the caller's
-- job and happens before this (D125); this function only records the outcome.
create or replace function public.save_drive_connection(
  p_user_id uuid,
  p_expected_token_id uuid,
  p_token_id uuid,
  p_account_id text,
  p_email text,
  p_refresh_sealed text,
  p_scope text
)
returns table (replaced boolean, same_account boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.drive_connections%rowtype;
  v_found boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('drive_connection:' || p_user_id::text, 0));
  select * into v_row from public.drive_connections c where c.user_id = p_user_id for update;
  v_found := found;
  if (v_found and v_row.token_id is distinct from p_expected_token_id)
     or (not v_found and p_expected_token_id is not null) then
    raise exception 'drive connection of % changed', p_user_id using errcode = 'DV002';
  end if;

  if v_found then
    update public.drive_connections c
    set token_id = p_token_id,
        google_account_id = p_account_id,
        google_email = p_email,
        refresh_token_sealed = p_refresh_sealed,
        granted_scope = p_scope,
        status = 'active',
        broken_reason = null,
        broken_at = null,
        connected_at = clock_timestamp(),
        last_used_at = null
    where c.user_id = p_user_id;
  else
    insert into public.drive_connections
      (user_id, token_id, google_account_id, google_email, refresh_token_sealed, granted_scope)
    values (p_user_id, p_token_id, p_account_id, p_email, p_refresh_sealed, p_scope);
  end if;

  -- Ids and booleans. Never the address, never anything sealed.
  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values (
    p_user_id::text, 'DRIVE_CONNECTED', 'drive_connections', p_user_id,
    jsonb_build_object(
      'replaced', v_found,
      'same_account', v_found and v_row.google_account_id = p_account_id
    )
  );

  return query select v_found, v_found and v_row.google_account_id = p_account_id;
end;
$$;

comment on function public.save_drive_connection(uuid, uuid, uuid, text, text, text, text) is
  'Milestone 5 part 3a. Records a new sealed refresh token for one person, replacing any earlier one, under a per-person lock. Raises DV002 when the row is not the one the caller saw. Audited without the address. service_role only.';

-- Google stopped honouring THIS token. False when the row now holds a different token (a new
-- Connect happened meanwhile) or no row exists.
create or replace function public.mark_drive_connection_broken(
  p_user_id uuid,
  p_token_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.drive_connections c
  set status = 'broken',
      broken_reason = p_reason,
      broken_at = clock_timestamp()
  where c.user_id = p_user_id and c.token_id = p_token_id and c.status = 'active';
  if not found then
    return false;
  end if;
  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values ('system', 'DRIVE_BROKEN', 'drive_connections', p_user_id,
          jsonb_build_object('reason', p_reason));
  return true;
end;
$$;

comment on function public.mark_drive_connection_broken(uuid, uuid, text) is
  'Milestone 5 part 3a. Marks one person''s connection broken (Google refused the token) with a reason code — only if it still holds that token. Audited. service_role only.';

-- Called only after Google confirmed the revocation (or said the grant was already gone):
-- a row deleted while Google still holds a live grant would be a lie (the brief). False when
-- the row now holds a different token.
create or replace function public.delete_drive_connection(
  p_user_id uuid,
  p_token_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.drive_connections c
  where c.user_id = p_user_id and c.token_id = p_token_id;
  if not found then
    return false;
  end if;
  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values (p_user_id::text, 'DRIVE_DISCONNECTED', 'drive_connections', p_user_id,
          jsonb_build_object('revoked_at_google', true));
  return true;
end;
$$;

comment on function public.delete_drive_connection(uuid, uuid) is
  'Milestone 5 part 3a. Deletes one person''s connection after Google confirmed the revocation — only if it still holds that token. Its read records go with it (cascade). Audited. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (7) A read: claim, complete
-- ---------------------------------------------------------------------------------------

-- ONE ID READS ONE FILE, ONCE (part 2's rule for pages, for the same reason): a repeated id
-- claims nothing and is answered `existing`. Raises DR001 past p_per_minute reads per person
-- per minute, and 23503 (foreign key) when the person has no connection.
create or replace function public.claim_drive_read(
  p_id uuid,
  p_user_id uuid,
  p_drive_file_id text,
  p_per_minute integer
)
returns table (claimed boolean, existing boolean)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_recent integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('drive_read_user:' || p_user_id::text, 0));
  if exists (select 1 from public.drive_reads r where r.id = p_id) then
    return query select false, true;
    return;
  end if;
  select count(*) into v_recent
  from public.drive_reads r
  where r.user_id = p_user_id
    and r.created_at > clock_timestamp() - interval '1 minute';
  if v_recent >= p_per_minute then
    raise exception 'user % has read % Drive files in the last minute', p_user_id, v_recent
      using errcode = 'DR001';
  end if;
  insert into public.drive_reads (id, user_id, drive_file_id, created_at)
  values (p_id, p_user_id, p_drive_file_id, clock_timestamp());
  update public.drive_connections c set last_used_at = clock_timestamp()
  where c.user_id = p_user_id;
  return query select true, false;
end;
$$;

comment on function public.claim_drive_read(uuid, uuid, text, integer) is
  'Milestone 5 part 3a. Claims one Drive read under a per-person lock: one id reads one file, once (existing = true for a repeat), DR001 past the per-minute limit, a foreign-key error when there is no connection. service_role only.';

-- How a read ended. Fields passed as null are left as they were. False when the record is not
-- this person's (or does not exist — the connection may have gone meanwhile).
create or replace function public.complete_drive_read(
  p_id uuid,
  p_user_id uuid,
  p_status text,
  p_outcome text,
  p_name text,
  p_google_mime text,
  p_exported_as text,
  p_byte_size bigint,
  p_content_hash text,
  p_modified_at timestamptz,
  p_duration_ms integer
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.drive_reads r
  set status = p_status,
      outcome = p_outcome,
      name = coalesce(p_name, r.name),
      google_mime = coalesce(p_google_mime, r.google_mime),
      exported_as = coalesce(p_exported_as, r.exported_as),
      byte_size = coalesce(p_byte_size, r.byte_size),
      content_hash = coalesce(p_content_hash, r.content_hash),
      modified_at = coalesce(p_modified_at, r.modified_at),
      duration_ms = coalesce(p_duration_ms, r.duration_ms),
      fetched_at = case when p_status = 'fetched' then clock_timestamp() else r.fetched_at end
  where r.id = p_id and r.user_id = p_user_id;
  return found;
end;
$$;

comment on function public.complete_drive_read(uuid, uuid, text, text, text, text, text, bigint, text, timestamptz, integer) is
  'Milestone 5 part 3a. Records how a Drive read ended: fetched (name, type, size, hash), refused or failed with a reason code. Scoped to the person who asked. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (8) begin_conversation_file — now also for a file read from Drive
--
-- As 20261012020000 wrote it, plus `p_drive_read_id`. When given, the attachment is checked
-- against the server's record of that read — this person's, fetched, recent, still under a
-- live connection (the record is gone otherwise), and the SAME BYTES — and takes its Drive
-- file, address and time from it. Anything else is FL007. A file the same as one already
-- attached is still "attached once": for a Drive file read again unchanged, that copy's time
-- moves forward and it takes the file's current name (it may have been renamed in Drive).
-- ---------------------------------------------------------------------------------------

drop function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid);

create or replace function public.begin_conversation_file(
  p_conversation_id uuid,
  p_uploaded_by uuid,
  p_request_id uuid,
  p_name text,
  p_kind text,
  p_byte_size bigint,
  p_content_hash text,
  p_expected_pages integer,
  p_vision_pages integer,
  p_retention_days integer,
  p_max_files integer,
  p_abandoned_minutes integer,
  p_fetch_id uuid default null,
  p_drive_read_id uuid default null
)
returns table (
  id uuid,
  status text,
  existing boolean,
  duplicate boolean,
  expected_pages integer,
  pages_stored integer[]
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_conversation public.conversations%rowtype;
  v_file public.conversation_files%rowtype;
  v_fetch public.web_fetches%rowtype;
  v_read public.drive_reads%rowtype;
  v_live integer;
  v_source_url text;
  v_source_host text;
  v_fetched_at timestamptz;
  v_drive_file_id text;
begin
  if p_fetch_id is not null and p_drive_read_id is not null then
    raise exception 'one source at a time' using errcode = 'FL007';
  end if;

  select * into v_conversation
  from public.conversations c
  where c.id = p_conversation_id
  for update;
  if not found or v_conversation.deleted_at is not null then
    raise exception 'conversation % does not exist', p_conversation_id using errcode = '02000';
  end if;

  -- The same gesture, sent again.
  select * into v_file from public.conversation_files f where f.request_id = p_request_id;
  if found then
    return query
      select v_file.id, v_file.status, true, false, v_file.expected_pages,
             coalesce((select array_agg(p.page_no order by p.page_no)
                       from public.conversation_file_pages p where p.file_id = v_file.id),
                      '{}'::integer[]);
    return;
  end if;

  if p_fetch_id is not null then
    -- From a link: only against the server's own record of having fetched exactly these bytes.
    select * into v_fetch from public.web_fetches w where w.id = p_fetch_id for update;
    if not found
       or v_fetch.user_id <> p_uploaded_by
       or v_fetch.status <> 'fetched'
       or v_fetch.fetched_at < now() - make_interval(mins => p_abandoned_minutes)
       or v_fetch.content_hash is distinct from p_content_hash
       or v_fetch.byte_size is distinct from p_byte_size
    then
      raise exception 'fetch % cannot be attached', p_fetch_id using errcode = 'FL007';
    end if;
    v_source_url := v_fetch.final_url;
    v_source_host := v_fetch.final_host;
    v_fetched_at := v_fetch.fetched_at;
  elsif p_drive_read_id is not null then
    -- From Drive: the same, against the record of the read. A web page never comes from Drive.
    select * into v_read from public.drive_reads r where r.id = p_drive_read_id for update;
    if not found
       or v_read.user_id <> p_uploaded_by
       or v_read.status <> 'fetched'
       or v_read.fetched_at < now() - make_interval(mins => p_abandoned_minutes)
       or v_read.content_hash is distinct from p_content_hash
       or v_read.byte_size is distinct from p_byte_size
       or p_kind = 'html'
    then
      raise exception 'drive read % cannot be attached', p_drive_read_id using errcode = 'FL007';
    end if;
    v_drive_file_id := v_read.drive_file_id;
    v_source_url := 'https://drive.google.com/file/d/' || v_read.drive_file_id || '/view';
    v_source_host := 'drive.google.com';
    v_fetched_at := v_read.fetched_at;
  elsif p_kind = 'html' then
    -- A web page with no fetch behind it does not exist.
    raise exception 'an html file needs a fetch' using errcode = 'FL007';
  end if;

  -- The same file, already attached and ready.
  select * into v_file
  from public.conversation_files f
  where f.conversation_id = p_conversation_id
    and f.content_hash = p_content_hash
    and f.status = 'ready';
  if found then
    if v_fetched_at is not null and v_file.source_url is not null then
      -- Asked again, and the same bytes came back: this copy is current as of now.
      update public.conversation_files f
      set fetched_at = v_fetched_at,
          expires_at = now() + make_interval(days => p_retention_days),
          name = case
            when v_drive_file_id is not null and f.drive_file_id = v_drive_file_id
              then v_read.name
            else f.name
          end
      where f.id = v_file.id;
    end if;
    return query select v_file.id, v_file.status, true, true, v_file.expected_pages, '{}'::integer[];
    return;
  end if;

  -- Uploads that never finished. This person's earlier attempt at the same file is one by
  -- definition (their browser sends one file at a time); anyone's older than the cut-off is.
  delete from public.conversation_files f
  where f.conversation_id = p_conversation_id
    and f.status = 'reading'
    and (
      (f.uploaded_by = p_uploaded_by and f.content_hash = p_content_hash)
      or f.created_at < now() - make_interval(mins => p_abandoned_minutes)
    );

  select count(*) into v_live
  from public.conversation_files f
  where f.conversation_id = p_conversation_id and f.status in ('reading', 'ready');
  if v_live >= p_max_files then
    raise exception 'conversation % already holds % files', p_conversation_id, v_live
      using errcode = 'FL001';
  end if;

  insert into public.conversation_files
    (conversation_id, user_id, scope, uploaded_by, request_id, name, kind, byte_size,
     content_hash, expected_pages, vision_pages, expires_at,
     source_url, source_host, fetched_at, drive_file_id)
  values
    (p_conversation_id, v_conversation.user_id, v_conversation.scope, p_uploaded_by,
     p_request_id,
     -- A Drive file is named as Drive named it when it was read, never as the browser says.
     case when v_drive_file_id is null then p_name else v_read.name end,
     p_kind, p_byte_size, p_content_hash, p_expected_pages,
     p_vision_pages, now() + make_interval(days => p_retention_days),
     v_source_url, v_source_host, v_fetched_at, v_drive_file_id)
  returning * into v_file;

  return query select v_file.id, v_file.status, false, false, v_file.expected_pages, '{}'::integer[];
end;
$$;

comment on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid, uuid) is
  'Milestone 5 parts 1, 2 and 3a. Claims an upload under a lock on its conversation: idempotent on request_id, returns the ready row for the same content, deletes abandoned attempts, refuses past the per-conversation limit (FL001). With p_fetch_id (a page) or p_drive_read_id (a Drive file) the attachment must match the server''s record of that read (FL007) and takes its source, time — and for Drive its name — from it. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (9) finish_conversation_file — the audit row says when a file came from Drive
--
-- As 20261012020000 wrote it; the one change is `source` in the audit row. The replacing of an
-- older read of the same address now also replaces an older read of the same Drive file,
-- because a Drive file has one address (section 1).
-- ---------------------------------------------------------------------------------------

create or replace function public.finish_conversation_file(
  p_file_id uuid,
  p_actor uuid,
  p_max_chars integer,
  p_gap_mark text default null,
  p_sent_mark text default null
)
returns table (
  id uuid,
  duplicate boolean,
  already boolean,
  page_count integer,
  char_count integer,
  vision_pages integer,
  confidence numeric,
  replaced integer
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_file public.conversation_files%rowtype;
  v_other public.conversation_files%rowtype;
  v_pages integer;
  v_chars integer;
  v_letters integer;
  v_vision integer;
  v_confidence numeric;
  v_missing integer := 0;
  v_sent boolean := false;
  v_replaced integer := 0;
  v_old uuid;
begin
  select * into v_file from public.conversation_files f where f.id = p_file_id for update;
  if not found then
    raise exception 'file % does not exist', p_file_id using errcode = '02000';
  end if;
  if v_file.status = 'ready' then
    return query select v_file.id, false, true, v_file.page_count, v_file.char_count,
                        v_file.vision_pages, v_file.confidence, 0;
    return;
  end if;
  if v_file.status <> 'reading' then
    raise exception 'file % was removed', p_file_id using errcode = 'FL002';
  end if;

  select count(*),
         coalesce(sum(char_length(p.content)), 0),
         coalesce(sum(p.letter_count), 0),
         count(*) filter (where p.extraction_method = 'claude_vision'),
         min(p.confidence)
    into v_pages, v_chars, v_letters, v_vision, v_confidence
  from public.conversation_file_pages p
  where p.file_id = p_file_id;

  if v_pages <> v_file.expected_pages then
    raise exception 'file % has % of % pages', p_file_id, v_pages, v_file.expected_pages
      using errcode = 'FL004';
  end if;
  if v_letters = 0 then
    raise exception 'file % has no readable text', p_file_id using errcode = 'FL005';
  end if;
  if v_chars > p_max_chars then
    raise exception 'file % is % characters', p_file_id, v_chars using errcode = 'FL006';
  end if;

  if p_gap_mark is not null and char_length(p_gap_mark) > 0 then
    select coalesce(sum(
             (char_length(p.content) - char_length(replace(p.content, p_gap_mark, '')))
             / char_length(p_gap_mark)), 0)::integer
      into v_missing
    from public.conversation_file_pages p
    where p.file_id = p_file_id;
  end if;

  if p_sent_mark is not null and char_length(p_sent_mark) > 0 then
    select exists (
      select 1 from public.conversation_file_pages p
      where p.file_id = p_file_id and position(p_sent_mark in p.content) > 0
    ) into v_sent;
  end if;

  -- Somebody else attached the same file while this one was being read.
  select * into v_other
  from public.conversation_files f
  where f.conversation_id = v_file.conversation_id
    and f.content_hash = v_file.content_hash
    and f.status = 'ready';
  if found then
    if v_file.fetched_at is not null and v_other.source_url is not null then
      update public.conversation_files f
      set fetched_at = greatest(f.fetched_at, v_file.fetched_at)
      where f.id = v_other.id;
    end if;
    delete from public.conversation_files f where f.id = p_file_id;
    return query select v_other.id, true, true, v_other.page_count, v_other.char_count,
                        v_other.vision_pages, v_other.confidence, 0;
    return;
  end if;

  update public.conversation_files f
  set status = 'ready',
      ready_at = now(),
      page_count = v_pages,
      char_count = v_chars,
      vision_pages = v_vision,
      confidence = v_confidence,
      values_missing = v_missing,
      read_as_sent = v_sent
  where f.id = p_file_id;

  -- An older read of the same address (a page, or a Drive file), in this conversation, goes
  -- now: two copies of one document must never sit in front of the model saying different
  -- things.
  if v_file.source_url is not null then
    for v_old in
      select f.id from public.conversation_files f
      where f.conversation_id = v_file.conversation_id
        and f.source_url = v_file.source_url
        and f.status = 'ready'
        and f.id <> p_file_id
    loop
      if public.remove_conversation_file(v_old, p_actor, 'replaced') then
        v_replaced := v_replaced + 1;
      end if;
    end loop;
  end if;

  -- Ids, a kind and counts. Never the name, never the address, never a word of the content.
  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values (
    p_actor::text, 'FILE_ATTACHED', 'conversation_files', p_file_id,
    jsonb_build_object(
      'conversation_id', v_file.conversation_id,
      'kind', v_file.kind,
      'byte_size', v_file.byte_size,
      'page_count', v_pages,
      'char_count', v_chars,
      'vision_pages', v_vision,
      'source', case
        when v_file.drive_file_id is not null then 'drive'
        when v_file.source_url is null then 'upload'
        else 'link'
      end,
      'values_missing', v_missing,
      'read_as_sent', v_sent,
      'replaced', v_replaced
    )
  );

  return query select p_file_id, false, false, v_pages, v_chars, v_vision, v_confidence, v_replaced;
end;
$$;

comment on function public.finish_conversation_file(uuid, uuid, integer, text, text) is
  'Milestone 5 parts 1, 2 and 3a. Marks a file ready only when every declared page is stored, in one transaction with its audit row (ids and counts only; source upload / link / drive). Counts the reader''s marks, and removes an older read of the same address — a page or a Drive file — in the same conversation. Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (10) remove_conversation_file — a removed row forgets its Drive file as well
-- ---------------------------------------------------------------------------------------

create or replace function public.remove_conversation_file(
  p_file_id uuid,
  p_actor uuid,
  p_reason text
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_file public.conversation_files%rowtype;
begin
  select * into v_file from public.conversation_files f where f.id = p_file_id for update;
  if not found or v_file.status = 'removed' then
    return false;
  end if;
  if v_file.status = 'reading' then
    delete from public.conversation_files f where f.id = p_file_id;
    return true;
  end if;

  delete from public.conversation_file_pages p where p.file_id = p_file_id;
  update public.conversation_files f
  set status = 'removed',
      name = null,
      content_hash = null,
      source_url = null,
      source_host = null,
      fetched_at = null,
      drive_file_id = null,
      removed_at = now(),
      removed_by = p_actor,
      removed_reason = p_reason
  where f.id = p_file_id;

  insert into public.audit_log (actor, action, entity_type, entity_id, before)
  values (
    coalesce(p_actor::text, 'system'),
    case p_reason
      when 'expired' then 'FILE_EXPIRED'
      when 'replaced' then 'FILE_REPLACED'
      else 'FILE_REMOVED'
    end,
    'conversation_files', p_file_id,
    jsonb_build_object(
      'conversation_id', v_file.conversation_id,
      'kind', v_file.kind,
      'byte_size', v_file.byte_size,
      'page_count', v_file.page_count
    )
  );
  return true;
end;
$$;

comment on function public.remove_conversation_file(uuid, uuid, text) is
  'Milestone 5 parts 1, 2 and 3a. Deletes an unfinished upload outright; turns a ready file into a tombstone with no text, name, hash, address or Drive file, and audits it (removed, expired or replaced). Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (11) purge_conversation_files — the same job clears Drive read records and stale attempts
-- ---------------------------------------------------------------------------------------

create or replace function public.purge_conversation_files(
  p_abandoned_minutes integer default 15
)
returns table (abandoned integer, expired integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_abandoned integer := 0;
  v_expired integer := 0;
  v_id uuid;
begin
  delete from public.conversation_files f
  where f.status = 'reading'
    and f.created_at < now() - make_interval(mins => p_abandoned_minutes);
  get diagnostics v_abandoned = row_count;

  for v_id in
    select f.id from public.conversation_files f
    where f.status = 'ready' and f.expires_at <= now()
    order by f.expires_at
  loop
    if public.remove_conversation_file(v_id, null, 'expired') then
      v_expired := v_expired + 1;
    end if;
  end loop;

  delete from public.web_fetches w where w.created_at < now() - interval '1 day';
  delete from public.drive_reads r where r.created_at < now() - interval '1 day';
  -- The same clock the attempt was stamped with (create_drive_oauth_state).
  delete from public.drive_oauth_states s where s.expires_at <= clock_timestamp();

  return query select v_abandoned, v_expired;
end;
$$;

comment on function public.purge_conversation_files(integer) is
  'Milestone 5 parts 1, 2 and 3a (D85, D95, D121). Deletes abandoned uploads, tombstones files past their expiry, and deletes page-fetch and Drive-read records older than a day and connection attempts past their ten minutes. Scheduled daily by pg_cron (job purge-conversation-files). service_role only.';

-- ---------------------------------------------------------------------------------------
-- (12) Who may call what
-- ---------------------------------------------------------------------------------------

revoke all on function public.create_drive_oauth_state(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.return_drive_oauth_state(text, text, text) from public, anon, authenticated;
revoke all on function public.take_drive_oauth_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_drive_connection(uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.mark_drive_connection_broken(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.delete_drive_connection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_drive_read(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_drive_read(uuid, uuid, text, text, text, text, text, bigint, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_conversation_file(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.remove_conversation_file(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.purge_conversation_files(integer) from public, anon, authenticated;

grant execute on function public.create_drive_oauth_state(uuid, text, text, integer, integer) to service_role;
grant execute on function public.return_drive_oauth_state(text, text, text) to service_role;
grant execute on function public.take_drive_oauth_state(uuid, uuid) to service_role;
grant execute on function public.save_drive_connection(uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.mark_drive_connection_broken(uuid, uuid, text) to service_role;
grant execute on function public.delete_drive_connection(uuid, uuid) to service_role;
grant execute on function public.claim_drive_read(uuid, uuid, text, integer) to service_role;
grant execute on function public.complete_drive_read(uuid, uuid, text, text, text, text, text, bigint, text, timestamptz, integer) to service_role;
grant execute on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid, uuid) to service_role;
grant execute on function public.finish_conversation_file(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.remove_conversation_file(uuid, uuid, text) to service_role;
grant execute on function public.purge_conversation_files(integer) to service_role;
