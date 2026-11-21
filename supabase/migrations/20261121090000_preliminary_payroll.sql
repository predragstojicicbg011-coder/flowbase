-- ============================================================================
-- A preliminary payroll for the running month
--
-- Ported from Mintflow (20270105090000_a_preliminary_payroll.sql) and adapted
-- to FlowBase: no R&D, so the template has every hour category a FlowBase
-- timesheet has; no page-gate registry, so the template is protected the way
-- payroll_timesheets is (administrator and owner read and write) plus the
-- restrictive members_only every FlowBase table carries (NADOGRADNJA rule 3).
--
-- Before the real timesheets arrive, the running month is calculated in the
-- browser on assumed hours. This file keeps those hours, marks what a kept run
-- is, and makes sure a preliminary run never reaches the ledger:
--
--   A. `payroll_belgrade_month(p_at)`: the first of the month that contains
--      p_at in Belgrade -- the same rule the pages apply (src/utils/today.ts).
--   B. `payroll_preliminary_hours`: ONE ROW PER MONTH -- the sixteen hour
--      categories of a timesheet, a note, who saved it and when. A trigger
--      accepts a write only for the running month and stamps who saved it.
--   C. `payroll_runs.kind`: 'preliminary' or 'regular', default 'regular', so
--      every run kept so far is regular. The unique index on (company, month,
--      run) is NOT touched: Recalculate overwrites the same row, which is how
--      a preliminary run becomes regular.
--   D. THREE LOCKS ON THE LEDGER: a run cannot be set to posted while
--      preliminary; its kind cannot change once a posting row exists for it,
--      by run_id or by (company, month, run); and a payroll_postings row for
--      a preliminary run is refused, its run found by run_id, else by
--      (company, month, run).
--   E. A RUN A POSTING IS MADE FROM IS NOT DELETED: the page removes a kept
--      draft nobody is in any more, and between a posting's claim and its
--      run's freeze that run is still a draft. The delete is refused while a
--      posting row exists for it, by run_id or by (company, month, run).
--      undoPosting removes the posting row first and then puts the run back
--      to draft, so nothing it does is refused.
--
-- No client data (NADOGRADNJA rule 2). NOT RE-RUNNABLE, ON PURPOSE: this file
-- is the only author of its table and of the kind column, and `if not exists`
-- would quietly adopt one of another shape. A second application stops at
-- section 0 and changes nothing.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- -- 0. WHAT THIS FILE NEEDS BEFORE IT WRITES ANYTHING -------------------------
do $$
declare
  rel text;
  col text;
begin
  foreach rel in array array['payroll_runs', 'payroll_postings', 'payroll_run_lines', 'profiles'] loop
    if to_regclass('public.' || rel) is null then
      raise exception 'public.% is not there, and this file guards it. Nothing was written -- rolling back', rel;
    end if;
  end loop;

  foreach col in array array['id', 'company_id', 'period_month', 'run_key', 'status'] loop
    if not exists (select 1 from pg_attribute a
                    where a.attrelid = 'public.payroll_runs'::regclass
                      and a.attname = col and a.attnum > 0 and not a.attisdropped) then
      raise exception 'public.payroll_runs has no % column, and the kind guard reads it. Nothing was written -- rolling back', col;
    end if;
  end loop;
  foreach col in array array['run_id', 'company_id', 'period_month', 'run_key'] loop
    if not exists (select 1 from pg_attribute a
                    where a.attrelid = 'public.payroll_postings'::regclass
                      and a.attname = col and a.attnum > 0 and not a.attisdropped) then
      raise exception 'public.payroll_postings has no % column, and the posting guard reads it. Nothing was written -- rolling back', col;
    end if;
  end loop;

  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.payroll_run_lines'::regclass
                    and t.tgname = 'payroll_run_lines_frozen_trg' and not t.tgisinternal) then
    raise exception 'the trigger payroll_run_lines_frozen_trg is not there, and a posted run is only a record while it is. Nothing was written -- rolling back';
  end if;

  if to_regprocedure('public.get_my_role()') is null or to_regprocedure('public.is_member()') is null then
    raise exception 'public.get_my_role() or public.is_member() is not there, and the policies this file writes ask them. Nothing was written -- rolling back';
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'auth.uid() is not there, so a template could not say who saved it. Nothing was written -- rolling back';
  end if;
  if to_regrole('anon') is null or to_regrole('authenticated') is null then
    raise exception 'one of the roles anon and authenticated is not there, and every grant here names them. Nothing was written -- rolling back';
  end if;

  -- Neither may already exist under another author's hand.
  if to_regclass('public.payroll_preliminary_hours') is not null then
    raise exception 'public.payroll_preliminary_hours already exists. This file is its only author, so either it was applied already or something else made it -- READ IT FIRST. Nothing was written -- rolling back';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.payroll_runs'::regclass
                and a.attname = 'kind' and a.attnum > 0 and not a.attisdropped) then
    raise exception 'public.payroll_runs already has a kind column. This file is its only author, so either it was applied already or something else made it -- READ IT FIRST. Nothing was written -- rolling back';
  end if;
end $$;

-- -- A. THE RUNNING MONTH, AS BELGRADE HAS IT ----------------------------------
--
-- 00:30 on the 1st in Belgrade is still the 31st (or the 30th) in UTC; the
-- month is Belgrade's. Reads no table, so it runs with the caller's rights.
create function public.payroll_belgrade_month(p_at timestamptz default now())
returns date
language sql
stable
set search_path = public, pg_temp
as $fn$
  select date_trunc('month', p_at at time zone 'Europe/Belgrade')::date
$fn$;

comment on function public.payroll_belgrade_month(timestamptz) is
  'The first of the month that contains p_at in Belgrade: the running month '
  'the preliminary payroll is kept for. 20261121090000.';

revoke all on function public.payroll_belgrade_month(timestamptz) from public, anon;
grant execute on function public.payroll_belgrade_month(timestamptz) to authenticated, service_role;

-- -- B. THE TEMPLATE OF HOURS ---------------------------------------------------
--
-- "Somebody who worked the whole month has these hours": every category a
-- FlowBase timesheet has. The pages apply it in memory to people with no
-- timesheet; it is never written to payroll_timesheets.
create table public.payroll_preliminary_hours (
  month                     date primary key
                            constraint payroll_preliminary_hours_month_is_first_of_month
                            check (month = date_trunc('month', month)::date),
  regular_hours             numeric not null default 0,
  holiday_hours             numeric not null default 0,
  vacation_hours            numeric not null default 0,
  sick_hours                numeric not null default 0,
  sick_full_hours           numeric not null default 0,
  sick_maternity_hours      numeric not null default 0,
  sick_fund_hours           numeric not null default 0,
  paid_leave_hours          numeric not null default 0,
  religious_holiday_hours   numeric not null default 0,
  military_court_hours      numeric not null default 0,
  work_stoppage_hours       numeric not null default 0,
  absence_hours             numeric not null default 0,
  undocumented_hours        numeric not null default 0,
  suspension_single_hours   numeric not null default 0,
  suspension_family_hours   numeric not null default 0,
  unpaid_hours              numeric not null default 0,
  note                      text,
  saved_by                  uuid default auth.uid(),
  saved_at                  timestamptz not null default now(),
  constraint payroll_preliminary_hours_not_negative check (
    regular_hours >= 0 and holiday_hours >= 0 and vacation_hours >= 0
    and sick_hours >= 0 and sick_full_hours >= 0 and sick_maternity_hours >= 0
    and sick_fund_hours >= 0 and paid_leave_hours >= 0 and religious_holiday_hours >= 0
    and military_court_hours >= 0 and work_stoppage_hours >= 0 and absence_hours >= 0
    and undocumented_hours >= 0 and suspension_single_hours >= 0
    and suspension_family_hours >= 0 and unpaid_hours >= 0)
);

comment on table public.payroll_preliminary_hours is
  'The assumed hours of a whole month, one row per month, kept only for the '
  'running month in Belgrade (payroll_preliminary_hours_running_month). Applied '
  'in the browser to people with no timesheet; never a timesheet, never posted. '
  'Read and written by administrators and the owner, as payroll_timesheets. 20261121090000.';

revoke all on table public.payroll_preliminary_hours from public, anon, authenticated;
grant select, insert, update, delete on table public.payroll_preliminary_hours to authenticated;
grant all on table public.payroll_preliminary_hours to service_role;
alter table public.payroll_preliminary_hours enable row level security;

create policy members_only on public.payroll_preliminary_hours as restrictive
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy payroll_preliminary_hours_read on public.payroll_preliminary_hours
  for select to authenticated
  using ((select public.get_my_role()) = any (array['administrator', 'owner']));

create policy payroll_preliminary_hours_write on public.payroll_preliminary_hours
  for all to authenticated
  using ((select public.get_my_role()) = any (array['administrator', 'owner']))
  with check ((select public.get_my_role()) = any (array['administrator', 'owner']));

-- -- B2. ONLY FOR THE RUNNING MONTH ---------------------------------------------
--
-- On every write, the old month too on an update and a delete: last month's
-- template is history and is not rewritten, and next month's is not kept
-- before it has started. Who saved it and when are stamped here, so an update
-- says who made it and the page never sends either.
create function public.payroll_preliminary_hours_running_month()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  NOT_RUNNING constant text := 'Pretpostavljeni sati se čuvaju samo za tekući mesec.';
  v_running date := public.payroll_belgrade_month();
begin
  if tg_op in ('UPDATE', 'DELETE') and old.month is distinct from v_running then
    raise exception using errcode = 'check_violation', message = NOT_RUNNING;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.month is distinct from v_running then
    raise exception using errcode = 'check_violation', message = NOT_RUNNING;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.saved_by := auth.uid();
  new.saved_at := now();
  return new;
end
$fn$;

revoke all on function public.payroll_preliminary_hours_running_month() from public, anon, authenticated;

create trigger payroll_preliminary_hours_running_month
  before insert or update or delete on public.payroll_preliminary_hours
  for each row execute function public.payroll_preliminary_hours_running_month();

-- -- C. WHAT A KEPT RUN IS --------------------------------------------------------
alter table public.payroll_runs
  add column kind text not null default 'regular'
  constraint payroll_runs_kind_known check (kind in ('preliminary', 'regular'));

comment on column public.payroll_runs.kind is
  'preliminary: calculated on assumed hours, or on a rate that is not yet the 20th''s '
  'for a month that converts euros; never posted (payroll_runs_kind_guard, '
  'payroll_postings_not_preliminary). regular: everything real. Recalculate '
  'overwrites it. 20261121090000.';

-- -- D. A PRELIMINARY RUN IS NEVER POSTED, AND A POSTED RUN'S KIND NEVER MOVES ----
--
-- "Posted" is asked of payroll_postings, not of the run's status: between the
-- claim of a posting and the freeze of its run the status is still draft, and
-- a second tab recalculating in that window must not turn the run preliminary
-- underneath the invoices being written. SECURITY DEFINER so the lookups see
-- every posting whatever the caller's policies say.
create function public.payroll_runs_kind_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  NOT_POSTED  constant text := 'Preliminarni obračun ne može da se proknjiži.';
  KIND_FROZEN constant text := 'Ovaj obračun je proknjižen, pa njegova vrsta (preliminaran ili redovan) ne može da se menja.';
begin
  if new.status = 'posted' and new.kind = 'preliminary' then
    raise exception using errcode = 'check_violation', message = NOT_POSTED;
  end if;
  if tg_op = 'UPDATE' and new.kind is distinct from old.kind
     and exists (select 1 from public.payroll_postings p
                  where p.run_id = old.id
                     or (p.company_id = old.company_id and p.period_month = old.period_month
                         and p.run_key = old.run_key)) then
    raise exception using errcode = 'check_violation', message = KIND_FROZEN;
  end if;
  return new;
end
$fn$;

revoke all on function public.payroll_runs_kind_guard() from public, anon, authenticated;

create trigger payroll_runs_kind_guard
  before insert or update on public.payroll_runs
  for each row execute function public.payroll_runs_kind_guard();

create function public.payroll_postings_not_preliminary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  NOT_POSTED constant text := 'Preliminarni obračun ne može da se proknjiži.';
  v_kind text;
begin
  -- By run_id, else by (company, month, run): run_id is nullable and set null
  -- when its run is deleted.
  if new.run_id is not null then
    select r.kind into v_kind from public.payroll_runs r where r.id = new.run_id;
  end if;
  if v_kind is null then
    select r.kind into v_kind from public.payroll_runs r
     where r.company_id = new.company_id and r.period_month = new.period_month
       and r.run_key = new.run_key;
  end if;
  if v_kind = 'preliminary' then
    raise exception using errcode = 'check_violation', message = NOT_POSTED;
  end if;
  return new;
end
$fn$;

revoke all on function public.payroll_postings_not_preliminary() from public, anon, authenticated;

create trigger payroll_postings_not_preliminary
  before insert or update of run_id, company_id, period_month, run_key on public.payroll_postings
  for each row execute function public.payroll_postings_not_preliminary();

-- -- E. A RUN A POSTING IS MADE FROM IS NOT DELETED --------------------------------
create function public.payroll_runs_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  HAS_POSTING constant text := 'Ovaj obračun ima knjiženje u glavnoj knjizi, pa ne može da se ukloni. Prvo poništite knjiženje.';
begin
  if exists (select 1 from public.payroll_postings p
              where p.run_id = old.id
                 or (p.company_id = old.company_id and p.period_month = old.period_month
                     and p.run_key = old.run_key)) then
    raise exception using errcode = 'check_violation', message = HAS_POSTING;
  end if;
  return old;
end
$fn$;

revoke all on function public.payroll_runs_delete_guard() from public, anon, authenticated;

create trigger payroll_runs_delete_guard
  before delete on public.payroll_runs
  for each row execute function public.payroll_runs_delete_guard();

-- -- F. THE CHECKS -------------------------------------------------------------------
--
-- Catalogue facts only; each block raises and rolls the whole file back. What
-- the triggers do is proved by supabase/tests/preliminary_payroll_test.sql.
do $$
declare
  v_found text[];
  v_def   text;
  r       record;
  v_cols  constant text[] := array[
    'month date not null',
    'regular_hours numeric not null', 'holiday_hours numeric not null',
    'vacation_hours numeric not null', 'sick_hours numeric not null',
    'sick_full_hours numeric not null', 'sick_maternity_hours numeric not null',
    'sick_fund_hours numeric not null', 'paid_leave_hours numeric not null',
    'religious_holiday_hours numeric not null', 'military_court_hours numeric not null',
    'work_stoppage_hours numeric not null', 'absence_hours numeric not null',
    'undocumented_hours numeric not null', 'suspension_single_hours numeric not null',
    'suspension_family_hours numeric not null', 'unpaid_hours numeric not null',
    'note text', 'saved_by uuid', 'saved_at timestamp with time zone not null'];
begin
  -- The template, column for column: exactly the hour columns of a timesheet.
  select array_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                   || case when a.attnotnull then ' not null' else '' end order by a.attnum)
    into v_found
    from pg_attribute a
   where a.attrelid = 'public.payroll_preliminary_hours'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_found is distinct from v_cols then
    raise exception 'public.payroll_preliminary_hours came out as [%] and this file wrote [%] -- rolling back',
      array_to_string(v_found, ', '), array_to_string(v_cols, ', ');
  end if;
  select array_agg(c.column_name::text order by c.column_name) into v_found
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'payroll_timesheets' and c.column_name like '%\_hours';
  if v_found is distinct from (select array_agg(x order by x) from unnest(v_cols) u(c), split_part(u.c, ' ', 1) x
                                where x like '%\_hours') then
    raise exception 'payroll_timesheets has the hour columns [%], which the template does not mirror -- rolling back',
      array_to_string(v_found, ', ');
  end if;

  -- Row level security, the restrictive members_only, the two role policies.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.payroll_preliminary_hours'::regclass) then
    raise exception 'row level security is OFF on public.payroll_preliminary_hours -- rolling back';
  end if;
  select array_agg(pol.polname::text || ':' || case when pol.polpermissive then 'p' else 'r' end
                   order by pol.polname) into v_found
    from pg_policy pol where pol.polrelid = 'public.payroll_preliminary_hours'::regclass;
  if v_found is distinct from array['members_only:r', 'payroll_preliminary_hours_read:p',
                                    'payroll_preliminary_hours_write:p'] then
    raise exception 'public.payroll_preliminary_hours carries the policies [%] -- rolling back',
      array_to_string(v_found, ', ');
  end if;
  for r in select pol.polname, pg_get_expr(pol.polqual, pol.polrelid) as q,
                  pg_get_expr(pol.polwithcheck, pol.polrelid) as c
             from pg_policy pol where pol.polrelid = 'public.payroll_preliminary_hours'::regclass loop
    if r.polname = 'members_only' then
      if r.q not like '%is_member()%' or r.c not like '%is_member()%' then
        raise exception 'members_only does not ask is_member() in both clauses -- rolling back';
      end if;
    elsif r.q not like '%administrator%owner%' or r.q like '%assistant%' or r.q like '%manager%' then
      raise exception '% does not admit administrators and owners alone -- rolling back', r.polname;
    end if;
  end loop;

  -- The grants: anon nothing.
  if has_table_privilege('anon', 'public.payroll_preliminary_hours', 'select')
     or has_table_privilege('anon', 'public.payroll_preliminary_hours', 'insert') then
    raise exception '`anon` holds a privilege on public.payroll_preliminary_hours -- rolling back';
  end if;

  -- The kind column.
  select pg_get_expr(d.adbin, d.adrelid) into v_def
    from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.payroll_runs'::regclass and a.attname = 'kind'
     and a.attnotnull and a.atttypid = 'text'::regtype;
  if v_def is distinct from '''regular''::text' then
    raise exception 'public.payroll_runs.kind is not `text not null default ''regular''`: [%] -- rolling back',
      coalesce(v_def, 'nothing');
  end if;

  -- The four triggers, enabled, as written.
  for r in select * from (values
    ('payroll_preliminary_hours', 'payroll_preliminary_hours_running_month', 'BEFORE INSERT OR DELETE OR UPDATE'),
    ('payroll_runs', 'payroll_runs_kind_guard', 'BEFORE INSERT OR UPDATE'),
    ('payroll_runs', 'payroll_runs_delete_guard', 'BEFORE DELETE'),
    ('payroll_postings', 'payroll_postings_not_preliminary',
     'BEFORE INSERT OR UPDATE OF run_id, company_id, period_month, run_key')
  ) as t(tbl, trg, timing) loop
    select pg_get_triggerdef(t.oid) into v_def
      from pg_trigger t
     where t.tgrelid = ('public.' || r.tbl)::regclass and t.tgname = r.trg and not t.tgisinternal
       and t.tgenabled <> 'D';
    if v_def is null or v_def not like '%' || r.timing || ' ON public.' || r.tbl || ' FOR EACH ROW%' then
      raise exception 'the trigger % on public.% is not there, is disabled, or does not fire %: [%] -- rolling back',
        r.trg, r.tbl, r.timing, coalesce(v_def, 'nothing');
    end if;
  end loop;

  -- The five functions as the catalogue holds them: every one pins
  -- search_path to `public, pg_temp`; the four trigger functions run as their
  -- owner (they must see every posting whatever the caller's policies say) and
  -- nobody signed in may call them; payroll_belgrade_month reads no table, so
  -- it runs with the caller's rights, authenticated may call it and anon not.
  for r in select * from (values
    ('payroll_belgrade_month(timestamp with time zone)', false),
    ('payroll_preliminary_hours_running_month()', true),
    ('payroll_runs_kind_guard()', true),
    ('payroll_postings_not_preliminary()', true),
    ('payroll_runs_delete_guard()', true)
  ) as t(fn, definer) loop
    if to_regprocedure('public.' || r.fn) is null then
      raise exception 'public.% is not there -- rolling back', r.fn;
    end if;
    if (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.' || r.fn)) is distinct from r.definer then
      raise exception 'public.% is % SECURITY DEFINER and this file writes it % -- rolling back',
        r.fn, case when r.definer then 'not' else 'now' end, case when r.definer then 'so' else 'without' end;
    end if;
    if not coalesce((select 'search_path=public, pg_temp' = any (p.proconfig)
                       from pg_proc p where p.oid = to_regprocedure('public.' || r.fn)), false) then
      raise exception 'public.% does not pin search_path to `public, pg_temp`: [%] -- rolling back', r.fn,
        coalesce((select array_to_string(p.proconfig, ', ') from pg_proc p
                   where p.oid = to_regprocedure('public.' || r.fn)), 'unset');
    end if;
    if r.definer and (has_function_privilege('anon', 'public.' || r.fn, 'execute')
                      or has_function_privilege('authenticated', 'public.' || r.fn, 'execute')) then
      raise exception 'anon or authenticated may execute public.% -- rolling back', r.fn;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.payroll_belgrade_month(timestamp with time zone)', 'execute')
     or not has_function_privilege('authenticated', 'public.payroll_belgrade_month(timestamp with time zone)', 'execute') then
    raise exception 'payroll_belgrade_month is not executable by authenticated alone among the two -- rolling back';
  end if;

  -- What this file leaves as it found it.
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and indexname = 'payroll_runs_once_idx'
                    and indexdef not like '%kind%') then
    raise exception 'payroll_runs_once_idx is gone or now names kind; Recalculate must overwrite the same row -- rolling back';
  end if;
end $$;

commit;
