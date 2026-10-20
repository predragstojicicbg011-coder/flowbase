-- Supplier advances, fixes after review (20261021090000).
--
--   1. Links are replaced in ONE transaction: replace_advance_links(invoice,
--      coverage, usage). The form used to delete a document's links in one
--      request and write them back in another; a failure between them left a
--      final invoice owing its full amount again, offered for payment twice.
--   2. A linked document keeps its type, supplier, company, currency and
--      direction: an advance invoice in use retyped to a bill would become
--      payable with its use still counted.
--   3. A covered advance invoice's amount does not change (remove the
--      coverage first); the exact-coverage rule could otherwise be broken by
--      raising the amount.
--   4. A proforma's payment cannot be removed from under its coverage.
--   5. A credit note cannot take a final invoice below the advance it uses.
--   6. A bill with no advance is not checked against one: a negative
--      ordinary row (a payroll child) could no longer be edited.

begin;

-- ── 1 ──────────────────────────────────────────────────────────────────────
-- Security invoker: the caller's own rights (RLS on the link tables) apply.
-- A null array leaves that kind of link alone.
create or replace function public.replace_advance_links(p_invoice uuid, p_coverage jsonb, p_usage jsonb)
returns void
language plpgsql
set search_path to 'public'
as $$
begin
  if p_coverage is not null then
    delete from public.advance_coverage where advance_invoice_id = p_invoice;
    insert into public.advance_coverage (advance_invoice_id, proforma_id, amount)
    select p_invoice, (e ->> 'proforma_id')::uuid, (e ->> 'amount')::numeric
      from jsonb_array_elements(p_coverage) e;
  end if;
  if p_usage is not null then
    delete from public.advance_usage where final_invoice_id = p_invoice;
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount)
    select p_invoice, (e ->> 'advance_invoice_id')::uuid, (e ->> 'amount')::numeric
      from jsonb_array_elements(p_usage) e;
  end if;
end $$;

revoke all on function public.replace_advance_links(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.replace_advance_links(uuid, jsonb, jsonb) to authenticated, service_role;

-- ── 2, 3, 6 ────────────────────────────────────────────────────────────────
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
  before update of deleted_at, amount, document_type, partner_id, company_id, currency, type or delete on public.invoices
  for each row execute function public.invoices_keep_advance_links();

-- ── 4 ──────────────────────────────────────────────────────────────────────
create or replace function public.proforma_keeps_its_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_pf record; v_paid numeric; v_cov numeric;
begin
  select * into v_pf from public.invoices where id = old.invoice_id;
  if v_pf.id is null or v_pf.document_type <> 'proforma' then
    return null;
  end if;
  select coalesce(sum(l.allocated_amount), 0) into v_paid from public.invoice_transaction_links l where l.invoice_id = v_pf.id;
  select coalesce(sum(c.amount), 0) into v_cov
    from public.advance_coverage c join public.invoices a on a.id = c.advance_invoice_id and a.deleted_at is null
   where c.proforma_id = v_pf.id;
  if v_cov > v_paid + 0.005 then
    raise exception 'Po predračunu % je avansnim računima pokriveno %, a plaćeno bi ostalo %. Prvo odvežite avansni račun.', v_pf.invoice_number, v_cov, v_paid
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists proforma_keeps_its_payment on public.invoice_transaction_links;
create trigger proforma_keeps_its_payment
  after update or delete on public.invoice_transaction_links
  for each row execute function public.proforma_keeps_its_payment();

-- ── 5 ──────────────────────────────────────────────────────────────────────
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
     and a.document_type in ('credit_note', 'debit_note');
  if coalesce(v_base.amount, 0) + v_notes + new.amount < v_used - 0.005 then
    raise exception 'Račun % je zatvoren avansom od %; knjižno odobrenje bi ga spustilo ispod toga. Prvo smanjite iskorišćeni avans.', v_base.invoice_number, v_used
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists invoices_notes_respect_advance_used on public.invoices;
create trigger invoices_notes_respect_advance_used
  before insert or update on public.invoices
  for each row execute function public.notes_respect_advance_used();

revoke all on function public.proforma_keeps_its_payment(), public.notes_respect_advance_used() from public, anon, authenticated;

commit;
