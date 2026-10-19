-- Credit and debit notes, fix after review (20261020100000).
--
-- A credit note may lean on a debit note: bill 100, debit +50, credit -140.
-- Deleting, shrinking, relinking or retyping that debit note used to pass and
-- left the bill credited below zero, shown as 'paid' with nothing owed. The
-- rule now re-checks the bill the debit note leaves.

begin;

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
  v_keep numeric;
begin
  -- A debit note leaving its bill (deleted, shrunk, relinked or retyped):
  -- the credit notes on that bill must still fit in what remains.
  if tg_op = 'UPDATE'
     and old.document_type = 'debit_note' and old.adjusts_invoice_id is not null and old.deleted_at is null
     and (new.deleted_at is not null
          or new.adjusts_invoice_id is distinct from old.adjusts_invoice_id
          or new.document_type <> 'debit_note'
          or coalesce(new.amount, 0) < coalesce(old.amount, 0)) then
    select * into v_base from public.invoices where id = old.adjusts_invoice_id for update;
    if found and v_base.deleted_at is null then
      select coalesce(sum(a.amount) filter (where a.document_type = 'credit_note'), 0),
             coalesce(sum(a.amount) filter (where a.document_type = 'debit_note'), 0)
        into v_credits, v_debits
        from public.invoices a
       where a.adjusts_invoice_id = v_base.id and a.deleted_at is null and a.id <> old.id;
      v_keep := case when new.deleted_at is null and new.document_type = 'debit_note'
                      and new.adjusts_invoice_id = old.adjusts_invoice_id then coalesce(new.amount, 0) else 0 end;
      if coalesce(v_base.amount, 0) + v_debits + v_keep + v_credits < 0 then
        raise exception 'Knjižna odobrenja na računu % su veća od računa bez ovog knjižnog zaduženja. Prvo umanjite ili odvežite odobrenja.', v_base.invoice_number
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

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

revoke all on function public.invoices_adjustment_rules() from public, anon, authenticated;

commit;
