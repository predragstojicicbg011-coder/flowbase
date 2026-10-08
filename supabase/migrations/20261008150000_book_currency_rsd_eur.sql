-- ============================================================================
-- Book currency: RSD, with EUR beside it
--
-- Mintflow booked every money row in USD. MCFlow keeps its books in dinars —
-- the functional currency of a Serbian company — and carries euros next to
-- them, because that is how contracts, loans and management read figures.
--
-- Every money row now means:
--
--   amount         the document's own figure, in `currency`
--   currency       RSD, EUR or USD — the currency the document or payment is in
--   exchange_rate  RSD per 1 unit of `currency` (NBS middle rate on the
--                  document date). RSD is 1.
--   eur_rate       RSD per 1 EUR on that same date
--   amount_rsd     round(amount * exchange_rate, 2) — the book figure
--   amount_eur     round(amount_rsd / eur_rate, 2) — and for a EUR document,
--                  exactly `amount`, so no cent drifts in the round trip
--
-- The app computes these in `src/services/bookAmounts.ts`; this file only
-- shapes the tables. The database holds no business data yet, so nothing is
-- backfilled — every `*_usd` column is renamed, not converted.
--
-- Order: the views that read the renamed columns go first, the tables change,
-- the views come back with their grants, then the one function that wrote a
-- `*_usd` column is replaced. No CASCADE: an unknown dependency fails the
-- migration instead of vanishing.
-- ============================================================================


-- ── 1. Views over the columns about to be renamed ──────────────────────────
-- None of them reads another, so the order among them does not matter.
-- `delete_statement_cascade` reads `v_invoice_status.calculated_status`
-- (plpgsql, so no recorded dependency); that column keeps its name.

drop view if exists public.v_budget_vs_actual;
drop view if exists public.v_cash_position_latest;
drop view if exists public.v_invoice_status;
drop view if exists public.v_pl_entries;
drop view if exists public.v_revenue_entry_status;


-- ── 2. Ledger documents: invoices, transactions, pass-throughs ─────────────

alter table public.invoices rename column amount_usd to amount_rsd;
alter table public.invoices
  add column eur_rate numeric(18,6),
  add column amount_eur numeric(18,2);

alter table public.transactions rename column amount_usd to amount_rsd;
alter table public.transactions
  add column eur_rate numeric(18,6),
  add column amount_eur numeric(18,2);

alter table public.passthrough rename column amount_usd to amount_rsd;
alter table public.passthrough
  add column eur_rate numeric(18,6),
  add column amount_eur numeric(18,2);

comment on column public.invoices.exchange_rate is 'RSD per 1 unit of `currency`, NBS middle rate on the invoice date. 1 for RSD.';
comment on column public.invoices.eur_rate is 'RSD per 1 EUR on the same date. Equal to exchange_rate on a EUR invoice.';
comment on column public.invoices.amount_rsd is 'Book amount: round(amount * exchange_rate, 2).';
comment on column public.invoices.amount_eur is 'round(amount_rsd / eur_rate, 2); exactly `amount` on a EUR invoice.';

comment on column public.transactions.exchange_rate is 'RSD per 1 unit of `currency`, NBS middle rate on the transaction date. 1 for RSD.';
comment on column public.transactions.eur_rate is 'RSD per 1 EUR on the same date. Equal to exchange_rate on a EUR transaction.';
comment on column public.transactions.amount_rsd is 'Book amount: round(amount * exchange_rate, 2).';
comment on column public.transactions.amount_eur is 'round(amount_rsd / eur_rate, 2); exactly `amount` on a EUR transaction.';

comment on column public.passthrough.exchange_rate is 'RSD per 1 unit of `currency`, NBS middle rate on the transaction date. 1 for RSD.';
comment on column public.passthrough.eur_rate is 'RSD per 1 EUR on the same date.';
comment on column public.passthrough.amount_rsd is 'Book amount: round(amount * exchange_rate, 2).';
comment on column public.passthrough.amount_eur is 'round(amount_rsd / eur_rate, 2); exactly `amount` in EUR.';


-- ── 3. Parts of a document: allocations and P&L splits ─────────────────────
-- A part carries no rate of its own; it is converted at its parent's
-- exchange_rate and eur_rate (`partBookAmounts` in the app).

alter table public.invoice_transaction_links
  rename column allocated_amount_usd to allocated_amount_rsd;
alter table public.invoice_transaction_links
  add column allocated_amount_eur numeric(18,2);

comment on column public.invoice_transaction_links.allocated_amount is 'The part of the invoice this payment settles, in the INVOICE''s currency. v_invoice_status decides paid or partial on this column.';
comment on column public.invoice_transaction_links.allocated_amount_rsd is 'allocated_amount in RSD, at the invoice''s exchange_rate.';
comment on column public.invoice_transaction_links.allocated_amount_eur is 'allocated_amount_rsd in EUR, at the invoice''s eur_rate; exactly allocated_amount on a EUR invoice.';

alter table public.pl_splits rename column amount_usd to amount_rsd;
alter table public.pl_splits add column amount_eur numeric(18,2);

comment on column public.pl_splits.amount is 'In the parent document''s currency.';
comment on column public.pl_splits.amount_rsd is 'amount at the parent''s exchange_rate.';
comment on column public.pl_splits.amount_eur is 'amount_rsd at the parent''s eur_rate; exactly `amount` when the parent is in EUR. v_pl_entries derives it from the parent when null.';


-- ── 4. Payroll ─────────────────────────────────────────────────────────────
-- Payroll is calculated in RSD. `payroll_runs.exchange_rate` stays what it
-- was: the RSD/EUR rate euro-denominated contract terms are converted at.
-- `usd_rate` existed only to book the run in dollars; it is replaced by the
-- EUR rate the posted rows carry as `eur_rate`.

alter table public.payroll_runs drop column usd_rate;
alter table public.payroll_runs add column eur_rate numeric;

comment on column public.payroll_runs.exchange_rate is 'RSD per 1 EUR at which euro-denominated contract terms are converted to RSD for this run.';
comment on column public.payroll_runs.eur_rate is 'RSD per 1 EUR the posted invoices and transactions carry as eur_rate, for amount_eur. Normally the same NBS rate as exchange_rate.';

alter table public.payroll_postings add column eur_rate numeric;

comment on column public.payroll_postings.exchange_rate is 'RSD per 1 unit of the posted currency (1 for RSD payroll).';
comment on column public.payroll_postings.eur_rate is 'RSD per 1 EUR on the posting date.';

alter table public.payroll_records rename column amount_usd to amount_rsd;
alter table public.payroll_records
  add column eur_rate numeric,
  add column amount_eur numeric;

comment on column public.payroll_records.exchange_rate is 'RSD per 1 unit of `currency`. 1 for RSD.';
comment on column public.payroll_records.eur_rate is 'RSD per 1 EUR on the payment date.';
comment on column public.payroll_records.amount_rsd is 'Book amount: round(amount * exchange_rate, 2).';
comment on column public.payroll_records.amount_eur is 'round(amount_rsd / eur_rate, 2).';


-- ── 5. Revenue ─────────────────────────────────────────────────────────────
-- `revenue_entries` had no rate at all; it gets both, so an entry can be
-- converted the same way as every other money row.

alter table public.revenue_entries alter column currency set default 'RSD';
alter table public.revenue_entries rename column amount_usd to amount_rsd;
alter table public.revenue_entries
  add column exchange_rate numeric,
  add column eur_rate numeric,
  add column amount_eur numeric;

comment on column public.revenue_entries.exchange_rate is 'RSD per 1 unit of `currency`. 1 for RSD.';
comment on column public.revenue_entries.eur_rate is 'RSD per 1 EUR on the same date.';
comment on column public.revenue_entries.amount_rsd is 'Book amount: round(amount * exchange_rate, 2).';
comment on column public.revenue_entries.amount_eur is 'round(amount_rsd / eur_rate, 2); exactly `amount` in EUR.';

alter table public.revenue_collections alter column currency set default 'RSD';
alter table public.revenue_collections rename column amount_usd to amount_rsd;
alter table public.revenue_collections
  add column eur_rate numeric,
  add column amount_eur numeric;

comment on column public.revenue_collections.exchange_rate is 'RSD per 1 unit of `currency`. 1 for RSD.';
comment on column public.revenue_collections.eur_rate is 'RSD per 1 EUR on the transaction date.';
comment on column public.revenue_collections.amount_rsd is 'Book amount: round(amount * exchange_rate, 2).';
comment on column public.revenue_collections.amount_eur is 'round(amount_rsd / eur_rate, 2); exactly `amount` in EUR.';

alter table public.revenue_entry_collections
  rename column allocated_amount_usd to allocated_amount_rsd;
alter table public.revenue_entry_collections
  add column allocated_amount_eur numeric;

comment on column public.revenue_entry_collections.allocated_amount_rsd is 'The part of the entry this collection covers, in RSD.';
comment on column public.revenue_entry_collections.allocated_amount_eur is 'The same part in EUR, at the collection''s eur_rate.';


-- ── 6. Budgets and the cash position ───────────────────────────────────────
-- Budgets are planned in RSD. Their EUR figure is optional: the page may
-- work it out at display time from a planning rate, so it stays nullable.

alter table public.budget_entries
  rename column estimated_amount_usd to estimated_amount_rsd;
alter table public.budget_entries add column estimated_amount_eur numeric;

alter table public.budget_adjustments rename column amount_usd to amount_rsd;
alter table public.budget_adjustments rename column seed_usd to seed_rsd;
alter table public.budget_adjustments
  add column amount_eur numeric,
  add column seed_eur numeric;

comment on column public.budget_adjustments.seed_rsd is 'In RSD. The seed this entry''s node carried, in this month, when the figure was typed. applyLedger replays the deltas on the most recent recorded seed, so a typed figure does not move when the benchmark month rolls over. Null on entries written before this existed; those keep the old behaviour until re-recorded.';

alter table public.cash_positions rename column amount_usd to amount_rsd;
alter table public.cash_positions
  rename constraint cash_positions_amount_usd_check to cash_positions_amount_rsd_check;
alter table public.cash_positions add column amount_eur numeric(14,2);
alter table public.cash_positions
  add constraint cash_positions_amount_eur_check
  check (amount_eur is null or amount_eur >= 0);


-- ── 7. Stored rates ────────────────────────────────────────────────────────

alter table public.exchange_rates alter column to_currency set default 'RSD';
comment on column public.exchange_rates.rate is 'Units of to_currency (RSD) per 1 unit of from_currency.';


-- ── 8. The views, back ─────────────────────────────────────────────────────

-- v_budget_vs_actual: the baseline had no security_invoker, so the view ran
-- as its owner, past RLS, and anon could read it with the public key. It now
-- runs as the caller, and like every view here it is closed to anon.
CREATE VIEW public.v_budget_vs_actual WITH (security_invoker='on') AS
 SELECT be.company_id,
    be.budget_month,
    be.pl_category,
    be.pl_subcategory,
    be.department,
    be.dept_subcategory,
    be.expense_description,
    be.rev_alloc_type,
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
            transactions.rev_alloc_type,
            sum(transactions.amount_rsd) AS actual_rsd,
            sum(transactions.amount_eur) AS actual_eur
           FROM public.transactions
          WHERE ((transactions.tx_subtype = 'expense'::text) AND (transactions.pl_impact = true) AND (transactions.status = 'posted'::text))
          GROUP BY transactions.company_id, (date_trunc('month'::text, (transactions.transaction_date)::timestamp with time zone)), transactions.pl_category, transactions.pl_subcategory, transactions.department, transactions.dept_subcategory, transactions.expense_description, transactions.rev_alloc_type) act ON (((act.company_id = be.company_id) AND (act.month = be.budget_month) AND (COALESCE(act.pl_category, ''::text) = COALESCE(be.pl_category, ''::text)) AND (COALESCE(act.pl_subcategory, ''::text) = COALESCE(be.pl_subcategory, ''::text)) AND (COALESCE(act.department, ''::text) = COALESCE(be.department, ''::text)) AND (COALESCE(act.dept_subcategory, ''::text) = COALESCE(be.dept_subcategory, ''::text)) AND (COALESCE(act.expense_description, ''::text) = COALESCE(be.expense_description, ''::text)))));

REVOKE ALL ON TABLE public.v_budget_vs_actual FROM anon;
GRANT ALL ON TABLE public.v_budget_vs_actual TO authenticated;
GRANT ALL ON TABLE public.v_budget_vs_actual TO service_role;


CREATE VIEW public.v_cash_position_latest WITH (security_invoker='on') AS
 SELECT id,
    as_of,
    amount_rsd,
    amount_eur,
    note,
    created_at
   FROM public.cash_positions
  ORDER BY as_of DESC, created_at DESC
 LIMIT 1;

REVOKE ALL ON TABLE public.v_cash_position_latest FROM anon;
GRANT ALL ON TABLE public.v_cash_position_latest TO authenticated;
GRANT ALL ON TABLE public.v_cash_position_latest TO service_role;


-- v_invoice_status. Paid or partial is still decided in the invoice's own
-- currency, on `allocated_amount`. The tolerance was "one cent of the
-- reporting currency, expressed in the invoice's currency"
-- (0.01 * amount / amount_usd); it is now one para (0.01 RSD) expressed the
-- same way, never less than 0.01 of the invoice's currency.
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
    i.rev_alloc_type,
    i.rev_alloc_sg,
    i.rev_alloc_aimfox,
    i.opex_type,
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
            WHEN ((COALESCE(sum(itl.allocated_amount), (0)::numeric) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((0.01 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, (COALESCE(i.amount_rsd, (0)::numeric) - COALESCE(sum(itl.allocated_amount_rsd), (0)::numeric)))
        END AS remaining_rsd,
        CASE
            WHEN ((COALESCE(sum(itl.allocated_amount), (0)::numeric) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((0.01 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, (COALESCE(i.amount_eur, (0)::numeric) - COALESCE(sum(itl.allocated_amount_eur), (0)::numeric)))
        END AS remaining_eur,
        CASE
            WHEN (COALESCE(sum(itl.allocated_amount), (0)::numeric) <= (0)::numeric) THEN 'unpaid'::text
            WHEN (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((0.01 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_rsd, (0)::numeric)), 2))) THEN 'paid'::text
            ELSE 'partial'::text
        END AS calculated_status,
    COALESCE(sum(itl.allocated_amount), (0)::numeric) AS paid_amount,
    i.reference_number,
    i.account_number
   FROM (((public.invoices i
     LEFT JOIN public.partners p ON ((p.id = i.partner_id)))
     LEFT JOIN public.companies c ON ((c.id = i.company_id)))
     LEFT JOIN public.invoice_transaction_links itl ON ((itl.invoice_id = i.id)))
  WHERE (i.parent_invoice_id IS NULL)
  GROUP BY i.id, i.reference_number, i.account_number, i.invoice_number, i.invoice_date, i.due_date, i.type, i.currency, i.amount, i.amount_rsd, i.amount_eur, i.status, i.partner_id, i.company_id, i.pl_category, i.pl_subcategory, i.department, i.dept_subcategory, i.expense_description, i.revenue_stream, i.rev_alloc_type, i.rev_alloc_sg, i.rev_alloc_aimfox, i.opex_type, i.cf_type, i.cf_frequency, i.cf_next_month_est, i.note, i.pl_impact, i.exchange_rate, i.eur_rate, i.parent_invoice_id, p.name, c.name;

-- The baseline grants this view to authenticated and service_role only.
-- Supabase's default privileges would hand it to anon as well on creation.
REVOKE ALL ON TABLE public.v_invoice_status FROM anon;
GRANT ALL ON TABLE public.v_invoice_status TO authenticated;
GRANT ALL ON TABLE public.v_invoice_status TO service_role;


-- v_pl_entries. A split leg takes its EUR from the split row when the app
-- wrote it, and otherwise from the parent's eur_rate — exactly the split's
-- own amount when the parent is in EUR — so the four legs always agree.
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
    t.rev_alloc_type,
    t.rev_alloc_aimfox,
    t.rev_alloc_sg,
    t.opex_type,
    t.opex_amount,
    t.performance_amount,
    t.partner_id,
    'transaction'::text AS source,
    t.cf_type,
    t.cf_frequency,
    t.amount,
    t.currency
   FROM public.transactions t
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
    s.rev_alloc_type,
    t.rev_alloc_aimfox,
    t.rev_alloc_sg,
    s.opex_type,
    t.opex_amount,
    t.performance_amount,
    t.partner_id,
    'transaction'::text AS source,
    COALESCE(s.cf_type, t.cf_type) AS cf_type,
    t.cf_frequency,
    s.amount,
    t.currency
   FROM (public.pl_splits s
     JOIN public.transactions t ON ((t.id = s.source_id)))
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
    i.rev_alloc_type,
    i.rev_alloc_aimfox,
    i.rev_alloc_sg,
    i.opex_type,
    i.opex_amount,
    i.performance_amount,
    i.partner_id,
    'invoice'::text AS source,
    i.cf_type,
    i.cf_frequency,
    i.amount,
    i.currency
   FROM public.invoices i
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
    s.rev_alloc_type,
    i.rev_alloc_aimfox,
    i.rev_alloc_sg,
    s.opex_type,
    i.opex_amount,
    i.performance_amount,
    i.partner_id,
    'invoice'::text AS source,
    COALESCE(s.cf_type, i.cf_type) AS cf_type,
    i.cf_frequency,
    s.amount,
    i.currency
   FROM (public.pl_splits s
     JOIN public.invoices i ON ((i.id = s.source_id)))
  WHERE ((s.source = 'invoice'::text) AND (i.type = 'expense'::text) AND (i.pl_impact = true) AND (i.deleted_at IS NULL));

-- As with v_invoice_status: authenticated and service_role only.
REVOKE ALL ON TABLE public.v_pl_entries FROM anon;
GRANT ALL ON TABLE public.v_pl_entries TO authenticated;
GRANT ALL ON TABLE public.v_pl_entries TO service_role;


-- v_revenue_entry_status, from the baseline's final definition (the one
-- that replaced the placeholder). Collected or not is decided in RSD.
CREATE VIEW public.v_revenue_entry_status WITH (security_invoker='on') AS
 SELECT e.id,
    e.company_id,
    e.brand,
    e.revenue_stream,
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


-- ── 9. reconcile_direct_transaction ────────────────────────────────────────
-- The old version wrote its one argument, a USD figure, into BOTH
-- `allocated_amount` and `allocated_amount_usd`. `allocated_amount` is in the
-- invoice's own currency and is what v_invoice_status decides paid or partial
-- on, so a dinar invoice settled this way was compared against a dollar
-- figure ~100 times too small and stayed `partial` forever. Its ON CONFLICT
-- branch also refreshed only the USD column, leaving the two out of step.
--
-- The argument is now the RSD book figure, and the invoice-currency part is
-- derived from it at the invoice's own rate, as is the EUR part. Both
-- branches write all three. An invoice in a foreign currency without a rate
-- is refused rather than guessed at.

DROP FUNCTION public.reconcile_direct_transaction(uuid, uuid, numeric);

CREATE FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_rsd numeric) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_currency text;
  v_rate     numeric;
  v_eur_rate numeric;
  v_own      numeric;
  v_eur      numeric;
BEGIN
  SELECT currency,
         CASE WHEN currency = 'RSD' THEN 1 ELSE exchange_rate END,
         eur_rate
    INTO v_currency, v_rate, v_eur_rate
    FROM invoices
   WHERE id = p_invoice_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No invoice with id %', p_invoice_id USING errcode = 'no_data_found';
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'Invoice % is in % and has no exchange_rate to convert % RSD at',
      p_invoice_id, v_currency, p_allocated_rsd USING errcode = 'check_violation';
  END IF;

  -- In the invoice's currency: what v_invoice_status settles on.
  v_own := round(p_allocated_rsd / v_rate, 2);
  -- In EUR: exactly the invoice-currency part on a EUR invoice.
  v_eur := CASE
             WHEN v_currency = 'EUR' THEN v_own
             WHEN v_eur_rate > 0 THEN round(p_allocated_rsd / v_eur_rate, 2)
             ELSE NULL
           END;

  -- Kreiraj link
  INSERT INTO invoice_transaction_links
    (invoice_id, transaction_id, allocated_amount, allocated_amount_rsd, allocated_amount_eur)
  SELECT
    p_invoice_id,
    p_transaction_id,
    v_own,
    p_allocated_rsd,
    v_eur
  ON CONFLICT (invoice_id, transaction_id) DO UPDATE
    SET allocated_amount     = EXCLUDED.allocated_amount,
        allocated_amount_rsd = EXCLUDED.allocated_amount_rsd,
        allocated_amount_eur = EXCLUDED.allocated_amount_eur;

  -- Invoice preuzima P&L
  UPDATE invoices
  SET pl_impact = true
  WHERE id = p_invoice_id;

  -- Direct tx gubi P&L uticaj
  UPDATE transactions
  SET
    pl_impact = false,
    status = 'reconciled'
  WHERE id = p_transaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_rsd numeric) FROM anon, public;
GRANT ALL ON FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_rsd numeric) TO authenticated;
GRANT ALL ON FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_rsd numeric) TO service_role;
