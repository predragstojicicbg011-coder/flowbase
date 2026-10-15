-- A job that has not been set up says so once, not every quarter of an hour.
--
-- `run_processor_sync` records every tick in `scheduled_job_runs`, which is
-- the right thing when a job RUNS: that table is the first place to look when
-- something scheduled goes quiet. It is the wrong thing while a job is simply
-- not configured yet -- a client who has not got a SEF account, or a key not
-- yet pasted in. Four ticks an hour through the working day left close to
-- fifty rows a day all saying the same thing, and the rows that mean
-- something were underneath them.
--
-- So the unconfigured note is written when it CHANGES. One row says the job
-- is waiting, and the next row appears the moment anything is different --
-- including the moment somebody finishes setting it up.
--
-- Everything else about the function is unchanged. `20261015090000` is not
-- edited: a database has applied it already, and rule 5 of
-- docs/NADOGRADNJA.md keeps an applied migration as it was.

begin;

create or replace function public.run_processor_sync(
  p_function text,
  force      boolean default false,
  p_body     jsonb   default '{}'::jsonb
) returns text
language plpgsql security definer
set search_path to public, extensions, net
as $fn$
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

  select value into base_url from public.job_config where key = 'functions_base_url';
  select value into fn_key   from public.job_config where key = 'service_role_key';

  if base_url is null or fn_key is null then
    outcome := p_function || ': job_config has no functions_base_url and/or '
             || 'service_role_key — nothing was called';
    -- Written when the answer CHANGES, not on every tick. A job nobody has
    -- set up yet is a state, not an event: at four ticks an hour through the
    -- working day it left nearly fifty identical rows a day, and the rows
    -- that mean something sat underneath them. One row says it, and the next
    -- row appears the moment anything is different -- including the moment it
    -- starts working.
    if (select note from public.scheduled_job_runs
         where job = p_function
         order by fired_at desc, id desc
         limit 1) is distinct from outcome then
      insert into public.scheduled_job_runs (job, belgrade_at, belgrade_hour, would_run, note)
      values (p_function, now() at time zone 'Europe/Belgrade', hour_now, true, outcome);
    end if;
    return outcome;
  end if;

  select net.http_post(
    url     := rtrim(base_url, '/') || '/' || p_function,
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
$fn$;

revoke all on function public.run_processor_sync(text, boolean, jsonb) from public, anon;

-- ── Checks ────────────────────────────────────────────────────────────────
--
-- Only where the job is in fact unconfigured, which is the state this is
-- about. On a database that is set up, calling the function would post an
-- HTTP request, which a migration has no business doing.

do $$
declare
  before_id bigint;
  rows_left int;
begin
  if exists (select 1 from public.job_config where key = 'functions_base_url')
     and exists (select 1 from public.job_config where key = 'service_role_key') then
    raise notice 'the job is configured here, so the quiet path was not exercised';
    return;
  end if;

  select coalesce(max(id), 0) into before_id from public.scheduled_job_runs;

  perform public.run_processor_sync('check-quiet-job', true);
  perform public.run_processor_sync('check-quiet-job', true);
  perform public.run_processor_sync('check-quiet-job', true);

  select count(*) into rows_left from public.scheduled_job_runs
   where id > before_id and job = 'check-quiet-job';

  if rows_left <> 1 then
    raise exception 'three ticks of an unconfigured job left % rows, not 1', rows_left;
  end if;

  -- Said once, and still said: a job that leaves no trace at all cannot be
  -- told from one nobody ever scheduled.
  if (select note from public.scheduled_job_runs
       where id > before_id and job = 'check-quiet-job') not like '%nothing was called%' then
    raise exception 'the one row does not say why nothing was called';
  end if;

  delete from public.scheduled_job_runs where id > before_id and job = 'check-quiet-job';
end $$;

commit;
