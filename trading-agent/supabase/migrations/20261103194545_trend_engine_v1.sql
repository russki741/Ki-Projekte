-- Trend engine (trend-tick): positions of rule-based agents have no fixed target and only rules with a trailing stop
-- have a stop level, so both columns become optional. Plus a small calendar of scheduled high-impact events
-- (FOMC decisions etc.) that delays NEW entries of the trend agents. US payrolls are computed in code, not stored here.
alter table agent_core.positions alter column tp_price drop not null;
alter table agent_core.positions alter column sl_price drop not null;

create table if not exists agent_core.event_calendar (
  id bigint generated always as identity primary key,
  starts_at timestamptz not null,
  name text not null,
  region text not null default 'US',
  impact text not null default 'high' check (impact in ('high', 'medium')),
  unique (starts_at, name)
);
alter table agent_core.event_calendar enable row level security;
revoke all on agent_core.event_calendar from anon, authenticated;

insert into agent_core.event_calendar (starts_at, name, region, impact)
values ('2026-12-09 19:00:00+00', 'FOMC Zinsentscheid', 'US', 'high')
on conflict do nothing;
