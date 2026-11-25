-- Tests for 20261125090000_a_statement_delete_gets_past_the_rows_it_hides.sql.
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front:
--   sqltest supabase/migrations/20261125090000_a_statement_delete_gets_past_the_rows_it_hides.sql
--           supabase/tests/delete_statement_cascade_test.sql
-- Fixtures only (company "Test brisanje izvoda (TEST-DS)", users 0d5c...c1-c4,
-- hashes 'TEST-DS-…'), always rolled back. Run as the database owner. Ends
-- with ALL TESTS PASSED.
--
-- Actors: c1 administrator, c2 owner, c3 manager, c4 administrative assistant,
-- c5 a signed-in account with no profile (as MCFlow's MCOdobri users are).
--
-- Batches (all invented):
--   S1  2026-10, open: a credit payment (bank line + principal + interest
--       legs, instalment pointing at the bank line), an invoice payment that
--       closes INV-DS-OKT, a pass-through, the statement record.
--   S2  2026-10, open, paying INV-DS-SEP dated 2026-09-10; September closed.
--   S3  straddles: one row in closed September, one in October.
--   S4  2026-10, open, one line: deleted in the same transaction as S1.
--   S5  2026-10, open, paying INV-DS-SEPDEL dated 2026-09-12 and since
--       soft-deleted (step 4 restates it all the same).
--   T9  a bank line outside any statement that paid the last instalment of a
--       credit, which closed it.

\set ON_ERROR_STOP on

do $$
declare
  v_co uuid; v_bank uuid; v_cr uuid;
  v_inv_okt uuid; v_inv_sep uuid;
  v_t1 uuid; v_t4 uuid; v_t5 uuid; v_t6 uuid; v_t7 uuid; v_t8 uuid; v_t9 uuid;
  v_cr2 uuid; v_inv_del uuid;
  s1 uuid := '0d5c0000-0000-4000-8000-0000000005a1';
  s2 uuid := '0d5c0000-0000-4000-8000-0000000005a2';
  s3 uuid := '0d5c0000-0000-4000-8000-0000000005a3';
  s4 uuid := '0d5c0000-0000-4000-8000-0000000005a4';
  s5 uuid := '0d5c0000-0000-4000-8000-0000000005a5';
begin
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x.id::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', x.email, now(), now()
    from (values
      ('0d5c0000-0000-4000-8000-0000000000c1', 'ds-test-c1@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000c2', 'ds-test-c2@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000c3', 'ds-test-c3@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000c4', 'ds-test-c4@example.invalid'),
      ('0d5c0000-0000-4000-8000-0000000000c5', 'ds-test-c5@example.invalid')) as x(id, email);
  insert into public.profiles (id, full_name, email, role) values
    ('0d5c0000-0000-4000-8000-0000000000c1', 'Test Administrator', 'ds-test-c1@example.invalid', 'administrator'),
    ('0d5c0000-0000-4000-8000-0000000000c2', 'Test Vlasnik',       'ds-test-c2@example.invalid', 'owner'),
    ('0d5c0000-0000-4000-8000-0000000000c3', 'Test Menadžer',      'ds-test-c3@example.invalid', 'manager'),
    ('0d5c0000-0000-4000-8000-0000000000c4', 'Test Asistent',      'ds-test-c4@example.invalid', 'administrative_assistant');

  insert into public.companies (name, country, currency)
  values ('Test brisanje izvoda (TEST-DS)', 'Srbija', 'RSD') returning id into v_co;
  insert into public.banks (company_id, name, currencies)
  values (v_co, 'Test banka (TEST-DS)', array['RSD']) returning id into v_bank;

  -- The period lock is on (the trigger reads it the same way), September closed.
  insert into public.feature_flags (name, enabled) values ('period_lock', true)
    on conflict (name) do update set enabled = true;
  insert into public.closed_periods (company_id, period) values (v_co, '2026-09-01');

  insert into public.credits (company_id, name, bank, principal_amount, currency)
  values (v_co, 'Test kredit (TEST-DS)', 'Test banka', 120000, 'RSD') returning id into v_cr;
  update public.credits set status = 'closed' where id = v_cr;
  insert into public.credits (company_id, name, bank, principal_amount, currency, status)
  values (v_co, 'Test kredit 2 (TEST-DS)', 'Test banka', 5000, 'RSD', 'closed') returning id into v_cr2;

  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, status)
  values (v_co, 'INV-DS-OKT', '2026-10-05', 'expense', 'RSD', 1000, 1000, 1, 'paid') returning id into v_inv_okt;
  -- Inserted before September is closed would be the real order; the lock is
  -- lifted for the insert and put back.
  delete from public.closed_periods where company_id = v_co;
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, status)
  values (v_co, 'INV-DS-SEP', '2026-09-10', 'expense', 'RSD', 500, 500, 1, 'paid') returning id into v_inv_sep;
  insert into public.transactions (company_id, bank_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-09-28', 'direct', 'RSD', 70, 70, true, 'posted', s3, 'TEST-DS-h31', 'S3 SEPTEMBER LINE') returning id into v_t6;
  -- S5: a September invoice, paid in October, later soft-deleted.
  insert into public.invoices (company_id, invoice_number, invoice_date, type, currency, amount, amount_rsd, exchange_rate, status)
  values (v_co, 'INV-DS-SEPDEL', '2026-09-12', 'expense', 'RSD', 60, 60, 1, 'paid') returning id into v_inv_del;
  insert into public.transactions (company_id, bank_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-10-03', 'invoice_payment', 'RSD', 60, 60, false, 'posted', s5, 'TEST-DS-h51', 'S5 PAYMENT') returning id into v_t8;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_inv_del, v_t8, 60, 60);
  update public.invoices set deleted_at = now() where id = v_inv_del;
  insert into public.closed_periods (company_id, period) values (v_co, '2026-09-01');

  -- S1: a credit payment, three rows, the instalment on the bank line.
  insert into public.transactions (company_id, bank_id, transaction_date, type, tx_subtype, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-10-13', 'credit_payment', 'expense', 'RSD', 1200, 1200, false, 'posted', s1, 'TEST-DS-h11', 'S1 BANK LINE') returning id into v_t1;
  insert into public.transactions (company_id, bank_id, transaction_date, type, tx_subtype, currency, amount, amount_rsd, pl_impact, status, import_batch_id, note)
  values (v_co, v_bank, '2026-10-13', 'credit_payment', 'expense', 'RSD', 1000, 1000, true, 'posted', s1, 'S1 PRINCIPAL LEG'),
         (v_co, v_bank, '2026-10-13', 'credit_payment', 'expense', 'RSD', 200, 200, true, 'posted', s1, 'S1 INTEREST LEG');
  insert into public.credit_installments (credit_id, installment_no, due_date, principal_amount, interest_amount, total_amount,
                                          status, transaction_id, paid_date, paid_amount)
  values (v_cr, 1, '2026-10-15', 1000, 200, 1200, 'paid', v_t1, '2026-10-13', 1200);
  -- S1: an invoice payment that closes INV-DS-OKT.
  insert into public.transactions (company_id, bank_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-10-14', 'invoice_payment', 'RSD', 1000, 1000, false, 'posted', s1, 'TEST-DS-h12', 'S1 INVOICE PAYMENT') returning id into v_t4;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_inv_okt, v_t4, 1000, 1000);
  -- S1: a pass-through and the statement record.
  insert into public.passthrough (company_id, bank_id, transaction_date, direction, period_month, currency, amount, status, import_batch_id, import_hash)
  values (v_co, v_bank, '2026-10-14', 'in', '2026-10', 'RSD', 300, 'unpaired', s1, 'TEST-DS-h13');
  insert into public.import_logs (company_id, bank_id, import_type, file_name, row_count, filing_ref)
  values (v_co, v_bank, 'manual_statement', 'test-izvod-s1.txt', 5, s1::text);

  -- S2: an October payment of the September invoice.
  insert into public.transactions (company_id, bank_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-10-02', 'invoice_payment', 'RSD', 500, 500, false, 'posted', s2, 'TEST-DS-h21', 'S2 PAYMENT') returning id into v_t5;
  insert into public.invoice_transaction_links (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd)
  values (v_inv_sep, v_t5, 500, 500);
  insert into public.import_logs (company_id, bank_id, import_type, file_name, row_count, filing_ref)
  values (v_co, v_bank, 'manual_statement', 'test-izvod-s2.txt', 1, s2::text);

  -- S3: its October row (the September one is above).
  insert into public.transactions (company_id, bank_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-10-01', 'direct', 'RSD', 80, 80, true, 'posted', s3, 'TEST-DS-h32', 'S3 OCTOBER LINE');

  -- S4: one line.
  insert into public.transactions (company_id, bank_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_batch_id, import_hash, note)
  values (v_co, v_bank, '2026-10-20', 'direct', 'RSD', 40, 40, true, 'posted', s4, 'TEST-DS-h41', 'S4 LINE') returning id into v_t7;

  -- T9: the last instalment of credit 2, paid by a line outside any statement.
  insert into public.transactions (company_id, bank_id, transaction_date, type, tx_subtype, currency, amount, amount_rsd, pl_impact, status, note)
  values (v_co, v_bank, '2026-10-22', 'credit_payment', 'expense', 'RSD', 500, 500, false, 'posted', 'T9 BANK LINE') returning id into v_t9;
  insert into public.credit_installments (credit_id, installment_no, due_date, principal_amount, interest_amount, total_amount,
                                          status, transaction_id, paid_date, paid_amount)
  values (v_cr2, 10, '2026-10-25', 450, 50, 500, 'paid', v_t9, '2026-10-22', 500);

  perform set_config('ds.co', v_co::text, true);
  perform set_config('ds.t1', v_t1::text, true);
  perform set_config('ds.t5', v_t5::text, true);
  perform set_config('ds.t6', v_t6::text, true);
  perform set_config('ds.t7', v_t7::text, true);
  perform set_config('ds.t8', v_t8::text, true);
  perform set_config('ds.t9', v_t9::text, true);
  perform set_config('ds.cr', v_cr::text, true);
  perform set_config('ds.cr2', v_cr2::text, true);
  perform set_config('ds.s5', s5::text, true);
  perform set_config('ds.okt', v_inv_okt::text, true);
  perform set_config('ds.sep', v_inv_sep::text, true);
  perform set_config('ds.s1', s1::text, true);
  perform set_config('ds.s2', s2::text, true);
  perform set_config('ds.s3', s3::text, true);
  perform set_config('ds.s4', s4::text, true);
end $$;

-- A call as one of the actors, answered as "sqlstate|message|result".
create function pg_temp.ds_call(p_user text, p_batch text) returns text
language plpgsql as $$
declare
  back text := current_user;
  r jsonb; v_state text; v_msg text;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
  execute 'set local role authenticated';
  begin
    r := public.delete_statement_cascade(p_batch, null);
    v_state := '00000';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  execute format('set local role %I', back);
  perform set_config('request.jwt.claims', '', true);
  return v_state || '|' || coalesce(v_msg, '') || '|' || coalesce(r::text, '');
end $$;

-- What the database holds for this fixture, as the owner sees it.
create function pg_temp.ds_state() returns text
language sql as $$
  select concat_ws(' ',
    'live_tx=' || (select count(*) from public.transactions where company_id = current_setting('ds.co')::uuid and deleted_at is null),
    'live_pt=' || (select count(*) from public.passthrough where company_id = current_setting('ds.co')::uuid and deleted_at is null),
    'links=' || (select count(*) from public.invoice_transaction_links l join public.invoices i on i.id = l.invoice_id
                  where i.company_id = current_setting('ds.co')::uuid),
    'paid_inst=' || (select count(*) from public.credit_installments ci join public.credits c on c.id = ci.credit_id
                      where c.company_id = current_setting('ds.co')::uuid and ci.status = 'paid'),
    'logs=' || (select count(*) from public.import_logs where company_id = current_setting('ds.co')::uuid),
    'okt=' || (select status from public.invoices where id = current_setting('ds.okt')::uuid),
    'sep=' || (select status from public.invoices where id = current_setting('ds.sep')::uuid))
$$;

-- ══ 1. Who may not ══════════════════════════════════════════════════════════

do $$
declare before text := pg_temp.ds_state(); a text; who text;
begin
  foreach who in array array['0d5c0000-0000-4000-8000-0000000000c3',  -- manager
                             '0d5c0000-0000-4000-8000-0000000000c4',  -- assistant
                             '0d5c0000-0000-4000-8000-0000000000c5']  -- no profile
  loop
    a := pg_temp.ds_call(who, current_setting('ds.s1'));
    assert a = '42501|Samo administrator ili vlasnik može da obriše izvod.|', who || ': ' || a;
  end loop;
  a := pg_temp.ds_call(null, current_setting('ds.s1'));
  assert a = '42501|Samo administrator ili vlasnik može da obriše izvod.|', 'nobody: ' || a;
  assert not has_function_privilege('anon', 'public.delete_statement_cascade(text, uuid)', 'execute'), 'anon may call it';
  assert pg_temp.ds_state() = before, 'a refused caller changed something: ' || pg_temp.ds_state();
  raise notice '1 ok';
end $$;

-- ══ 2. The administrator deletes S1, and everything it made goes ════════════

do $$
declare a text; r jsonb;
begin
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c1', current_setting('ds.s1'));
  assert split_part(a, '|', 1) = '00000', 'S1: ' || a;
  r := split_part(a, '|', 3)::jsonb;
  assert r = '{"transactions_deleted":4,"passthroughs_deleted":1,"allocations_removed":1,"installments_reopened":1,"credits_reopened":1,"invoices_restated":1,"statement_records_removed":1}'::jsonb,
    'S1 result: ' || r::text;

  assert (select count(*) from public.transactions where import_batch_id = current_setting('ds.s1')::uuid and deleted_at is null) = 0, 'S1 rows still live';
  assert (select count(*) from public.transactions where import_batch_id = current_setting('ds.s1')::uuid and import_hash is not null) = 0, 'S1 hashes kept';
  assert (select count(*) from public.passthrough where import_batch_id = current_setting('ds.s1')::uuid and (deleted_at is null or import_hash is not null)) = 0, 'S1 pass-through kept or hashed';
  assert (select status || '/' || paid_amount || '/' || coalesce(transaction_id::text, 'null') || '/' || coalesce(paid_date::text, 'null')
            from public.credit_installments where installment_no = 1
             and credit_id in (select id from public.credits where company_id = current_setting('ds.co')::uuid)) = 'outstanding/0.00/null/null',
    'instalment not reopened';
  assert (select status from public.invoices where id = current_setting('ds.okt')::uuid) = 'unpaid', 'INV-DS-OKT not restated';
  assert not exists (select 1 from public.import_logs where filing_ref = current_setting('ds.s1')), 'statement record kept';
  -- The credit its last payment had closed is open again.
  assert (select status from public.credits where id = current_setting('ds.cr')::uuid) = 'active', 'credit left closed';
  -- deleted_by is the caller, though the call passed null.
  assert (select count(*) from public.transactions where import_batch_id = current_setting('ds.s1')::uuid
           and deleted_by is distinct from '0d5c0000-0000-4000-8000-0000000000c1') = 0, 'deleted_by is not the caller';
  -- The audit rows carry the caller (the FK to auth.users holds).
  assert exists (select 1 from public.audit_log where table_name = 'transactions' and record_id = current_setting('ds.t1')::uuid
                    and user_id = '0d5c0000-0000-4000-8000-0000000000c1'), 'audit row without the caller';
  raise notice '2 ok';
end $$;

-- ══ 3. The same file imports again ══════════════════════════════════════════

do $$
begin
  insert into public.transactions (company_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_hash)
  select current_setting('ds.co')::uuid, '2026-10-13', 'direct', 'RSD', 1, 1, false, 'posted', h
    from unnest(array['TEST-DS-h11', 'TEST-DS-h12']) h;
  insert into public.passthrough (company_id, transaction_date, direction, period_month, currency, amount, status, import_hash)
  values (current_setting('ds.co')::uuid, '2026-10-14', 'in', '2026-10', 'RSD', 300, 'unpaired', 'TEST-DS-h13');
  -- A LIVE hash still refuses its duplicate.
  begin
    insert into public.transactions (company_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_hash)
    values (current_setting('ds.co')::uuid, '2026-10-13', 'direct', 'RSD', 1, 1, false, 'posted', 'TEST-DS-h11');
    raise exception 'FAIL: a live hash took a duplicate';
  exception when unique_violation then null;
  end;
  raise notice '3 ok';
end $$;

-- ══ 4. Again, and a second statement in the same transaction ════════════════

do $$
declare a text;
begin
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c2', current_setting('ds.s1'));
  assert a like 'P0002|Izvod % nema nijednu stavku%', 'S1 again: ' || a;
  -- The temporary table of the first call is still there in this transaction.
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c2', current_setting('ds.s4'));
  assert split_part(a, '|', 1) = '00000' and (split_part(a, '|', 3)::jsonb ->> 'transactions_deleted')::int = 1, 'S4: ' || a;
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c1', 'nije-uuid');
  assert a like 'P0002|Izvod nije-uuid nema nijednu stavku%', 'not a uuid: ' || a;
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c1', '  ');
  assert a = '22023|Nije naveden nijedan izvod.|', 'blank: ' || a;
  raise notice '4 ok';
end $$;

-- ══ 5. An October statement that paid a September invoice ═══════════════════

do $$
declare before text := pg_temp.ds_state(); a text;
begin
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c2', current_setting('ds.s2'));
  assert a = '23514|Ništa nije obrisano: ovaj izvod je platio fakturu(e) INV-DS-SEP datiranu(e) u zaključanom periodu 2026-09, '
          || 'pa bi njegovo brisanje promenilo dug po njima u zaključanom mesecu — otključajte 2026-09 u Podešavanjima → '
          || 'Zaključani periodi, pa ponovo obrišite izvod.|', 'S2: ' || a;
  assert pg_temp.ds_state() = before, 'S2 changed something: ' || pg_temp.ds_state();
  assert (select deleted_at is null and import_hash = 'TEST-DS-h21' from public.transactions where id = current_setting('ds.t5')::uuid), 'S2 line touched';

  -- Unlocked, the same statement goes.
  delete from public.closed_periods where company_id = current_setting('ds.co')::uuid;
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c2', current_setting('ds.s2'));
  assert split_part(a, '|', 1) = '00000', 'S2 unlocked: ' || a;
  assert (select status from public.invoices where id = current_setting('ds.sep')::uuid) = 'unpaid', 'INV-DS-SEP not restated';
  insert into public.closed_periods (company_id, period) values (current_setting('ds.co')::uuid, '2026-09-01');
  raise notice '5 ok';
end $$;

-- ══ 6. A statement with a row in the closed month itself ════════════════════

do $$
declare before text := pg_temp.ds_state(); a text;
begin
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c1', current_setting('ds.s3'));
  -- Refused before any write, in Serbian: the trigger's English never shows.
  assert a = '23514|Ništa nije obrisano: izvod ima stavke u zaključanom periodu 2026-09 — otključajte 2026-09 '
          || 'u Podešavanjima → Zaključani periodi, pa ponovo obrišite izvod.|', 'S3: ' || a;
  assert pg_temp.ds_state() = before, 'S3 changed something: ' || pg_temp.ds_state();
  assert (select count(*) from public.transactions where import_batch_id = current_setting('ds.s3')::uuid and deleted_at is null and import_hash is not null) = 2,
    'S3 rows touched';
  raise notice '6 ok';
end $$;

-- ══ 7. One line deleted alone keeps its fingerprint ═════════════════════════

do $$
declare back text := current_user; v_id uuid; r jsonb;
begin
  -- A fresh line with a hash, deleted alone through delete_transaction_cascade
  -- (left as it is by this migration).
  insert into public.transactions (company_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_hash, note)
  values (current_setting('ds.co')::uuid, '2026-10-21', 'direct', 'RSD', 9, 9, true, 'posted', 'TEST-DS-h71', 'ONE LINE')
  returning id into v_id;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '0d5c0000-0000-4000-8000-0000000000c1', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.delete_transaction_cascade(v_id, '0d5c0000-0000-4000-8000-0000000000c1');
  execute format('set local role %I', back);
  perform set_config('request.jwt.claims', '', true);
  assert (select deleted_at is not null and import_hash = 'TEST-DS-h71' from public.transactions where id = v_id), 'single delete lost its hash';
  begin
    insert into public.transactions (company_id, transaction_date, type, currency, amount, amount_rsd, pl_impact, status, import_hash)
    values (current_setting('ds.co')::uuid, '2026-10-21', 'direct', 'RSD', 9, 9, true, 'posted', 'TEST-DS-h71');
    raise exception 'FAIL: a line deleted on purpose came back with its file';
  exception when unique_violation then null;
  end;
  raise notice '7 ok';
end $$;

-- ══ 8. A deleted invoice in a closed month is asked about too ═══════════════

do $$
declare before text := pg_temp.ds_state(); a text;
begin
  a := pg_temp.ds_call('0d5c0000-0000-4000-8000-0000000000c1', current_setting('ds.s5'));
  assert a like '23514|Ništa nije obrisano: ovaj izvod je platio fakturu(e) INV-DS-SEPDEL datiranu(e) u zaključanom periodu 2026-09,%', 'S5: ' || a;
  assert pg_temp.ds_state() = before, 'S5 changed something: ' || pg_temp.ds_state();
  assert (select deleted_at is null from public.transactions where id = current_setting('ds.t8')::uuid), 'S5 line touched';
  raise notice '8 ok';
end $$;

-- ══ 9. The single delete of a line that paid a credit's last instalment ═════

do $$
declare back text := current_user; r jsonb;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', '0d5c0000-0000-4000-8000-0000000000c2', 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  -- The parameter names somebody else; deleted_by is the caller all the same.
  r := public.delete_transaction_cascade(current_setting('ds.t9')::uuid, '0d5c0000-0000-4000-8000-0000000000c1');
  execute format('set local role %I', back);
  perform set_config('request.jwt.claims', '', true);
  assert r = '{"invoice_links_removed":0,"installments_unlinked":1,"credits_reopened":1}'::jsonb, 'T9: ' || r::text;
  assert (select status from public.credits where id = current_setting('ds.cr2')::uuid) = 'active', 'credit 2 left closed';
  assert (select status || '/' || coalesce(transaction_id::text, 'null') from public.credit_installments
           where credit_id = current_setting('ds.cr2')::uuid) = 'outstanding/null', 'instalment of credit 2 not reopened';
  assert (select deleted_by from public.transactions where id = current_setting('ds.t9')::uuid)
         = '0d5c0000-0000-4000-8000-0000000000c2', 'T9 deleted_by is not the caller';
  raise notice '9 ok';
end $$;

reset role;
select 'ALL TESTS PASSED' as result;
