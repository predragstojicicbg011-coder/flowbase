-- Tests for 20261121090000_preliminary_payroll.sql (the template of preliminary
-- hours for the running month, payroll_runs.kind, and the locks that keep a
-- preliminary run out of the ledger).
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/preliminary_payroll_test.sql; rollback;
-- Safe on a live database: fixtures only (company "Test preliminarni obracun
-- (TEST-PO)", users 0e0f...c1..c5), always rolled back. Run as the database
-- owner. Ends with ALL TESTS PASSED.
--
-- Actors: c1 administrator, c2 owner, c3 administrative assistant, c4 manager,
-- c5 an account with no profile (not a member).

\set ON_ERROR_STOP on

do $$
declare v_co uuid;
begin
  insert into auth.users (id, email)
  select x.id::uuid, x.email
    from (values
      ('0e0f0000-0000-4000-8000-0000000000c1', 'po-test-c1@example.invalid'),
      ('0e0f0000-0000-4000-8000-0000000000c2', 'po-test-c2@example.invalid'),
      ('0e0f0000-0000-4000-8000-0000000000c3', 'po-test-c3@example.invalid'),
      ('0e0f0000-0000-4000-8000-0000000000c4', 'po-test-c4@example.invalid'),
      ('0e0f0000-0000-4000-8000-0000000000c5', 'po-test-c5@example.invalid')) as x(id, email);
  insert into public.profiles (id, full_name, email, role) values
    ('0e0f0000-0000-4000-8000-0000000000c1', 'Osoba A', 'po-test-c1@example.invalid', 'administrator'),
    ('0e0f0000-0000-4000-8000-0000000000c2', 'Osoba B', 'po-test-c2@example.invalid', 'owner'),
    ('0e0f0000-0000-4000-8000-0000000000c3', 'Osoba C', 'po-test-c3@example.invalid', 'administrative_assistant'),
    ('0e0f0000-0000-4000-8000-0000000000c4', 'Osoba D', 'po-test-c4@example.invalid', 'manager');
  insert into public.companies (name, country, currency)
  values ('Test preliminarni obracun (TEST-PO)', 'Srbija', 'RSD') returning id into v_co;
  perform set_config('po.co', v_co::text, true);
  perform set_config('po.month', public.payroll_belgrade_month()::text, true);
end $$;

-- ══ 1. The running month in Belgrade ════════════════════════════════════════

do $$
begin
  -- 23:30 UTC on 31 October is 00:30 on 1 November in Belgrade (CET, +1).
  assert public.payroll_belgrade_month('2026-10-31 23:30+00') = date '2026-11-01', 'Belgrade month at night';
  assert public.payroll_belgrade_month('2026-11-30 22:59+00') = date '2026-11-01', 'last minute of November';
  assert public.payroll_belgrade_month('2026-11-30 23:00+00') = date '2026-12-01', 'first minute of December';
  -- Summer time (+2): 22:30 UTC on 31 May is 00:30 on 1 June.
  assert public.payroll_belgrade_month('2026-05-31 22:30+00') = date '2026-06-01', 'summer time';
  raise notice '1 ok';
end $$;

-- ══ 2. An administrator saves the running month's template ══════════════════

set local request.jwt.claims to '{"sub":"0e0f0000-0000-4000-8000-0000000000c1","role":"authenticated"}';
set local role authenticated;
do $$
declare r record;
begin
  insert into public.payroll_preliminary_hours (month, regular_hours, holiday_hours, saved_by, saved_at)
  values (current_setting('po.month')::date, 160, 8, '0e0f0000-0000-4000-8000-0000000000c5', '2000-01-01');
  select * into r from public.payroll_preliminary_hours where month = current_setting('po.month')::date;
  assert r.regular_hours = 160 and r.holiday_hours = 8 and r.vacation_hours = 0, 'the hours as saved';
  assert r.saved_by = '0e0f0000-0000-4000-8000-0000000000c1', format('saved_by is the caller, not what was sent: %s', r.saved_by);
  assert r.saved_at > now() - interval '1 minute', 'saved_at is stamped, not what was sent';
  raise notice '2 ok';
end $$;

-- ══ 3. Only the running month: last month and next month are refused ═══════

do $$
begin
  begin
    insert into public.payroll_preliminary_hours (month, regular_hours)
    values ((current_setting('po.month')::date - interval '1 month')::date, 168);
    raise exception 'FAIL: last month''s template was accepted';
  exception when check_violation then
    assert sqlerrm = 'Pretpostavljeni sati se čuvaju samo za tekući mesec.', sqlerrm;
  end;
  begin
    insert into public.payroll_preliminary_hours (month, regular_hours)
    values ((current_setting('po.month')::date + interval '1 month')::date, 168);
    raise exception 'FAIL: next month''s template was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.payroll_preliminary_hours set month = (month - interval '1 month')::date
     where month = current_setting('po.month')::date;
    raise exception 'FAIL: the template was moved to last month';
  exception when check_violation then null;
  end;
  begin
    insert into public.payroll_preliminary_hours (month, regular_hours)
    values (current_setting('po.month')::date + 1, 168);
    raise exception 'FAIL: a month that is not a first was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.payroll_preliminary_hours set vacation_hours = -8 where month = current_setting('po.month')::date;
    raise exception 'FAIL: negative hours were accepted';
  exception when check_violation then null;
  end;
  raise notice '3 ok';
end $$;

-- ══ 4. The owner updates it, and is stamped ═════════════════════════════════

reset role;
set local request.jwt.claims to '{"sub":"0e0f0000-0000-4000-8000-0000000000c2","role":"authenticated"}';
set local role authenticated;
do $$
declare n int;
begin
  update public.payroll_preliminary_hours set regular_hours = 152, vacation_hours = 8
   where month = current_setting('po.month')::date;
  get diagnostics n = row_count;
  assert n = 1, 'the owner updates the template';
  assert (select saved_by from public.payroll_preliminary_hours where month = current_setting('po.month')::date)
         = '0e0f0000-0000-4000-8000-0000000000c2', 'the update is stamped with the owner';
  raise notice '4 ok';
end $$;

-- ══ 5. Nobody else reads or writes it ═══════════════════════════════════════

reset role;
do $$
declare
  v_who text;
  n int;
begin
  foreach v_who in array array['0e0f0000-0000-4000-8000-0000000000c3',
                               '0e0f0000-0000-4000-8000-0000000000c4',
                               '0e0f0000-0000-4000-8000-0000000000c5'] loop
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', v_who), true);
    execute 'set local role authenticated';
    select count(*) into n from public.payroll_preliminary_hours;
    assert n = 0, format('%s reads %s template rows', v_who, n);
    begin
      insert into public.payroll_preliminary_hours (month, regular_hours)
      values (current_setting('po.month')::date, 1);
      raise exception 'FAIL: % wrote a template', v_who;
    exception when insufficient_privilege or unique_violation then null;
    end;
    update public.payroll_preliminary_hours set regular_hours = 1;
    get diagnostics n = row_count;
    assert n = 0, format('%s updated %s rows', v_who, n);
    delete from public.payroll_preliminary_hours;
    get diagnostics n = row_count;
    assert n = 0, format('%s deleted %s rows', v_who, n);
    execute 'reset role';
  end loop;
  assert (select regular_hours from public.payroll_preliminary_hours where month = current_setting('po.month')::date) = 152,
    'the template is untouched';
  raise notice '5 ok';
end $$;

-- ══ 6. Last month's template is history: not rewritten, not removed ════════

reset role;
do $$
begin
  -- Written as it would have been last month (the trigger is what is under
  -- test, so it is off for this one insert; the transaction is rolled back).
  alter table public.payroll_preliminary_hours disable trigger payroll_preliminary_hours_running_month;
  insert into public.payroll_preliminary_hours (month, regular_hours)
  values ((current_setting('po.month')::date - interval '1 month')::date, 168);
  alter table public.payroll_preliminary_hours enable trigger payroll_preliminary_hours_running_month;
  begin
    update public.payroll_preliminary_hours set regular_hours = 160
     where month = (current_setting('po.month')::date - interval '1 month')::date;
    raise exception 'FAIL: last month''s template was rewritten';
  exception when check_violation then null;
  end;
  begin
    delete from public.payroll_preliminary_hours
     where month = (current_setting('po.month')::date - interval '1 month')::date;
    raise exception 'FAIL: last month''s template was removed';
  exception when check_violation then null;
  end;
  raise notice '6 ok';
end $$;

-- ══ 7. The administrator removes the running month's template ══════════════

set local request.jwt.claims to '{"sub":"0e0f0000-0000-4000-8000-0000000000c1","role":"authenticated"}';
set local role authenticated;
do $$
declare n int;
begin
  delete from public.payroll_preliminary_hours where month = current_setting('po.month')::date;
  get diagnostics n = row_count;
  assert n = 1, 'the administrator removes the template';
  raise notice '7 ok';
end $$;
reset role;

-- ══ 8. Every run is regular unless it says otherwise ════════════════════════

do $$
declare v_co uuid := current_setting('po.co')::uuid; v_run uuid;
begin
  insert into public.payroll_runs (company_id, period_month, run_key, label)
  values (v_co, date '2026-09-01', 'regular', 'Zarade') returning id into v_run;
  assert (select kind from public.payroll_runs where id = v_run) = 'regular', 'default kind';
  begin
    update public.payroll_runs set kind = 'probni' where id = v_run;
    raise exception 'FAIL: an unknown kind was accepted';
  exception when check_violation then null;
  end;
  raise notice '8 ok';
end $$;

-- ══ 9. A preliminary run is never posted ════════════════════════════════════

do $$
declare v_co uuid := current_setting('po.co')::uuid; v_run uuid;
begin
  insert into public.payroll_runs (company_id, period_month, run_key, label, kind)
  values (v_co, date '2026-10-01', 'regular', 'Zarade', 'preliminary') returning id into v_run;

  -- By run_id.
  begin
    insert into public.payroll_postings (company_id, period_month, run_key, total_cost, run_id)
    values (v_co, date '2026-10-01', 'regular', 1000, v_run);
    raise exception 'FAIL: a posting of a preliminary run (by id) was accepted';
  exception when check_violation then
    assert sqlerrm = 'Preliminarni obračun ne može da se proknjiži.', sqlerrm;
  end;
  -- By (company, month, run), with no run_id.
  begin
    insert into public.payroll_postings (company_id, period_month, run_key, total_cost)
    values (v_co, date '2026-10-01', 'regular', 1000);
    raise exception 'FAIL: a posting of a preliminary run (by company, month and run) was accepted';
  exception when check_violation then null;
  end;
  -- A run set to posted while preliminary.
  begin
    update public.payroll_runs set status = 'posted', posted_at = now() where id = v_run;
    raise exception 'FAIL: a preliminary run was set to posted';
  exception when check_violation then null;
  end;
  begin
    insert into public.payroll_runs (company_id, period_month, run_key, label, kind, status, posted_at)
    values (v_co, date '2026-10-01', 'other', 'Ostala primanja', 'preliminary', 'posted', now());
    raise exception 'FAIL: a preliminary run was inserted as posted';
  exception when check_violation then null;
  end;
  -- An existing posting moved onto a preliminary run.
  insert into public.payroll_runs (company_id, period_month, run_key, label)
  values (v_co, date '2026-08-01', 'regular', 'Zarade');
  insert into public.payroll_postings (company_id, period_month, run_key, total_cost)
  values (v_co, date '2026-08-01', 'regular', 1000);
  begin
    update public.payroll_postings set period_month = date '2026-10-01'
     where company_id = v_co and period_month = date '2026-08-01';
    raise exception 'FAIL: a posting was moved onto a preliminary run';
  exception when check_violation then null;
  end;

  -- Recalculated as regular, it posts.
  update public.payroll_runs set kind = 'regular' where id = v_run;
  insert into public.payroll_postings (company_id, period_month, run_key, total_cost, run_id)
  values (v_co, date '2026-10-01', 'regular', 1000, v_run);
  update public.payroll_runs set status = 'posted', posted_at = now() where id = v_run;
  perform set_config('po.run', v_run::text, true);
  raise notice '9 ok';
end $$;

-- ══ 10. A posted run's kind is frozen, and the run is not deleted ═══════════

do $$
declare v_co uuid := current_setting('po.co')::uuid; v_run uuid := current_setting('po.run')::uuid; v_run2 uuid;
begin
  begin
    update public.payroll_runs set kind = 'preliminary' where id = v_run;
    raise exception 'FAIL: a posted run turned preliminary';
  exception when check_violation then null;
  end;
  begin
    delete from public.payroll_runs where id = v_run;
    raise exception 'FAIL: a run with a posting (by id) was deleted';
  exception when check_violation then
    assert sqlerrm like 'Ovaj obračun ima knjiženje u glavnoj knjizi%', sqlerrm;
  end;

  -- Between a posting's claim and its run's freeze the run is a draft, and the
  -- posting row may carry no run_id: still frozen and still not deleted.
  insert into public.payroll_runs (company_id, period_month, run_key, label)
  values (v_co, date '2026-10-01', 'other', 'Ostala primanja') returning id into v_run2;
  insert into public.payroll_postings (company_id, period_month, run_key, total_cost)
  values (v_co, date '2026-10-01', 'other', 500);
  begin
    update public.payroll_runs set kind = 'preliminary' where id = v_run2;
    raise exception 'FAIL: a claimed draft turned preliminary';
  exception when check_violation then null;
  end;
  begin
    delete from public.payroll_runs where id = v_run2;
    raise exception 'FAIL: a run with a posting (by company, month and run) was deleted';
  exception when check_violation then null;
  end;
  raise notice '10 ok';
end $$;

-- ══ 11. Undo, as undoPosting does it: posting row first, then the run ═══════

do $$
declare v_co uuid := current_setting('po.co')::uuid; v_run uuid := current_setting('po.run')::uuid; n int;
begin
  delete from public.payroll_postings where run_id = v_run;
  update public.payroll_runs set status = 'draft', posted_at = null where id = v_run;
  -- A draft with no posting may turn preliminary again and may be removed.
  update public.payroll_runs set kind = 'preliminary' where id = v_run;
  delete from public.payroll_runs where id = v_run;
  get diagnostics n = row_count;
  assert n = 1, 'a draft with no posting is removed';
  raise notice '11 ok';
end $$;

-- ══ 12. Who reads and writes payroll_runs did not change ════════════════════

set local request.jwt.claims to '{"sub":"0e0f0000-0000-4000-8000-0000000000c3","role":"authenticated"}';
set local role authenticated;
do $$
begin
  assert (select count(*) from public.payroll_runs) = 0, 'the assistant still reads no kept run';
  raise notice '12 ok';
end $$;
reset role;

do $$ begin raise notice 'ALL TESTS PASSED'; end $$;
