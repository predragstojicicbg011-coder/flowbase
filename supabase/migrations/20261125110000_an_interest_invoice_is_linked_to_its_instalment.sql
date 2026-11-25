-- ============================================================================
-- An interest invoice is linked to its instalment; an instalment goes back
-- to unpaid
--
-- PART A. Banks send SEF invoices for the interest on credit instalments.
-- That interest is already an expense the day the instalment is paid: the
-- statement and the transaction dialog post a CREDIT_INTEREST leg
-- (`creditHeads.interest`) beside the bank line. Booking the SEF invoice
-- through "Otvori i proknjiži" would count it twice, and "Odbij" leaves no
-- trace of it beside the credit.
--
-- So a waiting PURCHASE row of the inbox may be LINKED to a credit instalment
-- instead. Ported from Mintflow's 20270110090000 (its probe fix ac11c4e
-- included) and re-derived from FlowBase's own guard, grants and roles:
--
--   state 'linked'          a fourth state beside pending, imported, dismissed
--   credit_installment_id   the instalment; `on delete set null`, see the guard
--   linked_at, linked_by    when, and who
--   credits.lender_pib      the bank's PIB (digits), remembered on the first
--                           link, so the next invoice from it is proposed
--
-- No `invoices` row, no `transactions` row, nothing in P&L. The SEF data, the
-- UBL and the PDF stay on the inbox row as they do today, and SEF itself is
-- not touched: a linked row may still be accepted or rejected ON SEF
-- (`sef-decide` reads only the decision columns).
--
-- WHAT DIFFERS FROM MINTFLOW
--
--   * The link is gated on `can_write_books()`, the bar `sef_inbox_decide` and
--     `sef_inbox_mark_imported` use. FlowBase has no page gates.
--   * A `sales` row is refused: only a bill the company RECEIVED is interest.
--   * Another currency is ALLOWED (owner, 2026-11-25). A bank's interest
--     invoice on a EUR-indexed loan is issued in dinars; the screen converts
--     at the NBS middle rate to rank and to state the difference. The
--     database has no rate to compare with and does not try.
--   * No `credit_sef_links()`: every member already reads `sef_inbox`
--     (`sef_inbox_read using is_member()`), and the `sef-pdf` storage policy
--     reads it as the caller, so the Krediti page reads the links directly.
--
-- PART B. `credit_installment_mark_unpaid(uuid)` puts a paid or partly paid
-- instalment back to unpaid (paid_amount 0, outstanding, paid_date and
-- transaction_id null) and reopens a credit that reads `closed`. It is the
-- "Vrati na neplaćeno" button on the Krediti page, and what the statement
-- delete's warning tells people to do for an old credit payment. SECURITY
-- INVOKER: it writes through `credit_installments_update` and
-- `credits_update` (both `can_write_books()`), exactly the bar an instalment
-- is edited by today, and asks that bar first only to say so in Serbian. It
-- never touches `transactions`: the principal and interest rows already posted
-- stay in P&L, and the screen says so. A SEF interest invoice linked to the
-- instalment stays linked.
--
-- ── WHO WRITES WHAT ──────────────────────────────────────────────────────
--
-- `authenticated` keeps exactly the column grant 20261015100000 gave it --
-- `state, dismiss_reason, dismissed_at, restored_at` -- so the link columns
-- are written by `sef_inbox_link_installment` and by nobody's hand, the shape
-- of `imported_invoice_id` and `sef_inbox_mark_imported`. NO POLICY OR GRANT
-- ON A TABLE MOVES IN THIS FILE.
--
-- ── THE GUARD, EXTENDED ──────────────────────────────────────────────────
--
-- `sef_inbox_guard_state` keeps its imported half word for word and learns
-- four things about the new state:
--
--   * a row becomes `linked` only with its instalment;
--   * a `linked` row goes only back to `pending` (Odveži) -- declined while
--     linked, it would keep a link nobody sees;
--   * back in the queue the link is cleared, and when it was the last linked
--     invoice from that PIB on that credit, the credit forgets the PIB it only
--     ever learned from links (a definer trigger writing `credits`);
--   * an instalment deleted under a link (a revolving schedule regenerated
--     from a month on) nulls the column through the foreign key, and the row
--     goes back to the queue. That is why the trigger now also fires on
--     `credit_installment_id`.
--
-- ── CHECKS ───────────────────────────────────────────────────────────────
--
-- The catalogue first, then one probe on a sentinel row (sef_invoice_id -903)
-- inside a subtransaction that is always unwound by `SEFLK-PROBE-DONE`, so
-- nothing it writes -- the row, a remembered PIB, an instalment, an audit row
-- -- survives. The parts that need a company, an instalment or a bookkeeper
-- WARN and skip on a database that has none (flowbase-demo is nearly empty).
-- The probe acts only as a profile JOINED to `auth.users`: its writes to
-- `credits` and `credit_installments` are audited with auth.uid() into
-- `audit_log.user_id`, which references `auth.users`, and a profile left
-- behind by a deleted account failed Mintflow's first push exactly there.
-- ============================================================================

begin;

-- ── 1. The columns ────────────────────────────────────────────────────────

alter table public.sef_inbox
  add column if not exists credit_installment_id uuid references public.credit_installments (id) on delete set null,
  add column if not exists linked_at timestamptz,
  add column if not exists linked_by uuid;

create index if not exists sef_inbox_installment_idx
  on public.sef_inbox (credit_installment_id) where credit_installment_id is not null;

alter table public.credits add column if not exists lender_pib text;

comment on column public.sef_inbox.credit_installment_id is
  'The credit instalment a bank''s interest invoice is linked to (state linked). Written only by sef_inbox_link_installment.';
comment on column public.credits.lender_pib is
  'The bank''s PIB (digits) as its SEF invoices carry it, remembered on the first link of one of them to an instalment of this credit.';

-- ── 2. Four states ────────────────────────────────────────────────────────
--
-- The state check of 20261015100000 was written inline and so carries a name
-- Postgres chose. It is found by what it says rather than by that name: the
-- one check on the table that names 'imported' is the state list (on a second
-- apply, this file's own), and is replaced.

do $$
declare
  r   record;
  v_n int;
begin
  -- Exactly one. Anything else is a check nobody here has read, and the loop
  -- below would drop it unread.
  select count(*) into v_n
    from pg_constraint
   where conrelid = 'public.sef_inbox'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%''imported''%';
  if v_n <> 1 then
    raise exception 'sef_inbox carries % checks that name imported, and this file replaces exactly one state list. Read them before anything is dropped -- rolling back', v_n;
  end if;

  for r in select conname
             from pg_constraint
            where conrelid = 'public.sef_inbox'::regclass
              and contype = 'c'
              and pg_get_constraintdef(oid) like '%''imported''%'
  loop
    execute format('alter table public.sef_inbox drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.sef_inbox
  add constraint sef_inbox_state_known check (state in ('pending', 'imported', 'dismissed', 'linked'));

alter table public.sef_inbox drop constraint if exists sef_inbox_linked_says_when;
alter table public.sef_inbox
  add constraint sef_inbox_linked_says_when check (state <> 'linked' or linked_at is not null);

-- ── 3. The guard ──────────────────────────────────────────────────────────

create or replace function public.sef_inbox_guard_state()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  booked   text;
  v_credit uuid;
  v_digits text;
begin
  -- The instalment is gone (the foreign key nulled the link): back to the queue.
  if old.state = 'linked' and new.state = 'linked'
     and old.credit_installment_id is not null and new.credit_installment_id is null then
    new.state := 'pending';
    new.linked_at := null;
    new.linked_by := null;
    new.restored_at := now();
    return new;
  end if;

  -- Only `sef_inbox_link_installment` names the instalment, and a row is
  -- linked only with one.
  if new.state = 'linked' and old.state is distinct from 'linked'
     and new.credit_installment_id is null then
    raise exception using errcode = 'SEFLK',
      message = 'Faktura se povezuje sa ratom kredita samo izborom rate. Ništa nije promenjeno.';
  end if;

  if old.state = 'linked' and new.state not in ('linked', 'pending') then
    raise exception using errcode = 'SEFLK',
      message = 'Ova faktura je povezana sa ratom kredita. Prvo je odvežite, čime se vraća u red.';
  end if;

  -- 20261015100000's half, word for word: guarded on WHERE THE ROW IS GOING.
  if new.state = 'pending' and old.imported_invoice_id is not null then
    select coalesce(invoice_number, old.imported_invoice_id::text)
      into booked
      from public.invoices
     where id = old.imported_invoice_id
       and deleted_at is null;

    if found then
      raise exception
        'This invoice is already booked as %. Remove it from the ledger first, then put this row back in the queue.',
        booked;
    end if;

    new.imported_invoice_id := null;
    new.imported_at := null;
  end if;

  -- Unlinked: back in the queue with nothing pointing anywhere.
  if new.state = 'pending' and old.state = 'linked' then
    -- The PIB on the credit was LEARNED from links. When this was the last
    -- linked invoice from that PIB on that credit, a mistaken link must not
    -- leave a lasting proposal behind, so the credit forgets it. An instalment
    -- regenerated away (above) says nothing about the bank, and keeps it.
    select i.credit_id into v_credit
      from public.credit_installments i where i.id = old.credit_installment_id;
    v_digits := regexp_replace(coalesce(old.supplier_vat_number, ''), '\D', '', 'g');
    if v_credit is not null and v_digits <> ''
       and not exists (
         select 1
           from public.sef_inbox s
           join public.credit_installments i on i.id = s.credit_installment_id
          where s.state = 'linked' and s.id <> old.id and i.credit_id = v_credit
            and regexp_replace(coalesce(s.supplier_vat_number, ''), '\D', '', 'g') = v_digits) then
      update public.credits
         set lender_pib = null
       where id = v_credit
         and regexp_replace(coalesce(lender_pib, ''), '\D', '', 'g') = v_digits;
    end if;

    new.credit_installment_id := null;
    new.linked_at := null;
    new.linked_by := null;
  end if;

  return new;
end $fn$;

drop trigger if exists sef_inbox_guard_state on public.sef_inbox;
create trigger sef_inbox_guard_state
  before update of state, credit_installment_id on public.sef_inbox
  for each row execute function public.sef_inbox_guard_state();

-- ── 4. The one way into `linked` ──────────────────────────────────────────

create or replace function public.sef_inbox_link_installment(
  p_id uuid, p_installment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row     record;
  v_credit  uuid;
  v_company uuid;
  v_pib     text;
begin
  if auth.uid() is null then
    raise exception using errcode = 'SEFLK',
      message = 'Prijavite se: zahtev nije nosio prijavljenog korisnika. Ništa nije povezano.';
  end if;
  -- The bar of `sef_inbox_decide` and `sef_inbox_mark_imported`.
  if not coalesce(public.can_write_books(), false) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Samo finansijski tim može da poveže SEF fakturu sa ratom kredita. Ništa nije povezano.';
  end if;

  select c.id, c.company_id
    into v_credit, v_company
    from public.credit_installments i
    join public.credits c on c.id = i.credit_id
   where i.id = p_installment_id
     for share of i;
  if not found then
    raise exception using errcode = 'SEFLK',
      message = 'Ta rata kredita ne postoji. Ništa nije povezano.';
  end if;

  -- Locked, so two clicks cannot both find it pending.
  select s.state, s.imported_invoice_id, s.company_id, s.direction, s.supplier_vat_number
    into v_row
    from public.sef_inbox s
   where s.id = p_id
     for update;
  if not found then
    raise exception using errcode = 'SEFLK',
      message = 'Taj red SEF sandučeta ne postoji. Ništa nije povezano.';
  end if;
  if v_row.direction is distinct from 'purchase' then
    raise exception using errcode = 'SEFLK',
      message = 'Sa ratom kredita se povezuje samo ulazna faktura, a ova je izlazna. Ništa nije povezano.';
  end if;
  if v_row.state <> 'pending' or v_row.imported_invoice_id is not null then
    raise exception using errcode = 'SEFLK',
      message = 'Faktura ne čeka u redu: već je proknjižena, odbijena ili povezana. Ništa nije povezano.';
  end if;
  if v_row.company_id is distinct from v_company then
    raise exception using errcode = 'SEFLK',
      message = 'Faktura je upućena drugoj firmi, a ne onoj čiji je kredit. Ništa nije povezano.';
  end if;
  -- The currency is NOT compared: an interest invoice in dinars on a EUR
  -- credit is the ordinary case (owner, 2026-11-25).

  update public.sef_inbox
     set state = 'linked',
         credit_installment_id = p_installment_id,
         linked_at = now(),
         linked_by = auth.uid()
   where id = p_id;

  -- The bank is remembered on the first link and never overwritten.
  v_pib := nullif(regexp_replace(coalesce(v_row.supplier_vat_number, ''), '\D', '', 'g'), '');
  if v_pib is not null then
    update public.credits
       set lender_pib = v_pib
     where id = v_credit
       and lender_pib is null;
  end if;
end $fn$;

revoke all on function public.sef_inbox_link_installment(uuid, uuid) from public, anon;
grant execute on function public.sef_inbox_link_installment(uuid, uuid) to authenticated;

-- ── 5. An instalment back to unpaid ───────────────────────────────────────
--
-- Invoker: the two writes go through the policies an instalment is edited by
-- today, in one transaction. Answers whether the credit was reopened and how
-- many SEF interest invoices stay linked to the instalment.

create or replace function public.credit_installment_mark_unpaid(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_inst     record;
  v_n        int;
  v_reopened int;
  v_links    int;
begin
  if not coalesce(public.can_write_books(), false) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.';
  end if;

  select i.id, i.credit_id, i.status, coalesce(i.paid_amount, 0) as paid_amount
    into v_inst
    from public.credit_installments i
   where i.id = p_id
     for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'Ta rata kredita ne postoji. Ništa nije promenjeno.';
  end if;
  if v_inst.status <> 'paid' and v_inst.paid_amount <= 0 then
    raise exception using errcode = 'SEFLK',
      message = 'Rata nije ni delimično plaćena, pa nema šta da se vrati. Ništa nije promenjeno.';
  end if;

  update public.credit_installments
     set paid_amount = 0, status = 'outstanding', paid_date = null,
         transaction_id = null, updated_at = now()
   where id = p_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.';
  end if;

  -- A credit closed by the last payment is open again, as both deletes do
  -- (20261125090000). `restructured` is a decision and is left alone.
  update public.credits
     set status = 'active', updated_at = now()
   where id = v_inst.credit_id
     and status = 'closed';
  get diagnostics v_reopened = row_count;

  select count(*) into v_links
    from public.sef_inbox s
   where s.credit_installment_id = p_id and s.state = 'linked';

  return jsonb_build_object('credit_reopened', v_reopened > 0, 'sef_links', v_links);
end $fn$;

revoke all on function public.credit_installment_mark_unpaid(uuid) from public, anon;
grant execute on function public.credit_installment_mark_unpaid(uuid) to authenticated;

-- ── 6. Checks ─────────────────────────────────────────────────────────────

do $$
declare
  v_col     text;
  v_sig     text;
  v_n       int;
  v_name    text;
  v_conf    text[];
  v_def     boolean;
  v_src     text;
  v_company uuid;
  v_inst    uuid;
  v_credit  uuid;
  v_cstat   text;
  v_owner   uuid;
  v_seer    uuid;
  v_nobody  uuid := gen_random_uuid();
  v_probe   uuid;
  v_pib     text;
  v_state   text;
  v_link    uuid;
  v_by      uuid;
  v_at      timestamptz;
  v_res     jsonb;
  v_istat   text;
  v_ipaid   numeric;
  v_idate   date;
  v_itx     uuid;
begin
  -- ── The catalogue ──
  foreach v_col in array array['credit_installment_id', 'linked_at', 'linked_by'] loop
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'sef_inbox' and column_name = v_col) then
      raise exception 'sef_inbox has no column %, which this file adds -- rolling back', v_col;
    end if;
    if has_column_privilege('authenticated', 'public.sef_inbox', v_col, 'UPDATE') then
      raise exception 'authenticated can write sef_inbox.% by hand; the link is written by sef_inbox_link_installment alone -- rolling back', v_col;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'credits' and column_name = 'lender_pib') then
    raise exception 'credits has no column lender_pib, which this file adds -- rolling back';
  end if;
  if not has_column_privilege('authenticated', 'public.sef_inbox', 'state', 'UPDATE') then
    raise exception 'authenticated cannot record a decision on sef_inbox any more -- rolling back';
  end if;

  select count(*), min(conname) into v_n, v_name
    from pg_constraint
   where conrelid = 'public.sef_inbox'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%''imported''%';
  if v_n <> 1 or v_name <> 'sef_inbox_state_known' then
    raise exception 'sef_inbox carries % state lists (first: %), and must carry exactly one, sef_inbox_state_known -- rolling back', v_n, v_name;
  end if;
  if pg_get_constraintdef((select oid from pg_constraint
                            where conrelid = 'public.sef_inbox'::regclass
                              and conname = 'sef_inbox_state_known')) not like '%''linked''%' then
    raise exception 'sef_inbox_state_known does not admit linked -- rolling back';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.sef_inbox'::regclass and conname = 'sef_inbox_linked_says_when') then
    raise exception 'sef_inbox_linked_says_when is missing -- rolling back';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.sef_inbox'::regclass and tgname = 'sef_inbox_guard_state'
                    and not tgisinternal and tgenabled <> 'D'
                    and pg_get_triggerdef(oid) like '%BEFORE UPDATE OF state, credit_installment_id ON public.sef_inbox%') then
    raise exception 'sef_inbox_guard_state does not fire on both state and credit_installment_id; an instalment deleted under a link would leave the row linked to nothing -- rolling back';
  end if;

  foreach v_sig in array array['public.sef_inbox_guard_state()', 'public.sef_inbox_link_installment(uuid, uuid)'] loop
    select p.prosecdef, p.proconfig into v_def, v_conf
      from pg_proc p where p.oid = v_sig::regprocedure;
    if not v_def then
      raise exception '% is not security definer -- rolling back', v_sig;
    end if;
    if not ('search_path=public, pg_temp' = any (coalesce(v_conf, '{}'::text[]))) then
      raise exception '% does not pin search_path to public, pg_temp -- rolling back', v_sig;
    end if;
  end loop;

  -- The unpaid function is INVOKER on purpose: its writes go through the
  -- policies an instalment is edited by.
  select p.prosecdef, p.proconfig into v_def, v_conf
    from pg_proc p where p.oid = 'public.credit_installment_mark_unpaid(uuid)'::regprocedure;
  if v_def then
    raise exception 'credit_installment_mark_unpaid is security definer; it must write through the policies of credit_installments and credits -- rolling back';
  end if;
  if not ('search_path=public, pg_temp' = any (coalesce(v_conf, '{}'::text[]))) then
    raise exception 'credit_installment_mark_unpaid does not pin search_path to public, pg_temp -- rolling back';
  end if;

  foreach v_sig in array array['public.sef_inbox_link_installment(uuid, uuid)', 'public.credit_installment_mark_unpaid(uuid)'] loop
    if has_function_privilege('anon', v_sig, 'EXECUTE') then
      raise exception 'anon may execute % -- rolling back', v_sig;
    end if;
    if not has_function_privilege('authenticated', v_sig, 'EXECUTE') then
      raise exception 'authenticated may not execute %, and the screens call it as that role -- rolling back', v_sig;
    end if;
  end loop;

  -- The bodies, for a database where the probe below has nothing to act on.
  select prosrc into v_src from pg_proc where oid = 'public.sef_inbox_link_installment(uuid, uuid)'::regprocedure;
  if v_src not like '%if not coalesce(public.can_write_books(), false) then%' then
    raise exception 'sef_inbox_link_installment does not ask can_write_books() -- rolling back';
  end if;
  if v_src not like '%v_row.direction is distinct from ''purchase''%' then
    raise exception 'sef_inbox_link_installment does not refuse a sales row -- rolling back';
  end if;
  select prosrc into v_src from pg_proc where oid = 'public.credit_installment_mark_unpaid(uuid)'::regprocedure;
  if v_src not like '%if not coalesce(public.can_write_books(), false) then%' then
    raise exception 'credit_installment_mark_unpaid does not ask can_write_books() -- rolling back';
  end if;
  if v_src ~* 'transactions' then
    raise exception 'credit_installment_mark_unpaid names transactions; it must never touch a posted row -- rolling back';
  end if;

  -- The policies the unpaid function writes through are still the bookkeepers'.
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'credit_installments' and cmd = 'UPDATE'
                    and permissive = 'PERMISSIVE' and qual like '%can_write_books()%')
     or not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'credits' and cmd = 'UPDATE'
                    and permissive = 'PERMISSIVE' and qual like '%can_write_books()%')
     or exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename in ('credit_installments', 'credits')
                   and cmd in ('UPDATE', 'ALL') and permissive = 'PERMISSIVE'
                   and qual not like '%can_write_books()%') then
    raise exception 'the update policies of credit_installments and credits are no longer can_write_books() alone; read them before an invoker function writes through them -- rolling back';
  end if;

  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'sef_inbox' and cmd in ('DELETE', 'ALL') and permissive = 'PERMISSIVE';
  if v_n <> 0 then
    raise exception 'sef_inbox has a permissive delete policy; the trace must not be erasable -- rolling back';
  end if;

  -- ── The behaviour, on a sentinel row, always unwound ──
  select c.id into v_company from public.companies c order by c.id limit 1;
  if v_company is null then
    raise warning 'no company in public.companies, so the behaviour of the guard and the two functions is not probed here; the catalogue checks above stand';
    raise notice 'sef_inbox links ready';
    return;
  end if;

  begin
    insert into public.sef_inbox (company_id, direction, sef_invoice_id, overview_json, supplier_vat_number,
                                  currency, amount, document_number)
    values (v_company, 'purchase', -903, '{}'::jsonb, '900000903', 'XXX', 1.00, 'SEFLK-PROBE')
    returning id into v_probe;

    -- (1) Linked by hand, with no instalment: refused.
    begin
      update public.sef_inbox set state = 'linked', linked_at = now() where id = v_probe;
      raise exception 'GUARD FAILED: a row was marked linked with no instalment';
    exception when others then
      if sqlerrm <> 'Faktura se povezuje sa ratom kredita samo izborom rate. Ništa nije promenjeno.' then raise; end if;
    end;

    -- (2) No signed-in user, then a caller who is nobody: refused before
    --     anything is read or written.
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    begin
      perform public.sef_inbox_link_installment(v_probe, gen_random_uuid());
      raise exception 'GUARD FAILED: a request with no user linked an invoice';
    exception when others then
      if sqlerrm <> 'Prijavite se: zahtev nije nosio prijavljenog korisnika. Ništa nije povezano.' then raise; end if;
    end;
    perform set_config('request.jwt.claim.sub', v_nobody::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_nobody::text)::text, true);
    begin
      perform public.sef_inbox_link_installment(v_probe, gen_random_uuid());
      raise exception 'GUARD FAILED: a caller with no profile linked an invoice';
    exception when others then
      -- A caller who is nobody that gets as far as a write meets the audit
      -- trail's foreign key to auth.users before the sentence: the same
      -- failure, said as what it is.
      if sqlstate = '23503' then
        raise exception 'GUARD FAILED: a caller with no profile got as far as writing (%)', sqlerrm;
      end if;
      if sqlerrm <> 'Samo finansijski tim može da poveže SEF fakturu sa ratom kredita. Ništa nije povezano.' then raise; end if;
    end;
    begin
      perform public.credit_installment_mark_unpaid(gen_random_uuid());
      raise exception 'GUARD FAILED: a caller with no profile reached an instalment';
    exception when others then
      if sqlstate = '23503' then
        raise exception 'GUARD FAILED: a caller with no profile got as far as writing (%)', sqlerrm;
      end if;
      if sqlerrm <> 'Samo finansijski tim može da vrati ratu na neplaćenu. Ništa nije promenjeno.' then raise; end if;
    end;

    -- A bookkeeper whose sign-in account still exists: the writes below are
    -- audited, and audit_log.user_id references auth.users, so a profile left
    -- behind by a deleted account would fail the probe (it did, on Mintflow's
    -- live database).
    select p.id into v_seer
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.role in ('administrator', 'owner', 'administrative_assistant')
     order by p.id limit 1;
    if v_seer is null then
      raise warning 'no administrator, owner or assistant with a sign-in account, so a successful link and a return to unpaid are not probed here';
      raise exception 'SEFLK-PROBE-DONE';
    end if;
    perform set_config('request.jwt.claim.sub', v_seer::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_seer::text)::text, true);

    select i.id, c.id, c.company_id, c.lender_pib, c.status
      into v_inst, v_credit, v_owner, v_pib, v_cstat
      from public.credit_installments i
      join public.credits c on c.id = i.credit_id
     where c.company_id is not null
     order by i.id limit 1;
    if v_inst is null then
      raise warning 'no credit instalment in public.credit_installments, so the link and the return to unpaid are probed for their refusals only';
      raise exception 'SEFLK-PROBE-DONE';
    end if;
    -- The probe's currency, XXX, is never the credit's: a link across
    -- currencies is allowed.
    update public.sef_inbox set company_id = v_owner where id = v_probe;

    -- (3) A sales row: refused.
    update public.sef_inbox set direction = 'sales' where id = v_probe;
    begin
      perform public.sef_inbox_link_installment(v_probe, v_inst);
      raise exception 'GUARD FAILED: a sales invoice was linked to a credit instalment';
    exception when others then
      if sqlerrm <> 'Sa ratom kredita se povezuje samo ulazna faktura, a ova je izlazna. Ništa nije povezano.' then raise; end if;
    end;
    update public.sef_inbox set direction = 'purchase' where id = v_probe;

    -- (4) The bookkeeper links it, across currencies.
    perform public.sef_inbox_link_installment(v_probe, v_inst);
    select state, credit_installment_id, linked_by, linked_at into v_state, v_link, v_by, v_at
      from public.sef_inbox where id = v_probe;
    if v_state <> 'linked' or v_link is distinct from v_inst or v_by is distinct from v_seer or v_at is null then
      raise exception 'the link did not take: state %, instalment %, by %, at % -- rolling back', v_state, v_link, v_by, v_at;
    end if;
    if (select lender_pib from public.credits where id = v_credit)
       is distinct from coalesce(v_pib, '900000903') then
      raise exception 'the PIB was not remembered on the credit, or an earlier one was overwritten -- rolling back';
    end if;
    begin
      perform public.sef_inbox_link_installment(v_probe, v_inst);
      raise exception 'GUARD FAILED: a linked invoice was linked a second time';
    exception when others then
      if sqlerrm <> 'Faktura ne čeka u redu: već je proknjižena, odbijena ili povezana. Ništa nije povezano.' then raise; end if;
    end;

    -- (5) Declined while linked: refused.
    begin
      update public.sef_inbox set state = 'dismissed', dismiss_reason = 'probe' where id = v_probe;
      raise exception 'GUARD FAILED: a linked invoice was declined';
    exception when others then
      if sqlerrm <> 'Ova faktura je povezana sa ratom kredita. Prvo je odvežite, čime se vraća u red.' then raise; end if;
    end;

    -- (6) The instalment back to unpaid: the link stays, the credit reopens,
    --     nothing else moves. Made paid and its credit closed first, here.
    update public.credit_installments
       set status = 'paid', paid_amount = total_amount, paid_date = current_date
     where id = v_inst;
    update public.credits set status = 'closed' where id = v_credit;
    select transaction_id into v_itx from public.credit_installments where id = v_inst;
    v_res := public.credit_installment_mark_unpaid(v_inst);
    select status, paid_amount, paid_date, transaction_id into v_istat, v_ipaid, v_idate, v_itx
      from public.credit_installments where id = v_inst;
    if v_istat <> 'outstanding' or v_ipaid <> 0 or v_idate is not null or v_itx is not null then
      raise exception 'the instalment did not go back to unpaid: %, %, %, % -- rolling back', v_istat, v_ipaid, v_idate, v_itx;
    end if;
    if (select status from public.credits where id = v_credit) <> 'active'
       or (v_res ->> 'credit_reopened') is distinct from 'true'
       or coalesce((v_res ->> 'sef_links')::int, 0) < 1 then
      raise exception 'the return to unpaid answered % and left the credit % -- rolling back',
        v_res, (select status from public.credits where id = v_credit);
    end if;
    if (select state from public.sef_inbox where id = v_probe) <> 'linked' then
      raise exception 'the return to unpaid undid the SEF link -- rolling back';
    end if;
    begin
      perform public.credit_installment_mark_unpaid(v_inst);
      raise exception 'GUARD FAILED: an unpaid instalment was returned to unpaid';
    exception when others then
      if sqlerrm <> 'Rata nije ni delimično plaćena, pa nema šta da se vrati. Ništa nije promenjeno.' then raise; end if;
    end;

    -- (7) Unlinked: back in the queue, the link cleared, and the credit
    --     gives back the PIB it learned from it -- and keeps one it had.
    update public.sef_inbox set state = 'pending', restored_at = now() where id = v_probe;
    select state, credit_installment_id, linked_by, linked_at into v_state, v_link, v_by, v_at
      from public.sef_inbox where id = v_probe;
    if v_state <> 'pending' or v_link is not null or v_by is not null or v_at is not null then
      raise exception 'unlinking left state %, instalment %, by %, at % -- rolling back', v_state, v_link, v_by, v_at;
    end if;
    if (select lender_pib from public.credits where id = v_credit) is distinct from v_pib then
      raise exception 'unlinking the last invoice from a PIB did not give the credit back the PIB it had (%) -- rolling back', coalesce(v_pib, 'none');
    end if;

    -- (8) The instalment gone under a link: back in the queue.
    perform public.sef_inbox_link_installment(v_probe, v_inst);
    update public.sef_inbox set credit_installment_id = null where id = v_probe;
    select state, linked_at into v_state, v_at from public.sef_inbox where id = v_probe;
    if v_state <> 'pending' or v_at is not null then
      raise exception 'a link whose instalment went left the row %, linked at % -- rolling back', v_state, v_at;
    end if;
    if (select lender_pib from public.credits where id = v_credit) is distinct from coalesce(v_pib, '900000903') then
      raise exception 'an instalment regenerated away made the credit forget its bank''s PIB -- rolling back';
    end if;

    raise exception 'SEFLK-PROBE-DONE';
  exception when others then
    if sqlerrm <> 'SEFLK-PROBE-DONE' then raise; end if;
  end;

  if exists (select 1 from public.sef_inbox where sef_invoice_id = -903) then
    raise exception 'the probe row -903 survived its probe -- rolling back';
  end if;

  raise notice 'sef_inbox links ready';
end $$;

commit;
