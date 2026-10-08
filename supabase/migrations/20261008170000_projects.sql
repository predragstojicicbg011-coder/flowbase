-- ============================================================================
-- Projects replace the Aimfox / Social Growth allocation
--
-- Mintflow split every cost and revenue between two businesses — Aimfox and
-- Social Growth — by type code (`rev_alloc_type`: sg100, af100, shared,
-- byval), by value (`rev_alloc_aimfox`, `rev_alloc_sg`), by percentage on
-- payroll (`rev_alloc_af_pct`), and again into opex vs performance marketing
-- (`opex_type`, `opex_amount`, `performance_amount`). MCFlow is one
-- construction company. What it needs to know is which SITE or BUILDING a
-- cost or an income belongs to.
--
-- The model:
--
--   projects          a construction site (kind 'construction') or a rental
--                     building (kind 'rental'), with its investor (a partner)
--                     and its contract value.
--   project_id        on transactions, invoices and pl_splits: the one
--                     project a row belongs to. NULL means company overhead
--                     ("Opšti troškovi"). There are no allocation keys:
--                     a project's profitability is its revenue less its own
--                     direct costs, and overhead is reported on its own line.
--   pl_splits         a document that belongs to several projects is split,
--                     with the generic split mechanism, one line per project.
--                     This replaces the old two-way by-value split.
--   payroll_timesheet_projects
--                     hours per employee per month per project. Payroll cost
--                     is distributed over projects by these hours.
--
-- Decisions on the tables the brief asked about:
--
--   passthrough           NO project. A pass-through is money received on
--                         someone else's behalf and paid on; it never reaches
--                         the P&L (pl_impact defaults false, it is not a leg
--                         of v_pl_entries), so it has no profitability to
--                         attribute.
--   revenue_collections   NO project. A collection settles revenue_entries;
--                         the entry carries the project, and a collection
--                         that covers several entries would have no single
--                         project anyway.
--   revenue_entries       project_id added: an expected income belongs to a
--                         site or a building. `brand` (a Mintflow product
--                         name) becomes nullable; nothing new should fill it.
--   payroll_records       NO project. It is a whole month's payroll payment.
--   payroll_lines         NO project; only its allocation columns go. Payroll
--                         reaches projects through the hours table and the
--                         posting, which writes invoices/splits per project.
--   budget_entries        project_id added (null = an overhead line), for
--                         symmetry with v_budget_vs_actual. Nothing writes the
--                         table any more.
--   budget_adjustments    project_id added (null = overhead): this is the
--                         live budget ledger, and a budget line may now target
--                         a project.
--   quick_fill_scripts    NO project; `rev_alloc` and `opex_type` go. A script
--                         is a reusable classification (category, department,
--                         cost type). A project is chosen per document, and a
--                         script that silently assigned one would put next
--                         month's bills on last month's site.
--   employee_cost_allocation
--                         KEPT, minus `rev_alloc_type` and `opex_type`. It
--                         also says which department and sub-category a
--                         salary posts under, with dated validity, and the
--                         payroll posting (services/payroll/posting.ts) reads
--                         exactly that.
--
-- Revenue streams: `revenue_stream` classifies income, it does not allocate
-- it. The list is now a construction company's, stored in Serbian and checked
-- on all three tables that carry it. src/services/revenueStreams.ts holds the
-- same list and the same mapping from Mintflow's values.
--
-- The database holds no business data yet; the mapping UPDATEs below exist
-- so that a stray test row cannot fail the new CHECKs.
--
-- Order: views that read the dropped columns go first, then the tables
-- change, then the views come back with their grants. No CASCADE: an unknown
-- dependency fails the migration instead of vanishing with it.
--
-- Functions: none of them reads a dropped column (pl_splits_must_balance
-- sums `amount` only; the delete cascades and reconcile_direct_transaction
-- touch links, status and pl_impact), so none is replaced.
-- ============================================================================


-- ── 1. Views over the columns about to be dropped ──────────────────────────
-- None of them reads another, so the order among them does not matter.

drop view if exists public.v_budget_vs_actual;
drop view if exists public.v_invoice_status;
drop view if exists public.v_pl_entries;
drop view if exists public.v_revenue_entry_status;


-- ── 2. projects ────────────────────────────────────────────────────────────

create table public.projects (
  id uuid default gen_random_uuid() not null primary key,
  company_id uuid not null references public.companies(id),
  name text not null,
  code text,
  kind text not null default 'construction',
  investor_partner_id uuid references public.partners(id) on delete set null,
  contract_value numeric(18,2),
  contract_currency text,
  -- The date the book figures below were converted at: the contract date,
  -- or the day the project was entered.
  contract_date date,
  contract_value_rsd numeric(18,2),
  contract_value_eur numeric(18,2),
  active boolean not null default true,
  note text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint projects_name_check check (btrim(name) <> ''),
  constraint projects_kind_check check (kind = any (array['construction'::text, 'rental'::text])),
  constraint projects_contract_currency_check
    check (contract_currency is null or contract_currency = any (array['RSD'::text, 'EUR'::text])),
  constraint projects_contract_value_check check (contract_value is null or contract_value >= 0),
  -- A value without a currency is a figure nobody can read; a currency
  -- without a value is a leftover from a cleared field.
  constraint projects_contract_value_has_currency
    check ((contract_value is null) = (contract_currency is null))
);

comment on table public.projects is 'A construction site (gradilište) or a rental building (objekat u zakupu). Transactions, invoices and P&L split lines point at one through project_id; a row with no project is company overhead (Opšti troškovi). Profitability per project is its revenue less its own direct costs — there are no allocation keys.';
comment on column public.projects.kind is '''construction'' — a site billed to an investor; ''rental'' — a building that earns rent. Investor and contract value are expected on a construction site and optional on a rental.';
comment on column public.projects.investor_partner_id is 'The investor the site is built for, from partners. Optional for rental buildings.';
comment on column public.projects.contract_value is 'The contract value in contract_currency, as written in the contract.';
comment on column public.projects.contract_value_rsd is 'contract_value in RSD at the NBS rate on contract_date (bookAmounts in the app).';
comment on column public.projects.contract_value_eur is 'contract_value_rsd in EUR at the same date; exactly contract_value on a EUR contract.';

create unique index projects_company_name_key on public.projects (company_id, lower(name));
create unique index projects_company_code_key on public.projects (company_id, lower(code)) where code is not null;
create index projects_investor_idx on public.projects (investor_partner_id);

alter table public.projects enable row level security;

-- Read by anyone with access to the company; written like partners: the
-- bookkeeping roles add and edit, only an administrator or owner deletes.
create policy projects_select on public.projects for select to authenticated
  using (public.has_company_access(company_id));
create policy projects_insert on public.projects for insert to authenticated
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
              and public.has_company_access(company_id));
create policy projects_update on public.projects for update to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
         and public.has_company_access(company_id))
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
              and public.has_company_access(company_id));
create policy projects_delete on public.projects for delete to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
         and public.has_company_access(company_id));

create trigger audit_projects after insert or delete or update on public.projects
  for each row execute function public.audit_trigger();

revoke all on table public.projects from anon;
grant all on table public.projects to authenticated;
grant all on table public.projects to service_role;


-- ── 3. project_id on the rows that carry cost or revenue ───────────────────
-- ON DELETE RESTRICT: a project with entries cannot be deleted. Mark it
-- inactive instead; its history must keep pointing at it.

alter table public.transactions
  add column project_id uuid references public.projects(id) on delete restrict;
alter table public.invoices
  add column project_id uuid references public.projects(id) on delete restrict;
alter table public.pl_splits
  add column project_id uuid references public.projects(id) on delete restrict;
alter table public.revenue_entries
  add column project_id uuid references public.projects(id) on delete restrict;
alter table public.budget_entries
  add column project_id uuid references public.projects(id) on delete restrict;
alter table public.budget_adjustments
  add column project_id uuid references public.projects(id) on delete restrict;

create index transactions_project_idx on public.transactions (project_id);
create index invoices_project_idx on public.invoices (project_id);
create index pl_splits_project_idx on public.pl_splits (project_id);
create index revenue_entries_project_idx on public.revenue_entries (project_id);
create index budget_entries_project_idx on public.budget_entries (project_id);
create index budget_adjustments_project_idx on public.budget_adjustments (project_id);

comment on column public.transactions.project_id is 'The project this P&L row belongs to; null is company overhead. When the transaction has pl_splits, each split line carries its own project and this one is ignored by v_pl_entries.';
comment on column public.invoices.project_id is 'The project this P&L row belongs to; null is company overhead. When the invoice has pl_splits, each split line carries its own project and this one is ignored by v_pl_entries.';
comment on column public.pl_splits.project_id is 'The project this split line belongs to; null is company overhead. A document shared by several projects is split one line per project.';
comment on column public.revenue_entries.project_id is 'The project this expected income belongs to; null is company-level income.';
comment on column public.budget_entries.project_id is 'The project this budget line targets; null is an overhead line.';
comment on column public.budget_adjustments.project_id is 'The project this budget entry targets; null is an overhead line.';


-- ── 4. The allocation columns go ───────────────────────────────────────────

alter table public.transactions drop constraint if exists transactions_opex_type_check;
alter table public.transactions
  drop column rev_alloc_type,
  drop column rev_alloc_aimfox,
  drop column rev_alloc_sg,
  drop column opex_type,
  drop column opex_amount,
  drop column performance_amount;

alter table public.invoices drop constraint if exists invoices_opex_type_check;
alter table public.invoices
  drop column rev_alloc_type,
  drop column rev_alloc_aimfox,
  drop column rev_alloc_sg,
  drop column opex_type,
  drop column opex_amount,
  drop column performance_amount;

alter table public.pl_splits
  drop column rev_alloc_type,
  drop column opex_type;

alter table public.budget_entries drop column rev_alloc_type;

alter table public.payroll_lines
  drop column rev_alloc_type,
  drop column opex_type,
  drop column rev_alloc_af_pct;

alter table public.payroll_records
  drop column rev_alloc_type,
  drop column opex_type;

alter table public.quick_fill_scripts
  drop column rev_alloc,
  drop column opex_type;

-- Department and sub-category stay: the payroll posting reads them.
alter table public.employee_cost_allocation
  drop constraint if exists employee_cost_allocation_known_codes;
alter table public.employee_cost_allocation
  drop column rev_alloc_type,
  drop column opex_type;
comment on table public.employee_cost_allocation is 'Which department and sub-category a salary posts to, with the dates it applied. A move between departments must not rewrite what the old one cost in the months before it. Which PROJECT a salary goes to is decided by hours, in payroll_timesheet_projects.';


-- ── 5. Revenue streams ─────────────────────────────────────────────────────
-- Mintflow's values mapped onto the new list (revenueStreams.ts holds the
-- same mapping), then a CHECK on every table that carries the column.

update public.transactions set revenue_stream = case revenue_stream
    when 'Social Growth' then 'Građevinske situacije'
    when 'Aimfox' then 'Građevinske situacije'
    when 'Outsourced Services' then 'Građevinske situacije'
    when 'VAT Claimed' then 'Povraćaj PDV-a'
    when 'Interest Received' then 'Prihod od kamata'
    when 'Loans' then 'Krediti'
    when 'Credit' then 'Krediti'
    when '' then null
    else 'Ostalo' end
  where revenue_stream is not null
    and revenue_stream <> all (array['Građevinske situacije', 'Zakup', 'Povraćaj PDV-a', 'Prihod od kamata', 'Krediti', 'Ostalo']);

update public.invoices set revenue_stream = case revenue_stream
    when 'Social Growth' then 'Građevinske situacije'
    when 'Aimfox' then 'Građevinske situacije'
    when 'Outsourced Services' then 'Građevinske situacije'
    when 'VAT Claimed' then 'Povraćaj PDV-a'
    when 'Interest Received' then 'Prihod od kamata'
    when 'Loans' then 'Krediti'
    when 'Credit' then 'Krediti'
    when '' then null
    else 'Ostalo' end
  where revenue_stream is not null
    and revenue_stream <> all (array['Građevinske situacije', 'Zakup', 'Povraćaj PDV-a', 'Prihod od kamata', 'Krediti', 'Ostalo']);

alter table public.revenue_entries drop constraint if exists revenue_entries_revenue_stream_check;
update public.revenue_entries set revenue_stream = case revenue_stream
    when 'aimfox' then 'Građevinske situacije'
    when 'social_growth' then 'Građevinske situacije'
    else 'Ostalo' end
  where revenue_stream <> all (array['Građevinske situacije', 'Zakup', 'Povraćaj PDV-a', 'Prihod od kamata', 'Krediti', 'Ostalo']);

alter table public.revenue_entries alter column brand drop not null;
comment on column public.revenue_entries.brand is 'Mintflow''s product brand. Not used by MCFlow; the project says whose income it is.';

alter table public.transactions add constraint transactions_revenue_stream_check
  check (revenue_stream is null or revenue_stream = any (array['Građevinske situacije'::text, 'Zakup'::text, 'Povraćaj PDV-a'::text, 'Prihod od kamata'::text, 'Krediti'::text, 'Ostalo'::text]));
alter table public.invoices add constraint invoices_revenue_stream_check
  check (revenue_stream is null or revenue_stream = any (array['Građevinske situacije'::text, 'Zakup'::text, 'Povraćaj PDV-a'::text, 'Prihod od kamata'::text, 'Krediti'::text, 'Ostalo'::text]));
alter table public.revenue_entries add constraint revenue_entries_revenue_stream_check
  check (revenue_stream = any (array['Građevinske situacije'::text, 'Zakup'::text, 'Povraćaj PDV-a'::text, 'Prihod od kamata'::text, 'Krediti'::text, 'Ostalo'::text]));


-- ── 6. Hours per project ───────────────────────────────────────────────────
-- Beside payroll_timesheets, not inside it: a timesheet is one row per
-- employee per month with the hour TYPES (regular, holiday, sick …); this is
-- how that month's worked hours fall over projects. Month is the first of the
-- month, as on payroll_timesheets. An employee's hours with no row here are
-- overhead.

create table public.payroll_timesheet_projects (
  id uuid default gen_random_uuid() not null primary key,
  company_id uuid not null references public.companies(id),
  employee_id uuid not null references public.employees(id) on delete cascade,
  month date not null,
  project_id uuid not null references public.projects(id) on delete restrict,
  hours numeric not null default 0,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint payroll_timesheet_projects_month_is_first_of_month
    check (month = (date_trunc('month', month::timestamp with time zone))::date),
  constraint payroll_timesheet_projects_hours_not_negative check (hours >= 0),
  constraint payroll_timesheet_projects_one_row unique (employee_id, month, project_id)
);

comment on table public.payroll_timesheet_projects is 'Hours an employee worked on each project in a month. Payroll cost is distributed over projects in proportion to these hours; hours on no project are overhead.';

create index payroll_timesheet_projects_month_idx on public.payroll_timesheet_projects (month);
create index payroll_timesheet_projects_project_idx on public.payroll_timesheet_projects (project_id);

-- Payroll is administrator / owner only, exactly as payroll_timesheets.
alter table public.payroll_timesheet_projects enable row level security;
create policy payroll_timesheet_projects_read on public.payroll_timesheet_projects for select
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text])));
create policy payroll_timesheet_projects_write on public.payroll_timesheet_projects
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text])))
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text])));

revoke all on table public.payroll_timesheet_projects from anon;
grant all on table public.payroll_timesheet_projects to authenticated;
grant all on table public.payroll_timesheet_projects to service_role;


-- ── 7. The views, back ─────────────────────────────────────────────────────

-- v_budget_vs_actual: matched on the project as well. A budget line with no
-- project is compared with actuals that have none. Like before, actuals are
-- posted expense transactions read whole (their split lines are not consulted).
CREATE VIEW public.v_budget_vs_actual WITH (security_invoker='on') AS
 SELECT be.company_id,
    be.budget_month,
    be.pl_category,
    be.pl_subcategory,
    be.department,
    be.dept_subcategory,
    be.expense_description,
    be.project_id,
    be.estimated_amount_rsd AS estimated_rsd,
    be.estimated_amount_eur AS estimated_eur,
    be.is_manual_override,
    COALESCE(act.actual_rsd, (0)::numeric) AS actual_rsd,
    COALESCE(act.actual_eur, (0)::numeric) AS actual_eur,
    (be.estimated_amount_rsd - COALESCE(act.actual_rsd, (0)::numeric)) AS variance_rsd,
    (be.estimated_amount_eur - COALESCE(act.actual_eur, (0)::numeric)) AS variance_eur
   FROM (public.budget_entries be
     LEFT JOIN ( SELECT transactions.company_id,
            date_trunc('month'::text, (transactions.transaction_date)::timestamp with time zone) AS month,
            transactions.pl_category,
            transactions.pl_subcategory,
            transactions.department,
            transactions.dept_subcategory,
            transactions.expense_description,
            transactions.project_id,
            sum(transactions.amount_rsd) AS actual_rsd,
            sum(transactions.amount_eur) AS actual_eur
           FROM public.transactions
          WHERE ((transactions.tx_subtype = 'expense'::text) AND (transactions.pl_impact = true) AND (transactions.status = 'posted'::text))
          GROUP BY transactions.company_id, (date_trunc('month'::text, (transactions.transaction_date)::timestamp with time zone)), transactions.pl_category, transactions.pl_subcategory, transactions.department, transactions.dept_subcategory, transactions.expense_description, transactions.project_id) act ON (((act.company_id = be.company_id) AND (act.month = be.budget_month) AND (COALESCE(act.pl_category, ''::text) = COALESCE(be.pl_category, ''::text)) AND (COALESCE(act.pl_subcategory, ''::text) = COALESCE(be.pl_subcategory, ''::text)) AND (COALESCE(act.department, ''::text) = COALESCE(be.department, ''::text)) AND (COALESCE(act.dept_subcategory, ''::text) = COALESCE(be.dept_subcategory, ''::text)) AND (COALESCE(act.expense_description, ''::text) = COALESCE(be.expense_description, ''::text)) AND (act.project_id IS NOT DISTINCT FROM be.project_id))));

REVOKE ALL ON TABLE public.v_budget_vs_actual FROM anon;
GRANT ALL ON TABLE public.v_budget_vs_actual TO authenticated;
GRANT ALL ON TABLE public.v_budget_vs_actual TO service_role;


-- v_invoice_status, as 20261008160000 left it (paid within one dinar), with
-- the allocation columns replaced by the project and its name.
CREATE VIEW public.v_invoice_status WITH (security_invoker='on') AS
 SELECT i.id,
    i.invoice_number,
    i.invoice_date,
    i.due_date,
    i.type,
    i.currency,
    i.amount,
    i.amount_rsd,
    i.amount_eur,
    i.status,
    i.partner_id,
    i.company_id,
    i.pl_category,
    i.pl_subcategory,
    i.department,
    i.dept_subcategory,
    i.expense_description,
    i.revenue_stream,
    i.project_id,
    pr.name AS project_name,
    i.cf_type,
    i.cf_frequency,
    i.cf_next_month_est,
    i.note,
    i.pl_impact,
    i.exchange_rate,
    i.eur_rate,
    i.parent_invoice_id,
    p.name AS partner_name,
    c.name AS company_name,
    COALESCE(sum(itl.allocated_amount_rsd), (0)::numeric) AS paid_amount_rsd,
    COALESCE(sum(itl.allocated_amount_eur), (0)::numeric) AS paid_amount_eur,
        CASE
            WHEN ((COALESCE(sum(itl.allocated_amount), (0)::numeric) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((1.00 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, (COALESCE(i.amount_rsd, (0)::numeric) - COALESCE(sum(itl.allocated_amount_rsd), (0)::numeric)))
        END AS remaining_rsd,
        CASE
            WHEN ((COALESCE(sum(itl.allocated_amount), (0)::numeric) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((1.00 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, (COALESCE(i.amount_eur, (0)::numeric) - COALESCE(sum(itl.allocated_amount_eur), (0)::numeric)))
        END AS remaining_eur,
        CASE
            WHEN (COALESCE(sum(itl.allocated_amount), (0)::numeric) <= (0)::numeric) THEN 'unpaid'::text
            WHEN (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((1.00 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2))) THEN 'paid'::text
            ELSE 'partial'::text
        END AS calculated_status,
    COALESCE(sum(itl.allocated_amount), (0)::numeric) AS paid_amount,
    i.reference_number,
    i.account_number
   FROM ((((public.invoices i
     LEFT JOIN public.partners p ON ((p.id = i.partner_id)))
     LEFT JOIN public.companies c ON ((c.id = i.company_id)))
     LEFT JOIN public.projects pr ON ((pr.id = i.project_id)))
     LEFT JOIN public.invoice_transaction_links itl ON ((itl.invoice_id = i.id)))
  WHERE (i.parent_invoice_id IS NULL)
  GROUP BY i.id, i.reference_number, i.account_number, i.invoice_number, i.invoice_date, i.due_date, i.type, i.currency, i.amount, i.amount_rsd, i.amount_eur, i.status, i.partner_id, i.company_id, i.pl_category, i.pl_subcategory, i.department, i.dept_subcategory, i.expense_description, i.revenue_stream, i.project_id, pr.name, i.cf_type, i.cf_frequency, i.cf_next_month_est, i.note, i.pl_impact, i.exchange_rate, i.eur_rate, i.parent_invoice_id, p.name, c.name;

REVOKE ALL ON TABLE public.v_invoice_status FROM anon;
GRANT ALL ON TABLE public.v_invoice_status TO authenticated;
GRANT ALL ON TABLE public.v_invoice_status TO service_role;


-- v_pl_entries. Four legs as before: whole transactions, transaction split
-- lines, whole expense invoices, invoice split lines. A whole row takes its
-- document's project; a split line takes its OWN project, so one bill shared
-- by two sites lands on both. `project_id` null is overhead. `tx_type`
-- ('expense' | 'revenue') is what tells revenue from cost.
CREATE VIEW public.v_pl_entries WITH (security_invoker='on') AS
 SELECT t.id,
    t.company_id,
    t.transaction_date AS pl_date,
    t.tx_subtype AS tx_type,
    t.amount_rsd,
    t.amount_eur,
    t.pl_category,
    t.pl_subcategory,
    t.department,
    t.dept_subcategory,
    t.expense_description,
    t.revenue_stream,
    t.project_id,
    pr.name AS project_name,
    t.partner_id,
    'transaction'::text AS source,
    t.cf_type,
    t.cf_frequency,
    t.amount,
    t.currency
   FROM (public.transactions t
     LEFT JOIN public.projects pr ON ((pr.id = t.project_id)))
  WHERE ((t.pl_impact = true) AND (t.deleted_at IS NULL) AND (t.tx_subtype = ANY (ARRAY['expense'::text, 'revenue'::text])) AND (NOT (EXISTS ( SELECT 1
           FROM public.pl_splits s
          WHERE ((s.source = 'transaction'::text) AND (s.source_id = t.id))))))
UNION ALL
 SELECT s.id,
    t.company_id,
    t.transaction_date AS pl_date,
    t.tx_subtype AS tx_type,
    s.amount_rsd,
    COALESCE(s.amount_eur,
        CASE
            WHEN (t.currency = 'EUR'::text) THEN s.amount
            ELSE round((s.amount_rsd / NULLIF(t.eur_rate, (0)::numeric)), 2)
        END) AS amount_eur,
    s.pl_category,
    s.pl_subcategory,
    s.department,
    s.dept_subcategory,
    s.expense_description,
    t.revenue_stream,
    s.project_id,
    pr.name AS project_name,
    t.partner_id,
    'transaction'::text AS source,
    COALESCE(s.cf_type, t.cf_type) AS cf_type,
    t.cf_frequency,
    s.amount,
    t.currency
   FROM ((public.pl_splits s
     JOIN public.transactions t ON ((t.id = s.source_id)))
     LEFT JOIN public.projects pr ON ((pr.id = s.project_id)))
  WHERE ((s.source = 'transaction'::text) AND (t.pl_impact = true) AND (t.deleted_at IS NULL) AND (t.tx_subtype = ANY (ARRAY['expense'::text, 'revenue'::text])))
UNION ALL
 SELECT i.id,
    i.company_id,
    i.invoice_date AS pl_date,
    i.type AS tx_type,
    i.amount_rsd,
    i.amount_eur,
    i.pl_category,
    i.pl_subcategory,
    i.department,
    i.dept_subcategory,
    i.expense_description,
    i.revenue_stream,
    i.project_id,
    pr.name AS project_name,
    i.partner_id,
    'invoice'::text AS source,
    i.cf_type,
    i.cf_frequency,
    i.amount,
    i.currency
   FROM (public.invoices i
     LEFT JOIN public.projects pr ON ((pr.id = i.project_id)))
  WHERE ((i.type = 'expense'::text) AND (i.pl_impact = true) AND (i.deleted_at IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.pl_splits s
          WHERE ((s.source = 'invoice'::text) AND (s.source_id = i.id))))))
UNION ALL
 SELECT s.id,
    i.company_id,
    i.invoice_date AS pl_date,
    i.type AS tx_type,
    s.amount_rsd,
    COALESCE(s.amount_eur,
        CASE
            WHEN (i.currency = 'EUR'::text) THEN s.amount
            ELSE round((s.amount_rsd / NULLIF(i.eur_rate, (0)::numeric)), 2)
        END) AS amount_eur,
    s.pl_category,
    s.pl_subcategory,
    s.department,
    s.dept_subcategory,
    s.expense_description,
    i.revenue_stream,
    s.project_id,
    pr.name AS project_name,
    i.partner_id,
    'invoice'::text AS source,
    COALESCE(s.cf_type, i.cf_type) AS cf_type,
    i.cf_frequency,
    s.amount,
    i.currency
   FROM ((public.pl_splits s
     JOIN public.invoices i ON ((i.id = s.source_id)))
     LEFT JOIN public.projects pr ON ((pr.id = s.project_id)))
  WHERE ((s.source = 'invoice'::text) AND (i.type = 'expense'::text) AND (i.pl_impact = true) AND (i.deleted_at IS NULL));

REVOKE ALL ON TABLE public.v_pl_entries FROM anon;
GRANT ALL ON TABLE public.v_pl_entries TO authenticated;
GRANT ALL ON TABLE public.v_pl_entries TO service_role;


-- v_revenue_entry_status, as 20261008150000 left it, plus the project.
CREATE VIEW public.v_revenue_entry_status WITH (security_invoker='on') AS
 SELECT e.id,
    e.company_id,
    e.brand,
    e.revenue_stream,
    e.project_id,
    e.period_month,
    e.source,
    e.currency,
    e.amount,
    e.amount_rsd,
    e.amount_eur,
    e.status,
    e.invoice_ref,
    e.notes,
    e.created_at,
    e.updated_at,
    COALESCE(sum(ec.allocated_amount_rsd), (0)::numeric) AS collected_rsd,
    COALESCE(sum(ec.allocated_amount_eur), (0)::numeric) AS collected_eur,
    (e.amount_rsd - COALESCE(sum(ec.allocated_amount_rsd), (0)::numeric)) AS remaining_rsd,
    (e.amount_eur - COALESCE(sum(ec.allocated_amount_eur), (0)::numeric)) AS remaining_eur,
        CASE
            WHEN (COALESCE(sum(ec.allocated_amount_rsd), (0)::numeric) = (0)::numeric) THEN 'open'::text
            WHEN (COALESCE(sum(ec.allocated_amount_rsd), (0)::numeric) >= e.amount_rsd) THEN 'collected'::text
            ELSE 'partial'::text
        END AS calculated_status
   FROM (public.revenue_entries e
     LEFT JOIN public.revenue_entry_collections ec ON ((ec.entry_id = e.id)))
  GROUP BY e.id;

REVOKE ALL ON TABLE public.v_revenue_entry_status FROM anon;
GRANT ALL ON TABLE public.v_revenue_entry_status TO authenticated;
GRANT ALL ON TABLE public.v_revenue_entry_status TO service_role;
