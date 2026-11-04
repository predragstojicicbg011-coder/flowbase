-- Tests for 20261104100000_delete_invoice_cascade.sql.
--
-- Run in ONE transaction that is rolled back, with the migrations the database
-- may lack (begin/commit stripped) in front:
--   sqltest supabase/migrations/20261104090000_sales_invoices_in_the_inbox.sql
--           supabase/migrations/20261104100000_delete_invoice_cascade.sql
--           supabase/tests/delete_invoice_cascade_test.sql
-- Safe on a live database: fixtures only (company "Test brisanje (TEST-BR)",
-- users 0d0c...b1/b2), always rolled back. Run as the database owner. Ends
-- with ALL TESTS PASSED.
--
-- Actors: b1 finance (administrator), b2 manager (no books).

\set ON_ERROR_STOP on

do $$
declare v_co uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x.email, now(), now()
    from (values
      ('0d0c0000-0000-4000-8000-0000000000b1', 'del-test-b1@example.invalid'),
      ('0d0c0000-0000-4000-8000-0000000000b2', 'del-test-b2@example.invalid')) as x(id, email);
  insert into public.profiles (id, full_name, email, role) values
    ('0d0c0000-0000-4000-8000-0000000000b1', 'Test Finansije', 'del-test-b1@example.invalid', 'administrator'),
    ('0d0c0000-0000-4000-8000-0000000000b2', 'Test Menadžer',  'del-test-b2@example.invalid', 'manager');
  insert into public.companies (name, country, currency)
  values ('Test brisanje (TEST-BR)', 'Srbija', 'RSD') returning id into v_co;
  perform set_config('dt.co', v_co::text, true);
end $$;

-- ══ 1. A revenue invoice with a payment, a note, a PDF and a SEF row ════════

do $$
declare
  v_co uuid := current_setting('dt.co')::uuid;
  v_rev uuid; v_ko uuid; v_tx uuid; v_row uuid; v_doc uuid := gen_random_uuid();
begin
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, status)
  values (v_co, 'IF-1/2026', current_date, 'revenue', 'RSD', 120000, 120000, 1, 'partial') returning id into v_rev;
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, adjusts_invoice_id)
  values (v_co, 'KO-1', current_date, 'revenue', 'RSD', -10000, -10000, 1, 'credit_note', v_rev) returning id into v_ko;
  insert into public.transactions (company_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, current_date, 'invoice_payment', 'RSD', 50000, 50000, false, 'posted') returning id into v_tx;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_rev, v_tx, 50000, 50000);
  insert into public.invoice_documents (id, invoice_id, company_id, path, filename, bytes, uploaded_by)
  values (v_doc, v_rev, v_co, v_co || '/' || v_rev || '/' || v_doc || '.pdf', 'racun.pdf', 100, '0d0c0000-0000-4000-8000-0000000000b1');
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, sef_status, overview_json, state, imported_invoice_id, imported_at)
  values (v_co, 'sales', 7001, 'Sent', '{}', 'imported', v_rev, now()) returning id into v_row;
  perform set_config('dt.rev', v_rev::text, true);
  perform set_config('dt.ko', v_ko::text, true);
  perform set_config('dt.tx', v_tx::text, true);
  perform set_config('dt.doc', v_doc::text, true);
  perform set_config('dt.row', v_row::text, true);
end $$;

reset role;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000b1","role":"authenticated"}';
set local role authenticated;

do $$
declare r jsonb;
begin
  -- Dry run: the numbers, and nothing changes.
  r := public.delete_invoice_cascade(current_setting('dt.rev')::uuid, true);
  assert r ->> 'invoice_number' = 'IF-1/2026' and r ->> 'type' = 'revenue', 'dry: ' || r::text;
  assert (r ->> 'payments_unlinked')::int = 1, 'dry payments: ' || r::text;
  assert r -> 'notes_deleted' = '["KO-1"]'::jsonb, 'dry notes: ' || r::text;
  assert (r ->> 'uploads_removed')::int = 1, 'dry uploads: ' || r::text;
  assert r ->> 'sef_row' = 'pending', 'dry sef: ' || r::text;
  assert (r ->> 'advance_links_removed')::int = 0 and r -> 'finals_reopened' = '[]'::jsonb, 'dry advance';
  assert (select count(*) from public.invoices where id in (current_setting('dt.rev')::uuid, current_setting('dt.ko')::uuid) and deleted_at is null) = 2, 'dry kept the invoices';
  assert (select count(*) from public.invoice_transaction_links where invoice_id = current_setting('dt.rev')::uuid) = 1, 'dry kept the link';
  assert (select removed_at from public.invoice_documents where id = current_setting('dt.doc')::uuid) is null, 'dry kept the document';
  assert (select state from public.sef_inbox where id = current_setting('dt.row')::uuid) = 'imported', 'dry kept the row';

  -- The real call.
  r := public.delete_invoice_cascade(current_setting('dt.rev')::uuid);
  execute 'reset role';  -- soft deleted rows are invisible to the caller; read them as the owner
  assert (r ->> 'payments_unlinked')::int = 1, 'real: ' || r::text;
  assert (select count(*) from public.invoices where id in (current_setting('dt.rev')::uuid, current_setting('dt.ko')::uuid) and deleted_at is null) = 0, 'both deleted';
  assert (select deleted_by from public.invoices where id = current_setting('dt.rev')::uuid) = '0d0c0000-0000-4000-8000-0000000000b1', 'deleted_by is the caller';
  assert (select count(*) from public.invoice_transaction_links where invoice_id = current_setting('dt.rev')::uuid) = 0, 'link gone';
  assert (select deleted_at from public.transactions where id = current_setting('dt.tx')::uuid) is null, 'the transaction lives';
  assert (select removed_at is not null and removed_by is not null from public.invoice_documents where id = current_setting('dt.doc')::uuid), 'document removed';
  assert (select state = 'pending' and imported_invoice_id is null from public.sef_inbox where id = current_setting('dt.row')::uuid), 'row back to pending, unlinked';
  raise notice '1 ok';
end $$;

-- ══ 2. A cancelled sales row stays declined, with the reason ════════════════

reset role;
do $$
declare v_co uuid := current_setting('dt.co')::uuid; v_rev uuid; v_row uuid;
begin
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, 'IF-2/2026', current_date, 'revenue', 'RSD', 5000, 5000, 1) returning id into v_rev;
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, sef_status, overview_json, state, imported_invoice_id, imported_at)
  values (v_co, 'sales', 7002, 'Storno', '{}', 'imported', v_rev, now()) returning id into v_row;
  perform set_config('dt.rev2', v_rev::text, true);
  perform set_config('dt.row2', v_row::text, true);
end $$;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000b1","role":"authenticated"}';
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.delete_invoice_cascade(current_setting('dt.rev2')::uuid);
  execute 'reset role';  -- soft deleted rows are invisible to the caller; read them as the owner
  assert r ->> 'sef_row' = 'dismissed', 'sef_row: ' || r::text;
  assert (select state = 'dismissed' and imported_invoice_id is null
                and dismiss_reason = 'Stornirana, otkazana ili odbijena na SEF-u (Storno); proknjižena faktura obrisana.'
            from public.sef_inbox where id = current_setting('dt.row2')::uuid), 'dismissed with the reason';
  raise notice '2 ok';
end $$;

-- ══ 3. A bill with a purchase row: the other direction ══════════════════════

reset role;
do $$
declare v_co uuid := current_setting('dt.co')::uuid; v_exp uuid; v_row uuid;
begin
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, 'ULAZ-1', current_date, 'expense', 'RSD', 7000, 7000, 1) returning id into v_exp;
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, sef_status, overview_json, state, imported_invoice_id, imported_at)
  values (v_co, 'purchase', 7003, 'Approved', '{}', 'imported', v_exp, now()) returning id into v_row;
  perform set_config('dt.exp', v_exp::text, true);
  perform set_config('dt.row3', v_row::text, true);
end $$;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000b1","role":"authenticated"}';
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.delete_invoice_cascade(current_setting('dt.exp')::uuid);
  execute 'reset role';  -- soft deleted rows are invisible to the caller; read them as the owner
  assert r ->> 'type' = 'expense' and r ->> 'sef_row' = 'pending', 'expense: ' || r::text;
  assert (select deleted_at is not null from public.invoices where id = current_setting('dt.exp')::uuid), 'bill deleted';
  assert (select state = 'pending' and imported_invoice_id is null from public.sef_inbox where id = current_setting('dt.row3')::uuid), 'purchase row pending';
  raise notice '3 ok';
end $$;

-- ══ 4. An advance invoice used by a final invoice ═══════════════════════════

reset role;
do $$
declare v_co uuid := current_setting('dt.co')::uuid; v_p uuid; v_av uuid; v_fin uuid;
begin
  insert into public.partners (name) values ('Test dobavljač (TEST-BR)') returning id into v_p;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, prior_period)
  values (v_co, v_p, 'AV-9', current_date, 'expense', 'RSD', 100000, 100000, 1, 'advance_invoice', true) returning id into v_av;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_p, 'IF-9/2026', current_date, 'expense', 'RSD', 100000, 100000, 1) returning id into v_fin;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin, v_av, 100000);
  perform set_config('dt.av', v_av::text, true);
  perform set_config('dt.fin', v_fin::text, true);
end $$;
set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000b1","role":"authenticated"}';
set local role authenticated;
do $$
declare r jsonb;
begin
  r := public.delete_invoice_cascade(current_setting('dt.av')::uuid);
  execute 'reset role';  -- soft deleted rows are invisible to the caller; read them as the owner
  assert (r ->> 'advance_links_removed')::int = 1 and r -> 'finals_reopened' = '["IF-9/2026"]'::jsonb, 'advance: ' || r::text;
  assert (select count(*) from public.advance_usage where final_invoice_id = current_setting('dt.fin')::uuid) = 0, 'usage gone';
  assert (select deleted_at is not null from public.invoices where id = current_setting('dt.av')::uuid), 'advance deleted';
  assert (select deleted_at is null from public.invoices where id = current_setting('dt.fin')::uuid), 'final lives';
  raise notice '4 ok';
end $$;

-- ══ 5. All or nothing: a trigger that fails halfway undoes everything ═══════

reset role;
do $$
declare v_co uuid := current_setting('dt.co')::uuid; v_rev uuid; v_ko uuid; v_tx uuid; v_row uuid;
begin
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, 'IF-5/2026', current_date, 'revenue', 'RSD', 20000, 20000, 1) returning id into v_rev;
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, adjusts_invoice_id)
  values (v_co, 'KO-5', current_date, 'revenue', 'RSD', -1000, -1000, 1, 'credit_note', v_rev) returning id into v_ko;
  insert into public.transactions (company_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, current_date, 'invoice_payment', 'RSD', 5000, 5000, false, 'posted') returning id into v_tx;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_rev, v_tx, 5000, 5000);
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, sef_status, overview_json, state, imported_invoice_id, imported_at)
  values (v_co, 'sales', 7005, 'Sent', '{}', 'imported', v_rev, now()) returning id into v_row;
  perform set_config('dt.rev5', v_rev::text, true);
  perform set_config('dt.ko5', v_ko::text, true);
end $$;

create function public.tg_test_boom() returns trigger language plpgsql as $f$
begin raise exception 'boom from the test'; end $f$;
create trigger tg_test_boom before update on public.sef_inbox
  for each row execute function public.tg_test_boom();

set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000b1","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform public.delete_invoice_cascade(current_setting('dt.rev5')::uuid);
    raise exception 'FAIL: the call went through a failing trigger';
  exception when others then
    if sqlerrm not like 'boom from the test%' then raise; end if;
  end;
  assert (select count(*) from public.invoices where id in (current_setting('dt.rev5')::uuid, current_setting('dt.ko5')::uuid) and deleted_at is null) = 2,
    'the invoice and its note are untouched';
  assert (select count(*) from public.invoice_transaction_links where invoice_id = current_setting('dt.rev5')::uuid) = 1, 'the payment link is untouched';
  assert (select state from public.sef_inbox where sef_invoice_id = 7005 and company_id = current_setting('dt.co')::uuid) = 'imported', 'the row is untouched';
  raise notice '5 ok';
end $$;
reset role;
drop trigger tg_test_boom on public.sef_inbox;

-- ══ 6. A manager is refused ═════════════════════════════════════════════════

set local request.jwt.claims to '{"sub":"0d0c0000-0000-4000-8000-0000000000b2","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform public.delete_invoice_cascade(current_setting('dt.rev5')::uuid, true);
    raise exception 'FAIL: a manager previewed the delete';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.delete_invoice_cascade(current_setting('dt.rev5')::uuid);
    raise exception 'FAIL: a manager deleted an invoice';
  exception when insufficient_privilege then null;
  end;
  raise notice '6 ok';
end $$;
reset role;
select 'ALL TESTS PASSED' as result;
