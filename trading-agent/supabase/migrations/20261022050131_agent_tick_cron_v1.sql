-- Runs the paper-trading engine once per minute. While settings.kill_switch is true (default) it only collects data
-- (closed 1m candles, data status) and closes nothing new / opens nothing. No real orders exist anywhere in this system.
select cron.schedule('agent_tick', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/agent-tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 50000
  );
$job$);
