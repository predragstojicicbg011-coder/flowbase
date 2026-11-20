-- Tests for 20261120090000_public_holidays_2026_2027.sql (the public holidays
-- of 2026 and 2027, and the hour fund they give a month).
--
-- Run in ONE transaction that is rolled back, with the migration (begin/commit
-- stripped) in front when the database lacks it:
--   begin; \i <migration>; \i supabase/tests/public_holidays_test.sql; rollback;
-- Safe on a live database: it only reads, and its one fixture row is rolled
-- back. Run as the database owner. Ends with ALL TESTS PASSED.

\set ON_ERROR_STOP on

do $$
declare
  v_days    date[];
  v_weekday date[];
  v_fund    int;
  v_hol     int;
  r         record;
begin
  -- 1. Every listed day is there (a database may hold more, entered by hand).
  select array_agg(d order by d) into v_days
    from unnest(array[
      date '2026-01-01', date '2026-01-02', date '2026-01-07',
      date '2026-02-15', date '2026-02-16', date '2026-02-17',
      date '2026-04-10', date '2026-04-11', date '2026-04-12', date '2026-04-13',
      date '2026-05-01', date '2026-05-02', date '2026-11-11',
      date '2027-01-01', date '2027-01-02', date '2027-01-07',
      date '2027-02-15', date '2027-02-16',
      date '2027-04-30', date '2027-05-01', date '2027-05-02', date '2027-05-03', date '2027-05-04',
      date '2027-11-11']) d
   where not exists (select 1 from public.public_holidays h where h.holiday_on = d);
  assert v_days is null, format('missing holidays: %s', v_days);
  raise notice '1 ok';

  -- 2. The days that cost hours: the listed holidays falling Monday to Friday.
  select array_agg(h.holiday_on order by h.holiday_on) into v_weekday
    from public.public_holidays h
   where h.holiday_on >= date '2026-01-01' and h.holiday_on < date '2028-01-01'
     and extract(isodow from h.holiday_on) < 6
     and h.holiday_on = any (array[
       date '2026-01-01', date '2026-01-02', date '2026-01-07', date '2026-02-16', date '2026-02-17',
       date '2026-04-10', date '2026-04-13', date '2026-05-01', date '2026-11-11',
       date '2027-01-01', date '2027-01-07', date '2027-02-15', date '2027-02-16',
       date '2027-04-30', date '2027-05-03', date '2027-05-04', date '2027-11-11']);
  assert array_length(v_weekday, 1) = 17, format('weekday holidays: %s', v_weekday);
  assert extract(isodow from date '2026-02-15') = 7 and extract(isodow from date '2027-05-02') = 7,
    'the two Sundays that carry a day over are not Sundays';
  assert extract(isodow from date '2026-05-02') = 6 and extract(isodow from date '2027-01-02') = 6,
    'the Saturdays that carry nothing over are not Saturdays';
  raise notice '2 ok';

  -- 3. The day carried over from Sunday 2 May 2027 is named so the app reads it
  --    as "Praznik rada (drugi dan, prenet neradni dan)".
  select * into r from public.public_holidays where holiday_on = date '2027-05-04';
  assert r.kind = 'substitute', format('4 May 2027 kind %s', r.kind);
  assert r.name = 'Празник рада, други дан, замена', format('4 May 2027 name %s', r.name);
  assert extract(isodow from r.holiday_on) = 2, '4 May 2027 is not a Tuesday';
  assert (select kind from public.public_holidays where holiday_on = date '2026-02-17') = 'substitute',
    '17 February 2026 is not the substitute';
  raise notice '3 ok';

  -- 4. November 2026: 21 weekdays (168 hours), of which the 11th is a holiday (8 hours).
  select count(*) * 8 into v_fund
    from generate_series(date '2026-11-01', date '2026-11-30', interval '1 day') d
   where extract(isodow from d) < 6;
  select count(*) * 8 into v_hol
    from public.public_holidays h
   where h.holiday_on >= date '2026-11-01' and h.holiday_on < date '2026-12-01'
     and extract(isodow from h.holiday_on) < 6;
  assert v_fund = 168 and v_hol = 8, format('November 2026 fund %s, holiday hours %s', v_fund, v_hol);
  raise notice '4 ok';

  -- 5. One row per day: a second row for a listed day is refused.
  begin
    insert into public.public_holidays (holiday_on, name, kind) values (date '2026-11-11', 'Двапут', 'state');
    raise exception 'FAIL: a day was entered twice';
  exception when unique_violation then null;
  end;
  raise notice '5 ok';

  raise notice 'ALL TESTS PASSED';
end $$;
