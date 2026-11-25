-- Tests for 20261125100000_a_final_invoice_uses_its_paid_proforma.sql (a final
-- invoice closed by a paid proforma directly, both directions; a payment never
-- allocated beyond itself, counted in dinars; a bill never paid twice).
--
-- Run in ONE transaction that is rolled back, with the migrations it needs in
-- front (begin/commit stripped) when the database lacks them. Fixtures only
-- (company "Test predracun direktno (TEST-PD)", invented partners), always
-- rolled back. Run as the database owner; section 12 acts as an administrator
-- through PostgREST's claims. Ends with ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_s1 uuid; v_s2 uuid; v_c1 uuid; v_prj uuid; v_admin uuid := 'f1d00000-0000-4000-8000-0000000000a1';
  v_pf1 uuid; v_pf2 uuid; v_pf3 uuid; v_pf4 uuid; v_cpf uuid; v_av2 uuid; v_av9 uuid;
  v_f1 uuid; v_f2 uuid; v_f3 uuid; v_f4 uuid; v_f5 uuid; v_f6 uuid; v_cf1 uuid; v_cf2 uuid; v_rev uuid; v_other uuid;
  v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_t5 uuid; v_tc uuid; v_tf uuid;
  v_b7 uuid; v_b9 uuid; v_b3 uuid; v_p500 uuid; v_p100 uuid; v_i60 uuid; v_i40 uuid;
  v_eur1 uuid; v_eur2 uuid; v_rsdb uuid; v_trsd uuid; v_teur uuid;
  v_par uuid; v_chi uuid; v_tpay uuid; v_gone uuid; v_kept uuid; v_t6 uuid; v_f8 uuid; v_t7 uuid;
  v_e19 uuid; v_t19 uuid; v_inv uuid; v_tx uuid; k int; v_rate numeric; v_bill numeric; v_bill_rsd numeric; v_pay numeric;
  v_own numeric; v_rsd numeric; v_refused int := 0; v_old_rule int := 0; v_first text;
  v_msg text; r record; n numeric;
begin
  insert into public.companies (name, country, currency) values ('Test predracun direktno (TEST-PD)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.partners (name) values ('Test dobavljac A (TEST-PD)') returning id into v_s1;
  insert into public.partners (name) values ('Test dobavljac B (TEST-PD)') returning id into v_s2;
  insert into public.partners (name) values ('Test kupac A (TEST-PD)') returning id into v_c1;

  -- 1. A supplier's paid proforma closes its bill in full, with no advance invoice.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, eur_rate, document_type)
  values (v_co, v_s1, 'PD-PR-1', current_date, 'expense', 'RSD', 2400, 2400, 1, 117.2, 'proforma') returning id into v_pf1;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s1, current_date, 'invoice_payment', 'RSD', 2400, 2400, false, 'posted') returning id into v_t1;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_pf1, v_t1, 2400, 2400);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, eur_rate, amount_eur)
  values (v_co, v_s1, 'PD-F-1', current_date, 'expense', 'RSD', 2400, 2400, 1, 117.2, 20.48) returning id into v_f1;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f1, v_pf1, 2400);
  select * into r from public.v_invoice_status where id = v_f1;
  assert r.calculated_status = 'paid' and r.remaining_rsd = 0 and r.advance_used = 2400 and r.amount_due = 0,
    format('F-1 %s %s %s', r.calculated_status, r.remaining_rsd, r.advance_used);
  assert (select used_directly from public.v_invoice_status where id = v_pf1) = 2400, 'PF-1 used directly 2400';
  assert (select amount_rsd = 2400 and amount_eur = 20.48 from public.advance_usage where final_invoice_id = v_f1), 'the use carries the BILL''s book figures';
  assert (select used_directly from public.v_invoice_status where id = v_f1) = 0, 'a bill has no used_directly';
  raise notice '1 ok';

  -- 2. Nothing is left of PF-1: another bill is refused, with the figures.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s1, 'PD-F-2', current_date, 'expense', 'RSD', 100, 100, 1) returning id into v_f2;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f2, v_pf1, 1);
    raise exception 'FAIL: a used-up proforma used again';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Po predračunu PD-PR-1 je plaćeno 2400.00; avansnim računima je pokriveno 0, a konačni računi koriste 2400.00, pa je ostalo 0.00, a traži se 1.00.',
    format('used-up message: %s', v_msg);
  raise notice '2 ok';

  -- 3. Partly: PF-2 paid 3000, an advance invoice covers 1000 of it; a bill of 5000 may use 2000 directly, not 2001.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_s1, 'PD-PR-2', current_date, 'expense', 'RSD', 3000, 3000, 1, 'proforma') returning id into v_pf2;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s1, current_date, 'invoice_payment', 'RSD', 3000, 3000, false, 'posted') returning id into v_t2;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_pf2, v_t2, 3000, 3000);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_s1, 'PD-AV-2', current_date, 'expense', 'RSD', 1000, 1000, 1, 'advance_invoice') returning id into v_av2;
  insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av2, v_pf2, 1000);
  set constraints all immediate;
  set constraints all deferred;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s1, 'PD-F-3', current_date, 'expense', 'RSD', 5000, 5000, 1) returning id into v_f3;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f3, v_pf2, 2001);
    raise exception 'FAIL: used more of PF-2 than paid less covered';
  exception when check_violation then null;
  end;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f3, v_pf2, 2000);
  select * into r from public.v_invoice_status where id = v_f3;
  assert r.calculated_status = 'partial' and r.remaining_rsd = 3000, format('F-3 %s %s', r.calculated_status, r.remaining_rsd);
  select * into r from public.v_invoice_status where id = v_pf2;
  assert r.used_directly = 2000 and r.covered = 1000 and r.paid_amount = 3000, format('PF-2 %s %s %s', r.used_directly, r.covered, r.paid_amount);
  raise notice '3 ok';

  -- 4. An advance invoice covering 1 more of PF-2 is refused: direct use is spoken for.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_s1, 'PD-AV-9', current_date, 'expense', 'RSD', 1, 1, 1, 'advance_invoice') returning id into v_av9;
  begin
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount) values (v_av9, v_pf2, 1);
    raise exception 'FAIL: coverage beyond paid less direct use';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Po predračunu PD-PR-2 je plaćeno 3000.00; konačni računi koriste 2000.00 direktno, a avansnim računima bi bilo pokriveno 1001.00.',
    format('coverage message: %s', v_msg);
  raise notice '4 ok';

  -- 5. A used proforma keeps its payment, its shape and its life; a used bill keeps its amount.
  begin
    delete from public.invoice_transaction_links where invoice_id = v_pf1;
    raise exception 'FAIL: a used proforma''s payment unlinked';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'Predračun PD-PR-1 je iskorišćen: avansnim računima je pokriveno 0, konačni računi koriste 2400.00 direktno, a plaćeno bi ostalo 0%',
    format('unlink message: %s', v_msg);
  begin
    update public.invoice_transaction_links set allocated_amount = 2000, allocated_amount_rsd = 2000 where invoice_id = v_pf1;
    raise exception 'FAIL: a used proforma''s payment lowered';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set deleted_at = now() where id = v_pf1;
    raise exception 'FAIL: a used proforma deleted';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set currency = 'EUR' where id = v_pf1;
    raise exception 'FAIL: a used proforma''s currency changed';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set partner_id = v_s2 where id = v_pf1;
    raise exception 'FAIL: a used proforma''s partner changed';
  exception when check_violation then null;
  end;
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type, adjusts_invoice_id)
    values (v_co, v_s1, 'PD-KO-1', current_date, 'expense', 'RSD', -500, -500, 1, 'credit_note', v_f1);
    raise exception 'FAIL: a credit note took a bill below the proforma it uses';
  exception when check_violation then null;
  end;
  begin
    update public.invoices set amount = 2000, amount_rsd = 2000 where id = v_f1;
    raise exception 'FAIL: a bill made smaller than the proforma it uses';
  exception when check_violation then null;
  end;
  raise notice '5 ok';

  -- 6. Only a live final invoice of the same direction, partner, company and currency.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-F-B', current_date, 'expense', 'RSD', 100, 100, 1) returning id into v_other;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_other, v_pf2, 1);
    raise exception 'FAIL: another supplier''s proforma used';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Predračun PD-PR-2 nije istog dobavljača, firme i valute kao konačni račun.', format('partner message: %s', v_msg);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, revenue_stream)
  values (v_co, v_s1, 'PD-I-1', current_date, 'revenue', 'RSD', 100, 100, 1, 'Ostalo') returning id into v_rev;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_rev, v_pf2, 1);
    raise exception 'FAIL: a supplier''s proforma used by our invoice';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Avans koristi samo živ račun istog smera, firme, partnera i valute.', format('direction message: %s', v_msg);
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_pf1, v_pf2, 1);
    raise exception 'FAIL: a proforma used as a final invoice';
  exception when check_violation then null;
  end;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_s1, 'PD-PR-4', current_date, 'expense', 'RSD', 900, 900, 1, 'proforma') returning id into v_pf4;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f2, v_pf4, 1);
    raise exception 'FAIL: an unpaid proforma used';
  exception when check_violation then null;
  end;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f2, v_f3, 1);
    raise exception 'FAIL: a bill used as a source';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Konačni račun se zatvara avansnim računom ili plaćenim predračunom.', format('source message: %s', v_msg);
  raise notice '6 ok';

  -- 7. The supplier line: paid on proformas, covered, used directly, waiting for a document.
  select * into r from public.v_supplier_advances where company_id = v_co and partner_id = v_s1;
  assert r.paid_on_proformas = 5400 and r.covered = 1000 and r.used_directly = 4400 and r.paid_without_advance = 0,
    format('supplier line %s %s %s %s', r.paid_on_proformas, r.covered, r.used_directly, r.paid_without_advance);
  raise notice '7 ok';

  -- 8. The other direction: our invoice to a customer closed by the customer's paid proforma.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_c1, 'PD-IPR-1', current_date, 'revenue', 'RSD', 1200, 1200, 1, 'proforma') returning id into v_cpf;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_c1, current_date, 'invoice_payment', 'RSD', 1200, 1200, false, 'posted') returning id into v_tc;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_cpf, v_tc, 1200, 1200);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, revenue_stream)
  values (v_co, v_c1, 'PD-IF-1', current_date, 'revenue', 'RSD', 1000, 1000, 1, 'Ostalo') returning id into v_cf1;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_cf1, v_cpf, 1000);
  assert (select calculated_status from public.v_invoice_status where id = v_cf1) = 'paid', 'the customer invoice is paid by the proforma';
  select * into r from public.v_customer_advances where company_id = v_co and partner_id = v_c1;
  assert r.received_on_proformas = 1200 and r.used_directly = 1000 and r.received_without_advance = 200,
    format('customer line %s %s %s', r.received_on_proformas, r.used_directly, r.received_without_advance);
  assert not exists (select 1 from public.v_supplier_advances where company_id = v_co and partner_id = v_c1), 'a customer is not a supplier line';
  insert into public.projects (company_id, name) values (v_co, 'Test gradiliste (TEST-PD)') returning id into v_prj;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, revenue_stream, project_id, advance_deducted, advance_deducted_rsd, advance_deducted_eur)
  values (v_co, v_c1, 'PD-IF-D', current_date, 'revenue', 'RSD', 500, 500, 1, 'Ostalo', v_prj, 100, 100, 0) returning id into v_cf2;
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_cf2, v_cpf, 100);
    raise exception 'FAIL: a proforma used by an invoice with a project advance';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Račun PD-IF-D već ima odbijen avans po projektu (stari način); predračun se na njega ne vezuje.', format('project message: %s', v_msg);
  raise notice '8 ok';

  -- 9. A bill is not paid twice: F-5 1500, 300 paid by a payment; PF-3 paid 1500.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, document_type)
  values (v_co, v_s2, 'PD-PR-3', current_date, 'expense', 'RSD', 1500, 1500, 1, 'proforma') returning id into v_pf3;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 1500, 1500, false, 'posted') returning id into v_t3;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_pf3, v_t3, 1500, 1500);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-F-5', current_date, 'expense', 'RSD', 1500, 1500, 1) returning id into v_f5;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 2000, 2000, false, 'posted') returning id into v_t4;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_f5, v_t4, 300, 300);
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f5, v_pf3, 1202);
    raise exception 'FAIL: a bill paid twice by a proforma and a payment';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'Račun PD-F-5 duguje 1500.00, plaćanja već drže 300.00, a iskorišćeni avansi bi bili 1202.00 — bio bi plaćen dva puta.%',
    format('paid twice (use) message: %s', v_msg);
  -- Within the one-dinar tolerance passes: 1201.
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f5, v_pf3, 1201);
  delete from public.advance_usage where final_invoice_id = v_f5;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f5, v_pf3, 1200);
  assert (select calculated_status from public.v_invoice_status where id = v_f5) = 'paid', 'F-5 paid by 300 and 1200';
  -- The payment side of the same rule: raising F-5's payment link is refused.
  begin
    update public.invoice_transaction_links set allocated_amount = 400, allocated_amount_rsd = 400 where invoice_id = v_f5 and transaction_id = v_t4;
    raise exception 'FAIL: a payment link raised on a bill a proforma closes';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'Račun PD-F-5 duguje 1500.00, a avansni računi ili predračuni već zatvaraju 1200.00 od toga; plaćanja bi držala 400.00 — bio bi plaćen dva puta.%',
    format('paid twice (link) message: %s', v_msg);
  update public.invoice_transaction_links set allocated_amount = 250, allocated_amount_rsd = 250 where invoice_id = v_f5 and transaction_id = v_t4;
  update public.invoice_transaction_links set allocated_amount = 300, allocated_amount_rsd = 300 where invoice_id = v_f5 and transaction_id = v_t4;
  raise notice '9 ok';

  -- 10. A bill that stands paid twice (written past the rules, as live data could be) can still be re-saved and lowered.
  set local session_replication_role = replica;
  update public.invoice_transaction_links set allocated_amount = 900, allocated_amount_rsd = 900 where invoice_id = v_f5 and transaction_id = v_t4;
  set local session_replication_role = origin;
  perform public.replace_advance_links(v_f5, null, jsonb_build_array(jsonb_build_object('proforma_id', v_pf3, 'amount', 1200)));
  begin
    perform public.replace_advance_links(v_f5, null, jsonb_build_array(jsonb_build_object('proforma_id', v_pf3, 'amount', 1300)));
    raise exception 'FAIL: a use raised on a bill that stands paid twice';
  exception when check_violation then null;
  end;
  perform public.replace_advance_links(v_f5, null, jsonb_build_array(jsonb_build_object('proforma_id', v_pf3, 'amount', 1100)));
  assert (select sum(amount) from public.advance_usage where final_invoice_id = v_f5) = 1100, 'lowered to 1100';
  assert coalesce(current_setting('flowbase.uses_before_' || replace(v_f5::text, '-', ''), true), '') = '', 'the note is cleared after the call';
  update public.invoice_transaction_links set allocated_amount = 900, allocated_amount_rsd = 900 where invoice_id = v_f5 and transaction_id = v_t4;
  begin
    update public.invoice_transaction_links set allocated_amount = 901, allocated_amount_rsd = 901 where invoice_id = v_f5 and transaction_id = v_t4;
    raise exception 'FAIL: a payment link raised on a bill that stands paid twice';
  exception when check_violation then null;
  end;
  update public.invoice_transaction_links set allocated_amount = 300, allocated_amount_rsd = 300 where invoice_id = v_f5 and transaction_id = v_t4;
  raise notice '10 ok';

  -- 11. A payment is not allocated beyond itself (dinars).
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-B-700', current_date, 'expense', 'RSD', 700, 700, 1) returning id into v_b7;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-B-900', current_date, 'expense', 'RSD', 900, 900, 1) returning id into v_b9;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-B-300', current_date, 'expense', 'RSD', 300, 300, 1) returning id into v_b3;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'direct', 'RSD', 700, 700, true, 'posted') returning id into v_t5;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b7, v_t5, 700, 700);
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b9, v_t5, 700, 700);
    raise exception 'FAIL: one payment allocated twice';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'Plaćanje od 700.00 RSD (%) bilo bi raspoređeno 1400.00 RSD, a vredi 700.00 RSD — više nego što je plaćeno. Već plaća: PD-B-700 (700.00 RSD).%',
    format('over-allocation message: %s', v_msg);
  -- The live shape (written past the rules) stands; only a raise is refused.
  set local session_replication_role = replica;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b9, v_t5, 700, 700);
  set local session_replication_role = origin;
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b3, v_t5, 1, 1);
    raise exception 'FAIL: a third link on an over-allocated payment';
  exception when check_violation then null;
  end;
  begin
    update public.invoice_transaction_links set allocated_amount = 701, allocated_amount_rsd = 701 where invoice_id = v_b9 and transaction_id = v_t5;
    raise exception 'FAIL: a link of an over-allocated payment raised';
  exception when check_violation then null;
  end;
  update public.invoice_transaction_links set allocated_amount = 700, allocated_amount_rsd = 700 where invoice_id = v_b9 and transaction_id = v_t5;
  update public.invoice_transaction_links set allocated_amount = 100, allocated_amount_rsd = 100 where invoice_id = v_b9 and transaction_id = v_t5;
  delete from public.invoice_transaction_links where invoice_id = v_b9 and transaction_id = v_t5;
  -- 300 + 300 on a 500 payment: the second refused, 200 accepted; two in one statement refused; moving a link onto a full payment refused.
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 500, 500, false, 'posted') returning id into v_p500;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b9, v_p500, 300, 300);
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b3, v_p500, 300, 300);
    raise exception 'FAIL: 600 on a 500 payment';
  exception when check_violation then null;
  end;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b3, v_p500, 200, 200);
  delete from public.invoice_transaction_links where transaction_id = v_p500;
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
    values (v_b9, v_p500, 300, 300), (v_b3, v_p500, 300, 300);
    raise exception 'FAIL: two links in one statement over the payment';
  exception when check_violation then null;
  end;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_b9, v_p500, 500, 500);
  begin
    update public.invoice_transaction_links set transaction_id = v_p500 where invoice_id = v_b7 and transaction_id = v_t5;
    raise exception 'FAIL: a link moved onto a full payment';
  exception when check_violation then null;
  end;
  -- Within a para per link passes (the rounding settlementFor allows).
  update public.invoice_transaction_links set allocated_amount = 500.01, allocated_amount_rsd = 500.01 where invoice_id = v_b9 and transaction_id = v_p500;
  raise notice '11 ok';

  -- 12. In dinars, as the payment sees each link (FlowBase: cross-currency links are counted).
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, amount_eur, exchange_rate, eur_rate)
  values (v_co, v_s2, 'PD-E-1', current_date, 'expense', 'EUR', 1000, 117500, 1000, 117.5, 117.5) returning id into v_eur1;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-R-1', current_date, 'expense', 'RSD', 50000, 50000, 1) returning id into v_rsdb;
  -- A dinar payment of a euro bill: 117500 RSD pays the 1000 EUR bill in full...
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 117500, 117500, false, 'posted') returning id into v_trsd;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd, allocated_amount_eur) values (v_eur1, v_trsd, 1000, 117500, 1000);
  -- ...and nothing is left of it for a dinar bill (Mintflow would not count the euro link and let it through).
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_rsdb, v_trsd, 2, 2);
    raise exception 'FAIL: a dinar payment of a euro bill allocated again';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg like 'Plaćanje od 117500.00 RSD (%) bilo bi raspoređeno 117502.00 RSD, a vredi 117500.00 RSD%Već plaća: PD-E-1 (1000.00 EUR).%',
    format('cross-currency message: %s', v_msg);
  delete from public.invoice_transaction_links where invoice_id = v_eur1 and transaction_id = v_trsd;
  -- A euro payment of a euro bill booked at a higher rate: the move is the currency difference, not an over-allocation.
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, amount_eur, exchange_rate, eur_rate, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'EUR', 1000, 117200, 1000, 117.2, 117.2, false, 'posted') returning id into v_teur;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd, allocated_amount_eur) values (v_eur1, v_teur, 1000, 117500, 1000);
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_rsdb, v_teur, 100, 100);
    raise exception 'FAIL: a spent euro payment allocated to a dinar bill';
  exception when check_violation then null;
  end;
  -- A euro payment half spent: 500 EUR left = 58600 RSD at its own rate; a dinar bill may take that (and a para of a
  -- euro per link, 1.172 RSD), not more.
  update public.invoice_transaction_links set allocated_amount = 500, allocated_amount_rsd = 58750, allocated_amount_eur = 500 where invoice_id = v_eur1 and transaction_id = v_teur;
  begin
    insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_rsdb, v_teur, 58605, 58605);
    raise exception 'FAIL: a euro payment over-allocated through a dinar bill';
  exception when check_violation then null;
  end;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_rsdb, v_teur, 58600, 58600);
  raise notice '12 ok';

  -- 13. A payroll child mirrors its parent: child then parent on one payment both pass.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-PAY', current_date, 'expense', 'RSD', 1000, 1000, 1) returning id into v_par;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, parent_invoice_id)
  values (v_co, v_s2, 'PD-PAY-1', current_date, 'expense', 'RSD', 1000, 1000, 1, v_par) returning id into v_chi;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 1000, 1000, false, 'posted') returning id into v_tpay;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_chi, v_tpay, 1000, 1000);
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_par, v_tpay, 1000, 1000);
  raise notice '13 ok';

  -- 14. 60/40 edited to 70/30: raising first is refused, lowering first passes.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-60', current_date, 'expense', 'RSD', 100, 100, 1) returning id into v_i60;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-40', current_date, 'expense', 'RSD', 100, 100, 1) returning id into v_i40;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 100, 100, false, 'posted') returning id into v_p100;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_i60, v_p100, 60, 60), (v_i40, v_p100, 40, 40);
  begin
    update public.invoice_transaction_links set allocated_amount = 70, allocated_amount_rsd = 70 where invoice_id = v_i60 and transaction_id = v_p100;
    raise exception 'FAIL: raised first';
  exception when check_violation then null;
  end;
  update public.invoice_transaction_links set allocated_amount = 30, allocated_amount_rsd = 30 where invoice_id = v_i40 and transaction_id = v_p100;
  update public.invoice_transaction_links set allocated_amount = 70, allocated_amount_rsd = 70 where invoice_id = v_i60 and transaction_id = v_p100;
  raise notice '14 ok';

  -- 15. A soft-deleted final invoice releases its proforma, which another bill can then use.
  update public.invoices set deleted_at = now() where id = v_f3;
  assert (select used_directly from public.v_invoice_status where id = v_pf2) = 0, 'PF-2 released';
  assert (select paid_without_advance from public.v_supplier_advances where company_id = v_co and partner_id = v_s1) = 2000, 'PF-2 waits for a document again';
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s1, 'PD-F-6', current_date, 'expense', 'RSD', 2000, 2000, 1) returning id into v_f6;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f6, v_pf2, 2000);
  raise notice '15 ok';

  -- 16. Through replace_advance_links as an administrator (PostgREST's claims): a proforma_id names the source.
  insert into auth.users (id, email) values (v_admin, 'pd-admin@example.invalid');
  insert into public.profiles (id, email, full_name, role) values (v_admin, 'pd-admin@example.invalid', 'PD Admin', 'administrator');
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s1, 'PD-F-4', current_date, 'expense', 'RSD', 2400, 2400, 1) returning id into v_f4;
  delete from public.advance_usage where final_invoice_id = v_f6;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.replace_advance_links(v_f4, null, jsonb_build_array(jsonb_build_object('proforma_id', v_pf2, 'amount', 1500)));
  assert (select calculated_status from public.v_invoice_status where id = v_f4) = 'partial', 'F-4 partial through the call';
  begin
    perform public.replace_advance_links(v_f4, null, jsonb_build_array(jsonb_build_object('proforma_id', v_pf2, 'amount', 2500)));
    raise exception 'FAIL: 2500 of a proforma with 2000 left';
  exception when check_violation then null;
  end;
  assert (select sum(amount) from public.advance_usage where final_invoice_id = v_f4) = 1500, 'the 1500 use stands: one transaction';
  perform public.replace_advance_links(v_f4, null, '[]'::jsonb);
  assert not exists (select 1 from public.advance_usage where final_invoice_id = v_f4), 'an empty list removes the use';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  raise notice '16 ok';

  -- 17. The existing chain reads as it did: an advance invoice still closes a bill.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s1, 'PD-F-7', current_date, 'expense', 'RSD', 1000, 1000, 1) returning id into v_other;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_other, v_av2, 1000);
  assert (select calculated_status from public.v_invoice_status where id = v_other) = 'paid', 'an advance invoice closes a bill';
  assert (select advance_open from public.v_invoice_status where id = v_av2) = 0, 'AV-2 used up';
  begin
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f2, v_av2, 1);
    raise exception 'FAIL: a used-up advance invoice used';
  exception when check_violation then get stacked diagnostics v_msg = message_text;
  end;
  assert v_msg = 'Od avansnog računa PD-AV-2 (1000.00) je ostalo 0.00, a traži se 1.00.', format('advance message: %s', v_msg);
  raise notice '17 ok';

  -- 18. The edges the guard draws: a deleted invoice's link is not counted; a
  --     bill closes to the dinar; a raise of the dinar figure alone is asked.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-GONE', current_date, 'expense', 'RSD', 400, 400, 1) returning id into v_gone;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s2, 'PD-KEPT', current_date, 'expense', 'RSD', 400, 400, 1) returning id into v_kept;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 400, 400, false, 'posted') returning id into v_t6;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_gone, v_t6, 400, 400);
  update public.invoices set deleted_at = now() where id = v_gone;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_kept, v_t6, 400, 400);
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate)
  values (v_co, v_s1, 'PD-F-8', current_date, 'expense', 'RSD', 1500, 1500, 1) returning id into v_f8;
  insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount) values (v_f8, v_pf2, 1000);
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s1, current_date, 'invoice_payment', 'RSD', 600, 600, false, 'posted') returning id into v_t7;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd) values (v_f8, v_t7, 501, 501);
  begin
    update public.invoice_transaction_links set allocated_amount = 502, allocated_amount_rsd = 502 where invoice_id = v_f8 and transaction_id = v_t7;
    raise exception 'FAIL: a bill held beyond the dinar it closes by';
  exception when check_violation then null;
  end;
  -- The 117500 RSD payment again (its link was removed in 12), 999 EUR of the euro bill.
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd, allocated_amount_eur) values (v_eur1, v_trsd, 999, 117382.5, 999);
  begin
    update public.invoice_transaction_links set allocated_amount_rsd = 117600 where invoice_id = v_eur1 and transaction_id = v_trsd;
    raise exception 'FAIL: the dinar figure of a cross-currency link raised past the payment';
  exception when check_violation then null;
  end;
  raise notice '18 ok';

  -- 19. A dinar payment short of a euro bill (fix round 1). settlementFor's
  --     part payment writes own = round2(dinars / rate) and linkAmountsFromOwn
  --     its dinars as round2(own * rate): up to half a euro-para ABOVE the
  --     payment. A para of the invoice's currency per such link is allowed.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, amount_eur, exchange_rate, eur_rate)
  values (v_co, v_s2, 'PD-E-19', current_date, 'expense', 'EUR', 1000, 117500, 1000, 117.5, 117.5) returning id into v_e19;
  insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
  values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', 117200, 117200, false, 'posted') returning id into v_t19;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd, allocated_amount_eur)
  values (v_e19, v_t19, 997.45, 117200.38, 997.45);
  assert (select allocated_amount_rsd from public.invoice_transaction_links where transaction_id = v_t19) = 117200.38, '997,45 EUR = 117.200,38 RSD stands';
  -- A para of the invoice's currency (1,175 RSD), not more.
  begin
    update public.invoice_transaction_links set allocated_amount_rsd = 117201.25 where transaction_id = v_t19;
    raise exception 'FAIL: more than a euro-para above a dinar payment';
  exception when check_violation then null;
  end;
  -- The sweep: settlementFor's own outputs, part and whole, over random bills and rates.
  perform setseed(0.25);
  for k in 1 .. 400 loop
    v_rate := round((95 + random() * 30)::numeric, 4);
    v_bill := round((1 + random() * 20000)::numeric, 2);
    v_bill_rsd := round(v_bill * v_rate, 2);
    v_pay := round((v_bill_rsd * (0.5 + random() * 0.51))::numeric, 2);
    if v_pay >= v_bill_rsd - 0.01 then
      v_own := v_bill; v_rsd := v_bill_rsd;                      -- covers the remainder: the remainder itself
    else
      v_own := least(v_bill, round(v_pay / v_rate, 2));          -- partFromRsd
      v_rsd := round(v_own * v_rate, 2);                         -- partBookAmounts
    end if;
    if v_rsd > v_pay + 0.01 + 0.005 then v_old_rule := v_old_rule + 1; end if;
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, amount_eur, exchange_rate, eur_rate)
    values (v_co, v_s2, 'PD-SW-' || k, current_date, 'expense', 'EUR', v_bill, v_bill_rsd, v_bill, v_rate, v_rate) returning id into v_inv;
    insert into public.transactions (company_id, partner_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status)
    values (v_co, v_s2, current_date, 'invoice_payment', 'RSD', v_pay, v_pay, false, 'posted') returning id into v_tx;
    begin
      insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd, allocated_amount_eur)
      values (v_inv, v_tx, v_own, v_rsd, v_own);
    exception when check_violation then
      v_refused := v_refused + 1;
      v_first := coalesce(v_first, format('bill %s EUR at %s, payment %s RSD -> %s EUR / %s RSD', v_bill, v_rate, v_pay, v_own, v_rsd));
    end;
  end loop;
  assert v_refused = 0, format('%s of settlementFor''s own outputs refused, first: %s', v_refused, v_first);
  assert v_old_rule > 0, 'the sweep never reached a part payment above the payment by more than a dinar-para';
  raise notice '19 ok (% of 400 above a dinar-para, none refused)', v_old_rule;

  raise notice 'ALL TESTS PASSED';
end $$;
