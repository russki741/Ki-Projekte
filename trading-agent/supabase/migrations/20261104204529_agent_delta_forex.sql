-- Agent Delta: trend rule on six currency pairs, both directions (long = rule on the price, short = rule on 1/price), no leverage.
-- Paper only, 5,000 rubles start capital like Beta and Gamma. Tested in the lab (study 4 Nov 2026): about 0 % over almost 5 years.
insert into agent_core.agents (name, generation, status, mode, config, capital_start, cash, state, started_at)
select 'Agent Delta · Währungen', 0, 'active', 'paper',
  jsonb_build_object(
    'engine', 'trend',
    'markets', jsonb_build_object('forex', jsonb_build_array('EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCHF=X', 'USDCAD=X')),
    'allow_short', jsonb_build_object('forex', true),
    'strategy', jsonb_build_object('tf', 1440, 'rule', 'tsmom_vote', 'label', 'Momentum-Abstimmung 30/90/180 Tage, beide Richtungen',
                                   'scale', 0.5, 'sizing', 'vol', 'ref_vol', 0.6, 'vol_days', 30),
    'risk', jsonb_build_object('max_drawdown_pct', 10, 'min_notional_usd', 1, 'min_order_usd', 0),
    'costs', jsonb_build_object('forex', jsonb_build_object('fee_bps', 0, 'slip_bps', 1, 'fallback_spread_bps', 3,
      'spread_bps_by_symbol', jsonb_build_object('EURUSD=X', 2, 'GBPUSD=X', 2.5, 'USDJPY=X', 2, 'AUDUSD=X', 3, 'USDCHF=X', 3, 'USDCAD=X', 3))),
    'learning', jsonb_build_object('min_trades', 50, 'block_hours', 24, 'block_expectancy_r', -0.25),
    'display', jsonb_build_object('currency', 'RUB', 'capital_rub', 5000, 'usdrub_at_start', s.usdrub_rate)
  ),
  round(5000 / s.usdrub_rate, 6), round(5000 / s.usdrub_rate, 6), '{}'::jsonb, now()
from agent_core.settings s
where s.id and s.usdrub_rate > 0
  and not exists (select 1 from agent_core.agents where config->>'engine' = 'trend' and config->'markets' ? 'forex');
