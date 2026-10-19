-- One bill per supplier and number.
--
-- A supplier's bill number is unique for that supplier. Until now the app only
-- WARNED (src/services/sef/sefDuplicate.ts) when a bill from the SEF inbox
-- looked like one already in the ledger; nothing stopped the same bill being
-- booked twice — typed by hand and then booked from SEF, or imported twice.
-- From here the database refuses it.
--
-- THE RULE: a live (not soft-deleted) expense invoice may not share its
-- supplier (partner_id) and its number with another live expense invoice of
-- the same company. Numbers are compared on their letters and digits only, so
-- "2026/0412", "2026-0412" and "2026 0412" are one number — the same folding
-- the SEF duplicate warning uses. Revenue invoices are the company's own
-- numbering and are not touched. A bill with no supplier or no number is not
-- checked.
--
-- WHEN IT IS CHECKED: on insert, and on an update that changes the number, the
-- supplier, the type, the company or brings a deleted bill back. Any other
-- edit is left alone, so a pair that was already in the books before this
-- migration (it does not rewrite history) can still be corrected, and the
-- correction that separates them is accepted.
--
-- Two people booking the same bill at the same moment: the check takes a
-- transaction-level advisory lock on (company, supplier, number) first, so the
-- second waits for the first and then sees it.

begin;

create or replace function public.invoice_number_key(p_number text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(regexp_replace(lower(coalesce(p_number, '')), '[^[:alnum:]]', '', 'g'), '');
$$;

comment on function public.invoice_number_key(text) is
  'A bill number folded to its letters and digits, lower case: the key two bills of one supplier may not share.';

create index if not exists invoices_supplier_number_idx
  on public.invoices (partner_id, public.invoice_number_key(invoice_number))
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
     and old.deleted_at is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(new.company_id::text, '') || '|' || new.partner_id::text || '|' || v_key, 0));

  select i.invoice_number, i.invoice_date into v_other
    from public.invoices i
   where i.id <> new.id
     and i.deleted_at is null
     and i.type = 'expense'
     and i.partner_id = new.partner_id
     and i.company_id is not distinct from new.company_id
     and public.invoice_number_key(i.invoice_number) = v_key
   limit 1;
  if found then
    raise exception 'Račun broj % od ovog dobavljača je već proknjižen (broj „%“, datum %). Isti račun se ne knjiži dva puta.',
      new.invoice_number, v_other.invoice_number, to_char(v_other.invoice_date, 'DD.MM.YYYY')
      using errcode = 'unique_violation';
  end if;
  return new;
end $$;

drop trigger if exists invoices_one_per_supplier_number on public.invoices;
create trigger invoices_one_per_supplier_number
  before insert or update of invoice_number, partner_id, company_id, type, deleted_at on public.invoices
  for each row execute function public.invoices_one_per_supplier_number();

revoke all on function public.invoices_one_per_supplier_number() from public, anon, authenticated;

commit;
