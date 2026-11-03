// dashboard-api: read model and control actions for the simulation dashboard (GitHub Pages page).
// SIMULATION ONLY: nothing here can place an order anywhere; agents.mode is locked to 'paper' by a CHECK constraint.
// Auth: header x-dashboard-token; its SHA-256 hash must equal the Vault secret dashboard_token_sha256. verify_jwt is off.
// Writes are limited to: agent status, kill switch, a few settings and 'control' notifications in schema agent_core.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const ALLOWED_ORIGINS = new Set(["https://derus13.github.io", "https://russki741.github.io"]);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function corsHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-headers": "content-type, x-dashboard-token",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  const o = req.headers.get("origin");
  if (o && ALLOWED_ORIGINS.has(o)) h["access-control-allow-origin"] = o;
  return h;
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(req) } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const isUuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

// Closed trades with per-agent running totals. The window runs over ALL closed trades, so cum_pnl / capital_after stay correct even for a partial page.
// capital_after = capital_start + realized net result so far (open positions are not part of it).
async function closedPage(sql: any, limit: number, offset: number, agentId: string | null) {
  const rows = await sql`
    with t as (
      select p.id::int as id, p.agent_id, p.market, p.symbol, p.side, p.qty::float8 as qty, p.entry_price::float8 as entry_price, p.entry_time,
             p.exit_price::float8 as exit_price, p.exit_time, p.close_reason, p.pnl_usd::float8 as pnl_usd, p.r_multiple::float8 as r, p.quality::float8 as quality, p.setup_key,
             p.entry_fee::float8 as entry_fee, p.exit_fee::float8 as exit_fee, p.entry_notional::float8 as entry_notional,
             (sum(p.pnl_usd) over (partition by p.agent_id order by p.exit_time, p.id))::float8 as cum_pnl,
             (a.capital_start + sum(p.pnl_usd) over (partition by p.agent_id order by p.exit_time, p.id))::float8 as capital_after
      from agent_core.positions p join agent_core.agents a on a.id = p.agent_id
      where p.status = 'closed')
    select * from t where (${agentId}::uuid is null or agent_id = ${agentId}::uuid) order by exit_time desc, id desc limit ${limit} offset ${offset}`;
  const [{ n }] = await sql`select count(*)::int as n from agent_core.positions where status = 'closed' and (${agentId}::uuid is null or agent_id = ${agentId}::uuid)`;
  return { trades: rows, total: n };
}

async function tradesPage(sql: any, body: any) {
  const agentId = isUuid(body?.agent_id) ? body.agent_id : null;
  if (body?.agent_id !== undefined && body?.agent_id !== null && !agentId) return { status: 400, body: { error: "bad agent_id" } };
  const limit = body.limit === undefined ? 100 : body.limit;
  const offset = body.offset === undefined ? 0 : body.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { status: 400, body: { error: "limit 1..200" } };
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return { status: 400, body: { error: "offset 0..1000000" } };
  return { status: 200, body: { server_time: new Date().toISOString(), ...(await closedPage(sql, limit, offset, agentId)) } };
}

async function overview(sql: any, lite = false) {
  const [settings] = await sql`
    select kill_switch, paper_only, markets_enabled, max_agents, replication_threshold_eur::float8 as replication_threshold_eur,
           replication_requires_approval, eurusd_rate::float8 as eurusd_rate, eurusd_rate_at
    from agent_core.settings where id`;
  const [agents, open, closed, marks, dataStatus, signals, equity, lessons, news, newsSources, notifications, replication, stats, sparkRows, dailyRows] = await Promise.all([
    sql`select id, name, parent_id, generation, status, halted_reason, capital_start::float8 as capital_start, cash::float8 as cash, started_at, created_at,
               state, config from agent_core.agents order by created_at`,
    sql`select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_time, entry_fee::float8 as entry_fee,
               entry_notional::float8 as entry_notional, sl_price::float8 as sl, tp_price::float8 as tp, risk_usd::float8 as risk_usd, quality::float8 as quality, setup_key
        from agent_core.positions where status = 'open' order by entry_time desc`,
    lite ? Promise.resolve([]) : sql`select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_time, exit_price::float8 as exit_price, exit_time,
               close_reason, pnl_usd::float8 as pnl_usd, r_multiple::float8 as r, quality::float8 as quality, setup_key
        from agent_core.positions where status = 'closed' order by exit_time desc limit 60`,
    sql`select distinct on (symbol) symbol, c::float8 as price, extract(epoch from open_time) * 1000 as t from agent_core.candles order by symbol, open_time desc`,
    sql`select symbol, market, source, ok, last_attempt_at, last_ok_at, last_candle_open, lag_seconds::float8 as lag_seconds, has_volume, error, assessment from agent_core.data_status order by market, symbol`,
    sql`select s.agent_id, s.ts, s.market, s.symbol, s.candle_time, s.side, s.quality::float8 as quality, s.decision, s.reason
        from agent_core.signals s order by s.ts desc limit 40`,
    sql`select agent_id, extract(epoch from ts) * 1000 as t, equity::float8 as e from agent_core.equity_snapshots where ts > now() - interval '24 hours' order by ts`,
    sql`select agent_id, setup_key, trades, wins, sum_r::float8 as sum_r, status, blocked_until, note, inherited_from from agent_core.lessons order by updated_at desc limit 60`,
    sql`select source, title, url, published_at, fetched_at, score::float8 as score, impact, markets, tags from agent_core.news_items order by coalesce(published_at, fetched_at) desc limit 40`,
    sql`select source, ok, last_attempt_at, last_ok_at, items_seen, items_new, error from agent_core.news_sources order by source`,
    sql`select id::int as id, created_at, kind, agent_id, title, body from agent_core.notifications order by id desc limit 40`,
    sql`select created_at, parent_id, child_id, day, profit_eur::float8 as profit_eur, eurusd::float8 as eurusd, outcome, note from agent_core.replication_events order by id desc limit 20`,
    sql`select agent_id, count(*)::int as trades, (count(*) filter (where pnl_usd > 0))::int as wins, coalesce(sum(pnl_usd), 0)::float8 as pnl,
               coalesce(sum(pnl_usd) filter (where exit_time >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')), 0)::float8 as pnl_today,
               coalesce(avg(r_multiple), 0)::float8 as avg_r,
               coalesce(sum(pnl_usd) filter (where pnl_usd > 0), 0)::float8 as gross_win, coalesce(-sum(pnl_usd) filter (where pnl_usd < 0), 0)::float8 as gross_loss,
               coalesce(sum(coalesce(entry_fee, 0) + coalesce(exit_fee, 0)), 0)::float8 as fees
        from agent_core.positions where status = 'closed' group by agent_id`,
    sql`select symbol, array_agg(c::float8 order by open_time) as closes
        from (select symbol, open_time, c from agent_core.candles where open_time > now() - interval '75 minutes') x group by symbol`,
    sql`select day, trades, wins, losses, pnl, fees, cum_pnl from (
          select to_char(d.day, 'YYYY-MM-DD') as day, d.trades, d.wins, d.losses, d.pnl, d.fees,
                 (sum(d.pnl) over (order by d.day))::float8 as cum_pnl
          from (select (exit_time at time zone 'utc')::date as day, count(*)::int as trades, (count(*) filter (where pnl_usd > 0))::int as wins,
                       (count(*) filter (where pnl_usd < 0))::int as losses, sum(pnl_usd)::float8 as pnl,
                       sum(coalesce(entry_fee, 0) + coalesce(exit_fee, 0))::float8 as fees
                from agent_core.positions where status = 'closed' group by 1) d) x
        order by day desc limit 30`,
  ]);
  const spark: Record<string, number[]> = {};
  for (const r of sparkRows) spark[r.symbol] = (r.closes as number[]).slice(-60);
  const markOf = new Map<string, number>(marks.map((m: any) => [m.symbol, m.price]));
  const openOut = open.map((p: any) => {
    const mark = markOf.get(p.symbol) ?? p.entry_price;
    const dir = p.side === "long" ? 1 : -1;
    const unreal = (mark - p.entry_price) * p.qty * dir - p.entry_fee;
    return { ...p, mark, unrealized_usd: unreal, value: p.entry_notional + (mark - p.entry_price) * p.qty * dir };
  });
  const statOf = new Map<string, any>(stats.map((s: any) => [s.agent_id, s]));
  const agentsOut = agents.map((a: any) => {
    const mine = openOut.filter((p: any) => p.agent_id === a.id);
    const equityNow = a.cash + mine.reduce((s: number, p: any) => s + p.value, 0);
    const st = statOf.get(a.id) ?? { trades: 0, wins: 0, pnl: 0, pnl_today: 0, avg_r: 0, gross_win: 0, gross_loss: 0, fees: 0 };
    const peak = Math.max(Number(a.state?.peak_equity ?? a.capital_start), equityNow);
    // Capital reconciliation: equity must equal start + realized net + open price move - fees already paid on open positions.
    const dirOf = (p: any) => (p.side === "long" ? 1 : -1);
    const openMove = mine.reduce((s: number, p: any) => s + (p.mark - p.entry_price) * p.qty * dirOf(p), 0);
    const openFees = mine.reduce((s: number, p: any) => s + p.entry_fee, 0);
    const reserved = mine.reduce((s: number, p: any) => s + p.entry_notional, 0);
    const expected = a.capital_start + st.pnl + openMove - openFees;
    const capital = {
      start: a.capital_start, realized_net: st.pnl, fees_closed: st.fees ?? 0, open_move: openMove, open_fees: openFees,
      reserved, free_cash: a.cash, equity: equityNow, expected_equity: expected, diff: equityNow - expected,
    };
    return {
      id: a.id, name: a.name, parent_id: a.parent_id, generation: a.generation, status: a.status, halted_reason: a.halted_reason,
      capital_start: a.capital_start, cash: a.cash, equity: equityNow, capital, open_positions: mine.length,
      drawdown_pct: peak > 0 ? ((peak - equityNow) / peak) * 100 : 0, started_at: a.started_at, last_tick_at: a.state?.last_tick_at ?? null,
      stats: { ...st, win_rate: st.trades ? st.wins / st.trades : null, profit_factor: st.gross_loss > 0 ? st.gross_win / st.gross_loss : null },
      config: { markets: a.config?.markets, allow_short: a.config?.allow_short, strategy: a.config?.strategy, risk: a.config?.risk, costs: a.config?.costs, learning: a.config?.learning },
    };
  });
  return {
    server_time: new Date().toISOString(), settings, agents: agentsOut, open_positions: openOut, closed_trades: closed, closed_total: stats.reduce((n: number, r: any) => n + r.trades, 0), daily: dailyRows, data_status: dataStatus, signals,
    equity_curve: equity, lessons, news, news_sources: newsSources, notifications, replication_events: replication, spark,
  };
}

async function control(sql: any, body: any) {
  const agentId = isUuid(body?.agent_id) ? body.agent_id : null;
  if (body?.agent_id !== undefined && body?.agent_id !== null && !agentId) return { status: 400, body: { error: "bad agent_id" } };
  const note = async (title: string, text: string) =>
    await sql`insert into agent_core.notifications (kind, agent_id, title, body) values ('control', ${agentId}, ${title}, ${text})`;

  switch (body.action) {
    case "start": {
      // Explicit release: kill switch off, markets on, stopped/halted agents active. Halted agents get a fresh drawdown reference.
      await sql.begin(async (tx: any) => {
        await tx`update agent_core.settings set kill_switch = false, markets_enabled = '{"crypto": true, "forex": true}'::jsonb where id`;
        await tx`update agent_core.agents a set state = a.state || jsonb_build_object('peak_equity',
                   a.cash + coalesce((select sum(entry_notional) from agent_core.positions p where p.agent_id = a.id and p.status = 'open'), 0)::float8)
                 where a.status = 'halted' and a.mode = 'paper' and (${agentId}::uuid is null or a.id = ${agentId}::uuid)`;
        await tx`update agent_core.agents set status = 'active', halted_reason = null, started_at = now()
                 where status in ('stopped', 'halted') and mode = 'paper' and (${agentId}::uuid is null or id = ${agentId}::uuid)`;
      });
      await note("Start über das Dashboard", agentId ? "Agent gestartet (Simulation)." : "Alle Agenten gestartet (Simulation), Kill-Switch aus.");
      break;
    }
    case "stop": {
      await sql.begin(async (tx: any) => {
        await tx`update agent_core.agents set status = 'stopped' where status in ('active', 'halted') and mode = 'paper' and (${agentId}::uuid is null or id = ${agentId}::uuid)`;
        if (!agentId) await tx`update agent_core.settings set kill_switch = true where id`;
      });
      await note("Stopp über das Dashboard", agentId ? "Agent gestoppt, offene Positionen werden im nächsten Minutenlauf geschlossen." : "Alle Agenten gestoppt, Kill-Switch an. Offene Positionen werden im nächsten Minutenlauf geschlossen.");
      break;
    }
    case "kill_switch": {
      if (typeof body.on !== "boolean") return { status: 400, body: { error: "on must be boolean" } };
      await sql`update agent_core.settings set kill_switch = ${body.on} where id`;
      await note(body.on ? "Kill-Switch eingeschaltet" : "Kill-Switch ausgeschaltet", body.on ? "Keine neuen Trades, offene Positionen werden geschlossen." : "Handel in der Simulation wieder erlaubt (nur für aktive Agenten).");
      break;
    }
    case "approve_agent": {
      if (!agentId) return { status: 400, body: { error: "agent_id required" } };
      const [r] = await sql`select agent_core.fn_approve_agent(${agentId}::uuid, ${body.start !== false}) as res`;
      await note("Neuer Agent freigegeben", `Ergebnis: ${r.res}`);
      return { status: 200, body: { ok: r.res === "ok", result: r.res } };
    }
    case "settings": {
      const s = body.values ?? {};
      if (s.max_agents !== undefined) {
        if (!Number.isInteger(s.max_agents) || s.max_agents < 1 || s.max_agents > 10) return { status: 400, body: { error: "max_agents 1..10" } };
        await sql`update agent_core.settings set max_agents = ${s.max_agents} where id`;
      }
      if (s.replication_threshold_eur !== undefined) {
        if (typeof s.replication_threshold_eur !== "number" || !(s.replication_threshold_eur > 0)) return { status: 400, body: { error: "threshold > 0" } };
        await sql`update agent_core.settings set replication_threshold_eur = ${s.replication_threshold_eur} where id`;
      }
      if (s.replication_requires_approval !== undefined) {
        if (typeof s.replication_requires_approval !== "boolean") return { status: 400, body: { error: "boolean required" } };
        await sql`update agent_core.settings set replication_requires_approval = ${s.replication_requires_approval} where id`;
      }
      await note("Einstellungen geändert", JSON.stringify(s).slice(0, 300));
      break;
    }
    default:
      return { status: 400, body: { error: "unknown action" } };
  }
  return { status: 200, body: { ok: true } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method not allowed" }, 405);
  const token = req.headers.get("x-dashboard-token");
  if (!token || token.length < 20 || token.length > 200) return json(req, { error: "unauthorized" }, 401);

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'dashboard_token_sha256'`;
    if (!secret) return json(req, { error: "dashboard token not configured" }, 503);
    if (!safeEqual(await sha256hex(token), secret.decrypted_secret)) return json(req, { error: "unauthorized" }, 401);
    const raw = await req.text();
    if (raw.length > 10_000) return json(req, { error: "body too large" }, 413);
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(req, { error: "bad json" }, 400);
    }
    if (body.action === undefined || body.action === "overview") return json(req, await overview(sql, body.lite === true));
    if (body.action === "trades") {
      const r = await tradesPage(sql, body);
      return json(req, r.body, r.status);
    }
    const r = await control(sql, body);
    return json(req, r.body, r.status);
  } catch (e) {
    console.error("dashboard-api failed", e);
    return json(req, { error: "internal", detail: msg(e).slice(0, 200) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
