-- Delete an invoice and everything linked to it, in one transaction.
--
-- A revenue invoice (or a bill) that was booked by mistake cannot be removed
-- one piece at a time: its payment links, advance links, credit/debit notes,
-- uploaded PDFs and SEF inbox row each stand in the way of the next. This
-- function does it in the one order that works and either finishes or leaves
-- everything exactly as it was (an exception anywhere, a locked period
-- included, aborts the whole call).
--
-- It goes THROUGH the same rules as every other delete rather than around
-- them: the invoice and its notes are soft deleted with a plain update, so the
-- period-lock trigger, the advance-link guards and the note guards all fire.
-- The caller must keep the books and reach the company (checked first, because
-- the function is security definer and the policies do not apply inside it).
--
-- The notes (adjusts_invoice_id) are deleted together with the invoice: a
-- credit note without its bill means nothing. The confirmation lists them.
--
-- p_dry_run = true changes nothing and returns what a real call would do.

begin;

create or replace function public.delete_invoice_cascade(p_invoice uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_inv record;
  v_ids uuid[];
  v_note_ids uuid[];
  v_payments int;
  v_adv int;
  v_finals text[];
  v_notes text[];
  v_uploads int;
  v_sef text;
begin
  if not public.can_write_books() then
    raise exception 'Samo finansijski tim može da obriše fakturu.'
      using errcode = 'insufficient_privilege';
  end if;

  select id, company_id, invoice_number, type into v_inv
    from public.invoices where id = p_invoice and deleted_at is null for update;
  if v_inv.id is null then
    raise exception 'Faktura % ne postoji ili je već obrisana.', p_invoice using errcode = 'no_data_found';
  end if;
  if not public.has_company_access(v_inv.company_id) then
    raise exception 'Nemate pristup toj firmi.' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(a.id order by a.invoice_date, a.invoice_number), '{}'),
         coalesce(array_agg(coalesce(a.invoice_number, a.id::text) order by a.invoice_date, a.invoice_number), '{}')
    into v_note_ids, v_notes
    from public.invoices a
   where a.adjusts_invoice_id = p_invoice and a.deleted_at is null
     and a.document_type in ('credit_note', 'debit_note');
  v_ids := array[p_invoice] || v_note_ids;

  select count(*) into v_payments from public.invoice_transaction_links where invoice_id = any (v_ids);

  select (select count(*) from public.advance_usage u
           where u.final_invoice_id = p_invoice or u.advance_invoice_id = p_invoice)
       + (select count(*) from public.advance_coverage c
           where c.advance_invoice_id = p_invoice or c.proforma_id = p_invoice)
    into v_adv;

  select coalesce(array_agg(coalesce(f.invoice_number, f.id::text) order by f.invoice_number), '{}')
    into v_finals
    from public.advance_usage u
    join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
   where u.advance_invoice_id = p_invoice and f.id <> p_invoice;

  select count(*) into v_uploads from public.invoice_documents
   where invoice_id = any (v_ids) and removed_at is null;

  -- What happens to the inbox rows: a cancelled sales row stays declined, the
  -- rest go back to the queue.
  select case
           when bool_or(s.direction = 'sales' and lower(coalesce(s.sef_status, '')) in ('cancelled', 'storno', 'rejected')) then 'dismissed'
           when count(*) > 0 then 'pending'
         end
    into v_sef
    from public.sef_inbox s where s.imported_invoice_id = any (v_ids);

  if not p_dry_run then
    delete from public.advance_usage
     where final_invoice_id = p_invoice or advance_invoice_id = p_invoice;
    delete from public.advance_coverage
     where advance_invoice_id = p_invoice or proforma_id = p_invoice;
    delete from public.invoice_transaction_links where invoice_id = any (v_ids);

    -- Notes first: the invoice is not deleted while live notes point to it.
    update public.invoices set deleted_at = now(), deleted_by = auth.uid()
     where id = any (v_note_ids) and deleted_at is null;
    update public.invoices set deleted_at = now(), deleted_by = auth.uid()
     where id = p_invoice and deleted_at is null;

    update public.invoice_documents set removed_at = now(), removed_by = auth.uid()
     where invoice_id = any (v_ids) and removed_at is null;

    -- The guard trigger clears the link of a row going back to pending (the
    -- invoice is deleted by now); a declined row is cleared here.
    update public.sef_inbox
       set state = 'dismissed',
           dismiss_reason = 'Stornirana, otkazana ili odbijena na SEF-u (' || sef_status || '); proknjižena faktura obrisana.',
           dismissed_at = now(),
           imported_invoice_id = null,
           imported_at = null
     where imported_invoice_id = any (v_ids)
       and direction = 'sales' and lower(coalesce(sef_status, '')) in ('cancelled', 'storno', 'rejected');
    update public.sef_inbox set state = 'pending'
     where imported_invoice_id = any (v_ids);
  end if;

  return jsonb_build_object(
    'invoice_number', v_inv.invoice_number,
    'type', v_inv.type,
    'payments_unlinked', v_payments,
    'advance_links_removed', v_adv,
    'finals_reopened', to_jsonb(v_finals),
    'notes_deleted', to_jsonb(v_notes),
    'uploads_removed', v_uploads,
    'sef_row', to_jsonb(v_sef));
end $$;

revoke all on function public.delete_invoice_cascade(uuid, boolean) from public, anon;
grant execute on function public.delete_invoice_cascade(uuid, boolean) to authenticated, service_role;

commit;
