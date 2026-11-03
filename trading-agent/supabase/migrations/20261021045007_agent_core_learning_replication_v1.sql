-- Step 2/3: functions for learning and replication. Schema agent_core only.

-- Learning: after every closed trade update the lesson for its setup; block setups with clearly negative expectancy (in R).
create function agent_core.fn_after_close(p_id bigint) returns void
language plpgsql set search_path = agent_core, pg_temp as $$
declare
  p agent_core.positions%rowtype;
  l agent_core.lessons%rowtype;
  lc jsonb; min_trades int; block_r numeric; block_h int;
begin
  select * into p from positions where id = p_id and status = 'closed';
  if not found then return; end if;
  select config->'learning' into lc from agents where id = p.agent_id;
  min_trades := coalesce((lc->>'min_trades')::int, 12);
  block_r := coalesce((lc->>'block_expectancy_r')::numeric, -0.25);
  block_h := coalesce((lc->>'block_hours')::int, 24);

  insert into lessons (agent_id, setup_key, trades, wins, sum_r)
  values (p.agent_id, p.setup_key, 1, (p.pnl_usd > 0)::int, coalesce(p.r_multiple, 0))
  on conflict (agent_id, setup_key) do update set
    trades = lessons.trades + 1,
    wins = lessons.wins + excluded.wins,
    sum_r = lessons.sum_r + excluded.sum_r,
    updated_at = now();

  select * into l from lessons where agent_id = p.agent_id and setup_key = p.setup_key;
  if l.trades >= min_trades and (l.sum_r / l.trades) < block_r and l.status <> 'blocked' then
    update lessons set status = 'blocked', blocked_until = now() + make_interval(hours => block_h),
      note = format('Gesperrt: %s Trades, Ø %s R, Trefferquote %s %%', l.trades, round(l.sum_r / l.trades, 2), round(100.0 * l.wins / l.trades))
    where agent_id = l.agent_id and setup_key = l.setup_key;
    insert into notifications (kind, agent_id, title, body)
    values ('lesson', p.agent_id, 'Setup gesperrt',
      format('%s: %s Trades, Ø %s R. Gesperrt für %s h.', l.setup_key, l.trades, round(l.sum_r / l.trades, 2), block_h));
  end if;
end $$;

-- Gate before an entry: false while a setup is blocked; after expiry the setup gets a fresh trial window.
create function agent_core.fn_lesson_allows(p_agent uuid, p_key text) returns boolean
language plpgsql set search_path = agent_core, pg_temp as $$
declare l agent_core.lessons%rowtype;
begin
  select * into l from lessons where agent_id = p_agent and setup_key = p_key for update;
  if not found or l.status in ('ok', 'trial') then return true; end if;
  if l.blocked_until is not null and l.blocked_until <= now() then
    update lessons set status = 'trial', trades = 0, wins = 0, sum_r = 0, blocked_until = null,
      note = 'Neuer Versuch seit ' || to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI') || ' UTC'
    where agent_id = p_agent and setup_key = p_key;
    return true;
  end if;
  return false;
end $$;

-- Replication: at >= threshold (EUR) realized profit per UTC day an agent proposes ONE child with its config and lessons.
-- Hard cap on the number of agents; the child waits for approval unless settings say otherwise. Paper only.
create function agent_core.fn_check_replication(p_agent uuid) returns text
language plpgsql set search_path = agent_core, pg_temp as $$
declare
  a agent_core.agents%rowtype;
  c agent_core.settings%rowtype;
  utc_day date := (now() at time zone 'utc')::date;
  day_start timestamptz := (utc_day::timestamp at time zone 'utc');
  profit_usd numeric; profit_eur numeric; n_agents int; new_id uuid; new_status text;
begin
  select * into c from settings where id;
  select * into a from agents where id = p_agent;
  if not found or a.status <> 'active' then return 'agent_inactive'; end if;
  if exists (select 1 from replication_events where parent_id = p_agent and day = utc_day) then return 'already_today'; end if;
  select coalesce(sum(pnl_usd), 0) into profit_usd from positions
   where agent_id = p_agent and status = 'closed' and exit_time >= day_start;
  if profit_usd <= 0 then return 'no_profit'; end if;
  if c.eurusd_rate is null or c.eurusd_rate_at is null or c.eurusd_rate_at < now() - interval '1 day' then return 'no_rate'; end if;
  profit_eur := profit_usd / c.eurusd_rate;
  if profit_eur < c.replication_threshold_eur then return 'below_threshold'; end if;
  select count(*) into n_agents from agents;
  if n_agents >= c.max_agents then
    insert into replication_events (parent_id, day, profit_eur, eurusd, outcome, note)
    values (p_agent, utc_day, profit_eur, c.eurusd_rate, 'capped', format('Obergrenze von %s Agenten erreicht', c.max_agents));
    insert into notifications (kind, agent_id, title, body)
    values ('replication', p_agent, 'Vermehrung blockiert',
      format('%s hat %s € Tagesgewinn erreicht, aber die Obergrenze von %s Agenten ist erreicht.', a.name, round(profit_eur, 2), c.max_agents));
    return 'capped';
  end if;
  new_status := case when c.replication_requires_approval then 'pending_approval' else 'active' end;
  insert into agents (name, parent_id, generation, status, mode, config, capital_start, cash)
  values ('Agent ' || (n_agents + 1) || ' (Gen ' || (a.generation + 1) || ')', a.id, a.generation + 1, new_status, 'paper', a.config, a.capital_start, a.capital_start)
  returning id into new_id;
  insert into lessons (agent_id, setup_key, trades, wins, sum_r, status, blocked_until, note, inherited_from)
  select new_id, setup_key, trades, wins, sum_r, status, blocked_until, note, a.id from lessons where agent_id = p_agent;
  insert into replication_events (parent_id, child_id, day, profit_eur, eurusd, outcome, note)
  values (p_agent, new_id, utc_day, profit_eur, c.eurusd_rate, 'proposed',
    case when c.replication_requires_approval then 'Wartet auf Freigabe' else 'Automatisch gestartet' end);
  insert into notifications (kind, agent_id, title, body)
  values ('replication', p_agent, 'Neuer Agent vorgeschlagen',
    format('%s hat %s € Tagesgewinn erreicht. Neuer Agent (Gen %s) mit Gedächtnis und Einstellungen: %s.',
      a.name, round(profit_eur, 2), a.generation + 1,
      case when c.replication_requires_approval then 'wartet auf deine Freigabe' else 'läuft' end));
  return 'proposed:' || new_id::text;
end $$;

create function agent_core.fn_approve_agent(p_id uuid, p_start boolean default true) returns text
language plpgsql set search_path = agent_core, pg_temp as $$
begin
  update agents set status = case when p_start then 'active' else 'stopped' end,
         started_at = case when p_start then now() else started_at end
  where id = p_id and status = 'pending_approval';
  if not found then return 'not_pending'; end if;
  return 'ok';
end $$;

revoke all on all functions in schema agent_core from public, anon, authenticated;
