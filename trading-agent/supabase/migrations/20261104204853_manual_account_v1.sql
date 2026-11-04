-- Own paper account of the user ("Selbst handeln" in the app). config.engine = 'manual': no engine trades it; dashboard-api
-- opens and closes positions on the user's request at live prices with the same costs as the agents. 5,000 rubles start capital.
-- learning.min_trades is set very high so the lesson memory never blocks the user's own trades.
insert into agent_core.agents (name, generation, status, mode, config, capital_start, cash, state, started_at)
select 'Ich · Selbst gehandelt', 0, 'active', 'paper',
  jsonb_build_object(
    'engine', 'manual',
    'markets', jsonb_build_object('crypto', jsonb_build_array('BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XAUTUSDT'),
                                  'forex', jsonb_build_array('EURUSD=X', 'GBPUSD=X', 'USDJPY=X')),
    'allow_short', jsonb_build_object('forex', true),
    'strategy', jsonb_build_object('label', 'Du entscheidest selbst'),
    'risk', jsonb_build_object('min_order_usd', 6, 'min_notional_usd', 1),
    'costs', jsonb_build_object('crypto', jsonb_build_object('fee_bps', 10, 'slip_bps', 2),
                                'forex', jsonb_build_object('fee_bps', 0, 'slip_bps', 1, 'spread_bps_by_symbol', jsonb_build_object('EURUSD=X', 2, 'GBPUSD=X', 2.5, 'USDJPY=X', 2))),
    'learning', jsonb_build_object('min_trades', 1000000, 'block_hours', 0, 'block_expectancy_r', -1000),
    'display', jsonb_build_object('currency', 'RUB', 'capital_rub', 5000, 'usdrub_at_start', s.usdrub_rate)
  ),
  round(5000 / s.usdrub_rate, 6), round(5000 / s.usdrub_rate, 6), '{}'::jsonb, now()
from agent_core.settings s
where s.id and s.usdrub_rate > 0
  and not exists (select 1 from agent_core.agents where config->>'engine' = 'manual');
