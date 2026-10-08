-- ============================================================================
-- System categories: where the app books what it books on its own
--
-- Code copied from Mintflow posted payroll, credit instalments and the cash
-- flow split to P&L headings it found BY THEIR ENGLISH MINTFLOW NAMES —
-- 'Employee and Labour' › 'Net Salaries', 'Loans/Credits/Dividend' ›
-- 'Bank Credits', 'Banking and Finance', 'Taxes'. MCFlow's owner builds his
-- own P&L structure in Serbian (pl_categories, pl_subcategories, departments,
-- dept_subcategories, expense_descriptions), so those names will never exist
-- here and every such posting would either be refused or invent a heading.
--
-- This table says, per company, which of HIS headings each "role" posts to.
-- One row per role; the role keys are stable English identifiers declared in
-- src/services/systemCategories.ts (SYSTEM_ROLES), which also says which of
-- the five fields each role fills. A role with no row, or with a field the
-- role needs left empty, is unset, and the app REFUSES to post to it rather
-- than writing an empty or an English classification.
--
-- NAMES, NOT IDS. Transactions, invoices and pl_splits store the
-- classification as text (pl_category, pl_subcategory, department,
-- dept_subcategory, expense_description), and this table stores exactly what
-- gets copied onto them. Settings → Sistemske kategorije flags a row whose
-- name no longer exists in the lookup tables.
--
-- Policies mirror projects: read with access to the company; written by the
-- administrator or owner only — a system category moves every future payroll
-- and credit payment, which is a settings decision, not a bookkeeping one.
-- ============================================================================

create table public.system_categories (
  id uuid default gen_random_uuid() not null primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  role text not null,
  pl_category text,
  pl_subcategory text,
  department text,
  dept_subcategory text,
  expense_description text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  -- A stable key, not a label: snake_case English, as in SYSTEM_ROLES.
  constraint system_categories_role_check check (role ~ '^[a-z][a-z0-9_]*$'),
  constraint system_categories_company_role_key unique (company_id, role)
);

comment on table public.system_categories is 'Per company, the P&L classification each automatic posting role writes (payroll net salary, income tax, contributions, credit principal and interest, the cash-flow banking and tax lines…). Roles and the fields each one fills are declared in src/services/systemCategories.ts. Names, not ids — copied as-is onto transactions/invoices. An unset role makes the app refuse to post.';
comment on column public.system_categories.role is 'Stable English key of the role, e.g. payroll_net_salary, credit_interest. See SYSTEM_ROLES in src/services/systemCategories.ts.';

alter table public.system_categories enable row level security;

create policy system_categories_select on public.system_categories for select to authenticated
  using (public.has_company_access(company_id));
create policy system_categories_insert on public.system_categories for insert to authenticated
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
              and public.has_company_access(company_id));
create policy system_categories_update on public.system_categories for update to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
         and public.has_company_access(company_id))
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
              and public.has_company_access(company_id));
create policy system_categories_delete on public.system_categories for delete to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
         and public.has_company_access(company_id));

create trigger audit_system_categories after insert or delete or update on public.system_categories
  for each row execute function public.audit_trigger();

revoke all on table public.system_categories from anon;
grant all on table public.system_categories to authenticated;
grant all on table public.system_categories to service_role;
