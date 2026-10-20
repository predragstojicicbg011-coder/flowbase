-- Tests for 20261021090000_supplier_advances.sql (proforma, advance invoice,
-- final invoice).
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/supplier_advances_test.sql; rollback;
-- Safe on a live database: fixtures only (company "Test avansi (TEST-AV)",
-- two suppliers), always rolled back. Run as the database owner. Ends with
-- ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_p1 uuid; v_p2 uuid; v_pf uuid; v_tx uuid; v_av uuid; v_av2 uuid; v_fin uuid; v_fin2 uuid; v_fin3 uuid;
  v_old uuid; v_loose uuid; v_bill uuid; v_bav uuid; v_bfin uuid; r record;
begin
  insert into public.companies (name, country, currency) values ('Test avansi (TEST-AV)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.partners (name) values ('Test dobavljač A (TEST-AV)') returning id into v_p1;
  insert into public.partners (name) values ('Test dobavljač B (TEST-AV)') returning id into v_p2;

  -- 1. A proforma is payable and never in the P&L, whatever it is told.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, pl_impact)
  values (v_co, v_p1, 'PR-1', current_date, 'expense', 'RSD', 200000, 200000, 1, 'proforma', true) returning id into v_pf;
  select * into r from public.v_invoice_status where id = v_pf;
  assert r.calculated_status = 'unpaid' and r.remaining_rsd = 200000, format('proforma %s %s', r.calculated_status, r.remaining_rsd);
  assert (select pl_impact from public.invoices where id = v_pf) = false, 'proforma has no P&L';
  raise notice '1 ok';

  -- 2. Paid; an advance invoice of 150000 covers part of it.
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_p1, current_date, 'invoice_payment', 'RSD', 200000, 200000, false, 'posted') returning id into v_tx;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_pf, v_tx, 200000, 200000);
  assert (select calculated_status from public.v_invoice_status where id = v_pf) = 'paid', 'proforma paid';
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_p1, 'AV-1', current_date, 'expense', 'RSD', 150000, 150000, 1, 'advance_invoice') returning id into v_av;
  insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av, v_pf, 150000);
  set constraints all immediate;
  set constraints all deferred;
  select * into r from public.v_supplier_advances where company_id = v_co and partner_id = v_p1;
  assert r.paid_on_proformas = 200000 and r.covered = 150000 and r.paid_without_advance = 50000 and r.advance_open = 150000,
    format('supplier %s %s %s %s', r.paid_on_proformas, r.covered, r.paid_without_advance, r.advance_open);
  select * into r from public.v_invoice_status where id = v_av;
  assert r.calculated_status = 'paid' and r.remaining_rsd = 0 and not r.unlinked, 'advance invoice is not payable';
  assert (select pl_impact from public.invoices where id = v_av) = false, 'advance invoice has no P&L';
  raise notice '2 ok';

  -- 3. More than was paid is refused; an advance not fully covered is refused at commit.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_p1, 'AV-2', current_date, 'expense', 'RSD', 250000, 250000, 1, 'advance_invoice') returning id into v_av2;
  begin
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av2, v_pf, 250000);
    raise exception 'FAIL: covered more than was paid';
  exception when check_violation then null;
  end;
  update public.invoices set amount = 100000, amount_rsd = 100000 where id = v_av2;
  begin
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av2, v_pf, 50000);
    set constraints all immediate;
    raise exception 'FAIL: an advance invoice only partly covered';
  exception when check_violation then null;
  end;
  set constraints all deferred;
  raise notice '3 ok';

  -- 4. A final invoice closed in full by the advance.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, eur_rate)
  values (v_co, v_p1, 'F-1', current_date, 'expense', 'RSD', 120000, 120000, 1, 117.2) returning id into v_fin;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin, v_av, 120000);
  select * into r from public.v_invoice_status where id = v_fin;
  assert r.calculated_status = 'paid' and r.remaining_rsd = 0 and r.advance_used = 120000, format('final %s %s %s', r.calculated_status, r.remaining_rsd, r.advance_used);
  assert (select amount_rsd from public.advance_usage where final_invoice_id = v_fin) = 120000, 'usage in dinars at the final invoice rate';
  assert (select advance_open from public.v_invoice_status where id = v_av) = 30000, 'advance left 30000';
  raise notice '4 ok';

  -- 5. A second final invoice uses the rest and stays partly open; nothing is left after.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_p1, 'F-2', current_date, 'expense', 'RSD', 50000, 50000, 1) returning id into v_fin2;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin2, v_av, 30000);
  select * into r from public.v_invoice_status where id = v_fin2;
  assert r.calculated_status = 'partial' and r.remaining_rsd = 20000, format('final 2 %s %s', r.calculated_status, r.remaining_rsd);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_p1, 'F-3', current_date, 'expense', 'RSD', 10000, 10000, 1) returning id into v_fin3;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin3, v_av, 1);
    raise exception 'FAIL: used an advance already spent';
  exception when check_violation then null;
  end;
  begin
    update public.advance_usage set amount = 60000 where final_invoice_id = v_fin2;
    raise exception 'FAIL: used more than the final invoice';
  exception when check_violation then null;
  end;
  raise notice '5 ok';

  -- 6. Another supplier, a proforma as the advance, a bill as the proforma: refused.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_p2, 'F-9', current_date, 'expense', 'RSD', 10000, 10000, 1) returning id into v_bill;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_bill, v_av, 1);
    raise exception 'FAIL: another supplier''s advance';
  exception when check_violation then null;
  end;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin3, v_pf, 1);
    raise exception 'FAIL: a proforma used as an advance invoice';
  exception when check_violation then null;
  end;
  begin
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av2, v_fin3, 1);
    raise exception 'FAIL: a bill used as a proforma';
  exception when check_violation then null;
  end;
  raise notice '6 ok';

  -- 7. What the chain holds cannot be deleted or shrunk under it.
  begin
    update public.invoices set deleted_at = now() where id = v_av;
    raise exception 'FAIL: deleted an advance invoice in use';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set deleted_at = now() where id = v_pf;
    raise exception 'FAIL: deleted a paid proforma';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set amount = 100000, amount_rsd = 100000 where id = v_av;
    raise exception 'FAIL: shrank an advance invoice below its use';
  exception when check_violation then null;
  end;
  raise notice '7 ok';

  -- 8. An advance from an earlier period has no proforma and is not "unlinked"; one without is.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, prior_period)
  values (v_co, v_p1, 'AV-OLD', current_date - 400, 'expense', 'RSD', 80000, 80000, 1, 'advance_invoice', true) returning id into v_old;
  assert not (select unlinked from public.v_invoice_status where id = v_old), 'prior period is not unlinked';
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_p1, 'AV-LOOSE', current_date, 'expense', 'RSD', 5000, 5000, 1, 'advance_invoice') returning id into v_loose;
  assert (select unlinked from public.v_invoice_status where id = v_loose), 'an advance invoice with no proforma is unlinked';
  begin
    update public.invoices set prior_period = true where id = v_bill;
    raise exception 'FAIL: prior_period on a bill';
  exception when check_violation then null;
  end;
  raise notice '8 ok';

  -- 9. Ordinary edits pass; a final invoice with a credit note and an advance.
  update public.invoices set note = 'izmena' where id = v_bill;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
  values (v_co, v_p1, 'KO-1', current_date, 'expense', 'RSD', -10000, 'credit_note', v_fin3);
  update public.invoices set amount = 100000, amount_rsd = 100000 where id = v_fin3;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_fin3, v_old, 50000);
  assert (select remaining_rsd from public.v_invoice_status where id = v_fin3) = 40000,
    format('credit note and advance %s', (select remaining_rsd from public.v_invoice_status where id = v_fin3));
  raise notice '9 ok';

  -- 10. Bepro: an advance used in part stays open for the next final invoice.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, prior_period)
  values (v_co, v_p2, 'AV104/2026', current_date, 'expense', 'RSD', 329725.45, 329725.45, 1, 'advance_invoice', true) returning id into v_bav;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_p2, '745/2026', current_date, 'expense', 'RSD', 323125.57, 323125.57, 1) returning id into v_bfin;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_bfin, v_bav, 323125.57);
  assert (select calculated_status from public.v_invoice_status where id = v_bfin) = 'paid', 'Bepro final closed';
  assert (select advance_open from public.v_invoice_status where id = v_bav) = 6599.88, 'Bepro advance left 6599.88';
  raise notice '10 ok';

  set constraints all immediate;
  raise notice 'ALL TESTS PASSED';
end $$;
