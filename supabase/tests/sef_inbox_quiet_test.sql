-- Tests for 20261122090000_the_inbox_writes_only_what_changed.sql.
--
-- The new `sef_inbox_upsert` must leave every row exactly as the old one did
-- (all columns but last_seen_at), report the same counts, and write no row
-- version when SEF shows nothing new -- whatever the status. The key fold in
-- it and in `sef_sales_upsert` must read exactly what jsonb_value_ci read,
-- keys that differ only in case included; the sales body must still write
-- every listed row.
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/sef_inbox_quiet_test.sql; rollback;
-- Safe on a live database: fixtures only (companies "Test SEF stari (TEST-SQ)"
-- and "Test SEF novi (TEST-SQ)", invented suppliers and customers), helper
-- functions named sefq_*, always rolled back. Run as the database owner. Ends
-- with ALL TESTS PASSED.

\set ON_ERROR_STOP on

-- ══ The old bodies, verbatim from 20261104090000, under test names ══════════

create function public.sefq_upsert_old(
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

create function public.sefq_sales_old(
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

-- ══ The comparison: one payload through both bodies ═════════════════════════
--
-- Company A takes every payload through the old body, company B through the
-- new one. After each step the counts must be the same and every row the
-- same in every column except id, company_id and last_seen_at (compared as
-- the text of the whole row, so a JSON figure written 1.0 and 1.00 differs).
-- The step reports what each body WROTE: the rows whose ctid moved (a new
-- version, HOT or not) and the table's n_tup_upd for this transaction.
-- p_kind 'sales' compares sefq_sales_old with sef_sales_upsert instead.

create function public.sefq_rows(p_co uuid)
returns setof text
language sql
as $$
  select (to_jsonb(s) - 'id' - 'company_id' - 'last_seen_at')::text
    from public.sef_inbox s
   where s.company_id = p_co
$$;

create function public.sefq_ctids(p_co uuid)
returns jsonb
language sql
as $$
  select coalesce(jsonb_object_agg(direction || ':' || sef_invoice_id, ctid::text), '{}'::jsonb)
    from public.sef_inbox where company_id = p_co
$$;

create function public.sefq_updates()
returns bigint
language sql
as $$
  select coalesce((select n_tup_upd from pg_stat_xact_user_tables
                    where relid = 'public.sef_inbox'::regclass), 0)
$$;

create function public.sefq_step(p_label text, p_rows jsonb, p_kind text default 'purchase')
returns jsonb
language plpgsql
as $$
declare
  a uuid := current_setting('sq.a')::uuid;
  b uuid := current_setting('sq.b')::uuid;
  o jsonb; n jsonb;
  c0 jsonb; c1 jsonb; u0 bigint; old_upd bigint; new_upd bigint;
  moved_new text[]; moved_old text[]; d int;
begin
  c0 := public.sefq_ctids(a); u0 := public.sefq_updates();
  if p_kind = 'sales' then
    select to_jsonb(x) into o from public.sefq_sales_old(a, p_rows) x;
  else
    select to_jsonb(x) into o from public.sefq_upsert_old(a, p_rows) x;
  end if;
  old_upd := public.sefq_updates() - u0;
  c1 := public.sefq_ctids(a);
  select coalesce(array_agg(split_part(k, ':', 2) order by k), '{}') into moved_old
    from jsonb_each_text(c0) e(k, v) where c1 ->> k is distinct from v;

  c0 := public.sefq_ctids(b); u0 := public.sefq_updates();
  if p_kind = 'sales' then
    select to_jsonb(x) into n from public.sef_sales_upsert(b, p_rows) x;
  else
    select to_jsonb(x) into n from public.sef_inbox_upsert(b, p_rows) x;
  end if;
  new_upd := public.sefq_updates() - u0;
  c1 := public.sefq_ctids(b);
  select coalesce(array_agg(split_part(k, ':', 2) order by k), '{}') into moved_new
    from jsonb_each_text(c0) e(k, v) where c1 ->> k is distinct from v;

  if o is distinct from n then
    raise exception 'FAIL [%]: counts differ: old % new %', p_label, o, n;
  end if;

  select count(*) into d from (
    (select public.sefq_rows(a) except all select public.sefq_rows(b))
    union all
    (select public.sefq_rows(b) except all select public.sefq_rows(a))) x;
  if d <> 0 then
    raise exception 'FAIL [%]: % row text(s) differ between the old and the new body: %', p_label, d,
      (select string_agg(r, E'\n') from (
         (select public.sefq_rows(a) r except all select public.sefq_rows(b))
         union all
         (select public.sefq_rows(b) except all select public.sefq_rows(a))) y);
  end if;

  return n || jsonb_build_object(
    'old_upd', old_upd, 'new_upd', new_upd,
    'moved_old', to_jsonb(moved_old), 'moved_new', to_jsonb(moved_new));
end $$;

-- A payload the bodies must REFUSE: both must fail with the same message, and
-- neither may leave anything behind.
create function public.sefq_refused(p_label text, p_rows jsonb, p_kind text default 'purchase')
returns text
language plpgsql
as $$
declare
  a uuid := current_setting('sq.a')::uuid;
  b uuid := current_setting('sq.b')::uuid;
  m1 text; m2 text; before bigint; after bigint;
begin
  select count(*) into before from public.sef_inbox where company_id in (a, b);
  begin
    if p_kind = 'sales' then perform public.sefq_sales_old(a, p_rows); else perform public.sefq_upsert_old(a, p_rows); end if;
  exception when others then m1 := sqlerrm; end;
  begin
    if p_kind = 'sales' then perform public.sef_sales_upsert(b, p_rows); else perform public.sef_inbox_upsert(b, p_rows); end if;
  exception when others then m2 := sqlerrm; end;
  select count(*) into after from public.sef_inbox where company_id in (a, b);
  if m1 is null or m1 is distinct from m2 or before <> after then
    raise exception 'FAIL [%]: old [%] new [%], rows % -> %', p_label, m1, m2, before, after;
  end if;
  return m2;
end $$;

-- What both companies get by hand, between steps: the owner's decisions.
create function public.sefq_both(p_sql text)
returns void
language plpgsql
as $$
begin
  execute format(p_sql, current_setting('sq.a')::uuid);
  execute format(p_sql, current_setting('sq.b')::uuid);
end $$;

do $$
declare v_a uuid; v_b uuid;
begin
  insert into public.companies (name, country, currency)
  values ('Test SEF stari (TEST-SQ)', 'Srbija', 'RSD') returning id into v_a;
  insert into public.companies (name, country, currency)
  values ('Test SEF novi (TEST-SQ)', 'Srbija', 'RSD') returning id into v_b;
  perform set_config('sq.a', v_a::text, true);
  perform set_config('sq.b', v_b::text, true);
end $$;

-- ══ 1. New invoices, and ids that cannot be keyed ═══════════════════════════

do $$
declare r jsonb;
begin
  r := public.sefq_step('1 new', '[
    {"InvoiceId": 1001, "Status": "New",      "SupplierName": "Dobavljač A", "SupplierVatRegistrationNumber": "100000001",
     "Amount": 1200, "SumWithoutVat": 1000, "VatAmount": 200, "Currency": "RSD", "DocumentNumber": "A-1/2026",
     "DeliveryDate": "2026-11-02T00:00:00+01:00", "DueDate": "2026-12-02", "SentDate": "2026-11-03T09:15:00+01:00"},
    {"InvoiceId": 1002, "Status": "Seen",     "SupplierName": "Dobavljač B", "Amount": 1200},
    {"InvoiceId": 1003, "Status": "Approved", "SupplierName": "Dobavljač C", "Amount": 500},
    {"InvoiceId": 1004, "Status": "New",      "SupplierName": "Dobavljač D", "Amount": 700},
    {"InvoiceId": 1005, "Status": "New",      "SupplierName": "Dobavljač E", "Amount": 800},
    {"InvoiceId": 1006, "Status": "Approved", "SupplierName": "Dobavljač F", "Amount": 900},
    {"InvoiceId": 1008, "Status": "Seen",     "SupplierName": "Dobavljač G", "Amount": 100},
    {"InvoiceId": "abc", "Status": "New"},
    {"Status": "New", "SupplierName": "bez broja"}
  ]'::jsonb);
  assert (r->>'seen')::int = 7 and (r->>'inserted')::int = 7 and (r->>'skipped')::int = 2,
    'step 1 counts: ' || r::text;
  assert (r->>'new_upd')::int = 0, 'step 1 updated something: ' || r::text;

  -- The owner decides: 1004 booked, 1005 declined, 1006 accepted on SEF
  -- through the app and booked. 1003 is Approved on SEF with no decision from
  -- the app and still pending.
  perform public.sefq_both($s$update public.sef_inbox set state = 'imported', imported_at = now()
                              where company_id = %L and sef_invoice_id = 1004$s$);
  perform public.sefq_both($s$update public.sef_inbox set state = 'dismissed', dismiss_reason = 'nije naša', dismissed_at = now()
                              where company_id = %L and sef_invoice_id = 1005$s$);
  perform public.sefq_both($s$update public.sef_inbox set sef_decision = 'accepted', sef_decided_at = now(),
                                     state = 'imported', imported_at = now()
                              where company_id = %L and sef_invoice_id = 1006$s$);
  raise notice '1 ok';
end $$;

-- ══ 2. The same payload again ═══════════════════════════════════════════════

do $$
declare r jsonb; p jsonb;
begin
  p := '[
    {"InvoiceId": 1001, "Status": "New",      "SupplierName": "Dobavljač A", "SupplierVatRegistrationNumber": "100000001",
     "Amount": 1200, "SumWithoutVat": 1000, "VatAmount": 200, "Currency": "RSD", "DocumentNumber": "A-1/2026",
     "DeliveryDate": "2026-11-02T00:00:00+01:00", "DueDate": "2026-12-02", "SentDate": "2026-11-03T09:15:00+01:00"},
    {"InvoiceId": 1002, "Status": "Seen",     "SupplierName": "Dobavljač B", "Amount": 1200},
    {"InvoiceId": 1003, "Status": "Approved", "SupplierName": "Dobavljač C", "Amount": 500},
    {"InvoiceId": 1004, "Status": "New",      "SupplierName": "Dobavljač D", "Amount": 700},
    {"InvoiceId": 1005, "Status": "New",      "SupplierName": "Dobavljač E", "Amount": 800},
    {"InvoiceId": 1006, "Status": "Approved", "SupplierName": "Dobavljač F", "Amount": 900},
    {"InvoiceId": 1008, "Status": "Seen",     "SupplierName": "Dobavljač G", "Amount": 100},
    {"InvoiceId": "abc", "Status": "New"}
  ]'::jsonb;
  r := public.sefq_step('2 repeat', p);
  assert (r->>'seen')::int = 7 and (r->>'inserted')::int = 0 and (r->>'skipped')::int = 1,
    'step 2 counts: ' || r::text;
  -- The measurement itself works: the old body rewrote all seven.
  assert (r->>'old_upd')::int = 7 and jsonb_array_length(r->'moved_old') = 7,
    'the old body did not rewrite the seven (the measurement is broken): ' || r::text;
  -- THE POINT: the new body writes no row version at all -- 1003 included,
  -- Approved on SEF with no decision from the app: an unchanged status is not
  -- written again, so a trigger on `update of sef_status` does not fire.
  assert (r->>'new_upd')::int = 0 and r->'moved_new' = '[]'::jsonb,
    'the new body rewrote unchanged rows: ' || r::text;

  -- Once more, so a repeat of a repeat is quiet too.
  r := public.sefq_step('2 repeat again', p);
  assert (r->>'new_upd')::int = 0 and r->'moved_new' = '[]'::jsonb, 'second repeat wrote: ' || r::text;
  raise notice '2 ok';
end $$;

-- ══ 3. Status changes ═══════════════════════════════════════════════════════

do $$
declare r jsonb;
begin
  -- 1004 is booked and goes New -> Seen: only the status comparison sees it
  -- (not pending). 1005 is declined and SEF cancels it. 1008 is pending and
  -- goes Seen -> Rejected.
  r := public.sefq_step('3 status', '[
    {"InvoiceId": 1004, "Status": "Seen",      "SupplierName": "Dobavljač D", "Amount": 700},
    {"InvoiceId": 1005, "Status": "Cancelled", "SupplierName": "Dobavljač E", "Amount": 800},
    {"InvoiceId": 1008, "Status": "Rejected",  "SupplierName": "Dobavljač G", "Amount": 100}]'::jsonb);
  assert r->'moved_new' = '["1004", "1005", "1008"]'::jsonb, 'status changes written: ' || r::text;
  assert (select sef_status from public.sef_inbox
           where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1004) = 'Seen',
    'the booked row did not take its new status';
  raise notice '3 ok';
end $$;

-- ══ 4. A pending row's header changes ═══════════════════════════════════════

do $$
declare r jsonb; v numeric; j text;
begin
  -- 1001: the amount. 1002: only the JSON -- the same amount written 1200.00
  -- where SEF sent 1200 before: the column is equal, the document is not
  -- (jsonb's own = calls them equal; the text does not).
  r := public.sefq_step('4 pending figures', '[
    {"InvoiceId": 1001, "Status": "New",  "SupplierName": "Dobavljač A", "SupplierVatRegistrationNumber": "100000001",
     "Amount": 1300, "SumWithoutVat": 1000, "VatAmount": 300, "Currency": "RSD", "DocumentNumber": "A-1/2026",
     "DeliveryDate": "2026-11-02T00:00:00+01:00", "DueDate": "2026-12-02", "SentDate": "2026-11-03T09:15:00+01:00"},
    {"InvoiceId": 1002, "Status": "Seen", "SupplierName": "Dobavljač B", "Amount": 1200.00}]'::jsonb);
  assert r->'moved_new' = '["1001", "1002"]'::jsonb, 'pending header changes written: ' || r::text;
  select amount, overview_json::text into v, j from public.sef_inbox
   where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1002;
  assert v = 1200 and j like '%1200.00%', 'the JSON was not refreshed: ' || j;
  raise notice '4 ok';
end $$;

do $$
declare r jsonb; p jsonb; tz text := current_setting('timezone'); d date;
begin
  -- 4b. The SAME document can still mean a different column: a timestamp with
  -- no offset is read in the session's zone. Only the column comparisons see
  -- this (the JSON is identical), so they are not redundant with it.
  p := '[{"InvoiceId": 1009, "Status": "New", "SupplierName": "Dobavljač I", "Amount": 5,
          "DeliveryDate": "2026-11-02T23:30:00"}]';
  perform set_config('timezone', 'UTC', true);
  r := public.sefq_step('4b in UTC', p);
  assert (r->>'inserted')::int = 1, 'step 4b insert: ' || r::text;
  perform set_config('timezone', 'Europe/Belgrade', true);
  r := public.sefq_step('4b in Belgrade', p);
  perform set_config('timezone', tz, true);
  assert r->'moved_new' = '["1009"]'::jsonb, 'a column that changed under an equal document was not written: ' || r::text;
  select delivery_date into d from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1009;
  assert d = date '2026-11-02', 'delivery_date read in Belgrade: ' || d;
  raise notice '4b ok';
end $$;

-- ══ 5. A decided or booked row's header changes: kept, as before ════════════

do $$
declare r jsonb; v numeric; s text;
begin
  -- None of the three is pending and no status changes: no row version.
  -- 1005 is Cancelled with no decision from the app; that alone writes nothing.
  r := public.sefq_step('5 decided figures', '[
    {"InvoiceId": 1004, "Status": "Seen",      "SupplierName": "Dobavljač D izmenjen", "Amount": 7777},
    {"InvoiceId": 1005, "Status": "Cancelled", "SupplierName": "Dobavljač E izmenjen", "Amount": 8888},
    {"InvoiceId": 1006, "Status": "Approved",  "SupplierName": "Dobavljač F izmenjen", "Amount": 9999}]'::jsonb);
  assert r->'moved_new' = '[]'::jsonb and (r->>'new_upd')::int = 0, 'decided rows written: ' || r::text;
  select amount, supplier_name into v, s from public.sef_inbox
   where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1004;
  assert v = 700 and s = 'Dobavljač D', 'the booked figures were overwritten: ' || v || ' ' || s;
  select amount, supplier_name into v, s from public.sef_inbox
   where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1005;
  assert v = 800 and s = 'Dobavljač E', 'the declined figures were overwritten: ' || v || ' ' || s;
  select amount, supplier_name into v, s from public.sef_inbox
   where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1006;
  assert v = 900 and s = 'Dobavljač F', 'the accepted figures were overwritten: ' || v || ' ' || s;
  raise notice '5 ok';
end $$;

-- ══ 6. One invoice twice in one payload: the later wins ═════════════════════

do $$
declare r jsonb; v numeric;
begin
  r := public.sefq_step('6 duplicates', '[
    {"InvoiceId": 1001, "Status": "New", "SupplierName": "Dobavljač A", "Amount": 1400},
    {"InvoiceId": 1007, "Status": "New", "SupplierName": "Dobavljač H", "Amount": 10},
    {"InvoiceId": 1001, "Status": "New", "SupplierName": "Dobavljač A", "Amount": 1500},
    {"InvoiceId": 1007, "Status": "New", "SupplierName": "Dobavljač H", "Amount": 20}]'::jsonb);
  assert (r->>'seen')::int = 2 and (r->>'inserted')::int = 1 and (r->>'skipped')::int = 0, 'step 6 counts: ' || r::text;
  select amount into v from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1001;
  assert v = 1500, 'the later duplicate did not win: ' || v;
  select amount into v from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1007;
  assert v = 20, 'the later duplicate of a new invoice did not win: ' || v;
  raise notice '6 ok';
end $$;

-- ══ 7. No status key ════════════════════════════════════════════════════════

do $$
declare r jsonb; s text;
begin
  -- 1004 (booked): nothing it would take differs -- not written, status kept.
  -- 1007 (pending): its JSON no longer has the key, so it is written, and the
  -- status is still kept.
  r := public.sefq_step('7 no status', '[
    {"InvoiceId": 1004, "SupplierName": "Dobavljač D", "Amount": 700},
    {"InvoiceId": 1007, "SupplierName": "Dobavljač H", "Amount": 20}]'::jsonb);
  assert r->'moved_new' = '["1007"]'::jsonb, 'no-status writes: ' || r::text;
  select sef_status into s from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1007;
  assert s = 'New', 'a missing status blanked the stored one: ' || coalesce(s, 'null');
  raise notice '7 ok';
end $$;

-- ══ 8. Ids that cannot be keyed: skipped and counted ════════════════════════

do $$
declare r jsonb;
begin
  r := public.sefq_step('8 unkeyable', '[
    {"InvoiceId": "12a", "Status": "New"},
    {"InvoiceId": null, "Status": "New"},
    {"invoiceid": " 5", "Status": "New"},
    {"Status": "New"},
    {},
    {"InvoiceId": 1002, "Status": "Seen", "SupplierName": "Dobavljač B", "Amount": 1200.00}]'::jsonb);
  assert (r->>'seen')::int = 1 and (r->>'inserted')::int = 0 and (r->>'skipped')::int = 5, 'step 8 counts: ' || r::text;
  assert r->'moved_new' = '[]'::jsonb, 'step 8 wrote: ' || r::text;
  r := public.sefq_step('8 empty array', '[]'::jsonb);
  assert (r->>'seen')::int = 0 and (r->>'inserted')::int = 0 and (r->>'skipped')::int = 0, 'empty array counts: ' || r::text;
  raise notice '8 ok';
end $$;

-- ══ 9. Last seen more than a day ago ════════════════════════════════════════

do $$
declare r jsonb; t timestamptz;
begin
  -- Nothing SEF sends differs from what the rows hold; only their age.
  -- (1008 is Rejected with no decision from the app: no reason to write.)
  perform public.sefq_both($s$update public.sef_inbox set last_seen_at = now() - interval '2 days'
                              where company_id = %L and sef_invoice_id = 1002$s$);
  perform public.sefq_both($s$update public.sef_inbox set last_seen_at = now() - interval '25 hours'
                              where company_id = %L and sef_invoice_id = 1004$s$);
  perform public.sefq_both($s$update public.sef_inbox set last_seen_at = now() - interval '23 hours'
                              where company_id = %L and sef_invoice_id = 1008$s$);
  r := public.sefq_step('9 last seen', '[
    {"InvoiceId": 1002, "Status": "Seen",     "SupplierName": "Dobavljač B", "Amount": 1200.00},
    {"InvoiceId": 1004, "SupplierName": "Dobavljač D", "Amount": 700},
    {"InvoiceId": 1008, "Status": "Rejected", "SupplierName": "Dobavljač G", "Amount": 100}]'::jsonb);
  -- Over a day (2 days, 25 hours): written, and stamped now.
  assert r->'moved_new' = '["1002", "1004"]'::jsonb and (r->>'new_upd')::int = 2,
    'only the rows last seen over a day ago are written: ' || r::text;
  select last_seen_at into t from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1002;
  assert t = now(), '1002 not stamped: ' || t;
  select last_seen_at into t from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1004;
  assert t = now(), '1004 not stamped: ' || t;
  -- Under a day (23 hours): left alone, last_seen_at with it. The old body
  -- stamped it; that is the one column allowed to differ.
  select last_seen_at into t from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id = 1008;
  assert t = now() - interval '23 hours', 'last_seen_at of a row seen 23 hours ago moved: ' || t;
  select last_seen_at into t from public.sef_inbox where company_id = current_setting('sq.a')::uuid and sef_invoice_id = 1008;
  assert t = now(), 'the old body no longer stamps (the comparison is broken): ' || t;
  raise notice '9 ok';
end $$;

-- ══ 10. The functions as the catalogue holds them ═══════════════════════════

do $$
declare f regprocedure;
begin
  foreach f in array array['public.sef_inbox_upsert(uuid, jsonb)'::regprocedure,
                           'public.sef_sales_upsert(uuid, jsonb)'::regprocedure]
  loop
    assert (select prosecdef from pg_proc where oid = f), f || ' not SECURITY DEFINER';
    assert (select proconfig from pg_proc where oid = f) = array['search_path=public'], f || ' search_path changed';
    assert not has_function_privilege('anon', f, 'execute'), 'anon may call ' || f;
    assert not has_function_privilege('authenticated', f, 'execute'), 'a signed-in account may call ' || f;
    assert has_function_privilege('service_role', f, 'execute'), 'the service role may not call ' || f;
  end loop;
  assert pg_get_function_result('public.sef_inbox_upsert(uuid, jsonb)'::regprocedure)
           = 'TABLE(seen integer, inserted integer, skipped integer)', 'purchase result changed';
  assert pg_get_function_result('public.sef_sales_upsert(uuid, jsonb)'::regprocedure)
           = 'TABLE(seen integer, inserted integer)', 'sales result changed';
  raise notice '10 ok';
end $$;

-- ══ 11. The key fold reads exactly what jsonb_value_ci read (purchase) ══════

do $$
declare r jsonb; x record;
begin
  -- 11a. Keys that differ only in case. jsonb_value_ci returned the FIRST in
  -- jsonb's storage order (shorter key first, then bytewise: upper before
  -- lower), whatever order the text had them in.
  r := public.sefq_step('11a case duplicates', '[
    {"invoiceid": 1102, "InvoiceId": 1101, "amount": 2, "AMOUNT": 3, "Amount": 1,
     "status": "Seen", "Status": "New", "suppliername": "Dobavljač K", "SupplierName": "Dobavljač J",
     "DUEDATE": "2026-12-01", "dueDate": "2026-12-02", "duedate": "2026-12-03"}]'::jsonb);
  select sef_invoice_id, amount, sef_status, supplier_name, due_date into x
    from public.sef_inbox where company_id = current_setting('sq.b')::uuid and sef_invoice_id in (1101, 1102);
  assert x.sef_invoice_id = 1101 and x.amount = 3 and x.sef_status = 'New'
         and x.supplier_name = 'Dobavljač J' and x.due_date = date '2026-12-01',
    'case duplicates read the wrong key: ' || row(x.*)::text;

  -- 11b. Missing keys and nulls: null columns, the row still lands.
  r := public.sefq_step('11b missing and null', '[
    {"InvoiceId": 1103},
    {"InvoiceId": 1104, "Amount": null, "Status": null, "SupplierName": null, "DueDate": null, "Comment": null},
    {"INVOICEID": "1105", "STATUS": "New"}]'::jsonb);
  assert (r->>'inserted')::int = 3, '11b inserts: ' || r::text;

  -- 11c. Every JSON type where a figure, a text and a date are read.
  r := public.sefq_step('11c types', '[
    {"InvoiceId": 1106, "Amount": " 12.50 ", "SumWithoutVat": "abc", "VatAmount": {"x": 1},
     "Currency": true, "SupplierName": "  razmak  ", "DocumentNumber": "", "DocumentType": [1, "2"],
     "CirInvoiceId": 77, "GlobUniqId": "a\"b é", "Status": "New"},
    {"InvoiceId": -3, "Amount": -0.5, "SumWithoutVat": 1e3, "VatAmount": "1e3", "Status": "Seen"}]'::jsonb);

  -- 11d. Dates in every shape the guard accepts or refuses.
  r := public.sefq_step('11d dates', '[
    {"InvoiceId": 1107, "DeliveryDate": "2026-11-02",                "DueDate": "2026-11-02T23:30:00",      "SentDate": "2026-11-02T22:30:00Z"},
    {"InvoiceId": 1108, "DeliveryDate": "2026-11-02T23:30:00+01:00", "DueDate": "2026-11-02 08:00",         "SentDate": "2026-11-02T10:15:30.123+0100"},
    {"InvoiceId": 1109, "DeliveryDate": "02.11.2026",                "DueDate": null,                       "SentDate": "nije datum"},
    {"InvoiceId": 1110, "deliverydate": "2026-11-30T23:59:59-05:00", "DUEDATE": "2026-12-31T23:00:00Z",     "sentdate": 20261102}]'::jsonb);

  -- 11e. A generated grid: every key in four casings by turn, the id repeated
  -- (the later wins), every third row carrying a second casing of three keys
  -- with another value, figures and dates of every kind.
  r := public.sefq_step('11e grid', (
    select jsonb_agg(o order by g) from (
      select g, (select jsonb_object_agg(k, v) from (
          select case (g + i) % 4 when 0 then c when 1 then lower(c) when 2 then upper(c)
                                  else lower(left(c, 1)) || substr(c, 2) end as k,
                 case c
                   when 'InvoiceId' then to_jsonb(1200 + g % 17)
                   when 'Amount' then (array['1200', '"1200.5"', '" 99 "', '"abc"', 'null', '{"x": 1}', '-0.5'])[1 + g % 7]::jsonb
                   when 'DeliveryDate' then (array['"2026-11-02"', '"2026-11-02T23:30:00"', '"2026-11-02T23:30:00+01:00"', '"x"', 'null'])[1 + g % 5]::jsonb
                   when 'Status' then (array['"New"', '"Seen"', '"Approved"', 'null', '"Storno"'])[1 + g % 5]::jsonb
                   else to_jsonb(c || '-' || g)
                 end as v
            from unnest(array['InvoiceId', 'CirInvoiceId', 'GlobUniqId', 'DocumentNumber', 'DocumentType',
                              'SupplierName', 'SupplierVatRegistrationNumber', 'SupplierRegistrationNumber',
                              'Amount', 'SumWithoutVat', 'VatAmount', 'Currency', 'DeliveryDate', 'DueDate',
                              'SentDate', 'Status']) with ordinality as u(c, i)
           where g > 0
          union all
          select upper(c) || '', to_jsonb('drugi-' || g)
            from unnest(array['SupplierName', 'DocumentNumber', 'Status']) c
           where g % 3 = 0) kv) as o
        from generate_series(1, 60) g) z));
  assert (r->>'seen')::int = 17, '11e distinct ids: ' || r::text;
  -- And the same documents again: identical, so the new body writes nothing.
  r := public.sefq_step('11e grid again', (
    select jsonb_agg(overview_json order by sef_invoice_id) from public.sef_inbox
     where company_id = current_setting('sq.b')::uuid and sef_invoice_id between 1200 and 1216));
  assert (r->>'new_upd')::int = 0, '11e repeat wrote: ' || r::text;

  -- 11f. An element that is not an object is refused, the same way, by both.
  perform public.sefq_refused('11f number', '[{"InvoiceId": 1111}, 5]');
  perform public.sefq_refused('11f null', '[null]');
  perform public.sefq_refused('11f text', '["1112"]');
  perform public.sefq_refused('11f array', '[[{"InvoiceId": 1113}]]');
  perform public.sefq_refused('11f not an array', '{"InvoiceId": 1114}');
  raise notice '11 ok';
end $$;

-- ══ 12. The sales pull: the same reads, the same writes ═════════════════════

do $$
declare r jsonb; x record; t timestamptz;
begin
  r := public.sefq_step('12a sales new', '[
    {"sefInvoiceId": 3001, "status": "Sent", "globUniqId": "g-3001", "cirInvoiceId": "c-3001",
     "documentNumber": "IF-1/2026", "documentType": "Invoice", "customerName": "Kupac A",
     "customerVatNumber": "100000002", "customerRegistrationNumber": "20000002",
     "amount": 1200, "sumWithoutVat": 1000, "vatAmount": 200, "currency": "RSD",
     "issueDate": "2026-10-30", "deliveryDate": "2026-10-30T23:30:00", "dueDate": "2026-11-30T00:00:00+01:00"},
    {"SefInvoiceId": 3002, "Status": "Sent", "CustomerName": "Kupac B", "Comment": "napomena", "IssueDate": "02.11.2026"},
    {"sefinvoiceid": 3003, "SEFINVOICEID": 3004, "STATUS": "Paid", "status": "Sent", "Amount": 1, "AMOUNT": 3},
    {"sefInvoiceId": "x"},
    {"sefInvoiceId": 3001, "status": "Sent", "customerName": "Kupac A", "amount": 1300}]'::jsonb, 'sales');
  assert (r->>'seen')::int = 3 and (r->>'inserted')::int = 3, '12a counts: ' || r::text;
  select sef_invoice_id, sef_status, amount into x
    from public.sef_inbox where company_id = current_setting('sq.b')::uuid and direction = 'sales' and sef_invoice_id in (3003, 3004);
  assert x.sef_invoice_id = 3004 and x.sef_status = 'Paid' and x.amount = 3, 'sales case duplicates: ' || row(x.*)::text;

  -- 12b. The same payload again: the sales body still writes EVERY listed row
  -- and stamps last_seen_at (the ask-again queue orders by it).
  perform public.sefq_both($s$update public.sef_inbox set last_seen_at = now() - interval '1 hour'
                              where company_id = %L and direction = 'sales'$s$);
  r := public.sefq_step('12b sales repeat', '[
    {"SefInvoiceId": 3002, "Status": "Sent", "CustomerName": "Kupac B", "Comment": "napomena", "IssueDate": "02.11.2026"},
    {"sefinvoiceid": 3003, "SEFINVOICEID": 3004, "STATUS": "Paid", "status": "Sent", "Amount": 1, "AMOUNT": 3}]'::jsonb, 'sales');
  assert r->'moved_new' = '["3002", "3004"]'::jsonb and r->'moved_old' = r->'moved_new',
    'the sales body no longer writes every listed row: ' || r::text;
  select last_seen_at into t from public.sef_inbox
   where company_id = current_setting('sq.b')::uuid and direction = 'sales' and sef_invoice_id = 3004;
  assert t = now(), 'the sales body did not stamp last_seen_at: ' || t;

  -- 12c. A status and a comment change; a booked sales row keeps its figures.
  perform public.sefq_both($s$update public.sef_inbox set state = 'imported', imported_at = now()
                              where company_id = %L and direction = 'sales' and sef_invoice_id = 3002$s$);
  r := public.sefq_step('12c sales change', '[
    {"SefInvoiceId": 3002, "Status": "Storno", "Comment": "greška", "CustomerName": "Kupac B izmenjen", "Amount": 5}]'::jsonb, 'sales');

  perform public.sefq_refused('12d sales not an object', '[{"sefInvoiceId": 3005}, 7]', 'sales');
  raise notice '12 ok';
end $$;

do $$ begin raise notice 'ALL TESTS PASSED'; end $$;
