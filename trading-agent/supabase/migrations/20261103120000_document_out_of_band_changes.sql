-- DOCUMENTATION ONLY. These objects already exist in production; they were created outside the migration history.
-- This file is NOT in supabase_migrations.schema_migrations. Every statement is idempotent, so running it on a fresh
-- project recreates the same state, and running it on production changes nothing.

-- 1) Result store of the strategy lab (created by hand when the strategy-lab function was introduced).
create table if not exists agent_core.lab_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  tf integer not null,
  split_at timestamptz,
  note text,
  result jsonb not null
);
alter table agent_core.lab_runs enable row level security;
revoke all on agent_core.lab_runs from anon, authenticated;

-- 2) Bybit DEMO mirror: reconcile every 30 seconds (pg_cron sub-minute schedule).
--    cron.schedule with an existing job name replaces that job, so this is safe to re-run.
select cron.schedule('bybit_reconcile', '30 seconds', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/bybit-demo',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-agent-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret')),
    body := '{"action":"reconcile"}'::jsonb,
    timeout_milliseconds := 55000
  );
$job$);
-- Note: production currently has the project URL written literally in this job instead of the Vault lookup above.
-- Both resolve to the same URL.
