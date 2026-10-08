-- ============================================================================
-- Revenue on the accrual basis: progress billings, rent, advances, the plan
--
-- Mintflow took revenue from the bank: a Chargebee subscription was paid the
-- day it was earned, so a receipt WAS the revenue. A construction company
-- earns when it bills work performed — a progress billing ("situacija") to
-- the investor, or a month's rent to a tenant — and is paid 15 to 60 days
-- later. So revenue is now recognised when a REVENUE INVOICE is issued, on
-- the invoice date, on the invoice's project.
--
-- ── THE NO-DOUBLE-COUNT RULE ────────────────────────────────────────────────
--
-- One economic event reaches the P&L once: through the DOCUMENT or through the
-- PAYMENT, never both. This is how expense invoices have always worked, and
-- revenue now works the same way:
--
--   1. A payment that settles an invoice is a transaction of type
--      'invoice_payment' with pl_impact = false. Every entry path writes it
--      so: TransactionDialog, BankStatementDialog and BulkImport all set
--      `pl_impact: isDirectWithPL`, which is true only for type 'direct'.
--      v_pl_entries reads transactions with pl_impact = true only, so the
--      receipt is cash and nothing else. The invoice carries the P&L.
--
--   2. A DIRECT transaction later matched to an invoice gives up one of the
--      two: ReconcilePanel (and reconcile_direct_transaction) set the
--      invoice's pl_impact true and the transaction's false; InvoiceDialog,
--      entering an invoice against a direct transaction that already carries
--      the P&L, saves the invoice with pl_impact false. Either way exactly one
--      of the pair has pl_impact = true.
--
--   3. A currency difference (TransactionDialog / BankStatementDialog /
--      BulkImport `fxDifference`) is its own direct row with pl_impact true.
--      It is not a second copy of the invoice: it is the part of the RSD
--      figure the exchange rate moved, and it belongs in the P&L.
--
-- What changes here is only that the two invoice legs of v_pl_entries now
-- take `type IN ('expense', 'revenue')` instead of 'expense' alone. Rules 1–3
-- already hold for revenue invoices, so nothing else has to move. A direct
-- revenue transaction NOT tied to an invoice — interest received, a VAT
-- refund, a one-off — stays P&L revenue exactly as before.
--
-- Not done on purpose: excluding "a revenue transaction linked to a revenue
-- invoice" inside the view. Rule 3's currency gain IS linked to its invoice
-- and is legitimately in the P&L; a view-level filter would drop it. The
-- guarantee is the pl_impact pair, as it is for every expense bill.
--
-- ── ADVANCES (avans) ────────────────────────────────────────────────────────
--
-- An advance received from an investor is a liability, not revenue. It is a
-- transaction with `is_advance = true`: type 'direct', tx_subtype 'revenue',
-- pl_impact false, on a project. A boolean rather than a new `type` value,
-- because `type` is what a dozen places branch on — cashTimeline.cashMovement
-- (an allowlist: an unknown type moves no cash), statementEdit and
-- transactionMove (which types a row may become), the ledger filters, the
-- badges, every dialog's mode switch. A new type would fall out of all of
-- them; most dangerously out of the cash line, which must see the advance
-- arrive. As a flagged direct receipt it is cash in everywhere, and the CHECK
-- below keeps it out of the P&L whatever a dialog sends.
--
-- Each progress billing may deduct part of the advance: invoices get
-- `advance_deducted` (invoice currency) and its book figures at the invoice's
-- stored rates. The P&L takes the FULL invoice amount — the work performed —
-- and the investor owes `amount − advance_deducted`. v_invoice_status treats
-- the deducted part as already settled. Per project, v_project_advances says
-- what was received, deducted and what remains.
--
-- ── THE PLAN AND RENT ───────────────────────────────────────────────────────
--
--   revenue_plan    a manual monthly forecast of billings per project.
--   rental_leases   tenants of a rental building, with the monthly rent.
--   invoices.lease_id + service_month
--                   identify a rent invoice: one per lease per month.
--   projects.payment_days
--                   the investor's payment term; plan rows reach the cash
--                   forecast as inflows that many days after the month.
--
-- The forecast arithmetic (rent to the end of each lease, precedence between
-- plan, lease and issued invoices) is in src/services/revenuePlan.ts, pure
-- and tested. Nothing of it is stored.
--
-- ── WHAT GOES ───────────────────────────────────────────────────────────────
--
-- revenue_entries, revenue_collections, revenue_entry_collections and
-- v_revenue_entry_status — the Chargebee-shaped receivables model. Revenue
-- invoices and invoice_transaction_links now say everything they said (what
-- is expected, from whom, on which project, and what settled it). The only
-- reader was src/pages/Revenue.tsx, which is rebuilt on the new model. The
-- database holds no business data, so nothing is migrated across.
--
-- Order: views first, the dropped tables, the new columns and tables, then
-- the views back with their grants. No CASCADE: an unknown dependency fails
-- the migration instead of vanishing with it.
-- ============================================================================


-- ── 1. Views ───────────────────────────────────────────────────────────────
-- v_invoice_status and v_pl_entries are recreated with new columns and legs.
-- None of the three reads another. `delete_statement_cascade` reads
-- v_invoice_status.calculated_status (plpgsql, no recorded dependency); that
-- column keeps its name and meaning.

drop view if exists public.v_invoice_status;
drop view if exists public.v_pl_entries;
drop view if exists public.v_revenue_entry_status;


-- ── 2. The old receivables model ───────────────────────────────────────────
-- Children first. Their policies, keys, indexes and grants go with them; the
-- one trigger (revenue_collections_fill_gateway) went in 20261008130000.

drop table if exists public.revenue_entry_collections;
drop table if exists public.revenue_entries;
drop table if exists public.revenue_collections;


-- ── 3. projects.payment_days ───────────────────────────────────────────────

alter table public.projects
  add column payment_days integer not null default 45;
alter table public.projects
  add constraint projects_payment_days_check check (payment_days between 0 and 365);

comment on column public.projects.payment_days is 'The investor''s payment term in days. A planned billing (revenue_plan) reaches the cash forecast this many days after the end of its month.';


-- ── 4. Advances received ───────────────────────────────────────────────────
-- An advance is cash in and a liability: never P&L, always on a project. The
-- CHECK is the guarantee — a dialog that forgets to clear pl_impact is
-- refused, not silently booked as revenue.

alter table public.transactions
  add column is_advance boolean not null default false;
alter table public.transactions
  add constraint transactions_advance_shape check (
    not is_advance
    or (type = 'direct' and tx_subtype = 'revenue' and pl_impact = false and project_id is not null)
  );

create index transactions_advance_project_idx on public.transactions (project_id) where is_advance;

comment on column public.transactions.is_advance is 'An advance (avans) received from an investor: a liability, not revenue. Always a direct revenue receipt on a project with pl_impact false (transactions_advance_shape). Revenue invoices deduct it through invoices.advance_deducted; v_project_advances keeps the balance.';

-- An advance reaches an invoice through advance_deducted and only through
-- it. Allocated as well, through invoice_transaction_links, it would settle
-- the same billing twice: once as the deduction and once as a payment.
create function public.advance_is_not_an_invoice_payment() returns trigger
    language plpgsql
    set search_path to 'public'
    as $$
begin
  if exists (select 1 from public.transactions t where t.id = new.transaction_id and t.is_advance) then
    raise exception 'Transaction % is an advance; an invoice uses it through advance_deducted, not as a payment.', new.transaction_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger invoice_transaction_links_not_advance
  before insert or update of transaction_id on public.invoice_transaction_links
  for each row execute function public.advance_is_not_an_invoice_payment();

revoke all on function public.advance_is_not_an_invoice_payment() from anon, public;


-- ── 5. Advance deducted on a revenue invoice ───────────────────────────────
-- In the invoice's own currency, like `amount`, with its book figures at the
-- invoice's stored rates (bookAmounts.partBookAmounts in the app). A credit
-- note (negative amount) deducts nothing. A split revenue invoice has no
-- project of its own and so cannot deduct a project's advance.

alter table public.invoices
  add column advance_deducted numeric(18,2) not null default 0,
  add column advance_deducted_rsd numeric(18,2) not null default 0,
  add column advance_deducted_eur numeric(18,2) not null default 0;
alter table public.invoices
  add constraint invoices_advance_deducted_check check (
    advance_deducted = 0
    or (advance_deducted > 0 and advance_deducted <= amount
        and type = 'revenue' and project_id is not null)
  );
alter table public.invoices
  add constraint invoices_advance_deducted_book_check check (
    advance_deducted <> 0 or (advance_deducted_rsd = 0 and advance_deducted_eur = 0)
  );

comment on column public.invoices.advance_deducted is 'The part of the project''s advance this revenue invoice uses up, in the invoice''s currency. The P&L takes the whole `amount` (work performed); the investor owes amount − advance_deducted, and v_invoice_status counts the deduction as settled.';
comment on column public.invoices.advance_deducted_rsd is 'advance_deducted at the invoice''s exchange_rate.';
comment on column public.invoices.advance_deducted_eur is 'advance_deducted_rsd at the invoice''s eur_rate; exactly advance_deducted on a EUR invoice.';


-- ── 6. Rental leases ───────────────────────────────────────────────────────

create table public.rental_leases (
  id uuid default gen_random_uuid() not null primary key,
  company_id uuid not null references public.companies(id),
  project_id uuid not null references public.projects(id) on delete restrict,
  tenant_partner_id uuid not null references public.partners(id) on delete restrict,
  monthly_rent numeric(18,2) not null,
  currency text not null default 'RSD',
  start_date date not null,
  end_date date,
  invoice_day integer not null default 1,
  payment_days integer not null default 15,
  active boolean not null default true,
  note text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint rental_leases_monthly_rent_check check (monthly_rent > 0),
  constraint rental_leases_currency_check check (currency = any (array['RSD'::text, 'EUR'::text])),
  constraint rental_leases_dates_check check (end_date is null or end_date >= start_date),
  -- 28 at most, so every month has the day.
  constraint rental_leases_invoice_day_check check (invoice_day between 1 and 28),
  constraint rental_leases_payment_days_check check (payment_days between 0 and 365)
);

comment on table public.rental_leases is 'A tenant''s lease in a rental building (a project of kind ''rental''). The app proposes one rent invoice per lease per month (invoices.lease_id + service_month) and forecasts rent to end_date — open-ended leases to the forecast horizon.';
comment on column public.rental_leases.monthly_rent is 'Rent for a full month, in `currency`. A month the lease covers only in part is prorated by calendar days (revenuePlan.leaseMonthRent).';
comment on column public.rental_leases.invoice_day is 'Day of the service month the rent invoice is dated.';
comment on column public.rental_leases.payment_days is 'The tenant''s payment term: the rent invoice is due this many days after its date.';
comment on column public.rental_leases.active is 'An inactive lease proposes no invoices and forecasts no rent, whatever its dates say.';

create index rental_leases_project_idx on public.rental_leases (project_id);
create index rental_leases_tenant_idx on public.rental_leases (tenant_partner_id);

alter table public.rental_leases enable row level security;

-- As projects: read by anyone with access to the company; the bookkeeping
-- roles add and edit; only an administrator or owner deletes.
create policy rental_leases_select on public.rental_leases for select to authenticated
  using (public.has_company_access(company_id));
create policy rental_leases_insert on public.rental_leases for insert to authenticated
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
              and public.has_company_access(company_id));
create policy rental_leases_update on public.rental_leases for update to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
         and public.has_company_access(company_id))
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
              and public.has_company_access(company_id));
create policy rental_leases_delete on public.rental_leases for delete to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
         and public.has_company_access(company_id));

create trigger audit_rental_leases after insert or delete or update on public.rental_leases
  for each row execute function public.audit_trigger();

revoke all on table public.rental_leases from anon;
grant all on table public.rental_leases to authenticated;
grant all on table public.rental_leases to service_role;


-- A lease belongs to a rental building. Enforced in the database, on both
-- sides, because the app has two places that could break it — the lease
-- form and the project form (switching a building's kind) — and a site with
-- tenants would forecast rent nobody will bill. A CHECK cannot see another
-- table, so it is a trigger.

create function public.rental_lease_project_is_rental() returns trigger
    language plpgsql
    set search_path to 'public'
    as $$
begin
  if not exists (select 1 from public.projects p
                  where p.id = new.project_id and p.kind = 'rental') then
    raise exception 'A lease can only be on a rental project (kind ''rental''); project % is not one.', new.project_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger rental_leases_project_is_rental
  before insert or update of project_id on public.rental_leases
  for each row execute function public.rental_lease_project_is_rental();

create function public.project_with_leases_stays_rental() returns trigger
    language plpgsql
    set search_path to 'public'
    as $$
begin
  if new.kind <> 'rental' and exists (select 1 from public.rental_leases l where l.project_id = new.id) then
    raise exception 'Project % has leases and must stay a rental project.', new.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger projects_with_leases_stay_rental
  before update of kind on public.projects
  for each row execute function public.project_with_leases_stays_rental();

revoke all on function public.rental_lease_project_is_rental() from anon, public;
revoke all on function public.project_with_leases_stays_rental() from anon, public;


-- ── 7. Rent invoices ───────────────────────────────────────────────────────
-- A revenue invoice with a lease is that lease's rent for `service_month`.
-- One per lease per month among invoices that are not deleted: a deleted
-- rent invoice must not stop the month being billed again.

alter table public.invoices
  add column lease_id uuid references public.rental_leases(id) on delete restrict,
  add column service_month date;
alter table public.invoices
  add constraint invoices_service_month_is_first_of_month
    check (service_month is null or service_month = (date_trunc('month', service_month::timestamp with time zone))::date);
alter table public.invoices
  add constraint invoices_lease_is_rent
    check (lease_id is null or (type = 'revenue' and service_month is not null));

create unique index invoices_lease_month_key on public.invoices (lease_id, service_month)
  where lease_id is not null and deleted_at is null;

comment on column public.invoices.lease_id is 'Set on a rent invoice: the lease it bills. Null on every other invoice.';
comment on column public.invoices.service_month is 'The month a rent invoice bills (first of the month). With lease_id, unique among invoices not deleted.';

-- The rent is the building's: an invoice for a lease is on the lease's
-- project.
create function public.invoice_lease_matches_project() returns trigger
    language plpgsql
    set search_path to 'public'
    as $$
begin
  if new.lease_id is not null and not exists (
      select 1 from public.rental_leases l
       where l.id = new.lease_id and l.project_id is not distinct from new.project_id) then
    raise exception 'Invoice is for lease % but is not on that lease''s project.', new.lease_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger invoices_lease_matches_project
  before insert or update of lease_id, project_id on public.invoices
  for each row execute function public.invoice_lease_matches_project();

revoke all on function public.invoice_lease_matches_project() from anon, public;


-- ── 8. The revenue plan ────────────────────────────────────────────────────
-- What a project is expected to bill each month, typed by hand. Book figures
-- like every money row; for a month not yet come there is no rate of its
-- own, so the figures are at the latest NBS list on the day the amount is
-- entered (`planBookFigures` in the app) and `rate_date` says which. A plan is
-- an estimate: it is never revalued.

create table public.revenue_plan (
  id uuid default gen_random_uuid() not null primary key,
  company_id uuid not null references public.companies(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  month date not null,
  amount numeric(18,2) not null,
  currency text not null default 'RSD',
  eur_rate numeric(18,6),
  rate_date date,
  amount_rsd numeric(18,2),
  amount_eur numeric(18,2),
  note text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint revenue_plan_month_is_first_of_month
    check (month = (date_trunc('month', month::timestamp with time zone))::date),
  constraint revenue_plan_amount_check check (amount >= 0),
  constraint revenue_plan_currency_check check (currency = any (array['RSD'::text, 'EUR'::text])),
  constraint revenue_plan_one_row unique (project_id, month)
);

comment on table public.revenue_plan is 'Planned billings per project per month (manual forecast). On a rental project a row replaces the automatic rent forecast for that month. Issued revenue invoices of the same project and month reduce it (revenuePlan.plannedRevenueByMonth). Reaches the cash forecast at month end + projects.payment_days.';
comment on column public.revenue_plan.amount_rsd is 'amount in RSD at the latest NBS rate on the day it was entered (rate_date).';
comment on column public.revenue_plan.amount_eur is 'amount_rsd in EUR at the same rate; exactly `amount` on a EUR row.';
comment on column public.revenue_plan.rate_date is 'The NBS list the book figures were converted at — the day of entry, not the planned month.';

create index revenue_plan_month_idx on public.revenue_plan (month);

alter table public.revenue_plan enable row level security;

create policy revenue_plan_select on public.revenue_plan for select to authenticated
  using (public.has_company_access(company_id));
create policy revenue_plan_insert on public.revenue_plan for insert to authenticated
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
              and public.has_company_access(company_id));
create policy revenue_plan_update on public.revenue_plan for update to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
         and public.has_company_access(company_id))
  with check ((public.get_my_role() = any (array['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))
              and public.has_company_access(company_id));
create policy revenue_plan_delete on public.revenue_plan for delete to authenticated
  using ((public.get_my_role() = any (array['administrator'::text, 'owner'::text]))
         and public.has_company_access(company_id));

create trigger audit_revenue_plan after insert or delete or update on public.revenue_plan
  for each row execute function public.audit_trigger();

revoke all on table public.revenue_plan from anon;
grant all on table public.revenue_plan to authenticated;
grant all on table public.revenue_plan to service_role;


-- ── 9. The views, back ─────────────────────────────────────────────────────

-- v_invoice_status. Paid or partial is still decided in the invoice's own
-- currency with the one-dinar tolerance of 20261008160000, but on what is
-- SETTLED — allocations plus the advance deducted — rather than on the
-- allocations alone:
--
--   settled         sum(allocated_amount) + advance_deducted
--   remaining_*     amount_* − advance_deducted_* − sum(allocated_*), floored
--                   at 0, and 0 outright when settled is within tolerance
--   'unpaid'        nothing settled, or no money received yet (an advance
--                   deduction alone does not make a billing "partly paid" —
--                   the investor has not paid anything against it)
--   'paid'          settled is within the tolerance of `amount` — which
--                   includes an invoice the advance covers in full
--   'partial'       otherwise
--
-- settleInvoice.settledStatus / outstandingOwn hold the same rule.
-- New columns, at the end: the deduction, what is due from the investor
-- (amount − advance_deducted), and the rent invoice's lease and month.
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
            WHEN (((COALESCE(sum(itl.allocated_amount), (0)::numeric) + i.advance_deducted) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - (COALESCE(sum(itl.allocated_amount), (0)::numeric) + i.advance_deducted)), 2) <= GREATEST(0.01, round(((1.00 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, ((COALESCE(i.amount_rsd, (0)::numeric) - i.advance_deducted_rsd) - COALESCE(sum(itl.allocated_amount_rsd), (0)::numeric)))
        END AS remaining_rsd,
        CASE
            WHEN (((COALESCE(sum(itl.allocated_amount), (0)::numeric) + i.advance_deducted) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - (COALESCE(sum(itl.allocated_amount), (0)::numeric) + i.advance_deducted)), 2) <= GREATEST(0.01, round(((1.00 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, ((COALESCE(i.amount_eur, (0)::numeric) - i.advance_deducted_eur) - COALESCE(sum(itl.allocated_amount_eur), (0)::numeric)))
        END AS remaining_eur,
        CASE
            WHEN ((COALESCE(sum(itl.allocated_amount), (0)::numeric) + i.advance_deducted) <= (0)::numeric) THEN 'unpaid'::text
            WHEN (round((COALESCE(i.amount, (0)::numeric) - (COALESCE(sum(itl.allocated_amount), (0)::numeric) + i.advance_deducted)), 2) <= GREATEST(0.01, round(((1.00 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2))) THEN 'paid'::text
            WHEN (COALESCE(sum(itl.allocated_amount), (0)::numeric) <= (0)::numeric) THEN 'unpaid'::text
            ELSE 'partial'::text
        END AS calculated_status,
    COALESCE(sum(itl.allocated_amount), (0)::numeric) AS paid_amount,
    i.reference_number,
    i.account_number,
    i.advance_deducted,
    i.advance_deducted_rsd,
    i.advance_deducted_eur,
    (COALESCE(i.amount, (0)::numeric) - i.advance_deducted) AS amount_due,
    (COALESCE(i.amount_rsd, (0)::numeric) - i.advance_deducted_rsd) AS amount_due_rsd,
    (COALESCE(i.amount_eur, (0)::numeric) - i.advance_deducted_eur) AS amount_due_eur,
    i.lease_id,
    i.service_month
   FROM ((((public.invoices i
     LEFT JOIN public.partners p ON ((p.id = i.partner_id)))
     LEFT JOIN public.companies c ON ((c.id = i.company_id)))
     LEFT JOIN public.projects pr ON ((pr.id = i.project_id)))
     LEFT JOIN public.invoice_transaction_links itl ON ((itl.invoice_id = i.id)))
  WHERE (i.parent_invoice_id IS NULL)
  GROUP BY i.id, i.reference_number, i.account_number, i.invoice_number, i.invoice_date, i.due_date, i.type, i.currency, i.amount, i.amount_rsd, i.amount_eur, i.status, i.partner_id, i.company_id, i.pl_category, i.pl_subcategory, i.department, i.dept_subcategory, i.expense_description, i.revenue_stream, i.project_id, pr.name, i.cf_type, i.cf_frequency, i.cf_next_month_est, i.note, i.pl_impact, i.exchange_rate, i.eur_rate, i.parent_invoice_id, p.name, c.name, i.advance_deducted, i.advance_deducted_rsd, i.advance_deducted_eur, i.lease_id, i.service_month;

REVOKE ALL ON TABLE public.v_invoice_status FROM anon;
GRANT ALL ON TABLE public.v_invoice_status TO authenticated;
GRANT ALL ON TABLE public.v_invoice_status TO service_role;


-- v_pl_entries. The four legs of 20261008170000, with one change: the two
-- invoice legs take revenue invoices as well as expense invoices. Revenue is
-- recognised on the invoice date, on the invoice's project (or, when split,
-- on each split line's). The receipt that settles it is an 'invoice_payment'
-- with pl_impact false and never reaches the first two legs — see the rule
-- at the top of this file. An advance (is_advance) has pl_impact false by
-- CHECK and is not here either. The FULL invoice amount is revenue; an
-- advance deducted on it changes what the investor owes, not what was earned.
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
  WHERE ((i.type = ANY (ARRAY['expense'::text, 'revenue'::text])) AND (i.pl_impact = true) AND (i.deleted_at IS NULL) AND (NOT (EXISTS ( SELECT 1
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
  WHERE ((s.source = 'invoice'::text) AND (i.type = ANY (ARRAY['expense'::text, 'revenue'::text])) AND (i.pl_impact = true) AND (i.deleted_at IS NULL));

REVOKE ALL ON TABLE public.v_pl_entries FROM anon;
GRANT ALL ON TABLE public.v_pl_entries TO authenticated;
GRANT ALL ON TABLE public.v_pl_entries TO service_role;


-- v_project_advances. One row per project that has received or deducted an
-- advance. Book figures in RSD and EUR always; and, when every advance and
-- every deducting invoice of the project is in ONE currency, the same three
-- figures in that currency exactly (`currency` null and the own-currency
-- figures null when they are mixed). Read the own-currency remainder when
-- there is one: an EUR advance used up by EUR billings at different rates
-- leaves a few dinars of RSD remainder that is an exchange difference, not
-- advance. revenue.projectAdvanceBalance computes the same from rows, and is
-- what the invoice dialog checks a new deduction against.
--
-- A draft or deleted transaction is not an advance received; a deleted
-- invoice deducts nothing.
CREATE VIEW public.v_project_advances WITH (security_invoker='on') AS
 WITH moves AS (
         SELECT t.project_id,
            t.currency,
            t.amount AS received,
            (0)::numeric AS deducted,
            t.amount_rsd AS received_rsd,
            t.amount_eur AS received_eur,
            (0)::numeric AS deducted_rsd,
            (0)::numeric AS deducted_eur
           FROM public.transactions t
          WHERE (t.is_advance AND (t.deleted_at IS NULL) AND (t.status <> 'draft'::text))
        UNION ALL
         SELECT i.project_id,
            i.currency,
            (0)::numeric,
            i.advance_deducted,
            (0)::numeric,
            (0)::numeric,
            i.advance_deducted_rsd,
            i.advance_deducted_eur
           FROM public.invoices i
          WHERE ((i.advance_deducted > (0)::numeric) AND (i.deleted_at IS NULL))
        )
 SELECT pr.id AS project_id,
    pr.company_id,
    pr.name AS project_name,
        CASE WHEN (count(DISTINCT m.currency) = 1) THEN min(m.currency) ELSE NULL::text END AS currency,
        CASE WHEN (count(DISTINCT m.currency) = 1) THEN sum(m.received) ELSE NULL::numeric END AS received,
        CASE WHEN (count(DISTINCT m.currency) = 1) THEN sum(m.deducted) ELSE NULL::numeric END AS deducted,
        CASE WHEN (count(DISTINCT m.currency) = 1) THEN (sum(m.received) - sum(m.deducted)) ELSE NULL::numeric END AS remaining,
    COALESCE(sum(m.received_rsd), (0)::numeric) AS received_rsd,
    COALESCE(sum(m.received_eur), (0)::numeric) AS received_eur,
    sum(m.deducted_rsd) AS deducted_rsd,
    sum(m.deducted_eur) AS deducted_eur,
    (COALESCE(sum(m.received_rsd), (0)::numeric) - sum(m.deducted_rsd)) AS remaining_rsd,
    (COALESCE(sum(m.received_eur), (0)::numeric) - sum(m.deducted_eur)) AS remaining_eur
   FROM (moves m
     JOIN public.projects pr ON ((pr.id = m.project_id)))
  GROUP BY pr.id, pr.company_id, pr.name;

REVOKE ALL ON TABLE public.v_project_advances FROM anon;
GRANT ALL ON TABLE public.v_project_advances TO authenticated;
GRANT ALL ON TABLE public.v_project_advances TO service_role;
