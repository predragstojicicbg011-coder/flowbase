-- Tests for 20261104090000_sales_invoices_in_the_inbox.sql.
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/sales_inbox_test.sql; rollback;
-- Safe on a live database: fixtures only (company "Test izlazne (TEST-IZ)", an
-- invented customer and supplier, one finance user), always rolled back. Run as
-- the database owner. Ends with ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_co2 uuid; v_row uuid; v_sales uuid; v_exp uuid; v_rev uuid;
  r record; n int; v_amount numeric; v_status text; v_comment text;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values ('0d0c0000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000',
          'authenticated', 'authenticated', 'sales-inbox-a1@example.invalid', now(), now());
  insert into public.profiles (id, full_name, email, role)
  values ('0d0c0000-0000-4000-8000-0000000000a1', 'Test Finansije', 'sales-inbox-a1@example.invalid', 'administrator');

  insert into public.companies (name, country, currency) values ('Test izlazne (TEST-IZ)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.companies (name, country, currency) values ('Test druga firma (TEST-IZ)', 'Srbija', 'RSD') returning id into v_co2;

  -- 1. The same SEF id in both directions is two rows; a repeat is still one.
  perform public.sef_inbox_upsert(v_co, '[{"InvoiceId": 555, "Status": "New", "SupplierName": "Test dobavljac doo",
    "SupplierVatRegistrationNumber": "100000001", "Amount": 1200}]'::jsonb);
  select count(*), min(direction) into n, v_status from public.sef_inbox where company_id = v_co and sef_invoice_id = 555;
  assert n = 1 and v_status = 'purchase', 'upsert one purchase row: ' || n || ' ' || v_status;

  select * into r from public.sef_sales_upsert(v_co, '[{"sefInvoiceId": 555, "status": "Sent", "globUniqId": "g-555",
    "cirInvoiceId": "c-555", "documentNumber": "IF-1/2026", "documentType": "Invoice",
    "customerName": "Test kupac doo", "customerVatNumber": "100000002", "customerRegistrationNumber": "20000002",
    "amount": 1200, "sumWithoutVat": 1000, "vatAmount": 200, "currency": "RSD",
    "issueDate": "2026-10-30", "deliveryDate": "2026-10-30", "dueDate": "2026-11-30"}]'::jsonb);
  assert r.seen = 1 and r.inserted = 1, 'sales upsert counts: ' || r.seen || '/' || r.inserted;
  select count(*) into n from public.sef_inbox where company_id = v_co and sef_invoice_id = 555;
  assert n = 2, 'two rows for id 555: ' || n;
  select id, direction, customer_vat_number, customer_name, issue_date, sent_date
    into r from public.sef_inbox where company_id = v_co and sef_invoice_id = 555 and direction = 'sales';
  v_sales := r.id;
  assert r.customer_vat_number = '100000002' and r.customer_name = 'Test kupac doo', 'customer columns';
  assert r.issue_date = date '2026-10-30', 'issue_date: ' || r.issue_date;
  assert (r.sent_date at time zone 'Europe/Belgrade') = timestamp '2026-10-30 00:00', 'sent_date is Belgrade midnight: ' || r.sent_date;

  perform public.sef_inbox_upsert(v_co, '[{"InvoiceId": 555, "Status": "Seen"}]'::jsonb);
  select count(*) into n from public.sef_inbox where company_id = v_co and sef_invoice_id = 555 and direction = 'purchase';
  assert n = 1, 'repeat purchase upsert keeps one row: ' || n;
  select count(*) into n from public.sef_inbox where company_id = v_co and sef_invoice_id = 555 and direction = 'sales';
  assert n = 1, 'repeat purchase upsert did not touch the sales row';

  -- 2. A repeat of the sales row refreshes status and figures while pending.
  select * into r from public.sef_sales_upsert(v_co, '[{"sefInvoiceId": 555, "status": "Paid", "amount": 1500,
    "customerName": "Test kupac doo", "customerVatNumber": "100000002"}]'::jsonb);
  assert r.seen = 1 and r.inserted = 0, 'repeat is not an insert: ' || r.inserted;
  select sef_status, amount into v_status, v_amount from public.sef_inbox where id = v_sales;
  assert v_status = 'Paid' and v_amount = 1500, 'status and amount refreshed: ' || v_status || ' ' || v_amount;

  -- 3. Status updates touch only existing sales rows.
  n := public.sef_sales_status(v_co, '[{"sefInvoiceId": 999, "status": "Storno", "comment": "x"}]'::jsonb);
  assert n = 0, 'unknown id changes nothing: ' || n;
  select count(*) into n from public.sef_inbox where company_id = v_co and sef_invoice_id = 999;
  assert n = 0, 'unknown id made a row';
  n := public.sef_sales_status(v_co, '[{"sefInvoiceId": 555, "status": "Storno", "comment": "greška u ceni"}]'::jsonb);
  assert n = 1, 'one sales row changed: ' || n;
  select sef_status, sef_comment into v_status, v_comment from public.sef_inbox where id = v_sales;
  assert v_status = 'Storno' and v_comment = 'greška u ceni', 'status and comment written';
  select sef_status into v_status from public.sef_inbox where company_id = v_co and sef_invoice_id = 555 and direction = 'purchase';
  assert v_status = 'Seen', 'the purchase row was left alone: ' || v_status;

  -- 4. mark_imported checks the direction and the cancelled status.
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number)
  values (v_co, current_date, 'expense', 'RSD', 100, 'ULAZNA-1') returning id into v_exp;
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number)
  values (v_co, current_date, 'revenue', 'RSD', 100, 'IZLAZNA-1') returning id into v_rev;
  perform set_config('request.jwt.claims', '{"sub":"0d0c0000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

  begin
    perform public.sef_inbox_mark_imported(v_sales, v_exp);
    raise exception 'FAIL: a sales row was tied to an expense invoice';
  exception when others then
    assert sqlerrm like 'Izlazna faktura sa SEF-a se vezuje samo za izlaznu fakturu%', sqlerrm;
  end;
  begin
    perform public.sef_inbox_mark_imported(v_sales, v_rev);
    raise exception 'FAIL: a stornirana sales row was booked';
  exception when others then
    assert sqlerrm like 'Faktura je stornirana, otkazana ili odbijena%', sqlerrm;
  end;
  select id into v_row from public.sef_inbox where company_id = v_co and sef_invoice_id = 555 and direction = 'purchase';
  begin
    perform public.sef_inbox_mark_imported(v_row, v_rev);
    raise exception 'FAIL: a purchase row was tied to a revenue invoice';
  exception when others then
    assert sqlerrm like 'Ulazna faktura sa SEF-a se vezuje samo za ulaznu fakturu%', sqlerrm;
  end;
  perform public.sef_sales_status(v_co, '[{"sefInvoiceId": 555, "status": "Sent", "comment": null}]'::jsonb);
  perform public.sef_inbox_mark_imported(v_sales, v_rev);
  select count(*) into n from public.sef_inbox where id = v_sales and state = 'imported' and imported_invoice_id = v_rev;
  assert n = 1, 'a sent sales row was tied to the revenue invoice';
  perform public.sef_inbox_mark_imported(v_row, v_exp);

  -- 5. One number per revenue invoice, per company and document type.
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number, document_type)
  values (v_co, current_date, 'revenue', 'RSD', 100, 'IF-1/2026', 'invoice');
  begin
    insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number, document_type)
    values (v_co, current_date, 'revenue', 'RSD', 100, 'IF-1-2026', 'invoice');
    raise exception 'FAIL: the same revenue number was booked twice';
  exception when unique_violation then
    assert sqlerrm like 'Izlazna faktura broj IF-1-2026 je već proknjižena%', sqlerrm;
  end;
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number, document_type)
  values (v_co2, current_date, 'revenue', 'RSD', 100, 'IF-1/2026', 'invoice');
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number, document_type)
  values (v_co, current_date, 'revenue', 'RSD', -100, 'IF-1/2026', 'credit_note');
  insert into public.invoices (company_id, invoice_date, type, currency, amount, invoice_number, document_type)
  values (v_co, current_date, 'expense', 'RSD', 100, 'IF-1/2026', 'invoice');
  -- (A revenue proforma cannot exist -- invoices_advance_shape refuses it -- so
  -- the proforma exclusion in the trigger has nothing to be tested against.)

  -- 6. The interface cannot write the direction or the customer.
  assert not has_column_privilege('authenticated', 'public.sef_inbox', 'direction', 'UPDATE'), 'direction is writable';
  assert not has_column_privilege('authenticated', 'public.sef_inbox', 'customer_name', 'UPDATE'), 'customer_name is writable';
  assert not has_function_privilege('authenticated', 'public.sef_sales_upsert(uuid, jsonb)', 'execute'), 'sales upsert open to users';
  assert not has_function_privilege('authenticated', 'public.sef_sales_status(uuid, jsonb)', 'execute'), 'sales status open to users';
  assert has_function_privilege('service_role', 'public.sef_sales_upsert(uuid, jsonb)', 'execute'), 'sales upsert closed to the service';

  -- 7. The sales pull is scheduled when the purchase pull is.
  if exists (select 1 from cron.job where jobname = 'sef-pull-quarter-hourly' and active) then
    assert exists (select 1 from cron.job where jobname = 'sef-pull-sales-quarter-hourly' and active
                     and command like '%''sef-pull-sales'', true%'), 'the sales pull is not scheduled';
  end if;

  raise notice 'ALL TESTS PASSED';
end $$;
