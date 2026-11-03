-- Isolated schema for the paper-trading agent. Nothing outside this schema is touched.
create schema if not exists trading_sim;
revoke all on schema trading_sim from public;
revoke all on schema trading_sim from anon, authenticated;

-- Single-row control table: this is how the agent is steered.
create table trading_sim.config (
  id boolean primary key default true,
  kill_switch boolean not null default true,      -- true = no simulated trading at all (safe default)
  probe_enabled boolean not null default true,    -- false = probe function returns immediately
  paper_only boolean not null default true,       -- hard-locked to true by constraint: no real orders, ever
  markets_enabled jsonb not null default '{"crypto":false,"stocks":false,"forex":false,"metals":false}'::jsonb,
  risk jsonb not null default '{}'::jsonb,        -- risk limits: defined together with the simulation step
  costs jsonb not null default '{}'::jsonb,       -- fees/spread/slippage: defined together with the simulation step
  updated_at timestamptz not null default now(),
  constraint config_single_row check (id),
  constraint config_paper_only_true check (paper_only)
);
insert into trading_sim.config (id) values (true);

-- Append-only log of data-source checks (what worked, how fresh, how fast).
create table trading_sim.source_checks (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  market text not null check (market in ('crypto','stocks','forex','metals')),
  source text not null,
  symbol text not null,
  ok boolean not null,                            -- request succeeded AND a closed 1m candle was parsed
  http_status int,
  latency_ms int,
  last_closed_candle_open timestamptz,
  lag_seconds numeric,                            -- seconds since the last closed 1m candle ended
  has_volume boolean,
  error text,
  region text
);
create index source_checks_lookup on trading_sim.source_checks (market, source, symbol, checked_at desc);

-- Latest state per source/symbol, including the last successful fetch.
create view trading_sim.source_status_latest with (security_invoker = true) as
with latest as (
  select distinct on (market, source, symbol) *
  from trading_sim.source_checks
  order by market, source, symbol, checked_at desc
), last_ok as (
  select market, source, symbol, max(checked_at) as last_success_at
  from trading_sim.source_checks
  where ok
  group by market, source, symbol
)
select l.*, o.last_success_at
from latest l
left join last_ok o using (market, source, symbol);

create function trading_sim.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger config_touch before update on trading_sim.config
for each row execute function trading_sim.touch_updated_at();

-- Lock everything down: RLS on, no policies, no grants to API roles.
alter table trading_sim.config enable row level security;
alter table trading_sim.source_checks enable row level security;
revoke all on all tables in schema trading_sim from anon, authenticated;
alter default privileges in schema trading_sim revoke all on tables from anon, authenticated;
