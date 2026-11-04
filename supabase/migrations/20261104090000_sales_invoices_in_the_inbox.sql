-- Sales invoices in the inbox.
--
-- The SEF inbox so far holds what the company RECEIVES (purchase invoices).
-- The company also ISSUES invoices through SEF, and those come back the same
-- way: a scheduled pull reads the headers, the accountants decide what to book.
-- So the one table carries both, told apart by `direction`:
--
--   purchase  what the company received. Supplier columns are filled.
--   sales     what the company issued. Customer columns are filled instead,
--             plus the issue date and SEF's own comment (a Storno or a
--             rejection arrives with one).
--
-- THE SAME SEF ID CAN APPEAR IN BOTH DIRECTIONS, because a company that bills
-- itself (a group member, a test) sees one invoice as sent and as received. So
-- the row is keyed by (company, direction, SEF id), not by (company, SEF id).
--
-- ONE NUMBER PER REVENUE INVOICE. The numbers of issued invoices are given by
-- the company itself, not by a supplier, so the rule is per company (and
-- document type), not per customer: two live revenue invoices of one company
-- with the same folded number, and the same document type, are refused.
-- Proformas are not invoice numbers and are left out.

begin;

-- ── The columns ────────────────────────────────────────────────────────────

alter table public.sef_inbox
  add column if not exists direction text not null default 'purchase',
  add column if not exists customer_name text,
  add column if not exists customer_vat_number text,
  add column if not exists customer_registration_number text,
  add column if not exists issue_date date,
  add column if not exists sef_comment text;

alter table public.sef_inbox drop constraint if exists sef_inbox_direction_check;
alter table public.sef_inbox add constraint sef_inbox_direction_check
  check (direction in ('purchase', 'sales'));

-- `authenticated` keeps its column grant on the four decision columns and gets
-- nothing on these: the pull writes them as service_role.

drop index if exists public.sef_inbox_one_row_per_invoice;
create unique index sef_inbox_one_row_per_invoice
  on public.sef_inbox (company_id, direction, sef_invoice_id);

-- ── The purchase pull: the body from 20261015100000, now saying 'purchase' ──

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
      company_id, direction, sef_invoice_id, cir_invoice_id, glob_uniq_id,
      document_number, document_type, supplier_name,
      supplier_vat_number, supplier_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      delivery_date, due_date, sent_date, sef_status, overview_json)
    select
      p_company_id, 'purchase', i.sef_invoice_id, i.cir_invoice_id, i.glob_uniq_id,
      i.document_number, i.document_type, i.supplier_name,
      i.supplier_vat_number, i.supplier_registration_number,
      i.amount, i.sum_without_vat, i.vat_amount, i.currency,
      i.delivery_date, i.due_date, i.sent_date, i.sef_status, i.overview_json
      from incoming i
    on conflict (company_id, direction, sef_invoice_id) do update set
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

revoke all on function public.sef_inbox_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_inbox_upsert(uuid, jsonb) to service_role;

-- ── The sales pull ─────────────────────────────────────────────────────────
--
-- Keys are camelCase, as the edge function sends them. `jsonb_value_ci` is
-- used anyway so a differently cased key does not empty the inbox.

create or replace function public.sef_sales_upsert(
  p_company_id uuid,
  p_rows       jsonb)
returns table (seen int, inserted int)
language plpgsql
security definer
set search_path = public
as $$
begin
  with incoming as (
    -- DISTINCT for the same reason as the purchase side: one array may carry
    -- an invoice twice and `on conflict do update` refuses to touch a row twice
    -- in one statement. The later position wins.
    select distinct on (sef_invoice_id)
      sef_invoice_id, status, comment, cir_invoice_id, glob_uniq_id,
      document_number, document_type, customer_name, customer_vat_number,
      customer_registration_number, amount, sum_without_vat, vat_amount,
      currency, issue_date, delivery_date, due_date, overview_json, pos
      from (
      select
        (public.jsonb_value_ci(r, 'sefInvoiceId'))::bigint                    as sef_invoice_id,
        public.jsonb_value_ci(r, 'status')                                    as status,
        public.jsonb_value_ci(r, 'comment')                                   as comment,
        public.jsonb_value_ci(r, 'cirInvoiceId')                              as cir_invoice_id,
        public.jsonb_value_ci(r, 'globUniqId')                                as glob_uniq_id,
        public.jsonb_value_ci(r, 'documentNumber')                            as document_number,
        public.jsonb_value_ci(r, 'documentType')                              as document_type,
        public.jsonb_value_ci(r, 'customerName')                              as customer_name,
        public.jsonb_value_ci(r, 'customerVatNumber')                         as customer_vat_number,
        public.jsonb_value_ci(r, 'customerRegistrationNumber')                as customer_registration_number,
        case when btrim(public.jsonb_value_ci(r, 'amount')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'amount'))::numeric end          as amount,
        case when btrim(public.jsonb_value_ci(r, 'sumWithoutVat')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'sumWithoutVat'))::numeric end   as sum_without_vat,
        case when btrim(public.jsonb_value_ci(r, 'vatAmount')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'vatAmount'))::numeric end       as vat_amount,
        public.jsonb_value_ci(r, 'currency')                                  as currency,
        case when public.jsonb_value_ci(r, 'issueDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'issueDate'))::timestamptz at time zone 'Europe/Belgrade')::date end as issue_date,
        case when public.jsonb_value_ci(r, 'deliveryDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'deliveryDate'))::timestamptz at time zone 'Europe/Belgrade')::date end as delivery_date,
        case when public.jsonb_value_ci(r, 'dueDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'dueDate'))::timestamptz at time zone 'Europe/Belgrade')::date end      as due_date,
        r                                                                     as overview_json,
        e.pos                                                                 as pos
        from jsonb_array_elements(p_rows) with ordinality as e(r, pos)
       where public.jsonb_value_ci(r, 'sefInvoiceId') ~ '^-?[0-9]+$'
    ) q
    order by sef_invoice_id, pos desc
  ),
  merged as (
    insert into public.sef_inbox as t (
      company_id, direction, sef_invoice_id, cir_invoice_id, glob_uniq_id,
      document_number, document_type, customer_name,
      customer_vat_number, customer_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      issue_date, delivery_date, due_date, sent_date, sef_status, sef_comment,
      overview_json)
    select
      p_company_id, 'sales', i.sef_invoice_id, i.cir_invoice_id, i.glob_uniq_id,
      i.document_number, i.document_type, i.customer_name,
      i.customer_vat_number, i.customer_registration_number,
      i.amount, i.sum_without_vat, i.vat_amount, i.currency,
      i.issue_date, i.delivery_date, i.due_date,
      -- The window runs on `sent_date`; for an issued invoice that is the issue
      -- date, at midnight in Belgrade.
      case when i.issue_date is not null
           then i.issue_date::timestamp at time zone 'Europe/Belgrade' end,
      i.status, i.comment, i.overview_json
      from incoming i
    on conflict (company_id, direction, sef_invoice_id) do update set
      -- ALWAYS, whatever has been decided: the status is what SEF says now.
      sef_status   = coalesce(excluded.sef_status, t.sef_status),
      sef_comment  = coalesce(excluded.sef_comment, t.sef_comment),
      last_seen_at = now(),
      -- The header only while the row is still to be decided.
      cir_invoice_id               = case when t.state = 'pending' then excluded.cir_invoice_id               else t.cir_invoice_id               end,
      glob_uniq_id                 = case when t.state = 'pending' then excluded.glob_uniq_id                 else t.glob_uniq_id                 end,
      document_number              = case when t.state = 'pending' then excluded.document_number              else t.document_number              end,
      document_type                = case when t.state = 'pending' then excluded.document_type                else t.document_type                end,
      customer_name                = case when t.state = 'pending' then excluded.customer_name                else t.customer_name                end,
      customer_vat_number          = case when t.state = 'pending' then excluded.customer_vat_number          else t.customer_vat_number          end,
      customer_registration_number = case when t.state = 'pending' then excluded.customer_registration_number else t.customer_registration_number end,
      amount                       = case when t.state = 'pending' then excluded.amount                       else t.amount                       end,
      sum_without_vat              = case when t.state = 'pending' then excluded.sum_without_vat              else t.sum_without_vat              end,
      vat_amount                   = case when t.state = 'pending' then excluded.vat_amount                   else t.vat_amount                   end,
      currency                     = case when t.state = 'pending' then excluded.currency                     else t.currency                     end,
      issue_date                   = case when t.state = 'pending' then excluded.issue_date                   else t.issue_date                   end,
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

revoke all on function public.sef_sales_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_sales_upsert(uuid, jsonb) to service_role;

-- Status changes SEF reports on invoices already pulled. Only existing sales
-- rows: an id nobody pulled is skipped, never invented from a status alone.
create or replace function public.sef_sales_status(
  p_company_id uuid,
  p_updates    jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with u as (
    select distinct on (sef_invoice_id) sef_invoice_id, status, comment
      from (
        select (public.jsonb_value_ci(r, 'sefInvoiceId'))::bigint as sef_invoice_id,
               public.jsonb_value_ci(r, 'status')                 as status,
               public.jsonb_value_ci(r, 'comment')                as comment,
               e.pos                                              as pos
          from jsonb_array_elements(p_updates) with ordinality as e(r, pos)
         where public.jsonb_value_ci(r, 'sefInvoiceId') ~ '^-?[0-9]+$'
      ) q
     order by sef_invoice_id, pos desc
  ),
  changed as (
    update public.sef_inbox t
       set sef_status   = coalesce(u.status, t.sef_status),
           sef_comment  = coalesce(u.comment, t.sef_comment),
           last_seen_at = now()
      from u
     where t.company_id = p_company_id
       and t.direction = 'sales'
       and t.sef_invoice_id = u.sef_invoice_id
    returning 1
  )
  select count(*)::int into n from changed;
  return n;
end $$;

revoke all on function public.sef_sales_status(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_sales_status(uuid, jsonb) to service_role;

-- ── Booking a row: the direction has to match the invoice ──────────────────
--
-- The body from 20261018150000, with the direction check in front of the
-- update. A sales row is tied to a revenue invoice only, a purchase row to an
-- expense invoice only, and a sales invoice SEF has cancelled is not booked.

create or replace function public.sef_inbox_mark_imported(p_id uuid, p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_direction text;
  v_status    text;
  v_type      text;
begin
  if not public.can_write_books() then
    raise exception 'Samo finansijski tim može da označi SEF fakturu kao proknjiženu.'
      using errcode = 'insufficient_privilege';
  end if;
  select i.type into v_type from public.invoices i
   where i.id = p_invoice_id and i.deleted_at is null;
  if not found then
    raise exception 'There is no live invoice % to mark this row against.', p_invoice_id;
  end if;

  select s.direction, s.sef_status into v_direction, v_status
    from public.sef_inbox s where s.id = p_id;
  if found then
    if v_direction = 'sales' and v_type is distinct from 'revenue' then
      raise exception 'Izlazna faktura sa SEF-a se vezuje samo za izlaznu fakturu u knjigama.';
    end if;
    if v_direction = 'purchase' and v_type is distinct from 'expense' then
      raise exception 'Ulazna faktura sa SEF-a se vezuje samo za ulaznu fakturu u knjigama.';
    end if;
    if v_direction = 'sales' and lower(coalesce(v_status, '')) in ('cancelled', 'storno', 'rejected') then
      raise exception 'Faktura je stornirana, otkazana ili odbijena na SEF-u i ne knjiži se.';
    end if;
  end if;

  update public.sef_inbox
     set state = 'imported',
         imported_invoice_id = p_invoice_id,
         imported_at = now()
   where id = p_id
     and state = 'pending'
     and imported_invoice_id is null;
  if not found then
    raise exception
      'That row is not waiting to be booked — it is already decided, or already linked to an invoice.';
  end if;
end
$$;

revoke all on function public.sef_inbox_mark_imported(uuid, uuid) from public, anon;
grant execute on function public.sef_inbox_mark_imported(uuid, uuid) to authenticated;

-- ── One number per revenue invoice ─────────────────────────────────────────

create or replace function public.invoices_one_per_own_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_key text;
  v_other record;
begin
  if new.type <> 'revenue' or new.document_type = 'proforma' or new.deleted_at is not null then
    return new;
  end if;
  v_key := public.invoice_number_key(new.invoice_number);
  if v_key is null then
    return new;
  end if;
  -- An edit that leaves the number, the company, the type and the document
  -- type alone is not checked, so a pair already in the books can be corrected.
  if tg_op = 'UPDATE'
     and new.invoice_number is not distinct from old.invoice_number
     and new.company_id is not distinct from old.company_id
     and new.type = old.type
     and new.document_type is not distinct from old.document_type
     and old.deleted_at is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'own|' || coalesce(new.company_id::text, '') || '|' || new.document_type || '|' || v_key, 0));

  select i.invoice_number, i.invoice_date into v_other
    from public.invoices i
   where i.id <> new.id
     and i.deleted_at is null
     and i.type = 'revenue'
     and i.document_type = new.document_type
     and i.company_id is not distinct from new.company_id
     and public.invoice_number_key(i.invoice_number) = v_key
   limit 1;
  if found then
    raise exception 'Izlazna faktura broj % je već proknjižena (broj „%“, datum %). Isti broj se ne knjiži dva puta.',
      new.invoice_number, v_other.invoice_number, to_char(v_other.invoice_date, 'DD.MM.YYYY')
      using errcode = 'unique_violation';
  end if;
  return new;
end $$;

drop trigger if exists invoices_one_per_own_number on public.invoices;
create trigger invoices_one_per_own_number
  before insert or update of invoice_number, company_id, type, document_type, deleted_at on public.invoices
  for each row execute function public.invoices_one_per_own_number();

revoke all on function public.invoices_one_per_own_number() from public, anon, authenticated;

create index if not exists invoices_own_number_idx
  on public.invoices (company_id, document_type, public.invoice_number_key(invoice_number))
  where deleted_at is null and type = 'revenue';

-- ── The schedule ───────────────────────────────────────────────────────────
--
-- Beside the purchase pull, on the same quarter hours, only where that one is
-- scheduled and active. `cron.schedule` is upsert-by-name.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sef-pull-quarter-hourly' and active) then
    perform cron.schedule(
      'sef-pull-sales-quarter-hourly',
      '*/15 5-17 * * *',
      $job$ select public.run_processor_sync('sef-pull-sales', true) $job$
    );
  end if;
end $$;

-- ── Existing duplicates: reported, not fixed ───────────────────────────────

do $$
declare
  n int;
begin
  select count(*) into n from (
    select 1 from public.invoices
     where type = 'revenue' and document_type <> 'proforma' and deleted_at is null
       and public.invoice_number_key(invoice_number) is not null
     group by company_id, document_type, public.invoice_number_key(invoice_number)
    having count(*) > 1
  ) d;
  if n > 0 then
    raise notice '% revenue invoice number(s) are already booked more than once; they stay as they are and can be corrected one by one.', n;
  end if;
end $$;

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from pg_index x
        join pg_class c on c.oid = x.indexrelid
       where c.relname = 'sef_inbox_one_row_per_invoice' and x.indisunique
         and x.indnatts = 3) <> 1 then
    raise exception 'sef_inbox_one_row_per_invoice is not unique over three columns';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'sef_inbox'
       and policyname = 'members_only' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'sef_inbox is missing its members_only policy';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon' and table_name = 'sef_inbox'
  ) then
    raise exception 'anon was granted rights on sef_inbox';
  end if;
  if has_column_privilege('authenticated', 'public.sef_inbox', 'direction', 'UPDATE')
     or has_column_privilege('authenticated', 'public.sef_inbox', 'customer_name', 'UPDATE') then
    raise exception 'a signed-in account can write the direction or the customer';
  end if;
  if has_function_privilege('authenticated', 'public.sef_sales_upsert(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.sef_sales_upsert(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.sef_sales_status(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.sef_sales_status(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.sef_inbox_upsert(uuid, jsonb)', 'execute') then
    raise exception 'a pull function is callable by a signed-in account';
  end if;
  if not has_function_privilege('service_role', 'public.sef_sales_upsert(uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.sef_sales_status(uuid, jsonb)', 'execute') then
    raise exception 'the service role cannot call the sales pull functions';
  end if;
end $$;

commit;
