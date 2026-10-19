-- Credit notes and debit notes (knjižno odobrenje, knjižno zaduženje).
--
-- Spec: docs/superpowers/specs/2026-10-19-knjizna-odobrenja-design.md.
--
-- Until now a credit note was a "bill with a minus" that knew nothing of the
-- bill it reduces, so the unpaid list held two loose lines, plus and minus.
-- From here an invoice row has a DOCUMENT TYPE:
--   'invoice'      a bill (or our own invoice);
--   'credit_note'  reduces one bill: amount < 0;
--   'debit_note'   adds to one bill: amount > 0;
-- and a credit or debit note points at the bill it adjusts (adjusts_invoice_id).
-- parent_invoice_id already belongs to payroll and is not reused.
--
-- RULES (trigger invoices_adjustment_rules):
--   - the sign follows the type;
--   - the bill is a live 'invoice' of the same company, partner, currency and
--     direction (expense/revenue);
--   - a credit note may not take the bill below zero: its credits stay within
--     amount + debit notes;
--   - a linked note takes the bill's exchange rates, so a bill credited in
--     full closes to the dinar;
--   - a bill with live notes on it keeps its partner, company, currency,
--     direction and type, and its amount may not drop below its credits.
-- A note with no bill is allowed (an old bill from before the books): it is
-- marked unlinked and is linked later.
-- Rules run on insert and when a column they read changes; any other edit is
-- left alone. The bill is locked while a note is checked against it, so two
-- notes saved at once cannot together over-credit it.
-- A bill cannot be deleted while a live note points to it
-- (invoices_keep_adjusted_base).
--
-- v_invoice_status: a bill counts its notes. Credits settle it like a payment
-- (a bill reduced by a credit note is 'partial', one credited in full is
-- 'paid'), debits add to what is owed; remaining_* and amount_due* include
-- both. A linked note is never owed on its own: 'paid'. An unlinked note is
-- computed as before. New columns at the end: document_type,
-- adjusts_invoice_id, adjustments (the notes' sum in the bill's currency),
-- adjustments_rsd, adjustments_eur, unlinked.
--
-- Duplicate control (20261020090000) now compares numbers per document type:
-- credit note "5/26" and bill "5/26" of one supplier are two documents.
--
-- Existing data: a live negative invoice outside payroll becomes an unlinked
-- credit note.

begin;

alter table public.invoices
  add column if not exists document_type text not null default 'invoice',
  add column if not exists adjusts_invoice_id uuid references public.invoices(id) on delete set null;

alter table public.invoices drop constraint if exists invoices_document_type_check;
alter table public.invoices add constraint invoices_document_type_check
  check (document_type in ('invoice', 'credit_note', 'debit_note'));

comment on column public.invoices.document_type is
  'invoice, credit_note (amount < 0, reduces adjusts_invoice_id) or debit_note (amount > 0, adds to it). Rules: invoices_adjustment_rules.';
comment on column public.invoices.adjusts_invoice_id is
  'The bill a credit or debit note adjusts; null on a bill, and on a note not linked yet. Not parent_invoice_id, which is payroll''s.';

create index if not exists invoices_adjusts_invoice_idx
  on public.invoices (adjusts_invoice_id) where adjusts_invoice_id is not null;

-- Backfill before the new rules exist: they would re-check every row.
update public.invoices
   set document_type = 'credit_note'
 where amount < 0 and document_type = 'invoice' and parent_invoice_id is null and deleted_at is null;

-- Duplicate control per document type.
drop index if exists public.invoices_supplier_number_idx;
create index if not exists invoices_supplier_number_idx
  on public.invoices (partner_id, document_type, public.invoice_number_key(invoice_number))
  where deleted_at is null and type = 'expense';

create or replace function public.invoices_one_per_supplier_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_key text;
  v_other record;
begin
  if new.type <> 'expense' or new.deleted_at is not null or new.partner_id is null then
    return new;
  end if;
  v_key := public.invoice_number_key(new.invoice_number);
  if v_key is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.invoice_number is not distinct from old.invoice_number
     and new.partner_id is not distinct from old.partner_id
     and new.company_id is not distinct from old.company_id
     and new.type = old.type
     and new.document_type = old.document_type
     and old.deleted_at is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(new.company_id::text, '') || '|' || new.partner_id::text || '|' || new.document_type || '|' || v_key, 0));

  select i.invoice_number, i.invoice_date into v_other
    from public.invoices i
   where i.id <> new.id
     and i.deleted_at is null
     and i.type = 'expense'
     and i.document_type = new.document_type
     and i.partner_id = new.partner_id
     and i.company_id is not distinct from new.company_id
     and public.invoice_number_key(i.invoice_number) = v_key
   limit 1;
  if found then
    raise exception '% broj % od ovog dobavljača je već proknjižen (broj „%“, datum %). Isti dokument se ne knjiži dva puta.',
      case new.document_type when 'credit_note' then 'Knjižno odobrenje' when 'debit_note' then 'Knjižno zaduženje' else 'Račun' end,
      new.invoice_number, v_other.invoice_number, to_char(v_other.invoice_date, 'DD.MM.YYYY')
      using errcode = 'unique_violation';
  end if;
  return new;
end $$;

drop trigger if exists invoices_one_per_supplier_number on public.invoices;
create trigger invoices_one_per_supplier_number
  before insert or update of invoice_number, partner_id, company_id, type, deleted_at, document_type on public.invoices
  for each row execute function public.invoices_one_per_supplier_number();

revoke all on function public.invoices_one_per_supplier_number() from public, anon, authenticated;

-- The rules of a note and of a bill with notes.
create or replace function public.invoices_adjustment_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_base record;
  v_credits numeric;
  v_debits numeric;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.deleted_at is null
     and new.document_type = old.document_type
     and new.adjusts_invoice_id is not distinct from old.adjusts_invoice_id
     and new.amount is not distinct from old.amount
     and new.partner_id is not distinct from old.partner_id
     and new.company_id is not distinct from old.company_id
     and new.currency is not distinct from old.currency
     and new.type is not distinct from old.type
     and new.exchange_rate is not distinct from old.exchange_rate
     and new.eur_rate is not distinct from old.eur_rate
     and new.amount_rsd is not distinct from old.amount_rsd
     and new.amount_eur is not distinct from old.amount_eur then
    return new;
  end if;

  if new.document_type = 'credit_note' and coalesce(new.amount, 0) >= 0 then
    raise exception 'Knjižno odobrenje mora imati negativan iznos.' using errcode = 'check_violation';
  end if;
  if new.document_type = 'debit_note' and coalesce(new.amount, 0) <= 0 then
    raise exception 'Knjižno zaduženje mora imati pozitivan iznos.' using errcode = 'check_violation';
  end if;

  -- A bill that notes point to.
  if tg_op = 'UPDATE' and exists (
       select 1 from public.invoices a where a.adjusts_invoice_id = new.id and a.deleted_at is null) then
    if new.document_type <> 'invoice'
       or new.partner_id is distinct from old.partner_id
       or new.company_id is distinct from old.company_id
       or new.currency is distinct from old.currency
       or new.type is distinct from old.type then
      raise exception 'Na ovaj račun su vezana knjižna odobrenja ili zaduženja: partner, firma, valuta, vrsta i smer se ne menjaju dok su vezana.'
        using errcode = 'check_violation';
    end if;
    select coalesce(sum(a.amount) filter (where a.document_type = 'credit_note'), 0),
           coalesce(sum(a.amount) filter (where a.document_type = 'debit_note'), 0)
      into v_credits, v_debits
      from public.invoices a where a.adjusts_invoice_id = new.id and a.deleted_at is null;
    if coalesce(new.amount, 0) + v_debits + v_credits < 0 then
      raise exception 'Iznos računa ne može biti manji od knjižnih odobrenja vezanih za njega (%).', -v_credits
        using errcode = 'check_violation';
    end if;
  end if;

  if new.adjusts_invoice_id is null then
    return new;
  end if;

  -- A linked note.
  if new.document_type = 'invoice' then
    raise exception 'Samo knjižno odobrenje ili zaduženje se vezuje za račun.' using errcode = 'check_violation';
  end if;
  if new.adjusts_invoice_id = new.id then
    raise exception 'Dokument se ne vezuje sam za sebe.' using errcode = 'check_violation';
  end if;

  select * into v_base from public.invoices where id = new.adjusts_invoice_id for update;
  if not found or v_base.deleted_at is not null then
    raise exception 'Račun na koji se dokument odnosi ne postoji ili je obrisan.' using errcode = 'check_violation';
  end if;
  if v_base.document_type <> 'invoice' then
    raise exception 'Knjižno odobrenje ili zaduženje se vezuje za račun, ne za drugo odobrenje ili zaduženje.'
      using errcode = 'check_violation';
  end if;
  if v_base.company_id is distinct from new.company_id
     or v_base.partner_id is distinct from new.partner_id
     or v_base.currency is distinct from new.currency
     or v_base.type is distinct from new.type then
    raise exception 'Knjižno odobrenje ili zaduženje mora biti iste firme, partnera, valute i smera kao račun %.', v_base.invoice_number
      using errcode = 'check_violation';
  end if;

  if new.document_type = 'credit_note' then
    select coalesce(sum(a.amount) filter (where a.document_type = 'credit_note'), 0),
           coalesce(sum(a.amount) filter (where a.document_type = 'debit_note'), 0)
      into v_credits, v_debits
      from public.invoices a
     where a.adjusts_invoice_id = v_base.id and a.deleted_at is null and a.id <> new.id;
    if coalesce(v_base.amount, 0) + v_debits + v_credits + new.amount < 0 then
      raise exception 'Knjižno odobrenje (%) je veće od onoga što je ostalo od računa % (%).',
        -new.amount, v_base.invoice_number, coalesce(v_base.amount, 0) + v_debits + v_credits
        using errcode = 'check_violation';
    end if;
  end if;

  -- The bill's rates, so the note is in the bill's book figures.
  new.exchange_rate := v_base.exchange_rate;
  new.eur_rate := v_base.eur_rate;
  new.amount_rsd := case
    when new.currency = 'RSD' then new.amount
    when v_base.exchange_rate is not null then round(new.amount * v_base.exchange_rate, 2)
    when coalesce(v_base.amount, 0) <> 0 then round(new.amount * v_base.amount_rsd / v_base.amount, 2)
  end;
  new.amount_eur := case
    when new.currency = 'EUR' then new.amount
    when v_base.amount_eur is not null and coalesce(v_base.amount, 0) <> 0 then round(new.amount * v_base.amount_eur / v_base.amount, 2)
    when v_base.eur_rate is not null and v_base.eur_rate <> 0 then round(new.amount_rsd / v_base.eur_rate, 2)
  end;
  return new;
end $$;

drop trigger if exists invoices_adjustment_rules on public.invoices;
create trigger invoices_adjustment_rules
  before insert or update on public.invoices
  for each row execute function public.invoices_adjustment_rules();

revoke all on function public.invoices_adjustment_rules() from public, anon, authenticated;

-- A bill keeps living while notes point to it.
create or replace function public.invoices_keep_adjusted_base()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' and (old.deleted_at is not null or new.deleted_at is null) then
    return new;
  end if;
  if exists (select 1 from public.invoices a where a.adjusts_invoice_id = old.id and a.deleted_at is null) then
    raise exception 'Račun % se ne briše dok su za njega vezana knjižna odobrenja ili zaduženja. Prvo njih obrišite ili odvežite.',
      old.invoice_number using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists invoices_keep_adjusted_base on public.invoices;
create trigger invoices_keep_adjusted_base
  before update of deleted_at or delete on public.invoices
  for each row execute function public.invoices_keep_adjusted_base();

revoke all on function public.invoices_keep_adjusted_base() from public, anon, authenticated;

-- v_invoice_status: the columns of 20261008180000_accrual_revenue.sql, in
-- order, with notes counted; new columns at the end. Payments and notes are
-- summed in lateral subqueries instead of a GROUP BY.
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
      when linked.is_note then 0::numeric
      when s.closed then 0::numeric
      else greatest(0::numeric, coalesce(i.amount_rsd, 0) + adj.total_rsd - i.advance_deducted_rsd - pay.paid_rsd)
    end as remaining_rsd,
    case
      when linked.is_note then 0::numeric
      when s.closed then 0::numeric
      else greatest(0::numeric, coalesce(i.amount_eur, 0) + adj.total_eur - i.advance_deducted_eur - pay.paid_eur)
    end as remaining_eur,
    case
      when linked.is_note then 'paid'
      when s.settled <= 0 then 'unpaid'
      when s.closed then 'paid'
      when pay.paid <= 0 and adj.credits = 0 then 'unpaid'
      else 'partial'
    end as calculated_status,
    pay.paid as paid_amount,
    i.reference_number,
    i.account_number,
    i.advance_deducted,
    i.advance_deducted_rsd,
    i.advance_deducted_eur,
    (coalesce(i.amount, 0) + adj.total - i.advance_deducted) as amount_due,
    (coalesce(i.amount_rsd, 0) + adj.total_rsd - i.advance_deducted_rsd) as amount_due_rsd,
    (coalesce(i.amount_eur, 0) + adj.total_eur - i.advance_deducted_eur) as amount_due_eur,
    i.lease_id,
    i.service_month,
    i.document_type,
    i.adjusts_invoice_id,
    adj.total as adjustments,
    adj.total_rsd as adjustments_rsd,
    adj.total_eur as adjustments_eur,
    (i.document_type <> 'invoice' and i.adjusts_invoice_id is null) as unlinked
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
       select i.document_type <> 'invoice' and i.adjusts_invoice_id is not null as is_note) linked
     cross join lateral (
       select pay.paid + i.advance_deducted + adj.credits as settled) s0
     cross join lateral (
       select s0.settled,
              s0.settled > 0
              and round(coalesce(i.amount, 0) + adj.total + adj.credits - s0.settled, 2)
                  <= greatest(0.01, round(1.00 * coalesce(i.amount, 0) / nullif(i.amount_rsd, 0), 2)) as closed) s
  where i.parent_invoice_id is null;

revoke all on public.v_invoice_status from anon;
grant all on public.v_invoice_status to authenticated, service_role;

do $$
begin
  if exists (select 1 from public.invoices
              where deleted_at is null and parent_invoice_id is null
                and document_type = 'invoice' and amount < 0) then
    raise exception 'A live negative invoice is still of type invoice after the backfill.';
  end if;
  if exists (select 1 from public.invoices
              where (document_type = 'credit_note' and amount >= 0)
                 or (document_type = 'debit_note' and amount <= 0)) then
    raise exception 'A note has the wrong sign.';
  end if;
end $$;

commit;
