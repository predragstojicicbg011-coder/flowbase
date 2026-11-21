-- Tests for 20261122090000_the_inbox_writes_only_what_changed.sql.
--
-- The new `sef_inbox_upsert` must leave every row exactly as the old one did
-- (all columns but last_seen_at), report the same counts, and write no row
-- version when nothing changed -- except the rows the header's rule 4 keeps
-- writing (a decision on SEF the app did not make).
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/sef_inbox_quiet_test.sql; rollback;
-- Safe on a live database: fixtures only (companies "Test SEF stari (TEST-SQ)"
-- and "Test SEF novi (TEST-SQ)", invented suppliers), helper functions named
-- sefq_*, always rolled back. Run as the database owner. Ends with ALL TESTS
-- PASSED.

\set ON_ERROR_STOP on

-- ══ The old body, verbatim from 20261104090000, under a test name ═══════════

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

-- ══ The comparison: one payload through both bodies ═════════════════════════
--
-- Company A takes every payload through the old body, company B through the
-- new one. After each step the counts must be the same and every row the
-- same in every column except id, company_id and last_seen_at (compared as
-- the text of the whole row, so a JSON figure written 1.0 and 1.00 differs).
-- The step reports what each body WROTE: the rows whose ctid moved (a new
-- version, HOT or not) and the table's n_tup_upd for this transaction.

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
  select coalesce(jsonb_object_agg(sef_invoice_id::text, ctid::text), '{}'::jsonb)
    from public.sef_inbox where company_id = p_co
$$;

create function public.sefq_updates()
returns bigint
language sql
as $$
  select coalesce((select n_tup_upd from pg_stat_xact_user_tables
                    where relid = 'public.sef_inbox'::regclass), 0)
$$;

create function public.sefq_step(p_label text, p_rows jsonb)
returns jsonb
language plpgsql
as $$
declare
  a uuid := current_setting('sq.a')::uuid;
  b uuid := current_setting('sq.b')::uuid;
  o record; n record;
  c0 jsonb; c1 jsonb; u0 bigint; old_upd bigint; new_upd bigint;
  moved_new text[]; moved_old text[]; d int;
begin
  c0 := public.sefq_ctids(a); u0 := public.sefq_updates();
  select * into o from public.sefq_upsert_old(a, p_rows);
  old_upd := public.sefq_updates() - u0;
  c1 := public.sefq_ctids(a);
  select coalesce(array_agg(k order by k), '{}') into moved_old
    from jsonb_each_text(c0) e(k, v) where c1 ->> k is distinct from v;

  c0 := public.sefq_ctids(b); u0 := public.sefq_updates();
  select * into n from public.sef_inbox_upsert(b, p_rows);
  new_upd := public.sefq_updates() - u0;
  c1 := public.sefq_ctids(b);
  select coalesce(array_agg(k order by k), '{}') into moved_new
    from jsonb_each_text(c0) e(k, v) where c1 ->> k is distinct from v;

  if (o.seen, o.inserted, o.skipped) is distinct from (n.seen, n.inserted, n.skipped) then
    raise exception 'FAIL [%]: counts differ: old %/%/% new %/%/%', p_label,
      o.seen, o.inserted, o.skipped, n.seen, n.inserted, n.skipped;
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

  return jsonb_build_object(
    'seen', n.seen, 'inserted', n.inserted, 'skipped', n.skipped,
    'old_upd', old_upd, 'new_upd', new_upd,
    'moved_old', to_jsonb(moved_old), 'moved_new', to_jsonb(moved_new));
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
    {"InvoiceId": 1004, "Status": "New",      "SupplierName": "Dobavljač D", "Amount": 700},
    {"InvoiceId": 1005, "Status": "New",      "SupplierName": "Dobavljač E", "Amount": 800},
    {"InvoiceId": 1006, "Status": "Approved", "SupplierName": "Dobavljač F", "Amount": 900},
    {"InvoiceId": 1008, "Status": "Seen",     "SupplierName": "Dobavljač G", "Amount": 100},
    {"InvoiceId": "abc", "Status": "New"}
  ]'::jsonb;
  r := public.sefq_step('2 repeat', p);
  assert (r->>'seen')::int = 6 and (r->>'inserted')::int = 0 and (r->>'skipped')::int = 1,
    'step 2 counts: ' || r::text;
  -- The measurement itself works: the old body rewrote all six.
  assert (r->>'old_upd')::int = 6 and jsonb_array_length(r->'moved_old') = 6,
    'the old body did not rewrite the six (the measurement is broken): ' || r::text;
  -- THE POINT: the new body writes no row version at all.
  assert (r->>'new_upd')::int = 0 and r->'moved_new' = '[]'::jsonb,
    'the new body rewrote unchanged rows: ' || r::text;

  -- Once more, so a repeat of a repeat is quiet too.
  r := public.sefq_step('2 repeat again', p);
  assert (r->>'new_upd')::int = 0 and r->'moved_new' = '[]'::jsonb, 'second repeat wrote: ' || r::text;

  -- A decision on SEF the app did not make (1003: Approved, sef_decision
  -- null) is written every pass, as before -- a trigger following it fires.
  -- 1006 (Approved, accepted through the app) is not.
  r := public.sefq_step('2 approved outside', '[
    {"InvoiceId": 1003, "Status": "Approved", "SupplierName": "Dobavljač C", "Amount": 500},
    {"InvoiceId": 1006, "Status": "Approved", "SupplierName": "Dobavljač F", "Amount": 900}]'::jsonb);
  assert r->'moved_new' = '["1003"]'::jsonb and (r->>'new_upd')::int = 1,
    'only the row a trigger follows is rewritten: ' || r::text;
  raise notice '2 ok';
end $$;

-- ══ 3. Status changes ═══════════════════════════════════════════════════════

do $$
declare r jsonb;
begin
  -- 1004 is booked and goes New -> Seen: only the status comparison sees it
  -- (not pending, not a decision). 1005 is declined and SEF cancels it.
  -- 1008 is pending and goes Seen -> Rejected.
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
  r := public.sefq_step('5 decided figures', '[
    {"InvoiceId": 1004, "Status": "Seen",      "SupplierName": "Dobavljač D izmenjen", "Amount": 7777},
    {"InvoiceId": 1005, "Status": "Cancelled", "SupplierName": "Dobavljač E izmenjen", "Amount": 8888},
    {"InvoiceId": 1006, "Status": "Approved",  "SupplierName": "Dobavljač F izmenjen", "Amount": 9999}]'::jsonb);
  -- 1004 (booked) and 1006 (accepted through the app) get no new version.
  -- 1005 is Cancelled with no decision from the app, so rule 4 writes it --
  -- with its old figures, as the old body did.
  assert r->'moved_new' = '["1005"]'::jsonb and (r->>'new_upd')::int = 1, 'decided rows written: ' || r::text;
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
    {"InvoiceId": 1002, "Status": "Seen", "SupplierName": "Dobavljač B", "Amount": 1200.00}]'::jsonb);
  assert (r->>'seen')::int = 1 and (r->>'inserted')::int = 0 and (r->>'skipped')::int = 4, 'step 8 counts: ' || r::text;
  assert r->'moved_new' = '[]'::jsonb, 'step 8 wrote: ' || r::text;
  raise notice '8 ok';
end $$;

-- ══ 9. Last seen more than a day ago ════════════════════════════════════════

do $$
declare r jsonb; t timestamptz;
begin
  -- 1008 is rejected through the app first, so rule 4 does not write it.
  -- Then nothing SEF sends differs from what the rows hold; only their age.
  perform public.sefq_both($s$update public.sef_inbox set sef_decision = 'rejected', sef_decision_comment = 'netačan iznos'
                              where company_id = %L and sef_invoice_id = 1008$s$);
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

-- ══ 10. The function as the catalogue holds it ══════════════════════════════

do $$
declare f regprocedure := 'public.sef_inbox_upsert(uuid, jsonb)'::regprocedure;
begin
  assert (select prosecdef from pg_proc where oid = f), 'not SECURITY DEFINER';
  assert (select proconfig from pg_proc where oid = f) = array['search_path=public'], 'search_path changed';
  assert pg_get_function_result(f) = 'TABLE(seen integer, inserted integer, skipped integer)', 'result changed';
  assert not has_function_privilege('anon', f, 'execute'), 'anon may call it';
  assert not has_function_privilege('authenticated', f, 'execute'), 'a signed-in account may call it';
  assert has_function_privilege('service_role', f, 'execute'), 'the service role may not call it';
  raise notice '10 ok';
end $$;

do $$ begin raise notice 'ALL TESTS PASSED'; end $$;
