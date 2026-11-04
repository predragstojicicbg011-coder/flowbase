-- The sales pull is scheduled seven minutes after the purchase pull.
do $$
begin
  if to_regclass('cron.job') is not null
     and exists (select 1 from cron.job where jobname = 'sef-pull-sales-quarter-hourly') then
    assert (select schedule from cron.job where jobname = 'sef-pull-sales-quarter-hourly') = '7-59/15 5-17 * * *',
      'the sales pull is not seven minutes after the purchase pull';
    assert (select command from cron.job where jobname = 'sef-pull-sales-quarter-hourly') like '%''sef-pull-sales'', true%',
      'the sales job lost its command';
    assert (select count(*) from cron.job where jobname = 'sef-pull-sales-quarter-hourly') = 1, 'the job was duplicated';
    if exists (select 1 from cron.job where jobname = 'sef-pull-quarter-hourly') then
      assert (select schedule from cron.job where jobname = 'sef-pull-quarter-hourly') <> '7-59/15 5-17 * * *',
        'both pulls run at the same time';
    end if;
  end if;
  raise notice 'ALL TESTS PASSED';
end $$;
