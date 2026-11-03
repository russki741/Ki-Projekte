-- DOCUMENTATION ONLY. Data changes made on 2026-11-03 with plain SQL (not in supabase_migrations.schema_migrations).
-- Every statement is idempotent: on production it changes nothing, on a fresh project it creates the same agents.

-- 1) Two trend agents (engine "trend", handled by the trend-tick function). Rules and parameters come from the
--    rulebook test (strategy-lab, action "rulebook", daily bars, May 2022 to October 2026, costs included).
--    scale 0.25: each market gets at most 1/3 x 25 % of the capital, so the simulated drawdown stays below the 10 % limit.
insert into agent_core.agents (name, status, mode, config, capital_start, cash, started_at)
select v.name, 'active', 'paper', jsonb_build_object(
    'engine', 'trend',
    'markets', jsonb_build_object('crypto', jsonb_build_array('BTCUSDT', 'ETHUSDT', 'SOLUSDT')),
    'strategy', jsonb_build_object('rule', v.rule, 'label', v.label, 'tf', 1440, 'sizing', 'vol', 'ref_vol', 0.6, 'vol_days', 30, 'scale', 0.25),
    'risk', jsonb_build_object('max_drawdown_pct', 10, 'min_notional_usd', 10),
    'costs', jsonb_build_object('crypto', jsonb_build_object('fee_bps', 10, 'slip_bps', 2, 'fallback_spread_bps', 3)),
    'learning', jsonb_build_object('min_trades', 50, 'block_expectancy_r', -0.25, 'block_hours', 24)),
  10000, 10000, now()
from (values ('Agent Beta · Momentum', 'tsmom_vote', 'Momentum-Abstimmung 30/90/180 Tage'),
             ('Agent Gamma · Turtle', 'turtle_55_20', 'Turtle-Ausbruch 55/20 Tage')) v(name, rule, label)
where not exists (select 1 from agent_core.agents a where a.name = v.name);

-- 2) Agent Alpha (minute strategy) retired: agent-tick closes its open positions with reason "retired" and never opens
--    new ones. Its markets keep being collected (candles, market assessment in the app).
update agent_core.agents
set config = jsonb_set(config, '{strategy,retired}', 'true'::jsonb),
    status = 'stopped',
    state = state || jsonb_build_object('retired_at', now(), 'retired_note', 'Ersetzt durch Trend-Agenten Beta und Gamma')
where name = 'Agent Alpha' and coalesce((config->'strategy'->>'retired')::boolean, false) = false;

-- 3) FOMC decisions 2027 (Federal Reserve press release of 2025-09-05, statement at 2:00 p.m. Eastern Time:
--    19:00 UTC in winter time, 18:00 UTC in summer time).
insert into agent_core.event_calendar (starts_at, name, region, impact) values
 ('2027-01-27 19:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-03-17 18:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-04-28 18:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-06-09 18:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-07-28 18:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-09-15 18:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-10-27 18:00:00+00', 'FOMC Zinsentscheid', 'US', 'high'),
 ('2027-12-08 19:00:00+00', 'FOMC Zinsentscheid', 'US', 'high')
on conflict do nothing;
