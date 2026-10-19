-- Tests for 20261020100000_credit_and_debit_notes.sql.
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/credit_and_debit_notes_test.sql; rollback;
-- Safe on a live database: fixtures only (company "Test odobrenja (TEST-KO)",
-- two suppliers), always rolled back. Run as the database owner. Ends with
-- ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_p1 uuid; v_p2 uuid; v_bill uuid; v_eur uuid; v_ko uuid; v_kz uuid; v_free uuid; r record;
begin
  insert into public.companies (name, country, currency) values ('Test odobrenja (TEST-KO)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.partners (name) values ('Test dobavljač A (TEST-KO)') returning id into v_p1;
  insert into public.partners (name) values ('Test dobavljač B (TEST-KO)') returning id into v_p2;

  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_p1, 'R-1/26', current_date, 'expense', 'RSD', 120000, 120000, 1) returning id into v_bill;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, eur_rate, amount_eur)
  values (v_co, v_p1, 'R-2/26', current_date, 'expense', 'EUR', 1000, 117200, 117.2, 117.2, 1000) returning id into v_eur;

  assert (select document_type from public.invoices where id = v_bill) = 'invoice', 'a new bill is an invoice';

  -- 1. A credit note reduces what is owed; the bill is partly closed; the note itself is closed.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
  values (v_co, v_p1, 'KO-5/26', current_date, 'expense', 'RSD', -20000, 'credit_note', v_bill) returning id into v_ko;
  select * into r from public.v_invoice_status where id = v_bill;
  assert r.calculated_status = 'partial', format('reduced bill: %s', r.calculated_status);
  assert r.remaining_rsd = 100000, format('remaining %s', r.remaining_rsd);
  assert r.adjustments = -20000, format('adjustments %s', r.adjustments);
  assert (select calculated_status from public.v_invoice_status where id = v_ko) = 'paid', 'a linked credit note is closed';
  assert (select amount_rsd from public.invoices where id = v_ko) = -20000, 'credit note dinars from the bill''s rate';
  raise notice '1 ok';

  -- 2. A debit note adds to it.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
  values (v_co, v_p1, 'KZ-1/26', current_date, 'expense', 'RSD', 5000, 'debit_note', v_bill) returning id into v_kz;
  assert (select remaining_rsd from public.v_invoice_status where id = v_bill) = 105000, 'debit note adds';
  raise notice '2 ok';

  -- 3. A credit note larger than the bill is refused.
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KO-6/26', current_date, 'expense', 'RSD', -200000, 'credit_note', v_bill);
    raise exception 'FAIL: credited more than the bill';
  exception when check_violation then null;
  end;
  raise notice '3 ok';

  -- 4. Wrong partner, wrong currency, wrong sign: refused.
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p2, 'KO-7/26', current_date, 'expense', 'RSD', -100, 'credit_note', v_bill);
    raise exception 'FAIL: another partner''s bill';
  exception when check_violation then null;
  end;
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KO-8/26', current_date, 'expense', 'EUR', -10, 'credit_note', v_bill);
    raise exception 'FAIL: another currency';
  exception when check_violation then null;
  end;
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KO-9/26', current_date, 'expense', 'RSD', 100, 'credit_note', v_bill);
    raise exception 'FAIL: a positive credit note';
  exception when check_violation then null;
  end;
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KZ-2/26', current_date, 'expense', 'RSD', -100, 'debit_note', v_bill);
    raise exception 'FAIL: a negative debit note';
  exception when check_violation then null;
  end;
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'R-9/26', current_date, 'expense', 'RSD', 100, 'invoice', v_bill);
    raise exception 'FAIL: an invoice linked to an invoice';
  exception when check_violation then null;
  end;
  raise notice '4 ok';

  -- 5. Not onto another credit note.
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KO-10/26', current_date, 'expense', 'RSD', -100, 'credit_note', v_ko);
    raise exception 'FAIL: linked to a credit note';
  exception when check_violation then null;
  end;
  raise notice '5 ok';

  -- 6. On a EUR bill the note takes the bill's rates.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
  values (v_co, v_p1, 'KO-11/26', current_date + 10, 'expense', 'EUR', -100, 'credit_note', v_eur);
  select * into r from public.invoices where invoice_number = 'KO-11/26' and partner_id = v_p1;
  assert r.exchange_rate = 117.2 and r.eur_rate = 117.2, 'bill''s rates';
  assert r.amount_rsd = -11720 and r.amount_eur = -100, format('rsd %s eur %s', r.amount_rsd, r.amount_eur);
  assert (select remaining_rsd from public.v_invoice_status where id = v_eur) = 105480, 'EUR bill remaining in dinars';
  raise notice '6 ok';

  -- 7. The bill cannot be deleted while a live note points to it.
  begin
    update public.invoices set deleted_at = now() where id = v_eur;
    raise exception 'FAIL: deleted a bill a credit note points to';
  exception when check_violation then null;
  end;
  update public.invoices set deleted_at = now() where invoice_number = 'KO-11/26' and partner_id = v_p1;
  update public.invoices set deleted_at = now() where id = v_eur;
  raise notice '7 ok';

  -- 8. A note with no bill: allowed, marked, and not closed.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type)
  values (v_co, v_p2, 'KO-1/25', current_date, 'expense', 'RSD', -3000, 'credit_note') returning id into v_free;
  select * into r from public.v_invoice_status where id = v_free;
  assert r.unlinked and r.calculated_status <> 'paid', format('unlinked %s %s', r.unlinked, r.calculated_status);
  -- ... and linked later.
  update public.invoices set adjusts_invoice_id = v_bill, partner_id = v_p1 where id = v_free;
  assert (select remaining_rsd from public.v_invoice_status where id = v_bill) = 102000, 'linked later';
  raise notice '8 ok';

  -- 9. Duplicate numbers are per document type.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type)
  values (v_co, v_p1, 'KO-5/26', current_date, 'expense', 'RSD', 100, 'invoice');
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type)
    values (v_co, v_p1, 'KO 5/26', current_date, 'expense', 'RSD', -10, 'credit_note');
    raise exception 'FAIL: two credit notes with one number';
  exception when unique_violation then null;
  end;
  raise notice '9 ok';

  -- 10. Editing a bill's note passes; a bill fully credited is closed.
  update public.invoices set note = 'izmena' where id = v_bill;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
  values (v_co, v_p1, 'KO-12/26', current_date, 'expense', 'RSD', -102000, 'credit_note', v_bill);
  assert (select calculated_status from public.v_invoice_status where id = v_bill) = 'paid', 'fully credited bill is closed';
  assert (select remaining_rsd from public.v_invoice_status where id = v_bill) = 0, 'nothing left';
  -- The bill with notes on it cannot turn into a note itself.
  begin
    update public.invoices set document_type = 'credit_note', amount = -1 where id = v_bill;
    raise exception 'FAIL: a bill with notes became a note';
  exception when check_violation then null;
  end;
  raise notice '10 ok';

  -- 11. A debit note that a credit note leans on cannot go away or shrink.
  declare v_b2 uuid; v_d2 uuid;
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
    values (v_co, v_p1, 'R-3/26', current_date, 'expense', 'RSD', 100, 100, 1) returning id into v_b2;
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KZ-3/26', current_date, 'expense', 'RSD', 50, 'debit_note', v_b2) returning id into v_d2;
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, document_type, adjusts_invoice_id)
    values (v_co, v_p1, 'KO-13/26', current_date, 'expense', 'RSD', -140, 'credit_note', v_b2);
    begin
      update public.invoices set deleted_at = now() where id = v_d2;
      raise exception 'FAIL: deleted a debit note a credit note leans on';
    exception when check_violation then null;
    end;
    begin
      update public.invoices set amount = 10 where id = v_d2;
      raise exception 'FAIL: shrank a debit note a credit note leans on';
    exception when check_violation then null;
    end;
    begin
      update public.invoices set adjusts_invoice_id = null where id = v_d2;
      raise exception 'FAIL: unlinked a debit note a credit note leans on';
    exception when check_violation then null;
    end;
    update public.invoices set amount = 40 where id = v_d2;  -- 100 + 40 - 140 = 0: still allowed
  end;
  raise notice '11 ok';

  raise notice 'ALL TESTS PASSED';
end $$;
