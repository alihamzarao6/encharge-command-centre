-- Milestone 5 part 2 — reading a web page from a link (docs/MEMORY.md 12 Oct 2026, D93–D99).
--
-- A page the client points at is read the way an attached file is: the Edge Function fetches
-- the bytes (guarded — src/lib/pages/), hands them to the browser, and the browser reads them
-- through the same readers and sends back TEXT (D84, unchanged). So a web page is one more
-- row in `conversation_files` and its text is more rows in `conversation_file_pages`, under
-- the RLS those tables already have. What this migration adds is what a page has and a file
-- does not:
--
--   * WHERE IT CAME FROM, as the server saw it. `source_url`, `source_host` and `fetched_at`
--     complete the provenance every stored field owes (CLAUDE.md rule 12) — and they are
--     written from the server's own record of the fetch (`web_fetches`), never from anything
--     a browser sends. A browser can say what the text is; it cannot say where it came from.
--   * A RECORD OF EACH FETCH. `web_fetches` holds one row per "Read this page": who asked,
--     the address, how the site answered, the size and SHA-256 of the bytes. No page text, no
--     title. It is what `begin` checks an attachment against, what the per-person and
--     per-host limits count, and it is gone after a day.
--   * HOW MUCH OF THE PAGE WAS NOT THERE. Some sites leave a place for a script to fill in a
--     figure (three of the seven lender rate pages probed). The reader writes a mark there;
--     `values_missing` is how many, so the interface and the model can say "read in part".
--   * WHETHER IT WAS READ AS THE SITE SENT IT. One lender sends a page that shows nothing
--     until its scripts fade it in; the reader reads what is behind `opacity:0` — and only
--     that — and says so in the first line of the text. `read_as_sent` records it, so the
--     screen and the model can say that what was read may not be what a visitor sees.
--   * A NEWER READ REPLACES AN OLDER ONE of the same address in the same conversation, so two
--     copies of a rate page never sit in front of the model disagreeing.
--
-- The raw HTML is never stored: not here, not in a bucket, not anywhere. A web page's text is
-- kept for ONE day (D95) — the retention is the existing `expires_at`, set by the caller; the
-- purge is the existing job.
--
-- Deploy order (RUNBOOK §1f): this migration first. `begin_conversation_file` and
-- `finish_conversation_file` keep accepting the calls the deployed `files` function makes
-- (the new parameters have defaults), so nothing breaks between this and the function deploy.
--
-- Reversible:
--   drop function public.complete_web_fetch(uuid, uuid, text, text, text, text, integer, text, bigint, text, integer, integer);
--   drop function public.claim_web_fetch(uuid, uuid, text, text, integer, integer);
--   drop table public.web_fetches;
--   (then restore begin_/finish_/remove_/purge_conversation_file(s) from 20261012010000)
--   delete from public.conversation_files where kind = 'html';
--   alter table public.conversation_file_pages drop constraint conversation_file_pages_method_check;  -- re-add without 'html_text'
--   alter table public.conversation_files
--     drop constraint conversation_files_html_source_check,
--     drop constraint conversation_files_source_check,
--     drop column read_as_sent, drop column values_missing, drop column fetched_at,
--     drop column source_host, drop column source_url;
--   (and re-add the kind, removed_reason and tombstone checks as 20261012010000 wrote them)

-- ---------------------------------------------------------------------------------------
-- (1) What a page has that a file does not
-- ---------------------------------------------------------------------------------------

alter table public.conversation_files
  -- The address that was actually read: after redirects, https, no credentials, no fragment.
  add column source_url text,
  -- Its host, for the screen and for the model. Never taken from the page.
  add column source_host text,
  -- When the server fetched it. What "is this still current" is answered from.
  add column fetched_at timestamptz,
  -- Places the site leaves for a script to fill in, found empty in what was fetched.
  add column values_missing integer not null default 0
    constraint conversation_files_values_missing_check check (values_missing >= 0),
  -- The page shows nothing until its scripts run and was read as the site sent it — with
  -- its opacity:0 declarations ignored. Some of its text may never be shown to a visitor.
  add column read_as_sent boolean not null default false;

-- All three, or none: a row is either from a link or it is not.
alter table public.conversation_files
  add constraint conversation_files_source_check check (
    (source_url is null and source_host is null and fetched_at is null)
    or (
      source_url is not null and source_host is not null and fetched_at is not null
      and source_url ~ '^https://[^[:space:]]+$'
      and char_length(source_url) <= 2048
      and char_length(source_host) between 1 and 253
    )
  );

alter table public.conversation_files drop constraint conversation_files_kind_check;
alter table public.conversation_files add constraint conversation_files_kind_check
  check (kind in ('pdf', 'docx', 'xlsx', 'csv', 'text', 'image', 'html'));

-- A web page that names no source is not a web page. (An uploaded .html file is still
-- refused — D83 — so `html` only ever arrives with a fetch behind it.)
alter table public.conversation_files
  add constraint conversation_files_html_source_check
  check (kind <> 'html' or status = 'removed' or source_url is not null);

alter table public.conversation_files drop constraint conversation_files_removed_reason_check;
alter table public.conversation_files add constraint conversation_files_removed_reason_check
  check (removed_reason is null or removed_reason in ('user', 'expired', 'replaced'));

-- The tombstone guarantee now covers the address too: a removed row names nothing.
alter table public.conversation_files drop constraint conversation_files_tombstone_check;
alter table public.conversation_files add constraint conversation_files_tombstone_check
  check (
    (status = 'removed' and name is null and content_hash is null and removed_at is not null
      and source_url is null)
    or (status <> 'removed' and name is not null and content_hash is not null)
  );

create index conversation_files_source_idx
  on public.conversation_files (conversation_id, source_url)
  where status = 'ready' and source_url is not null;

comment on column public.conversation_files.source_url is
  'Milestone 5 part 2. The address this row was read from, as the SERVER fetched it (after redirects). Null for an uploaded file, and null again once removed. Copied from web_fetches at begin; a browser cannot set it.';
comment on column public.conversation_files.fetched_at is
  'Milestone 5 part 2. When the server fetched the page. Shown on screen and given to the model with the text: a rate read yesterday is not today''s rate.';
comment on column public.conversation_files.read_as_sent is
  'Milestone 5 part 2. True when the page showed nothing until its scripts ran and was read as the site sent it (the reader''s mark was found in the stored text at finish). Shown on screen under the page and given to the model with the text: what was read may include text a visitor never sees.';
comment on column public.conversation_files.values_missing is
  'Milestone 5 part 2. How many places in the page were left for a script to fill in and were empty in what was fetched. Above zero, the page is shown and described as read in part.';

alter table public.conversation_file_pages drop constraint conversation_file_pages_method_check;
alter table public.conversation_file_pages add constraint conversation_file_pages_method_check
  check (extraction_method in
    ('pdf_text_layer', 'claude_vision', 'docx_xml', 'xlsx_xml', 'csv_parse', 'plain_text',
     'html_text'));

-- ---------------------------------------------------------------------------------------
-- (2) web_fetches — the server's record of each read
-- ---------------------------------------------------------------------------------------

create table public.web_fetches (
  -- The browser's id for one request to open a page. Never reused: a second try is a new row.
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  requested_url text not null constraint web_fetches_requested_url_check
    check (requested_url ~ '^https://[^[:space:]]+$' and char_length(requested_url) <= 2048),
  requested_host text not null constraint web_fetches_requested_host_check
    check (char_length(requested_host) between 1 and 253),
  -- Where it ended after redirects. Null until the site answered.
  final_url text constraint web_fetches_final_url_check
    check (final_url is null
      or (final_url ~ '^https://[^[:space:]]+$' and char_length(final_url) <= 2048)),
  final_host text constraint web_fetches_final_host_check
    check (final_host is null or char_length(final_host) between 1 and 253),
  -- started: asked, no answer recorded yet. fetched: bytes were handed to the browser.
  -- refused: the address or the page was refused, for the reason in `outcome`.
  -- failed: the site did not answer usefully; may be tried again.
  status text not null default 'started' constraint web_fetches_status_check
    check (status in ('started', 'fetched', 'refused', 'failed')),
  -- A reason code from src/lib/pages/limits.ts. Never a sentence, never page content.
  outcome text constraint web_fetches_outcome_check
    check (outcome is null or outcome ~ '^[a-z_]{1,48}$'),
  http_status integer,
  content_type text constraint web_fetches_content_type_check
    check (content_type is null or char_length(content_type) <= 120),
  byte_size bigint constraint web_fetches_byte_size_check
    check (byte_size is null or byte_size >= 0),
  content_hash text constraint web_fetches_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  hops integer,
  duration_ms integer,
  created_at timestamptz not null default now(),
  fetched_at timestamptz,
  -- Only a fetch that produced bytes can be attached, and it says what those bytes were.
  constraint web_fetches_fetched_check
    check (status <> 'fetched'
      or (final_url is not null and final_host is not null and byte_size is not null
          and content_hash is not null and fetched_at is not null))
);

create index web_fetches_user_idx on public.web_fetches (user_id, created_at);
create index web_fetches_requested_host_idx on public.web_fetches (requested_host, created_at);
create index web_fetches_final_host_idx on public.web_fetches (final_host, created_at)
  where final_host is not null;
create index web_fetches_created_idx on public.web_fetches (created_at);

comment on table public.web_fetches is
  'Milestone 5 part 2. One row per page a person asked the assistant to read: who, the address, how the site answered, the size and SHA-256 of what came back. No page text and no title. RLS is forced and there is NO policy: only the server reads it — to check an attachment against, and to count the per-person and per-host limits. Rows older than a day are deleted by purge_conversation_files.';

alter table public.web_fetches enable row level security;
alter table public.web_fetches force row level security;

revoke all on public.web_fetches from anon, authenticated;
-- The privilege says "you may ask"; with no policy, row-level security answers "there is
-- nothing for you" (the conversation_file_pages pattern; tests/security/rls.test.ts asserts
-- the grant on every table).
grant select on public.web_fetches to authenticated;
grant all on public.web_fetches to service_role;

-- No policy on web_fetches. Deliberate; see the comment on the table.

-- ---------------------------------------------------------------------------------------
-- (3) claim_web_fetch — may this read go ahead?
--
-- Atomic per person and per host: each limit is decided under its own lock, so two reads
-- started together cannot both conclude that the minute's allowance has room, or that nobody
-- was just at that site.
--
--   * p_per_minute reads per person per minute (every attempt counts, refused or not).
--   * p_host_gap_ms between two reads of the same host, by anyone (SECURITY.md §10). When the
--     gap has not passed, nothing is claimed and `wait_ms` says how long is left: the caller
--     waits and asks again.
--
-- ONE ID OPENS ONE PAGE, ONCE. An id that is already on record claims nothing and is answered
-- `existing`: the caller opens nothing and asks again under a new id, which is counted and
-- spaced like any other read. Were a repeated id let through, one id sent again and again
-- would be as many requests to a site as its sender liked, past both limits. The answer is
-- the same whoever the id belongs to, so it says nothing about anybody else's reads.
-- Raises: WF001 the person's limit is reached.
-- ---------------------------------------------------------------------------------------

create or replace function public.claim_web_fetch(
  p_id uuid,
  p_user_id uuid,
  p_url text,
  p_host text,
  p_per_minute integer,
  p_host_gap_ms integer
)
returns table (claimed boolean, existing boolean, wait_ms integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_recent integer;
  v_last timestamptz;
  v_wait integer;
begin
  -- The person first, then the host — always in that order, so two claims cannot each hold
  -- what the other is waiting for. The first makes the per-minute count exact when one
  -- person starts several reads at once; the second does the same for the gap.
  perform pg_advisory_xact_lock(hashtextextended('web_fetch_user:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('web_fetch:' || p_host, 0));

  if exists (select 1 from public.web_fetches f where f.id = p_id) then
    return query select false, true, 0;
    return;
  end if;

  select count(*) into v_recent
  from public.web_fetches f
  where f.user_id = p_user_id
    and f.created_at > clock_timestamp() - interval '1 minute';
  if v_recent >= p_per_minute then
    raise exception 'user % has opened % pages in the last minute', p_user_id, v_recent
      using errcode = 'WF001';
  end if;

  select max(f.created_at) into v_last
  from public.web_fetches f
  where f.requested_host = p_host or f.final_host = p_host;
  if v_last is not null then
    v_wait := p_host_gap_ms
      - floor(extract(epoch from (clock_timestamp() - v_last)) * 1000)::integer;
    if v_wait > 0 then
      return query select false, false, v_wait;
      return;
    end if;
  end if;

  insert into public.web_fetches (id, user_id, requested_url, requested_host, created_at)
  values (p_id, p_user_id, p_url, p_host, clock_timestamp());
  return query select true, false, 0;
end;
$$;

comment on function public.claim_web_fetch(uuid, uuid, text, text, integer, integer) is
  'Milestone 5 part 2. Claims one page read under a per-host lock: applies the per-person per-minute limit (WF001) and the per-host gap (returns wait_ms). An id already on record claims nothing (existing = true): one id opens one page, once. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (4) complete_web_fetch — how it ended
--
-- Also called when the BROWSER refuses a page it was handed (a paywall, a login page): the
-- fetch is marked refused, so it can no longer be attached. Fields passed as null are left as
-- they were. Returns false when the row is not this person's (or does not exist).
-- ---------------------------------------------------------------------------------------

create or replace function public.complete_web_fetch(
  p_id uuid,
  p_user_id uuid,
  p_status text,
  p_outcome text,
  p_final_url text,
  p_final_host text,
  p_http_status integer,
  p_content_type text,
  p_byte_size bigint,
  p_content_hash text,
  p_hops integer,
  p_duration_ms integer
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.web_fetches f
  set status = p_status,
      outcome = p_outcome,
      final_url = coalesce(p_final_url, f.final_url),
      final_host = coalesce(p_final_host, f.final_host),
      http_status = coalesce(p_http_status, f.http_status),
      content_type = coalesce(p_content_type, f.content_type),
      byte_size = coalesce(p_byte_size, f.byte_size),
      content_hash = coalesce(p_content_hash, f.content_hash),
      hops = coalesce(p_hops, f.hops),
      duration_ms = coalesce(p_duration_ms, f.duration_ms),
      fetched_at = case when p_status = 'fetched' then clock_timestamp() else f.fetched_at end
  where f.id = p_id and f.user_id = p_user_id;
  return found;
end;
$$;

comment on function public.complete_web_fetch(uuid, uuid, text, text, text, text, integer, text, bigint, text, integer, integer) is
  'Milestone 5 part 2. Records how a page read ended: fetched (with the final address, size and hash), refused or failed, with a reason code. Scoped to the person who asked. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (5) begin_conversation_file — now also for a page that was fetched
--
-- As 20261012010000 wrote it, plus `p_fetch_id`. When given, the attachment is checked
-- against the server's record of the fetch — this person's, fetched, recent, and the SAME
-- BYTES (size and SHA-256) — and takes its address, host and time from that record. Anything
-- else is FL007. The browser supplies the text; it never supplies where the text came from.
--
-- The same bytes already attached and ready is still "the same file, attached once" — and
-- for a page it means something more: the site was asked again and nothing had changed, so
-- that copy's `fetched_at` moves forward to this fetch and its expiry with it.
--
-- The old twelve-parameter signature is dropped and this one accepts the same named
-- arguments (the thirteenth has a default), so the deployed `files` function keeps working
-- across the deploy.
-- ---------------------------------------------------------------------------------------

drop function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer);

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
  p_fetch_id uuid default null
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

  -- From a link: only against the server's own record of having fetched exactly these bytes.
  if p_fetch_id is not null then
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
    if p_fetch_id is not null and v_file.source_url is not null then
      -- Asked again, and the site sent the same bytes: this copy is current as of now.
      update public.conversation_files f
      set fetched_at = v_fetch.fetched_at,
          expires_at = now() + make_interval(days => p_retention_days)
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
     source_url, source_host, fetched_at)
  values
    (p_conversation_id, v_conversation.user_id, v_conversation.scope, p_uploaded_by,
     p_request_id, p_name, p_kind, p_byte_size, p_content_hash, p_expected_pages,
     p_vision_pages, now() + make_interval(days => p_retention_days),
     case when p_fetch_id is null then null else v_fetch.final_url end,
     case when p_fetch_id is null then null else v_fetch.final_host end,
     case when p_fetch_id is null then null else v_fetch.fetched_at end)
  returning * into v_file;

  return query select v_file.id, v_file.status, false, false, v_file.expected_pages, '{}'::integer[];
end;
$$;

comment on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid) is
  'Milestone 5 parts 1 and 2. Claims an upload under a lock on its conversation: idempotent on request_id, returns the ready row for the same content, deletes abandoned attempts, refuses past the per-conversation limit (FL001). With p_fetch_id, the attachment must match the server''s record of that fetch (FL007) and takes its address and time from it. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (6) finish_conversation_file — now counts what was missing, and replaces an older read
--
-- As 20261012010000 wrote it, plus:
--   * `p_gap_mark`: the text the reader writes where a page left a place for a script to fill
--     in. Its occurrences across the stored pages become `values_missing`.
--   * `p_sent_mark`: the line the reader writes at the top of a page it read as the site sent
--     it. Found anywhere in the stored pages, it sets `read_as_sent`.
--   * a page from the same address already attached to this conversation is removed
--     (reason `replaced`) in the same transaction. `replaced` says how many.
-- ---------------------------------------------------------------------------------------

drop function public.finish_conversation_file(uuid, uuid, integer);

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

  -- An older read of the same address, in this conversation, goes now: two copies of one
  -- page must never sit in front of the model saying different things.
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
      'source', case when v_file.source_url is null then 'upload' else 'link' end,
      'values_missing', v_missing,
      'read_as_sent', v_sent,
      'replaced', v_replaced
    )
  );

  return query select p_file_id, false, false, v_pages, v_chars, v_vision, v_confidence, v_replaced;
end;
$$;

comment on function public.finish_conversation_file(uuid, uuid, integer, text, text) is
  'Milestone 5 parts 1 and 2. Marks a file ready only when every declared page is stored, in one transaction with its audit row (ids and counts only). Sets read_as_sent when the reader''s "read as sent" mark is in the stored text. Counts the reader''s "not in the page" marks into values_missing, and removes an older read of the same address in the same conversation. Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (7) remove_conversation_file — a removed row now forgets its address as well
--
-- Same signature, so `create or replace`. `p_reason` may now be `replaced`.
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
  'Milestone 5 parts 1 and 2. Deletes an unfinished upload outright; turns a ready file into a tombstone with no text, name, hash or address, and audits it (removed, expired or replaced). Idempotent. service_role only.';

-- ---------------------------------------------------------------------------------------
-- (8) purge_conversation_files — the same job also clears the fetch records
--
-- Same signature and return type. A fetch record is needed for fifteen minutes (to attach
-- against) and for a minute (to count); a day is kept so "why could it not read that" has an
-- answer the next morning.
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

  return query select v_abandoned, v_expired;
end;
$$;

comment on function public.purge_conversation_files(integer) is
  'Milestone 5 parts 1 and 2 (D85, D95). Deletes abandoned uploads, tombstones files and pages past their expiry, and deletes page-fetch records older than a day. Scheduled daily by pg_cron (job purge-conversation-files). service_role only.';

-- ---------------------------------------------------------------------------------------
-- (9) Who may call what
-- ---------------------------------------------------------------------------------------

revoke all on function public.claim_web_fetch(uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_web_fetch(uuid, uuid, text, text, text, text, integer, text, bigint, text, integer, integer) from public, anon, authenticated;
revoke all on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.finish_conversation_file(uuid, uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.claim_web_fetch(uuid, uuid, text, text, integer, integer) to service_role;
grant execute on function public.complete_web_fetch(uuid, uuid, text, text, text, text, integer, text, bigint, text, integer, integer) to service_role;
grant execute on function public.begin_conversation_file(uuid, uuid, uuid, text, text, bigint, text, integer, integer, integer, integer, integer, uuid) to service_role;
grant execute on function public.finish_conversation_file(uuid, uuid, integer, text, text) to service_role;
