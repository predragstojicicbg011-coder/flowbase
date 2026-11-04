-- Customer advances: the proforma, advance invoice, final invoice chain
-- opens to revenue, never across directions.
--
-- A customer pays ahead against our PROFORMA; we issue an ADVANCE INVOICE
-- (avansni račun) and later a FINAL INVOICE that the advance closes. The
-- machinery is the supplier one (20261021090000, 20261027090000); only the
-- direction rules change:
--   invoices_advance_shape   proforma and advance_invoice for expense AND
--                            revenue; never in the P&L (pl_impact false);
--   advance_coverage_rules   the proforma and the advance invoice have the
--                            same direction;
--   advance_usage_rules      the final invoice has the advance invoice's
--                            direction (company, partner, currency).
-- v_customer_advances is v_supplier_advances for revenue, per project.

begin;

create or replace function public.invoices_advance_shape()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.prior_period and new.document_type <> 'advance_invoice' then
    raise exception 'Samo avansni račun može biti iz ranijeg perioda.' using errcode = 'check_violation';
  end if;
  if new.document_type in ('proforma', 'advance_invoice') then
    -- Never in the P&L, whatever the caller sent.
    new.pl_impact := false;
    if new.type is null or new.type not in ('expense', 'revenue') then
      raise exception '% mora biti ulazni (od dobavljača) ili izlazni (kupcu).',
        case new.document_type when 'proforma' then 'Predračun' else 'Avansni račun' end using errcode = 'check_violation';
    end if;
    if coalesce(new.amount, 0) <= 0 then
      raise exception 'Iznos mora biti veći od 0.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;


create or replace function public.advance_coverage_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_av record; v_pf record; v_paid numeric; v_other numeric;
begin
  select * into v_av from public.invoices where id = new.advance_invoice_id for update;
  select * into v_pf from public.invoices where id = new.proforma_id for update;
  if v_av.id is null or v_av.deleted_at is not null or v_av.document_type <> 'advance_invoice' then
    raise exception 'Pokriće se upisuje samo na živ avansni račun.' using errcode = 'check_violation';
  end if;
  if v_av.prior_period then
    raise exception 'Avansni račun iz ranijeg perioda nema predračun.' using errcode = 'check_violation';
  end if;
  if v_pf.id is null or v_pf.deleted_at is not null or v_pf.document_type <> 'proforma' then
    raise exception 'Avansni račun se vezuje samo za predračun.' using errcode = 'check_violation';
  end if;
  if v_av.type is distinct from v_pf.type then
    raise exception 'Predračun % nije istog smera kao avansni račun.', v_pf.invoice_number using errcode = 'check_violation';
  end if;
  if v_av.company_id is distinct from v_pf.company_id or v_av.partner_id is distinct from v_pf.partner_id
     or v_av.currency is distinct from v_pf.currency then
    raise exception 'Predračun % nije istog %, firme i valute kao avansni račun.', v_pf.invoice_number,
      case v_av.type when 'revenue' then 'kupca' else 'dobavljača' end
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(l.allocated_amount), 0) into v_paid
    from public.invoice_transaction_links l where l.invoice_id = v_pf.id;
  select coalesce(sum(c.amount), 0) into v_other
    from public.advance_coverage c join public.invoices a on a.id = c.advance_invoice_id and a.deleted_at is null
   where c.proforma_id = v_pf.id and c.id <> new.id;
  if v_other + new.amount > v_paid + 0.005 then
    raise exception 'Po predračunu % je plaćeno %, a avansnim računima bi bilo pokriveno %.', v_pf.invoice_number, v_paid, v_other + new.amount
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(c.amount), 0) into v_other
    from public.advance_coverage c where c.advance_invoice_id = v_av.id and c.id <> new.id;
  if v_other + new.amount > coalesce(v_av.amount, 0) + 0.005 then
    raise exception 'Pokriće (%) je veće od avansnog računa % (%).', v_other + new.amount, v_av.invoice_number, v_av.amount
      using errcode = 'check_violation';
  end if;
  return new;
end $$;


create or replace function public.advance_usage_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fin record; v_av record; v_other numeric; v_notes numeric;
begin
  select * into v_fin from public.invoices where id = new.final_invoice_id for update;
  select * into v_av from public.invoices where id = new.advance_invoice_id for update;
  if v_fin.id is null or v_fin.deleted_at is not null or v_fin.document_type <> 'invoice' or v_fin.type is distinct from v_av.type then
    raise exception 'Avans koristi samo živ račun istog smera, firme, partnera i valute.' using errcode = 'check_violation';
  end if;
  if v_av.id is null or v_av.deleted_at is not null or v_av.document_type <> 'advance_invoice' then
    raise exception 'Konačni račun se zatvara avansnim računom.' using errcode = 'check_violation';
  end if;
  if v_fin.company_id is distinct from v_av.company_id or v_fin.partner_id is distinct from v_av.partner_id
     or v_fin.currency is distinct from v_av.currency then
    raise exception 'Avansni račun % nije istog %, firme i valute kao konačni račun.', v_av.invoice_number,
      case v_av.type when 'revenue' then 'kupca' else 'dobavljača' end
      using errcode = 'check_violation';
  end if;
  if coalesce(v_fin.advance_deducted, 0) > 0 then
    raise exception 'Račun % već ima odbijen avans po projektu (stari način); avansni račun se na njega ne vezuje.', v_fin.invoice_number
      using errcode = 'check_violation';
  end if;
  select coalesce(sum(u.amount), 0) into v_other
    from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
   where u.advance_invoice_id = v_av.id and u.id <> new.id;
  if v_other + new.amount > coalesce(v_av.amount, 0) + 0.005 then
    raise exception 'Od avansnog računa % (%) je ostalo %, a traži se %.', v_av.invoice_number, v_av.amount,
      coalesce(v_av.amount, 0) - v_other, new.amount using errcode = 'check_violation';
  end if;
  select coalesce(sum(a.amount), 0) into v_notes
    from public.invoices a where a.adjusts_invoice_id = v_fin.id and a.deleted_at is null and a.document_type = 'credit_note';
  select coalesce(sum(u.amount), 0) into v_other
    from public.advance_usage u where u.final_invoice_id = v_fin.id and u.id <> new.id;
  if v_other + new.amount > coalesce(v_fin.amount, 0) + v_notes + 0.005 then
    raise exception 'Iskorišćeni avans (%) je veći od konačnog računa % (%).', v_other + new.amount, v_fin.invoice_number,
      coalesce(v_fin.amount, 0) + v_notes using errcode = 'check_violation';
  end if;
  -- The final invoice's book figures, so a bill closed by an advance closes to the dinar.
  new.amount_rsd := case when coalesce(v_fin.amount, 0) <> 0 and v_fin.amount_rsd is not null
                         then round(new.amount * v_fin.amount_rsd / v_fin.amount, 2) end;
  new.amount_eur := case when coalesce(v_fin.amount, 0) <> 0 and v_fin.amount_eur is not null
                         then round(new.amount * v_fin.amount_eur / v_fin.amount, 2) end;
  return new;
end $$;

-- ── The old project advance and the advance chain never meet on one invoice ──

create or replace function public.invoices_project_or_chain_advance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if coalesce(new.advance_deducted, 0) > 0
     and exists (select 1 from public.advance_usage u where u.final_invoice_id = new.id) then
    raise exception 'Račun % već koristi avansni račun; avans po projektu se na njega ne odbija.', new.invoice_number
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists invoices_project_or_chain_advance on public.invoices;
create trigger invoices_project_or_chain_advance
  before insert or update of advance_deducted on public.invoices
  for each row execute function public.invoices_project_or_chain_advance();

revoke all on function public.invoices_project_or_chain_advance() from public, anon, authenticated;

-- ── v_customer_advances: the chain per customer and project ────────────────
create or replace view public.v_customer_advances with (security_invoker = 'on') as
 with docs as (
   select i.company_id, i.partner_id, i.project_id, i.currency, i.document_type, i.id, i.amount
     from public.invoices i
    where i.deleted_at is null and i.document_type in ('proforma', 'advance_invoice') and i.type = 'revenue'
 ), sums as (
   select d.company_id, d.partner_id, d.project_id, d.currency,
          coalesce(sum((select coalesce(sum(l.allocated_amount), 0) from public.invoice_transaction_links l where l.invoice_id = d.id))
                   filter (where d.document_type = 'proforma'), 0) as received_on_proformas,
          coalesce(sum((select coalesce(sum(cv.amount), 0) from public.advance_coverage cv where cv.advance_invoice_id = d.id))
                   filter (where d.document_type = 'advance_invoice'), 0) as covered,
          coalesce(sum(d.amount) filter (where d.document_type = 'advance_invoice'), 0) as advance_total,
          coalesce(sum((select coalesce(sum(u.amount), 0) from public.advance_usage u
                          join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
                         where u.advance_invoice_id = d.id))
                   filter (where d.document_type = 'advance_invoice'), 0) as used
     from docs d
    group by d.company_id, d.partner_id, d.project_id, d.currency
 )
 select s.company_id, s.partner_id, p.name as partner_name, s.project_id, pr.name as project_name, s.currency,
        s.received_on_proformas, s.covered, s.advance_total, s.used,
        s.received_on_proformas - s.covered as received_without_advance,
        s.advance_total - s.used as advance_open
   from sums s
   left join public.partners p on p.id = s.partner_id
   left join public.projects pr on pr.id = s.project_id;

revoke all on public.v_customer_advances from anon;
grant select on public.v_customer_advances to authenticated, service_role;

commit;
