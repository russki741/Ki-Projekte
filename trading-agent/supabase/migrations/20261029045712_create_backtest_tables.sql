-- Backtest research tables (simulation only). Additive: no existing table is touched.
create table if not exists agent_core.hist_candles (
  symbol text not null,
  open_time timestamptz not null,
  o float8 not null, h float8 not null, l float8 not null, c float8 not null,
  v float8 not null default 0,
  primary key (symbol, open_time)
);
create table if not exists agent_core.bt_trades (
  id bigint generated always as identity primary key,
  run_id text not null,
  symbol text not null,
  side text not null,
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  entry_price float8, exit_price float8, qty float8,
  quality int,
  reason text,
  gross_usd float8, fees_usd float8, net_usd float8, r float8, risk_usd float8
);
create index if not exists bt_trades_run_idx on agent_core.bt_trades (run_id, symbol, entry_time);
alter table agent_core.hist_candles enable row level security;
alter table agent_core.bt_trades enable row level security;
comment on table agent_core.hist_candles is 'Stored Bybit public 1m history for backtests (simulation only).';
comment on table agent_core.bt_trades is 'Simulated trades of backtest runs, one row per trade, grouped by run_id.';
