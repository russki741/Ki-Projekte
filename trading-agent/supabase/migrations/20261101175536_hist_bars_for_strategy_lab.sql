-- Additive: higher-timeframe history (Bybit public klines) for the strategy lab. Nothing existing is altered.
create table if not exists agent_core.hist_bars (
  symbol text not null,
  tf integer not null,
  open_time timestamptz not null,
  o double precision not null,
  h double precision not null,
  l double precision not null,
  c double precision not null,
  v double precision not null,
  primary key (symbol, tf, open_time)
);
alter table agent_core.hist_bars enable row level security;
revoke all on agent_core.hist_bars from anon, authenticated;
