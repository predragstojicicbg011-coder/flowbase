-- The SEF inbox writes only what changed.
--
-- The purchase pull asks SEF for the last 45 days every quarter of an hour and
-- hands every invoice to `sef_inbox_upsert`. Until now its `on conflict do
-- update` had no WHERE, so every pass wrote a new version of every invoice it
-- already had -- `last_seen_at` always, the status always, and for a row still
-- to be decided all fifteen header columns including the JSON it came in. The
-- answers were right; the cost was hundreds of unchanged rows rewritten, their
-- indexes updated and their dead versions left to vacuum, 52 times a day.
--
-- Now an existing row is updated only when the update would tell it something
-- (any one of these is enough):
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
--   4. SEF SHOWS A DECISION THE APP DID NOT MAKE: the status is Approved,
--      Rejected, Cancelled or Storno and `sef_decision` is null. A client's
--      trigger may follow exactly that (`after update of sef_status ... when`
--      those statuses and `sef_decision is null`), and such a trigger is free
--      to rely on being fired again on the next pass -- one that catches its
--      own failure and leaves the work for the next pull does. A row that
--      matches is therefore written every pass, as before. Expressed in
--      sef_inbox columns only, so it says nothing about any client's tables.
--
-- WHAT AN UPDATE WRITES IS UNCHANGED: the SET list is the old one, except that
-- an unchanged `overview_json` keeps the stored value instead of an equal copy
-- (same text, so nobody can tell -- but the JSON is not written out again).
-- New invoices are inserted exactly as before.
--
-- THE COUNTS MEAN WHAT THEY MEANT. `seen` was the number of rows the merge
-- touched, and with no WHERE that was every distinct invoice SEF listed with a
-- usable id. A skipped update is not returned by the merge, so `seen` is now
-- counted from the incoming rows themselves: the same number, still "invoices
-- SEF listed", which is what the run log shows. `inserted` and `skipped` are
-- computed as before.
--
-- A row whose update is skipped is still locked by `on conflict` for the rest
-- of the pass; it gets no new version, no index entry and no dead tuple.
--
-- The sales pull (`sef_sales_upsert`, `sef_sales_status`) is NOT changed: its
-- ask-again queue orders the rows SEF stopped listing by `last_seen_at`, and a
-- stamp that lags by up to a day would reorder that queue.
--
-- No client data (NADOGRADNJA rule 2). RE-RUNNABLE: `create or replace` with
-- the same signature and result; a second application writes the same body
-- and the same grants.

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
  if to_regprocedure('public.jsonb_value_ci(jsonb, text)') is null then
    raise exception 'public.jsonb_value_ci(jsonb, text) is not there, and the merge reads every key through it. Nothing was written -- rolling back';
  end if;
  foreach col in array array[
    'company_id', 'direction', 'sef_invoice_id', 'state', 'sef_status', 'sef_decision',
    'last_seen_at', 'cir_invoice_id', 'glob_uniq_id', 'document_number', 'document_type',
    'supplier_name', 'supplier_vat_number', 'supplier_registration_number', 'amount',
    'sum_without_vat', 'vat_amount', 'currency', 'delivery_date', 'due_date', 'sent_date',
    'overview_json']
  loop
    if not exists (select 1 from pg_attribute
                    where attrelid = 'public.sef_inbox'::regclass and attname = col
                      and attnum > 0 and not attisdropped) then
      raise exception 'public.sef_inbox has no % column, and the merge compares it. Nothing was written -- rolling back', col;
    end if;
  end loop;
  if (select count(*) from pg_index x
        join pg_class c on c.oid = x.indexrelid
       where c.relname = 'sef_inbox_one_row_per_invoice' and x.indisunique
         and x.indnatts = 3) <> 1 then
    raise exception 'sef_inbox_one_row_per_invoice is not unique over (company, direction, id), and the merge conflicts on it. Nothing was written -- rolling back';
  end if;
end $$;

-- ── 1. The purchase pull: the body from 20261104090000, writing only changes ──

create or replace function public.sef_inbox_upsert(
  p_company_id uuid,
  p_rows       jsonb)
returns table (seen int, inserted int, skipped int)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Reported, not swallowed. A pass that quietly drops rows is a queue that is
  -- short by an unknown amount, which is worse than one that is short and says so.
  select count(*)::int into skipped
    from jsonb_array_elements(p_rows) r
   where coalesce(public.jsonb_value_ci(r, 'invoiceId'), '') !~ '^-?[0-9]+$';

  with incoming as (
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
        (public.jsonb_value_ci(r, 'invoiceId'))::bigint                      as sef_invoice_id,
        public.jsonb_value_ci(r, 'cirInvoiceId')                             as cir_invoice_id,
        public.jsonb_value_ci(r, 'globUniqId')                               as glob_uniq_id,
        public.jsonb_value_ci(r, 'documentNumber')                           as document_number,
        public.jsonb_value_ci(r, 'documentType')                             as document_type,
        public.jsonb_value_ci(r, 'supplierName')                             as supplier_name,
        public.jsonb_value_ci(r, 'supplierVatRegistrationNumber')            as supplier_vat_number,
        public.jsonb_value_ci(r, 'supplierRegistrationNumber')               as supplier_registration_number,
        -- Guarded rather than cast outright. A figure this cannot read becomes
        -- null and the row still lands; cast outright it would abort the batch.
        case when btrim(public.jsonb_value_ci(r, 'amount')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'amount'))::numeric end          as amount,
        case when btrim(public.jsonb_value_ci(r, 'sumWithoutVat')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'sumWithoutVat'))::numeric end   as sum_without_vat,
        case when btrim(public.jsonb_value_ci(r, 'vatAmount')) ~ '^[-+]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$'
             then btrim(public.jsonb_value_ci(r, 'vatAmount'))::numeric end       as vat_amount,
        public.jsonb_value_ci(r, 'currency')                                 as currency,
        -- Belgrade, not the session's zone. These are Serbian invoices, and
        -- `timestamptz::date` under a negative-offset session files a midnight
        -- timestamp on the previous day.
        -- ASSUMES SEF sends an offset. An offset-less timestamp is read in the
        -- session's zone — UTC on Supabase — and a late-evening one would then
        -- roll to the next Belgrade day. To be confirmed against a real
        -- response before this is trusted for a month boundary.
        case when public.jsonb_value_ci(r, 'deliveryDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'deliveryDate'))::timestamptz at time zone 'Europe/Belgrade')::date end as delivery_date,
        case when public.jsonb_value_ci(r, 'dueDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then ((public.jsonb_value_ci(r, 'dueDate'))::timestamptz at time zone 'Europe/Belgrade')::date end      as due_date,
        case when public.jsonb_value_ci(r, 'sentDate') ~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?)?$'
             then (public.jsonb_value_ci(r, 'sentDate'))::timestamptz end    as sent_date,
        public.jsonb_value_ci(r, 'status')                                   as sef_status,
        r                                                as overview_json,
        e.pos                                            as pos
        from jsonb_array_elements(p_rows) with ordinality as e(r, pos)
       -- A row with no usable id cannot be keyed at all. Skipped rather than
       -- allowed to kill the pass — and COUNTED, above, so a skip is reported
       -- and not silent.
       where public.jsonb_value_ci(r, 'invoiceId') ~ '^-?[0-9]+$'
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
      -- The same value as before; an unchanged one is kept rather than copied,
      -- so a row updated for its status does not write its JSON out again.
      overview_json                = case when t.state = 'pending'
                                           and excluded.overview_json::text is distinct from t.overview_json::text
                                          then excluded.overview_json else t.overview_json end
    -- ONLY WHEN IT TELLS THE ROW SOMETHING (the header lists the four reasons).
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
      -- 4. A decision on SEF that the app did not make: written every pass, so
      --    a trigger following it fires every pass, as it always has.
      or (t.sef_decision is null
          and lower(btrim(coalesce(excluded.sef_status, t.sef_status, '')))
                in ('approved', 'rejected', 'cancelled', 'storno'))
    returning (xmax = 0) as was_insert
  )
  -- `seen` is every distinct invoice SEF listed with a usable id -- what the
  -- old body's merge returned, now that a skipped update returns nothing.
  select (select count(*)::int from incoming), count(*) filter (where was_insert)::int
    into seen, inserted
    from merged;

  return next;
end $$;

revoke all on function public.sef_inbox_upsert(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sef_inbox_upsert(uuid, jsonb) to service_role;

-- ── 2. Checks ──────────────────────────────────────────────────────────────

do $$
declare
  f regprocedure := 'public.sef_inbox_upsert(uuid, jsonb)'::regprocedure;
begin
  if not (select prosecdef from pg_proc where oid = f) then
    raise exception 'public.sef_inbox_upsert is no longer SECURITY DEFINER -- rolling back';
  end if;
  if (select proconfig from pg_proc where oid = f) is distinct from array['search_path=public'] then
    raise exception 'public.sef_inbox_upsert does not pin search_path to public: % -- rolling back',
      coalesce(array_to_string((select proconfig from pg_proc where oid = f), ','), '[unset]');
  end if;
  if pg_get_function_result(f) <> 'TABLE(seen integer, inserted integer, skipped integer)' then
    raise exception 'public.sef_inbox_upsert now returns % -- rolling back', pg_get_function_result(f);
  end if;
  if has_function_privilege('anon', f, 'execute')
     or has_function_privilege('authenticated', f, 'execute') then
    raise exception 'public.sef_inbox_upsert is callable by anon or a signed-in account -- rolling back';
  end if;
  if not has_function_privilege('service_role', f, 'execute') then
    raise exception 'the service role cannot call public.sef_inbox_upsert -- rolling back';
  end if;
end $$;

commit;
