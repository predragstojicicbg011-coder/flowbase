-- Tests for 20261020090000_one_bill_per_supplier_number.sql.
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/one_bill_per_supplier_number_test.sql; rollback;
-- Safe on a live database: fixtures only (company "Test duplikati (TEST-DUP)", two
-- suppliers), always rolled back. Run as the database owner. Ends with ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare v_co uuid; v_p1 uuid; v_p2 uuid; v_a uuid; v_b uuid;
begin
  insert into public.companies (name, country, currency) values ('Test duplikati (TEST-DUP)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.partners (name) values ('Test dobavljač 1 (TEST-DUP)') returning id into v_p1;
  insert into public.partners (name) values ('Test dobavljač 2 (TEST-DUP)') returning id into v_p2;

  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
  values (v_co, v_p1, '2026/0412', current_date, 'expense', 'RSD', 100) returning id into v_a;

  -- 1. Same supplier, same number written differently: refused.
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
    values (v_co, v_p1, '2026-0412', current_date, 'expense', 'RSD', 100);
    raise exception 'FAIL: the same bill was booked twice';
  exception when unique_violation then null;
  end;

  -- 2. Another supplier with the same number: allowed.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
  values (v_co, v_p2, '2026/0412', current_date, 'expense', 'RSD', 100);

  -- 3. A revenue invoice with that number: not this rule's business.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
  values (v_co, v_p1, '2026/0412', current_date, 'revenue', 'RSD', 100);

  -- 4. Renumbering another bill onto it: refused.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
  values (v_co, v_p1, '2026/0413', current_date, 'expense', 'RSD', 50) returning id into v_b;
  begin
    update public.invoices set invoice_number = '2026 0412' where id = v_b;
    raise exception 'FAIL: renumbered a bill onto one already booked';
  exception when unique_violation then null;
  end;

  -- 5. Any other edit of a bill is untouched by the rule.
  update public.invoices set note = 'izmena', amount = 120 where id = v_a;

  -- 6. Once the first is deleted, the bill can be booked again; bringing the deleted one back is refused.
  update public.invoices set deleted_at = now() where id = v_a;
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
  values (v_co, v_p1, '2026-0412', current_date, 'expense', 'RSD', 100);
  begin
    update public.invoices set deleted_at = null where id = v_a;
    raise exception 'FAIL: a deleted duplicate was brought back';
  exception when unique_violation then null;
  end;

  -- 7. Bills with no number or no supplier are not checked.
  insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
  values (v_co, v_p1, null, current_date, 'expense', 'RSD', 1), (v_co, v_p1, null, current_date, 'expense', 'RSD', 1),
         (v_co, null, '2026/0412', current_date, 'expense', 'RSD', 1), (v_co, null, '2026/0412', current_date, 'expense', 'RSD', 1);

  -- 8. The message names the bill.
  begin
    insert into public.invoices (company_id, partner_id, invoice_number, invoice_date, type, currency, amount)
    values (v_co, v_p1, '2026.0412', current_date, 'expense', 'RSD', 100);
  exception when unique_violation then
    assert sqlerrm like 'Račun broj 2026.0412 od ovog dobavljača je već proknjižen%', sqlerrm;
  end;

  raise notice 'ALL TESTS PASSED';
end $$;
