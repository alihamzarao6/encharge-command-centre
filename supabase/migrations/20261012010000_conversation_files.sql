-- Milestone 5 part 1 — reading files and documents (docs/MEMORY.md 12 Oct 2026, D83–D92).
--
-- What this stores, and what it deliberately does not.
--
--   * The ORIGINAL FILE is never stored: not here, not in a bucket, not anywhere. Extraction
--     runs in the browser (D84), so for typed formats the bytes never leave the device, and
--     for a photo or a scanned page one image passes through the Edge Function's memory to
--     the model and is dropped. There is no Storage bucket in this migration and therefore no
--     object URL that could be guessed.
--   * What IS stored is the extracted TEXT, page by page, plus the file's name, size, kind and
--     a SHA-256 of the original (so the same file sent twice is recognised). That is what
--     "answering from the file" needs and nothing else is kept.
--
-- Two tables, split on who may read them:
--
--   conversation_files       one row per attached file. Readable by whoever can read the
--                            conversation it belongs to (D86): the same `scope` / `user_id`
--                            column check `messages` uses, kept equal to the parent by the
--                            same parent-sync trigger, so making a conversation private makes
--                            its files private in the same statement.
--   conversation_file_pages  the text. RLS is on and forced and there is NO policy: no browser
--                            session can read a page through the Data API, whoever it belongs
--                            to. Only the server reads it (service_role), to put it in front
--                            of the model. The interface never needs the text — it shows the
--                            name, the size and the page count — so the text has no client
--                            read path to get wrong.
--
-- Provenance (CLAUDE.md rule 12) is on every page row and NOT NULL: the source is the upload
-- itself (`file_id` → the file's hash, uploader and time; there is no URL), `extracted_at`,
-- `extraction_method`, `confidence`. A parse is exact (1.00); a transcription by vision is
-- only as good as the page was legible, and says which (`legibility`).
--
-- Retention (D85): 30 days from upload, then `purge_conversation_files` — scheduled daily by
-- pg_cron below — destroys the text and leaves a tombstone with no name and no hash. Sooner
-- when a person removes the file; at once, and completely, when the conversation is deleted;
-- and an upload that never finished is deleted after 15 minutes. `messages.document_context`
-- marks the turns that were answered with a file in front of the model, so the shared-memory
-- summariser can leave them out (D89).
--
-- Every write is a function executable by service_role only. The browser holds SELECT on the
-- file rows and nothing else, as on every other table (20260824010500_rls.sql).
--
-- Reversible:
--   select cron.unschedule('purge-conversation-files');
--   drop trigger conversations_purge_files on public.conversations;
--   drop trigger conversations_cascade_files_ownership on public.conversations;
--   drop function public.purge_files_of_deleted_conversation();
--   drop function public.cascade_conversation_files_ownership();
--   drop function public.purge_conversation_files(integer);
--   drop function public.remove_conversation_file(uuid, uuid, text);
--   drop function public.finish_conversation_file(uuid, uuid, integer);
--   drop function public.append_conversation_file_pages(uuid, jsonb);
--   drop function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer);
--   drop table public.conversation_file_pages;
--   drop table public.conversation_files;
--   alter table public.messages drop column document_context;
--   (pg_cron itself is left installed: other jobs may come to depend on it.)

-- ---------------------------------------------------------------------------------------
-- (1) The turn flag the summariser reads
-- ---------------------------------------------------------------------------------------

alter table public.messages
  add column document_context boolean not null default false;

comment on column public.messages.document_context is
  'True on both rows of a turn that was answered with an attached file in front of the model (Milestone 5 part 1, D89). The shared-memory summariser replaces such a message with a placeholder, so a figure read off somebody''s payslip never reaches workspace memory.';

-- ---------------------------------------------------------------------------------------
-- (2) Tables
-- ---------------------------------------------------------------------------------------

create table public.conversation_files (
  id uuid primary key default gen_random_uuid(),
  -- Cascade, unlike the memory tables: document text must never outlive its conversation.
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- The CONVERSATION's author and scope, denormalised so the RLS policy is a column check,
  -- not a join — exactly as on `messages`, and kept equal to the parent by the same trigger.
  user_id uuid not null references auth.users (id),
  scope text not null constraint conversation_files_scope_check check (scope in ('user', 'workspace')),
  -- Who attached it. May differ from user_id in a shared conversation.
  uploaded_by uuid not null references auth.users (id),
  -- One per upload gesture: a retried `begin` returns the row instead of making a second.
  request_id uuid not null,
  -- A display label, already sanitised by the server. Gone when the file is.
  name text constraint conversation_files_name_length check (char_length(name) between 1 and 200),
  kind text not null constraint conversation_files_kind_check
    check (kind in ('pdf', 'docx', 'xlsx', 'csv', 'text', 'image')),
  -- Size of the ORIGINAL, as the browser measured it. Shown to the person; never trusted.
  byte_size bigint not null constraint conversation_files_byte_size_check
    check (byte_size between 1 and 104857600),
  -- SHA-256 of the original, hex. Recognises the same file sent twice. Gone when the file is.
  content_hash text constraint conversation_files_hash_format check (content_hash ~ '^[0-9a-f]{64}$'),
  -- What the browser said it would send: the pages that must be stored before `finish`.
  expected_pages integer not null constraint conversation_files_expected_pages_check
    check (expected_pages between 1 and 2000),
  vision_pages integer not null default 0,
  page_count integer not null default 0,
  char_count integer not null default 0,
  -- The lowest page confidence, set when the file becomes ready.
  confidence numeric(3, 2) constraint conversation_files_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  -- reading: pages still arriving, invisible to every session and to the model.
  -- ready:   complete, and what a turn loads.
  -- removed: a tombstone — the text, the name and the hash are gone.
  status text not null default 'reading' constraint conversation_files_status_check
    check (status in ('reading', 'ready', 'removed')),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  expires_at timestamptz not null,
  removed_at timestamptz,
  removed_by uuid references auth.users (id),
  removed_reason text constraint conversation_files_removed_reason_check
    check (removed_reason is null or removed_reason in ('user', 'expired')),
  constraint conversation_files_vision_pages_check
    check (vision_pages between 0 and expected_pages),
  -- The tombstone guarantee, held by the database: a removed row names nothing.
  constraint conversation_files_tombstone_check
    check (
      (status = 'removed' and name is null and content_hash is null and removed_at is not null)
      or (status <> 'removed' and name is not null and content_hash is not null)
    )
);

create unique index conversation_files_request_id_key on public.conversation_files (request_id);
-- The same file, attached and ready, once per conversation. Not over `reading`: an
-- interrupted upload must not block the retry that replaces it.
create unique index conversation_files_ready_hash_key
  on public.conversation_files (conversation_id, content_hash)
  where status = 'ready';
create index conversation_files_conversation_idx
  on public.conversation_files (conversation_id, created_at);
create index conversation_files_expiry_idx
  on public.conversation_files (expires_at) where status = 'ready';
create index conversation_files_reading_idx
  on public.conversation_files (created_at) where status = 'reading';
create index conversation_files_user_id_idx on public.conversation_files (user_id);

comment on table public.conversation_files is
  'One row per file attached to a conversation (Milestone 5 part 1). The original bytes are never stored anywhere; the extracted text is in conversation_file_pages. Visible to whoever can read the conversation; written only by the files Edge Function through the functions below.';

create table public.conversation_file_pages (
  file_id uuid not null references public.conversation_files (id) on delete cascade,
  -- Storage position, 1..N in document order. The LABEL carries the document's own name for
  -- the page ("Page 7", Sheet "Rates"), so this never has to be shown to anyone.
  page_no integer not null constraint conversation_file_pages_page_no_check check (page_no >= 1),
  label text not null constraint conversation_file_pages_label_length
    check (char_length(label) between 1 and 300),
  content text not null constraint conversation_file_pages_content_length
    check (char_length(content) <= 64000),
  -- Provenance (rule 12). `claude_vision` is written by the server only.
  extraction_method text not null constraint conversation_file_pages_method_check
    check (extraction_method in
      ('pdf_text_layer', 'claude_vision', 'docx_xml', 'xlsx_xml', 'csv_parse', 'plain_text')),
  confidence numeric(3, 2) not null constraint conversation_file_pages_confidence_check
    check (confidence >= 0 and confidence <= 1),
  legibility text not null default 'full' constraint conversation_file_pages_legibility_check
    check (legibility in ('full', 'partial', 'none')),
  -- Letters and digits of any script, counted by the server when it stores the page. What
  -- "is there anything readable here" is decided on; never Postgres' own idea of a letter,
  -- which depends on the database's locale.
  letter_count integer not null constraint conversation_file_pages_letter_count_check
    check (letter_count >= 0),
  extracted_at timestamptz not null default now(),
  primary key (file_id, page_no)
);

comment on table public.conversation_file_pages is
  'The text read out of an attached file, one row per page, with its provenance. RLS is forced and there is NO policy: no browser session can read these rows. Only the server does, to put them in front of the model.';

-- ---------------------------------------------------------------------------------------
-- (3) RLS and the privilege layer
-- ---------------------------------------------------------------------------------------

alter table public.conversation_files enable row level security;
alter table public.conversation_files force row level security;
alter table public.conversation_file_pages enable row level security;
alter table public.conversation_file_pages force row level security;

revoke all on public.conversation_files, public.conversation_file_pages from anon, authenticated;
-- SELECT is granted on both, as on every table (tests/security/rls.test.ts asserts the grant
-- per table). On the pages table the grant meets no policy, so it yields no rows: the
-- privilege says "you may ask", row-level security answers "there is nothing for you".
grant select on public.conversation_files, public.conversation_file_pages to authenticated;
grant all on public.conversation_files, public.conversation_file_pages to service_role;

-- Whoever can read the conversation can see its files (D86) — and nobody else: an account
-- that is not on the allowlist reads nothing, and a private conversation's file is its
-- author's alone. An upload still in progress is nobody's to see.
create policy conversation_files_read on public.conversation_files
  for select to authenticated
  using (
    status <> 'reading'
    and (scope = 'workspace' or user_id = (select auth.uid()))
    and public.is_active_staff()
  );

-- No policy on conversation_file_pages. Deliberate; see the header.

-- ---------------------------------------------------------------------------------------
-- (4) Ownership follows the conversation, in both directions
-- ---------------------------------------------------------------------------------------

-- Child side: the function `messages` already uses. A file can never disagree with its
-- conversation about who owns it or who may see it.
create trigger conversation_files_sync_ownership
  before insert or update of conversation_id, user_id, scope on public.conversation_files
  for each row
  execute function public.sync_child_ownership();

-- Parent side: marking a conversation private (or handing it to someone) carries to its
-- files in the same transaction. A separate function from `cascade_conversation_ownership`,
-- which stays exactly as Stage 3 part 5 left it.
create or replace function public.cascade_conversation_files_ownership()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.conversation_files
    set user_id = new.user_id, scope = new.scope
    where conversation_id = new.id;
  return new;
end;
$$;

create trigger conversations_cascade_files_ownership
  after update of user_id, scope on public.conversations
  for each row
  when (old.user_id is distinct from new.user_id or old.scope is distinct from new.scope)
  execute function public.cascade_conversation_files_ownership();

-- Deleting a conversation destroys its files outright — rows, text, names, everything. The
-- conversation's messages are deleted permanently by `delete_conversation`; text read out of
-- a client's documents must not be the one thing that survives it.
create or replace function public.purge_files_of_deleted_conversation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from public.conversation_files where conversation_id = new.id;
  return new;
end;
$$;

create trigger conversations_purge_files
  after update of deleted_at on public.conversations
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function public.purge_files_of_deleted_conversation();

-- ---------------------------------------------------------------------------------------
-- (5) begin_conversation_file — claim an upload, idempotently
--
-- Under a lock on the conversation, so two uploads starting together cannot both take the
-- last free slot. Returns the row for a request id that was already claimed (a retry after a
-- dropped response resumes rather than starting again), or the READY row holding the same
-- content (the same file sent twice is attached once).
--
-- Raises: 02000 the conversation does not exist or was deleted · FL001 the conversation is
-- full.
-- ---------------------------------------------------------------------------------------

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
  p_abandoned_minutes integer
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
  v_live integer;
begin
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

  -- The same file, already attached and ready.
  select * into v_file
  from public.conversation_files f
  where f.conversation_id = p_conversation_id
    and f.content_hash = p_content_hash
    and f.status = 'ready';
  if found then
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
     content_hash, expected_pages, vision_pages, expires_at)
  values
    (p_conversation_id, v_conversation.user_id, v_conversation.scope, p_uploaded_by,
     p_request_id, p_name, p_kind, p_byte_size, p_content_hash, p_expected_pages,
     p_vision_pages, now() + make_interval(days => p_retention_days))
  returning * into v_file;

  return query select v_file.id, v_file.status, false, false, v_file.expected_pages, '{}'::integer[];
end;
$$;

comment on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer) is
  'Milestone 5 part 1. Claims an upload under a lock on its conversation: idempotent on request_id, returns the ready row for the same content, deletes abandoned attempts, refuses past the per-conversation limit (FL001). service_role only.';

-- ---------------------------------------------------------------------------------------
-- (6) append_conversation_file_pages — store pages of a file that is still being read
--
-- An upsert: sending a page twice (a retry after a dropped response) stores it once.
-- Raises: 02000 no such file · FL002 the file is not being read any more · FL003 a page
-- number outside what `begin` declared.
-- ---------------------------------------------------------------------------------------

create or replace function public.append_conversation_file_pages(
  p_file_id uuid,
  p_pages jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_file public.conversation_files%rowtype;
  v_stored integer;
begin
  select * into v_file from public.conversation_files f where f.id = p_file_id for update;
  if not found then
    raise exception 'file % does not exist', p_file_id using errcode = '02000';
  end if;
  if v_file.status <> 'reading' then
    raise exception 'file % is not being read (status %)', p_file_id, v_file.status
      using errcode = 'FL002';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_pages) as x(page_no integer)
    where x.page_no is null or x.page_no < 1 or x.page_no > v_file.expected_pages
  ) then
    raise exception 'file % was declared with % pages', p_file_id, v_file.expected_pages
      using errcode = 'FL003';
  end if;

  insert into public.conversation_file_pages
    (file_id, page_no, label, content, extraction_method, confidence, legibility, letter_count)
  select p_file_id, x.page_no, x.label, x.content, x.extraction_method, x.confidence,
         x.legibility, x.letter_count
  from jsonb_to_recordset(p_pages) as x(
    page_no integer, label text, content text, extraction_method text,
    confidence numeric, legibility text, letter_count integer
  )
  on conflict (file_id, page_no) do update
    set label = excluded.label,
        content = excluded.content,
        extraction_method = excluded.extraction_method,
        confidence = excluded.confidence,
        legibility = excluded.legibility,
        letter_count = excluded.letter_count,
        extracted_at = now();

  select count(*) into v_stored from public.conversation_file_pages p where p.file_id = p_file_id;
  return v_stored;
end;
$$;

comment on function public.append_conversation_file_pages(uuid, jsonb) is
  'Milestone 5 part 1. Upserts pages of a file whose status is still reading. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (7) finish_conversation_file — all pages in, the file becomes usable
--
-- One transaction: the completeness check, the status change and the audit row. A file is
-- `ready` only when EVERY page `begin` declared is stored — a half-read file is never
-- presented as a whole one. Idempotent: finishing a ready file returns it.
--
-- Raises: 02000 no such file · FL002 removed · FL004 pages missing · FL005 nothing readable
-- in it · FL006 longer than `p_max_chars`.
-- ---------------------------------------------------------------------------------------

create or replace function public.finish_conversation_file(
  p_file_id uuid,
  p_actor uuid,
  p_max_chars integer
)
returns table (
  id uuid,
  duplicate boolean,
  already boolean,
  page_count integer,
  char_count integer,
  vision_pages integer,
  confidence numeric
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
begin
  select * into v_file from public.conversation_files f where f.id = p_file_id for update;
  if not found then
    raise exception 'file % does not exist', p_file_id using errcode = '02000';
  end if;
  if v_file.status = 'ready' then
    return query select v_file.id, false, true, v_file.page_count, v_file.char_count,
                        v_file.vision_pages, v_file.confidence;
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

  -- Somebody else attached the same file while this one was being read.
  select * into v_other
  from public.conversation_files f
  where f.conversation_id = v_file.conversation_id
    and f.content_hash = v_file.content_hash
    and f.status = 'ready';
  if found then
    delete from public.conversation_files f where f.id = p_file_id;
    return query select v_other.id, true, true, v_other.page_count, v_other.char_count,
                        v_other.vision_pages, v_other.confidence;
    return;
  end if;

  update public.conversation_files f
  set status = 'ready',
      ready_at = now(),
      page_count = v_pages,
      char_count = v_chars,
      vision_pages = v_vision,
      confidence = v_confidence
  where f.id = p_file_id;

  -- Ids, a kind and counts. Never the name, never a word of the content.
  insert into public.audit_log (actor, action, entity_type, entity_id, after)
  values (
    p_actor::text, 'FILE_ATTACHED', 'conversation_files', p_file_id,
    jsonb_build_object(
      'conversation_id', v_file.conversation_id,
      'kind', v_file.kind,
      'byte_size', v_file.byte_size,
      'page_count', v_pages,
      'char_count', v_chars,
      'vision_pages', v_vision
    )
  );

  return query select p_file_id, false, false, v_pages, v_chars, v_vision, v_confidence;
end;
$$;

comment on function public.finish_conversation_file(uuid, uuid, integer) is
  'Milestone 5 part 1. Marks a file ready only when every declared page is stored, in one transaction with its audit row (ids and counts only). Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (8) remove_conversation_file — a person takes a file back, or an upload is abandoned
--
-- A file that never became ready is deleted outright: nobody ever saw it. A ready file
-- becomes a tombstone — the text, the name and the hash are destroyed, the row stays so the
-- thread can say a file was here. Idempotent; returns false when there was nothing to do.
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
      removed_at = now(),
      removed_by = p_actor,
      removed_reason = p_reason
  where f.id = p_file_id;

  insert into public.audit_log (actor, action, entity_type, entity_id, before)
  values (
    coalesce(p_actor::text, 'system'),
    case when p_reason = 'expired' then 'FILE_EXPIRED' else 'FILE_REMOVED' end,
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
  'Milestone 5 part 1. Deletes an unfinished upload outright; turns a ready file into a tombstone with no text, name or hash, and audits it. Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (9) purge_conversation_files — the retention promise, kept on a schedule
--
-- Not dependent on anyone using the app: pg_cron calls it once a day. Deletes uploads that
-- never finished, and turns every ready file past its `expires_at` into a tombstone.
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

  return query select v_abandoned, v_expired;
end;
$$;

comment on function public.purge_conversation_files(integer) is
  'Milestone 5 part 1 (D85). Deletes abandoned uploads and tombstones files past their 30-day expiry. Scheduled daily by pg_cron (job purge-conversation-files). service_role only.';

revoke all on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.append_conversation_file_pages(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.finish_conversation_file(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.remove_conversation_file(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.purge_conversation_files(integer) from public, anon, authenticated;
revoke all on function public.cascade_conversation_files_ownership() from public, anon, authenticated;
revoke all on function public.purge_files_of_deleted_conversation() from public, anon, authenticated;
grant execute on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.append_conversation_file_pages(uuid, jsonb) to service_role;
grant execute on function public.finish_conversation_file(uuid, uuid, integer) to service_role;
grant execute on function public.remove_conversation_file(uuid, uuid, text) to service_role;
grant execute on function public.purge_conversation_files(integer) to service_role;

-- ---------------------------------------------------------------------------------------
-- (10) The schedule
--
-- pg_cron is a Supabase-supported extension and is installed here so a from-zero replay
-- (CI, a new project) ends with the job in place. On the LIVE project it must be enabled
-- before this migration is pushed — RUNBOOK §1e names it as a deploy step.
-- `cron.schedule` with a job name replaces a job of the same name, so re-running is safe.
-- 03:17 UTC is 11:17 in Perth: daytime there, but the job is a handful of indexed deletes.
-- ---------------------------------------------------------------------------------------

create extension if not exists pg_cron;

select cron.schedule(
  'purge-conversation-files',
  '17 3 * * *',
  $$select public.purge_conversation_files()$$
);
