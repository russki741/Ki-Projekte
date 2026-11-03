-- trend-tick every 5 minutes, offset by 2 minutes so the daily bar (closes 00:00 UTC) is final at Bybit before the first decision.
select cron.unschedule(jobid) from cron.job where jobname = 'trend_tick';
select cron.schedule('trend_tick', '2-59/5 * * * *', $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/trend-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$cmd$);
