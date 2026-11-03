-- Reads public news feeds every 10 minutes (about 4,300 function calls per month, far below the free limit).
select cron.schedule('news_scan', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/news-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 40000
  );
$job$);
