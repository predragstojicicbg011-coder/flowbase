-- An invoice counts as paid when what is still open is at most one dinar,
-- expressed in the invoice's own currency (1.00 * amount / amount_rsd), and
-- never less than 0.01 of that currency. On a dinar bill that is 1.00 RSD,
-- on a euro bill 0.01 EUR. The book currency migration had cut it to one
-- para, which left a bill paid 60 para short of its total "partial" for
-- good; bank rounding and fees make differences that small every day.
--
-- settleInvoice.toleranceFor holds the same rule, and the two must agree.

CREATE OR REPLACE VIEW public.v_invoice_status WITH (security_invoker='on') AS
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
   FROM (((public.invoices i
     LEFT JOIN public.partners p ON ((p.id = i.partner_id)))
     LEFT JOIN public.companies c ON ((c.id = i.company_id)))
     LEFT JOIN public.invoice_transaction_links itl ON ((itl.invoice_id = i.id)))
  WHERE (i.parent_invoice_id IS NULL)
  GROUP BY i.id, i.reference_number, i.account_number, i.invoice_number, i.invoice_date, i.due_date, i.type, i.currency, i.amount, i.amount_rsd, i.amount_eur, i.status, i.partner_id, i.company_id, i.pl_category, i.pl_subcategory, i.department, i.dept_subcategory, i.expense_description, i.revenue_stream, i.rev_alloc_type, i.rev_alloc_sg, i.rev_alloc_aimfox, i.opex_type, i.cf_type, i.cf_frequency, i.cf_next_month_est, i.note, i.pl_impact, i.exchange_rate, i.eur_rate, i.parent_invoice_id, p.name, c.name;
