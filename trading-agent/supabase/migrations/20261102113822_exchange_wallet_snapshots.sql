-- Bybit DEMO account balance snapshots (play money), written by the bybit-demo function, read by bybit-view.
create table if not exists agent_core.exchange_wallet_snapshots (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  total_equity_usd numeric not null,
  coins jsonb not null default '[]'::jsonb
);
create index if not exists exchange_wallet_snapshots_ts_idx on agent_core.exchange_wallet_snapshots (ts desc);
alter table agent_core.exchange_wallet_snapshots enable row level security;
comment on table agent_core.exchange_wallet_snapshots is 'Bybit DEMO wallet snapshots (simulation account). No policies: only the service role / postgres reads and writes.';
