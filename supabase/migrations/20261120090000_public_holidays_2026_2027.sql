-- ============================================================================
-- Public holidays of 2026 and 2027
--
-- The table `public_holidays` has been in the schema since the baseline, but
-- no migration, seed or screen ever wrote a row into it. Every month therefore
-- derived its hour fund with no holiday in it: November 2026 read 168 working
-- hours and no holiday hours, although the 11th is Armistice Day.
--
-- The days are the ones the law makes non-working for everyone, plus the
-- Orthodox holidays, with two rules:
--
--   A STATE HOLIDAY ON A SUNDAY gives the next working day off, and never a
--   religious one. In 2026 Statehood Day (15 February) is a Sunday, so the
--   17th is off as well. In 2027 the second day of Labour Day (2 May) is a
--   Sunday and 3 May is already Easter Monday, so the day carried over is
--   Tuesday 4 May.
--
--   ONLY DAYS NOBODY WORKS. Holidays non-working for one faith only (Catholic
--   Easter and Christmas, Ramazanski and Kurbanski Bajram, Yom Kippur) are a
--   fact about a person, not about a month; they go on that person's
--   timesheet. Sveti Sava, Victory Day and Vidovdan are working days.
--
-- THREE DAYS OF 2027 CARRY TWO HOLIDAYS. Orthodox Easter is 2 May 2027, so
-- Holy Saturday is Labour Day and Easter Sunday is Labour Day's second day.
-- The table holds one row per day (two rows would take eight hours twice), so
-- each of those days has one row whose name says both.
--
-- The names are stored in Cyrillic, as the app's `holidayName` expects: the
-- part before the first comma is the holiday, each part after it a suffix
-- ("други дан", "замена") that the app translates.
--
-- This file only adds rows; it changes no table, policy or function. A row
-- somebody already entered by hand for one of these days is kept as it is
-- (`on conflict do nothing`). The check below REQUIRES every listed day to be
-- present, and only NOTICES rows the list does not have, so a database whose
-- holidays were filled in by hand is never blocked by it.
-- ============================================================================

begin;

do $$
begin
  if to_regclass('public.public_holidays') is null then
    raise exception 'public.public_holidays is not there; the baseline has not been applied -- rolling back';
  end if;
end $$;

insert into public.public_holidays (holiday_on, name, kind, note) values
  -- 2026
  ('2026-01-01', 'Нова година',                          'state',      null),
  ('2026-01-02', 'Нова година, други дан',               'state',      null),
  ('2026-01-07', 'Божић',                                'orthodox',   null),
  ('2026-02-15', 'Дан државности',                       'state',      'Пада у недељу'),
  ('2026-02-16', 'Дан државности, други дан',            'state',      null),
  ('2026-02-17', 'Дан државности, замена',               'substitute', 'Јер је 15. пао у недељу'),
  ('2026-04-10', 'Велики петак',                         'orthodox',   null),
  ('2026-04-11', 'Велика субота',                        'orthodox',   null),
  ('2026-04-12', 'Васкрс',                               'orthodox',   null),
  ('2026-04-13', 'Васкршњи понедељак',                   'orthodox',   null),
  ('2026-05-01', 'Празник рада',                         'state',      null),
  ('2026-05-02', 'Празник рада, други дан',              'state',      'Пада у суботу — нема замене'),
  ('2026-11-11', 'Дан примирја у Првом светском рату',   'state',      null),
  -- 2027
  ('2027-01-01', 'Нова година',                          'state',      null),
  ('2027-01-02', 'Нова година, други дан',               'state',      'Пада у суботу — нема замене'),
  ('2027-01-07', 'Божић',                                'orthodox',   null),
  ('2027-02-15', 'Дан државности',                       'state',      null),
  ('2027-02-16', 'Дан државности, други дан',            'state',      null),
  ('2027-04-30', 'Велики петак',                         'orthodox',   null),
  ('2027-05-01', 'Празник рада; Велика субота',          'state',      'Пада у суботу — нема замене'),
  ('2027-05-02', 'Васкрс; Празник рада, други дан',      'state',      'Пада у недељу'),
  ('2027-05-03', 'Васкршњи понедељак',                   'orthodox',   null),
  ('2027-05-04', 'Празник рада, други дан, замена',      'substitute', 'Јер је 2. мај пао у недељу, а 3. мај је Васкршњи понедељак'),
  ('2027-11-11', 'Дан примирја у Првом светском рату',   'state',      null)
on conflict (holiday_on) do nothing;

-- ── Check ───────────────────────────────────────────────────────────────────

do $$
declare
  v_expected date[] := array[
    date '2026-01-01', date '2026-01-02', date '2026-01-07',
    date '2026-02-15', date '2026-02-16', date '2026-02-17',
    date '2026-04-10', date '2026-04-11', date '2026-04-12', date '2026-04-13',
    date '2026-05-01', date '2026-05-02', date '2026-11-11',
    date '2027-01-01', date '2027-01-02', date '2027-01-07',
    date '2027-02-15', date '2027-02-16',
    date '2027-04-30', date '2027-05-01', date '2027-05-02', date '2027-05-03', date '2027-05-04',
    date '2027-11-11'];
  v_missing date[];
  v_extra   date[];
  v_weekday int;
begin
  select array_agg(d order by d) into v_missing
    from unnest(v_expected) d
   where not exists (select 1 from public.public_holidays h where h.holiday_on = d);
  if v_missing is not null then
    raise exception 'public holidays missing after the insert: % -- rolling back', v_missing;
  end if;

  -- Rows the list does not have: somebody entered them on purpose, and they stay.
  select array_agg(h.holiday_on order by h.holiday_on) into v_extra
    from public.public_holidays h
   where h.holiday_on >= date '2026-01-01' and h.holiday_on < date '2028-01-01'
     and h.holiday_on <> all (v_expected);
  if v_extra is not null then
    raise notice 'public holidays 2026-2027 also hold days this list does not have, kept as they are: %', v_extra;
  end if;

  select count(*) into v_weekday
    from unnest(v_expected) d
   where extract(isodow from d) < 6;
  raise notice 'public holidays 2026-2027: all % listed days present, % of them on a weekday',
    array_length(v_expected, 1), v_weekday;
end $$;

commit;
