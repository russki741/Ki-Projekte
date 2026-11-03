-- Crypto paper-trading module. Creates NEW objects only inside trading_sim; no existing table or row is modified.

create table trading_sim.candles (
  market text not null,
  symbol text not null,
  ts timestamptz not null,               -- candle OPEN time (UTC); only closed candles are stored
  o numeric not null, h numeric not null, l numeric not null, c numeric not null,
  v numeric not null,
  source text not null,
  ingested_at timestamptz not null default now(),
  primary key (market, symbol, ts)
);

create table trading_sim.signals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  market text not null,
  symbol text not null,
  candle_ts timestamptz not null,        -- last closed 1m candle the decision is based on
  price numeric,
  quality int,                           -- 0..100, null when not computable (blocked)
  decision text not null check (decision in ('entry_signal','no_signal','blocked')),
  action text not null default 'none',   -- opened / skipped:<why> / none
  reasons jsonb not null default '[]'::jsonb,
  indicators jsonb not null default '{}'::jsonb,
  components jsonb not null default '{}'::jsonb,
  unique (market, symbol, candle_ts)
);
create index signals_recent on trading_sim.signals (market, created_at desc);
create index signals_rank on trading_sim.signals (created_at desc, quality desc);

create table trading_sim.sim_state (
  market text primary key,
  start_equity numeric not null,
  cash numeric not null,
  halted boolean not null default false,
  halt_reason text,
  last_tick_at timestamptz,
  updated_at timestamptz not null default now()
);

create table trading_sim.sim_trades (
  id bigint generated always as identity primary key,
  market text not null,
  symbol text not null,
  status text not null check (status in ('open','closed')),
  is_test boolean not null default false,
  signal_candle_ts timestamptz not null,
  last_eval_candle_ts timestamptz not null,   -- exits already evaluated up to this closed candle
  opened_at timestamptz not null default now(),
  qty numeric not null,
  entry_price numeric not null,
  entry_fee numeric not null,
  entry_spread_bps numeric not null,
  stop_price numeric not null,
  target_price numeric not null,
  quality int not null,
  closed_at timestamptz,
  exit_price numeric,
  exit_fee numeric,
  exit_reason text,
  pnl_net numeric,
  pnl_pct numeric
);
create index sim_trades_open on trading_sim.sim_trades (market, status);
create index sim_trades_closed_at on trading_sim.sim_trades (market, closed_at desc);

create table trading_sim.sim_equity (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  market text not null,
  equity numeric not null,
  cash numeric not null,
  open_positions int not null,
  realized_pnl numeric not null
);
create index sim_equity_recent on trading_sim.sim_equity (market, ts desc);

-- Shared overview of simulated results across all markets (test trades excluded).
create view trading_sim.sim_overview with (security_invoker = true) as
select
  s.market,
  s.start_equity,
  coalesce(e.equity, s.cash) as equity,
  coalesce(e.equity, s.cash) - s.start_equity as pnl_total,
  coalesce(t.closed_trades, 0) as closed_trades,
  coalesce(t.wins, 0) as wins,
  coalesce(t.realized_pnl, 0) as realized_pnl,
  coalesce(t.fees_paid, 0) as fees_paid,
  coalesce(o.open_positions, 0) as open_positions,
  s.halted,
  s.halt_reason,
  s.last_tick_at
from trading_sim.sim_state s
left join lateral (
  select equity from trading_sim.sim_equity q where q.market = s.market order by ts desc limit 1
) e on true
left join lateral (
  select
    count(*) filter (where status = 'closed') as closed_trades,
    count(*) filter (where status = 'closed' and pnl_net > 0) as wins,
    sum(pnl_net) filter (where status = 'closed') as realized_pnl,
    sum(entry_fee + coalesce(exit_fee, 0)) as fees_paid
  from trading_sim.sim_trades x where x.market = s.market and not x.is_test
) t on true
left join lateral (
  select count(*) as open_positions from trading_sim.sim_trades x
  where x.market = s.market and x.status = 'open' and not x.is_test
) o on true;

-- Lock down the new tables: RLS on, no policies, no grants to API roles.
alter table trading_sim.candles enable row level security;
alter table trading_sim.signals enable row level security;
alter table trading_sim.sim_state enable row level security;
alter table trading_sim.sim_trades enable row level security;
alter table trading_sim.sim_equity enable row level security;
revoke all on trading_sim.candles, trading_sim.signals, trading_sim.sim_state, trading_sim.sim_trades, trading_sim.sim_equity, trading_sim.sim_overview from anon, authenticated;
