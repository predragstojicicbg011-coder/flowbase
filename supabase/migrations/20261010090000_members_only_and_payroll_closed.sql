-- Only MCFlow's own users reach MCFlow's data, and salaries stay with the
-- people who run payroll.
--
-- What this closes. Several policies inherited from Mintflow let ANY signed-in
-- account in: `true`, `auth.role() = 'authenticated'` or `auth.uid() is not
-- null`. payroll_records and payroll_lines (salaries) were readable and
-- writable that way, audit_log (old and new values of every change) was
-- readable, and credits, instalments, banks, the company, partners and the
-- P&L lookups were writable by anyone signed in. Sign-ups are now closed, but
-- an account created by mistake, or a future low-role user, would still have
-- had all of it.
--
-- 1. One RESTRICTIVE policy on every table in public: the caller must have a
--    profile with one of MCFlow's roles. Restrictive policies are ANDed with
--    the permissive ones, so an account without a profile sees and changes
--    nothing, whatever an older permissive policy says. New tables must get
--    the same policy (members_only).
-- 2. Payroll rows: administrator and owner only, as for every other payroll
--    table.
-- 3. audit_log: read by the administrator only (audit_select already says so).
-- 4. The blanket "allow all" policies go. Reads stay open to members, writes
--    follow the roles used for comparable tables.

begin;

-- ── Helpers ───────────────────────────────────────────────────────────────

create or replace function public.is_member() returns boolean
  language sql stable security definer
  set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('administrator', 'owner', 'manager', 'administrative_assistant')
  );
$$;

create or replace function public.can_write_books() returns boolean
  language sql stable security definer
  set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('administrator', 'owner', 'administrative_assistant')
  );
$$;

revoke all on function public.is_member()       from public, anon;
revoke all on function public.can_write_books() from public, anon;
grant execute on function public.is_member()       to authenticated, service_role;
grant execute on function public.can_write_books() to authenticated, service_role;

-- get_my_role is SECURITY DEFINER without a fixed search_path; pin it.
alter function public.get_my_role() set search_path to 'public';


-- ── 1. Members only, everywhere ───────────────────────────────────────────

do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists members_only on public.%I', t);
    -- profiles is how membership is decided; a user must always be able to
    -- read their own row, which own_profile_only already limits.
    if t <> 'profiles' then
      execute format(
        'create policy members_only on public.%I as restrictive for all to authenticated '
        'using (public.is_member()) with check (public.is_member())', t);
    end if;
  end loop;
end $$;


-- ── 2. Payroll rows: administrator and owner ──────────────────────────────

drop policy if exists payroll_records_all                on public.payroll_records;
drop policy if exists payroll_records_authenticated_read on public.payroll_records;
drop policy if exists payroll_lines_all                  on public.payroll_lines;
drop policy if exists payroll_lines_authenticated_read   on public.payroll_lines;

create policy payroll_records_read  on public.payroll_records for select to authenticated using (public.is_admin());
create policy payroll_records_write on public.payroll_records for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy payroll_lines_read    on public.payroll_lines   for select to authenticated using (public.is_admin());
create policy payroll_lines_write   on public.payroll_lines   for all    to authenticated using (public.is_admin()) with check (public.is_admin());


-- ── 3. Audit log: the administrator reads it ──────────────────────────────

drop policy if exists audit_log_read on public.audit_log;


-- ── 4. No more "allow all" ────────────────────────────────────────────────

-- Lookups that already have their own read and modify policies.
drop policy if exists "Allow all for authenticated users" on public.pl_categories;
drop policy if exists "Allow all for authenticated users" on public.pl_subcategories;
drop policy if exists "Allow all for authenticated users" on public.partners;
drop policy if exists "Allow all for authenticated"       on public.import_logs;

-- Tables whose only policy was "allow all": members read, roles write.
drop policy if exists "Allow all for authenticated users" on public.banks;
drop policy if exists "Allow all for authenticated users" on public.companies;
drop policy if exists "Allow all for authenticated users" on public.expense_categories;
drop policy if exists "Allow all for authenticated users" on public.expense_subcategories;

create policy banks_read  on public.banks for select to authenticated using (has_company_access(company_id));
create policy banks_write on public.banks for all    to authenticated
  using (public.is_admin() and has_company_access(company_id))
  with check (public.is_admin() and has_company_access(company_id));

create policy companies_read  on public.companies for select to authenticated using (has_company_access(id));
create policy companies_write on public.companies for update to authenticated
  using (public.is_admin() and has_company_access(id))
  with check (public.is_admin() and has_company_access(id));

create policy expense_categories_read  on public.expense_categories for select to authenticated using (true);
create policy expense_categories_write on public.expense_categories for all    to authenticated
  using (get_my_role() = 'administrator') with check (get_my_role() = 'administrator');
create policy expense_subcategories_read  on public.expense_subcategories for select to authenticated using (true);
create policy expense_subcategories_write on public.expense_subcategories for all    to authenticated
  using (get_my_role() = 'administrator') with check (get_my_role() = 'administrator');

-- Credits and their instalments: anyone who books may pay one down (a
-- payment updates its instalments); only the administrator or owner deletes.
drop policy if exists "Allow authenticated all on credits"             on public.credits;
drop policy if exists "Allow authenticated all on credit_installments" on public.credit_installments;

create policy credits_read   on public.credits for select to authenticated using (true);
create policy credits_insert on public.credits for insert to authenticated with check (public.can_write_books());
create policy credits_update on public.credits for update to authenticated using (public.can_write_books()) with check (public.can_write_books());
create policy credits_delete on public.credits for delete to authenticated using (public.is_admin());

create policy credit_installments_read   on public.credit_installments for select to authenticated using (true);
create policy credit_installments_insert on public.credit_installments for insert to authenticated with check (public.can_write_books());
create policy credit_installments_update on public.credit_installments for update to authenticated using (public.can_write_books()) with check (public.can_write_books());
create policy credit_installments_delete on public.credit_installments for delete to authenticated using (public.is_admin());

-- The company's own profile and accounts: the administrator or owner.
drop policy if exists "authenticated can insert" on public.company_profiles;
drop policy if exists "authenticated can update" on public.company_profiles;
create policy company_profiles_insert on public.company_profiles for insert to authenticated with check (public.is_admin());
create policy company_profiles_update on public.company_profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "authenticated can insert" on public.company_bank_accounts;
drop policy if exists "authenticated can update" on public.company_bank_accounts;
drop policy if exists "authenticated can delete" on public.company_bank_accounts;
create policy company_bank_accounts_insert on public.company_bank_accounts for insert to authenticated with check (public.is_admin());
create policy company_bank_accounts_update on public.company_bank_accounts for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy company_bank_accounts_delete on public.company_bank_accounts for delete to authenticated using (public.is_admin());

-- A partner's bank accounts follow the partner: anyone who books may add
-- or correct one, the administrator or owner removes it.
drop policy if exists "authenticated can insert" on public.partner_accounts;
drop policy if exists "authenticated can update" on public.partner_accounts;
drop policy if exists "authenticated can delete" on public.partner_accounts;
create policy partner_accounts_insert on public.partner_accounts for insert to authenticated with check (public.can_write_books());
create policy partner_accounts_update on public.partner_accounts for update to authenticated using (public.can_write_books()) with check (public.can_write_books());
create policy partner_accounts_delete on public.partner_accounts for delete to authenticated using (public.is_admin());

-- Splits are written with the documents they divide.
drop policy if exists pl_splits_write on public.pl_splits;
create policy pl_splits_write on public.pl_splits for all to authenticated
  using (public.can_write_books()) with check (public.can_write_books());

commit;
