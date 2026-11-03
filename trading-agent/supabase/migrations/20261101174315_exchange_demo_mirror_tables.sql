-- Additive only: two new tables for the Bybit DEMO mirror. Nothing existing is altered. The mirror is OFF by default.
create table if not exists agent_core.exchange_config (
  id boolean primary key default true check (id),
  venue text not null default 'bybit_demo' check (venue = 'bybit_demo'),
  enabled boolean not null default false,
  enabled_since timestamptz,
  max_entry_age_s integer not null default 180,
  last_reconcile_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into agent_core.exchange_config (id) values (true) on conflict (id) do nothing;

create table if not exists agent_core.exchange_orders (
  id bigint generated always as identity primary key,
  position_id bigint not null references agent_core.positions(id),
  leg text not null check (leg in ('in','out')),
  symbol text not null,
  side text not null check (side in ('Buy','Sell')),
  order_link_id text not null unique,
  bybit_order_id text,
  status text not null check (status in ('sending','filled','partial','error','skipped')),
  note text,
  attempts integer not null default 0,
  req_qty numeric,
  fill_qty numeric,
  fill_price numeric,
  fill_value numeric,
  fee_base numeric,
  fee_quote numeric,
  net_base_qty numeric,
  paper_price numeric,
  slip_bps_vs_paper numeric,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (position_id, leg)
);
create index if not exists exchange_orders_status_idx on agent_core.exchange_orders (status, updated_at);

alter table agent_core.exchange_config enable row level security;
alter table agent_core.exchange_orders enable row level security;
revoke all on agent_core.exchange_config from anon, authenticated;
revoke all on agent_core.exchange_orders from anon, authenticated;
