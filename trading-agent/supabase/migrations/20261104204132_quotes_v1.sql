-- Latest price per market for the app: currency pairs (Yahoo, mid price) and tokens without minute candles (Bybit ticker).
-- Written by trend-tick (every 5 minutes for open positions and traded markets) and by dashboard-api (own trades of the user).
create table if not exists agent_core.quotes (
  symbol text primary key,
  market text not null check (market in ('crypto', 'forex')),
  bid numeric,
  ask numeric,
  last numeric not null check (last > 0),
  quote_time timestamptz not null,
  fetched_at timestamptz not null default now(),
  source text not null
);
alter table agent_core.quotes enable row level security;
comment on table agent_core.quotes is 'Latest price per market (display and paper fills of the manual account). quote_time = time of the price at the source.';
