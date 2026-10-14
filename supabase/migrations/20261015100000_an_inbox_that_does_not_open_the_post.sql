-- An inbox that does not open the post.
--
-- SEF is the tax administration's e-invoice service: every company in Serbia
-- receives its supplier bills through it, and the accounting firm reads the
-- same mailbox. ASKING SEF FOR A DOCUMENT MOVES THAT INVOICE FROM `New` TO
-- `Seen`, and the accountants rely on that status to know what they have not
-- looked at yet.
--
-- So this is two halves, separated on purpose:
--
--   * A scheduled pull reads HEADERS only, through `purchase-invoice/overview`.
--     It was measured against the live service: an invoice listed that way is
--     still `New` in the portal afterwards. The whole design rests on that.
--   * The document is fetched once, by name, only when somebody decides to
--     book that bill -- and that is the moment the status changes, which is
--     what the owner is told before he presses it.
--
-- A row therefore carries the FIGURES from the header and nothing else until
-- it is opened. An invoice that is declined is never opened at all: the
-- accounting firm sees it exactly as it was.
--
-- This arrives here as ONE migration where the application it came from
-- reached it in five. Rule 5 of docs/NADOGRADNJA.md protects migrations a
-- database has already applied, and none here has applied any of these, so
-- the corrections belong in the first version rather than as a trail of fixes
-- nobody needs to read: the live server answers in PascalCase while its
-- published schema says camelCase, and a row the owner has already decided on
-- is left alone by later passes.

begin;

create table if not exists public.sef_inbox (
  id                           uuid primary key default gen_random_uuid(),
  company_id                   uuid not null references public.companies (id) on delete cascade,

  -- SEF's own identity. This is what makes re-reading a window free.
  sef_invoice_id               bigint not null,
  cir_invoice_id               text,
  glob_uniq_id                 text,

  -- Everything below comes from PurchaseInvoiceOverviewDto. There is no issue
  -- date in it: the window runs on `sent_date`, and the true IssueDate is read
  -- from the UBL at import. See the spec.
  document_number              text,
  document_type                text,
  supplier_name                text,
  supplier_vat_number          text,
  supplier_registration_number text,
  amount                       numeric(18,2),
  sum_without_vat              numeric(18,2),
  vat_amount                   numeric(18,2),
  currency                     text,
  delivery_date                date,
  due_date                     date,
  sent_date                    timestamptz,
  sef_status                   text,

  overview_json                jsonb not null,

  -- Kept because SEF is asked for the document EXACTLY ONCE per invoice. When
  -- the parser mishandles some supplier's layout the original is still here to
  -- re-parse, with no second call and no further effect on the status.
  ubl_xml                      text,
  ubl_fetched_at               timestamptz,

  state                        text not null default 'pending'
                                 check (state in ('pending', 'imported', 'dismissed')),
  dismiss_reason               text,
  -- `on delete set null` is load-bearing: it is what lets a row return to the
  -- queue once its ledger invoice is gone. See the trigger below.
  imported_invoice_id          uuid references public.invoices (id) on delete set null,

  pulled_at                    timestamptz not null default now(),
  last_seen_at                 timestamptz not null default now(),
  imported_at                  timestamptz,
  dismissed_at                 timestamptz,
  restored_at                  timestamptz,

  -- A decline with no reason is a decline nobody can account for in March.
  constraint sef_inbox_declined_says_why
    check (state <> 'dismissed' or btrim(coalesce(dismiss_reason, '')) <> '')
);

-- NOT a second check constraint saying an imported row names its invoice.
-- That would contradict `on delete set null`: deleting the ledger invoice
-- would null the link while `state` was still `imported`, the check would
-- fail, and the delete would be refused. The trigger below does the work.

create unique index if not exists sef_inbox_one_row_per_invoice
  on public.sef_inbox (company_id, sef_invoice_id);

create index if not exists sef_inbox_queue_idx
  on public.sef_inbox (company_id, state, sent_date desc);

-- ── The refusal that may not live in the UI ────────────────────────────────
--
-- Returning an imported row to the queue means it can be booked a second time
-- and the bill is in the ledger twice. The UI is not the only writer, and a
-- guarantee resting on somebody remembering a check is not a guarantee.

create or replace function public.sef_inbox_guard_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booked text;
begin
  -- Guarded on WHERE THE ROW IS GOING, not on where it came from. The first
  -- version asked `old.state = 'imported'`, which let `imported -> dismissed
  -- -> pending` walk around it: two updates, each legal on its own, and the
  -- bill bookable twice.
  if new.state = 'pending' and old.imported_invoice_id is not null then
    -- `deleted_at is null` is explicit, and not decoration. Invoices here are
    -- SOFT deleted, so `on delete set null` never fires for them and the link
    -- outlives a deletion the owner has already made. Without this the trigger
    -- would refuse for ever, telling him to do the thing he just did.
    select coalesce(invoice_number, old.imported_invoice_id::text)
      into booked
      from public.invoices
     where id = old.imported_invoice_id
       and deleted_at is null;

    if found then
      raise exception
        'This invoice is already booked as %. Remove it from the ledger first, then put this row back in the queue.',
        booked;
    end if;

    -- The invoice is gone, so the link is a fact about nothing. Cleared here
    -- rather than left standing: a stale link that survives into `pending`
    -- comes back to life if that invoice is ever undeleted, and the row is
    -- then bookable a second time with nothing to say so.
    new.imported_invoice_id := null;
    new.imported_at := null;
  end if;
  return new;
end $$;

drop trigger if exists sef_inbox_guard_state on public.sef_inbox;
create trigger sef_inbox_guard_state
  before update of state on public.sef_inbox
  for each row execute function public.sef_inbox_guard_state();

-- The interface cannot write the link (see the grants below), so this is the
-- one way a row becomes imported. It names a live invoice and refuses anything
-- already imported.
create or replace function public.sef_inbox_mark_imported(
  p_id uuid, p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.invoices
                  where id = p_invoice_id and deleted_at is null) then
    raise exception 'There is no live invoice % to mark this row against.', p_invoice_id;
  end if;

  -- Only a row still waiting is booked, and only once. A `dismissed` row
  -- keeps its link, so without `imported_invoice_id is null` this would
  -- relink it to a second invoice and quietly leave the first unprotected.
  update public.sef_inbox
     set state = 'imported',
         imported_invoice_id = p_invoice_id,
         imported_at = now()
   where id = p_id
     and state = 'pending'
     and imported_invoice_id is null;

  -- Saying nothing when nothing happened leaves the caller believing a bill
  -- was booked against a row that never took the link.
  if not found then
    raise exception
      'That row is not waiting to be booked — it is already decided, or already linked to an invoice.';
  end if;
end $$;

revoke all on function public.sef_inbox_mark_imported(uuid, uuid) from public, anon;
grant execute on function public.sef_inbox_mark_imported(uuid, uuid) to authenticated;

-- ── Grants ─────────────────────────────────────────────────────────────────
--
-- Rows are written by the edge functions as `service_role`, which bypasses
-- RLS. `authenticated` reads everything and writes only the four columns a
-- decision is made of; the link to a booked invoice is written by
-- `sef_inbox_mark_imported` above and never by hand. Nobody deletes.

alter table public.sef_inbox enable row level security;

revoke all on table public.sef_inbox from anon, authenticated;

-- Read everything; write only the four columns a decision is made of. The
-- link is deliberately NOT here: a link that can be nulled by hand is a
-- double-booking guard that can be walked around in one statement, and the
-- figures this table holds are the trace, not working space.
grant select on table public.sef_inbox to authenticated;
grant update (state, dismiss_reason, dismissed_at, restored_at)
  on table public.sef_inbox to authenticated;

-- The restrictive policy every new table takes (20261010090000): an account
-- without one of this company's roles sees nothing, whatever the permissive
-- policies below say.
drop policy if exists members_only on public.sef_inbox;
create policy members_only on public.sef_inbox as restrictive
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists sef_inbox_read on public.sef_inbox;
create policy sef_inbox_read
  on public.sef_inbox for select to authenticated using (public.is_member());

-- Deciding what to do with a supplier's bill is bookkeeping, so it is the
-- people who keep the books -- not every member who can read the queue.
drop policy if exists sef_inbox_decide on public.sef_inbox;
create policy sef_inbox_decide
  on public.sef_inbox for update to authenticated
  using (public.can_write_books()) with check (public.can_write_books());

-- ── The pull window ────────────────────────────────────────────────────────
--
-- In SQL rather than in the edge function so that the floor sits beside the
-- config it reads, and so that Belgrade time is Postgres's problem rather than
-- a hand-rolled offset. Belgrade leaves summer time on the last Sunday in
-- October; `timezone()` knows and an offset does not.
--
-- A WINDOW, not a cursor. A cursor is state and state can be wrong: if the job
-- is down over a weekend, or the cursor advances on a pass that later fails,
-- the invoices in that gap are seen by nobody and nothing reports it. The next
-- pass re-reads all 45 days and the gap closes by itself.

create or replace function public.sef_pull_window(
  p_from date default null,
  p_to   date default null)
returns table (date_from date, date_to date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  floor_date date;
  today_bg   date;
begin
  select value::date into floor_date
    from public.job_config where key = 'sef_pull_from';

  today_bg := (timezone('Europe/Belgrade', now()))::date;

  if p_from is not null and p_to is not null then
    date_from := greatest(p_from, coalesce(floor_date, p_from));
    date_to   := p_to;
  else
    date_from := greatest(today_bg - 45, coalesce(floor_date, today_bg - 45));
    date_to   := today_bg;
  end if;

  return next;
end $$;

revoke all on function public.sef_pull_window(date, date) from public, anon;
grant execute on function public.sef_pull_window(date, date) to authenticated, service_role;

-- A helper rather than lower-casing the whole object, because `overview_json`
-- stores the row as it arrived and must stay byte-for-byte what SEF sent.
-- First match wins: two keys differing only in case is not something SEF sends.
create or replace function public.jsonb_value_ci(p_obj jsonb, p_key text)
returns text
language sql
immutable
as $$
  select e.value #>> '{}'
    from jsonb_each(p_obj) e
   where lower(e.key) = lower(p_key)
   limit 1
$$;

-- A pure helper: nothing to protect, but nothing outside the service either has
-- a reason to call it. `sef_inbox_upsert` is `security definer` and owned, so
-- it reaches this whatever is granted here. Supabase's default privileges give
-- `anon` and `authenticated` EXECUTE directly, hence naming them, as the
-- sibling migration does.
revoke all on function public.jsonb_value_ci(jsonb, text) from public, anon, authenticated;
grant execute on function public.jsonb_value_ci(jsonb, text) to service_role;

-- The return type is unchanged (seen, inserted, skipped), so `create or
-- replace` is enough and no `drop function` is needed.
create or replace function public.sef_inbox_upsert(
  p_company_id uuid,
  p_rows       jsonb)
returns table (seen int, inserted int, skipped int)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Reported, not swallowed. A pass that quietly drops rows is a queue that is
  -- short by an unknown amount, which is worse than one that is short and says so.
  select count(*)::int into skipped
    from jsonb_array_elements(p_rows) r
   where coalesce(public.jsonb_value_ci(r, 'invoiceId'), '') !~ '^-?[0-9]+$';

  with incoming as (
    -- DISTINCT because one array may carry the same invoice twice — overlapping
    -- pages, or SEF simply repeating a row — and `on conflict do update` refuses
    -- to touch one row twice in a statement, taking the whole batch with it.
    -- Of the duplicates the LATER one in the array wins: `pos` is its place in
    -- the array, and it orders the DISTINCT ON. `pos` is not written anywhere.
    select distinct on (sef_invoice_id)
      sef_invoice_id, cir_invoice_id, glob_uniq_id, document_number, document_type,
      supplier_name, supplier_vat_number, supplier_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      delivery_date, due_date, sent_date, sef_status, overview_json,
      -- Carried out of the subquery only so `distinct on` can order by it:
      -- the later array position wins when one response repeats an invoice.
      -- NOT inserted — the insert below names its columns.
      pos
      from (
      select
        (public.jsonb_value_ci(r, 'invoiceId'))::bigint                      as sef_invoice_id,
        public.jsonb_value_ci(r, 'cirInvoiceId')                             as cir_invoice_id,
        public.jsonb_value_ci(r, 'globUniqId')                               as glob_uniq_id,
        public.jsonb_value_ci(r, 'documentNumber')                           as document_number,
        public.jsonb_value_ci(r, 'documentType')                             as document_type,
        public.jsonb_value_ci(r, 'supplierName')                             as supplier_name,
        public.jsonb_value_ci(r, 'supplierVatRegistrationNumber')            as supplier_vat_number,
        public.jsonb_value_ci(r, 'supplierRegistrationNumber')               as supplier_registration_number,
        -- Guarded rather than cast outright. A figure this cannot read becomes
        -- null and the row still lands; cast outright it would abort the batch.
        case when btrim(public.jsonb_value_ci(r, 'amount')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'amount'))::numeric end          as amount,
        case when btrim(public.jsonb_value_ci(r, 'sumWithoutVat')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'sumWithoutVat'))::numeric end   as sum_without_vat,
        case when btrim(public.jsonb_value_ci(r, 'vatAmount')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'vatAmount'))::numeric end       as vat_amount,
        public.jsonb_value_ci(r, 'currency')                                 as currency,
        -- Belgrade, not the session's zone. These are Serbian invoices, and
        -- `timestamptz::date` under a negative-offset session files a midnight
        -- timestamp on the previous day.
        -- ASSUMES SEF sends an offset. An offset-less timestamp is read in the
        -- session's zone — UTC on Supabase — and a late-evening one would then
        -- roll to the next Belgrade day. To be confirmed against a real
        -- response before this is trusted for a month boundary.
        case when public.jsonb_value_ci(r, 'deliveryDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'deliveryDate'))::timestamptz at time zone 'Europe/Belgrade')::date end as delivery_date,
        case when public.jsonb_value_ci(r, 'dueDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'dueDate'))::timestamptz at time zone 'Europe/Belgrade')::date end      as due_date,
        case when public.jsonb_value_ci(r, 'sentDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then (public.jsonb_value_ci(r, 'sentDate'))::timestamptz end    as sent_date,
        public.jsonb_value_ci(r, 'status')                                   as sef_status,
        r                                                as overview_json,
        e.pos                                            as pos
        from jsonb_array_elements(p_rows) with ordinality as e(r, pos)
       -- A row with no usable id cannot be keyed at all. Skipped rather than
       -- allowed to kill the pass — and COUNTED, above, so a skip is reported
       -- and not silent.
       where public.jsonb_value_ci(r, 'invoiceId') ~ '^-?[0-9]+$'
    ) q
    order by sef_invoice_id, pos desc
  ),
  merged as (
    insert into public.sef_inbox as t (
      company_id, sef_invoice_id, cir_invoice_id, glob_uniq_id,
      document_number, document_type, supplier_name,
      supplier_vat_number, supplier_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      delivery_date, due_date, sent_date, sef_status, overview_json)
    select
      p_company_id, i.sef_invoice_id, i.cir_invoice_id, i.glob_uniq_id,
      i.document_number, i.document_type, i.supplier_name,
      i.supplier_vat_number, i.supplier_registration_number,
      i.amount, i.sum_without_vat, i.vat_amount, i.currency,
      i.delivery_date, i.due_date, i.sent_date, i.sef_status, i.overview_json
      from incoming i
    on conflict (company_id, sef_invoice_id) do update set
      -- ALWAYS, whatever the owner has decided. A re-read that omits `status`
      -- must not blank the one signal this column exists to carry.
      sef_status   = coalesce(excluded.sef_status, t.sef_status),
      last_seen_at = now(),
      -- ONLY while the row is still his to decide. `t.state` is the row as it
      -- stands; writing these unconditionally would overwrite the figures a
      -- booked invoice was booked from.
      cir_invoice_id               = case when t.state = 'pending' then excluded.cir_invoice_id               else t.cir_invoice_id               end,
      glob_uniq_id                 = case when t.state = 'pending' then excluded.glob_uniq_id                 else t.glob_uniq_id                 end,
      document_number              = case when t.state = 'pending' then excluded.document_number              else t.document_number              end,
      document_type                = case when t.state = 'pending' then excluded.document_type                else t.document_type                end,
      supplier_name                = case when t.state = 'pending' then excluded.supplier_name                else t.supplier_name                end,
      supplier_vat_number          = case when t.state = 'pending' then excluded.supplier_vat_number          else t.supplier_vat_number          end,
      supplier_registration_number = case when t.state = 'pending' then excluded.supplier_registration_number else t.supplier_registration_number end,
      amount                       = case when t.state = 'pending' then excluded.amount                       else t.amount                       end,
      sum_without_vat              = case when t.state = 'pending' then excluded.sum_without_vat              else t.sum_without_vat              end,
      vat_amount                   = case when t.state = 'pending' then excluded.vat_amount                   else t.vat_amount                   end,
      currency                     = case when t.state = 'pending' then excluded.currency                     else t.currency                     end,
      delivery_date                = case when t.state = 'pending' then excluded.delivery_date                else t.delivery_date                end,
      due_date                     = case when t.state = 'pending' then excluded.due_date                     else t.due_date                     end,
      sent_date                    = case when t.state = 'pending' then excluded.sent_date                    else t.sent_date                    end,
      overview_json                = case when t.state = 'pending' then excluded.overview_json                else t.overview_json                end
    returning (xmax = 0) as was_insert
  )
  select count(*)::int, count(*) filter (where was_insert)::int
    into seen, inserted
    from merged;

  return next;
end $$;


-- Re-issued: `create or replace` keeps the grants, but this is the line that
-- gets lost if somebody turns it into a drop-and-create later.
revoke all on function public.sef_inbox_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_inbox_upsert(uuid, jsonb) to service_role;


-- ── The inbox fills itself ────────────────────────────────────────────────
--
-- Quarter-hourly through the working day, in UTC: 05:00-17:00 UTC is
-- 07:00-19:00 Belgrade in summer and 06:00-18:00 in winter. `force` is passed
-- because `run_processor_sync` otherwise refuses any hour but seven, which is
-- the rule for jobs that must run once a day and not for one that runs
-- through it.
--
-- `cron.schedule` is upsert-by-name, so re-running this re-points the same job
-- rather than stacking a second copy of it.

select cron.schedule(
  'sef-pull-quarter-hourly',
  '*/15 5-17 * * *',
  $job$ select public.run_processor_sync('sef-pull', true) $job$
);

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
declare
  w    record;
  cmd  text;
  cid  uuid;
begin
  -- The restrictive policy new tables must have.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'sef_inbox'
       and policyname = 'members_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'sef_inbox is missing its members_only policy';
  end if;

  -- anon was closed in 20261008151000 and must not be reopened here.
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon' and table_name = 'sef_inbox'
  ) then
    raise exception 'anon was granted rights on sef_inbox';
  end if;

  -- A signed-in account may change the four columns a decision is made of,
  -- and NOT the link to a booked invoice: a link that can be nulled by hand
  -- is a double-booking guard that can be walked around in one statement.
  if not has_column_privilege('authenticated', 'public.sef_inbox', 'state', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.sef_inbox', 'dismiss_reason', 'UPDATE') then
    raise exception 'a decision cannot be recorded';
  end if;
  if has_column_privilege('authenticated', 'public.sef_inbox', 'imported_invoice_id', 'UPDATE') then
    raise exception 'the link to a booked invoice can be written by hand';
  end if;

  -- The window is 45 days back to today in Belgrade, floored by config.
  select * into w from public.sef_pull_window();
  if w.date_to <> (timezone('Europe/Belgrade', now()))::date then
    raise exception 'the window does not end today in Belgrade';
  end if;
  if w.date_from <> w.date_to - 45 then
    raise exception 'the window is not 45 days';
  end if;

  -- The job is scheduled, active, and calls the pull rather than something
  -- else that happens to be named like it.
  select command into cmd from cron.job
   where jobname = 'sef-pull-quarter-hourly' and active;
  if cmd is null then
    raise exception 'the pull is not scheduled, or is not active';
  end if;
  if cmd not like '%''sef-pull'', true%' then
    raise exception 'the scheduled job does not call sef-pull with force';
  end if;

  -- The server's own spelling. Reading a key the way the published schema
  -- spells it returned null from the live service, every row failed the
  -- invoice-id filter, and the inbox stayed empty with nothing reported.
  if public.jsonb_value_ci('{"InvoiceId": 1}'::jsonb, 'invoiceId') is distinct from '1' then
    raise exception 'the key reader is case-sensitive after all';
  end if;

  -- Everything the pull needs, named here so an empty inbox is explained by a
  -- failed migration rather than found weeks later.
  if to_regclass('public.integration_credentials') is null
     or to_regclass('public.job_config') is null
     or to_regclass('public.processor_sync_runs') is null then
    raise exception 'the scaffolding migration has not been applied';
  end if;

  raise notice 'sef-pull is scheduled; set job_config.functions_base_url and '
               'service_role_key, and integration_credentials for provider sef';
  cid := null;
end $$;

commit;
