-- DOCUMENTATION ONLY. Restart on 2026-11-04 (about 04:52 UTC), done with plain SQL, not in supabase_migrations.schema_migrations.
-- Wish of the owner: each trend agent starts with 5,000 rubles (10,000 rubles together), statistics count from the restart,
-- smallest possible position size that the exchange still accepts.
--
-- Steps that were taken:
-- 1) Beta and Gamma set to 'stopped'; trend-tick then closed Beta's open SOL position (reason 'stopped', -5.64 USD), and
--    bybit-demo sold it on the demo account. That trade belongs to the archive.
-- 2) The block below, under the same advisory lock as trend-tick. Rate: Bank of Russia 81.6699 RUB per USD (2026-11-04),
--    so 5,000 RUB = 61.222066 USDT per agent.
-- 3) trend-tick run by hand right after; Beta bought SOL for 6.00 USDT (raised to the minimum order).
-- Nothing was deleted: the archive is everything with entry_time < settings.stats_since (see docs/BETRIEB.md).

do $$
declare r numeric; cap numeric;
begin
  -- runs only once: on production (stats_since already set) this block does nothing
  if (select stats_since from agent_core.settings where id) > '2021-01-01' then return; end if;
  perform pg_advisory_xact_lock(738202);
  select usdrub_rate into r from agent_core.settings where id and usdrub_rate_at > now() - interval '1 day';
  if r is null or r < 1 then raise exception 'no fresh USD/RUB rate'; end if;
  if exists (select 1 from agent_core.positions p join agent_core.agents a on a.id = p.agent_id where p.status = 'open' and a.config->>'engine' = 'trend') then
    raise exception 'trend agents still have open positions';
  end if;
  cap := round(5000 / r, 6);
  update agent_core.agents set
    capital_start = cap, cash = cap, status = 'active', halted_reason = null, started_at = now(),
    config = jsonb_set(jsonb_set(jsonb_set(config, '{risk,min_order_usd}', '6'::jsonb), '{risk,min_notional_usd}', '5'::jsonb),
                       '{display}', jsonb_build_object('currency', 'RUB', 'capital_rub', 5000, 'usdrub_at_start', r)),
    state = (state - 'decided' - 'blocked') || jsonb_build_object('peak_equity', cap, 'season_start', now())
  where config->>'engine' = 'trend' and mode = 'paper';
  update agent_core.settings set stats_since = now() where id;
  insert into agent_core.notifications (kind, title, body, payload)
  values ('control', 'Neustart mit 5.000 Rubel je Agent',
          format('Beta und Gamma starten mit je 5.000 RUB (%s USDT zum Kurs %s). Die Statistik zählt ab jetzt, ältere Trades sind archiviert.', round(cap, 2), r),
          jsonb_build_object('capital_rub', 5000, 'capital_usd', cap, 'usdrub', r));
end $$;
