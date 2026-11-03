-- Crypto probe every minute (matches the 60 s cadence); other markets every 5 minutes to stay gentle on unofficial free endpoints.
select cron.schedule('probe_crypto', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/probe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')
    ),
    body := '{"group":"crypto"}'::jsonb,
    timeout_milliseconds := 15000
  );
$job$);

select cron.schedule('probe_others', '*/5 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/probe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')
    ),
    body := '{"group":"others"}'::jsonb,
    timeout_milliseconds := 20000
  );
$job$);

-- Keep the free-tier database small: drop probe logs older than 3 days.
select cron.schedule('retention_source_checks', '17 3 * * *', $job$
  delete from trading_sim.source_checks where checked_at < now() - interval '3 days';
$job$);
