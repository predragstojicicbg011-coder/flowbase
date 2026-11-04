-- Tests for 20261104110000_customer_advances.sql (the advance chain for
-- customers, never across directions; v_customer_advances).
--
-- Run in ONE transaction that is rolled back, with the migrations it needs in
-- front (begin/commit stripped) when the database lacks them. Fixtures only
-- (company "Test avansi kupaca (TEST-AK)", two customers), always rolled back.
-- Run as the database owner. Ends with ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_c1 uuid; v_c2 uuid; v_pf uuid; v_tx uuid; v_av uuid; v_fin uuid; v_ef uuid; v_epf uuid;
  v_av2 uuid; v_av3 uuid; v_f1 uuid; v_f2 uuid; v_f3 uuid; v_pf2 uuid; v_pf3 uuid; v_d1 uuid; v_prj uuid; v_d2 uuid; v_av4 uuid; v_f9 uuid; v_msg text; r record; n numeric;
begin
  insert into public.companies (name, country, currency) values ('Test avansi kupaca (TEST-AK)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.partners (name) values ('Test kupac A (TEST-AK)') returning id into v_c1;
  insert into public.partners (name) values ('Test kupac B (TEST-AK)') returning id into v_c2;

  -- 1. An outgoing proforma: no P&L, unpaid.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, pl_impact)
  values (v_co, v_c1, 'IPR-1', current_date, 'revenue', 'RSD', 120000, 120000, 1, 'proforma', true) returning id into v_pf;
  assert (select pl_impact from public.invoices where id = v_pf) = false, 'proforma has no P&L';
  select * into r from public.v_invoice_status where id = v_pf;
  assert r.calculated_status = 'unpaid' and r.remaining_rsd = 120000, format('proforma %s %s', r.calculated_status, r.remaining_rsd);
  raise notice '1 ok';

  -- 2. The customer pays; an advance invoice of 120000 covers the proforma.
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_c1, current_date, 'invoice_payment', 'RSD', 120000, 120000, false, 'posted') returning id into v_tx;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_pf, v_tx, 120000, 120000);
  assert (select calculated_status from public.v_invoice_status where id = v_pf) = 'paid', 'proforma paid';
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c1, 'IAV-1', current_date, 'revenue', 'RSD', 120000, 120000, 1, 'advance_invoice') returning id into v_av;
  insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av, v_pf, 120000);
  set constraints all immediate;
  set constraints all deferred;
  assert (select pl_impact from public.invoices where id = v_av) = false, 'advance invoice has no P&L';
  raise notice '2 ok';

  -- 3. The final invoice of 300000 uses the advance of 120000.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, eur_rate)
  values (v_co, v_c1, 'IF-1', current_date, 'revenue', 'RSD', 300000, 300000, 1, 117.2) returning id into v_fin;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin, v_av, 120000);
  select * into r from public.v_invoice_status where id = v_fin;
  assert r.calculated_status = 'partial' and r.remaining_rsd = 180000, format('final %s %s', r.calculated_status, r.remaining_rsd);
  select coalesce(sum(amount_rsd), 0) into n from public.v_pl_entries where company_id = v_co and tx_type = 'revenue';
  assert n = 300000, format('P&L revenue %s', n);
  select coalesce(sum(amount_rsd), 0) into n from public.v_pl_entries where id in (v_pf, v_av);
  assert n = 0, 'proforma and advance invoice are not in the P&L';
  assert not exists (select 1 from public.v_supplier_advances where company_id = v_co), 'the customer chain is not in the supplier view';
  raise notice '3 ok';

  -- 3b. The customer view (before the direction tests add more documents).
  select * into r from public.v_customer_advances where company_id = v_co and partner_id = v_c1;
  assert r.received_on_proformas = 120000 and r.covered = 120000 and r.used = 120000 and r.advance_open = 0
     and r.received_without_advance = 0,
    format('customer view %s %s %s %s', r.received_on_proformas, r.covered, r.used, r.advance_open);
  assert r.partner_name = 'Test kupac A (TEST-AK)', 'partner name in the view';

  -- 4. Never across directions.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_c1, 'ULAZ-1', current_date, 'expense', 'RSD', 10000, 10000, 1) returning id into v_ef;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_ef, v_av, 1);
    raise exception 'FAIL: an outgoing advance used by an incoming bill';
  exception when check_violation then null;
  end;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c1, 'UPR-1', current_date, 'expense', 'RSD', 50000, 50000, 1, 'proforma') returning id into v_epf;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c1, 'IAV-X', current_date, 'revenue', 'RSD', 50000, 50000, 1, 'advance_invoice') returning id into v_av3;
  begin
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av3, v_epf, 1);
    raise exception 'FAIL: an outgoing advance covered by an incoming proforma';
  exception when check_violation then null;
  end;
  raise notice '4 ok';

  -- 5. An advance of 200000 used 150000, then 50000, on two final invoices; a third is refused.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c2, 'IAV-2', current_date, 'revenue', 'RSD', 200000, 200000, 1, 'advance_invoice') returning id into v_av2;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_c2, 'IF-2', current_date, 'revenue', 'RSD', 400000, 400000, 1) returning id into v_f1;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_c2, 'IF-3', current_date, 'revenue', 'RSD', 80000, 80000, 1) returning id into v_f2;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_c2, 'IF-4', current_date, 'revenue', 'RSD', 80000, 80000, 1) returning id into v_f3;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f1, v_av2, 150000);
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f2, v_av2, 50000);
  assert (select advance_open from public.v_invoice_status where id = v_av2) = 0, 'advance used up';
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f3, v_av2, 1);
    raise exception 'FAIL: used an advance already spent';
  exception when check_violation then null;
  end;
  raise notice '5 ok';

  -- 7. Two outgoing proformas with the same number in one company are both accepted.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c1, 'IPR-77', current_date, 'revenue', 'RSD', 1000, 1000, 1, 'proforma') returning id into v_pf2;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c2, 'IPR-77', current_date, 'revenue', 'RSD', 2000, 2000, 1, 'proforma') returning id into v_pf3;
  raise notice '7 ok';

  -- 8. The old project advance (advance_deducted) and the advance chain never meet on one invoice.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c2, 'IAV-4', current_date, 'revenue', 'RSD', 500000, 500000, 1, 'advance_invoice') returning id into v_av4;
  insert into public.projects (company_id, name) values (v_co, 'Test gradiliste (TEST-AK)') returning id into v_prj;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, project_id, advance_deducted, advance_deducted_rsd, advance_deducted_eur)
  values (v_co, v_c2, 'IF-D1', current_date, 'revenue', 'RSD', 300000, 300000, 1, v_prj, 300000, 300000, 0) returning id into v_d1;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_d1, v_av4, 1000);
    raise exception 'FAIL: advance chain on an invoice with a project advance';
  exception when check_violation then null;
  end;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_c2, 'IF-D2', current_date, 'revenue', 'RSD', 300000, 300000, 1) returning id into v_d2;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_d2, v_av4, 1000);
  begin
    update public.invoices set project_id = v_prj, advance_deducted = 1000, advance_deducted_rsd = 1000 where id = v_d2;
    raise exception 'FAIL: project advance on an invoice with the advance chain';
  exception when check_violation then null;
  end;
    raise notice '8 ok';

  -- 9. A customer's chain speaks of the customer, never of a supplier.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_c1, 'IF-9', current_date, 'revenue', 'RSD', 5000, 5000, 1) returning id into v_f9;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f9, v_av4, 1000);
    raise exception 'FAIL: an advance of another customer used';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Avansni račun IAV-4 nije istog kupca, firme i valute kao konačni račun.', format('usage message: %s', v_msg);
  begin
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av3, v_pf3, 1);
    raise exception 'FAIL: a proforma of another customer covered';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Predračun IPR-77 nije istog kupca, firme i valute kao avansni račun.', format('coverage message: %s', v_msg);
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
    values (v_co, v_c1, 'IPR-N', current_date, null, 'RSD', 1000, 1000, 1, 'proforma');
    raise exception 'FAIL: a proforma with no direction';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Predračun mora biti ulazni (od dobavljača) ili izlazni (kupcu).', format('direction message: %s', v_msg);
  raise notice '9 ok';

  raise notice 'ALL TESTS PASSED';
end $$;
