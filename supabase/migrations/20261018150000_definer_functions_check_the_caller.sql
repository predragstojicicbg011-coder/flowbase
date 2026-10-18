-- Every function that runs with its owner's rights checks who is calling.
--
-- A SECURITY DEFINER function skips row level security, so the function body
-- is the only thing that stands between a caller and the tables. Until now
-- every signed-in account was a member of the company, and four such
-- functions trusted that. A client may now have signed-in accounts that are
-- NOT members (MCFlow's approval app is the first), so each of the four now
-- decides for itself:
--
--   * sef_inbox_mark_imported  only the roles that book (can_write_books).
--   * sef_pull_window          members only. It only returns two dates, but
--                              it reads job_config, which nobody else may see.
--   * claim_processor_sync     the scheduled job's own bookkeeping. Only the
--   * run_processor_sync       service role (the edge functions) and the
--                              database owner (cron) call these, so the
--                              signed-in role loses EXECUTE altogether.
--
-- Found by listing every SECURITY DEFINER function that `authenticated` may
-- execute and reading each body (2026-10-18). delete_transaction_cascade was
-- on the list but is safe: its first step is soft_delete_row, which refuses
-- anyone but an administrator or owner.

begin;

create or replace function public.sef_inbox_mark_imported(p_id uuid, p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.can_write_books() then
    raise exception 'Samo finansijski tim može da označi SEF fakturu kao proknjiženu.'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.invoices
                  where id = p_invoice_id and deleted_at is null) then
    raise exception 'There is no live invoice % to mark this row against.', p_invoice_id;
  end if;
  update public.sef_inbox
     set state = 'imported',
         imported_invoice_id = p_invoice_id,
         imported_at = now()
   where id = p_id
     and state = 'pending'
     and imported_invoice_id is null;
  if not found then
    raise exception
      'That row is not waiting to be booked — it is already decided, or already linked to an invoice.';
  end if;
end
$$;

-- sef_pull_window: the body from 20261015100000 with a guard in front. The
-- edge function calls it as the service role, where auth.uid() is null, so
-- the guard lets the service role through and stops a signed-in non-member.
create or replace function public.sef_pull_window(p_from date default null, p_to date default null)
returns table (date_from date, date_to date)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  floor_date date;
  today_bg   date;
begin
  if auth.uid() is not null and not public.is_member() then
    raise exception 'Samo članovi firme vide podešavanje SEF povlačenja.'
      using errcode = 'insufficient_privilege';
  end if;

  select value::date into floor_date
    from public.job_config where key = 'sef_pull_from';

  today_bg := (timezone('Europe/Belgrade', now()))::date;

  if p_from is not null and p_to is not null then
    date_from := greatest(p_from, coalesce(floor_date, p_from));
    date_to   := p_to;
  else
    date_from := greatest(today_bg - 45, coalesce(floor_date, today_bg - 45));
    date_to   := today_bg;
  end if;

  return next;
end
$$;

revoke execute on function public.claim_processor_sync(date, text, text, interval) from authenticated, anon, public;
revoke execute on function public.run_processor_sync(text, boolean, jsonb)         from authenticated, anon, public;
grant  execute on function public.claim_processor_sync(date, text, text, interval) to service_role;
grant  execute on function public.run_processor_sync(text, boolean, jsonb)         to service_role;

-- ── Checks ────────────────────────────────────────────────────────────────

do $$
begin
  if has_function_privilege('authenticated', 'public.run_processor_sync(text, boolean, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_processor_sync(date, text, text, interval)', 'execute') then
    raise exception 'the scheduled-job functions are still callable by signed-in users';
  end if;
  if (select prosrc from pg_proc where proname = 'sef_inbox_mark_imported'
        and pronamespace = 'public'::regnamespace) !~ 'can_write_books' then
    raise exception 'sef_inbox_mark_imported does not check the caller';
  end if;
  if (select prosrc from pg_proc where proname = 'sef_pull_window'
        and pronamespace = 'public'::regnamespace) !~ 'is_member' then
    raise exception 'sef_pull_window does not check the caller';
  end if;
end $$;

commit;
