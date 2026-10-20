-- Supplier advances: proforma, advance invoice, final invoice.
--
-- Spec: docs/superpowers/specs/2026-10-20-avansi-dobavljacima-design.md.
--
-- A supplier is often paid ahead, against a PROFORMA (predračun). After the
-- payment it issues an ADVANCE INVOICE (avansni račun, SEF type 386), and on
-- delivery a FINAL INVOICE (konačni račun) that the advance closes in full or
-- in part. Two new document types and two link tables carry it:
--
--   'proforma'         paid like a bill (invoice_transaction_links), never in
--                      the P&L;
--   'advance_invoice'  never paid, never in the P&L; covered by paid proformas
--                      (advance_coverage) and used by final invoices
--                      (advance_usage). prior_period = true marks one paid
--                      before the books, with no proforma;
--   final invoice      an ordinary 'invoice' with advance_usage rows; its full
--                      amount is the cost, the advance settles part of what
--                      is owed, like a credit note does.
--
-- RULES
--   advance_coverage   an advance invoice is covered only by live proformas of
--                      the same company, supplier and currency; a proforma
--                      covers at most what was paid on it; an advance invoice
--                      with coverage is covered EXACTLY (checked at commit):
--                      one smaller than what was paid is fine, it covers part
--                      of the proforma; one larger cannot be covered;
--   advance_usage      a final invoice ('invoice', expense) uses live advance
--                      invoices of the same company, supplier and currency; no
--                      advance is used beyond its amount, no final invoice
--                      beyond what it comes to (amount + its notes); the
--                      dinar and euro figures are the final invoice's;
--   keeping the chain  an advance invoice in use or covered, and a proforma
--                      paid or covering, are not deleted; an advance invoice
--                      is not shrunk below its use, nor a final invoice below
--                      the advance it uses.
--
-- v_invoice_status keeps every column of 20261020100000 in order. A final
-- invoice counts the advance it uses as settled; an advance invoice is never
-- owed ('paid', nothing remaining). New columns at the end: prior_period,
-- advance_used(_rsd, _eur), advance_open, covered. `unlinked` is also true of
-- an advance invoice with no proforma that is not from an earlier period.
-- v_supplier_advances sums the chain per supplier.

begin;

alter table public.invoices drop constraint if exists invoices_document_type_check;
alter table public.invoices add constraint invoices_document_type_check
  check (document_type in ('invoice', 'credit_note', 'debit_note', 'proforma', 'advance_invoice'));

alter table public.invoices add column if not exists prior_period boolean not null default false;
comment on column public.invoices.prior_period is
  'An advance invoice paid before the books: no proforma, no payment in the app. Only on advance_invoice.';

create table if not exists public.advance_coverage (
  id uuid primary key default gen_random_uuid(),
  advance_invoice_id uuid not null references public.invoices(id) on delete cascade,
  proforma_id uuid not null references public.invoices(id),
  amount numeric(18,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (advance_invoice_id, proforma_id)
);
create index if not exists advance_coverage_proforma_idx on public.advance_coverage (proforma_id);
comment on table public.advance_coverage is 'Which paid proformas an advance invoice covers, and how much of each, in their currency.';

create table if not exists public.advance_usage (
  id uuid primary key default gen_random_uuid(),
  final_invoice_id uuid not null references public.invoices(id) on delete cascade,
  advance_invoice_id uuid not null references public.invoices(id),
  amount numeric(18,2) not null check (amount > 0),
  amount_rsd numeric(18,2),
  amount_eur numeric(18,2),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  unique (final_invoice_id, advance_invoice_id)
);
create index if not exists advance_usage_advance_idx on public.advance_usage (advance_invoice_id);
comment on table public.advance_usage is 'How much of which advance invoice a final invoice uses, in its currency; book figures at the final invoice''s rates.';

-- Access: as invoice_transaction_links.
alter table public.advance_coverage enable row level security;
alter table public.advance_usage enable row level security;
revoke all on public.advance_coverage, public.advance_usage from anon;
grant all on public.advance_coverage, public.advance_usage to authenticated, service_role;

drop policy if exists members_only on public.advance_coverage;
create policy members_only on public.advance_coverage as restrictive for all to authenticated
  using (public.is_member()) with check (public.is_member());
drop policy if exists members_only on public.advance_usage;
create policy members_only on public.advance_usage as restrictive for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists advance_coverage_select on public.advance_coverage;
create policy advance_coverage_select on public.advance_coverage for select using (
  exists (select 1 from public.invoices i where i.id = advance_coverage.advance_invoice_id and public.has_company_access(i.company_id)));
drop policy if exists advance_coverage_write on public.advance_coverage;
create policy advance_coverage_write on public.advance_coverage for all using (
  public.can_write_books() and exists (select 1 from public.invoices i where i.id = advance_coverage.advance_invoice_id and public.has_company_access(i.company_id)))
  with check (
  public.can_write_books() and exists (select 1 from public.invoices i where i.id = advance_coverage.advance_invoice_id and public.has_company_access(i.company_id)));

drop policy if exists advance_usage_select on public.advance_usage;
create policy advance_usage_select on public.advance_usage for select using (
  exists (select 1 from public.invoices i where i.id = advance_usage.final_invoice_id and public.has_company_access(i.company_id)));
drop policy if exists advance_usage_write on public.advance_usage;
create policy advance_usage_write on public.advance_usage for all using (
  public.can_write_books() and exists (select 1 from public.invoices i where i.id = advance_usage.final_invoice_id and public.has_company_access(i.company_id)))
  with check (
  public.can_write_books() and exists (select 1 from public.invoices i where i.id = advance_usage.final_invoice_id and public.has_company_access(i.company_id)));

-- ── The shape of a proforma and an advance invoice ─────────────────────────

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
    if new.type is distinct from 'expense' then
      raise exception '% je dokument dobavljača (ulazni).',
        case new.document_type when 'proforma' then 'Predračun' else 'Avansni račun' end using errcode = 'check_violation';
    end if;
    if coalesce(new.amount, 0) <= 0 then
      raise exception 'Iznos mora biti veći od 0.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoices_advance_shape on public.invoices;
create trigger invoices_advance_shape
  before insert or update on public.invoices
  for each row execute function public.invoices_advance_shape();

-- ── Coverage: an advance invoice ← paid proformas ──────────────────────────

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
  if v_av.company_id is distinct from v_pf.company_id or v_av.partner_id is distinct from v_pf.partner_id
     or v_av.currency is distinct from v_pf.currency then
    raise exception 'Predračun % nije istog dobavljača, firme i valute kao avansni račun.', v_pf.invoice_number
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

drop trigger if exists advance_coverage_rules on public.advance_coverage;
create trigger advance_coverage_rules
  before insert or update on public.advance_coverage
  for each row execute function public.advance_coverage_rules();

-- At commit: an advance invoice with any coverage is covered exactly. Called
-- from the coverage rows and from the advance invoice itself.
create or replace function public.advance_check_covered(p_advance uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_av record; v_cov numeric; v_n int;
begin
  select * into v_av from public.invoices where id = p_advance;
  if v_av.id is null or v_av.deleted_at is not null or v_av.document_type <> 'advance_invoice' then
    return;
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_cov from public.advance_coverage where advance_invoice_id = p_advance;
  if v_n > 0 and abs(v_cov - coalesce(v_av.amount, 0)) > 0.005 then
    raise exception 'Avansni račun % (%) nije pokriven plaćenim predračunima (pokriveno %). Avansni račun ne može biti veći od plaćenog.',
      v_av.invoice_number, v_av.amount, v_cov using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.advance_coverage_balance()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_table_name = 'advance_coverage' then
    perform public.advance_check_covered(coalesce(new.advance_invoice_id, old.advance_invoice_id));
    if tg_op = 'UPDATE' and new.advance_invoice_id is distinct from old.advance_invoice_id then
      perform public.advance_check_covered(old.advance_invoice_id);
    end if;
  else
    perform public.advance_check_covered(new.id);
  end if;
  return null;
end $$;

drop trigger if exists advance_coverage_balance on public.advance_coverage;
create constraint trigger advance_coverage_balance
  after insert or update or delete on public.advance_coverage
  deferrable initially deferred
  for each row execute function public.advance_coverage_balance();

drop trigger if exists invoices_advance_balance on public.invoices;
create constraint trigger invoices_advance_balance
  after update of amount, deleted_at on public.invoices
  deferrable initially deferred
  for each row when (new.document_type = 'advance_invoice')
  execute function public.advance_coverage_balance();

-- ── Usage: a final invoice ← advance invoices ──────────────────────────────

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
  if v_fin.id is null or v_fin.deleted_at is not null or v_fin.document_type <> 'invoice' or v_fin.type <> 'expense' then
    raise exception 'Avans koristi samo živ ulazni račun.' using errcode = 'check_violation';
  end if;
  if v_av.id is null or v_av.deleted_at is not null or v_av.document_type <> 'advance_invoice' then
    raise exception 'Konačni račun se zatvara avansnim računom.' using errcode = 'check_violation';
  end if;
  if v_fin.company_id is distinct from v_av.company_id or v_fin.partner_id is distinct from v_av.partner_id
     or v_fin.currency is distinct from v_av.currency then
    raise exception 'Avansni račun % nije istog dobavljača, firme i valute kao konačni račun.', v_av.invoice_number
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
    from public.invoices a where a.adjusts_invoice_id = v_fin.id and a.deleted_at is null and a.document_type in ('credit_note', 'debit_note');
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

drop trigger if exists advance_usage_rules on public.advance_usage;
create trigger advance_usage_rules
  before insert or update on public.advance_usage
  for each row execute function public.advance_usage_rules();

-- ── Keeping the chain ──────────────────────────────────────────────────────

create or replace function public.invoices_keep_advance_links()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_used numeric;
begin
  -- Deleting (soft or hard).
  if tg_op = 'DELETE' or (old.deleted_at is null and new.deleted_at is not null) then
    if old.document_type = 'advance_invoice' and (
         exists (select 1 from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
                  where u.advance_invoice_id = old.id)
         or exists (select 1 from public.advance_coverage c where c.advance_invoice_id = old.id)) then
      raise exception 'Avansni račun % je vezan za predračun ili konačni račun i ne briše se. Prvo uklonite veze.', old.invoice_number
        using errcode = 'check_violation';
    end if;
    if old.document_type = 'proforma' and (
         exists (select 1 from public.invoice_transaction_links l where l.invoice_id = old.id)
         or exists (select 1 from public.advance_coverage c where c.proforma_id = old.id)) then
      raise exception 'Predračun % je plaćen ili vezan za avansni račun i ne briše se.', old.invoice_number
        using errcode = 'check_violation';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if new.amount is distinct from old.amount then
    if new.document_type = 'advance_invoice' then
      select coalesce(sum(u.amount), 0) into v_used
        from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
       where u.advance_invoice_id = new.id;
      if coalesce(new.amount, 0) < v_used - 0.005 then
        raise exception 'Avansni račun % je iskorišćen sa %; iznos ne može biti manji.', new.invoice_number, v_used
          using errcode = 'check_violation';
      end if;
    elsif new.document_type = 'invoice' then
      select coalesce(sum(u.amount), 0) into v_used from public.advance_usage u where u.final_invoice_id = new.id;
      if coalesce(new.amount, 0) + coalesce((select sum(a.amount) from public.invoices a where a.adjusts_invoice_id = new.id
             and a.deleted_at is null and a.document_type in ('credit_note', 'debit_note')), 0) < v_used - 0.005 then
        raise exception 'Račun % koristi avans od %; iznos ne može biti manji.', new.invoice_number, v_used
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoices_keep_advance_links on public.invoices;
create trigger invoices_keep_advance_links
  before update of deleted_at, amount or delete on public.invoices
  for each row execute function public.invoices_keep_advance_links();

revoke all on function public.advance_coverage_rules(), public.advance_usage_rules(), public.advance_coverage_balance(),
  public.invoices_keep_advance_links(), public.advance_check_covered(uuid) from public, anon, authenticated;

-- ── v_invoice_status ───────────────────────────────────────────────────────
-- The columns of 20261020100000, in order; the advance a final invoice uses
-- counts as settled; an advance invoice is never owed. New columns at the end.
create or replace view public.v_invoice_status with (security_invoker = 'on') as
 select i.id,
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
    pr.name as project_name,
    i.cf_type,
    i.cf_frequency,
    i.cf_next_month_est,
    i.note,
    i.pl_impact,
    i.exchange_rate,
    i.eur_rate,
    i.parent_invoice_id,
    p.name as partner_name,
    c.name as company_name,
    pay.paid_rsd as paid_amount_rsd,
    pay.paid_eur as paid_amount_eur,
    case
      when linked.not_owed then 0::numeric
      when s.closed then 0::numeric
      else greatest(0::numeric, coalesce(i.amount_rsd, 0) + adj.total_rsd - i.advance_deducted_rsd - pay.paid_rsd - used.used_rsd)
    end as remaining_rsd,
    case
      when linked.not_owed then 0::numeric
      when s.closed then 0::numeric
      else greatest(0::numeric, coalesce(i.amount_eur, 0) + adj.total_eur - i.advance_deducted_eur - pay.paid_eur - used.used_eur)
    end as remaining_eur,
    case
      when linked.not_owed then 'paid'
      when s.settled <= 0 then 'unpaid'
      when s.closed then 'paid'
      when pay.paid <= 0 and adj.credits = 0 and used.used = 0 then 'unpaid'
      else 'partial'
    end as calculated_status,
    pay.paid as paid_amount,
    i.reference_number,
    i.account_number,
    i.advance_deducted,
    i.advance_deducted_rsd,
    i.advance_deducted_eur,
    (coalesce(i.amount, 0) + adj.total - i.advance_deducted - used.used) as amount_due,
    (coalesce(i.amount_rsd, 0) + adj.total_rsd - i.advance_deducted_rsd - used.used_rsd) as amount_due_rsd,
    (coalesce(i.amount_eur, 0) + adj.total_eur - i.advance_deducted_eur - used.used_eur) as amount_due_eur,
    i.lease_id,
    i.service_month,
    i.document_type,
    i.adjusts_invoice_id,
    adj.total as adjustments,
    adj.total_rsd as adjustments_rsd,
    adj.total_eur as adjustments_eur,
    ((i.document_type in ('credit_note', 'debit_note') and i.adjusts_invoice_id is null)
      or (i.document_type = 'advance_invoice' and not i.prior_period and cov.covered = 0)) as unlinked,
    i.prior_period,
    used.used as advance_used,
    used.used_rsd as advance_used_rsd,
    used.used_eur as advance_used_eur,
    case when i.document_type = 'advance_invoice' then coalesce(i.amount, 0) - spent.spent end as advance_open,
    cov.covered
   from public.invoices i
     left join public.partners p on p.id = i.partner_id
     left join public.companies c on c.id = i.company_id
     left join public.projects pr on pr.id = i.project_id
     cross join lateral (
       select coalesce(sum(itl.allocated_amount), 0::numeric) as paid,
              coalesce(sum(itl.allocated_amount_rsd), 0::numeric) as paid_rsd,
              coalesce(sum(itl.allocated_amount_eur), 0::numeric) as paid_eur
         from public.invoice_transaction_links itl
        where itl.invoice_id = i.id) pay
     cross join lateral (
       select coalesce(sum(a.amount), 0::numeric) as total,
              coalesce(sum(a.amount_rsd), 0::numeric) as total_rsd,
              coalesce(sum(a.amount_eur), 0::numeric) as total_eur,
              coalesce(-sum(a.amount) filter (where a.document_type = 'credit_note'), 0::numeric) as credits
         from public.invoices a
        where a.adjusts_invoice_id = i.id
          and a.deleted_at is null
          and a.document_type in ('credit_note', 'debit_note')
          and i.document_type = 'invoice') adj
     cross join lateral (
       select coalesce(sum(u.amount), 0::numeric) as used,
              coalesce(sum(u.amount_rsd), 0::numeric) as used_rsd,
              coalesce(sum(u.amount_eur), 0::numeric) as used_eur
         from public.advance_usage u
        where u.final_invoice_id = i.id
          and i.document_type = 'invoice') used
     cross join lateral (
       select coalesce(sum(u.amount), 0::numeric) as spent
         from public.advance_usage u
         join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
        where u.advance_invoice_id = i.id
          and i.document_type = 'advance_invoice') spent
     cross join lateral (
       select coalesce(sum(cv.amount), 0::numeric) as covered
         from public.advance_coverage cv
         join public.invoices av on av.id = cv.advance_invoice_id and av.deleted_at is null
        where (i.document_type = 'advance_invoice' and cv.advance_invoice_id = i.id)
           or (i.document_type = 'proforma' and cv.proforma_id = i.id)) cov
     cross join lateral (
       select (i.document_type in ('credit_note', 'debit_note') and i.adjusts_invoice_id is not null)
              or i.document_type = 'advance_invoice' as not_owed) linked
     cross join lateral (
       select pay.paid + i.advance_deducted + adj.credits + used.used as settled) s0
     cross join lateral (
       select s0.settled,
              s0.settled > 0
              and round(coalesce(i.amount, 0) + adj.total + adj.credits - s0.settled, 2)
                  <= greatest(0.01, round(1.00 * coalesce(i.amount, 0) / nullif(i.amount_rsd, 0), 2)) as closed) s
  where i.parent_invoice_id is null;

revoke all on public.v_invoice_status from anon;
grant all on public.v_invoice_status to authenticated, service_role;

-- ── v_supplier_advances: the chain per supplier ────────────────────────────
create or replace view public.v_supplier_advances with (security_invoker = 'on') as
 with docs as (
   select i.company_id, i.partner_id, i.currency, i.document_type, i.id, i.amount
     from public.invoices i
    where i.deleted_at is null and i.document_type in ('proforma', 'advance_invoice') and i.type = 'expense'
 ), sums as (
   select d.company_id, d.partner_id, d.currency,
          coalesce(sum((select coalesce(sum(l.allocated_amount), 0) from public.invoice_transaction_links l where l.invoice_id = d.id))
                   filter (where d.document_type = 'proforma'), 0) as paid_on_proformas,
          coalesce(sum((select coalesce(sum(cv.amount), 0) from public.advance_coverage cv where cv.advance_invoice_id = d.id))
                   filter (where d.document_type = 'advance_invoice'), 0) as covered,
          coalesce(sum(d.amount) filter (where d.document_type = 'advance_invoice'), 0) as advance_total,
          coalesce(sum((select coalesce(sum(u.amount), 0) from public.advance_usage u
                          join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
                         where u.advance_invoice_id = d.id))
                   filter (where d.document_type = 'advance_invoice'), 0) as used
     from docs d
    group by d.company_id, d.partner_id, d.currency
 )
 select s.company_id, s.partner_id, p.name as partner_name, s.currency,
        s.paid_on_proformas, s.covered, s.advance_total, s.used,
        s.paid_on_proformas - s.covered as paid_without_advance,
        s.advance_total - s.used as advance_open
   from sums s
   left join public.partners p on p.id = s.partner_id;

revoke all on public.v_supplier_advances from anon;
grant select on public.v_supplier_advances to authenticated, service_role;

commit;
