-- The sales pull runs seven minutes after the purchase pull, not in the same
-- second: both use one SEF key, and SEF answers 429 above about three requests
-- a second. `cron.schedule` with an existing name replaces that job. Only where
-- pg_cron is installed and the sales job exists; elsewhere this does nothing.

do $$
begin
  if to_regclass('cron.job') is not null
     and exists (select 1 from cron.job where jobname = 'sef-pull-sales-quarter-hourly') then
    perform cron.schedule(
      'sef-pull-sales-quarter-hourly',
      '7-59/15 5-17 * * *',
      $job$ select public.run_processor_sync('sef-pull-sales', true) $job$
    );
  end if;
end $$;
