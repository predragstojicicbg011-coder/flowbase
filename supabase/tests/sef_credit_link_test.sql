-- Tests for 20261125110000_an_interest_invoice_is_linked_to_its_instalment.sql.
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/sef_credit_link_test.sql; rollback;
-- Fixtures only (companies "Test kamata (TEST-KR)" and "Test druga firma
-- (TEST-KR)", users 0d5c...d1-d5, invented PIBs 900000017 / 900000042 and
-- figures), always rolled back. Run as the database owner. Ends with ALL TESTS
-- PASSED.
--
-- Actors: d1 administrator, d2 owner, d3 manager, d4 administrative assistant,
-- d5 a signed-in account with no profile (as MCFlow's MCOdobri users are).
--
-- Credits (all invented):
--   CR1  EUR, active: #1 paid in full by a bank line, #2 partly paid, #3 unpaid.
--   CR2  RSD, closed: #9 its last instalment, paid.
-- Inbox rows: P1, P2 purchase, pending, RSD, from the bank's PIB; S1 a sales
-- row; O1 a purchase row addressed to the second company.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_co2 uuid; v_bank uuid; v_cr1 uuid; v_cr2 uuid; v_tx uuid;
  v_i1 uuid; v_i2 uuid; v_i3 uuid; v_i9 uuid;
  v_p1 uuid; v_p2 uuid; v_p3 uuid; v_s1 uuid; v_o1 uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x.email, now(), now()
    from (values
      ('0d5c0000-0000-4000-8000-0000000000d1', 'kr-test-d1@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000d2', 'kr-test-d2@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000d3', 'kr-test-d3@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000d4', 'kr-test-d4@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000d5', 'kr-test-d5@example.invalid')) as x(id, email);
  insert into public.profiles (id, full_name, email, role) values
    ('0d5c0000-0000-4000-8000-0000000000d1', 'Test Administrator', 'kr-test-d1@example.invalid', 'administrator'),
    ('0d5c0000-0000-4000-8000-0000000000d2', 'Test Vlasnik',       'kr-test-d2@example.invalid', 'owner'),
    ('0d5c0000-0000-4000-8000-0000000000d3', 'Test Menadžer',      'kr-test-d3@example.invalid', 'manager'),
    ('0d5c0000-0000-4000-8000-0000000000d4', 'Test Asistent',      'kr-test-d4@example.invalid', 'administrative_assistant');

  insert into public.companies (name, country, currency) values ('Test kamata (TEST-KR)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.companies (name, country, currency) values ('Test druga firma (TEST-KR)', 'Srbija', 'RSD') returning id into v_co2;
  insert into public.banks (company_id, name, currencies) values (v_co, 'Test banka (TEST-KR)', array['RSD', 'EUR']) returning id into v_bank;

  insert into public.credits (company_id, name, bank, principal_amount, currency, status)
  values (v_co, 'Test kredit EUR (TEST-KR)', 'Test banka', 30000, 'EUR', 'active') returning id into v_cr1;
  insert into public.credits (company_id, name, bank, principal_amount, currency, status)
  values (v_co, 'Test kredit RSD (TEST-KR)', 'Test banka', 900000, 'RSD', 'closed') returning id into v_cr2;

  insert into public.transactions (company_id, bank_id, transaction_date, type, tx_subtype, currency, amount, amount_rsd, pl_impact, status, note)
  values (v_co, v_bank, '2026-10-30', 'credit_payment', 'expense', 'EUR', 1250, 146500, false, 'posted', 'KR BANK LINE') returning id into v_tx;

  insert into public.credit_installments (credit_id, installment_no, due_date, principal_amount, interest_amount, total_amount, status, transaction_id, paid_date, paid_amount)
  values (v_cr1, 1, '2026-10-31', 1000, 250, 1250, 'paid', v_tx, '2026-10-30', 1250) returning id into v_i1;
  insert into public.credit_installments (credit_id, installment_no, due_date, principal_amount, interest_amount, total_amount, status, paid_amount)
  values (v_cr1, 2, '2026-11-30', 1000, 262.01, 1262.01, 'outstanding', 600) returning id into v_i2;
  insert into public.credit_installments (credit_id, installment_no, due_date, principal_amount, interest_amount, total_amount, status, paid_amount)
  values (v_cr1, 3, '2026-12-31', 1000, 240, 1240, 'outstanding', 0) returning id into v_i3;
  insert into public.credit_installments (credit_id, installment_no, due_date, principal_amount, interest_amount, total_amount, status, paid_date, paid_amount)
  values (v_cr2, 9, '2026-10-25', 450, 50, 500, 'paid', '2026-10-25', 500) returning id into v_i9;

  insert into public.sef_inbox (company_id, direction, sef_invoice_id, overview_json, supplier_name, supplier_vat_number, currency, amount, document_number, sent_date)
  values (v_co, 'purchase', -8101, '{}', 'Test banka', 'RS 900-000-017', 'RSD', 30705.92, 'KR-TEST-1', '2026-11-28T09:00:00Z') returning id into v_p1;
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, overview_json, supplier_name, supplier_vat_number, currency, amount, document_number, sent_date)
  values (v_co, 'purchase', -8102, '{}', 'Test banka', '900000017', 'EUR', 262.01, 'KR-TEST-2', '2026-11-29T09:00:00Z') returning id into v_p2;
  -- P3: another bank's PIB, on the same credit.
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, overview_json, supplier_name, supplier_vat_number, currency, amount, document_number)
  values (v_co, 'purchase', -8105, '{}', 'Druga banka', '900000042', 'EUR', 240, 'KR-TEST-3') returning id into v_p3;
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, overview_json, customer_name, currency, amount, document_number)
  values (v_co, 'sales', -8103, '{}', 'Test kupac', 'RSD', 100, 'IZL-TEST-1') returning id into v_s1;
  insert into public.sef_inbox (company_id, direction, sef_invoice_id, overview_json, supplier_name, supplier_vat_number, currency, amount, document_number)
  values (v_co2, 'purchase', -8104, '{}', 'Test banka', '900000042', 'RSD', 100, 'KR-TEST-O') returning id into v_o1;

  perform set_config('kr.co', v_co::text, true);
  perform set_config('kr.cr1', v_cr1::text, true);
  perform set_config('kr.cr2', v_cr2::text, true);
  perform set_config('kr.tx', v_tx::text, true);
  perform set_config('kr.i1', v_i1::text, true);
  perform set_config('kr.i2', v_i2::text, true);
  perform set_config('kr.i3', v_i3::text, true);
  perform set_config('kr.i9', v_i9::text, true);
  perform set_config('kr.p1', v_p1::text, true);
  perform set_config('kr.p2', v_p2::text, true);
  perform set_config('kr.p3', v_p3::text, true);
  perform set_config('kr.s1', v_s1::text, true);
  perform set_config('kr.o1', v_o1::text, true);
end $$;

-- One statement as one of the actors, under RLS, answered "sqlstate|message|result".
create function pg_temp.kr_as(p_user text, p_sql text) returns text
language plpgsql as $$
declare
  back text := current_user;
  r text; v_state text; v_msg text;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  execute 'set local role authenticated';
  begin
    execute p_sql into r;
    v_state := '00000';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  execute format('set local role %I', back);
  perform set_config('request.jwt.claims', '', true);
  return v_state || '|' || coalesce(v_msg, '') || '|' || coalesce(r, '');
end $$;

create function pg_temp.kr_link(p_user text, p_row text, p_inst text) returns text
language sql as $$
  select pg_temp.kr_as(p_user, format('select public.sef_inbox_link_installment(%L::uuid, %L::uuid)::text', p_row, p_inst))
$$;

create function pg_temp.kr_unpaid(p_user text, p_inst text) returns text
language sql as $$
  select pg_temp.kr_as(p_user, format('select public.credit_installment_mark_unpaid(%L::uuid)::text', p_inst))
$$;

create function pg_temp.kr_row(p_row text) returns text
language sql as $$
  select concat_ws('/', state, coalesce(credit_installment_id::text, 'null'), coalesce(linked_by::text, 'null'),
                   case when linked_at is null then 'no-at' else 'at' end)
    from public.sef_inbox where id = p_row::uuid
$$;

create function pg_temp.kr_inst(p_inst text) returns text
language sql as $$
  select concat_ws('/', status, paid_amount, coalesce(paid_date::text, 'null'), coalesce(transaction_id::text, 'null'))
    from public.credit_installments where id = p_inst::uuid
$$;

-- ══ 1. Who may not link ═════════════════════════════════════════════════════

do $$
declare a text; who text;
begin
  foreach who in array array['0d5c0000-0000-4000-8000-0000000000d3',   -- manager
                             '0d5c0000-0000-4000-8000-0000000000d5']   -- no profile
  loop
    a := pg_temp.kr_link(who, current_setting('kr.p1'), current_setting('kr.i2'));
    assert a = '42501|Samo finansijski tim može da poveže SEF fakturu sa ratom kredita. Ništa nije povezano.|', who || ': ' || a;
  end loop;
  a := pg_temp.kr_link(null, current_setting('kr.p1'), current_setting('kr.i2'));
  assert a = 'SEFLK|Prijavite se: zahtev nije nosio prijavljenog korisnika. Ništa nije povezano.|', 'nobody: ' || a;
  assert not has_function_privilege('anon', 'public.sef_inbox_link_installment(uuid, uuid)', 'execute'), 'anon may link';
  assert pg_temp.kr_row(current_setting('kr.p1')) = 'pending/null/null/no-at', 'a refused caller changed the row';

  -- Nobody writes the link by hand, and the state alone cannot say linked.
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d1',
    format('update public.sef_inbox set credit_installment_id = %L where id = %L returning id::text', current_setting('kr.i2'), current_setting('kr.p1')));
  assert a like '42501|permission denied for table sef_inbox|%', 'link column written by hand: ' || a;
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d4',
    format('update public.sef_inbox set state = ''linked'' where id = %L returning id::text', current_setting('kr.p1')));
  assert a = 'SEFLK|Faktura se povezuje sa ratom kredita samo izborom rate. Ništa nije promenjeno.|', 'linked by hand: ' || a;
  raise notice '1 ok';
end $$;

-- ══ 2. A bookkeeper links, across currencies; the refusals say why ══════════

do $$
declare a text;
begin
  -- The assistant keeps the books (can_write_books), and links an RSD invoice
  -- to an instalment of a EUR credit.
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d4', current_setting('kr.p1'), current_setting('kr.i2'));
  assert split_part(a, '|', 1) = '00000', 'assistant link: ' || a;
  assert pg_temp.kr_row(current_setting('kr.p1')) = 'linked/' || current_setting('kr.i2') || '/0d5c0000-0000-4000-8000-0000000000d4/at',
    'link not taken: ' || pg_temp.kr_row(current_setting('kr.p1'));
  -- The bank's PIB, as digits, is remembered on the credit.
  assert (select lender_pib from public.credits where id = current_setting('kr.cr1')::uuid) = '900000017', 'PIB not remembered';

  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.p1'), current_setting('kr.i3'));
  assert a = 'SEFLK|Faktura ne čeka u redu: već je proknjižena, odbijena ili povezana. Ništa nije povezano.|', 'second link: ' || a;
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.s1'), current_setting('kr.i3'));
  assert a = 'SEFLK|Sa ratom kredita se povezuje samo ulazna faktura, a ova je izlazna. Ništa nije povezano.|', 'sales: ' || a;
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.o1'), current_setting('kr.i3'));
  assert a = 'SEFLK|Faktura je upućena drugoj firmi, a ne onoj čiji je kredit. Ništa nije povezano.|', 'other company: ' || a;
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.p2'), gen_random_uuid()::text);
  assert a = 'SEFLK|Ta rata kredita ne postoji. Ništa nije povezano.|', 'no instalment: ' || a;
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', gen_random_uuid()::text, current_setting('kr.i3'));
  assert a = 'SEFLK|Taj red SEF sandučeta ne postoji. Ništa nije povezano.|', 'no row: ' || a;
  assert pg_temp.kr_row(current_setting('kr.s1')) = 'pending/null/null/no-at', 'sales row moved';
  assert pg_temp.kr_row(current_setting('kr.o1')) = 'pending/null/null/no-at', 'other company row moved';

  -- A credit that already remembers a PIB keeps it: the first link wins.
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.p3'), current_setting('kr.i3'));
  assert split_part(a, '|', 1) = '00000', 'p3 link: ' || a;
  assert (select lender_pib from public.credits where id = current_setting('kr.cr1')::uuid) = '900000017', 'PIB overwritten by another bank';
  -- And unlinking that other bank's invoice does not make it forget its own.
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d1',
    format('update public.sef_inbox set state = ''pending'', restored_at = now() where id = %L returning id::text', current_setting('kr.p3')));
  assert split_part(a, '|', 1) = '00000', 'p3 unlink: ' || a;
  assert (select lender_pib from public.credits where id = current_setting('kr.cr1')::uuid) = '900000017', 'PIB forgotten for another bank';

  -- No invoice and no transaction came of it.
  assert not exists (select 1 from public.invoices where company_id = current_setting('kr.co')::uuid), 'an invoice was created';
  assert (select count(*) from public.transactions where company_id = current_setting('kr.co')::uuid) = 1, 'a transaction was created';
  -- The PIB write is audited with the caller (the FK to auth.users holds).
  assert exists (select 1 from public.audit_log where table_name = 'credits' and record_id = current_setting('kr.cr1')::uuid
                    and user_id = '0d5c0000-0000-4000-8000-0000000000d4'), 'audit row without the caller';
  raise notice '2 ok';
end $$;

-- ══ 3. Every member reads the link (the Krediti page reads the table) ═══════

do $$
declare a text;
begin
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d3',
    format('select string_agg(credit_installment_id::text, '','') from public.sef_inbox where state = ''linked'' and id = %L', current_setting('kr.p1')));
  assert a = '00000||' || current_setting('kr.i2'), 'manager read: ' || a;
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d5', 'select count(*)::text from public.sef_inbox');
  assert a = '00000||0', 'a non-member read the inbox: ' || a;
  raise notice '3 ok';
end $$;

-- ══ 4. Declined while linked: refused. Unlinked: the PIB goes with the last ══

do $$
declare a text;
begin
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d1',
    format('update public.sef_inbox set state = ''dismissed'', dismiss_reason = ''x'', dismissed_at = now() where id = %L returning id::text', current_setting('kr.p1')));
  assert a = 'SEFLK|Ova faktura je povezana sa ratom kredita. Prvo je odvežite, čime se vraća u red.|', 'declined while linked: ' || a;

  -- A second invoice from the same bank, on the same credit.
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d2', current_setting('kr.p2'), current_setting('kr.i2'));
  assert split_part(a, '|', 1) = '00000', 'owner link: ' || a;

  -- Unlink one: the other still says it, so the credit keeps the PIB.
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d1',
    format('update public.sef_inbox set state = ''pending'', restored_at = now() where id = %L returning id::text', current_setting('kr.p2')));
  assert split_part(a, '|', 1) = '00000', 'unlink p2: ' || a;
  assert pg_temp.kr_row(current_setting('kr.p2')) = 'pending/null/null/no-at', 'p2 not cleared';
  assert (select lender_pib from public.credits where id = current_setting('kr.cr1')::uuid) = '900000017', 'PIB forgotten too early';

  -- Unlink the last: the credit forgets it.
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d4',
    format('update public.sef_inbox set state = ''pending'', restored_at = now() where id = %L returning id::text', current_setting('kr.p1')));
  assert split_part(a, '|', 1) = '00000', 'unlink p1: ' || a;
  assert (select lender_pib from public.credits where id = current_setting('kr.cr1')::uuid) is null, 'PIB kept after the last unlink';
  raise notice '4 ok';
end $$;

-- ══ 5. Back to unpaid ═══════════════════════════════════════════════════════

do $$
declare a text; who text; before text;
begin
  -- Link P1 to #1 again: the return to unpaid keeps it.
  a := pg_temp.kr_link('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.p1'), current_setting('kr.i1'));
  assert split_part(a, '|', 1) = '00000', 'relink: ' || a;

  before := pg_temp.kr_inst(current_setting('kr.i1'));
  foreach who in array array['0d5c0000-0000-4000-8000-0000000000d3',   -- manager
                             '0d5c0000-0000-4000-8000-0000000000d5']   -- no profile
  loop
    a := pg_temp.kr_unpaid(who, current_setting('kr.i1'));
    assert a = '42501|Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.|', who || ': ' || a;
  end loop;
  a := pg_temp.kr_unpaid(null, current_setting('kr.i1'));
  assert a = '42501|Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.|', 'nobody: ' || a;
  assert not has_function_privilege('anon', 'public.credit_installment_mark_unpaid(uuid)', 'execute'), 'anon may un-pay';
  assert pg_temp.kr_inst(current_setting('kr.i1')) = before, 'a refused caller changed the instalment';

  -- Paid in full, by a bank line: back to unpaid, the bank line untouched.
  a := pg_temp.kr_unpaid('0d5c0000-0000-4000-8000-0000000000d4', current_setting('kr.i1'));
  assert a = '00000||{"sef_links": 1, "credit_reopened": false}', 'assistant #1: ' || a;
  assert pg_temp.kr_inst(current_setting('kr.i1')) = 'outstanding/0.00/null/null', '#1: ' || pg_temp.kr_inst(current_setting('kr.i1'));
  assert exists (select 1 from public.transactions where id = current_setting('kr.tx')::uuid and deleted_at is null), 'the bank line was touched';
  assert pg_temp.kr_row(current_setting('kr.p1')) like 'linked/' || current_setting('kr.i1') || '/%', 'the SEF link went';

  -- Partly paid.
  a := pg_temp.kr_unpaid('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.i2'));
  assert a = '00000||{"sef_links": 0, "credit_reopened": false}', 'admin #2: ' || a;
  assert pg_temp.kr_inst(current_setting('kr.i2')) = 'outstanding/0.00/null/null', '#2: ' || pg_temp.kr_inst(current_setting('kr.i2'));

  -- The last instalment of a closed credit: the credit opens again.
  a := pg_temp.kr_unpaid('0d5c0000-0000-4000-8000-0000000000d2', current_setting('kr.i9'));
  assert a = '00000||{"sef_links": 0, "credit_reopened": true}', 'owner #9: ' || a;
  assert (select status from public.credits where id = current_setting('kr.cr2')::uuid) = 'active', 'credit left closed';

  -- Nothing to return, and nothing there.
  a := pg_temp.kr_unpaid('0d5c0000-0000-4000-8000-0000000000d1', current_setting('kr.i3'));
  assert a = 'SEFLK|Rata nije ni delimično plaćena, pa nema šta da se vrati. Ništa nije promenjeno.|', '#3: ' || a;
  a := pg_temp.kr_unpaid('0d5c0000-0000-4000-8000-0000000000d1', gen_random_uuid()::text);
  assert a = 'P0002|Ta rata kredita ne postoji. Ništa nije promenjeno.|', 'missing: ' || a;

  -- Never a transaction, and audited with the caller.
  assert (select count(*) from public.transactions where company_id = current_setting('kr.co')::uuid and deleted_at is null) = 1, 'transactions moved';
  assert exists (select 1 from public.audit_log where table_name = 'credit_installments' and record_id = current_setting('kr.i1')::uuid
                    and user_id = '0d5c0000-0000-4000-8000-0000000000d4'), 'unpaid not audited with the caller';
  raise notice '5 ok';
end $$;

-- ══ 6. The instalment deleted under a link: the row goes back to the queue ══

do $$
declare a text;
begin
  a := pg_temp.kr_as('0d5c0000-0000-4000-8000-0000000000d1',
    format('delete from public.credit_installments where id = %L returning id::text', current_setting('kr.i1')));
  assert split_part(a, '|', 1) = '00000' and split_part(a, '|', 3) = current_setting('kr.i1'), 'delete #1: ' || a;
  assert pg_temp.kr_row(current_setting('kr.p1')) = 'pending/null/null/no-at', 'row left linked to nothing: ' || pg_temp.kr_row(current_setting('kr.p1'));
  assert (select restored_at is not null from public.sef_inbox where id = current_setting('kr.p1')::uuid), 'restored_at not set';
  -- A regenerated schedule says nothing about the bank: the PIB P1 taught
  -- the credit on relinking stays.
  assert (select lender_pib from public.credits where id = current_setting('kr.cr1')::uuid) = '900000017', 'PIB forgotten by a deleted instalment';
  raise notice '6 ok';
end $$;

do $$ begin raise notice 'ALL TESTS PASSED'; end $$;
