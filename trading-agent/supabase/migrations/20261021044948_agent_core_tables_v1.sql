-- Step 1/3: tables only, in a NEW schema agent_core. Nothing in schema trading_sim or public is touched.
-- Safety: agents.mode is locked to 'paper' by a CHECK constraint, so real orders cannot be represented here.
create schema if not exists agent_core;
revoke all on schema agent_core from public, anon, authenticated;

create function agent_core.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- Single-row control table: global kill switch (default ON = nothing trades), limits, replication rules.
create table agent_core.settings (
  id boolean primary key default true check (id),
  kill_switch boolean not null default true,
  paper_only boolean not null default true check (paper_only),
  markets_enabled jsonb not null default '{"crypto": false, "forex": false}'::jsonb,
  max_agents int not null default 3 check (max_agents between 1 and 10),
  replication_threshold_eur numeric not null default 500 check (replication_threshold_eur > 0),
  replication_requires_approval boolean not null default true,
  eurusd_rate numeric,
  eurusd_rate_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into agent_core.settings default values;
create trigger settings_touch before update on agent_core.settings
for each row execute function agent_core.touch_updated_at();

-- Latest state of every data source/symbol (source, delay, last successful fetch, errors).
create table agent_core.data_status (
  symbol text primary key,
  market text not null check (market in ('crypto','forex')),
  source text not null,
  ok boolean not null default false,
  last_attempt_at timestamptz,
  last_ok_at timestamptz,
  last_candle_open timestamptz,
  lag_seconds numeric,
  has_volume boolean,
  error text
);

create table agent_core.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_id uuid references agent_core.agents(id) on delete set null,
  generation int not null default 0,
  status text not null default 'stopped' check (status in ('active','stopped','pending_approval','halted')),
  mode text not null default 'paper' check (mode = 'paper'),
  config jsonb not null,
  state jsonb not null default '{}'::jsonb,
  capital_start numeric not null default 10000 check (capital_start > 0),
  cash numeric not null default 10000,
  halted_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger agents_touch before update on agent_core.agents
for each row execute function agent_core.touch_updated_at();

create table agent_core.candles (
  symbol text not null,
  market text not null check (market in ('crypto','forex')),
  open_time timestamptz not null,
  o numeric not null, h numeric not null, l numeric not null, c numeric not null, v numeric,
  source text not null,
  primary key (symbol, open_time)
);
create index candles_open_time on agent_core.candles (open_time);

create table agent_core.positions (
  id bigint generated always as identity primary key,
  agent_id uuid not null references agent_core.agents(id) on delete cascade,
  market text not null, symbol text not null,
  side text not null check (side in ('long','short')),
  status text not null default 'open' check (status in ('open','closed')),
  qty numeric not null check (qty > 0),
  entry_price numeric not null, entry_time timestamptz not null default now(),
  entry_fee numeric not null default 0, entry_notional numeric not null,
  sl_price numeric not null, tp_price numeric not null, risk_usd numeric not null,
  quality numeric, setup_key text not null, features jsonb,
  exit_price numeric, exit_time timestamptz, exit_fee numeric, close_reason text,
  pnl_usd numeric, r_multiple numeric, note text
);
create index positions_agent_status on agent_core.positions (agent_id, status);
create index positions_exit_time on agent_core.positions (exit_time);

create table agent_core.signals (
  id bigint generated always as identity primary key,
  agent_id uuid not null references agent_core.agents(id) on delete cascade,
  ts timestamptz not null default now(),
  market text not null, symbol text not null, candle_time timestamptz not null,
  side text, quality numeric, decision text not null, reason text, features jsonb
);
create index signals_agent_ts on agent_core.signals (agent_id, ts desc);

create table agent_core.equity_snapshots (
  id bigint generated always as identity primary key,
  agent_id uuid not null references agent_core.agents(id) on delete cascade,
  ts timestamptz not null default now(),
  equity numeric not null, cash numeric not null, open_positions int not null,
  day_pnl numeric, drawdown_pct numeric
);
create index equity_agent_ts on agent_core.equity_snapshots (agent_id, ts desc);

create table agent_core.lessons (
  agent_id uuid not null references agent_core.agents(id) on delete cascade,
  setup_key text not null,
  trades int not null default 0, wins int not null default 0, sum_r numeric not null default 0,
  status text not null default 'ok' check (status in ('ok','blocked','trial')),
  blocked_until timestamptz, note text,
  inherited_from uuid references agent_core.agents(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (agent_id, setup_key)
);

create table agent_core.news_items (
  id bigint generated always as identity primary key,
  source text not null, title text not null, url text not null unique,
  published_at timestamptz, fetched_at timestamptz not null default now(),
  score numeric,
  impact text not null default 'low' check (impact in ('low','medium','high')),
  markets text[] not null default '{}',
  tags text[] not null default '{}'
);
create index news_published on agent_core.news_items (published_at desc);

create table agent_core.notifications (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null,
  agent_id uuid references agent_core.agents(id) on delete set null,
  title text not null, body text, payload jsonb,
  sent_at timestamptz, channel text, send_error text
);
create index notifications_unsent on agent_core.notifications (created_at) where sent_at is null;

create table agent_core.replication_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  parent_id uuid not null references agent_core.agents(id) on delete cascade,
  child_id uuid references agent_core.agents(id) on delete set null,
  day date not null, profit_eur numeric not null, eurusd numeric not null,
  outcome text not null check (outcome in ('proposed','capped')),
  note text,
  unique (parent_id, day)
);

-- First agent: starts STOPPED. Defaults = the settings agreed with the user.
insert into agent_core.agents (name, config) values ('Agent Alpha', $cfg${
  "markets": {"crypto": ["BTCUSDT","ETHUSDT","SOLUSDT"], "forex": ["EURUSD=X"]},
  "allow_short": {"crypto": false, "forex": true},
  "strategy": {
    "name": "mtf_pullback", "ema_fast": 20, "ema_slow": 50, "rsi_period": 14, "atr_period": 14,
    "rsi_long_cross": 45, "rsi_short_cross": 55, "atr_stop_mult": 1.5, "rr": 2,
    "min_edge_multiple": 3, "min_quality": 60, "max_hold_min": 240,
    "bands": {"crypto": {"atr_pct_min": 0.0012, "atr_pct_max": 0.015}, "forex": {"atr_pct_min": 0.0002, "atr_pct_max": 0.004}}
  },
  "risk": {
    "risk_per_trade_pct": 1, "max_positions": 3, "max_position_pct": 25,
    "daily_loss_pct": 3, "max_drawdown_pct": 10,
    "cooldown_after_stop_min": 15, "loss_streak_pause": 3, "loss_streak_pause_min": 60, "min_notional_usd": 10
  },
  "costs": {
    "crypto": {"fee_bps": 10, "slip_bps": 2, "fallback_spread_bps": 3},
    "forex": {"fee_bps": 0, "fallback_spread_bps": 0.9, "slip_bps": 0.5}
  },
  "data": {"max_lag_s": {"crypto": 180, "forex": 300}},
  "learning": {"min_trades": 12, "block_expectancy_r": -0.25, "block_hours": 24}
}$cfg$::jsonb);

-- Lock down: RLS on, no policies, no grants for API roles.
alter table agent_core.settings enable row level security;
alter table agent_core.data_status enable row level security;
alter table agent_core.agents enable row level security;
alter table agent_core.candles enable row level security;
alter table agent_core.positions enable row level security;
alter table agent_core.signals enable row level security;
alter table agent_core.equity_snapshots enable row level security;
alter table agent_core.lessons enable row level security;
alter table agent_core.news_items enable row level security;
alter table agent_core.notifications enable row level security;
alter table agent_core.replication_events enable row level security;
revoke all on all tables in schema agent_core from anon, authenticated;
