-- The SEF inbox writes only what changed, and reads each row once.
--
-- The purchase pull asks SEF for the last 45 days every quarter of an hour and
-- hands every invoice to `sef_inbox_upsert`. Until now its `on conflict do
-- update` had no WHERE, so every pass wrote a new version of every invoice it
-- already had -- `last_seen_at` always, the status always, and for a row still
-- to be decided all fifteen header columns including the JSON it came in. The
-- answers were right; the cost was hundreds of unchanged rows rewritten, their
-- indexes updated and their dead versions left to vacuum, 52 times a day.
--
-- A. WRITES. An existing purchase row is now updated only when the update
--    would tell it something (any one of these is enough):
--
--   1. THE STATUS DIFFERS: SEF's status, after the same coalesce as before (a
--      re-read that omits `status` still never blanks it), is distinct from
--      the stored one.
--   2. THE ROW IS STILL TO BE DECIDED AND ITS HEADER DIFFERS: `state` is
--      'pending' and one of the fifteen columns written only while pending is
--      distinct from what SEF sent. `overview_json` is compared as text, so a
--      figure SEF writes as 1.0 one day and 1.00 the next is a change, as the
--      old body (which always wrote it) would have made it.
--   3. IT WAS LAST SEEN MORE THAN A DAY AGO: `last_seen_at` keeps meaning
--      "SEF listed this invoice", to within a day. Nothing reads it for a
--      purchase row today; this keeps the column honest for whoever does.
--
--    A ROW SEF SHOWS UNCHANGED IS NOT WRITTEN, whatever its status, so a
--    trigger on `update of sef_status` fires only when the status really
--    changes (or the row is written for 2 or 3). A client trigger that used to
--    count on being fired again on every pass -- to retry work it failed --
--    must retry on its own schedule instead.
--
--    WHAT AN UPDATE WRITES IS UNCHANGED: the SET list is the old one, except
--    that an unchanged `overview_json` keeps the stored value instead of an
--    equal copy. New invoices are inserted exactly as before.
--
-- B. READS. Every value used to be read with `jsonb_value_ci(r, key)`, which
--    walks all of a row's keys for each value: 24 walks of ~25 keys per
--    purchase row, about four fifths of the pull's time. Now each row's keys
--    are folded to lower case ONCE and the values are read with `->>`:
--
--      jsonb_object_agg(lower(k.key), k.value order by k.ord desc)
--        from jsonb_each(r) with ordinality as k(key, value, ord)
--
--    EXACTLY what jsonb_value_ci returned, including for keys that differ only
--    in case ("Amount" and "amount" in one row): jsonb_value_ci has no ORDER
--    BY, so it returns the FIRST match in jsonb_each order (jsonb's storage
--    order: shorter key first, then bytewise, so upper case before lower);
--    jsonb_object_agg keeps the LAST of duplicate keys; aggregating in REVERSE
--    jsonb_each order makes that last one the first. Without `desc` the other
--    value wins. `->>` returns what `#>> '{}'` did for every JSON type; a row
--    that is not an object fails as before, in jsonb_each. The same fold is
--    applied to `sef_sales_upsert`, which reads only: its writes are exactly
--    as before, `last_seen_at` stamped on every listed row included (the
--    sales ask-again queue orders by it).
--
-- THE COUNTS MEAN WHAT THEY MEANT. `seen` was the number of rows the merge
-- touched, and with no WHERE that was every distinct invoice SEF listed with a
-- usable id. A skipped update is not returned by the merge, so `seen` is now
-- counted from the incoming rows themselves: the same number, still "invoices
-- SEF listed", which is what the run log shows. `inserted` and `skipped` mean
-- what they did; `skipped` is counted from the same folded rows.
--
-- A row whose update is skipped is still locked by `on conflict` for the rest
-- of the pass; it gets no new version, no index entry and no dead tuple.
--
-- `sef_sales_status` (a handful of ids per pass) and `jsonb_value_ci` itself
-- are not changed.
--
-- No client data (NADOGRADNJA rule 2). RE-RUNNABLE: `create or replace` with
-- the same signatures and results; a second application writes the same
-- bodies and the same grants.

begin;

-- ── 0. What this file reads before it writes anything ──────────────────────

do $$
declare
  col text;
begin
  if to_regprocedure('public.sef_inbox_upsert(uuid, jsonb)') is null then
    raise exception 'public.sef_inbox_upsert(uuid, jsonb) is not there, and this file replaces it. Nothing was written -- rolling back';
  end if;
  if pg_get_function_result('public.sef_inbox_upsert(uuid, jsonb)'::regprocedure)
       <> 'TABLE(seen integer, inserted integer, skipped integer)' then
    raise exception 'public.sef_inbox_upsert returns %, not (seen, inserted, skipped). Nothing was written -- rolling back',
      pg_get_function_result('public.sef_inbox_upsert(uuid, jsonb)'::regprocedure);
  end if;
  if to_regprocedure('public.sef_sales_upsert(uuid, jsonb)') is null then
    raise exception 'public.sef_sales_upsert(uuid, jsonb) is not there, and this file replaces it. Nothing was written -- rolling back';
  end if;
  if pg_get_function_result('public.sef_sales_upsert(uuid, jsonb)'::regprocedure)
       <> 'TABLE(seen integer, inserted integer)' then
    raise exception 'public.sef_sales_upsert returns %, not (seen, inserted). Nothing was written -- rolling back',
      pg_get_function_result('public.sef_sales_upsert(uuid, jsonb)'::regprocedure);
  end if;
  foreach col in array array[
    'company_id', 'direction', 'sef_invoice_id', 'state', 'sef_status', 'sef_comment',
    'last_seen_at', 'cir_invoice_id', 'glob_uniq_id', 'document_number', 'document_type',
    'supplier_name', 'supplier_vat_number', 'supplier_registration_number',
    'customer_name', 'customer_vat_number', 'customer_registration_number', 'amount',
    'sum_without_vat', 'vat_amount', 'currency', 'issue_date', 'delivery_date', 'due_date',
    'sent_date', 'overview_json']
  loop
    if not exists (select 1 from pg_attribute
                    where attrelid = 'public.sef_inbox'::regclass and attname = col
                      and attnum > 0 and not attisdropped) then
      raise exception 'public.sef_inbox has no % column, and the merge writes it. Nothing was written -- rolling back', col;
    end if;
  end loop;
  if (select count(*) from pg_index x
        join pg_class c on c.oid = x.indexrelid
       where c.relname = 'sef_inbox_one_row_per_invoice' and x.indisunique
         and x.indnatts = 3) <> 1 then
    raise exception 'sef_inbox_one_row_per_invoice is not unique over (company, direction, id), and the merges conflict on it. Nothing was written -- rolling back';
  end if;
end $$;

-- ── 1. The purchase pull: writes only changes, reads each row once ─────────

create or replace function public.sef_inbox_upsert(
  p_company_id uuid,
  p_rows       jsonb)
returns table (seen int, inserted int, skipped int)
language plpgsql
security definer
set search_path = public
as $$
begin
  with parsed as (
    -- Each element of the array once, its keys folded to lower case (`f`; see
    -- the header for why the order is DESC), and whether it can be keyed.
    select e.r, e.pos, l.f,
           coalesce(l.f ->> 'invoiceid', '') ~ '^-?[0-9]+$' as keyed
      from jsonb_array_elements(p_rows) with ordinality as e(r, pos)
      cross join lateral (
        select jsonb_object_agg(lower(k.key), k.value order by k.ord desc) as f
          from jsonb_each(e.r) with ordinality as k(key, value, ord)) l
  ),
  incoming as (
    -- DISTINCT because one array may carry the same invoice twice — overlapping
    -- pages, or SEF simply repeating a row — and `on conflict do update` refuses
    -- to touch one row twice in a statement, taking the whole batch with it.
    -- Of the duplicates the LATER one in the array wins: `pos` is its place in
    -- the array, and it orders the DISTINCT ON. `pos` is not written anywhere.
    select distinct on (sef_invoice_id)
      sef_invoice_id, cir_invoice_id, glob_uniq_id, document_number, document_type,
      supplier_name, supplier_vat_number, supplier_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      delivery_date, due_date, sent_date, sef_status, overview_json,
      -- Carried out of the subquery only so `distinct on` can order by it:
      -- the later array position wins when one response repeats an invoice.
      -- NOT inserted — the insert below names its columns.
      pos
      from (
      select
        (f ->> 'invoiceid')::bigint                                    as sef_invoice_id,
        f ->> 'cirinvoiceid'                                           as cir_invoice_id,
        f ->> 'globuniqid'                                             as glob_uniq_id,
        f ->> 'documentnumber'                                         as document_number,
        f ->> 'documenttype'                                           as document_type,
        f ->> 'suppliername'                                           as supplier_name,
        f ->> 'suppliervatregistrationnumber'                          as supplier_vat_number,
        f ->> 'supplierregistrationnumber'                             as supplier_registration_number,
        -- Guarded rather than cast outright. A figure this cannot read becomes
        -- null and the row still lands; cast outright it would abort the batch.
        case when btrim(f ->> 'amount') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(f ->> 'amount')::numeric end                   as amount,
        case when btrim(f ->> 'sumwithoutvat') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(f ->> 'sumwithoutvat')::numeric end            as sum_without_vat,
        case when btrim(f ->> 'vatamount') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(f ->> 'vatamount')::numeric end                as vat_amount,
        f ->> 'currency'                                               as currency,
        -- Belgrade, not the session's zone. These are Serbian invoices, and
        -- `timestamptz::date` under a negative-offset session files a midnight
        -- timestamp on the previous day.
        -- ASSUMES SEF sends an offset. An offset-less timestamp is read in the
        -- session's zone — UTC on Supabase — and a late-evening one would then
        -- roll to the next Belgrade day. To be confirmed against a real
        -- response before this is trusted for a month boundary.
        case when f ->> 'deliverydate' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((f ->> 'deliverydate')::timestamptz at time zone 'Europe/Belgrade')::date end as delivery_date,
        case when f ->> 'duedate' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((f ->> 'duedate')::timestamptz at time zone 'Europe/Belgrade')::date end      as due_date,
        case when f ->> 'sentdate' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then (f ->> 'sentdate')::timestamptz end                  as sent_date,
        f ->> 'status'                                                 as sef_status,
        r                                                              as overview_json,
        pos
        from parsed
       -- A row with no usable id cannot be keyed at all. Skipped rather than
       -- allowed to kill the pass — and COUNTED, below, so a skip is reported
       -- and not silent.
       where keyed
    ) q
    order by sef_invoice_id, pos desc
  ),
  merged as (
    insert into public.sef_inbox as t (
      company_id, direction, sef_invoice_id, cir_invoice_id, glob_uniq_id,
      document_number, document_type, supplier_name,
      supplier_vat_number, supplier_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      delivery_date, due_date, sent_date, sef_status, overview_json)
    select
      p_company_id, 'purchase', i.sef_invoice_id, i.cir_invoice_id, i.glob_uniq_id,
      i.document_number, i.document_type, i.supplier_name,
      i.supplier_vat_number, i.supplier_registration_number,
      i.amount, i.sum_without_vat, i.vat_amount, i.currency,
      i.delivery_date, i.due_date, i.sent_date, i.sef_status, i.overview_json
      from incoming i
    on conflict (company_id, direction, sef_invoice_id) do update set
      -- ALWAYS, whatever the owner has decided. A re-read that omits `status`
      -- must not blank the one signal this column exists to carry.
      sef_status   = coalesce(excluded.sef_status, t.sef_status),
      last_seen_at = now(),
      -- ONLY while the row is still his to decide. `t.state` is the row as it
      -- stands; writing these unconditionally would overwrite the figures a
      -- booked invoice was booked from.
      cir_invoice_id               = case when t.state = 'pending' then excluded.cir_invoice_id               else t.cir_invoice_id               end,
      glob_uniq_id                 = case when t.state = 'pending' then excluded.glob_uniq_id                 else t.glob_uniq_id                 end,
      document_number              = case when t.state = 'pending' then excluded.document_number              else t.document_number              end,
      document_type                = case when t.state = 'pending' then excluded.document_type                else t.document_type                end,
      supplier_name                = case when t.state = 'pending' then excluded.supplier_name                else t.supplier_name                end,
      supplier_vat_number          = case when t.state = 'pending' then excluded.supplier_vat_number          else t.supplier_vat_number          end,
      supplier_registration_number = case when t.state = 'pending' then excluded.supplier_registration_number else t.supplier_registration_number end,
      amount                       = case when t.state = 'pending' then excluded.amount                       else t.amount                       end,
      sum_without_vat              = case when t.state = 'pending' then excluded.sum_without_vat              else t.sum_without_vat              end,
      vat_amount                   = case when t.state = 'pending' then excluded.vat_amount                   else t.vat_amount                   end,
      currency                     = case when t.state = 'pending' then excluded.currency                     else t.currency                     end,
      delivery_date                = case when t.state = 'pending' then excluded.delivery_date                else t.delivery_date                end,
      due_date                     = case when t.state = 'pending' then excluded.due_date                     else t.due_date                     end,
      sent_date                    = case when t.state = 'pending' then excluded.sent_date                    else t.sent_date                    end,
      -- The same value as before; an unchanged one is kept rather than copied.
      overview_json                = case when t.state = 'pending'
                                           and excluded.overview_json::text is distinct from t.overview_json::text
                                          then excluded.overview_json else t.overview_json end
    -- ONLY WHEN IT TELLS THE ROW SOMETHING (the header lists the three reasons).
    where
      -- 1. The status differs.
      coalesce(excluded.sef_status, t.sef_status) is distinct from t.sef_status
      -- 2. Still to be decided, and the header differs.
      or (t.state = 'pending' and (
               excluded.cir_invoice_id               is distinct from t.cir_invoice_id
            or excluded.glob_uniq_id                 is distinct from t.glob_uniq_id
            or excluded.document_number              is distinct from t.document_number
            or excluded.document_type                is distinct from t.document_type
            or excluded.supplier_name                is distinct from t.supplier_name
            or excluded.supplier_vat_number          is distinct from t.supplier_vat_number
            or excluded.supplier_registration_number is distinct from t.supplier_registration_number
            or excluded.amount                       is distinct from t.amount
            or excluded.sum_without_vat              is distinct from t.sum_without_vat
            or excluded.vat_amount                   is distinct from t.vat_amount
            or excluded.currency                     is distinct from t.currency
            or excluded.delivery_date                is distinct from t.delivery_date
            or excluded.due_date                     is distinct from t.due_date
            or excluded.sent_date                    is distinct from t.sent_date
            or excluded.overview_json::text          is distinct from t.overview_json::text))
      -- 3. Last seen more than a day ago.
      or t.last_seen_at < now() - interval '1 day'
    returning (xmax = 0) as was_insert
  )
  -- Reported, not swallowed: `skipped` counts the rows that could not be
  -- keyed. `seen` is every distinct invoice SEF listed with a usable id --
  -- what the old body's merge returned, now that a skipped update returns
  -- nothing.
  select (select count(*)::int from parsed where not keyed),
         (select count(*)::int from incoming),
         count(*) filter (where was_insert)::int
    into skipped, seen, inserted
    from merged;

  return next;
end $$;

revoke all on function public.sef_inbox_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_inbox_upsert(uuid, jsonb) to service_role;

-- ── 2. The sales pull: the body from 20261104090000, reading each row once ──
--
-- Only the reading changes. What it inserts, what it updates and when -- every
-- listed row, `last_seen_at` included -- is exactly as before.

create or replace function public.sef_sales_upsert(
  p_company_id uuid,
  p_rows       jsonb)
returns table (seen int, inserted int)
language plpgsql
security definer
set search_path = public
as $$
begin
  with incoming as (
    -- DISTINCT for the same reason as the purchase side: one array may carry
    -- an invoice twice and `on conflict do update` refuses to touch a row twice
    -- in one statement. The later position wins.
    select distinct on (sef_invoice_id)
      sef_invoice_id, status, comment, cir_invoice_id, glob_uniq_id,
      document_number, document_type, customer_name, customer_vat_number,
      customer_registration_number, amount, sum_without_vat, vat_amount,
      currency, issue_date, delivery_date, due_date, overview_json, pos
      from (
      select
        (f ->> 'sefinvoiceid')::bigint                                 as sef_invoice_id,
        f ->> 'status'                                                 as status,
        f ->> 'comment'                                                as comment,
        f ->> 'cirinvoiceid'                                           as cir_invoice_id,
        f ->> 'globuniqid'                                             as glob_uniq_id,
        f ->> 'documentnumber'                                         as document_number,
        f ->> 'documenttype'                                           as document_type,
        f ->> 'customername'                                           as customer_name,
        f ->> 'customervatnumber'                                      as customer_vat_number,
        f ->> 'customerregistrationnumber'                             as customer_registration_number,
        case when btrim(f ->> 'amount') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(f ->> 'amount')::numeric end                   as amount,
        case when btrim(f ->> 'sumwithoutvat') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(f ->> 'sumwithoutvat')::numeric end            as sum_without_vat,
        case when btrim(f ->> 'vatamount') ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(f ->> 'vatamount')::numeric end                as vat_amount,
        f ->> 'currency'                                               as currency,
        case when f ->> 'issuedate' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((f ->> 'issuedate')::timestamptz at time zone 'Europe/Belgrade')::date end    as issue_date,
        case when f ->> 'deliverydate' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((f ->> 'deliverydate')::timestamptz at time zone 'Europe/Belgrade')::date end as delivery_date,
        case when f ->> 'duedate' ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((f ->> 'duedate')::timestamptz at time zone 'Europe/Belgrade')::date end      as due_date,
        e.r                                                            as overview_json,
        e.pos                                                          as pos
        from jsonb_array_elements(p_rows) with ordinality as e(r, pos)
        -- The keys folded once; DESC as on the purchase side (see the header).
        cross join lateral (
          select jsonb_object_agg(lower(k.key), k.value order by k.ord desc) as f
            from jsonb_each(e.r) with ordinality as k(key, value, ord)) l
       where f ->> 'sefinvoiceid' ~ '^-?[0-9]+$'
    ) q
    order by sef_invoice_id, pos desc
  ),
  merged as (
    insert into public.sef_inbox as t (
      company_id, direction, sef_invoice_id, cir_invoice_id, glob_uniq_id,
      document_number, document_type, customer_name,
      customer_vat_number, customer_registration_number,
      amount, sum_without_vat, vat_amount, currency,
      issue_date, delivery_date, due_date, sent_date, sef_status, sef_comment,
      overview_json)
    select
      p_company_id, 'sales', i.sef_invoice_id, i.cir_invoice_id, i.glob_uniq_id,
      i.document_number, i.document_type, i.customer_name,
      i.customer_vat_number, i.customer_registration_number,
      i.amount, i.sum_without_vat, i.vat_amount, i.currency,
      i.issue_date, i.delivery_date, i.due_date,
      -- The window runs on `sent_date`; for an issued invoice that is the issue
      -- date, at midnight in Belgrade.
      case when i.issue_date is not null
           then i.issue_date::timestamp at time zone 'Europe/Belgrade' end,
      i.status, i.comment, i.overview_json
      from incoming i
    on conflict (company_id, direction, sef_invoice_id) do update set
      -- ALWAYS, whatever has been decided: the status is what SEF says now.
      sef_status   = coalesce(excluded.sef_status, t.sef_status),
      sef_comment  = coalesce(excluded.sef_comment, t.sef_comment),
      last_seen_at = now(),
      -- The header only while the row is still to be decided.
      cir_invoice_id               = case when t.state = 'pending' then excluded.cir_invoice_id               else t.cir_invoice_id               end,
      glob_uniq_id                 = case when t.state = 'pending' then excluded.glob_uniq_id                 else t.glob_uniq_id                 end,
      document_number              = case when t.state = 'pending' then excluded.document_number              else t.document_number              end,
      document_type                = case when t.state = 'pending' then excluded.document_type                else t.document_type                end,
      customer_name                = case when t.state = 'pending' then excluded.customer_name                else t.customer_name                end,
      customer_vat_number          = case when t.state = 'pending' then excluded.customer_vat_number          else t.customer_vat_number          end,
      customer_registration_number = case when t.state = 'pending' then excluded.customer_registration_number else t.customer_registration_number end,
      amount                       = case when t.state = 'pending' then excluded.amount                       else t.amount                       end,
      sum_without_vat              = case when t.state = 'pending' then excluded.sum_without_vat              else t.sum_without_vat              end,
      vat_amount                   = case when t.state = 'pending' then excluded.vat_amount                   else t.vat_amount                   end,
      currency                     = case when t.state = 'pending' then excluded.currency                     else t.currency                     end,
      issue_date                   = case when t.state = 'pending' then excluded.issue_date                   else t.issue_date                   end,
      delivery_date                = case when t.state = 'pending' then excluded.delivery_date                else t.delivery_date                end,
      due_date                     = case when t.state = 'pending' then excluded.due_date                     else t.due_date                     end,
      sent_date                    = case when t.state = 'pending' then excluded.sent_date                    else t.sent_date                    end,
      overview_json                = case when t.state = 'pending' then excluded.overview_json                else t.overview_json                end
    returning (xmax = 0) as was_insert
  )
  select count(*)::int, count(*) filter (where was_insert)::int
    into seen, inserted
    from merged;

  return next;
end $$;

revoke all on function public.sef_sales_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_sales_upsert(uuid, jsonb) to service_role;

-- ── 3. Checks ──────────────────────────────────────────────────────────────

do $$
declare
  f regprocedure;
  want text;
begin
  foreach f in array array['public.sef_inbox_upsert(uuid, jsonb)'::regprocedure,
                           'public.sef_sales_upsert(uuid, jsonb)'::regprocedure]
  loop
    if not (select prosecdef from pg_proc where oid = f) then
      raise exception '% is no longer SECURITY DEFINER -- rolling back', f;
    end if;
    if (select proconfig from pg_proc where oid = f) is distinct from array['search_path=public'] then
      raise exception '% does not pin search_path to public: % -- rolling back', f,
        coalesce(array_to_string((select proconfig from pg_proc where oid = f), ','), '[unset]');
    end if;
    want := case when f = 'public.sef_inbox_upsert(uuid, jsonb)'::regprocedure
                 then 'TABLE(seen integer, inserted integer, skipped integer)'
                 else 'TABLE(seen integer, inserted integer)' end;
    if pg_get_function_result(f) <> want then
      raise exception '% now returns % -- rolling back', f, pg_get_function_result(f);
    end if;
    if has_function_privilege('anon', f, 'execute')
       or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is callable by anon or a signed-in account -- rolling back', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then
      raise exception 'the service role cannot call % -- rolling back', f;
    end if;
    -- The fold must keep the FIRST of keys that differ only in case.
    if (select prosrc from pg_proc where oid = f) not like '%order by k.ord desc%' then
      raise exception '% folds keys without `order by k.ord desc`, and would read the other of two keys that differ only in case -- rolling back', f;
    end if;
  end loop;
end $$;

commit;
