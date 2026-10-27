-- A debit note is owed by itself (knjižno zaduženje, 27.10.2026).
--
-- Until now a debit note added to the bill it points to: the bill showed the
-- note's amount as still owed, and the note itself read 'paid'. Booked from
-- SEF on Mintflow, a paid bill came back partly unpaid and its debit note
-- could not be paid at all. The owner's rule:
--
--   * a debit note points to its bill (adjusts_invoice_id), for reference;
--   * it is a document of its own, not part of the bill's value: the bill is
--     left as it is, paid or not;
--   * it is owed and paid by itself, at the account and reference on it;
--   * it is in the P&L like a bill.
--
-- Credit notes are unchanged: they reduce their bill. Only credit notes are
-- counted on a bill now — in v_invoice_status, in the credit-note limit
-- (invoices_adjustment_rules) and in the advance rules; a credit note no
-- longer leans on a debit note of the same bill.

begin;

-- ── 1. The status view: a bill counts its credit notes; a debit note is owed ──
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
          and a.document_type = 'credit_note'
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
       select (i.document_type = 'credit_note' and i.adjusts_invoice_id is not null)
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

-- ── 2. The credit-note limit: the bill and its credit notes only ──────────────
create or replace function public.invoices_adjustment_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_base record;
  v_credits numeric;
  v_keep numeric;
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
    select coalesce(sum(a.amount) filter (where a.document_type = 'credit_note'), 0)
      into v_credits
      from public.invoices a where a.adjusts_invoice_id = new.id and a.deleted_at is null;
    if coalesce(new.amount, 0) + v_credits < 0 then
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
    select coalesce(sum(a.amount) filter (where a.document_type = 'credit_note'), 0)
      into v_credits
      from public.invoices a
     where a.adjusts_invoice_id = v_base.id and a.deleted_at is null and a.id <> new.id;
    if coalesce(v_base.amount, 0) + v_credits + new.amount < 0 then
      raise exception 'Knjižno odobrenje (%) je veće od onoga što je ostalo od računa % (%).',
        -new.amount, v_base.invoice_number, coalesce(v_base.amount, 0) + v_credits
        using errcode = 'check_violation';
    end if;
  end if;

  -- A debit note is a document of its own, booked at its own date's rates.
  if new.document_type = 'debit_note' then
    return new;
  end if;

  -- The bill's rates, so the credit note is in the bill's book figures.
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

-- ── 3. Advances: a final invoice with its credit notes only ───────────────────
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

create or replace function public.invoices_keep_advance_links()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_used numeric;
  v_linked boolean;
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

  -- What the document is linked to.
  v_linked := case old.document_type
    when 'advance_invoice' then exists (select 1 from public.advance_usage u where u.advance_invoice_id = old.id)
                              or exists (select 1 from public.advance_coverage c where c.advance_invoice_id = old.id)
    when 'proforma' then exists (select 1 from public.advance_coverage c where c.proforma_id = old.id)
    when 'invoice' then exists (select 1 from public.advance_usage u where u.final_invoice_id = old.id)
    else false end;

  if v_linked and (new.document_type is distinct from old.document_type
       or new.partner_id is distinct from old.partner_id or new.company_id is distinct from old.company_id
       or new.currency is distinct from old.currency or new.type is distinct from old.type) then
    raise exception 'Dokument % je vezan za avans (predračun, avansni ili konačni račun): vrsta, dobavljač, firma, valuta i smer se ne menjaju dok su veze tu.', old.invoice_number
      using errcode = 'check_violation';
  end if;

  if new.amount is distinct from old.amount then
    if new.document_type = 'advance_invoice' then
      if exists (select 1 from public.advance_coverage c where c.advance_invoice_id = new.id) then
        raise exception 'Avansni račun % je pokriven predračunima; prvo uklonite pokriće, pa promenite iznos.', new.invoice_number
          using errcode = 'check_violation';
      end if;
      select coalesce(sum(u.amount), 0) into v_used
        from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
       where u.advance_invoice_id = new.id;
      if v_used > 0 and coalesce(new.amount, 0) < v_used - 0.005 then
        raise exception 'Avansni račun % je iskorišćen sa %; iznos ne može biti manji.', new.invoice_number, v_used
          using errcode = 'check_violation';
      end if;
    elsif new.document_type = 'invoice' then
      select coalesce(sum(u.amount), 0) into v_used from public.advance_usage u where u.final_invoice_id = new.id;
      if v_used > 0 and coalesce(new.amount, 0) + coalesce((select sum(a.amount) from public.invoices a where a.adjusts_invoice_id = new.id
             and a.deleted_at is null and a.document_type = 'credit_note'), 0) < v_used - 0.005 then
        raise exception 'Račun % koristi avans od %; iznos ne može biti manji.', new.invoice_number, v_used
          using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

create or replace function public.notes_respect_advance_used()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_base record; v_notes numeric; v_used numeric;
begin
  if new.deleted_at is not null or new.adjusts_invoice_id is null or new.document_type <> 'credit_note' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.amount is not distinct from old.amount
     and new.adjusts_invoice_id is not distinct from old.adjusts_invoice_id and old.deleted_at is null then
    return new;
  end if;
  select coalesce(sum(u.amount), 0) into v_used from public.advance_usage u where u.final_invoice_id = new.adjusts_invoice_id;
  if v_used <= 0 then
    return new;
  end if;
  select * into v_base from public.invoices where id = new.adjusts_invoice_id;
  select coalesce(sum(a.amount), 0) into v_notes
    from public.invoices a
   where a.adjusts_invoice_id = new.adjusts_invoice_id and a.deleted_at is null and a.id <> new.id
     and a.document_type = 'credit_note';
  if coalesce(v_base.amount, 0) + v_notes + new.amount < v_used - 0.005 then
    raise exception 'Račun % je zatvoren avansom od %; knjižno odobrenje bi ga spustilo ispod toga. Prvo smanjite iskorišćeni avans.', v_base.invoice_number, v_used
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- A credit note that used to fit only because a debit note was counted is
-- reported, not hidden: the limit above refuses it from now on.
do $$
declare v_n int;
begin
  select count(*) into v_n
    from public.invoices b
   where b.deleted_at is null and b.document_type = 'invoice'
     and coalesce(b.amount, 0) + coalesce((select sum(a.amount) from public.invoices a
           where a.adjusts_invoice_id = b.id and a.deleted_at is null and a.document_type = 'credit_note'), 0) < -0.005;
  if v_n > 0 then
    raise notice '% račun(a) ima knjižna odobrenja veća od samog računa; proverite ih.', v_n;
  end if;
end $$;

commit;
