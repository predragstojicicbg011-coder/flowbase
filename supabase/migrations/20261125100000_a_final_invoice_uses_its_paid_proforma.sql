-- ============================================================================
-- A final invoice uses its paid proforma; a payment is never allocated beyond
-- itself
--
-- Ported from Mintflow's 20270112090000 and re-derived from FlowBase's own
-- latest bodies (FlowBase is where the advance chain began, and its chain is
-- wider: customer advances, advance invoices from an earlier period, the old
-- project advance, a proforma proposed from a statement payment).
--
-- WHAT THIS FILE CHANGES.
--
--   advance_usage_rules()            a final invoice may be closed by a PAID
--                                    PROFORMA directly, not only by an advance
--                                    invoice -- in BOTH directions, a supplier's
--                                    bill and our invoice to a customer (last
--                                    20261104110000)
--   advance_coverage_rules()         coverage counts what final invoices use of
--                                    the proforma directly (last 20261104110000)
--   proforma_keeps_its_payment()     the same, when a payment is unlinked
--                                    (last 20261021100000)
--   invoices_keep_advance_links()    a used proforma is not deleted and keeps
--                                    its type, partner, company, currency and
--                                    direction (last 20261027090000)
--   replace_advance_links()          a use may name `proforma_id` as well as
--                                    `advance_invoice_id` (last 20261021100000)
--   v_invoice_status                 one column more at the end: used_directly
--                                    (last 20261027090000)
--   v_supplier_advances              one column more at the end: used_directly;
--                                    paid_without_advance no longer counts it
--                                    (last 20261021090000)
--   v_customer_advances              the same for customers: used_directly;
--                                    received_without_advance no longer counts
--                                    it (last 20261104110000)
--   links_stay_within_their_payment  NEW: a link may not take a payment's
--                                    allocations beyond what it paid, nor a bill
--                                    an advance or a proforma closes beyond
--                                    what it owes
--
-- No table, no column of a table, no policy.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Many partners never issue an advance invoice: proforma, payment, final
-- invoice, in the same month. And FlowBase makes the case common: a statement
-- payment to a supplier with no proforma PROPOSES one (proformaFromPayment),
-- so paid proformas with no advance invoice are the normal case. The chain of
-- 20261021090000 knows only proforma -> advance invoice (advance_coverage) ->
-- final invoice (advance_usage); with no advance invoice the final invoice
-- could not be closed by the money already paid on the proforma.
--
-- ── THE SHAPE ──────────────────────────────────────────────────────────────
--
-- `advance_usage` keeps its columns. `advance_invoice_id` is the SOURCE of a
-- use: an advance invoice, as before, or now a proforma. No sibling table:
-- v_invoice_status already sums `advance_usage` for a final invoice whatever
-- the source -- `advance_used(_rsd, _eur)`, `amount_due`, the status, the
-- remaining figures, the credit-note limit, the amount limit,
-- invoices_project_or_chain_advance -- so the final invoice reads paid or
-- partial with no new arithmetic. The rules decide by the source's
-- document_type.
--
-- THE RULES, as for an advance invoice:
--
--   * a proforma is used only by a live final invoice ('invoice') of the same
--     direction, company, partner and currency, with no old project advance
--     (advance_deducted) on it;
--   * a proforma's PAID amount is shared: what advance invoices cover of it
--     plus what final invoices use of it directly is never more than what was
--     paid on it (asked by the use, by the coverage, and when a payment is
--     unlinked);
--   * the dinar and euro figures of a use are the final invoice's (unchanged
--     code);
--   * a final invoice's uses never exceed it with its credit notes, and a
--     credit note does not take it below them (unchanged code: both sum every
--     use, whatever the source);
--   * a bill is not paid twice: its uses plus the payments linked to it never
--     come to more than it owes (amount + credit notes), within the tolerance
--     v_invoice_status closes a bill by (one dinar, in the bill's currency).
--     Asked of a NEW or RAISED use only (a use that keeps or lowers the bill's
--     total passes), so a bill that stands over today can still be re-saved;
--     replace_advance_links tells the rule what the bill used before it
--     deleted and rewrote the uses (`flowbase.uses_before_<id>`,
--     transaction-local). The link guard asks the same from the payment side,
--     for a bill an advance or a proforma closes;
--   * a used proforma is not deleted, and keeps its type, partner, company,
--     currency and direction while it is used;
--   * links are replaced in one transaction (replace_advance_links).
--
-- The existing chain, proforma -> advance invoice -> final invoice, is left
-- exactly as it was: every branch for an advance invoice is the latest
-- FlowBase text, sentence for sentence.
--
-- ── THE THREE VIEWS ────────────────────────────────────────────────────────
--
-- v_invoice_status: every column of 20261027090000 in order, and at the end
-- `used_directly` -- for a proforma, what live final invoices use of it
-- directly; 0 for anything else. A form offers a proforma for direct use up
-- to paid_amount - covered - used_directly.
--
-- v_supplier_advances / v_customer_advances: every column in order, and at
-- the end `used_directly` per partner (and project) and currency.
-- `paid_without_advance` / `received_without_advance` is what was paid on
-- proformas that neither an advance invoice covers nor a final invoice uses
-- -- the money still waiting for a document.
--
-- EVERY EXISTING ROW READS EXACTLY AS BEFORE: no use has a proforma as its
-- source until this file is applied, so used_directly is 0 everywhere. All
-- three views are compared before and after, whole rows, every old column,
-- and the file rolls back on any difference (section I).
--
-- ── A PAYMENT IS NOT ALLOCATED BEYOND ITSELF ───────────────────────────────
--
-- Mintflow found one direct payment linked to two invoices, each link holding
-- the whole payment. FlowBase has the same hole: nothing in the database
-- stopped it, and ReconcilePanel offered a payment at its full amount whatever
-- it already paid (the panel is fixed in the same change). From now on a write
-- to a link is refused when it takes the payment's allocations ABOVE what it
-- paid AND above what they were before the write.
--
-- COUNTED IN THE BOOK CURRENCY (the owner's ruling, 2026-11-25), so a dinar
-- payment of a euro bill is counted too -- Mintflow skips such links. Each
-- link is counted in dinars AS THE PAYMENT SEES IT:
--
--   a link to an invoice in the PAYMENT'S currency  allocated_amount at the
--       payment's own rate (amount_rsd / amount; 1 for a dinar payment). Its
--       stored allocated_amount_rsd is at the INVOICE's rate, so a euro
--       payment that settles a euro bill to the cent would otherwise be over
--       or under by the rate move between the two dates -- that move is the
--       currency difference, booked as its own row, not an over-allocation;
--   a link to an invoice in ANOTHER currency  allocated_amount_rsd. That is
--       the figure settlementFor and allocateAcross hold against the payment's
--       dinars when the currencies differ, so it is in the payment's unit.
--
-- For a dinar payment (the common case) this is exactly sum(allocated_amount
-- _rsd) against amount_rsd. A foreign payment with no dinar figure (none
-- should exist; rates are required) counts its same-currency links only, in
-- its own currency, as Mintflow does.
--
--   counted   links to live, top-level invoices (a payroll child mirrors its
--             parent's share of the same payment and is not counted twice);
--   limit     |amount| in dinars, plus a para per counted link, in dinars:
--             of the PAYMENT's currency for a link in the payment's currency
--             (settlementFor finishes a bill within CLOSED_WITHIN), of the
--             INVOICE's currency for a link in another currency -- a part
--             payment there is written as own = round2(dinars / rate) and its
--             dinars as round2(own * rate), up to half a para of the invoice's
--             currency above what the payment paid (fix round 1: a 117.200 RSD
--             payment of a 1.000 EUR bill at 117,5 holds 997,45 EUR =
--             117.200,38 RSD);
--   when      after INSERT, and after UPDATE of allocated_amount,
--             allocated_amount_rsd, invoice_id or transaction_id. Never on
--             DELETE: a delete only lowers.
--
-- ONLY NEW AND CHANGED ROWS ARE ASKED, and a change that does not RAISE the
-- total is let through even on a payment that is already over: existing rows
-- are not checked at apply time and nothing that stands today is refused, and
-- the owner can still lower or remove the wrong link of an over-allocated
-- payment. Section I counts those payments and bills and says how many.
--
-- TWO WRITERS AT ONCE. Each check sums rows another transaction may be
-- writing at the same moment. The guard takes a transaction-scoped advisory
-- lock on the PAYMENT, and then on the BILL, before it sums: two links on one
-- payment, or two links on one bill, wait for each other, and the second
-- one's sum -- a new statement, so a new snapshot at READ COMMITTED, which is
-- what PostgREST runs -- sees the first writer's row. A USE and a LINK on one
-- bill are already serialized by row locks: the use rule takes the bill row
-- `for update`, the link's foreign key takes it `for key share`, and those
-- conflict. The use rule takes NO advisory lock: taken before its `for update`
-- it would wait in a circle with a link that already holds the key share and
-- wants the bill's advisory lock (40P01 -- Mintflow reproduced it).
--
-- ── NO PROBE ROWS ──────────────────────────────────────────────────────────
--
-- invoices, transactions and invoice_transaction_links are audited, and
-- audit_log.user_id references auth.users. Nothing below writes a row: the
-- checks read the catalogue and compare the views with themselves. The
-- behaviour is proved by supabase/tests/proforma_used_directly_test.sql on a
-- throwaway database built from empty. On an empty database (flowbase-demo)
-- every comparison is between two empty sets and passes; the counts say 0.
-- ============================================================================

-- A plain `begin`, as every FlowBase migration: the house test runs this file
-- inside its own `begin; ... rollback;`. A write committed by someone else
-- between the snapshot below and the comparison in section I can only make
-- the comparison see a difference and roll back -- never hide one.
begin;

set local lock_timeout = '3s';

-- ── 0. What this file stands on, asked before anything is replaced ─────────
do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'public.advance_usage_rules()', 'public.advance_coverage_rules()', 'public.proforma_keeps_its_payment()',
    'public.invoices_keep_advance_links()', 'public.replace_advance_links(uuid, jsonb, jsonb)'] loop
    if to_regprocedure(v_fn) is null then
      raise exception '% is not there, so this file would CREATE it rather than replace it. 20261021100000 / 20261104110000 have not been applied -- rolling back', v_fn;
    end if;
  end loop;
  if to_regclass('public.advance_usage') is null or to_regclass('public.advance_coverage') is null
     or to_regclass('public.v_invoice_status') is null or to_regclass('public.v_supplier_advances') is null
     or to_regclass('public.v_customer_advances') is null then
    raise exception 'the advance tables or views of 20261021090000 / 20261104110000 are not there -- rolling back';
  end if;
  if to_regprocedure('public.links_stay_within_their_payment()') is not null then
    -- A second apply: everything below is create-or-replace, nothing is lost.
    raise notice 'public.links_stay_within_their_payment() is already there; this is a second apply';
  end if;
end $$;

-- What every document and every partner line read before.
create temporary table proforma_use_status_before on commit drop as
  select v.id, to_jsonb(v) - 'used_directly' as row from public.v_invoice_status v;
create temporary table proforma_use_suppliers_before on commit drop as
  select to_jsonb(v) - 'used_directly' as row from public.v_supplier_advances v;
create temporary table proforma_use_customers_before on commit drop as
  select to_jsonb(v) - 'used_directly' as row from public.v_customer_advances v;

comment on column public.advance_usage.advance_invoice_id is
  'The source of the use: an advance invoice, or a paid proforma the final invoice uses directly (20261125100000).';

-- ── A. A use: an advance invoice, or a paid proforma ───────────────────────
create or replace function public.advance_usage_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fin record; v_av record; v_other numeric; v_notes numeric; v_paid numeric; v_cov numeric;
  v_paid_fin numeric; v_before numeric; v_tol numeric;
begin
  -- The bill's row lock serializes this use with a payment link on the same
  -- bill (whose foreign key takes the row `for key share`). No advisory lock
  -- here: see TWO WRITERS AT ONCE.
  select * into v_fin from public.invoices where id = new.final_invoice_id for update;
  select * into v_av from public.invoices where id = new.advance_invoice_id for update;
  if v_fin.id is null or v_fin.deleted_at is not null or v_fin.document_type <> 'invoice' or v_fin.type is distinct from v_av.type then
    raise exception 'Avans koristi samo živ račun istog smera, firme, partnera i valute.' using errcode = 'check_violation';
  end if;
  if v_av.id is null or v_av.deleted_at is not null or v_av.document_type not in ('advance_invoice', 'proforma') then
    raise exception 'Konačni račun se zatvara avansnim računom ili plaćenim predračunom.' using errcode = 'check_violation';
  end if;
  if v_fin.company_id is distinct from v_av.company_id or v_fin.partner_id is distinct from v_av.partner_id
     or v_fin.currency is distinct from v_av.currency then
    raise exception '% % nije istog %, firme i valute kao konačni račun.',
      case v_av.document_type when 'proforma' then 'Predračun' else 'Avansni račun' end, v_av.invoice_number,
      case v_av.type when 'revenue' then 'kupca' else 'dobavljača' end
      using errcode = 'check_violation';
  end if;
  if coalesce(v_fin.advance_deducted, 0) > 0 then
    if v_av.document_type = 'proforma' then
      raise exception 'Račun % već ima odbijen avans po projektu (stari način); predračun se na njega ne vezuje.', v_fin.invoice_number
        using errcode = 'check_violation';
    end if;
    raise exception 'Račun % već ima odbijen avans po projektu (stari način); avansni račun se na njega ne vezuje.', v_fin.invoice_number
      using errcode = 'check_violation';
  end if;
  if v_av.document_type = 'advance_invoice' then
    select coalesce(sum(u.amount), 0) into v_other
      from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
     where u.advance_invoice_id = v_av.id and u.id <> new.id;
    if v_other + new.amount > coalesce(v_av.amount, 0) + 0.005 then
      raise exception 'Od avansnog računa % (%) je ostalo %, a traži se %.', v_av.invoice_number, v_av.amount,
        coalesce(v_av.amount, 0) - v_other, new.amount using errcode = 'check_violation';
    end if;
  else
    -- A proforma: what was paid on it, less what advance invoices cover of it
    -- and what other final invoices use of it directly.
    select coalesce(sum(l.allocated_amount), 0) into v_paid
      from public.invoice_transaction_links l where l.invoice_id = v_av.id;
    select coalesce(sum(c.amount), 0) into v_cov
      from public.advance_coverage c join public.invoices a on a.id = c.advance_invoice_id and a.deleted_at is null
     where c.proforma_id = v_av.id;
    select coalesce(sum(u.amount), 0) into v_other
      from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
     where u.advance_invoice_id = v_av.id and u.id <> new.id;
    if v_cov + v_other + new.amount > v_paid + 0.005 then
      raise exception 'Po predračunu % je plaćeno %; avansnim računima je pokriveno %, a konačni računi koriste %, pa je ostalo %, a traži se %.',
        coalesce(v_av.invoice_number, 'bez broja'), v_paid, v_cov, v_other, greatest(v_paid - v_cov - v_other, 0), new.amount
        using errcode = 'check_violation';
    end if;
  end if;
  select coalesce(sum(a.amount), 0) into v_notes
    from public.invoices a where a.adjusts_invoice_id = v_fin.id and a.deleted_at is null and a.document_type = 'credit_note';
  select coalesce(sum(u.amount), 0) into v_other
    from public.advance_usage u where u.final_invoice_id = v_fin.id and u.id <> new.id;
  if v_other + new.amount > coalesce(v_fin.amount, 0) + v_notes + 0.005 then
    raise exception 'Iskorišćeni avans (%) je veći od konačnog računa % (%).', v_other + new.amount, v_fin.invoice_number,
      coalesce(v_fin.amount, 0) + v_notes using errcode = 'check_violation';
  end if;
  -- Not paid twice: the uses and the payments together, within the tolerance
  -- v_invoice_status closes a bill by (one dinar, in the bill's currency).
  -- Only a write that RAISES the uses is asked; what the bill used before is
  -- replace_advance_links' note, or the other rows plus this row's old amount.
  select coalesce(sum(l.allocated_amount), 0) into v_paid_fin
    from public.invoice_transaction_links l where l.invoice_id = v_fin.id;
  v_before := coalesce(nullif(current_setting('flowbase.uses_before_' || replace(v_fin.id::text, '-', ''), true), '')::numeric,
                       v_other + case when tg_op = 'UPDATE' and old.final_invoice_id = new.final_invoice_id then old.amount else 0 end);
  v_tol := greatest(0.01, round(1.00 * coalesce(v_fin.amount, 0) / nullif(v_fin.amount_rsd, 0), 2));
  if v_other + new.amount + v_paid_fin > coalesce(v_fin.amount, 0) + v_notes + v_tol
     and v_other + new.amount > v_before + 0.005 then
    raise exception 'Račun % duguje %, plaćanja već drže %, a iskorišćeni avansi bi bili % — bio bi plaćen dva puta. Smanjite iskorišćeni iznos ili prvo odvežite plaćanje.',
      coalesce(v_fin.invoice_number, 'bez broja'), coalesce(v_fin.amount, 0) + v_notes, v_paid_fin, v_other + new.amount
      using errcode = 'check_violation';
  end if;
  -- The final invoice's book figures, so a bill closed by an advance closes to the dinar.
  new.amount_rsd := case when coalesce(v_fin.amount, 0) <> 0 and v_fin.amount_rsd is not null
                         then round(new.amount * v_fin.amount_rsd / v_fin.amount, 2) end;
  new.amount_eur := case when coalesce(v_fin.amount, 0) <> 0 and v_fin.amount_eur is not null
                         then round(new.amount * v_fin.amount_eur / v_fin.amount, 2) end;
  return new;
end $$;

-- ── B. Coverage counts the direct use ──────────────────────────────────────
create or replace function public.advance_coverage_rules()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_av record; v_pf record; v_paid numeric; v_other numeric; v_direct numeric;
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
  select coalesce(sum(u.amount), 0) into v_direct
    from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
   where u.advance_invoice_id = v_pf.id;
  if v_other + v_direct + new.amount > v_paid + 0.005 then
    if v_direct > 0 then
      raise exception 'Po predračunu % je plaćeno %; konačni računi koriste % direktno, a avansnim računima bi bilo pokriveno %.',
        v_pf.invoice_number, v_paid, v_direct, v_other + new.amount using errcode = 'check_violation';
    end if;
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

-- ── C. A proforma's payment stays while it is covered or used ──────────────
create or replace function public.proforma_keeps_its_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_pf record; v_paid numeric; v_cov numeric; v_direct numeric;
begin
  -- The proforma's row first (fix round 1): a use takes it `for update`
  -- (advance_usage_rules), so an unlink and a use of one proforma wait for
  -- each other and the second one's sums see the first one's write.
  select * into v_pf from public.invoices where id = old.invoice_id for update;
  if v_pf.id is null or v_pf.document_type <> 'proforma' then
    return null;
  end if;
  select coalesce(sum(l.allocated_amount), 0) into v_paid from public.invoice_transaction_links l where l.invoice_id = v_pf.id;
  select coalesce(sum(c.amount), 0) into v_cov
    from public.advance_coverage c join public.invoices a on a.id = c.advance_invoice_id and a.deleted_at is null
   where c.proforma_id = v_pf.id;
  select coalesce(sum(u.amount), 0) into v_direct
    from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
   where u.advance_invoice_id = v_pf.id;
  if v_cov + v_direct > v_paid + 0.005 then
    if v_direct > 0 then
      raise exception 'Predračun % je iskorišćen: avansnim računima je pokriveno %, konačni računi koriste % direktno, a plaćeno bi ostalo %. Prvo ih odvežite.',
        v_pf.invoice_number, v_cov, v_direct, v_paid using errcode = 'check_violation';
    end if;
    raise exception 'Po predračunu % je avansnim računima pokriveno %, a plaćeno bi ostalo %. Prvo odvežite avansni račun.', v_pf.invoice_number, v_cov, v_paid
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

-- ── D. Keeping the chain: a used proforma ──────────────────────────────────
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
    if old.document_type = 'proforma'
       and exists (select 1 from public.advance_usage u join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
                    where u.advance_invoice_id = old.id) then
      raise exception 'Predračun % koristi konačni račun i ne briše se. Prvo uklonite vezu.', old.invoice_number
        using errcode = 'check_violation';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- What the document is linked to.
  v_linked := case old.document_type
    when 'advance_invoice' then exists (select 1 from public.advance_usage u where u.advance_invoice_id = old.id)
                              or exists (select 1 from public.advance_coverage c where c.advance_invoice_id = old.id)
    when 'proforma' then exists (select 1 from public.advance_coverage c where c.proforma_id = old.id)
                      or exists (select 1 from public.advance_usage u where u.advance_invoice_id = old.id)
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

-- ── E. Links replaced in one transaction, with the caller's own rights ─────
-- A use names its source as `advance_invoice_id` (as before) or `proforma_id`.
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
    -- What the bill used before, for advance_usage_rules: re-writing the same
    -- uses (or fewer) is not a raise.
    perform set_config('flowbase.uses_before_' || replace(p_invoice::text, '-', ''),
      (select coalesce(sum(u.amount), 0) from public.advance_usage u where u.final_invoice_id = p_invoice)::text, true);
    delete from public.advance_usage where final_invoice_id = p_invoice;
    insert into public.advance_usage (final_invoice_id, advance_invoice_id, amount)
    select p_invoice, coalesce(e ->> 'advance_invoice_id', e ->> 'proforma_id')::uuid, (e ->> 'amount')::numeric
      from jsonb_array_elements(p_usage) e;
    perform set_config('flowbase.uses_before_' || replace(p_invoice::text, '-', ''), '', true);
  end if;
end $$;

-- ── F. v_invoice_status: 20261027090000's columns, and used_directly ───────
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
    cov.covered,
    direct.used_directly
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
       select coalesce(sum(u.amount), 0::numeric) as used_directly
         from public.advance_usage u
         join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
        where u.advance_invoice_id = i.id
          and i.document_type = 'proforma') direct
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

-- `create or replace view` replaces the options with the ones it names; said
-- again, so it cannot depend on that.
alter view public.v_invoice_status set (security_invoker = on);
revoke all on public.v_invoice_status from anon;
grant all on public.v_invoice_status to authenticated, service_role;

-- ── G. v_supplier_advances: used directly, and paid without a document ─────
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
                   filter (where d.document_type = 'advance_invoice'), 0) as used,
          coalesce(sum((select coalesce(sum(u.amount), 0) from public.advance_usage u
                          join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
                         where u.advance_invoice_id = d.id))
                   filter (where d.document_type = 'proforma'), 0) as used_directly
     from docs d
    group by d.company_id, d.partner_id, d.currency
 )
 select s.company_id, s.partner_id, p.name as partner_name, s.currency,
        s.paid_on_proformas, s.covered, s.advance_total, s.used,
        s.paid_on_proformas - s.covered - s.used_directly as paid_without_advance,
        s.advance_total - s.used as advance_open,
        s.used_directly
   from sums s
   left join public.partners p on p.id = s.partner_id;

alter view public.v_supplier_advances set (security_invoker = on);
revoke all on public.v_supplier_advances from anon;
grant select on public.v_supplier_advances to authenticated, service_role;

-- ── H. v_customer_advances: the same for customers, per project ────────────
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
                   filter (where d.document_type = 'advance_invoice'), 0) as used,
          coalesce(sum((select coalesce(sum(u.amount), 0) from public.advance_usage u
                          join public.invoices f on f.id = u.final_invoice_id and f.deleted_at is null
                         where u.advance_invoice_id = d.id))
                   filter (where d.document_type = 'proforma'), 0) as used_directly
     from docs d
    group by d.company_id, d.partner_id, d.project_id, d.currency
 )
 select s.company_id, s.partner_id, p.name as partner_name, s.project_id, pr.name as project_name, s.currency,
        s.received_on_proformas, s.covered, s.advance_total, s.used,
        s.received_on_proformas - s.covered - s.used_directly as received_without_advance,
        s.advance_total - s.used as advance_open,
        s.used_directly
   from sums s
   left join public.partners p on p.id = s.partner_id
   left join public.projects pr on pr.id = s.project_id;

alter view public.v_customer_advances set (security_invoker = on);
revoke all on public.v_customer_advances from anon;
grant select on public.v_customer_advances to authenticated, service_role;

-- ── H2. A payment is not allocated beyond itself ───────────────────────────
-- The lock comes first: two writers on one payment wait for each other, and
-- the sums below are new statements, so the second sees the first's row.
create or replace function public.links_stay_within_their_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx      record;
  v_inv     record;
  v_rate    numeric;   -- dinars per unit of the payment's currency; null: a foreign payment with no dinar figure
  v_unit    numeric;
  v_total   numeric;
  v_slack   numeric;
  v_mine    numeric := 0;
  v_was     numeric := 0;
  v_before  numeric;
  v_limit   numeric;
  v_others  text;
  v_uses    numeric;
  v_notes   numeric;
  v_paid    numeric;
  v_tol     numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('flowbase.payment.' || new.transaction_id::text, 0));

  -- ── The payment side, in dinars as the payment sees each link ──
  select t.id, t.amount, t.amount_rsd, t.currency, t.transaction_date, t.deleted_at into v_tx
    from public.transactions t where t.id = new.transaction_id;
  if v_tx.id is not null and v_tx.deleted_at is null and coalesce(v_tx.amount, 0) <> 0 then
    v_rate := case when coalesce(v_tx.currency, 'RSD') = 'RSD' then 1
                   when coalesce(v_tx.amount_rsd, 0) <> 0 then abs(v_tx.amount_rsd / v_tx.amount) end;
    v_unit := coalesce(v_rate, 1);
    -- Counted: links of this payment to live, top-level invoices. A link in
    -- the payment's currency at the payment's rate; a link in another
    -- currency at its own dinar figure (none when the payment has no rate).
    -- The slack: a para per counted link, of the payment's currency for a
    -- same-currency link, of the invoice's currency (at the link's own rate)
    -- for a link in another currency.
    select coalesce(sum(case when coalesce(i.currency, 'RSD') = coalesce(v_tx.currency, 'RSD') then l.allocated_amount * v_unit
                             when v_rate is not null then l.allocated_amount_rsd end), 0),
           coalesce(sum(case when coalesce(i.currency, 'RSD') = coalesce(v_tx.currency, 'RSD') then greatest(0.01, 0.01 * v_unit)
                             when v_rate is not null and l.allocated_amount_rsd is not null
                             then greatest(0.01, 0.01 * coalesce(abs(l.allocated_amount_rsd / nullif(l.allocated_amount, 0)), 0)) end), 0)
      into v_total, v_slack
      from public.invoice_transaction_links l
      join public.invoices i on i.id = l.invoice_id
     where l.transaction_id = v_tx.id
       and i.deleted_at is null and i.parent_invoice_id is null;

    v_limit := abs(v_tx.amount) * v_unit + v_slack + 0.005;
    if abs(v_total) > v_limit then
      -- What this write changed of that total: the new row's share, less the
      -- old row's where it was on the same payment.
      select coalesce(case when coalesce(i.currency, 'RSD') = coalesce(v_tx.currency, 'RSD') then new.allocated_amount * v_unit
                           when v_rate is not null then new.allocated_amount_rsd end, 0)
        into v_mine
        from public.invoices i
       where i.id = new.invoice_id and i.deleted_at is null and i.parent_invoice_id is null;
      v_mine := coalesce(v_mine, 0);
      if tg_op = 'UPDATE' and old.transaction_id = new.transaction_id then
        select coalesce(case when coalesce(i.currency, 'RSD') = coalesce(v_tx.currency, 'RSD') then old.allocated_amount * v_unit
                             when v_rate is not null then old.allocated_amount_rsd end, 0)
          into v_was
          from public.invoices i
         where i.id = old.invoice_id and i.deleted_at is null and i.parent_invoice_id is null;
        v_was := coalesce(v_was, 0);
      end if;
      v_before := v_total - v_mine + v_was;
      -- Already over before this write, and not raised by it: lowering or
      -- re-saving a link of an over-allocated payment stays possible.
      if abs(v_total) > abs(v_before) + 0.005 then
        select string_agg(coalesce(i.invoice_number, 'bez broja') || ' (' || l.allocated_amount::text || ' ' || coalesce(i.currency, 'RSD') || ')', ', '
                          order by i.invoice_number)
          into v_others
          from public.invoice_transaction_links l
          join public.invoices i on i.id = l.invoice_id
         where l.transaction_id = v_tx.id and l.id <> new.id
           and i.deleted_at is null and i.parent_invoice_id is null;
        raise exception 'Plaćanje od % % (%) bilo bi raspoređeno % RSD, a vredi % RSD — više nego što je plaćeno. Već plaća: %. Smanjite raspodelu ili prvo uklonite vezu.',
          abs(v_tx.amount), coalesce(v_tx.currency, 'RSD'), to_char(v_tx.transaction_date, 'DD.MM.YYYY'),
          round(abs(v_total), 2), round(abs(v_tx.amount) * v_unit, 2), coalesce(v_others, 'ništa drugo')
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- ── The bill side: a bill an advance or a proforma closes is not paid twice ──
  perform pg_advisory_xact_lock(hashtextextended('flowbase.invoice.' || new.invoice_id::text, 0));
  select coalesce(sum(u.amount), 0) into v_uses from public.advance_usage u where u.final_invoice_id = new.invoice_id;
  if v_uses > 0 then
    select i.id, i.invoice_number, i.amount, i.amount_rsd into v_inv from public.invoices i where i.id = new.invoice_id;
    select coalesce(sum(a.amount), 0) into v_notes
      from public.invoices a where a.adjusts_invoice_id = new.invoice_id and a.deleted_at is null and a.document_type = 'credit_note';
    select coalesce(sum(l.allocated_amount), 0) into v_paid from public.invoice_transaction_links l where l.invoice_id = new.invoice_id;
    v_tol := greatest(0.01, round(1.00 * coalesce(v_inv.amount, 0) / nullif(v_inv.amount_rsd, 0), 2));
    v_before := v_paid - coalesce(new.allocated_amount, 0)
      + case when tg_op = 'UPDATE' and old.invoice_id = new.invoice_id then coalesce(old.allocated_amount, 0) else 0 end;
    if v_uses + v_paid > coalesce(v_inv.amount, 0) + v_notes + v_tol and v_paid > v_before + 0.005 then
      raise exception 'Račun % duguje %, a avansni računi ili predračuni već zatvaraju % od toga; plaćanja bi držala % — bio bi plaćen dva puta. Smanjite plaćanje ili prvo uklonite korišćenje avansa.',
        coalesce(v_inv.invoice_number, 'bez broja'), coalesce(v_inv.amount, 0) + v_notes, v_uses, v_paid
        using errcode = 'check_violation';
    end if;
  end if;
  return null;
end $$;

drop trigger if exists links_stay_within_their_payment on public.invoice_transaction_links;
create trigger links_stay_within_their_payment
  after insert or update of allocated_amount, allocated_amount_rsd, invoice_id, transaction_id on public.invoice_transaction_links
  for each row execute function public.links_stay_within_their_payment();

revoke all on function public.links_stay_within_their_payment() from public, anon, authenticated;
revoke all on function public.advance_coverage_rules(), public.advance_usage_rules(),
  public.invoices_keep_advance_links(), public.proforma_keeps_its_payment() from public, anon, authenticated;
revoke all on function public.replace_advance_links(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.replace_advance_links(uuid, jsonb, jsonb) to authenticated, service_role;

-- ── I. Checks ──────────────────────────────────────────────────────────────
do $$
declare
  v_changed  text;
  v_n        int;
  v_m        int;
  v_src      text;
  v_cfg      text[];
  v_fn       text;
  v_cols     text[];
  r          record;
begin
  -- 1. Every document reads exactly as before, every old column.
  select string_agg(b.id::text, ', '), count(*) into v_changed, v_n
    from proforma_use_status_before b
    left join public.v_invoice_status a on a.id = b.id
   where a.id is null or (to_jsonb(a) - 'used_directly') is distinct from b.row;
  if v_changed is not null then
    raise exception '% document(s) would read differently in v_invoice_status: % -- rolling back', v_n, v_changed;
  end if;
  if (select count(*) from public.v_invoice_status) <> (select count(*) from proforma_use_status_before) then
    raise exception 'v_invoice_status would hold a different number of rows -- rolling back';
  end if;
  if exists (select 1 from public.v_invoice_status v where v.used_directly is null or (v.document_type <> 'proforma' and v.used_directly <> 0)) then
    raise exception 'v_invoice_status.used_directly is null somewhere, or not 0 on a document that is not a proforma -- rolling back';
  end if;

  -- 2. Every supplier and customer line reads exactly as before.
  if exists (select 1 from proforma_use_suppliers_before b
              where not exists (select 1 from public.v_supplier_advances a where (to_jsonb(a) - 'used_directly') = b.row))
     or (select count(*) from public.v_supplier_advances) <> (select count(*) from proforma_use_suppliers_before)
     or exists (select 1 from public.v_supplier_advances a where a.used_directly is null) then
    raise exception 'v_supplier_advances would read differently, hold a different number of lines, or a line with no used_directly -- rolling back';
  end if;
  if exists (select 1 from proforma_use_customers_before b
              where not exists (select 1 from public.v_customer_advances a where (to_jsonb(a) - 'used_directly') = b.row))
     or (select count(*) from public.v_customer_advances) <> (select count(*) from proforma_use_customers_before)
     or exists (select 1 from public.v_customer_advances a where a.used_directly is null) then
    raise exception 'v_customer_advances would read differently, hold a different number of lines, or a line with no used_directly -- rolling back';
  end if;

  -- 3. The views: invoker, anon shut out, and the new column LAST (every old
  --    column kept in place).
  foreach v_fn in array array['v_invoice_status', 'v_supplier_advances', 'v_customer_advances'] loop
    if not coalesce((select option_value::boolean from pg_class c join pg_namespace n on n.oid = c.relnamespace,
                       pg_options_to_table(c.reloptions) where n.nspname = 'public' and c.relname = v_fn
                       and option_name = 'security_invoker'), false) then
      raise exception 'public.% lost security_invoker -- rolling back', v_fn;
    end if;
    select array_agg(a.attname::text order by a.attnum) into v_cols
      from pg_attribute a where a.attrelid = ('public.' || v_fn)::regclass and a.attnum > 0 and not a.attisdropped;
    if v_cols[array_length(v_cols, 1)] <> 'used_directly' then
      raise exception 'public.%''s last column is %, not used_directly -- rolling back', v_fn, v_cols[array_length(v_cols, 1)];
    end if;
    if has_table_privilege('anon', 'public.' || v_fn, 'select') or not has_table_privilege('authenticated', 'public.' || v_fn, 'select') then
      raise exception 'public.% is readable by anon, or not by authenticated -- rolling back', v_fn;
    end if;
  end loop;

  -- 4. The rules, by what their bodies say. The behaviour is proved by the
  --    test file on a throwaway database (no probe rows here); these hold its
  --    shape in place.
  foreach v_fn in array array['advance_usage_rules', 'advance_coverage_rules', 'proforma_keeps_its_payment',
                              'invoices_keep_advance_links', 'links_stay_within_their_payment'] loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = v_fn) <> 1 then
      raise exception 'public.% is not exactly one function -- rolling back', v_fn;
    end if;
    select p.prosrc, p.proconfig into v_src, v_cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prosecdef;
    if v_src is null then
      raise exception 'public.% is not security definer, so it would sum only the rows the caller may see -- rolling back', v_fn;
    end if;
    if v_cfg is null or not exists (select 1 from unnest(v_cfg) x where x like 'search_path=public%') then
      raise exception 'public.% resolves names through the caller''s search_path -- rolling back', v_fn;
    end if;
  end loop;

  select prosrc into v_src from pg_proc where oid = 'public.advance_usage_rules()'::regprocedure;
  if v_src !~ 'document_type\s+not\s+in\s+\(''advance_invoice'',\s*''proforma''\)' then
    raise exception 'advance_usage_rules does not admit a proforma as the source of a use -- rolling back';
  end if;
  if v_src !~ 'v_fin\.type\s+is\s+distinct\s+from\s+v_av\.type'
     or v_src !~ 'if\s+coalesce\(v_fin\.advance_deducted,\s*0\)\s*>\s*0\s+then' then
    raise exception 'advance_usage_rules lost the direction rule or the old project advance rule of 20261104110000 -- rolling back';
  end if;
  if v_src !~ 'from\s+public\.invoice_transaction_links\s+l\s+where\s+l\.invoice_id\s*=\s*v_av\.id'
     or v_src !~ 'from\s+public\.advance_coverage\s+c\s+join\s+public\.invoices\s+a\s+on\s+a\.id\s*=\s*c\.advance_invoice_id\s+and\s+a\.deleted_at\s+is\s+null\s+where\s+c\.proforma_id\s*=\s*v_av\.id'
     or v_src !~ 'if\s+v_cov\s*\+\s*v_other\s*\+\s*new\.amount\s*>\s*v_paid\s*\+\s*0\.005\s+then\s+raise' then
    raise exception 'advance_usage_rules does not hold a proforma''s use to what was paid on it, less what advance invoices cover and other final invoices use -- rolling back';
  end if;
  if v_src ~ 'pg_advisory'
     or v_src !~ '^\s*declare.*begin\s+(--[^\n]*\n\s*)*select\s+\*\s+into\s+v_fin\s+from\s+public\.invoices\s+where\s+id\s*=\s*new\.final_invoice_id\s+for\s+update;'
     or v_src !~ 'if\s+v_other\s*\+\s*new\.amount\s*\+\s*v_paid_fin\s*>\s*coalesce\(v_fin\.amount,\s*0\)\s*\+\s*v_notes\s*\+\s*v_tol\s+and\s+v_other\s*\+\s*new\.amount\s*>\s*v_before\s*\+\s*0\.005\s+then'
     or v_src !~ 'from\s+public\.invoice_transaction_links\s+l\s+where\s+l\.invoice_id\s*=\s*v_fin\.id'
     or v_src !~ 'v_tol\s*:=\s*greatest\(0\.01,\s*round\(1\.00\s*\*\s*coalesce\(v_fin\.amount,\s*0\)\s*/\s*nullif\(v_fin\.amount_rsd,\s*0\),\s*2\)\);'
     or v_src !~ 'current_setting\(''flowbase\.uses_before_''' then
    raise exception 'advance_usage_rules does not keep a bill from being paid twice (the bill row locked first and no advisory lock -- which would deadlock with a link -- uses + payments within what it owes to the dinar, or a re-save of what stands) -- rolling back';
  end if;
  if v_src !~ 'if\s+v_other\s*\+\s*new\.amount\s*>\s*coalesce\(v_av\.amount,\s*0\)\s*\+\s*0\.005\s+then\s+raise'
     or v_src !~ 'if\s+v_other\s*\+\s*new\.amount\s*>\s*coalesce\(v_fin\.amount,\s*0\)\s*\+\s*v_notes\s*\+\s*0\.005\s+then\s+raise'
     or v_src !~ 'round\(new\.amount\s*\*\s*v_fin\.amount_rsd\s*/\s*v_fin\.amount,\s*2\)'
     or v_src !~ 'round\(new\.amount\s*\*\s*v_fin\.amount_eur\s*/\s*v_fin\.amount,\s*2\)' then
    raise exception 'advance_usage_rules lost a rule of 20261104110000 (the advance invoice''s limit, the final invoice''s limit or its book figures) -- rolling back';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.advance_coverage_rules()'::regprocedure;
  if v_src !~ 'from\s+public\.advance_usage\s+u\s+join\s+public\.invoices\s+f\s+on\s+f\.id\s*=\s*u\.final_invoice_id\s+and\s+f\.deleted_at\s+is\s+null\s+where\s+u\.advance_invoice_id\s*=\s*v_pf\.id'
     or v_src !~ 'if\s+v_other\s*\+\s*v_direct\s*\+\s*new\.amount\s*>\s*v_paid\s*\+\s*0\.005\s+then' then
    raise exception 'advance_coverage_rules does not count what final invoices use of the proforma directly, so coverage + direct use could exceed what was paid -- rolling back';
  end if;
  if v_src !~ 'if\s+v_av\.type\s+is\s+distinct\s+from\s+v_pf\.type\s+then' or v_src !~ 'if\s+v_av\.prior_period\s+then' then
    raise exception 'advance_coverage_rules lost the direction rule or the earlier-period rule of 20261104110000 -- rolling back';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.proforma_keeps_its_payment()'::regprocedure;
  if v_src !~ 'select\s+\*\s+into\s+v_pf\s+from\s+public\.invoices\s+where\s+id\s*=\s*old\.invoice_id\s+for\s+update;' then
    raise exception 'proforma_keeps_its_payment does not lock the proforma row before it sums, so an unlink and a use at once could both pass -- rolling back';
  end if;
  if v_src !~ 'from\s+public\.advance_usage\s+u\s+join\s+public\.invoices\s+f\s+on\s+f\.id\s*=\s*u\.final_invoice_id\s+and\s+f\.deleted_at\s+is\s+null\s+where\s+u\.advance_invoice_id\s*=\s*v_pf\.id'
     or v_src !~ 'if\s+v_cov\s*\+\s*v_direct\s*>\s*v_paid\s*\+\s*0\.005\s+then' then
    raise exception 'proforma_keeps_its_payment does not count the direct use, so a used proforma''s payment could be unlinked -- rolling back';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.invoices_keep_advance_links()'::regprocedure;
  if v_src !~ 'when\s+''proforma''\s+then\s+exists\s+\(select\s+1\s+from\s+public\.advance_coverage\s+c\s+where\s+c\.proforma_id\s*=\s*old\.id\)\s+or\s+exists\s+\(select\s+1\s+from\s+public\.advance_usage\s+u\s+where\s+u\.advance_invoice_id\s*=\s*old\.id\)'
     or v_src !~ 'old\.document_type\s*=\s*''proforma''\s+and\s+exists\s+\(select\s+1\s+from\s+public\.advance_usage\s+u' then
    raise exception 'invoices_keep_advance_links does not keep a used proforma (its type, partner, company, currency, direction, or its deletion) -- rolling back';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.replace_advance_links(uuid, jsonb, jsonb)'::regprocedure;
  if (select prosecdef from pg_proc where oid = 'public.replace_advance_links(uuid, jsonb, jsonb)'::regprocedure) then
    raise exception 'replace_advance_links became security definer; it writes with the caller''s own rights (20261021100000) -- rolling back';
  end if;
  if v_src !~ 'coalesce\(e\s*->>\s*''advance_invoice_id'',\s*e\s*->>\s*''proforma_id''\)' then
    raise exception 'replace_advance_links does not take a proforma_id in a use -- rolling back';
  end if;
  if v_src !~ 'set_config\(''flowbase\.uses_before_''\s*\|\|\s*replace\(p_invoice::text,\s*''-'',\s*''''\),\s*\(select\s+coalesce\(sum\(u\.amount\),\s*0\)\s+from\s+public\.advance_usage\s+u\s+where\s+u\.final_invoice_id\s*=\s*p_invoice\)::text,\s*true\);\s*delete\s+from\s+public\.advance_usage' then
    raise exception 'replace_advance_links does not note what the bill used before it deletes the uses, so re-saving a bill that stands would be refused -- rolling back';
  end if;

  select prosrc into v_src from pg_proc where oid = 'public.links_stay_within_their_payment()'::regprocedure;
  if v_src !~ 'select\s+coalesce\(sum\(case\s+when\s+coalesce\(i\.currency,\s*''RSD''\)\s*=\s*coalesce\(v_tx\.currency,\s*''RSD''\)\s+then\s+l\.allocated_amount\s*\*\s*v_unit\s+when\s+v_rate\s+is\s+not\s+null\s+then\s+l\.allocated_amount_rsd\s+end\),\s*0\),'
     or v_src !~ 'into\s+v_total,\s*v_slack\s+from\s+public\.invoice_transaction_links\s+l\s+join\s+public\.invoices\s+i\s+on\s+i\.id\s*=\s*l\.invoice_id\s+where\s+l\.transaction_id\s*=\s*v_tx\.id\s+and\s+i\.deleted_at\s+is\s+null\s+and\s+i\.parent_invoice_id\s+is\s+null;'
     or v_src !~ 'then\s+greatest\(0\.01,\s*0\.01\s*\*\s*v_unit\)\s+when\s+v_rate\s+is\s+not\s+null\s+and\s+l\.allocated_amount_rsd\s+is\s+not\s+null\s+then\s+greatest\(0\.01,\s*0\.01\s*\*\s*coalesce\(abs\(l\.allocated_amount_rsd\s*/\s*nullif\(l\.allocated_amount,\s*0\)\),\s*0\)\)\s+end\),\s*0\)\s+into\s+v_total'
     or v_src !~ 'v_rate\s*:=\s*case\s+when\s+coalesce\(v_tx\.currency,\s*''RSD''\)\s*=\s*''RSD''\s+then\s+1\s+when\s+coalesce\(v_tx\.amount_rsd,\s*0\)\s*<>\s*0\s+then\s+abs\(v_tx\.amount_rsd\s*/\s*v_tx\.amount\)\s+end;'
     or v_src !~ 'v_limit\s*:=\s*abs\(v_tx\.amount\)\s*\*\s*v_unit\s*\+\s*v_slack\s*\+\s*0\.005;\s*if\s+abs\(v_total\)\s*>\s*v_limit\s+then'
     or v_src !~ 'if\s+abs\(v_total\)\s*>\s*abs\(v_before\)\s*\+\s*0\.005\s+then\s+select\s+string_agg'
     or v_src !~ 'raise\s+exception\s+''Plaćanje od' then
    raise exception 'links_stay_within_their_payment does not hold a payment''s links, in dinars as the payment sees them, to what it paid -- rolling back';
  end if;
  if v_src !~ '^\s*declare.*begin\s+perform\s+pg_advisory_xact_lock\(hashtextextended\(''flowbase\.payment\.''\s*\|\|\s*new\.transaction_id::text,\s*0\)\);' then
    raise exception 'links_stay_within_their_payment does not lock the payment before it sums, so two writers at once could both pass -- rolling back';
  end if;
  if v_src !~ 'perform\s+pg_advisory_xact_lock\(hashtextextended\(''flowbase\.invoice\.''\s*\|\|\s*new\.invoice_id::text,\s*0\)\);\s*select\s+coalesce\(sum\(u\.amount\),\s*0\)\s+into\s+v_uses'
     or v_src !~ 'v_tol\s*:=\s*greatest\(0\.01,\s*round\(1\.00\s*\*\s*coalesce\(v_inv\.amount,\s*0\)\s*/\s*nullif\(v_inv\.amount_rsd,\s*0\),\s*2\)\);'
     or v_src !~ 'if\s+v_uses\s*\+\s*v_paid\s*>\s*coalesce\(v_inv\.amount,\s*0\)\s*\+\s*v_notes\s*\+\s*v_tol\s+and\s+v_paid\s*>\s*v_before\s*\+\s*0\.005\s+then' then
    raise exception 'links_stay_within_their_payment does not keep a bill an advance or a proforma closes from being paid twice -- rolling back';
  end if;

  -- 5. The triggers, on, at the right moment.
  for r in select * from (values
      ('advance_usage',             'advance_usage_rules',             'BEFORE', array['INSERT', 'UPDATE']),
      ('advance_coverage',          'advance_coverage_rules',          'BEFORE', array['INSERT', 'UPDATE']),
      ('invoice_transaction_links', 'proforma_keeps_its_payment',      'AFTER',  array['DELETE', 'UPDATE']),
      ('invoices',                  'invoices_keep_advance_links',     'BEFORE', array['DELETE', 'UPDATE']),
      ('invoice_transaction_links', 'links_stay_within_their_payment', 'AFTER',  array['INSERT', 'UPDATE']))
      as t(tbl, fn, timing, events) loop
    if not exists (
         select 1 from pg_trigger g
           join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = r.tbl and g.tgfoid = ('public.' || r.fn || '()')::regprocedure
            and g.tgenabled in ('O', 'A') and not g.tgisinternal
            and (g.tgtype & 1) = 1                                             -- for each row
            and ((g.tgtype & 2) = 2) = (r.timing = 'BEFORE')
            and ((g.tgtype & 4) = 4) = ('INSERT' = any (r.events))
            and ((g.tgtype & 8) = 8) = ('DELETE' = any (r.events))
            and ((g.tgtype & 16) = 16) = ('UPDATE' = any (r.events))) then
      raise exception 'public.% has no enabled % row trigger running public.%() on % -- rolling back', r.tbl, r.timing, r.fn, r.events;
    end if;
  end loop;
  if (select count(*) from pg_trigger g where g.tgrelid = 'public.invoice_transaction_links'::regclass
        and g.tgfoid = 'public.links_stay_within_their_payment()'::regprocedure) <> 1 then
    raise exception 'public.links_stay_within_their_payment() runs from more or fewer than one trigger -- rolling back';
  end if;
  if (select array_agg(a.attname::text order by a.attname) from pg_trigger g
        join pg_attribute a on a.attrelid = g.tgrelid and a.attnum = any (g.tgattr::int2[])
       where g.tgrelid = 'public.invoice_transaction_links'::regclass
         and g.tgfoid = 'public.links_stay_within_their_payment()'::regprocedure)
     is distinct from array['allocated_amount', 'allocated_amount_rsd', 'invoice_id', 'transaction_id'] then
    raise exception 'the payment guard does not run on an update of allocated_amount, allocated_amount_rsd, invoice_id and transaction_id -- rolling back';
  end if;
  if has_function_privilege('authenticated', 'public.links_stay_within_their_payment()', 'execute')
     or has_function_privilege('anon', 'public.links_stay_within_their_payment()', 'execute') then
    raise exception 'public.links_stay_within_their_payment() is executable by a signed-in caller or anon -- rolling back';
  end if;
  if not has_function_privilege('authenticated', 'public.replace_advance_links(uuid, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.replace_advance_links(uuid, jsonb, jsonb)', 'execute') then
    raise exception 'public.replace_advance_links is not executable by authenticated, or is by anon -- rolling back';
  end if;

  -- 6. What stands today and is not refused: payments already allocated
  --    beyond what they paid, and bills held beyond what they owe, counted as
  --    the guards count. The same two queries the owner runs before the push.
  select count(*) into v_n from (
    select t.id
      from public.transactions t
      join public.invoice_transaction_links l on l.transaction_id = t.id
      join public.invoices i on i.id = l.invoice_id
      cross join lateral (select case when coalesce(t.currency, 'RSD') = 'RSD' then 1
                                      when coalesce(t.amount_rsd, 0) <> 0 then abs(t.amount_rsd / t.amount) end as rate) x
     where t.deleted_at is null and coalesce(t.amount, 0) <> 0
       and i.deleted_at is null and i.parent_invoice_id is null
     group by t.id, t.amount, x.rate
    having abs(coalesce(sum(case when coalesce(i.currency, 'RSD') = coalesce(t.currency, 'RSD') then l.allocated_amount * coalesce(x.rate, 1)
                                 when x.rate is not null then l.allocated_amount_rsd end), 0))
           > abs(t.amount) * coalesce(x.rate, 1)
             + coalesce(sum(case when coalesce(i.currency, 'RSD') = coalesce(t.currency, 'RSD') then greatest(0.01, 0.01 * coalesce(x.rate, 1))
                                 when x.rate is not null and l.allocated_amount_rsd is not null
                                 then greatest(0.01, 0.01 * coalesce(abs(l.allocated_amount_rsd / nullif(l.allocated_amount, 0)), 0)) end), 0)
             + 0.005) y;
  select count(*) into v_m from (
    select f.id
      from public.invoices f
     where f.deleted_at is null and f.document_type = 'invoice'
       and exists (select 1 from public.advance_usage u where u.final_invoice_id = f.id)
       and (select coalesce(sum(u.amount), 0) from public.advance_usage u where u.final_invoice_id = f.id)
         + (select coalesce(sum(l.allocated_amount), 0) from public.invoice_transaction_links l where l.invoice_id = f.id)
         > coalesce(f.amount, 0)
         + (select coalesce(sum(a.amount), 0) from public.invoices a where a.adjusts_invoice_id = f.id and a.deleted_at is null and a.document_type = 'credit_note')
         + greatest(0.01, round(1.00 * coalesce(f.amount, 0) / nullif(f.amount_rsd, 0), 2))) z;
  raise notice 'a final invoice uses its paid proforma: every document, supplier line and customer line reads as before; % payment(s) are allocated beyond what they paid today and % bill(s) are held by advances and payments beyond what they owe; they stand -- the guards refuse only a write that raises that', v_n, v_m;
end $$;

commit;
