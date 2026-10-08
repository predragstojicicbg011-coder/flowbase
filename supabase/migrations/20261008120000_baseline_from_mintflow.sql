--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- Mintflow's database had btree_gist enabled by hand; the exclusion
-- constraints below (no overlapping validity ranges per employee) need it.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: audit_trigger(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.audit_log (table_name, record_id, action, old_data, new_data, user_id)
  values (
    tg_table_name,
    case when tg_op = 'DELETE' then old.id else new.id end,
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    auth.uid()
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;


--
-- Name: claim_chargebee_snapshot(date, text, uuid, text, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_chargebee_snapshot(p_date date, p_site text, p_company uuid DEFAULT NULL::uuid, p_brand text DEFAULT NULL::text, p_stale_after interval DEFAULT '00:05:00'::interval) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  insert into public.chargebee_snapshot_runs
    (snapshot_date, site, company_id, brand, status, started_at,
     finished_at, subscriptions, error, export_id)
  values (p_date, p_site, p_company, p_brand, 'running', clock_timestamp(),
          null, null, null, null)
  on conflict (snapshot_date, site) do update
     set status        = 'running',
         started_at    = clock_timestamp(),
         finished_at   = null,
         subscriptions = null,
         error         = null,
         export_id     = null,
         company_id    = excluded.company_id,
         brand         = excluded.brand
   -- The claim. A run already in flight is left alone; one that has been
   -- "running" longer than the sync can possibly take is a run whose function
   -- died, and may be taken over.
   where public.chargebee_snapshot_runs.status <> 'running'
      or public.chargebee_snapshot_runs.started_at < clock_timestamp() - p_stale_after
  returning id;
$$;


--
-- Name: claim_processor_sync(date, text, text, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_processor_sync(p_date date, p_provider text, p_account text DEFAULT ''::text, p_stale_after interval DEFAULT '00:05:00'::interval) RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  insert into public.processor_sync_runs
    (sync_date, provider, account, status, started_at,
     finished_at, transactions, error, export_id)
  values (p_date, p_provider, p_account, 'running', clock_timestamp(),
          null, null, null, null)
  on conflict (sync_date, provider, account) do update
     set status       = 'running',
         started_at   = clock_timestamp(),
         finished_at  = null,
         transactions = null,
         error        = null,
         export_id    = null
   where public.processor_sync_runs.status <> 'running'
      or public.processor_sync_runs.started_at < clock_timestamp() - p_stale_after
  returning id;
$$;


--
-- Name: delete_statement_cascade(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_statement_cascade(p_batch_id text, p_deleted_by uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  n_tx       int;
  n_pt       int;
  n_links    int;
  n_inst     int;
  n_invoices int;
  n_logs     int;
begin
  if p_batch_id is null or btrim(p_batch_id) = '' then
    raise exception 'No statement was named' using errcode = 'invalid_parameter_value';
  end if;

  -- Which invoices this batch was paying, captured BEFORE the allocations go,
  -- because afterwards there is nothing left to say so.
  create temporary table _touched_invoices on commit drop as
  select distinct l.invoice_id
    from public.invoice_transaction_links l
    join public.transactions t on t.id = l.transaction_id
   where t.import_batch_id = p_batch_id;

  -- 1. Soft delete the transactions. First, because the closed-period trigger
  --    is the only thing that refuses any of this, and it must refuse before
  --    an allocation has been removed.
  update public.transactions
     set deleted_at = now(), deleted_by = p_deleted_by
   where import_batch_id = p_batch_id
     and deleted_at is null;
  get diagnostics n_tx = row_count;

  update public.passthrough
     set deleted_at = now(), deleted_by = p_deleted_by
   where import_batch_id = p_batch_id
     and deleted_at is null;
  get diagnostics n_pt = row_count;

  if n_tx = 0 and n_pt = 0 then
    raise exception
      'No rows belong to statement % — it may already have been deleted, or its rows were never stamped with it.',
      p_batch_id using errcode = 'no_data_found';
  end if;

  -- 2. The allocations. A deleted transaction must not go on closing an
  --    invoice.
  delete from public.invoice_transaction_links l
   using public.transactions t
   where l.transaction_id = t.id
     and t.import_batch_id = p_batch_id;
  get diagnostics n_links = row_count;

  -- 3. Credit instalments these rows were paying, back to outstanding.
  update public.credit_installments ci
     set transaction_id = null, paid_amount = 0, status = 'outstanding',
         paid_date = null, updated_at = now()
    from public.transactions t
   where ci.transaction_id = t.id
     and t.import_batch_id = p_batch_id;
  get diagnostics n_inst = row_count;

  -- 4. The invoices, back to what they are now actually owed. Without this a
  --    fully paid invoice keeps saying `paid` while the payment that closed it
  --    is gone.
  update public.invoices i
     set status = v.calculated_status, updated_at = now()
    from public.v_invoice_status v
   where v.id = i.id
     and i.id in (select invoice_id from _touched_invoices)
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
    'invoices_restated',    n_invoices,
    'statement_records_removed', n_logs
  );
end;
$$;


--
-- Name: FUNCTION delete_statement_cascade(p_batch_id text, p_deleted_by uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.delete_statement_cascade(p_batch_id text, p_deleted_by uuid) IS 'Removes a posted statement and everything it created: its transactions and pass-throughs (soft), their invoice allocations, the credit instalments they closed, and the statement record. Restates every invoice it touched. All or nothing — a closed period refuses the whole batch.';


--
-- Name: delete_transaction_cascade(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_transaction_cascade(p_transaction_id uuid, p_deleted_by uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_links int;
  v_insts int;
begin
  if not public.soft_delete_row('transactions', p_transaction_id, p_deleted_by) then
    raise exception 'No transaction with id % — nothing was deleted.', p_transaction_id
      using errcode = 'no_data_found';
  end if;

  delete from public.invoice_transaction_links where transaction_id = p_transaction_id;
  get diagnostics v_links = row_count;

  update public.credit_installments
     set transaction_id = null, status = 'outstanding', paid_date = null, paid_amount = 0
   where transaction_id = p_transaction_id;
  get diagnostics v_insts = row_count;

  return jsonb_build_object('invoice_links_removed', v_links,
                           'installments_unlinked', v_insts);
end $$;


--
-- Name: enforce_period_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_period_lock() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  date_col text := tg_argv[0];
  rec_new  jsonb;
  rec_old  jsonb;
  d_new    date;
  d_old    date;
  cid_new  uuid;
  cid_old  uuid;
  blocked  date;
begin
  -- Global switch. Checked first because it is the cheapest exit: when it is
  -- off the trigger does no further work.
  if not coalesce((select f.enabled from public.feature_flags f
                    where f.name = 'period_lock'), true) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    rec_new := to_jsonb(new);
    d_new   := nullif(rec_new ->> date_col, '')::date;
    cid_new := nullif(rec_new ->> 'company_id', '')::uuid;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    rec_old := to_jsonb(old);
    d_old   := nullif(rec_old ->> date_col, '')::date;
    cid_old := nullif(rec_old ->> 'company_id', '')::uuid;
  end if;

  -- Both old and new state are checked: this blocks writing INTO a locked
  -- period as well as moving a row OUT of one.
  if d_old is not null and cid_old is not null
     and exists (select 1 from public.closed_periods cp
                  where cp.company_id = cid_old
                    and cp.period = date_trunc('month', d_old)::date)
  then
    blocked := d_old;
  elsif d_new is not null and cid_new is not null
     and exists (select 1 from public.closed_periods cp
                  where cp.company_id = cid_new
                    and cp.period = date_trunc('month', d_new)::date)
  then
    blocked := d_new;
  end if;

  if blocked is not null then
    raise exception
      'Period % is locked for this company — changes are not allowed. Unlock it in Settings and try again.',
      to_char(blocked, 'YYYY-MM')
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;


--
-- Name: fill_id_at_gateway(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_id_at_gateway() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.id_at_gateway is null
     and new.notes is not null
     and new.notes <> ''
  then
    begin
      new.id_at_gateway := nullif(btrim(new.notes::jsonb ->> 'id_at_gateway'), '');
    exception when others then
      -- `notes` is free text on some rows and JSON on others. A row whose
      -- notes are not JSON is not an error: it simply has no gateway id, and
      -- failing the insert over it would stop a sync for a reason that has
      -- nothing to do with the row being saved.
      new.id_at_gateway := null;
    end;
  end if;
  return new;
end
$$;


--
-- Name: get_my_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$;


--
-- Name: get_unmatched_braintree(text, date, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unmatched_braintree(p_site text DEFAULT NULL::text, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_limit integer DEFAULT 50) RETURNS TABLE(id uuid, processor text, amount numeric, currency text, transaction_date date, notes text)
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT id, processor, amount, currency, transaction_date, notes::text
  FROM revenue_collections
  WHERE status = 'unmatched'
    AND (p_site IS NULL OR processor = 'chargebee_' || p_site)
    AND (p_date_from IS NULL OR transaction_date >= p_date_from)
    AND (p_date_to IS NULL OR transaction_date <= p_date_to)
    AND notes::json->>'gateway' = 'braintree'
    AND notes::json->>'payment_method' NOT IN ('paypal_express_checkout', 'chargeback')
  ORDER BY transaction_date
  LIMIT p_limit;
$$;


--
-- Name: has_company_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_company_access(p_company_id uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = auth.uid()
    AND (
      role IN ('administrator', 'owner')
      OR p_company_id::text = ANY(company_access)
    )
  )
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('administrator', 'owner')
  );
$$;


--
-- Name: log_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO audit_log (user_id, user_email, action, table_name, record_id, old_data, new_data)
  VALUES (
    auth.uid(),
    (SELECT email FROM profiles WHERE id = auth.uid()),
    TG_OP,
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN row_to_json(OLD)::jsonb ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN row_to_json(NEW)::jsonb ELSE NULL END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: payroll_run_lines_frozen(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payroll_run_lines_frozen() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare v_status text;
begin
  select r.status into v_status from public.payroll_runs r
   where r.id = coalesce(new.run_id, old.run_id);

  if v_status = 'posted' then
    raise exception 'This month has been posted, so its lines cannot change. '
      'Delete the posting from the Payroll page first — that puts the run back to '
      'draft and lets it be recalculated.'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;


--
-- Name: FUNCTION payroll_run_lines_frozen(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.payroll_run_lines_frozen() IS 'A posted run is frozen. Enforced here rather than in the page, which a second tab or a stale screen would walk straight past.';


--
-- Name: pl_splits_must_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pl_splits_must_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  src       text;
  src_id    uuid;
  lines     numeric;
  parent    numeric;
  short     numeric;
begin
  src := coalesce(new.source, old.source);
  src_id := coalesce(new.source_id, old.source_id);

  select coalesce(sum(amount), 0) into lines
    from public.pl_splits
   where source = src and source_id = src_id;

  -- Every line removed is a split undone; nothing left to balance.
  if lines = 0 and not exists (
    select 1 from public.pl_splits where source = src and source_id = src_id
  ) then
    return null;
  end if;

  if src = 'transaction' then
    select amount into parent from public.transactions where id = src_id;
  else
    select amount into parent from public.invoices where id = src_id;
  end if;

  if parent is null then
    raise exception 'A split names a % that is not there (%)', src, src_id;
  end if;

  short := round(parent - lines, 2);
  -- A cent, the same tolerance the form applies. Anything inside it is a
  -- rounding artefact; anything outside it is a disagreement.
  if abs(short) > 0.01 then
    raise exception
      'The split of % % comes to % and the payment is % — % unaccounted for',
      src, src_id, round(lines, 2), round(parent, 2), short;
  end if;

  return null;
end
$$;


--
-- Name: reconcile_direct_transaction(uuid, uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_usd numeric) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Kreiraj link
  INSERT INTO invoice_transaction_links
    (invoice_id, transaction_id, allocated_amount, allocated_amount_usd)
  SELECT
    p_invoice_id,
    p_transaction_id,
    p_allocated_usd,
    p_allocated_usd
  ON CONFLICT (invoice_id, transaction_id) DO UPDATE
    SET allocated_amount_usd = p_allocated_usd;

  -- Invoice preuzima P&L
  UPDATE invoices
  SET pl_impact = true
  WHERE id = p_invoice_id;

  -- Direct tx gubi P&L uticaj
  UPDATE transactions
  SET
    pl_impact = false,
    status = 'reconciled'
  WHERE id = p_transaction_id;
END;
$$;


--
-- Name: run_chargebee_snapshot(boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_chargebee_snapshot(force boolean DEFAULT false, p_site text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'net'
    AS $$
declare
  hour_now int;
  fn_url   text;
  fn_key   text;
  request  bigint;
  outcome  text;
  site_txt text;
begin
  hour_now := extract(hour from (now() at time zone 'Europe/Belgrade'))::int;
  site_txt := case when p_site is null then '' else ' for ' || p_site end;

  if hour_now <> 7 and not force then
    outcome := 'woke an hour out — this is the daylight-saving half of the pair';
    insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
    values ('chargebee-snapshot', now() at time zone 'Europe/Belgrade', hour_now, false, outcome);
    return outcome;
  end if;

  select value into fn_url from public.job_config where key = 'chargebee_snapshot_url';
  select value into fn_key from public.job_config where key = 'service_role_key';

  if fn_url is null or fn_key is null then
    outcome := 'job_config has no chargebee_snapshot_url and/or service_role_key — nothing was called';
    insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
    values ('chargebee-snapshot', now() at time zone 'Europe/Belgrade', hour_now, true, outcome);
    return outcome;
  end if;

  -- pg_net hands the request off and returns an id rather than waiting. One
  -- site takes up to ninety seconds and the database has no business sitting
  -- through it; what came back is in `net._http_response` under this id.
  select net.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || fn_key,
                 'Content-Type',  'application/json'),
    -- Named or not. An empty object is what the morning sends, and the
    -- function then takes whichever site is next.
    body    := case when p_site is null
                 then '{}'::jsonb
                 else jsonb_build_object('site', p_site) end,
    timeout_milliseconds := 120000
  ) into request;

  outcome := 'called the snapshot function' || site_txt || '; pg_net request ' || request
             || case when force and hour_now <> 7
                  then ' — FORCED at ' || hour_now || ':00 Belgrade, not the morning run'
                  else '' end;

  insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
  values ('chargebee-snapshot', now() at time zone 'Europe/Belgrade', hour_now, true, outcome);

  return outcome;
end
$$;


--
-- Name: run_processor_sync(text, boolean, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_processor_sync(p_function text, force boolean DEFAULT false, p_body jsonb DEFAULT '{}'::jsonb) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'net'
    AS $_$
declare
  hour_now int;
  base_url text;
  fn_key   text;
  request  bigint;
  outcome  text;
begin
  hour_now := extract(hour from (now() at time zone 'Europe/Belgrade'))::int;

  if hour_now <> 7 and not force then
    outcome := p_function || ': woke an hour out — the daylight-saving half of the pair';
    insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
    values (p_function, now() at time zone 'Europe/Belgrade', hour_now, false, outcome);
    return outcome;
  end if;

  -- The snapshot's own url is the one entry that already holds the project's
  -- function base; the processor functions sit beside it.
  select regexp_replace(value, '/[^/]+$', '/' || p_function)
    into base_url
    from public.job_config where key = 'chargebee_snapshot_url';
  select value into fn_key from public.job_config where key = 'service_role_key';

  if base_url is null or fn_key is null then
    outcome := p_function || ': job_config has no chargebee_snapshot_url and/or '
             || 'service_role_key — nothing was called';
    insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
    values (p_function, now() at time zone 'Europe/Belgrade', hour_now, true, outcome);
    return outcome;
  end if;

  -- pg_net hands the request off and returns an id rather than waiting. What
  -- came back is in `net._http_response` under this id.
  select net.http_post(
    url     := base_url,
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || fn_key,
                 'Content-Type',  'application/json'),
    body    := p_body,
    timeout_milliseconds := 150000
  ) into request;

  outcome := p_function || ': called, pg_net request ' || request
           || case when force and hour_now <> 7
                then ' — FORCED at ' || hour_now || ':00 Belgrade' else '' end;

  insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
  values (p_function, now() at time zone 'Europe/Belgrade', hour_now, true, outcome);

  return outcome;
end
$_$;


--
-- Name: soft_delete_row(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.soft_delete_row(p_table text, p_id uuid, p_deleted_by uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_company uuid;
  v_role    text;
  v_rows    int;
begin
  if p_table not in ('transactions', 'invoices', 'passthrough') then
    raise exception 'soft_delete_row does not handle %', p_table
      using errcode = 'invalid_parameter_value';
  end if;

  -- The caller's rights, not the owner's. `security definer` has already
  -- thrown the policies away, so everything they enforced is enforced here.
  v_role := public.get_my_role();
  if v_role is null or v_role not in ('administrator', 'owner') then
    raise exception 'Only an administrator or an owner can delete a record.'
      using errcode = 'insufficient_privilege';
  end if;

  execute format('select company_id from public.%I where id = $1', p_table)
    into v_company using p_id;

  if v_company is null then
    raise exception 'No % with id % — nothing was deleted.', p_table, p_id
      using errcode = 'no_data_found';
  end if;

  if not public.has_company_access(v_company) then
    raise exception 'You do not have access to that company.'
      using errcode = 'insufficient_privilege';
  end if;

  -- No RETURNING. The row is invisible the instant deleted_at is set, so
  -- asking for it back would fail for a reason that has nothing to do with
  -- whether the write landed.
  execute format(
    'update public.%I set deleted_at = now(), deleted_by = $2 '
    'where id = $1 and deleted_at is null', p_table)
    using p_id, p_deleted_by;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    user_email text,
    action text NOT NULL,
    table_name text NOT NULL,
    record_id uuid,
    old_data jsonb,
    new_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: banks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.banks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    name text NOT NULL,
    type text DEFAULT 'bank'::text,
    currencies text[],
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: budget_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    budget_month date NOT NULL,
    level text NOT NULL,
    pl_category text,
    pl_subcategory text,
    department text,
    dept_subcategory text,
    expense_description text,
    kind text NOT NULL,
    amount_usd numeric NOT NULL,
    reason text NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    seed_usd numeric,
    CONSTRAINT budget_adjustments_kind_check CHECK ((kind = ANY (ARRAY['set'::text, 'adjust'::text]))),
    CONSTRAINT budget_adjustments_level_check CHECK ((level = ANY (ARRAY['pl_category'::text, 'pl_subcategory'::text, 'department'::text, 'dept_subcategory'::text, 'expense_description'::text]))),
    CONSTRAINT budget_adjustments_reason_check CHECK ((btrim(reason) <> ''::text))
);


--
-- Name: COLUMN budget_adjustments.company_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_adjustments.company_id IS 'Null means the group: a budget line is set consolidated. A non-null value is history - the rows carried across from budget_entries, which was per company. Every row counts toward the group total regardless; do not null, merge or delete the ones that carry a company.';


--
-- Name: COLUMN budget_adjustments.seed_usd; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.budget_adjustments.seed_usd IS 'The seed this entry''s node carried, in this month, when the figure was typed. applyLedger replays the deltas on the most recent recorded seed, so a typed figure does not move when the benchmark month rolls over. Null on entries written before this existed; those keep the old behaviour until re-recorded.';


--
-- Name: budget_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    budget_month date NOT NULL,
    pl_category text,
    pl_subcategory text,
    department text,
    dept_subcategory text,
    expense_description text,
    rev_alloc_type text DEFAULT 'sg100'::text,
    estimated_amount numeric DEFAULT 0 NOT NULL,
    estimated_amount_usd numeric,
    note text,
    is_manual_override boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: cash_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    as_of date NOT NULL,
    amount_usd numeric(14,2) NOT NULL,
    note text,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_positions_amount_usd_check CHECK ((amount_usd >= (0)::numeric))
);


--
-- Name: TABLE cash_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cash_positions IS 'What was in the accounts on a given day, reported by a person. There is no cash balance in the ledger to derive this from — `transactions` records movements and nothing carries an opening figure. Dated, so a runway computed last quarter can still be reconstructed.';


--
-- Name: chargebee_site_brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chargebee_site_brands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    site text NOT NULL,
    brand text NOT NULL,
    revenue_stream text NOT NULL,
    company_id uuid,
    is_active boolean DEFAULT true,
    CONSTRAINT chargebee_site_brands_revenue_stream_check CHECK ((revenue_stream = ANY (ARRAY['social_growth'::text, 'aimfox'::text, 'other'::text]))),
    CONSTRAINT chargebee_site_brands_stream_is_known CHECK (((revenue_stream IS NULL) OR (revenue_stream = ANY (ARRAY['aimfox'::text, 'social_growth'::text]))))
);


--
-- Name: COLUMN chargebee_site_brands.revenue_stream; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chargebee_site_brands.revenue_stream IS 'Which stream this brand reports into. Aimfox is a stream of one; every other brand is Social Growth. Here rather than in the page, so a tenth brand is a row and not an edit.';


--
-- Name: chargebee_snapshot_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chargebee_snapshot_runs (
    id bigint NOT NULL,
    snapshot_date date NOT NULL,
    site text NOT NULL,
    company_id uuid,
    brand text,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    subscriptions integer,
    error text,
    export_id text,
    fx_note text,
    CONSTRAINT chargebee_snapshot_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: TABLE chargebee_snapshot_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chargebee_snapshot_runs IS 'One Chargebee subscription sync per site per day. Only `complete` runs are readable through v_chargebee_latest_subscriptions: a sync that died halfway leaves rows indistinguishable from a finished one.';


--
-- Name: COLUMN chargebee_snapshot_runs.export_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chargebee_snapshot_runs.export_id IS 'The Chargebee export this snapshot was read out of. Checkable against Chargebee''s own export history.';


--
-- Name: COLUMN chargebee_snapshot_runs.fx_note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chargebee_snapshot_runs.fx_note IS 'The rates this run converted at, and where they came from. Null on a run that had nothing to convert.';


--
-- Name: chargebee_snapshot_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.chargebee_snapshot_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.chargebee_snapshot_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: chargebee_subscription_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chargebee_subscription_snapshots (
    run_id bigint NOT NULL,
    subscription_id text NOT NULL,
    status text NOT NULL,
    plan_id text,
    currency text DEFAULT 'USD'::text NOT NULL,
    next_billing_amount numeric(14,2) DEFAULT 0 NOT NULL,
    next_billing_at date,
    cycle_months integer,
    mrr numeric(14,2),
    fx_rate numeric(18,8) DEFAULT 1 NOT NULL,
    next_billing_amount_usd numeric(14,2) GENERATED ALWAYS AS (round((next_billing_amount / fx_rate), 2)) STORED,
    CONSTRAINT a_foreign_amount_needs_a_real_rate CHECK (((upper(currency) = 'USD'::text) OR (fx_rate <> (1)::numeric))),
    CONSTRAINT snapshots_fx_rate_is_usable CHECK ((fx_rate > (0)::numeric))
);


--
-- Name: COLUMN chargebee_subscription_snapshots.next_billing_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chargebee_subscription_snapshots.next_billing_amount IS 'Major units. The API answers in minor units; the sync divides once.';


--
-- Name: COLUMN chargebee_subscription_snapshots.fx_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chargebee_subscription_snapshots.fx_rate IS 'Units of `currency` per 1 USD on the morning of the snapshot — the same meaning `exchange_rate` carries everywhere else here. USD is 1. Stored rather than looked up, because a forecast has to still read the same way in December as it did on the day it was made.';


--
-- Name: COLUMN chargebee_subscription_snapshots.next_billing_amount_usd; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.chargebee_subscription_snapshots.next_billing_amount_usd IS 'Generated, never written. A stored amount and a stored rate that disagree is a fault no check anybody would think to run would catch.';


--
-- Name: closed_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.closed_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    period date NOT NULL,
    closed_by uuid,
    closed_at timestamp with time zone DEFAULT now() NOT NULL,
    note text
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid,
    name text NOT NULL,
    country text,
    currency text,
    created_at timestamp with time zone DEFAULT now(),
    currencies text[] DEFAULT '{}'::text[]
);


--
-- Name: company_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_bank_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_name text NOT NULL,
    account_number text NOT NULL,
    currency text DEFAULT 'RSD'::text,
    is_primary boolean DEFAULT false,
    swift text,
    iban text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: company_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    full_legal_name text,
    address text,
    city text,
    country text DEFAULT 'Srbija'::text,
    pib text,
    mb text,
    pdv_number text,
    phone text,
    email text,
    website text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: credit_extensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_extensions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credit_id uuid NOT NULL,
    extended_on date DEFAULT CURRENT_DATE NOT NULL,
    previous_maturity date,
    new_maturity date NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid()
);


--
-- Name: TABLE credit_extensions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.credit_extensions IS 'Append-only history of every roll of a revolving line. The current maturity lives on credits.maturity_date; this is how it got there.';


--
-- Name: credit_installments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_installments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credit_id uuid,
    installment_no integer NOT NULL,
    due_date date NOT NULL,
    principal_amount numeric(14,2) DEFAULT 0 NOT NULL,
    interest_amount numeric(14,2) DEFAULT 0 NOT NULL,
    total_amount numeric(14,2) NOT NULL,
    status text DEFAULT 'outstanding'::text NOT NULL,
    transaction_id uuid,
    paid_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    paid_amount numeric(14,2) DEFAULT 0,
    CONSTRAINT credit_installments_status_check CHECK ((status = ANY (ARRAY['paid'::text, 'outstanding'::text])))
);


--
-- Name: credit_rate_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_rate_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credit_id uuid NOT NULL,
    effective_from date NOT NULL,
    reference_rate numeric(7,4) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid()
);


--
-- Name: TABLE credit_rate_resets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.credit_rate_resets IS 'Append-only. The rate in force for a month is the credit''s margin plus the latest reset on or before it; a reset never rewrites a month that has already been priced.';


--
-- Name: credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    name text NOT NULL,
    bank text NOT NULL,
    principal_amount numeric(14,2) NOT NULL,
    currency text DEFAULT 'RSD'::text,
    interest_rate numeric(6,4),
    rate_type text DEFAULT 'fixed'::text,
    rate_description text,
    disbursement_date date,
    first_payment_date date,
    last_payment_date date,
    monthly_annuity numeric(14,2),
    total_installments integer,
    status text DEFAULT 'active'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    kind text DEFAULT 'annuity'::text NOT NULL,
    maturity_date date,
    rate_margin numeric(7,4),
    reference_rate_name text,
    CONSTRAINT credits_kind_check CHECK ((kind = ANY (ARRAY['annuity'::text, 'revolving'::text]))),
    CONSTRAINT credits_rate_type_check CHECK ((rate_type = ANY (ARRAY['fixed'::text, 'variable'::text]))),
    CONSTRAINT credits_status_check CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text, 'restructured'::text])))
);


--
-- Name: COLUMN credits.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.credits.kind IS 'annuity: amortising, principal and interest in every instalment. revolving: interest only until maturity, then the principal in one payment.';


--
-- Name: COLUMN credits.maturity_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.credits.maturity_date IS 'Revolving only: when the principal falls due. The CURRENT value — every roll of it is a row in credit_extensions.';


--
-- Name: COLUMN credits.rate_margin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.credits.rate_margin IS 'The fixed part of a variable rate, in percent. The benchmark it sits over is a series in credit_rate_resets.';


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dept_subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dept_subcategories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    department_id uuid,
    name text NOT NULL,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: employee_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    currency text DEFAULT 'EUR'::text NOT NULL,
    net_amount numeric NOT NULL,
    service_years integer,
    transport_net numeric DEFAULT 0 NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_contracts_currency_check CHECK ((currency = ANY (ARRAY['EUR'::text, 'RSD'::text, 'USD'::text]))),
    CONSTRAINT employee_contracts_net_amount_check CHECK ((net_amount >= (0)::numeric)),
    CONSTRAINT employee_contracts_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT employee_contracts_service_years_check CHECK ((service_years >= 0)),
    CONSTRAINT employee_contracts_transport_net_check CHECK ((transport_net >= (0)::numeric))
);


--
-- Name: COLUMN employee_contracts.net_amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_contracts.net_amount IS 'Contracted NET including seniority, as the payslip states it. The base is net_amount / (1 + service_years * coefficient) — divided, never added.';


--
-- Name: COLUMN employee_contracts.service_years; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_contracts.service_years IS 'An override, normally null. Null means the years are derived from employees.seniority_from, which cannot go stale; fill this in only where MPP disagrees with the derivation, and say why in the note.';


--
-- Name: employee_cost_allocation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_cost_allocation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    department text NOT NULL,
    dept_subcategory text,
    rev_alloc_type text DEFAULT 'sg100'::text NOT NULL,
    opex_type text DEFAULT 'opex'::text NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_cost_allocation_department_check CHECK ((btrim(department) <> ''::text)),
    CONSTRAINT employee_cost_allocation_known_codes CHECK (((rev_alloc_type = ANY (ARRAY['sg100'::text, 'af100'::text, 'shared'::text, 'byval'::text])) AND (opex_type = ANY (ARRAY['opex'::text, 'performance'::text, 'split'::text])))),
    CONSTRAINT employee_cost_allocation_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);


--
-- Name: TABLE employee_cost_allocation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.employee_cost_allocation IS 'Which department and which revenue allocation a salary posts to, with the dates it applied. A move between departments must not rewrite what the old one cost in the months before it.';


--
-- Name: employee_deductions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_deductions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    label text NOT NULL,
    goes_to text NOT NULL,
    payee text,
    amount numeric,
    percent_of_net numeric,
    valid_from date NOT NULL,
    valid_to date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    currency text DEFAULT 'RSD'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    payee_partner_id uuid,
    CONSTRAINT employee_deductions_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT employee_deductions_currency_is_known CHECK ((currency = ANY (ARRAY['RSD'::text, 'EUR'::text, 'USD'::text]))),
    CONSTRAINT employee_deductions_goes_to_check CHECK ((goes_to = ANY (ARRAY['third_party'::text, 'employer'::text]))),
    CONSTRAINT employee_deductions_label_check CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT employee_deductions_one_way_of_saying_it CHECK (((amount IS NULL) <> (percent_of_net IS NULL))),
    CONSTRAINT employee_deductions_percent_has_no_currency CHECK (((percent_of_net IS NULL) OR (currency = 'RSD'::text))),
    CONSTRAINT employee_deductions_percent_of_net_check CHECK (((percent_of_net >= (0)::numeric) AND (percent_of_net <= (1)::numeric))),
    CONSTRAINT employee_deductions_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);


--
-- Name: COLUMN employee_deductions.amount; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_deductions.amount IS 'In `currency`. A euro deduction is converted at the month being calculated, the same rate a euro contract uses — never at a rate frozen into the row.';


--
-- Name: COLUMN employee_deductions.is_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_deductions.is_active IS 'Switched off rather than ended when an arrangement is suspended: ending it loses that it is the same arrangement, deleting it loses the months it ran. An inactive deduction is skipped by every run but stays on the employee.';


--
-- Name: COLUMN employee_deductions.payee_partner_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employee_deductions.payee_partner_id IS 'The partner a third-party deduction is forwarded to. Preferred over the `payee` text when set; the text remains what the arrangement says.';


--
-- Name: employee_payroll_absence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_payroll_absence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    reason text NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_payroll_absence_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT employee_payroll_absence_reason_check CHECK ((reason = ANY (ARRAY['maternity'::text, 'parental'::text, 'sick_leave_fund'::text, 'unpaid_leave'::text, 'suspension'::text, 'other'::text])))
);


--
-- Name: TABLE employee_payroll_absence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.employee_payroll_absence IS 'Periods where somebody is employed but their salary is not ours to calculate or pay — maternity leave above all. Not the same as leaving: the contract, department and deductions all stay, ready for their return.';


--
-- Name: employee_research_engagement; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_research_engagement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    share numeric NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_research_engagement_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT employee_research_engagement_share_check CHECK (((share > (0)::numeric) AND (share <= (1)::numeric)))
);


--
-- Name: TABLE employee_research_engagement; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.employee_research_engagement IS 'Истраживање и развој по члановима 21и и 45з, as a share of working time with the dates it applied. No row for a month means no subsidy that month.';


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    code text,
    full_name text NOT NULL,
    organisational_unit text,
    hired_on date,
    left_on date,
    note text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    seniority_from date,
    CONSTRAINT employees_full_name_check CHECK ((btrim(full_name) <> ''::text)),
    CONSTRAINT employees_left_after_hired CHECK (((left_on IS NULL) OR (hired_on IS NULL) OR (left_on >= hired_on)))
);


--
-- Name: TABLE employees; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.employees IS 'People on the payroll, and only what a calculation needs: who they are, which unit, the dates that decide whether a month includes them, and the date seniority counts from. Deliberately not their bank details.';


--
-- Name: COLUMN employees.seniority_from; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.seniority_from IS 'Датум почетка последњег ангажовања. Seniority is the whole years from this date to the month being calculated — proved against all fourteen employees of the August 2026 export.';


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rate_date date NOT NULL,
    from_currency text NOT NULL,
    to_currency text DEFAULT 'USD'::text,
    rate numeric(18,6) NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: expense_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text,
    sort_order integer
);


--
-- Name: expense_descriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_descriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dept_subcategory_id uuid,
    name text NOT NULL,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: expense_subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_subcategories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid,
    name text NOT NULL,
    sort_order integer
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: import_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_id uuid,
    import_type text DEFAULT 'bank_statement'::text NOT NULL,
    file_name text,
    date_from date,
    date_to date,
    row_count integer,
    period_month text,
    filing_ref text,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    created_by text,
    default_currency text
);


--
-- Name: installments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid,
    due_date date NOT NULL,
    amount numeric(18,2) NOT NULL,
    is_paid boolean DEFAULT false,
    paid_at timestamp with time zone
);


--
-- Name: integration_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    site text,
    api_key text,
    api_secret text,
    merchant_id text,
    extra jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.integration_credentials FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid,
    matched_transaction_id uuid,
    match_type text,
    matched_amount numeric(18,2),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT invoice_matches_match_type_check CHECK ((match_type = ANY (ARRAY['full'::text, 'partial'::text, 'overpayment'::text])))
);


--
-- Name: invoice_transaction_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_transaction_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    allocated_amount numeric(18,2) NOT NULL,
    allocated_amount_usd numeric(18,2),
    note text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_id uuid,
    partner_id uuid,
    invoice_number text,
    invoice_date date NOT NULL,
    due_date date,
    type text NOT NULL,
    pl_category text,
    pl_subcategory text,
    department text,
    dept_subcategory text,
    expense_description text,
    revenue_stream text,
    rev_alloc_type text DEFAULT 'sg100'::text,
    dept_split_type text DEFAULT 'none'::text,
    currency text NOT NULL,
    amount numeric(18,2) NOT NULL,
    exchange_rate numeric(18,6),
    amount_usd numeric(18,2),
    is_indexed boolean DEFAULT false,
    account_number text,
    model text,
    reference_number text,
    pl_impact boolean DEFAULT true,
    note text,
    tags text[],
    status text DEFAULT 'unpaid'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    rev_alloc_aimfox numeric,
    rev_alloc_sg numeric,
    opex_type text DEFAULT 'opex'::text,
    opex_amount numeric,
    performance_amount numeric,
    cf_type text,
    cf_frequency text,
    cf_next_month_est numeric,
    cf_accrual_from date,
    cf_accrual_to date,
    cf_capex_months integer,
    cf_reimbursable_date date,
    parent_invoice_id uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT invoices_opex_type_check CHECK ((opex_type = ANY (ARRAY['opex'::text, 'performance'::text, 'split'::text]))),
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['unpaid'::text, 'partial'::text, 'paid'::text, 'overpaid'::text, 'reconciled'::text, 'overdue'::text]))),
    CONSTRAINT invoices_type_check CHECK ((type = ANY (ARRAY['expense'::text, 'revenue'::text])))
);


--
-- Name: job_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_config (
    key text NOT NULL,
    value text NOT NULL,
    note text
);


--
-- Name: TABLE job_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.job_config IS 'Values a scheduled job needs and nobody else may read: function urls and the service key. Row level security is on and there is deliberately no policy, so PostgREST can return nothing from it. Filled in by hand.';


--
-- Name: partner_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partner_id uuid,
    account_number text NOT NULL,
    bank_name text,
    reference_number text,
    model text,
    is_primary boolean DEFAULT false,
    currency text DEFAULT 'RSD'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: partners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    country text,
    account_number text,
    model text,
    reference_number text,
    contact_info text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    type text DEFAULT 'vendor'::text,
    tax_id text,
    address text,
    city text,
    contact_name text,
    contact_email text,
    contact_phone text,
    note text,
    registration_number text,
    is_individual boolean DEFAULT false
);


--
-- Name: passthrough; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passthrough (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_id uuid,
    partner_id uuid,
    direction text NOT NULL,
    pair_id uuid,
    period_month text NOT NULL,
    currency text NOT NULL,
    amount numeric(18,2) NOT NULL,
    exchange_rate numeric(18,6),
    amount_usd numeric(18,2),
    transaction_date date NOT NULL,
    statement_number text,
    note text,
    pl_impact boolean DEFAULT false,
    status text DEFAULT 'unpaired'::text,
    created_at timestamp with time zone DEFAULT now(),
    account_number text,
    model text,
    reference_number text,
    import_hash text,
    import_batch_id uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT passthrough_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text]))),
    CONSTRAINT passthrough_status_check CHECK ((status = ANY (ARRAY['unpaired'::text, 'paired'::text, 'balanced'::text])))
);


--
-- Name: payroll_additions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_additions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    month date NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    treatment text NOT NULL,
    amount numeric NOT NULL,
    currency text DEFAULT 'RSD'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_additions_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payroll_additions_currency_check CHECK ((currency = ANY (ARRAY['RSD'::text, 'EUR'::text, 'USD'::text]))),
    CONSTRAINT payroll_additions_kind_check CHECK ((kind = ANY (ARRAY['bonus'::text, 'stimulation'::text, 'damages'::text, 'other'::text]))),
    CONSTRAINT payroll_additions_label_check CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT payroll_additions_month_is_first_of_month CHECK ((month = (date_trunc('month'::text, (month)::timestamp with time zone))::date)),
    CONSTRAINT payroll_additions_treatment_check CHECK ((treatment = ANY (ARRAY['salary'::text, 'other_income'::text, 'non_taxable'::text])))
);


--
-- Name: TABLE payroll_additions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_additions IS 'Bonuses and other one-off additions, for one month. Never prorated by hours, and each carries the treatment that decides how it is taxed.';


--
-- Name: COLUMN payroll_additions.treatment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_additions.treatment IS 'salary — joins the gross-up, tax and both contributions. other_income — income tax only, as the travel allowance. non_taxable — paid as it stands.';


--
-- Name: payroll_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payroll_id uuid,
    partner_id uuid,
    employee_name text NOT NULL,
    department_id uuid,
    department_name text,
    dept_subcategory_id uuid,
    dept_subcategory_name text,
    gross_salary numeric DEFAULT 0 NOT NULL,
    net_salary numeric DEFAULT 0 NOT NULL,
    tax_on_salary numeric DEFAULT 0 NOT NULL,
    contrib_employee numeric DEFAULT 0 NOT NULL,
    contrib_employer numeric DEFAULT 0 NOT NULL,
    deductions_third_party jsonb DEFAULT '[]'::jsonb,
    deductions_retained jsonb DEFAULT '[]'::jsonb,
    rev_alloc_type text,
    opex_type text,
    cf_type text,
    cf_frequency text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    rev_alloc_af_pct integer DEFAULT 50
);


--
-- Name: payroll_postings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_postings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    period_month date NOT NULL,
    run_key text NOT NULL,
    posted_on date DEFAULT CURRENT_DATE NOT NULL,
    exchange_rate numeric,
    total_cost numeric NOT NULL,
    subsidy numeric DEFAULT 0 NOT NULL,
    created_invoice_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_transaction_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    note text,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id uuid,
    CONSTRAINT payroll_postings_month_is_first_of_month CHECK ((period_month = (date_trunc('month'::text, (period_month)::timestamp with time zone))::date)),
    CONSTRAINT payroll_postings_run_key_check CHECK ((btrim(run_key) <> ''::text))
);


--
-- Name: TABLE payroll_postings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_postings IS 'One row per run per month, unique. A duplicated payroll is a second complete and plausible set of invoices that reconciles against nothing, so the second attempt is refused by the database.';


--
-- Name: COLUMN payroll_postings.run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_postings.run_id IS 'The saved run these entries were written from. Deleting the posting is what puts that run back to draft.';


--
-- Name: payroll_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_id uuid,
    period_month text NOT NULL,
    payment_date date NOT NULL,
    due_date date,
    tax_filing_ref text,
    currency text DEFAULT 'RSD'::text NOT NULL,
    exchange_rate numeric,
    amount_usd numeric,
    rev_alloc_type text DEFAULT 'sg100'::text,
    opex_type text DEFAULT 'opex'::text,
    cf_type text DEFAULT 'recurring'::text,
    cf_frequency text DEFAULT 'monthly'::text,
    note text,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: payroll_run_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_run_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    employee_id uuid,
    employee_code text,
    employee_name text NOT NULL,
    department text,
    dept_subcategory text,
    line_kind text DEFAULT 'salary'::text NOT NULL,
    label text,
    hours numeric DEFAULT 0 NOT NULL,
    month_hours numeric DEFAULT 0 NOT NULL,
    contracted_net numeric DEFAULT 0 NOT NULL,
    seniority_net numeric DEFAULT 0 NOT NULL,
    additional_net numeric DEFAULT 0 NOT NULL,
    service_years integer,
    gross numeric DEFAULT 0 NOT NULL,
    contribution_base numeric DEFAULT 0 NOT NULL,
    tax_free numeric DEFAULT 0 NOT NULL,
    tax_base numeric DEFAULT 0 NOT NULL,
    income_tax numeric DEFAULT 0 NOT NULL,
    pension_employee numeric DEFAULT 0 NOT NULL,
    health_employee numeric DEFAULT 0 NOT NULL,
    unemployment_employee numeric DEFAULT 0 NOT NULL,
    pension_employer numeric DEFAULT 0 NOT NULL,
    health_employer numeric DEFAULT 0 NOT NULL,
    unemployment_employer numeric DEFAULT 0 NOT NULL,
    subsidy numeric DEFAULT 0 NOT NULL,
    net numeric DEFAULT 0 NOT NULL,
    total_cost numeric DEFAULT 0 NOT NULL,
    deductions_third_party numeric DEFAULT 0 NOT NULL,
    deductions_employer numeric DEFAULT 0 NOT NULL,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_run_lines_line_kind_check CHECK ((line_kind = ANY (ARRAY['salary'::text, 'other'::text])))
);


--
-- Name: COLUMN payroll_run_lines.detail; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_run_lines.detail IS 'Hours by category, deductions and additions by name — everything the payslip shows that is not a single number on this row.';


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    period_month date NOT NULL,
    run_key text NOT NULL,
    label text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    exchange_rate numeric,
    usd_rate numeric,
    month_hours numeric,
    gross numeric DEFAULT 0 NOT NULL,
    net numeric DEFAULT 0 NOT NULL,
    income_tax numeric DEFAULT 0 NOT NULL,
    contributions_employee numeric DEFAULT 0 NOT NULL,
    contributions_employer numeric DEFAULT 0 NOT NULL,
    subsidy numeric DEFAULT 0 NOT NULL,
    total_cost numeric DEFAULT 0 NOT NULL,
    deductions_third_party numeric DEFAULT 0 NOT NULL,
    deductions_employer numeric DEFAULT 0 NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL,
    calculated_by uuid DEFAULT auth.uid(),
    posted_at timestamp with time zone,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_runs_month_is_first_of_month CHECK ((period_month = (date_trunc('month'::text, (period_month)::timestamp with time zone))::date)),
    CONSTRAINT payroll_runs_posted_has_a_date CHECK (((status <> 'posted'::text) OR (posted_at IS NOT NULL))),
    CONSTRAINT payroll_runs_run_key_check CHECK ((btrim(run_key) <> ''::text)),
    CONSTRAINT payroll_runs_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text])))
);


--
-- Name: TABLE payroll_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_runs IS 'A calculated month, kept. Recalculating replaces its lines; posting freezes them, because a posted month has to reproduce exactly as it was posted.';


--
-- Name: payroll_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_key text NOT NULL,
    setting_key text NOT NULL,
    label text NOT NULL,
    value_numeric numeric,
    value_text text,
    valid_from date NOT NULL,
    valid_to date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label_en text,
    options jsonb,
    CONSTRAINT payroll_settings_has_a_value CHECK (((value_numeric IS NULL) <> (value_text IS NULL))),
    CONSTRAINT payroll_settings_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);


--
-- Name: TABLE payroll_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_settings IS 'Every figure a payroll run needs, with the dates it was in force. Never overwritten: a new value is a new row, so an old month recalculates to what it originally cost.';


--
-- Name: COLUMN payroll_settings.label_en; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_settings.label_en IS 'What the setting does, in English. `label` keeps MPP wording verbatim so a row can still be found from the accountant screen.';


--
-- Name: COLUMN payroll_settings.options; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_settings.options IS 'For a setting that is a choice: [{value, label}] where `value` is what MPP stores and `label` is English. Null for an amount.';


--
-- Name: payroll_timesheet_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_timesheet_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    file_name text NOT NULL,
    employee_id uuid NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_timesheet_aliases_file_name_check CHECK ((btrim(file_name) <> ''::text))
);


--
-- Name: TABLE payroll_timesheet_aliases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_timesheet_aliases IS 'Timesheet spellings that do not match the register by themselves. Linked once by hand, because a fuzzy match that is wrong puts one person hours on another person salary and both look plausible.';


--
-- Name: payroll_timesheets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_timesheets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    month date NOT NULL,
    research_hours numeric DEFAULT 0 NOT NULL,
    regular_hours numeric DEFAULT 0 NOT NULL,
    holiday_hours numeric DEFAULT 0 NOT NULL,
    vacation_hours numeric DEFAULT 0 NOT NULL,
    sick_hours numeric DEFAULT 0 NOT NULL,
    unpaid_hours numeric DEFAULT 0 NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sick_full_hours numeric DEFAULT 0 NOT NULL,
    sick_maternity_hours numeric DEFAULT 0 NOT NULL,
    sick_fund_hours numeric DEFAULT 0 NOT NULL,
    paid_leave_hours numeric DEFAULT 0 NOT NULL,
    religious_holiday_hours numeric DEFAULT 0 NOT NULL,
    military_court_hours numeric DEFAULT 0 NOT NULL,
    work_stoppage_hours numeric DEFAULT 0 NOT NULL,
    absence_hours numeric DEFAULT 0 NOT NULL,
    undocumented_hours numeric DEFAULT 0 NOT NULL,
    suspension_single_hours numeric DEFAULT 0 NOT NULL,
    suspension_family_hours numeric DEFAULT 0 NOT NULL,
    CONSTRAINT payroll_timesheets_absence_hours_not_negative CHECK ((absence_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_holiday_hours_check CHECK ((holiday_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_military_court_hours_not_negative CHECK ((military_court_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_month_is_first_of_month CHECK ((month = (date_trunc('month'::text, (month)::timestamp with time zone))::date)),
    CONSTRAINT payroll_timesheets_paid_leave_hours_not_negative CHECK ((paid_leave_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_regular_hours_check CHECK ((regular_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_religious_holiday_hours_not_negative CHECK ((religious_holiday_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_research_hours_check CHECK ((research_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_sick_full_hours_not_negative CHECK ((sick_full_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_sick_fund_hours_not_negative CHECK ((sick_fund_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_sick_hours_check CHECK ((sick_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_sick_maternity_hours_not_negative CHECK ((sick_maternity_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_suspension_family_hours_not_negative CHECK ((suspension_family_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_suspension_single_hours_not_negative CHECK ((suspension_single_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_undocumented_hours_not_negative CHECK ((undocumented_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_unpaid_hours_check CHECK ((unpaid_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_vacation_hours_check CHECK ((vacation_hours >= (0)::numeric)),
    CONSTRAINT payroll_timesheets_work_stoppage_hours_not_negative CHECK ((work_stoppage_hours >= (0)::numeric))
);


--
-- Name: TABLE payroll_timesheets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_timesheets IS 'Hours per employee per month, split R&D / other / absence. The R&D split is what divides Team AimFox from Team Dev — the same people, two runs.';


--
-- Name: COLUMN payroll_timesheets.sick_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_timesheets.sick_hours IS 'Боловање на терет послодавца — paid at the 0.65 coefficient in the settings.';


--
-- Name: COLUMN payroll_timesheets.sick_full_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_timesheets.sick_full_hours IS 'Боловање на терет послодавца, пун фонд — the same leave at 100%.';


--
-- Name: COLUMN payroll_timesheets.sick_fund_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payroll_timesheets.sick_fund_hours IS 'Боловање на терет фонда. Earns nothing here: the health fund pays it, which is why the settings have no coefficient for it.';


--
-- Name: payroll_unit_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_unit_mapping (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    organisational_unit text NOT NULL,
    department text NOT NULL,
    dept_subcategory text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_unit_mapping_department_check CHECK ((btrim(department) <> ''::text)),
    CONSTRAINT payroll_unit_mapping_organisational_unit_check CHECK ((btrim(organisational_unit) <> ''::text))
);


--
-- Name: TABLE payroll_unit_mapping; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payroll_unit_mapping IS 'Which department an organisational unit posts to. Posting refuses while a unit in use is missing, rather than defaulting anybody into Unassigned.';


--
-- Name: pl_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pl_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text,
    sort_order integer,
    CONSTRAINT pl_categories_type_check CHECK ((type = ANY (ARRAY['revenue'::text, 'expense'::text, 'reduction'::text])))
);


--
-- Name: pl_splits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pl_splits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    source_id uuid NOT NULL,
    amount numeric(18,2) NOT NULL,
    amount_usd numeric(18,2),
    pl_category text,
    pl_subcategory text,
    department text,
    dept_subcategory text,
    expense_description text,
    rev_alloc_type text,
    opex_type text,
    cf_type text,
    note text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    CONSTRAINT pl_splits_source_check CHECK ((source = ANY (ARRAY['transaction'::text, 'invoice'::text])))
);


--
-- Name: TABLE pl_splits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pl_splits IS 'One payment broken into several costs. A row that has these contributes them to the P&L instead of itself; everything else in the application still reads the payment, once, for its full amount.';


--
-- Name: pl_subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pl_subcategories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_id uuid,
    name text NOT NULL,
    sort_order integer
);


--
-- Name: processor_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processor_sync_runs (
    id bigint NOT NULL,
    sync_date date NOT NULL,
    provider text NOT NULL,
    account text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    period_from date,
    period_to date,
    transactions integer,
    error text,
    export_id text,
    CONSTRAINT processor_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: TABLE processor_sync_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.processor_sync_runs IS 'One payment-processor export per provider per day. Only `complete` runs are readable: a sync that died halfway leaves rows indistinguishable from a finished one.';


--
-- Name: processor_sync_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.processor_sync_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.processor_sync_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: processor_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processor_transactions (
    run_id bigint NOT NULL,
    external_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    kind text NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    fee numeric(14,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    raw_status text,
    reference_id text,
    CONSTRAINT processor_transactions_kind_check CHECK ((kind = ANY (ARRAY['sale'::text, 'refund'::text, 'chargeback'::text, 'fee'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text,
    email text,
    role text,
    created_at timestamp with time zone DEFAULT now(),
    company_access text[] DEFAULT '{}'::text[],
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['administrator'::text, 'owner'::text, 'manager'::text, 'administrative_assistant'::text])))
);


--
-- Name: public_holidays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_holidays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    holiday_on date NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT public_holidays_kind_check CHECK ((kind = ANY (ARRAY['state'::text, 'orthodox'::text, 'substitute'::text]))),
    CONSTRAINT public_holidays_name_check CHECK ((btrim(name) <> ''::text))
);


--
-- Name: TABLE public_holidays; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.public_holidays IS 'Days this company does not work. The hour fund of a month is its weekdays times eight; the holidays among those weekdays are paid but not worked. Holidays non-working for one faith only are deliberately not in here.';


--
-- Name: quick_fill_scripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quick_fill_scripts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    icon text DEFAULT ''::text NOT NULL,
    pl_category text DEFAULT ''::text NOT NULL,
    pl_subcategory text DEFAULT ''::text NOT NULL,
    department text DEFAULT ''::text NOT NULL,
    dept_subcategory text DEFAULT ''::text NOT NULL,
    expense_description text DEFAULT ''::text NOT NULL,
    rev_alloc text DEFAULT 'shared'::text NOT NULL,
    opex_type text DEFAULT 'opex'::text NOT NULL,
    cf_type text DEFAULT ''::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: TABLE quick_fill_scripts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.quick_fill_scripts IS 'Classification shortcuts shared by everyone in the organisation. Not scoped to a company: the categories and departments they name already are not.';


--
-- Name: revenue_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_id uuid,
    processor text NOT NULL,
    transaction_date date NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    amount numeric NOT NULL,
    amount_usd numeric,
    exchange_rate numeric,
    reference text,
    notes text,
    status text DEFAULT 'unmatched'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    id_at_gateway text,
    CONSTRAINT revenue_collections_processor_check CHECK (((processor IS NOT NULL) AND (btrim(processor) <> ''::text) AND ((processor ~ '^chargebee_[a-z0-9][a-z0-9-]*$'::text) OR (processor = ANY ('{}'::text[]))))),
    CONSTRAINT revenue_collections_status_check CHECK ((status = ANY (ARRAY['unmatched'::text, 'partial'::text, 'matched'::text])))
);


--
-- Name: COLUMN revenue_collections.id_at_gateway; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.revenue_collections.id_at_gateway IS 'The processor''s own transaction id, as Chargebee reported it. This is how a Braintree, Stripe or PayPal row finds its brand: the processor never knows the brand, and the Chargebee site that recorded the payment does.';


--
-- Name: revenue_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    brand text NOT NULL,
    revenue_stream text NOT NULL,
    period_month text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    amount numeric NOT NULL,
    amount_usd numeric,
    status text DEFAULT 'open'::text NOT NULL,
    invoice_ref text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT revenue_entries_revenue_stream_check CHECK ((revenue_stream = ANY (ARRAY['aimfox'::text, 'social_growth'::text, 'other'::text]))),
    CONSTRAINT revenue_entries_source_check CHECK ((source = ANY (ARRAY['chargebee'::text, 'invoice_ninja'::text, 'manual'::text, 'stripe'::text, 'other'::text]))),
    CONSTRAINT revenue_entries_status_check CHECK ((status = ANY (ARRAY['open'::text, 'partial'::text, 'collected'::text, 'cancelled'::text])))
);


--
-- Name: revenue_entry_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_entry_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entry_id uuid,
    collection_id uuid,
    allocated_amount_usd numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: revenue_estimate_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_estimate_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    estimate_month date NOT NULL,
    line text NOT NULL,
    kind text NOT NULL,
    amount_usd numeric NOT NULL,
    reason text NOT NULL,
    created_by uuid DEFAULT auth.uid(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT revenue_estimate_adjustments_kind_check CHECK ((kind = ANY (ARRAY['set'::text, 'adjust'::text]))),
    CONSTRAINT revenue_estimate_adjustments_line_check CHECK ((line = ANY (ARRAY['vat_claimed'::text, 'other_revenue'::text]))),
    CONSTRAINT revenue_estimate_adjustments_reason_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT revenue_estimate_month_is_a_month CHECK ((estimate_month = (date_trunc('month'::text, (estimate_month)::timestamp with time zone))::date))
);


--
-- Name: TABLE revenue_estimate_adjustments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.revenue_estimate_adjustments IS 'Append-only changes to the simulation''s VAT claimed and other revenue lines. A line reads as last month''s figure, replaced by the most recent `set` and moved by every `adjust` after it. No update, no delete: a mistake is undone with a counter-entry.';


--
-- Name: revenue_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    revenue_stream text NOT NULL,
    setting_key text NOT NULL,
    rate numeric(6,5) NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT revenue_settings_range_is_forward CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT revenue_settings_rate_check CHECK (((rate >= (0)::numeric) AND (rate < (1)::numeric))),
    CONSTRAINT revenue_settings_revenue_stream_check CHECK ((revenue_stream = ANY (ARRAY['aimfox'::text, 'social_growth'::text]))),
    CONSTRAINT revenue_settings_setting_key_check CHECK ((setting_key = ANY (ARRAY['processing_fee'::text, 'chargeback'::text])))
);


--
-- Name: TABLE revenue_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.revenue_settings IS 'What a revenue stream loses before the money arrives, with the dates each rate was in force. Never overwritten: a new rate is a new row, so a forecast made last month still reads at last month''s rate.';


--
-- Name: scheduled_job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_job_runs (
    id bigint NOT NULL,
    job text NOT NULL,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    belgrade_at timestamp with time zone NOT NULL,
    belgrade_hour integer NOT NULL,
    would_run boolean NOT NULL,
    note text
);


--
-- Name: TABLE scheduled_job_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.scheduled_job_runs IS 'Every firing of a scheduled job, including the ones that declined to act. Read this to see whether the schedule is alive and whether it is picking the right hour in Belgrade.';


--
-- Name: scheduled_job_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.scheduled_job_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.scheduled_job_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sync_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    site text,
    status text,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    records_fetched integer DEFAULT 0,
    records_created integer DEFAULT 0,
    records_skipped integer DEFAULT 0,
    error_message text,
    date_from date,
    date_to date,
    CONSTRAINT sync_logs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid,
    bank_id uuid,
    partner_id uuid,
    transaction_date date NOT NULL,
    statement_number text,
    type text NOT NULL,
    pl_category text,
    pl_subcategory text,
    department text,
    dept_subcategory text,
    expense_description text,
    revenue_stream text,
    rev_alloc_type text DEFAULT 'sg100'::text,
    dept_split_type text DEFAULT 'none'::text,
    tx_subtype text,
    currency text NOT NULL,
    amount numeric(18,2) NOT NULL,
    exchange_rate numeric(18,6),
    amount_usd numeric(18,2),
    is_indexed boolean DEFAULT false,
    account_number text,
    model text,
    reference_number text,
    pl_impact boolean DEFAULT false,
    note text,
    tags text[],
    status text DEFAULT 'posted'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    rev_alloc_aimfox numeric,
    rev_alloc_sg numeric,
    opex_type text DEFAULT 'opex'::text,
    opex_amount numeric,
    performance_amount numeric,
    cf_type text,
    cf_frequency text,
    cf_next_month_est numeric,
    cf_accrual_from date,
    cf_accrual_to date,
    cf_capex_months integer,
    cf_reimbursable_date date,
    payment_method text,
    import_hash text,
    import_batch_id uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT transactions_cf_frequency_check CHECK ((cf_frequency = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'yearly'::text]))),
    CONSTRAINT transactions_cf_type_check CHECK ((cf_type = ANY (ARRAY['recurring'::text, 'one_time'::text, 'accrual'::text, 'capex'::text, 'reimbursable'::text]))),
    CONSTRAINT transactions_opex_type_check CHECK ((opex_type = ANY (ARRAY['opex'::text, 'performance'::text, 'split'::text]))),
    CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['posted'::text, 'draft'::text, 'reconciled'::text]))),
    CONSTRAINT transactions_type_check CHECK ((type = ANY (ARRAY['invoice_payment'::text, 'direct'::text, 'passthrough'::text, 'credit_payment'::text])))
);


--
-- Name: user_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    entity text,
    can_access boolean DEFAULT false,
    can_view_reports boolean DEFAULT false,
    can_enter_data boolean DEFAULT false,
    can_post boolean DEFAULT false,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now()
);


--
-- Name: v_budget_vs_actual; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_budget_vs_actual AS
 SELECT be.company_id,
    be.budget_month,
    be.pl_category,
    be.pl_subcategory,
    be.department,
    be.dept_subcategory,
    be.expense_description,
    be.rev_alloc_type,
    be.estimated_amount_usd AS estimated_usd,
    be.is_manual_override,
    COALESCE(act.actual_usd, (0)::numeric) AS actual_usd,
    (be.estimated_amount_usd - COALESCE(act.actual_usd, (0)::numeric)) AS variance_usd
   FROM (public.budget_entries be
     LEFT JOIN ( SELECT transactions.company_id,
            date_trunc('month'::text, (transactions.transaction_date)::timestamp with time zone) AS month,
            transactions.pl_category,
            transactions.pl_subcategory,
            transactions.department,
            transactions.dept_subcategory,
            transactions.expense_description,
            transactions.rev_alloc_type,
            sum(transactions.amount_usd) AS actual_usd
           FROM public.transactions
          WHERE ((transactions.tx_subtype = 'expense'::text) AND (transactions.pl_impact = true) AND (transactions.status = 'posted'::text))
          GROUP BY transactions.company_id, (date_trunc('month'::text, (transactions.transaction_date)::timestamp with time zone)), transactions.pl_category, transactions.pl_subcategory, transactions.department, transactions.dept_subcategory, transactions.expense_description, transactions.rev_alloc_type) act ON (((act.company_id = be.company_id) AND (act.month = be.budget_month) AND (COALESCE(act.pl_category, ''::text) = COALESCE(be.pl_category, ''::text)) AND (COALESCE(act.pl_subcategory, ''::text) = COALESCE(be.pl_subcategory, ''::text)) AND (COALESCE(act.department, ''::text) = COALESCE(be.department, ''::text)) AND (COALESCE(act.dept_subcategory, ''::text) = COALESCE(be.dept_subcategory, ''::text)) AND (COALESCE(act.expense_description, ''::text) = COALESCE(be.expense_description, ''::text)))));


--
-- Name: v_cash_position_latest; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_cash_position_latest WITH (security_invoker='on') AS
 SELECT id,
    as_of,
    amount_usd,
    note,
    created_at
   FROM public.cash_positions
  ORDER BY as_of DESC, created_at DESC
 LIMIT 1;


--
-- Name: v_chargebee_latest_runs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_chargebee_latest_runs WITH (security_invoker='on') AS
 SELECT DISTINCT ON (site) id AS run_id,
    site,
    brand,
    company_id,
    snapshot_date,
    subscriptions,
    finished_at,
    error,
    fx_note
   FROM public.chargebee_snapshot_runs
  WHERE (status = 'complete'::text)
  ORDER BY site, snapshot_date DESC, id DESC;


--
-- Name: VIEW v_chargebee_latest_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_chargebee_latest_runs IS 'The newest finished sync for each Chargebee site. Answers "when was this site last read", which is a question about runs — a site with no subscriptions has no rows to carry a date, and reading the date off the rows makes a working site with nothing to sell look like one that has never synced at all.';


--
-- Name: v_chargebee_latest_subscriptions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_chargebee_latest_subscriptions WITH (security_invoker='on') AS
 WITH latest AS (
         SELECT DISTINCT ON (chargebee_snapshot_runs.site) chargebee_snapshot_runs.id,
            chargebee_snapshot_runs.site,
            chargebee_snapshot_runs.brand,
            chargebee_snapshot_runs.company_id,
            chargebee_snapshot_runs.snapshot_date,
            chargebee_snapshot_runs.subscriptions
           FROM public.chargebee_snapshot_runs
          WHERE (chargebee_snapshot_runs.status = 'complete'::text)
          ORDER BY chargebee_snapshot_runs.site, chargebee_snapshot_runs.snapshot_date DESC, chargebee_snapshot_runs.id DESC
        )
 SELECT l.site,
    l.brand,
    l.company_id,
    l.snapshot_date,
    s.subscription_id,
    s.status,
    s.plan_id,
    s.currency,
    s.next_billing_amount,
    s.next_billing_at,
    s.cycle_months,
    s.mrr,
    s.fx_rate,
    s.next_billing_amount_usd
   FROM (latest l
     JOIN public.chargebee_subscription_snapshots s ON ((s.run_id = l.id)));


--
-- Name: v_invoice_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_invoice_status WITH (security_invoker='on') AS
 SELECT i.id,
    i.invoice_number,
    i.invoice_date,
    i.due_date,
    i.type,
    i.currency,
    i.amount,
    i.amount_usd,
    i.status,
    i.partner_id,
    i.company_id,
    i.pl_category,
    i.pl_subcategory,
    i.department,
    i.dept_subcategory,
    i.expense_description,
    i.revenue_stream,
    i.rev_alloc_type,
    i.rev_alloc_sg,
    i.rev_alloc_aimfox,
    i.opex_type,
    i.cf_type,
    i.cf_frequency,
    i.cf_next_month_est,
    i.note,
    i.pl_impact,
    i.exchange_rate,
    i.parent_invoice_id,
    p.name AS partner_name,
    c.name AS company_name,
    COALESCE(sum(itl.allocated_amount_usd), (0)::numeric) AS paid_amount_usd,
        CASE
            WHEN ((COALESCE(sum(itl.allocated_amount), (0)::numeric) > (0)::numeric) AND (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((0.01 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_usd, (0)::numeric)), 2)))) THEN (0)::numeric
            ELSE GREATEST((0)::numeric, (COALESCE(i.amount_usd, (0)::numeric) - COALESCE(sum(itl.allocated_amount_usd), (0)::numeric)))
        END AS remaining_usd,
        CASE
            WHEN (COALESCE(sum(itl.allocated_amount), (0)::numeric) <= (0)::numeric) THEN 'unpaid'::text
            WHEN (round((COALESCE(i.amount, (0)::numeric) - COALESCE(sum(itl.allocated_amount), (0)::numeric)), 2) <= GREATEST(0.01, round(((0.01 * COALESCE(i.amount, (0)::numeric)) / NULLIF(i.amount_usd, (0)::numeric)), 2))) THEN 'paid'::text
            ELSE 'partial'::text
        END AS calculated_status,
    COALESCE(sum(itl.allocated_amount), (0)::numeric) AS paid_amount,
    i.reference_number,
    i.account_number
   FROM (((public.invoices i
     LEFT JOIN public.partners p ON ((p.id = i.partner_id)))
     LEFT JOIN public.companies c ON ((c.id = i.company_id)))
     LEFT JOIN public.invoice_transaction_links itl ON ((itl.invoice_id = i.id)))
  WHERE (i.parent_invoice_id IS NULL)
  GROUP BY i.id, i.reference_number, i.account_number, i.invoice_number, i.invoice_date, i.due_date, i.type, i.currency, i.amount, i.amount_usd, i.status, i.partner_id, i.company_id, i.pl_category, i.pl_subcategory, i.department, i.dept_subcategory, i.expense_description, i.revenue_stream, i.rev_alloc_type, i.rev_alloc_sg, i.rev_alloc_aimfox, i.opex_type, i.cf_type, i.cf_frequency, i.cf_next_month_est, i.note, i.pl_impact, i.exchange_rate, i.parent_invoice_id, p.name, c.name;


--
-- Name: v_pl_entries; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_pl_entries WITH (security_invoker='on') AS
 SELECT t.id,
    t.company_id,
    t.transaction_date AS pl_date,
    t.tx_subtype AS tx_type,
    t.amount_usd,
    t.pl_category,
    t.pl_subcategory,
    t.department,
    t.dept_subcategory,
    t.expense_description,
    t.revenue_stream,
    t.rev_alloc_type,
    t.rev_alloc_aimfox,
    t.rev_alloc_sg,
    t.opex_type,
    t.opex_amount,
    t.performance_amount,
    t.partner_id,
    'transaction'::text AS source,
    t.cf_type,
    t.cf_frequency,
    t.amount,
    t.currency
   FROM public.transactions t
  WHERE ((t.pl_impact = true) AND (t.deleted_at IS NULL) AND (t.tx_subtype = ANY (ARRAY['expense'::text, 'revenue'::text])) AND (NOT (EXISTS ( SELECT 1
           FROM public.pl_splits s
          WHERE ((s.source = 'transaction'::text) AND (s.source_id = t.id))))))
UNION ALL
 SELECT s.id,
    t.company_id,
    t.transaction_date AS pl_date,
    t.tx_subtype AS tx_type,
    s.amount_usd,
    s.pl_category,
    s.pl_subcategory,
    s.department,
    s.dept_subcategory,
    s.expense_description,
    t.revenue_stream,
    s.rev_alloc_type,
    t.rev_alloc_aimfox,
    t.rev_alloc_sg,
    s.opex_type,
    t.opex_amount,
    t.performance_amount,
    t.partner_id,
    'transaction'::text AS source,
    COALESCE(s.cf_type, t.cf_type) AS cf_type,
    t.cf_frequency,
    s.amount,
    t.currency
   FROM (public.pl_splits s
     JOIN public.transactions t ON ((t.id = s.source_id)))
  WHERE ((s.source = 'transaction'::text) AND (t.pl_impact = true) AND (t.deleted_at IS NULL) AND (t.tx_subtype = ANY (ARRAY['expense'::text, 'revenue'::text])))
UNION ALL
 SELECT i.id,
    i.company_id,
    i.invoice_date AS pl_date,
    i.type AS tx_type,
    i.amount_usd,
    i.pl_category,
    i.pl_subcategory,
    i.department,
    i.dept_subcategory,
    i.expense_description,
    i.revenue_stream,
    i.rev_alloc_type,
    i.rev_alloc_aimfox,
    i.rev_alloc_sg,
    i.opex_type,
    i.opex_amount,
    i.performance_amount,
    i.partner_id,
    'invoice'::text AS source,
    i.cf_type,
    i.cf_frequency,
    i.amount,
    i.currency
   FROM public.invoices i
  WHERE ((i.type = 'expense'::text) AND (i.pl_impact = true) AND (i.deleted_at IS NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.pl_splits s
          WHERE ((s.source = 'invoice'::text) AND (s.source_id = i.id))))))
UNION ALL
 SELECT s.id,
    i.company_id,
    i.invoice_date AS pl_date,
    i.type AS tx_type,
    s.amount_usd,
    s.pl_category,
    s.pl_subcategory,
    s.department,
    s.dept_subcategory,
    s.expense_description,
    i.revenue_stream,
    s.rev_alloc_type,
    i.rev_alloc_aimfox,
    i.rev_alloc_sg,
    s.opex_type,
    i.opex_amount,
    i.performance_amount,
    i.partner_id,
    'invoice'::text AS source,
    COALESCE(s.cf_type, i.cf_type) AS cf_type,
    i.cf_frequency,
    s.amount,
    i.currency
   FROM (public.pl_splits s
     JOIN public.invoices i ON ((i.id = s.source_id)))
  WHERE ((s.source = 'invoice'::text) AND (i.type = 'expense'::text) AND (i.pl_impact = true) AND (i.deleted_at IS NULL));


--
-- Name: v_processor_latest; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_processor_latest WITH (security_invoker='on') AS
 WITH latest AS (
         SELECT DISTINCT ON (processor_sync_runs.provider, processor_sync_runs.account) processor_sync_runs.id,
            processor_sync_runs.provider,
            processor_sync_runs.account,
            processor_sync_runs.sync_date
           FROM public.processor_sync_runs
          WHERE (processor_sync_runs.status = 'complete'::text)
          ORDER BY processor_sync_runs.provider, processor_sync_runs.account, processor_sync_runs.sync_date DESC, processor_sync_runs.id DESC
        )
 SELECT l.provider,
    l.account,
    l.sync_date,
    t.external_id,
    t.occurred_at,
    t.kind,
    t.amount,
    t.fee,
    t.currency,
    t.raw_status,
    t.reference_id
   FROM (latest l
     JOIN public.processor_transactions t ON ((t.run_id = l.id)));


--
-- Name: v_revenue_entry_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_revenue_entry_status AS
SELECT
    NULL::uuid AS id,
    NULL::uuid AS company_id,
    NULL::text AS brand,
    NULL::text AS revenue_stream,
    NULL::text AS period_month,
    NULL::text AS source,
    NULL::text AS currency,
    NULL::numeric AS amount,
    NULL::numeric AS amount_usd,
    NULL::text AS status,
    NULL::text AS invoice_ref,
    NULL::text AS notes,
    NULL::timestamp with time zone AS created_at,
    NULL::timestamp with time zone AS updated_at,
    NULL::numeric AS collected_usd,
    NULL::numeric AS remaining_usd,
    NULL::text AS calculated_status;


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: banks banks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banks
    ADD CONSTRAINT banks_pkey PRIMARY KEY (id);


--
-- Name: budget_adjustments budget_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_adjustments
    ADD CONSTRAINT budget_adjustments_pkey PRIMARY KEY (id);


--
-- Name: budget_entries budget_entries_company_id_budget_month_pl_category_pl_subca_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_entries
    ADD CONSTRAINT budget_entries_company_id_budget_month_pl_category_pl_subca_key UNIQUE (company_id, budget_month, pl_category, pl_subcategory, department, dept_subcategory, expense_description);


--
-- Name: budget_entries budget_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_entries
    ADD CONSTRAINT budget_entries_pkey PRIMARY KEY (id);


--
-- Name: cash_positions cash_positions_as_of_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_positions
    ADD CONSTRAINT cash_positions_as_of_key UNIQUE (as_of);


--
-- Name: cash_positions cash_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_positions
    ADD CONSTRAINT cash_positions_pkey PRIMARY KEY (id);


--
-- Name: chargebee_site_brands chargebee_site_brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_site_brands
    ADD CONSTRAINT chargebee_site_brands_pkey PRIMARY KEY (id);


--
-- Name: chargebee_site_brands chargebee_site_brands_site_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_site_brands
    ADD CONSTRAINT chargebee_site_brands_site_key UNIQUE (site);


--
-- Name: chargebee_snapshot_runs chargebee_snapshot_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_snapshot_runs
    ADD CONSTRAINT chargebee_snapshot_runs_pkey PRIMARY KEY (id);


--
-- Name: chargebee_snapshot_runs chargebee_snapshot_runs_snapshot_date_site_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_snapshot_runs
    ADD CONSTRAINT chargebee_snapshot_runs_snapshot_date_site_key UNIQUE (snapshot_date, site);


--
-- Name: chargebee_subscription_snapshots chargebee_subscription_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_subscription_snapshots
    ADD CONSTRAINT chargebee_subscription_snapshots_pkey PRIMARY KEY (run_id, subscription_id);


--
-- Name: closed_periods closed_periods_company_id_period_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closed_periods
    ADD CONSTRAINT closed_periods_company_id_period_key UNIQUE (company_id, period);


--
-- Name: closed_periods closed_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closed_periods
    ADD CONSTRAINT closed_periods_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: company_bank_accounts company_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: company_profiles company_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_profiles
    ADD CONSTRAINT company_profiles_pkey PRIMARY KEY (id);


--
-- Name: credit_extensions credit_extensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_extensions
    ADD CONSTRAINT credit_extensions_pkey PRIMARY KEY (id);


--
-- Name: credit_installments credit_installments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_installments
    ADD CONSTRAINT credit_installments_pkey PRIMARY KEY (id);


--
-- Name: credit_rate_resets credit_rate_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_rate_resets
    ADD CONSTRAINT credit_rate_resets_pkey PRIMARY KEY (id);


--
-- Name: credits credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_pkey PRIMARY KEY (id);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: dept_subcategories dept_subcategories_department_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dept_subcategories
    ADD CONSTRAINT dept_subcategories_department_id_name_key UNIQUE (department_id, name);


--
-- Name: dept_subcategories dept_subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dept_subcategories
    ADD CONSTRAINT dept_subcategories_pkey PRIMARY KEY (id);


--
-- Name: employee_contracts employee_contracts_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_no_overlap EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: employee_contracts employee_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_pkey PRIMARY KEY (id);


--
-- Name: employee_cost_allocation employee_cost_allocation_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_cost_allocation
    ADD CONSTRAINT employee_cost_allocation_no_overlap EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: employee_cost_allocation employee_cost_allocation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_cost_allocation
    ADD CONSTRAINT employee_cost_allocation_pkey PRIMARY KEY (id);


--
-- Name: employee_deductions employee_deductions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_deductions
    ADD CONSTRAINT employee_deductions_pkey PRIMARY KEY (id);


--
-- Name: employee_payroll_absence employee_payroll_absence_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_payroll_absence
    ADD CONSTRAINT employee_payroll_absence_no_overlap EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: employee_payroll_absence employee_payroll_absence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_payroll_absence
    ADD CONSTRAINT employee_payroll_absence_pkey PRIMARY KEY (id);


--
-- Name: employee_research_engagement employee_research_engagement_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_research_engagement
    ADD CONSTRAINT employee_research_engagement_no_overlap EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: employee_research_engagement employee_research_engagement_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_research_engagement
    ADD CONSTRAINT employee_research_engagement_pkey PRIMARY KEY (id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);


--
-- Name: expense_categories expense_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_categories
    ADD CONSTRAINT expense_categories_pkey PRIMARY KEY (id);


--
-- Name: expense_descriptions expense_descriptions_dept_subcategory_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_descriptions
    ADD CONSTRAINT expense_descriptions_dept_subcategory_id_name_key UNIQUE (dept_subcategory_id, name);


--
-- Name: expense_descriptions expense_descriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_descriptions
    ADD CONSTRAINT expense_descriptions_pkey PRIMARY KEY (id);


--
-- Name: expense_subcategories expense_subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_subcategories
    ADD CONSTRAINT expense_subcategories_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (name);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: import_logs import_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_logs
    ADD CONSTRAINT import_logs_pkey PRIMARY KEY (id);


--
-- Name: installments installments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installments
    ADD CONSTRAINT installments_pkey PRIMARY KEY (id);


--
-- Name: integration_credentials integration_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_pkey PRIMARY KEY (id);


--
-- Name: integration_credentials integration_credentials_provider_site_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_credentials
    ADD CONSTRAINT integration_credentials_provider_site_key UNIQUE (provider, site);


--
-- Name: invoice_matches invoice_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_matches
    ADD CONSTRAINT invoice_matches_pkey PRIMARY KEY (id);


--
-- Name: invoice_transaction_links invoice_transaction_links_invoice_id_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_transaction_links
    ADD CONSTRAINT invoice_transaction_links_invoice_id_transaction_id_key UNIQUE (invoice_id, transaction_id);


--
-- Name: invoice_transaction_links invoice_transaction_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_transaction_links
    ADD CONSTRAINT invoice_transaction_links_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: job_config job_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_config
    ADD CONSTRAINT job_config_pkey PRIMARY KEY (key);


--
-- Name: partner_accounts partner_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_accounts
    ADD CONSTRAINT partner_accounts_pkey PRIMARY KEY (id);


--
-- Name: partners partners_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_name_unique UNIQUE (name);


--
-- Name: partners partners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_pkey PRIMARY KEY (id);


--
-- Name: passthrough passthrough_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passthrough
    ADD CONSTRAINT passthrough_pkey PRIMARY KEY (id);


--
-- Name: payroll_additions payroll_additions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_additions
    ADD CONSTRAINT payroll_additions_pkey PRIMARY KEY (id);


--
-- Name: payroll_lines payroll_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines
    ADD CONSTRAINT payroll_lines_pkey PRIMARY KEY (id);


--
-- Name: payroll_postings payroll_postings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_postings
    ADD CONSTRAINT payroll_postings_pkey PRIMARY KEY (id);


--
-- Name: payroll_records payroll_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_pkey PRIMARY KEY (id);


--
-- Name: payroll_run_lines payroll_run_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: payroll_settings payroll_settings_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_settings
    ADD CONSTRAINT payroll_settings_no_overlap EXCLUDE USING gist (setting_key WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: payroll_settings payroll_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_settings
    ADD CONSTRAINT payroll_settings_pkey PRIMARY KEY (id);


--
-- Name: payroll_timesheet_aliases payroll_timesheet_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_timesheet_aliases
    ADD CONSTRAINT payroll_timesheet_aliases_pkey PRIMARY KEY (id);


--
-- Name: payroll_timesheets payroll_timesheets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_timesheets
    ADD CONSTRAINT payroll_timesheets_pkey PRIMARY KEY (id);


--
-- Name: payroll_unit_mapping payroll_unit_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_unit_mapping
    ADD CONSTRAINT payroll_unit_mapping_pkey PRIMARY KEY (id);


--
-- Name: pl_categories pl_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pl_categories
    ADD CONSTRAINT pl_categories_name_key UNIQUE (name);


--
-- Name: pl_categories pl_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pl_categories
    ADD CONSTRAINT pl_categories_pkey PRIMARY KEY (id);


--
-- Name: pl_splits pl_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pl_splits
    ADD CONSTRAINT pl_splits_pkey PRIMARY KEY (id);


--
-- Name: pl_subcategories pl_subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pl_subcategories
    ADD CONSTRAINT pl_subcategories_pkey PRIMARY KEY (id);


--
-- Name: processor_sync_runs processor_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processor_sync_runs
    ADD CONSTRAINT processor_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: processor_sync_runs processor_sync_runs_sync_date_provider_account_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processor_sync_runs
    ADD CONSTRAINT processor_sync_runs_sync_date_provider_account_key UNIQUE (sync_date, provider, account);


--
-- Name: processor_transactions processor_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processor_transactions
    ADD CONSTRAINT processor_transactions_pkey PRIMARY KEY (run_id, external_id, kind);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: public_holidays public_holidays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_holidays
    ADD CONSTRAINT public_holidays_pkey PRIMARY KEY (id);


--
-- Name: quick_fill_scripts quick_fill_scripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quick_fill_scripts
    ADD CONSTRAINT quick_fill_scripts_pkey PRIMARY KEY (id);


--
-- Name: revenue_collections revenue_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_collections
    ADD CONSTRAINT revenue_collections_pkey PRIMARY KEY (id);


--
-- Name: revenue_entries revenue_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_pkey PRIMARY KEY (id);


--
-- Name: revenue_entry_collections revenue_entry_collections_entry_id_collection_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entry_collections
    ADD CONSTRAINT revenue_entry_collections_entry_id_collection_id_key UNIQUE (entry_id, collection_id);


--
-- Name: revenue_entry_collections revenue_entry_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entry_collections
    ADD CONSTRAINT revenue_entry_collections_pkey PRIMARY KEY (id);


--
-- Name: revenue_estimate_adjustments revenue_estimate_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_estimate_adjustments
    ADD CONSTRAINT revenue_estimate_adjustments_pkey PRIMARY KEY (id);


--
-- Name: revenue_settings revenue_settings_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_settings
    ADD CONSTRAINT revenue_settings_no_overlap EXCLUDE USING gist (revenue_stream WITH =, setting_key WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&);


--
-- Name: revenue_settings revenue_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_settings
    ADD CONSTRAINT revenue_settings_pkey PRIMARY KEY (id);


--
-- Name: scheduled_job_runs scheduled_job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_job_runs
    ADD CONSTRAINT scheduled_job_runs_pkey PRIMARY KEY (id);


--
-- Name: sync_logs sync_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_logs
    ADD CONSTRAINT sync_logs_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: user_access user_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access
    ADD CONSTRAINT user_access_pkey PRIMARY KEY (id);


--
-- Name: audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_at_idx ON public.audit_log USING btree (created_at DESC);


--
-- Name: audit_log_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_record_idx ON public.audit_log USING btree (table_name, record_id, created_at DESC);


--
-- Name: budget_adjustments_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_adjustments_lookup_idx ON public.budget_adjustments USING btree (company_id, budget_month, created_at);


--
-- Name: budget_adjustments_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_adjustments_month_idx ON public.budget_adjustments USING btree (budget_month, created_at);


--
-- Name: cash_positions_as_of_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_positions_as_of_idx ON public.cash_positions USING btree (as_of DESC);


--
-- Name: cb_snap_billing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cb_snap_billing ON public.chargebee_subscription_snapshots USING btree (run_id, next_billing_at) WHERE (next_billing_at IS NOT NULL);


--
-- Name: cb_snap_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cb_snap_run ON public.chargebee_subscription_snapshots USING btree (run_id);


--
-- Name: chargebee_site_brands_one_row_per_site; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chargebee_site_brands_one_row_per_site ON public.chargebee_site_brands USING btree (site);


--
-- Name: closed_periods_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX closed_periods_lookup_idx ON public.closed_periods USING btree (company_id, period);


--
-- Name: credit_extensions_by_credit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_extensions_by_credit ON public.credit_extensions USING btree (credit_id, extended_on DESC);


--
-- Name: credit_rate_resets_by_credit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_rate_resets_by_credit ON public.credit_rate_resets USING btree (credit_id, effective_from DESC);


--
-- Name: departments_name_folded; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX departments_name_folded ON public.departments USING btree (lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text)));


--
-- Name: dept_subcategories_name_per_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dept_subcategories_name_per_parent ON public.dept_subcategories USING btree (COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text)));


--
-- Name: employee_contracts_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_contracts_employee_idx ON public.employee_contracts USING btree (employee_id, valid_from DESC);


--
-- Name: employee_cost_allocation_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_cost_allocation_employee_idx ON public.employee_cost_allocation USING btree (employee_id, valid_from DESC);


--
-- Name: employee_deductions_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_deductions_employee_idx ON public.employee_deductions USING btree (employee_id, valid_from DESC);


--
-- Name: employee_deductions_payee_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_deductions_payee_partner ON public.employee_deductions USING btree (payee_partner_id) WHERE (payee_partner_id IS NOT NULL);


--
-- Name: employee_payroll_absence_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_payroll_absence_employee_idx ON public.employee_payroll_absence USING btree (employee_id, valid_from DESC);


--
-- Name: employee_research_engagement_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_research_engagement_employee_idx ON public.employee_research_engagement USING btree (employee_id, valid_from DESC);


--
-- Name: employees_company_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX employees_company_code_idx ON public.employees USING btree (company_id, code) WHERE ((code IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: employees_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employees_company_idx ON public.employees USING btree (company_id) WHERE (deleted_at IS NULL);


--
-- Name: expense_descriptions_name_per_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX expense_descriptions_name_per_parent ON public.expense_descriptions USING btree (COALESCE(dept_subcategory_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text)));


--
-- Name: idx_budget_entries_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_budget_entries_month ON public.budget_entries USING btree (company_id, budget_month);


--
-- Name: idx_ci_credit_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ci_credit_id ON public.credit_installments USING btree (credit_id);


--
-- Name: idx_ci_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ci_due_date ON public.credit_installments USING btree (due_date);


--
-- Name: idx_ci_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ci_status ON public.credit_installments USING btree (status);


--
-- Name: idx_invoices_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_company ON public.invoices USING btree (company_id);


--
-- Name: idx_invoices_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_due_date ON public.invoices USING btree (due_date);


--
-- Name: idx_invoices_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_partner ON public.invoices USING btree (partner_id);


--
-- Name: idx_invoices_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_status ON public.invoices USING btree (status);


--
-- Name: idx_itl_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_itl_invoice ON public.invoice_transaction_links USING btree (invoice_id);


--
-- Name: idx_itl_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_itl_transaction ON public.invoice_transaction_links USING btree (transaction_id);


--
-- Name: idx_passthrough_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_passthrough_pair ON public.passthrough USING btree (pair_id);


--
-- Name: idx_passthrough_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_passthrough_period ON public.passthrough USING btree (period_month);


--
-- Name: idx_payroll_lines_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_lines_partner ON public.payroll_lines USING btree (partner_id);


--
-- Name: idx_payroll_lines_payroll; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_lines_payroll ON public.payroll_lines USING btree (payroll_id);


--
-- Name: idx_payroll_records_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_records_company ON public.payroll_records USING btree (company_id);


--
-- Name: idx_payroll_records_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_records_period ON public.payroll_records USING btree (period_month);


--
-- Name: idx_transactions_cf_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_cf_type ON public.transactions USING btree (cf_type) WHERE (cf_type IS NOT NULL);


--
-- Name: idx_transactions_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_company ON public.transactions USING btree (company_id);


--
-- Name: idx_transactions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_date ON public.transactions USING btree (transaction_date);


--
-- Name: idx_transactions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_type ON public.transactions USING btree (type);


--
-- Name: import_logs_account_currency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_logs_account_currency_idx ON public.import_logs USING btree (company_id, bank_id, default_currency, created_at DESC);


--
-- Name: invoices_not_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_not_deleted_idx ON public.invoices USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: passthrough_import_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX passthrough_import_batch_idx ON public.passthrough USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL);


--
-- Name: passthrough_import_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX passthrough_import_hash_uidx ON public.passthrough USING btree (import_hash) WHERE (import_hash IS NOT NULL);


--
-- Name: passthrough_not_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX passthrough_not_deleted_idx ON public.passthrough USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: payroll_additions_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_additions_employee_idx ON public.payroll_additions USING btree (employee_id, month DESC);


--
-- Name: payroll_additions_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_additions_month_idx ON public.payroll_additions USING btree (month, employee_id);


--
-- Name: payroll_postings_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_postings_month_idx ON public.payroll_postings USING btree (company_id, period_month);


--
-- Name: payroll_postings_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payroll_postings_once_idx ON public.payroll_postings USING btree (company_id, period_month, run_key);


--
-- Name: payroll_postings_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_postings_run_idx ON public.payroll_postings USING btree (run_id);


--
-- Name: payroll_run_lines_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_run_lines_employee_idx ON public.payroll_run_lines USING btree (employee_id, run_id);


--
-- Name: payroll_run_lines_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_run_lines_run_idx ON public.payroll_run_lines USING btree (run_id);


--
-- Name: payroll_runs_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_runs_month_idx ON public.payroll_runs USING btree (company_id, period_month DESC);


--
-- Name: payroll_runs_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payroll_runs_once_idx ON public.payroll_runs USING btree (company_id, period_month, run_key);


--
-- Name: payroll_timesheet_aliases_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payroll_timesheet_aliases_name_idx ON public.payroll_timesheet_aliases USING btree (company_id, file_name);


--
-- Name: payroll_timesheets_employee_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payroll_timesheets_employee_month_idx ON public.payroll_timesheets USING btree (employee_id, month);


--
-- Name: payroll_timesheets_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payroll_timesheets_month_idx ON public.payroll_timesheets USING btree (month);


--
-- Name: payroll_unit_mapping_unit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payroll_unit_mapping_unit_idx ON public.payroll_unit_mapping USING btree (company_id, organisational_unit);


--
-- Name: pl_categories_name_folded; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pl_categories_name_folded ON public.pl_categories USING btree (lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text)));


--
-- Name: pl_splits_by_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pl_splits_by_source ON public.pl_splits USING btree (source, source_id, sort_order);


--
-- Name: pl_subcategories_name_per_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pl_subcategories_name_per_parent ON public.pl_subcategories USING btree (COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text)));


--
-- Name: processor_tx_external; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX processor_tx_external ON public.processor_transactions USING btree (external_id);


--
-- Name: processor_tx_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX processor_tx_reference ON public.processor_transactions USING btree (reference_id) WHERE (reference_id IS NOT NULL);


--
-- Name: processor_tx_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX processor_tx_run ON public.processor_transactions USING btree (run_id);


--
-- Name: public_holidays_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX public_holidays_day_idx ON public.public_holidays USING btree (holiday_on);


--
-- Name: quick_fill_scripts_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quick_fill_scripts_name_idx ON public.quick_fill_scripts USING btree (lower(btrim(name)));


--
-- Name: revenue_collections_gateway_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX revenue_collections_gateway_idx ON public.revenue_collections USING btree (id_at_gateway) WHERE (id_at_gateway IS NOT NULL);


--
-- Name: revenue_estimate_adjustments_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX revenue_estimate_adjustments_lookup_idx ON public.revenue_estimate_adjustments USING btree (estimate_month, line, created_at);


--
-- Name: scheduled_job_runs_job_fired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_job_runs_job_fired ON public.scheduled_job_runs USING btree (job, fired_at DESC);


--
-- Name: transactions_import_batch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_import_batch_idx ON public.transactions USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL);


--
-- Name: transactions_import_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_import_hash_uidx ON public.transactions USING btree (import_hash) WHERE (import_hash IS NOT NULL);


--
-- Name: transactions_not_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_not_deleted_idx ON public.transactions USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: v_revenue_entry_status _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.v_revenue_entry_status WITH (security_invoker='on') AS
 SELECT e.id,
    e.company_id,
    e.brand,
    e.revenue_stream,
    e.period_month,
    e.source,
    e.currency,
    e.amount,
    e.amount_usd,
    e.status,
    e.invoice_ref,
    e.notes,
    e.created_at,
    e.updated_at,
    COALESCE(sum(ec.allocated_amount_usd), (0)::numeric) AS collected_usd,
    (e.amount_usd - COALESCE(sum(ec.allocated_amount_usd), (0)::numeric)) AS remaining_usd,
        CASE
            WHEN (COALESCE(sum(ec.allocated_amount_usd), (0)::numeric) = (0)::numeric) THEN 'open'::text
            WHEN (COALESCE(sum(ec.allocated_amount_usd), (0)::numeric) >= e.amount_usd) THEN 'collected'::text
            ELSE 'partial'::text
        END AS calculated_status
   FROM (public.revenue_entries e
     LEFT JOIN public.revenue_entry_collections ec ON ((ec.entry_id = e.id)))
  GROUP BY e.id;


--
-- Name: budget_entries audit_budget_entries; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_budget_entries AFTER INSERT OR DELETE OR UPDATE ON public.budget_entries FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: credit_installments audit_credit_installments; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_credit_installments AFTER INSERT OR DELETE OR UPDATE ON public.credit_installments FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: credits audit_credits; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_credits AFTER INSERT OR DELETE OR UPDATE ON public.credits FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: invoice_transaction_links audit_invoice_transaction_links; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_invoice_transaction_links AFTER INSERT OR DELETE OR UPDATE ON public.invoice_transaction_links FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: invoices audit_invoices; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_invoices AFTER INSERT OR DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: partners audit_partners; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_partners AFTER INSERT OR DELETE OR UPDATE ON public.partners FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: passthrough audit_passthrough; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_passthrough AFTER INSERT OR DELETE OR UPDATE ON public.passthrough FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: payroll_lines audit_payroll_lines; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_payroll_lines AFTER INSERT OR DELETE OR UPDATE ON public.payroll_lines FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: payroll_records audit_payroll_records; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_payroll_records AFTER INSERT OR DELETE OR UPDATE ON public.payroll_records FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: transactions audit_transactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_transactions AFTER INSERT OR DELETE OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.audit_trigger();


--
-- Name: payroll_run_lines payroll_run_lines_frozen_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payroll_run_lines_frozen_trg BEFORE INSERT OR DELETE OR UPDATE ON public.payroll_run_lines FOR EACH ROW EXECUTE FUNCTION public.payroll_run_lines_frozen();


--
-- Name: invoices period_lock_invoices; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_lock_invoices BEFORE INSERT OR DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.enforce_period_lock('invoice_date');


--
-- Name: passthrough period_lock_passthrough; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_lock_passthrough BEFORE INSERT OR DELETE OR UPDATE ON public.passthrough FOR EACH ROW EXECUTE FUNCTION public.enforce_period_lock('transaction_date');


--
-- Name: payroll_records period_lock_payroll_records; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_lock_payroll_records BEFORE INSERT OR DELETE OR UPDATE ON public.payroll_records FOR EACH ROW EXECUTE FUNCTION public.enforce_period_lock('payment_date');


--
-- Name: transactions period_lock_transactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER period_lock_transactions BEFORE INSERT OR DELETE OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.enforce_period_lock('transaction_date');


--
-- Name: pl_splits pl_splits_balance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER pl_splits_balance AFTER INSERT OR DELETE OR UPDATE ON public.pl_splits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.pl_splits_must_balance();


--
-- Name: revenue_collections revenue_collections_fill_gateway; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenue_collections_fill_gateway BEFORE INSERT OR UPDATE ON public.revenue_collections FOR EACH ROW EXECUTE FUNCTION public.fill_id_at_gateway();


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: banks banks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.banks
    ADD CONSTRAINT banks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: budget_adjustments budget_adjustments_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_adjustments
    ADD CONSTRAINT budget_adjustments_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: budget_entries budget_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_entries
    ADD CONSTRAINT budget_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: chargebee_site_brands chargebee_site_brands_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_site_brands
    ADD CONSTRAINT chargebee_site_brands_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: chargebee_snapshot_runs chargebee_snapshot_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_snapshot_runs
    ADD CONSTRAINT chargebee_snapshot_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: chargebee_subscription_snapshots chargebee_subscription_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chargebee_subscription_snapshots
    ADD CONSTRAINT chargebee_subscription_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.chargebee_snapshot_runs(id) ON DELETE CASCADE;


--
-- Name: closed_periods closed_periods_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.closed_periods
    ADD CONSTRAINT closed_periods_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: companies companies_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id);


--
-- Name: company_bank_accounts company_bank_accounts_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_profiles company_profiles_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_profiles
    ADD CONSTRAINT company_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: credit_extensions credit_extensions_credit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_extensions
    ADD CONSTRAINT credit_extensions_credit_id_fkey FOREIGN KEY (credit_id) REFERENCES public.credits(id) ON DELETE CASCADE;


--
-- Name: credit_installments credit_installments_credit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_installments
    ADD CONSTRAINT credit_installments_credit_id_fkey FOREIGN KEY (credit_id) REFERENCES public.credits(id) ON DELETE CASCADE;


--
-- Name: credit_installments credit_installments_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_installments
    ADD CONSTRAINT credit_installments_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id);


--
-- Name: credit_rate_resets credit_rate_resets_credit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_rate_resets
    ADD CONSTRAINT credit_rate_resets_credit_id_fkey FOREIGN KEY (credit_id) REFERENCES public.credits(id) ON DELETE CASCADE;


--
-- Name: credits credits_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credits
    ADD CONSTRAINT credits_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: dept_subcategories dept_subcategories_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dept_subcategories
    ADD CONSTRAINT dept_subcategories_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;


--
-- Name: employee_contracts employee_contracts_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_cost_allocation employee_cost_allocation_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_cost_allocation
    ADD CONSTRAINT employee_cost_allocation_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_deductions employee_deductions_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_deductions
    ADD CONSTRAINT employee_deductions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_deductions employee_deductions_payee_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_deductions
    ADD CONSTRAINT employee_deductions_payee_partner_id_fkey FOREIGN KEY (payee_partner_id) REFERENCES public.partners(id) ON DELETE SET NULL;


--
-- Name: employee_payroll_absence employee_payroll_absence_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_payroll_absence
    ADD CONSTRAINT employee_payroll_absence_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_research_engagement employee_research_engagement_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_research_engagement
    ADD CONSTRAINT employee_research_engagement_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employees employees_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: expense_descriptions expense_descriptions_dept_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_descriptions
    ADD CONSTRAINT expense_descriptions_dept_subcategory_id_fkey FOREIGN KEY (dept_subcategory_id) REFERENCES public.dept_subcategories(id) ON DELETE CASCADE;


--
-- Name: expense_subcategories expense_subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_subcategories
    ADD CONSTRAINT expense_subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.expense_categories(id);


--
-- Name: import_logs import_logs_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_logs
    ADD CONSTRAINT import_logs_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id);


--
-- Name: import_logs import_logs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_logs
    ADD CONSTRAINT import_logs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoice_transaction_links invoice_transaction_links_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_transaction_links
    ADD CONSTRAINT invoice_transaction_links_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_transaction_links invoice_transaction_links_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_transaction_links
    ADD CONSTRAINT invoice_transaction_links_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id);


--
-- Name: invoices invoices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoices invoices_parent_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_parent_invoice_id_fkey FOREIGN KEY (parent_invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: partner_accounts partner_accounts_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_accounts
    ADD CONSTRAINT partner_accounts_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE CASCADE;


--
-- Name: passthrough passthrough_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passthrough
    ADD CONSTRAINT passthrough_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id);


--
-- Name: passthrough passthrough_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passthrough
    ADD CONSTRAINT passthrough_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: passthrough passthrough_pair_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passthrough
    ADD CONSTRAINT passthrough_pair_id_fkey FOREIGN KEY (pair_id) REFERENCES public.passthrough(id);


--
-- Name: passthrough passthrough_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passthrough
    ADD CONSTRAINT passthrough_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: payroll_additions payroll_additions_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_additions
    ADD CONSTRAINT payroll_additions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: payroll_lines payroll_lines_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines
    ADD CONSTRAINT payroll_lines_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: payroll_lines payroll_lines_payroll_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_lines
    ADD CONSTRAINT payroll_lines_payroll_id_fkey FOREIGN KEY (payroll_id) REFERENCES public.payroll_records(id) ON DELETE CASCADE;


--
-- Name: payroll_postings payroll_postings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_postings
    ADD CONSTRAINT payroll_postings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payroll_postings payroll_postings_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_postings
    ADD CONSTRAINT payroll_postings_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id) ON DELETE SET NULL;


--
-- Name: payroll_records payroll_records_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id);


--
-- Name: payroll_records payroll_records_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_records
    ADD CONSTRAINT payroll_records_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payroll_run_lines payroll_run_lines_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: payroll_run_lines payroll_run_lines_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_run_lines
    ADD CONSTRAINT payroll_run_lines_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.payroll_runs(id) ON DELETE CASCADE;


--
-- Name: payroll_runs payroll_runs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payroll_timesheet_aliases payroll_timesheet_aliases_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_timesheet_aliases
    ADD CONSTRAINT payroll_timesheet_aliases_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: payroll_timesheet_aliases payroll_timesheet_aliases_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_timesheet_aliases
    ADD CONSTRAINT payroll_timesheet_aliases_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: payroll_timesheets payroll_timesheets_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_timesheets
    ADD CONSTRAINT payroll_timesheets_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: payroll_unit_mapping payroll_unit_mapping_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_unit_mapping
    ADD CONSTRAINT payroll_unit_mapping_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: pl_subcategories pl_subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pl_subcategories
    ADD CONSTRAINT pl_subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.pl_categories(id);


--
-- Name: processor_transactions processor_transactions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processor_transactions
    ADD CONSTRAINT processor_transactions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.processor_sync_runs(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id);


--
-- Name: revenue_collections revenue_collections_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_collections
    ADD CONSTRAINT revenue_collections_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id);


--
-- Name: revenue_collections revenue_collections_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_collections
    ADD CONSTRAINT revenue_collections_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: revenue_entries revenue_entries_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entries
    ADD CONSTRAINT revenue_entries_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: revenue_entry_collections revenue_entry_collections_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entry_collections
    ADD CONSTRAINT revenue_entry_collections_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.revenue_collections(id) ON DELETE CASCADE;


--
-- Name: revenue_entry_collections revenue_entry_collections_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_entry_collections
    ADD CONSTRAINT revenue_entry_collections_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.revenue_entries(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_bank_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_bank_id_fkey FOREIGN KEY (bank_id) REFERENCES public.banks(id);


--
-- Name: transactions transactions_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: transactions transactions_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id);


--
-- Name: user_access user_access_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access
    ADD CONSTRAINT user_access_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.profiles(id);


--
-- Name: user_access user_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access
    ADD CONSTRAINT user_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);


--
-- Name: import_logs Allow all for authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated" ON public.import_logs USING (true) WITH CHECK (true);


--
-- Name: banks Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.banks USING ((auth.role() = 'authenticated'::text));


--
-- Name: companies Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.companies USING ((auth.role() = 'authenticated'::text));


--
-- Name: expense_categories Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.expense_categories USING ((auth.role() = 'authenticated'::text));


--
-- Name: expense_subcategories Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.expense_subcategories USING ((auth.role() = 'authenticated'::text));


--
-- Name: partners Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.partners USING ((auth.role() = 'authenticated'::text));


--
-- Name: pl_categories Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.pl_categories USING ((auth.role() = 'authenticated'::text));


--
-- Name: pl_subcategories Allow all for authenticated users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for authenticated users" ON public.pl_subcategories USING ((auth.role() = 'authenticated'::text));


--
-- Name: credit_installments Allow authenticated all on credit_installments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated all on credit_installments" ON public.credit_installments TO authenticated USING (true) WITH CHECK (true);


--
-- Name: credits Allow authenticated all on credits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated all on credits" ON public.credits TO authenticated USING (true) WITH CHECK (true);


--
-- Name: budget_entries Allow authenticated insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated insert" ON public.budget_entries FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: budget_entries Allow authenticated select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated select" ON public.budget_entries FOR SELECT TO authenticated USING (true);


--
-- Name: budget_entries Allow authenticated update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow authenticated update" ON public.budget_entries FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: integration_credentials admin_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_only ON public.integration_credentials TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'administrator'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'administrator'::text)))));


--
-- Name: audit_log audit_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_insert ON public.audit_log FOR INSERT WITH CHECK (true);


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log audit_log_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_read ON public.audit_log FOR SELECT TO authenticated USING (true);


--
-- Name: audit_log audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_select ON public.audit_log FOR SELECT USING ((public.get_my_role() = 'administrator'::text));


--
-- Name: chargebee_site_brands auth_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_all ON public.chargebee_site_brands TO authenticated USING (true) WITH CHECK (true);


--
-- Name: revenue_collections auth_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_all ON public.revenue_collections TO authenticated USING (true) WITH CHECK (true);


--
-- Name: revenue_entries auth_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_all ON public.revenue_entries TO authenticated USING (true) WITH CHECK (true);


--
-- Name: revenue_entry_collections auth_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_all ON public.revenue_entry_collections TO authenticated USING (true) WITH CHECK (true);


--
-- Name: company_bank_accounts authenticated can delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can delete" ON public.company_bank_accounts FOR DELETE TO authenticated USING (true);


--
-- Name: partner_accounts authenticated can delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can delete" ON public.partner_accounts FOR DELETE TO authenticated USING (true);


--
-- Name: company_bank_accounts authenticated can insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can insert" ON public.company_bank_accounts FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: company_profiles authenticated can insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can insert" ON public.company_profiles FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: partner_accounts authenticated can insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can insert" ON public.partner_accounts FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: company_bank_accounts authenticated can select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can select" ON public.company_bank_accounts FOR SELECT TO authenticated USING (true);


--
-- Name: company_profiles authenticated can select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can select" ON public.company_profiles FOR SELECT TO authenticated USING (true);


--
-- Name: partner_accounts authenticated can select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can select" ON public.partner_accounts FOR SELECT TO authenticated USING (true);


--
-- Name: company_bank_accounts authenticated can update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can update" ON public.company_bank_accounts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: company_profiles authenticated can update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can update" ON public.company_profiles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: partner_accounts authenticated can update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated can update" ON public.partner_accounts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: banks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.banks ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_adjustments budget_adjustments_append; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budget_adjustments_append ON public.budget_adjustments FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: budget_adjustments budget_adjustments_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY budget_adjustments_read ON public.budget_adjustments FOR SELECT TO authenticated USING (true);


--
-- Name: budget_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_positions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cash_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: cash_positions cash_positions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_positions_select ON public.cash_positions FOR SELECT TO authenticated USING (true);


--
-- Name: cash_positions cash_positions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cash_positions_write ON public.cash_positions TO authenticated USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: chargebee_snapshot_runs cbsr_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cbsr_select ON public.chargebee_snapshot_runs FOR SELECT TO authenticated USING (((company_id IS NULL) OR public.has_company_access(company_id)));


--
-- Name: chargebee_subscription_snapshots cbss_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cbss_select ON public.chargebee_subscription_snapshots FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.chargebee_snapshot_runs r
  WHERE ((r.id = chargebee_subscription_snapshots.run_id) AND ((r.company_id IS NULL) OR public.has_company_access(r.company_id))))));


--
-- Name: chargebee_site_brands; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chargebee_site_brands ENABLE ROW LEVEL SECURITY;

--
-- Name: chargebee_site_brands chargebee_site_brands_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chargebee_site_brands_select ON public.chargebee_site_brands FOR SELECT TO authenticated USING (true);


--
-- Name: chargebee_site_brands chargebee_site_brands_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chargebee_site_brands_write ON public.chargebee_site_brands TO authenticated USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: chargebee_snapshot_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chargebee_snapshot_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: chargebee_subscription_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chargebee_subscription_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: closed_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.closed_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: closed_periods closed_periods_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closed_periods_read ON public.closed_periods FOR SELECT TO authenticated USING (true);


--
-- Name: closed_periods closed_periods_unlock; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closed_periods_unlock ON public.closed_periods FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: closed_periods closed_periods_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY closed_periods_write ON public.closed_periods FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: company_bank_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_bank_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: company_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_extensions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_extensions ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_extensions credit_extensions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_extensions_insert ON public.credit_extensions FOR INSERT TO authenticated WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: credit_extensions credit_extensions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_extensions_select ON public.credit_extensions FOR SELECT TO authenticated USING (true);


--
-- Name: credit_installments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_installments ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_rate_resets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_rate_resets ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_rate_resets credit_rate_resets_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_rate_resets_insert ON public.credit_rate_resets FOR INSERT TO authenticated WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: credit_rate_resets credit_rate_resets_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY credit_rate_resets_select ON public.credit_rate_resets FOR SELECT TO authenticated USING (true);


--
-- Name: credits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credits ENABLE ROW LEVEL SECURITY;

--
-- Name: departments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

--
-- Name: departments departments_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY departments_authenticated_read ON public.departments FOR SELECT TO authenticated USING (true);


--
-- Name: departments dept_modify; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dept_modify ON public.departments USING ((public.get_my_role() = 'administrator'::text)) WITH CHECK ((public.get_my_role() = 'administrator'::text));


--
-- Name: departments dept_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dept_select ON public.departments FOR SELECT USING (true);


--
-- Name: dept_subcategories dept_sub_modify; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dept_sub_modify ON public.dept_subcategories USING ((public.get_my_role() = 'administrator'::text)) WITH CHECK ((public.get_my_role() = 'administrator'::text));


--
-- Name: dept_subcategories dept_sub_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dept_sub_select ON public.dept_subcategories FOR SELECT USING (true);


--
-- Name: dept_subcategories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dept_subcategories ENABLE ROW LEVEL SECURITY;

--
-- Name: dept_subcategories dept_subcategories_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dept_subcategories_authenticated_read ON public.dept_subcategories FOR SELECT TO authenticated USING (true);


--
-- Name: employee_contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_contracts employee_contracts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_contracts_read ON public.employee_contracts FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_contracts employee_contracts_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_contracts_write ON public.employee_contracts USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_cost_allocation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_cost_allocation ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_cost_allocation employee_cost_allocation_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_cost_allocation_read ON public.employee_cost_allocation FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_cost_allocation employee_cost_allocation_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_cost_allocation_write ON public.employee_cost_allocation USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_deductions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_deductions ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_deductions employee_deductions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_deductions_read ON public.employee_deductions FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_deductions employee_deductions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_deductions_write ON public.employee_deductions USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_payroll_absence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_payroll_absence ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_payroll_absence employee_payroll_absence_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_payroll_absence_read ON public.employee_payroll_absence FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_payroll_absence employee_payroll_absence_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_payroll_absence_write ON public.employee_payroll_absence USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_research_engagement; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_research_engagement ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_research_engagement employee_research_engagement_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_research_engagement_read ON public.employee_research_engagement FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employee_research_engagement employee_research_engagement_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employee_research_engagement_write ON public.employee_research_engagement USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: employees employees_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_read ON public.employees FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: employees employees_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY employees_write ON public.employees USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: exchange_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_descriptions exp_desc_modify; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY exp_desc_modify ON public.expense_descriptions USING ((public.get_my_role() = 'administrator'::text)) WITH CHECK ((public.get_my_role() = 'administrator'::text));


--
-- Name: expense_descriptions exp_desc_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY exp_desc_select ON public.expense_descriptions FOR SELECT USING (true);


--
-- Name: expense_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_descriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_descriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_descriptions expense_descriptions_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY expense_descriptions_authenticated_read ON public.expense_descriptions FOR SELECT TO authenticated USING (true);


--
-- Name: expense_subcategories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_subcategories ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags feature_flags_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feature_flags_read ON public.feature_flags FOR SELECT TO authenticated USING (true);


--
-- Name: feature_flags feature_flags_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY feature_flags_write ON public.feature_flags FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: import_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: import_logs import_logs_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_logs_authenticated_read ON public.import_logs FOR SELECT TO authenticated USING (true);


--
-- Name: import_logs import_logs_authenticated_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_logs_authenticated_update ON public.import_logs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: import_logs import_logs_authenticated_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY import_logs_authenticated_write ON public.import_logs FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: installments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.installments ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_matches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_matches ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_transaction_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_transaction_links ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices invoices_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoices_delete ON public.invoices FOR DELETE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: invoices invoices_hide_deleted; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoices_hide_deleted ON public.invoices AS RESTRICTIVE FOR SELECT TO authenticated USING ((deleted_at IS NULL));


--
-- Name: invoices invoices_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoices_insert ON public.invoices FOR INSERT WITH CHECK (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND public.has_company_access(company_id)));


--
-- Name: invoices invoices_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoices_select ON public.invoices FOR SELECT USING (public.has_company_access(company_id));


--
-- Name: invoices invoices_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invoices_update ON public.invoices FOR UPDATE USING (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND public.has_company_access(company_id)));


--
-- Name: invoice_transaction_links itl_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY itl_delete ON public.invoice_transaction_links FOR DELETE USING (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND (EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_transaction_links.invoice_id) AND public.has_company_access(i.company_id))))));


--
-- Name: invoice_transaction_links itl_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY itl_insert ON public.invoice_transaction_links FOR INSERT WITH CHECK (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND (EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_transaction_links.invoice_id) AND public.has_company_access(i.company_id))))));


--
-- Name: invoice_transaction_links itl_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY itl_select ON public.invoice_transaction_links FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_transaction_links.invoice_id) AND public.has_company_access(i.company_id)))));


--
-- Name: invoice_transaction_links itl_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY itl_update ON public.invoice_transaction_links FOR UPDATE USING (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND (EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_transaction_links.invoice_id) AND public.has_company_access(i.company_id)))))) WITH CHECK (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND (EXISTS ( SELECT 1
   FROM public.invoices i
  WHERE ((i.id = invoice_transaction_links.invoice_id) AND public.has_company_access(i.company_id))))));


--
-- Name: job_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_config ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles own_profile_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_profile_only ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = id));


--
-- Name: profiles own_profile_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY own_profile_update ON public.profiles FOR UPDATE TO authenticated USING ((auth.uid() = id));


--
-- Name: partner_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: partners; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

--
-- Name: partners partners_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partners_authenticated_read ON public.partners FOR SELECT TO authenticated USING (true);


--
-- Name: partners partners_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partners_delete ON public.partners FOR DELETE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: partners partners_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partners_insert ON public.partners FOR INSERT WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: partners partners_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partners_select ON public.partners FOR SELECT USING (true);


--
-- Name: partners partners_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partners_update ON public.partners FOR UPDATE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: passthrough; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.passthrough ENABLE ROW LEVEL SECURITY;

--
-- Name: passthrough passthrough_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY passthrough_delete ON public.passthrough FOR DELETE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: passthrough passthrough_hide_deleted; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY passthrough_hide_deleted ON public.passthrough AS RESTRICTIVE FOR SELECT TO authenticated USING ((deleted_at IS NULL));


--
-- Name: passthrough passthrough_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY passthrough_insert ON public.passthrough FOR INSERT WITH CHECK (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND public.has_company_access(company_id)));


--
-- Name: passthrough passthrough_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY passthrough_select ON public.passthrough FOR SELECT USING (public.has_company_access(company_id));


--
-- Name: passthrough passthrough_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY passthrough_update ON public.passthrough FOR UPDATE USING (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND public.has_company_access(company_id)));


--
-- Name: payroll_additions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_additions ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_additions payroll_additions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_additions_read ON public.payroll_additions FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_additions payroll_additions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_additions_write ON public.payroll_additions USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_lines payroll_lines_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_lines_all ON public.payroll_lines USING (true);


--
-- Name: payroll_lines payroll_lines_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_lines_authenticated_read ON public.payroll_lines FOR SELECT TO authenticated USING (true);


--
-- Name: payroll_postings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_postings ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_postings payroll_postings_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_postings_read ON public.payroll_postings FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_postings payroll_postings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_postings_write ON public.payroll_postings USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_records ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_records payroll_records_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_records_all ON public.payroll_records USING (true);


--
-- Name: payroll_records payroll_records_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_records_authenticated_read ON public.payroll_records FOR SELECT TO authenticated USING (true);


--
-- Name: payroll_run_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_run_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_run_lines payroll_run_lines_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_run_lines_read ON public.payroll_run_lines FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_run_lines payroll_run_lines_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_run_lines_write ON public.payroll_run_lines USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_runs payroll_runs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_runs_read ON public.payroll_runs FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_runs payroll_runs_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_runs_write ON public.payroll_runs USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_settings payroll_settings_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_settings_select ON public.payroll_settings FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: payroll_settings payroll_settings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_settings_write ON public.payroll_settings USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_timesheet_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_timesheet_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_timesheet_aliases payroll_timesheet_aliases_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_timesheet_aliases_read ON public.payroll_timesheet_aliases FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_timesheet_aliases payroll_timesheet_aliases_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_timesheet_aliases_write ON public.payroll_timesheet_aliases USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_timesheets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_timesheets ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_timesheets payroll_timesheets_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_timesheets_read ON public.payroll_timesheets FOR SELECT USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_timesheets payroll_timesheets_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_timesheets_write ON public.payroll_timesheets USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: payroll_unit_mapping; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_unit_mapping ENABLE ROW LEVEL SECURITY;

--
-- Name: payroll_unit_mapping payroll_unit_mapping_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_unit_mapping_read ON public.payroll_unit_mapping FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: payroll_unit_mapping payroll_unit_mapping_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_unit_mapping_write ON public.payroll_unit_mapping USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: pl_categories pl_cat_modify; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_cat_modify ON public.pl_categories USING ((public.get_my_role() = 'administrator'::text)) WITH CHECK ((public.get_my_role() = 'administrator'::text));


--
-- Name: pl_categories pl_cat_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_cat_select ON public.pl_categories FOR SELECT USING (true);


--
-- Name: pl_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pl_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: pl_categories pl_categories_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_categories_authenticated_read ON public.pl_categories FOR SELECT TO authenticated USING (true);


--
-- Name: pl_splits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pl_splits ENABLE ROW LEVEL SECURITY;

--
-- Name: pl_splits pl_splits_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_splits_select ON public.pl_splits FOR SELECT TO authenticated USING (true);


--
-- Name: pl_splits pl_splits_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_splits_write ON public.pl_splits TO authenticated USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: pl_subcategories pl_sub_modify; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_sub_modify ON public.pl_subcategories USING ((public.get_my_role() = 'administrator'::text)) WITH CHECK ((public.get_my_role() = 'administrator'::text));


--
-- Name: pl_subcategories pl_sub_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_sub_select ON public.pl_subcategories FOR SELECT USING (true);


--
-- Name: pl_subcategories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pl_subcategories ENABLE ROW LEVEL SECURITY;

--
-- Name: pl_subcategories pl_subcategories_authenticated_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pl_subcategories_authenticated_read ON public.pl_subcategories FOR SELECT TO authenticated USING (true);


--
-- Name: processor_sync_runs processor_runs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY processor_runs_select ON public.processor_sync_runs FOR SELECT TO authenticated USING (true);


--
-- Name: processor_sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.processor_sync_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: processor_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.processor_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: processor_transactions processor_tx_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY processor_tx_select ON public.processor_transactions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.processor_sync_runs r
  WHERE (r.id = processor_transactions.run_id))));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: public_holidays; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_holidays ENABLE ROW LEVEL SECURITY;

--
-- Name: public_holidays public_holidays_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_holidays_read ON public.public_holidays FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: public_holidays public_holidays_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_holidays_write ON public.public_holidays USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: quick_fill_scripts qfs_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY qfs_delete ON public.quick_fill_scripts FOR DELETE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: quick_fill_scripts qfs_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY qfs_insert ON public.quick_fill_scripts FOR INSERT WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: quick_fill_scripts qfs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY qfs_select ON public.quick_fill_scripts FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: quick_fill_scripts qfs_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY qfs_update ON public.quick_fill_scripts FOR UPDATE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: quick_fill_scripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quick_fill_scripts ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_logs read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_authenticated ON public.sync_logs FOR SELECT TO authenticated USING (true);


--
-- Name: revenue_collections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_collections ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_entry_collections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_entry_collections ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_estimate_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_estimate_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_estimate_adjustments revenue_estimate_adjustments_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY revenue_estimate_adjustments_insert ON public.revenue_estimate_adjustments FOR INSERT TO authenticated WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: revenue_estimate_adjustments revenue_estimate_adjustments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY revenue_estimate_adjustments_select ON public.revenue_estimate_adjustments FOR SELECT TO authenticated USING (true);


--
-- Name: revenue_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_settings revenue_settings_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY revenue_settings_select ON public.revenue_settings FOR SELECT TO authenticated USING (true);


--
-- Name: revenue_settings revenue_settings_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY revenue_settings_write ON public.revenue_settings TO authenticated USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text]))) WITH CHECK ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])));


--
-- Name: scheduled_job_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduled_job_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_credentials service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all ON public.integration_credentials TO service_role USING (true) WITH CHECK (true);


--
-- Name: sync_logs service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY service_role_all ON public.sync_logs TO service_role USING (true) WITH CHECK (true);


--
-- Name: scheduled_job_runs sjr_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sjr_select ON public.scheduled_job_runs FOR SELECT TO authenticated USING (true);


--
-- Name: sync_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions transactions_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_delete ON public.transactions FOR DELETE USING ((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text])));


--
-- Name: transactions transactions_hide_deleted; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_hide_deleted ON public.transactions AS RESTRICTIVE FOR SELECT TO authenticated USING ((deleted_at IS NULL));


--
-- Name: transactions transactions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_insert ON public.transactions FOR INSERT WITH CHECK (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND public.has_company_access(company_id)));


--
-- Name: transactions transactions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_select ON public.transactions FOR SELECT USING (public.has_company_access(company_id));


--
-- Name: transactions transactions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_update ON public.transactions FOR UPDATE USING (((public.get_my_role() = ANY (ARRAY['administrator'::text, 'owner'::text, 'administrative_assistant'::text])) AND public.has_company_access(company_id)));


--
-- Name: user_access; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_access ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles users_read_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_read_own_profile ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = id));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION audit_trigger(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.audit_trigger() TO anon;
GRANT ALL ON FUNCTION public.audit_trigger() TO authenticated;
GRANT ALL ON FUNCTION public.audit_trigger() TO service_role;


--
-- Name: FUNCTION claim_chargebee_snapshot(p_date date, p_site text, p_company uuid, p_brand text, p_stale_after interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_chargebee_snapshot(p_date date, p_site text, p_company uuid, p_brand text, p_stale_after interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_chargebee_snapshot(p_date date, p_site text, p_company uuid, p_brand text, p_stale_after interval) TO anon;
GRANT ALL ON FUNCTION public.claim_chargebee_snapshot(p_date date, p_site text, p_company uuid, p_brand text, p_stale_after interval) TO authenticated;
GRANT ALL ON FUNCTION public.claim_chargebee_snapshot(p_date date, p_site text, p_company uuid, p_brand text, p_stale_after interval) TO service_role;


--
-- Name: FUNCTION claim_processor_sync(p_date date, p_provider text, p_account text, p_stale_after interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_processor_sync(p_date date, p_provider text, p_account text, p_stale_after interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_processor_sync(p_date date, p_provider text, p_account text, p_stale_after interval) TO anon;
GRANT ALL ON FUNCTION public.claim_processor_sync(p_date date, p_provider text, p_account text, p_stale_after interval) TO authenticated;
GRANT ALL ON FUNCTION public.claim_processor_sync(p_date date, p_provider text, p_account text, p_stale_after interval) TO service_role;


--
-- Name: FUNCTION delete_statement_cascade(p_batch_id text, p_deleted_by uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_statement_cascade(p_batch_id text, p_deleted_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_statement_cascade(p_batch_id text, p_deleted_by uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_statement_cascade(p_batch_id text, p_deleted_by uuid) TO service_role;


--
-- Name: FUNCTION delete_transaction_cascade(p_transaction_id uuid, p_deleted_by uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_transaction_cascade(p_transaction_id uuid, p_deleted_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_transaction_cascade(p_transaction_id uuid, p_deleted_by uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_transaction_cascade(p_transaction_id uuid, p_deleted_by uuid) TO service_role;


--
-- Name: FUNCTION enforce_period_lock(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_period_lock() TO anon;
GRANT ALL ON FUNCTION public.enforce_period_lock() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_period_lock() TO service_role;


--
-- Name: FUNCTION fill_id_at_gateway(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fill_id_at_gateway() TO anon;
GRANT ALL ON FUNCTION public.fill_id_at_gateway() TO authenticated;
GRANT ALL ON FUNCTION public.fill_id_at_gateway() TO service_role;


--
-- Name: FUNCTION get_my_role(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_role() TO anon;
GRANT ALL ON FUNCTION public.get_my_role() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_role() TO service_role;


--
-- Name: FUNCTION get_unmatched_braintree(p_site text, p_date_from date, p_date_to date, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_unmatched_braintree(p_site text, p_date_from date, p_date_to date, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.get_unmatched_braintree(p_site text, p_date_from date, p_date_to date, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_unmatched_braintree(p_site text, p_date_from date, p_date_to date, p_limit integer) TO service_role;


--
-- Name: FUNCTION has_company_access(p_company_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.has_company_access(p_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.has_company_access(p_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.has_company_access(p_company_id uuid) TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION log_audit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_audit() TO anon;
GRANT ALL ON FUNCTION public.log_audit() TO authenticated;
GRANT ALL ON FUNCTION public.log_audit() TO service_role;


--
-- Name: FUNCTION payroll_run_lines_frozen(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.payroll_run_lines_frozen() TO anon;
GRANT ALL ON FUNCTION public.payroll_run_lines_frozen() TO authenticated;
GRANT ALL ON FUNCTION public.payroll_run_lines_frozen() TO service_role;


--
-- Name: FUNCTION pl_splits_must_balance(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pl_splits_must_balance() TO anon;
GRANT ALL ON FUNCTION public.pl_splits_must_balance() TO authenticated;
GRANT ALL ON FUNCTION public.pl_splits_must_balance() TO service_role;


--
-- Name: FUNCTION reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_usd numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_usd numeric) TO anon;
GRANT ALL ON FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_usd numeric) TO authenticated;
GRANT ALL ON FUNCTION public.reconcile_direct_transaction(p_transaction_id uuid, p_invoice_id uuid, p_allocated_usd numeric) TO service_role;


--
-- Name: FUNCTION run_chargebee_snapshot(force boolean, p_site text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.run_chargebee_snapshot(force boolean, p_site text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.run_chargebee_snapshot(force boolean, p_site text) TO anon;
GRANT ALL ON FUNCTION public.run_chargebee_snapshot(force boolean, p_site text) TO authenticated;
GRANT ALL ON FUNCTION public.run_chargebee_snapshot(force boolean, p_site text) TO service_role;


--
-- Name: FUNCTION run_processor_sync(p_function text, force boolean, p_body jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.run_processor_sync(p_function text, force boolean, p_body jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.run_processor_sync(p_function text, force boolean, p_body jsonb) TO anon;
GRANT ALL ON FUNCTION public.run_processor_sync(p_function text, force boolean, p_body jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.run_processor_sync(p_function text, force boolean, p_body jsonb) TO service_role;


--
-- Name: FUNCTION soft_delete_row(p_table text, p_id uuid, p_deleted_by uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.soft_delete_row(p_table text, p_id uuid, p_deleted_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.soft_delete_row(p_table text, p_id uuid, p_deleted_by uuid) TO authenticated;
GRANT ALL ON FUNCTION public.soft_delete_row(p_table text, p_id uuid, p_deleted_by uuid) TO service_role;


--
-- Name: TABLE audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.audit_log TO service_role;
GRANT SELECT ON TABLE public.audit_log TO authenticated;


--
-- Name: TABLE banks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.banks TO anon;
GRANT ALL ON TABLE public.banks TO authenticated;
GRANT ALL ON TABLE public.banks TO service_role;


--
-- Name: TABLE budget_adjustments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.budget_adjustments TO service_role;
GRANT SELECT,INSERT ON TABLE public.budget_adjustments TO authenticated;


--
-- Name: TABLE budget_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.budget_entries TO anon;
GRANT ALL ON TABLE public.budget_entries TO authenticated;
GRANT ALL ON TABLE public.budget_entries TO service_role;


--
-- Name: TABLE cash_positions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cash_positions TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cash_positions TO authenticated;


--
-- Name: TABLE chargebee_site_brands; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chargebee_site_brands TO anon;
GRANT ALL ON TABLE public.chargebee_site_brands TO authenticated;
GRANT ALL ON TABLE public.chargebee_site_brands TO service_role;


--
-- Name: TABLE chargebee_snapshot_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chargebee_snapshot_runs TO anon;
GRANT ALL ON TABLE public.chargebee_snapshot_runs TO authenticated;
GRANT ALL ON TABLE public.chargebee_snapshot_runs TO service_role;


--
-- Name: SEQUENCE chargebee_snapshot_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.chargebee_snapshot_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.chargebee_snapshot_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.chargebee_snapshot_runs_id_seq TO service_role;


--
-- Name: TABLE chargebee_subscription_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.chargebee_subscription_snapshots TO anon;
GRANT ALL ON TABLE public.chargebee_subscription_snapshots TO authenticated;
GRANT ALL ON TABLE public.chargebee_subscription_snapshots TO service_role;


--
-- Name: TABLE closed_periods; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.closed_periods TO authenticated;
GRANT ALL ON TABLE public.closed_periods TO service_role;


--
-- Name: TABLE companies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.companies TO anon;
GRANT ALL ON TABLE public.companies TO authenticated;
GRANT ALL ON TABLE public.companies TO service_role;


--
-- Name: TABLE company_bank_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.company_bank_accounts TO anon;
GRANT ALL ON TABLE public.company_bank_accounts TO authenticated;
GRANT ALL ON TABLE public.company_bank_accounts TO service_role;


--
-- Name: TABLE company_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.company_profiles TO anon;
GRANT ALL ON TABLE public.company_profiles TO authenticated;
GRANT ALL ON TABLE public.company_profiles TO service_role;


--
-- Name: TABLE credit_extensions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.credit_extensions TO service_role;
GRANT SELECT,INSERT ON TABLE public.credit_extensions TO authenticated;


--
-- Name: TABLE credit_installments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.credit_installments TO anon;
GRANT ALL ON TABLE public.credit_installments TO authenticated;
GRANT ALL ON TABLE public.credit_installments TO service_role;


--
-- Name: TABLE credit_rate_resets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.credit_rate_resets TO service_role;
GRANT SELECT,INSERT ON TABLE public.credit_rate_resets TO authenticated;


--
-- Name: TABLE credits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.credits TO anon;
GRANT ALL ON TABLE public.credits TO authenticated;
GRANT ALL ON TABLE public.credits TO service_role;


--
-- Name: TABLE departments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.departments TO authenticated;
GRANT ALL ON TABLE public.departments TO service_role;


--
-- Name: TABLE dept_subcategories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dept_subcategories TO authenticated;
GRANT ALL ON TABLE public.dept_subcategories TO service_role;


--
-- Name: TABLE employee_contracts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employee_contracts TO authenticated;
GRANT ALL ON TABLE public.employee_contracts TO service_role;


--
-- Name: TABLE employee_cost_allocation; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employee_cost_allocation TO authenticated;
GRANT ALL ON TABLE public.employee_cost_allocation TO service_role;


--
-- Name: TABLE employee_deductions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employee_deductions TO authenticated;
GRANT ALL ON TABLE public.employee_deductions TO service_role;


--
-- Name: TABLE employee_payroll_absence; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employee_payroll_absence TO authenticated;
GRANT ALL ON TABLE public.employee_payroll_absence TO service_role;


--
-- Name: TABLE employee_research_engagement; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employee_research_engagement TO authenticated;
GRANT ALL ON TABLE public.employee_research_engagement TO service_role;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employees TO authenticated;
GRANT ALL ON TABLE public.employees TO service_role;


--
-- Name: TABLE exchange_rates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exchange_rates TO anon;
GRANT ALL ON TABLE public.exchange_rates TO authenticated;
GRANT ALL ON TABLE public.exchange_rates TO service_role;


--
-- Name: TABLE expense_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_categories TO anon;
GRANT ALL ON TABLE public.expense_categories TO authenticated;
GRANT ALL ON TABLE public.expense_categories TO service_role;


--
-- Name: TABLE expense_descriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_descriptions TO authenticated;
GRANT ALL ON TABLE public.expense_descriptions TO service_role;


--
-- Name: TABLE expense_subcategories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_subcategories TO anon;
GRANT ALL ON TABLE public.expense_subcategories TO authenticated;
GRANT ALL ON TABLE public.expense_subcategories TO service_role;


--
-- Name: TABLE feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.feature_flags TO authenticated;
GRANT ALL ON TABLE public.feature_flags TO service_role;


--
-- Name: TABLE groups; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.groups TO anon;
GRANT ALL ON TABLE public.groups TO authenticated;
GRANT ALL ON TABLE public.groups TO service_role;


--
-- Name: TABLE import_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.import_logs TO authenticated;
GRANT ALL ON TABLE public.import_logs TO service_role;


--
-- Name: TABLE installments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.installments TO anon;
GRANT ALL ON TABLE public.installments TO authenticated;
GRANT ALL ON TABLE public.installments TO service_role;


--
-- Name: TABLE integration_credentials; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.integration_credentials TO anon;
GRANT ALL ON TABLE public.integration_credentials TO authenticated;
GRANT ALL ON TABLE public.integration_credentials TO service_role;


--
-- Name: TABLE invoice_matches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invoice_matches TO anon;
GRANT ALL ON TABLE public.invoice_matches TO authenticated;
GRANT ALL ON TABLE public.invoice_matches TO service_role;


--
-- Name: TABLE invoice_transaction_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invoice_transaction_links TO anon;
GRANT ALL ON TABLE public.invoice_transaction_links TO authenticated;
GRANT ALL ON TABLE public.invoice_transaction_links TO service_role;


--
-- Name: TABLE invoices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invoices TO anon;
GRANT ALL ON TABLE public.invoices TO authenticated;
GRANT ALL ON TABLE public.invoices TO service_role;


--
-- Name: TABLE job_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_config TO anon;
GRANT ALL ON TABLE public.job_config TO authenticated;
GRANT ALL ON TABLE public.job_config TO service_role;


--
-- Name: TABLE partner_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partner_accounts TO anon;
GRANT ALL ON TABLE public.partner_accounts TO authenticated;
GRANT ALL ON TABLE public.partner_accounts TO service_role;


--
-- Name: TABLE partners; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partners TO authenticated;
GRANT ALL ON TABLE public.partners TO service_role;


--
-- Name: TABLE passthrough; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.passthrough TO anon;
GRANT ALL ON TABLE public.passthrough TO authenticated;
GRANT ALL ON TABLE public.passthrough TO service_role;


--
-- Name: TABLE payroll_additions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_additions TO authenticated;
GRANT ALL ON TABLE public.payroll_additions TO service_role;


--
-- Name: TABLE payroll_lines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_lines TO authenticated;
GRANT ALL ON TABLE public.payroll_lines TO service_role;


--
-- Name: TABLE payroll_postings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_postings TO authenticated;
GRANT ALL ON TABLE public.payroll_postings TO service_role;


--
-- Name: TABLE payroll_records; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_records TO authenticated;
GRANT ALL ON TABLE public.payroll_records TO service_role;


--
-- Name: TABLE payroll_run_lines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_run_lines TO authenticated;
GRANT ALL ON TABLE public.payroll_run_lines TO service_role;


--
-- Name: TABLE payroll_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_runs TO authenticated;
GRANT ALL ON TABLE public.payroll_runs TO service_role;


--
-- Name: TABLE payroll_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_settings TO authenticated;
GRANT ALL ON TABLE public.payroll_settings TO service_role;


--
-- Name: TABLE payroll_timesheet_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_timesheet_aliases TO authenticated;
GRANT ALL ON TABLE public.payroll_timesheet_aliases TO service_role;


--
-- Name: TABLE payroll_timesheets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_timesheets TO authenticated;
GRANT ALL ON TABLE public.payroll_timesheets TO service_role;


--
-- Name: TABLE payroll_unit_mapping; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_unit_mapping TO authenticated;
GRANT ALL ON TABLE public.payroll_unit_mapping TO service_role;


--
-- Name: TABLE pl_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pl_categories TO authenticated;
GRANT ALL ON TABLE public.pl_categories TO service_role;


--
-- Name: TABLE pl_splits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pl_splits TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pl_splits TO authenticated;


--
-- Name: TABLE pl_subcategories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pl_subcategories TO authenticated;
GRANT ALL ON TABLE public.pl_subcategories TO service_role;


--
-- Name: TABLE processor_sync_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.processor_sync_runs TO anon;
GRANT ALL ON TABLE public.processor_sync_runs TO authenticated;
GRANT ALL ON TABLE public.processor_sync_runs TO service_role;


--
-- Name: SEQUENCE processor_sync_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.processor_sync_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.processor_sync_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.processor_sync_runs_id_seq TO service_role;


--
-- Name: TABLE processor_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.processor_transactions TO anon;
GRANT ALL ON TABLE public.processor_transactions TO authenticated;
GRANT ALL ON TABLE public.processor_transactions TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE public_holidays; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_holidays TO authenticated;
GRANT ALL ON TABLE public.public_holidays TO service_role;


--
-- Name: TABLE quick_fill_scripts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.quick_fill_scripts TO authenticated;
GRANT ALL ON TABLE public.quick_fill_scripts TO service_role;


--
-- Name: TABLE revenue_collections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenue_collections TO anon;
GRANT ALL ON TABLE public.revenue_collections TO authenticated;
GRANT ALL ON TABLE public.revenue_collections TO service_role;


--
-- Name: TABLE revenue_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenue_entries TO anon;
GRANT ALL ON TABLE public.revenue_entries TO authenticated;
GRANT ALL ON TABLE public.revenue_entries TO service_role;


--
-- Name: TABLE revenue_entry_collections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenue_entry_collections TO anon;
GRANT ALL ON TABLE public.revenue_entry_collections TO authenticated;
GRANT ALL ON TABLE public.revenue_entry_collections TO service_role;


--
-- Name: TABLE revenue_estimate_adjustments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenue_estimate_adjustments TO service_role;
GRANT SELECT,INSERT ON TABLE public.revenue_estimate_adjustments TO authenticated;


--
-- Name: TABLE revenue_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenue_settings TO anon;
GRANT ALL ON TABLE public.revenue_settings TO authenticated;
GRANT ALL ON TABLE public.revenue_settings TO service_role;


--
-- Name: TABLE scheduled_job_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scheduled_job_runs TO anon;
GRANT ALL ON TABLE public.scheduled_job_runs TO authenticated;
GRANT ALL ON TABLE public.scheduled_job_runs TO service_role;


--
-- Name: SEQUENCE scheduled_job_runs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.scheduled_job_runs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.scheduled_job_runs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.scheduled_job_runs_id_seq TO service_role;


--
-- Name: TABLE sync_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sync_logs TO anon;
GRANT ALL ON TABLE public.sync_logs TO authenticated;
GRANT ALL ON TABLE public.sync_logs TO service_role;


--
-- Name: TABLE transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transactions TO anon;
GRANT ALL ON TABLE public.transactions TO authenticated;
GRANT ALL ON TABLE public.transactions TO service_role;


--
-- Name: TABLE user_access; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_access TO anon;
GRANT ALL ON TABLE public.user_access TO authenticated;
GRANT ALL ON TABLE public.user_access TO service_role;


--
-- Name: TABLE v_budget_vs_actual; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_budget_vs_actual TO anon;
GRANT ALL ON TABLE public.v_budget_vs_actual TO authenticated;
GRANT ALL ON TABLE public.v_budget_vs_actual TO service_role;


--
-- Name: TABLE v_cash_position_latest; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_cash_position_latest TO anon;
GRANT ALL ON TABLE public.v_cash_position_latest TO authenticated;
GRANT ALL ON TABLE public.v_cash_position_latest TO service_role;


--
-- Name: TABLE v_chargebee_latest_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_chargebee_latest_runs TO anon;
GRANT ALL ON TABLE public.v_chargebee_latest_runs TO authenticated;
GRANT ALL ON TABLE public.v_chargebee_latest_runs TO service_role;


--
-- Name: TABLE v_chargebee_latest_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_chargebee_latest_subscriptions TO anon;
GRANT ALL ON TABLE public.v_chargebee_latest_subscriptions TO authenticated;
GRANT ALL ON TABLE public.v_chargebee_latest_subscriptions TO service_role;


--
-- Name: TABLE v_invoice_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_invoice_status TO authenticated;
GRANT ALL ON TABLE public.v_invoice_status TO service_role;


--
-- Name: TABLE v_pl_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_pl_entries TO authenticated;
GRANT ALL ON TABLE public.v_pl_entries TO service_role;


--
-- Name: TABLE v_processor_latest; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_processor_latest TO anon;
GRANT ALL ON TABLE public.v_processor_latest TO authenticated;
GRANT ALL ON TABLE public.v_processor_latest TO service_role;


--
-- Name: TABLE v_revenue_entry_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_revenue_entry_status TO anon;
GRANT ALL ON TABLE public.v_revenue_entry_status TO authenticated;
GRANT ALL ON TABLE public.v_revenue_entry_status TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--


