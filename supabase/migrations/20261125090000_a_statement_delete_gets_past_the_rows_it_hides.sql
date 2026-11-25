-- ============================================================================
-- A statement delete gets past the rows it hides
--
-- WHAT THIS FILE CHANGES. Two functions, and nothing else. No table, no
-- column, no view, no policy, no trigger.
--
--   `public.delete_statement_cascade(text, uuid)`    -- last: the baseline
--   `public.delete_transaction_cascade(uuid, uuid)`  -- last: the baseline
--                                                       (20261008120000)
--
-- The statement delete becomes `security definer` and re-imposes by hand, at
-- the top, what the policies it now steps past imposed. Every step of the
-- baseline body is carried forward in the same order, returning the same keys
-- plus `credits_reopened`. The single delete stays what it was (definer, first
-- step `soft_delete_row`) and gains only the credit step below. What follows
-- is what is different, and why. Ported from Mintflow's 20270111090000 and
-- re-derived from FlowBase's own body, roles and policies (FlowBase has no
-- `credit_movements` and no page gates).
--
-- ── "OBRIŠI IZVOD" HAS NEVER WORKED IN FLOWBASE ──────────────────────────
--
-- The baseline body is invoker and compares `import_batch_id = p_batch_id`.
-- `transactions.import_batch_id` and `passthrough.import_batch_id` are `uuid`,
-- the parameter is `text`, and there is no `uuid = text` operator:
--
--   ERROR: operator does not exist: uuid = text
--
-- on the first statement of the body, on every call. The parameter stays
-- `text` (`import_logs.filing_ref` is text and `src/services/statementDelete.ts`
-- passes a string) and is read ONCE into a uuid. A name that is not a uuid
-- matches nothing and ends in the function's own "nema nijednu stavku"
-- refusal rather than a cast error.
--
-- AND IT COULD NOT HAVE WORKED AS INVOKER EVEN WITH THE CAST:
--
--   * the soft delete itself meets `transactions_hide_deleted` /
--     `passthrough_hide_deleted` (RESTRICTIVE, for select, `deleted_at is
--     null`): an UPDATE that reads columns is checked against the select
--     policies, and setting `deleted_at` is exactly what makes the new row
--     fail -- "new row violates row-level security policy";
--   * had it passed, steps 2 and 3 join `transactions` AFTER step 1 hid
--     those rows from the caller, so the allocations and instalments would
--     have been left standing with no error at all;
--   * and step 5, `delete from import_logs`, has no delete policy to pass in
--     FlowBase at all (`20261010090000` dropped "Allow all" and gave
--     import_logs read, insert and update only), so the statement record
--     would have been silently kept.
--
-- As definer each step sees and writes what it names.
--
-- `delete_transaction_cascade` already gets past them: FlowBase's (the
-- baseline's) is definer and its first step is `soft_delete_row`, which
-- re-imposes administrator or owner and company access. It is re-created here
-- only for the credit step below, every other step verbatim.
--
-- ── A REOPENED INSTALMENT REOPENS ITS CREDIT ─────────────────────────────
--
-- Paying the last instalment closes the credit (`credits.status = 'closed'`,
-- BankStatementDialog, BulkImport, useCreditPayment). Both deletes put the
-- instalments a deleted row paid back to outstanding, and until now left the
-- credit closed: a closed credit with an unpaid instalment, which the credit
-- pickers (`status = 'active'`) no longer offer, so the instalment could not
-- be paid again. Both now set every credit they reopened an instalment of, and
-- that reads `closed`, back to `active` in the same call. `restructured` is
-- left alone: that is a decision, not a consequence of the last payment.
--
-- ── WHAT IS RE-IMPOSED, AND WHY IT IS ENOUGH ──────────────────────────────
--
-- `security definer` throws every policy away, so whatever they decided is
-- decided here, before any write:
--
--   the role     administrator or owner, and a member. `transactions_delete`
--                and `passthrough_delete` name exactly those two roles, and a
--                soft delete IS a delete -- the bar `soft_delete_row` (and so
--                `delete_transaction_cascade`) uses, and the bar the client
--                shows the button by (`useAuth().canDelete`). NOT the looser
--                `can_write_books()` (which adds administrative_assistant).
--                `is_member()` (the RESTRICTIVE `members_only` on every table)
--                is asked as well; for these two roles it is true by
--                construction today, and asking it means a narrower
--                `is_member` narrows this function with it.
--   the scope    `has_company_access(company_id)` of every live row the call
--                would soft-delete -- the predicate of `transactions_select`
--                and `passthrough_select`. A statement with ANY row outside
--                the caller's companies is refused whole, because a
--                statement is all or nothing. (FlowBase is single company and
--                the two roles pass by construction; asked anyway.)
--
-- A caller with no profile -- MCFlow's MCOdobri users are exactly that -- has
-- no role and is refused.
--
-- WHAT IS DELIBERATELY NOT BYPASSED: the period lock. `period_lock_*` are
-- triggers, and triggers are not RLS: they fire whoever owns the function. A
-- closed month still refuses step 1 and the whole call rolls back with it.
-- Section C asks that the triggers are there and enabled.
--
-- AND THE STATEMENT'S OWN CLOSED MONTH. A statement with a row dated in a
-- closed month was refused by the trigger after the writes had begun, in its
-- English "Period 2026-09 is locked for this company". The same test is asked
-- first, of every live transaction and pass-through of the batch, and said in
-- Serbian with the months and where to unlock them.
--
-- AND AN INVOICE IN A CLOSED MONTH. Step 4 rewrites `invoices.status`, and
-- `period_lock_invoices` fires on `invoice_date`: an October statement that
-- paid a September invoice, with September closed, would be refused AFTER the
-- writes with the trigger's English "Period 2026-09 is locked", naming a month
-- the statement is not in. The refusal stands (removing a payment from a
-- closed-month invoice changes that month), but it is asked BEFORE any write,
-- with `enforce_period_lock`'s own test, and said in one Serbian sentence that
-- names the invoices, the months, and where to unlock them (Podešavanja →
-- 🔒 Zaključani periodi → Otključaj, `ClosedPeriodsTab`). It is asked of every
-- invoice the batch's rows are allocated to, soft-deleted ones included (step
-- 4 restates them too: `v_invoice_status` does not hide deleted invoices), and
-- not only of those whose status would move: what such an invoice has been
-- paid changes either way.
--
-- `deleted_by` is the caller, `auth.uid()`, as in `delete_invoice_cascade`,
-- in both functions. `p_deleted_by` stays in both signatures so no client
-- breaks, and is no longer read.
--
-- ── A DELETED STATEMENT CAN BE IMPORTED AGAIN ─────────────────────────────
--
-- `transactions_import_hash_uidx` and `passthrough_import_hash_uidx` are
-- unique over every row with a hash, soft-deleted ones included, so every
-- line of a statement imported again after "Obriši izvod" failed with 23505,
-- which both import screens count as "already imported". The statement delete
-- now clears `import_hash` in the same update that sets `deleted_at`: undoing
-- an import means the file was never read. The indexes are NOT made partial:
-- deleting ONE line (delete_transaction_cascade / soft_delete_row) keeps its
-- hash, so importing the same file again does not bring back a line somebody
-- deleted on purpose.
--
-- ── SMALLER THINGS ────────────────────────────────────────────────────────
--
-- `set search_path = public, pg_temp`, `pg_temp` LAST, so nothing a caller
-- puts in a temporary schema shadows a table; the temporary table is named
-- `pg_temp._touched_invoices` where it is made and read, and is dropped first
-- if a previous call in the same database transaction left it (it is `on
-- commit drop`, so a second statement deleted in one transaction would
-- otherwise fail with "already exists").
--
-- `service_role` keeps EXECUTE (the baseline grants it) and is refused on role:
-- nothing calls this function as the service role (the callers are
-- BankStatementDialog and BulkImport through `statementDelete.ts`, as
-- `authenticated`; no edge function names it).
--
-- Messages are Serbian, as in every FlowBase-only function; nothing in `src`
-- matches the baseline's English wording.
--
-- ── NO PROBE ROWS ─────────────────────────────────────────────────────────
--
-- The checks below write nothing. Section D calls the function as every
-- person in `profiles`, as a signed-in account with no profile, and as
-- nobody, on a batch no row carries: an administrator or an owner must get
-- past every gate and reach the function's own "nothing is there" refusal;
-- everybody else must be refused on role. Every call raises, so every call is
-- rolled back, and no audited table is ever written.
--
-- Tests: supabase/tests/delete_statement_cascade_test.sql.
-- ============================================================================

begin;

set local lock_timeout = '3s';

-- ── 0. What this file stands on, asked before anything is replaced ─────────
do $$
declare
  v_src text;
begin
  if to_regprocedure('public.delete_statement_cascade(text, uuid)') is null then
    raise exception
      'public.delete_statement_cascade(text, uuid) is not there, so this file would CREATE it rather than replace it. The baseline has not been applied -- rolling back';
  end if;
  if to_regprocedure('public.get_my_role()') is null
     or to_regprocedure('public.is_member()') is null
     or to_regprocedure('public.has_company_access(uuid)') is null then
    raise exception 'get_my_role(), is_member() or has_company_access(uuid) is missing, so the checks below would not run -- rolling back';
  end if;
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.transactions'::regclass and a.attname = 'import_batch_id' and not a.attisdropped)
     is distinct from 'uuid'
     or (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.passthrough'::regclass and a.attname = 'import_batch_id' and not a.attisdropped)
     is distinct from 'uuid' then
    raise exception
      'transactions.import_batch_id or passthrough.import_batch_id is no longer uuid, and the statement delete below reads its batch into a uuid to compare with them -- READ THIS FILE AGAIN -- rolling back';
  end if;

  -- The single delete is re-created with its own first step, soft_delete_row,
  -- which is what re-imposes role and company access for it.
  if to_regprocedure('public.delete_transaction_cascade(uuid, uuid)') is null
     or to_regprocedure('public.soft_delete_row(text, uuid, uuid)') is null then
    raise exception
      'public.delete_transaction_cascade(uuid, uuid) or public.soft_delete_row(text, uuid, uuid) is not there, so this file would create rather than replace, or its single delete would check nobody -- rolling back';
  end if;
  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.credits'::regclass and a.attname = 'status' and not a.attisdropped)
     is distinct from 'text' then
    raise exception 'credits.status is no longer text, and both deletes set it back to ''active'' -- rolling back';
  end if;
end $$;

-- ── A0. One transaction ──────────────────────────────────────────────────────
--
-- The baseline body, verbatim, with the credit step added after the
-- instalments and `deleted_by` taken from the caller.
create or replace function public.delete_transaction_cascade(
  p_transaction_id uuid,
  p_deleted_by     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_links   int;
  v_insts   int;
  v_credits uuid[];
  v_reopen  int;
begin
  -- First, and the only check: soft_delete_row refuses anybody but an
  -- administrator or an owner with access to the row's company.
  if not public.soft_delete_row('transactions', p_transaction_id, auth.uid()) then
    raise exception 'No transaction with id % — nothing was deleted.', p_transaction_id
      using errcode = 'no_data_found';
  end if;

  delete from public.invoice_transaction_links where transaction_id = p_transaction_id;
  get diagnostics v_links = row_count;

  with reopened as (
    update public.credit_installments
       set transaction_id = null, status = 'outstanding', paid_date = null, paid_amount = 0
     where transaction_id = p_transaction_id
    returning credit_id
  )
  select count(*), array_agg(distinct credit_id) into v_insts, v_credits from reopened;

  -- A credit closed by the payment this was is open again (20261125090000).
  update public.credits
     set status = 'active', updated_at = now()
   where id = any (coalesce(v_credits, '{}'))
     and status = 'closed';
  get diagnostics v_reopen = row_count;

  return jsonb_build_object('invoice_links_removed', v_links,
                           'installments_unlinked', v_insts,
                           'credits_reopened', v_reopen);
end $$;

revoke all on function public.delete_transaction_cascade(uuid, uuid) from public;
revoke all on function public.delete_transaction_cascade(uuid, uuid) from anon;
grant execute on function public.delete_transaction_cascade(uuid, uuid) to authenticated, service_role;

comment on function public.delete_transaction_cascade(uuid, uuid) is
  'Soft-deletes one transaction (through soft_delete_row, which checks the '
  'caller) and what references it: its invoice allocations and the credit '
  'instalments it closed, and reopens a credit those instalments had closed. '
  'deleted_by is the caller. The transaction keeps its import_hash. '
  'SECURITY DEFINER. 20261125090000.';

-- ── A. A whole statement ───────────────────────────────────────────────────
--
-- The baseline's five steps, in its order, returning its keys. Step 0 and 0b
-- are new, and the batch is compared as the uuid the columns hold.
create or replace function public.delete_statement_cascade(
  p_batch_id   text,
  p_deleted_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n_tx       int;
  n_pt       int;
  n_links    int;
  n_inst     int;
  n_credits  int;
  v_credits  uuid[];
  n_invoices int;
  n_logs     int;
  v_role     text;
  v_batch    uuid;
  v_inv      text;
  v_months   text;
begin
  if p_batch_id is null or btrim(p_batch_id) = '' then
    raise exception 'Nije naveden nijedan izvod.' using errcode = 'invalid_parameter_value';
  end if;

  -- 0. Who may (20261125090000). `security definer` has thrown the policies
  --    away, so what they decided is decided here, before any write.
  v_role := public.get_my_role();
  if v_role is null or v_role not in ('administrator', 'owner') or not public.is_member() then
    raise exception 'Samo administrator ili vlasnik može da obriše izvod.'
      using errcode = 'insufficient_privilege';
  end if;

  --    The columns hold a uuid and the name arrives as text. Read once; a
  --    name that is not a uuid matches nothing and ends in the "nema
  --    nijednu stavku" refusal below.
  begin
    v_batch := btrim(p_batch_id)::uuid;
  exception when invalid_text_representation then
    v_batch := null;
  end;

  if exists (select 1 from public.transactions t
              where t.import_batch_id = v_batch and t.deleted_at is null
                and not public.has_company_access(t.company_id))
     or exists (select 1 from public.passthrough p
              where p.import_batch_id = v_batch and p.deleted_at is null
                and not public.has_company_access(p.company_id)) then
    raise exception 'Nemate pristup toj firmi.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Which invoices this batch was paying, captured BEFORE the allocations go,
  -- because afterwards there is nothing left to say so.
  drop table if exists pg_temp._touched_invoices;
  create temporary table _touched_invoices on commit drop as
  select distinct l.invoice_id
    from public.invoice_transaction_links l
    join public.transactions t on t.id = l.transaction_id
   where t.import_batch_id = v_batch;

  -- 0b. The statement's own rows in a locked month (20261125090000). The
  --    period-lock trigger would refuse step 1 in English; the same test is
  --    asked here, before any write, of every live row of the batch.
  select string_agg(distinct to_char(d.dt, 'YYYY-MM'), ', ' order by to_char(d.dt, 'YYYY-MM'))
    into v_months
    from (select t.company_id, t.transaction_date as dt from public.transactions t
           where t.import_batch_id = v_batch and t.deleted_at is null
          union all
          select p.company_id, p.transaction_date from public.passthrough p
           where p.import_batch_id = v_batch and p.deleted_at is null) d
    join public.closed_periods cp
      on cp.company_id = d.company_id
     and cp.period = date_trunc('month', d.dt)::date
   where coalesce((select f.enabled from public.feature_flags f
                    where f.name = 'period_lock'), true);
  if v_months is not null then
    raise exception
      'Ništa nije obrisano: izvod ima stavke u zaključanom periodu % — otključajte % u Podešavanjima → Zaključani periodi, pa ponovo obrišite izvod.',
      v_months, v_months
      using errcode = 'check_violation';
  end if;

  --    An invoice this batch paid that is dated in a locked month
  --    (20261125090000). Step 4 would rewrite its status and
  --    `period_lock_invoices` would refuse it after the writes, naming a month
  --    the statement is not in. The refusal stands; it is asked here, before
  --    any write, with the `enforce_period_lock` test (the switch, then
  --    `closed_periods` by the invoice's company and the month of
  --    `invoice_date`), and said plainly.
  select string_agg(distinct coalesce(i.invoice_number, '(bez broja)'), ', '),
         string_agg(distinct to_char(i.invoice_date, 'YYYY-MM'), ', ')
    into v_inv, v_months
    from public.invoices i
    join public.closed_periods cp
      on cp.company_id = i.company_id
     and cp.period = date_trunc('month', i.invoice_date)::date
   where i.id in (select invoice_id from pg_temp._touched_invoices)
     and coalesce((select f.enabled from public.feature_flags f
                    where f.name = 'period_lock'), true);
  if v_inv is not null then
    raise exception
      'Ništa nije obrisano: ovaj izvod je platio fakturu(e) % datiranu(e) u zaključanom periodu %, pa bi njegovo brisanje promenilo dug po njima u zaključanom mesecu — otključajte % u Podešavanjima → Zaključani periodi, pa ponovo obrišite izvod.',
      v_inv, v_months, v_months
      using errcode = 'check_violation';
  end if;

  -- 1. Soft delete the transactions. First, because the closed-period trigger
  --    is the only thing that refuses any of this, and it must refuse before
  --    an allocation has been removed.
  --
  --    `import_hash` is cleared in the same write (20261125090000): the
  --    unique indexes on it count soft-deleted rows, and a statement that was
  --    deleted must import again rather than read as "already imported".
  update public.transactions
     set deleted_at = now(), deleted_by = auth.uid(), import_hash = null
   where import_batch_id = v_batch
     and deleted_at is null;
  get diagnostics n_tx = row_count;

  update public.passthrough
     set deleted_at = now(), deleted_by = auth.uid(), import_hash = null
   where import_batch_id = v_batch
     and deleted_at is null;
  get diagnostics n_pt = row_count;

  if n_tx = 0 and n_pt = 0 then
    raise exception
      'Izvod % nema nijednu stavku — možda je već obrisan, ili njegove stavke nikad nisu označene njime.',
      p_batch_id using errcode = 'no_data_found';
  end if;

  -- 2. The allocations. A deleted transaction must not go on closing an
  --    invoice.
  delete from public.invoice_transaction_links l
   using public.transactions t
   where l.transaction_id = t.id
     and t.import_batch_id = v_batch;
  get diagnostics n_links = row_count;

  -- 3. Credit instalments these rows were paying, back to outstanding.
  with reopened as (
    update public.credit_installments ci
       set transaction_id = null, paid_amount = 0, status = 'outstanding',
           paid_date = null, updated_at = now()
      from public.transactions t
     where ci.transaction_id = t.id
       and t.import_batch_id = v_batch
    returning ci.credit_id
  )
  select count(*), array_agg(distinct credit_id) into n_inst, v_credits from reopened;

  -- 3b. And a credit those instalments had closed, open again
  --    (20261125090000).
  update public.credits
     set status = 'active', updated_at = now()
   where id = any (coalesce(v_credits, '{}'))
     and status = 'closed';
  get diagnostics n_credits = row_count;

  -- 4. The invoices, back to what they are now actually owed. Without this a
  --    fully paid invoice keeps saying `paid` while the payment that closed it
  --    is gone.
  update public.invoices i
     set status = v.calculated_status, updated_at = now()
    from public.v_invoice_status v
   where v.id = i.id
     and i.id in (select invoice_id from pg_temp._touched_invoices)
     and i.status is distinct from v.calculated_status;
  get diagnostics n_invoices = row_count;

  -- 5. And the statement record itself.
  delete from public.import_logs where filing_ref = p_batch_id;
  get diagnostics n_logs = row_count;

  return jsonb_build_object(
    'transactions_deleted', n_tx,
    'passthroughs_deleted', n_pt,
    'allocations_removed',  n_links,
    'installments_reopened', n_inst,
    'credits_reopened',     n_credits,
    'invoices_restated',    n_invoices,
    'statement_records_removed', n_logs
  );
end;
$$;

revoke all on function public.delete_statement_cascade(text, uuid) from public;
revoke all on function public.delete_statement_cascade(text, uuid) from anon;
grant execute on function public.delete_statement_cascade(text, uuid) to authenticated, service_role;

comment on function public.delete_statement_cascade(text, uuid) is
  'Removes a posted statement and everything it created: its transactions and '
  'pass-throughs (soft, deleted_by the caller, their import_hash cleared so the '
  'file imports again), their invoice allocations, the credit instalments they '
  'closed (and the credits those had closed), and the statement record. Restates every invoice it touched. All or nothing: a '
  'closed month of its own rows or of an invoice it paid is refused before any '
  'write. SECURITY DEFINER, because the restrictive '
  '_hide_deleted policies refuse the soft delete under invoker and then hide '
  'the deleted rows from the steps keyed on them; it re-imposes administrator '
  'or owner, is_member() and has_company_access of every live row itself. '
  'The batch is compared as a uuid. 20261125090000.';

-- ── C. The catalogue ───────────────────────────────────────────────────────
do $$
declare
  v_src  text;
  v_cfg  text[];
  v_fn   text;
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'delete_statement_cascade') <> 1 then
    raise exception 'public.delete_statement_cascade is not exactly one function -- an overload beside it would be called by a client that guessed the other signature -- rolling back';
  end if;

  select p.prosrc, p.proconfig into v_src, v_cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'delete_statement_cascade' and p.prosecdef;
  if v_src is null then
    raise exception
      'public.delete_statement_cascade is not security definer, so its soft delete meets the restrictive _hide_deleted policies and every caller gets "new row violates row-level security policy" -- rolling back';
  end if;

  if not ('search_path=public, pg_temp' = any (coalesce(v_cfg, '{}'))) then
    raise exception
      'public.delete_statement_cascade is security definer with settings %, not search_path=public, pg_temp -- a definer function must not resolve names through the caller''s path -- rolling back', v_cfg;
  end if;

  -- What the policies decided, decided in the body. The behaviour of the role
  -- check is asked of real people in section D; these are the parts that are
  -- TRUE for every administrator and owner today and so cannot be seen
  -- failing as anybody.
  if v_src not like '%v_role := public.get_my_role();%'
     or v_src not like '%v_role not in (''administrator'', ''owner'')%' then
    raise exception 'public.delete_statement_cascade does not ask get_my_role() for administrator or owner, so as definer it would let anybody signed in delete -- rolling back';
  end if;
  if v_src not like '%or not public.is_member() then%' then
    raise exception 'public.delete_statement_cascade does not ask is_member(), the RESTRICTIVE members_only it steps past -- rolling back';
  end if;
  if (select count(*) from regexp_matches(v_src, 'not public\.has_company_access\([tp]\.company_id\)', 'g')) <> 2 then
    raise exception 'public.delete_statement_cascade does not ask has_company_access of both its transactions and its pass-throughs, so as definer it would reach rows of companies the caller cannot see -- rolling back';
  end if;

  if not has_function_privilege('authenticated', 'public.delete_statement_cascade(text, uuid)', 'execute') then
    raise exception 'authenticated cannot call public.delete_statement_cascade -- "Obriši izvod" would fail -- rolling back';
  end if;
  if has_function_privilege('anon', 'public.delete_statement_cascade(text, uuid)', 'execute') then
    raise exception 'anon can call public.delete_statement_cascade, a definer function that deletes -- rolling back';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where n.nspname = 'public' and p.proname = 'delete_statement_cascade'
                and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'PUBLIC holds EXECUTE on public.delete_statement_cascade, a definer function that deletes -- rolling back';
  end if;

  -- The batch is compared as a uuid. `import_batch_id = p_batch_id` is
  -- `uuid = text` and fails at call time on every call.
  if v_src ~ 'import_batch_id\s*=\s*p_batch_id' then
    raise exception 'public.delete_statement_cascade still compares import_batch_id (uuid) with p_batch_id (text): operator does not exist: uuid = text, on every call -- rolling back';
  end if;

  -- A deleted statement imports again: both soft deletes clear the hash the
  -- unique indexes hold.
  if (select count(*) from regexp_matches(v_src,
        'set deleted_at = now\(\), deleted_by = auth\.uid\(\), import_hash = null', 'g')) <> 2 then
    raise exception 'public.delete_statement_cascade does not clear import_hash in both of its soft deletes, so the unique import_hash indexes, which count soft-deleted rows, refuse every line of the same statement imported again and the import screens report them as already imported -- rolling back';
  end if;

  -- A paid invoice in a locked month is refused before any write, by name.
  -- Asked of the text, because no row may be written to exercise it: the
  -- join to the locked month, the refusal that follows it, and that it comes
  -- before the first update.
  if v_src !~ 'cp\.company_id = i\.company_id\s+and cp\.period = date_trunc\(''month'', i\.invoice_date\)::date'
     or v_src !~ 'if v_inv is not null then\s+raise exception\s+''Ništa nije obrisano: ovaj izvod je platio fakturu\(e\)'
     or v_src not like '%otključajte % u Podešavanjima → Zaključani periodi%'
     or strpos(v_src, 'if v_inv is not null then') > strpos(v_src, 'update public.transactions') then
    raise exception 'public.delete_statement_cascade does not ask closed_periods for the invoices it restates before its first write, so an invoice dated in a locked month is refused by period_lock_invoices after the writes, naming a month the statement is not in -- rolling back';
  end if;

  -- The statement's own rows in a locked month, refused before any write, in
  -- Serbian: both tables, joined to the month, ahead of the first update.
  if v_src !~ 'from public\.transactions t\s+where t\.import_batch_id = v_batch and t\.deleted_at is null\s+union all\s+select p\.company_id, p\.transaction_date from public\.passthrough p'
     or v_src !~ 'cp\.company_id = d\.company_id\s+and cp\.period = date_trunc\(''month'', d\.dt\)::date'
     or v_src !~ 'if v_months is not null then\s+raise exception\s+''Ništa nije obrisano: izvod ima stavke u zaključanom periodu'
     or strpos(v_src, 'if v_months is not null then') > strpos(v_src, 'update public.transactions') then
    raise exception 'public.delete_statement_cascade does not ask closed_periods for its own rows before its first write, so the period-lock trigger refuses it after the writes in English -- rolling back';
  end if;

  -- A deleted invoice is restated by step 4 (v_invoice_status does not hide
  -- it) and so meets period_lock_invoices: the check must not skip it.
  if v_src ~ 'from public\.invoices i\s+join public\.closed_periods[^;]*i\.deleted_at is null' then
    raise exception 'public.delete_statement_cascade skips soft-deleted invoices in its closed-month check, but step 4 restates them and period_lock_invoices refuses them after the writes -- rolling back';
  end if;

  -- The caller is who deleted, not what the client sent.
  if v_src ~ 'deleted_by = p_deleted_by' then
    raise exception 'public.delete_statement_cascade writes deleted_by from its parameter, not auth.uid() -- rolling back';
  end if;

  -- A definer function bypasses RLS only if its OWNER does. Live, the owner
  -- is `postgres`, which carries BYPASSRLS; an owner without it would meet
  -- `_hide_deleted` exactly as an invoker caller does.
  for v_fn in
    select p.proname || ' (owner ' || ro.rolname || ')'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles ro on ro.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in ('delete_statement_cascade', 'delete_transaction_cascade')
       and not (ro.rolsuper or ro.rolbypassrls)
  loop
    raise exception 'public.% neither is a superuser nor carries BYPASSRLS, so as definer it still meets the restrictive _hide_deleted policies and every delete fails as it did -- rolling back', v_fn;
  end loop;

  -- Both deletes reopen the credit an instalment they reopen had closed, from
  -- the credit ids that instalment update returned.
  foreach v_fn in array array['delete_statement_cascade', 'delete_transaction_cascade'] loop
    select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if v_src !~ 'returning (ci\.)?credit_id\s+\)\s+select count\(\*\), array_agg\(distinct credit_id\) into'
       or v_src !~ 'update public\.credits\s+set status = ''active'', updated_at = now\(\)\s+where id = any \(coalesce\(v_credits, ''\{\}''\)\)\s+and status = ''closed''' then
      raise exception 'public.% does not set a credit it reopened an instalment of back to active, so a deleted last payment leaves the credit closed with an unpaid instalment nobody can pick -- rolling back', v_fn;
    end if;
  end loop;

  -- The single delete: one function, definer, its first step soft_delete_row
  -- as the caller, and the grants of a definer that deletes.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'delete_transaction_cascade') <> 1 then
    raise exception 'public.delete_transaction_cascade is not exactly one function -- rolling back';
  end if;
  select p.prosrc, p.proconfig into v_src, v_cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'delete_transaction_cascade' and p.prosecdef;
  if v_src is null or not ('search_path=public, pg_temp' = any (coalesce(v_cfg, '{}'))) then
    raise exception 'public.delete_transaction_cascade is not security definer with search_path=public, pg_temp -- rolling back';
  end if;
  if strpos(v_src, 'if not public.soft_delete_row(''transactions'', p_transaction_id, auth.uid()) then') = 0
     or strpos(v_src, 'if not public.soft_delete_row(''transactions''') > strpos(v_src, 'delete from public.invoice_transaction_links') then
    raise exception 'public.delete_transaction_cascade does not start with soft_delete_row as the caller, the one step that checks who may delete -- rolling back';
  end if;
  if not has_function_privilege('authenticated', 'public.delete_transaction_cascade(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.delete_transaction_cascade(uuid, uuid)', 'execute')
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
                       aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where n.nspname = 'public' and p.proname = 'delete_transaction_cascade'
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'public.delete_transaction_cascade: authenticated must call it, anon and PUBLIC must not -- rolling back';
  end if;

  -- What the definer does NOT step past: the closed-period triggers.
  foreach v_fn in array array['transactions', 'passthrough', 'invoices'] loop
    if not exists (select 1 from pg_trigger t
                    where t.tgrelid = format('public.%I', v_fn)::regclass
                      and t.tgname = 'period_lock_' || v_fn
                      and t.tgenabled <> 'D') then
      raise exception
        'period_lock_% is not an enabled trigger on public.%, so a closed month would no longer refuse what this function writes -- rolling back', v_fn, v_fn;
    end if;
  end loop;
end $$;

-- ── D. As every person, on a batch that is not there ───────────────────────
--
-- Each call names a batch no row carries, so each one raises and is rolled
-- back with everything it did; nothing is written. An administrator or an
-- owner must reach the function's own "nema nijednu stavku" refusal -- which
-- proves they get past role, membership and scope and past the uuid
-- comparison. Everybody else -- a manager, an assistant, a signed-in account
-- with no profile (MCFlow's MCOdobri users), and nobody -- must be refused on
-- role.
do $$
declare
  back      text := current_user;
  r         record;
  v_state   text;
  v_msg     text;
  v_state2  text;
  v_msg2    text;
  n_admins  int := 0;
  n_others  int := 0;
begin
  for r in
    select p.id, p.role, true as has_profile from public.profiles p
    union all
    (select u.id, null::text, false from auth.users u
      where not exists (select 1 from public.profiles p where p.id = u.id)
      order by u.id limit 1)
    union all
    select null::uuid, null::text, false
    order by 1 nulls last
  loop
    v_state := null;
    v_msg   := null;
    v_state2 := null;
    v_msg2   := null;
    perform set_config('request.jwt.claim.sub', coalesce(r.id::text, ''), true);
    perform set_config('request.jwt.claims',
                       case when r.id is null then ''
                            else jsonb_build_object('sub', r.id, 'role', 'authenticated')::text end,
                       true);
    execute 'set local role authenticated';
    begin
      perform public.delete_statement_cascade(gen_random_uuid()::text, null);
      v_state := 'none';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    end;
    begin
      perform public.delete_transaction_cascade(gen_random_uuid(), null);
      v_state2 := 'none';
    exception when others then
      get stacked diagnostics v_state2 = returned_sqlstate, v_msg2 = message_text;
    end;
    execute format('set local role %I', back);

    if r.role in ('administrator', 'owner') then
      if v_state is distinct from 'P0002' or v_msg not like 'Izvod % nema nijednu stavku%' then
        raise exception
          'as the % whose id is %, public.delete_statement_cascade(<a batch no row carries>) answered [%] %, not its own "nothing is there" refusal -- an administrator or an owner does not get past this function''s gates -- rolling back',
          r.role, r.id, coalesce(v_state, 'no error'), coalesce(v_msg, '');
      end if;
      if v_state2 is distinct from 'P0002' or v_msg2 not like 'No transactions with id %' then
        raise exception
          'as the % whose id is %, public.delete_transaction_cascade(<an id no row carries>) answered [%] %, not soft_delete_row''s "nothing is there" -- rolling back',
          r.role, r.id, coalesce(v_state2, 'no error'), coalesce(v_msg2, '');
      end if;
      n_admins := n_admins + 1;
    else
      if v_state is distinct from '42501'
         or v_msg is distinct from 'Samo administrator ili vlasnik može da obriše izvod.' then
        raise exception
          'as % (id %), public.delete_statement_cascade answered [%] %, not the role refusal -- a definer delete that does not refuse this caller lets them delete what transactions_delete never let them -- rolling back',
          coalesce(r.role, case when r.has_profile or r.id is null then 'a caller with no role' else 'a signed-in account with no profile' end),
          coalesce(r.id::text, 'none'), coalesce(v_state, 'no error'), coalesce(v_msg, '');
      end if;
      if v_state2 is distinct from '42501'
         or v_msg2 is distinct from 'Only an administrator or an owner can delete a record.' then
        raise exception
          'as % (id %), public.delete_transaction_cascade answered [%] %, not soft_delete_row''s role refusal -- rolling back',
          coalesce(r.role, 'a caller with no profile'), coalesce(r.id::text, 'none'),
          coalesce(v_state2, 'no error'), coalesce(v_msg2, '');
      end if;
      n_others := n_others + 1;
    end if;
  end loop;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  if n_admins = 0 then
    raise notice 'section D, NOT EXERCISED for the bar: public.profiles holds no administrator or owner, so nobody here could be seen getting PAST the gates. Section C asks the body instead. % other caller(s) were refused on role.', n_others;
  else
    raise notice 'section D: % administrator(s)/owner(s) got past every gate of both deletes to their own "nothing is there" refusal; % other caller(s), nobody included, were refused on role; nothing was written',
      n_admins, n_others;
  end if;
end $$;

commit;
