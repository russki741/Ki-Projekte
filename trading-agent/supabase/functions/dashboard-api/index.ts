// dashboard-api: read model and control actions for the simulation dashboard (GitHub Pages page).
// SIMULATION ONLY: nothing here can place an order anywhere; agents.mode is locked to 'paper' by a CHECK constraint.
// Auth: header x-dashboard-token; its SHA-256 hash must equal the Vault secret dashboard_token_sha256. verify_jwt is off.
// Writes are limited to: agent status, kill switch, a few settings, 'control' notifications and the user's OWN paper trades
// ("Selbst handeln": actions manual_quote, manual_open, manual_close on the account with config.engine = 'manual') in schema agent_core.
// Own trades are paper positions at live public prices (Bybit spot ticker, Yahoo chart) with the same costs as the agents.
// manual_chart: candles for the live chart in the app (Bybit spot klines, Yahoo chart); live updates come from the Bybit
// WebSocket in the browser (crypto) or by asking again (currencies).
// Second credential: header x-agent-secret (Vault agent_cron_secret, server side only) may call the two read-only market
// data actions manual_quote and manual_chart, for health checks from the database. Everything else needs the dashboard token.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import {
  type Bar, COSTS, type Market, MARKETS, marketOf, MIN_USD, parseBybitKlines, parseYahooBars, parseYahooChart, plan, precisionOf, type Quote, quoteFrom,
  roundTripPct, settleClose, type Side, TF,
} from "./manual.ts";

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

// Statistics period: trades OPENED before settings.stats_since are archive (kept in the tables, not counted here).
// Retired agents (config.strategy.retired) are archive too and are left out of the overview.
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
      where p.status = 'closed' and p.entry_time >= (select stats_since from agent_core.settings where id))
    select * from t where (${agentId}::uuid is null or agent_id = ${agentId}::uuid) order by exit_time desc, id desc limit ${limit} offset ${offset}`;
  const [{ n }] = await sql`select count(*)::int as n from agent_core.positions where status = 'closed' and entry_time >= (select stats_since from agent_core.settings where id)
                            and (${agentId}::uuid is null or agent_id = ${agentId}::uuid)`;
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
           replication_requires_approval, eurusd_rate::float8 as eurusd_rate, eurusd_rate_at, stats_since,
           usdrub_rate::float8 as usdrub_rate, usdrub_rate_at, usdrub_source
    from agent_core.settings where id`;
  const since = settings.stats_since;
  const [agents, open, closed, marks, quotes, dataStatus, signals, equity, lessons, news, newsSources, notifications, replication, stats, sparkRows, dailyRows] = await Promise.all([
    sql`select id, name, parent_id, generation, status, halted_reason, capital_start::float8 as capital_start, cash::float8 as cash, started_at, created_at,
               state, config from agent_core.agents where coalesce((config->'strategy'->>'retired')::boolean, false) = false order by created_at`,
    sql`select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_time, entry_fee::float8 as entry_fee,
               entry_notional::float8 as entry_notional, sl_price::float8 as sl, tp_price::float8 as tp, risk_usd::float8 as risk_usd, quality::float8 as quality, setup_key
        from agent_core.positions where status = 'open' order by entry_time desc`,
    lite ? Promise.resolve([]) : sql`select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_time, exit_price::float8 as exit_price, exit_time,
               close_reason, pnl_usd::float8 as pnl_usd, r_multiple::float8 as r, quality::float8 as quality, setup_key
        from agent_core.positions where status = 'closed' and entry_time >= ${since} order by exit_time desc limit 60`,
    sql`select distinct on (symbol) symbol, c::float8 as price, extract(epoch from open_time) * 1000 as t from agent_core.candles order by symbol, open_time desc`,
    sql`select symbol, last::float8 as price, extract(epoch from quote_time) * 1000 as t from agent_core.quotes`,
    sql`select symbol, market, source, ok, last_attempt_at, last_ok_at, last_candle_open, lag_seconds::float8 as lag_seconds, has_volume, error, assessment from agent_core.data_status order by market, symbol`,
    sql`select s.agent_id, s.ts, s.market, s.symbol, s.candle_time, s.side, s.quality::float8 as quality, s.decision, s.reason
        from agent_core.signals s where s.ts >= ${since} order by s.ts desc limit 40`,
    sql`select agent_id, extract(epoch from ts) * 1000 as t, equity::float8 as e from agent_core.equity_snapshots where ts > now() - interval '24 hours' and ts >= ${since} order by ts`,
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
        from agent_core.positions where status = 'closed' and entry_time >= ${since} group by agent_id`,
    sql`select symbol, array_agg(c::float8 order by open_time) as closes
        from (select symbol, open_time, c from agent_core.candles where open_time > now() - interval '75 minutes') x group by symbol`,
    sql`select day, trades, wins, losses, pnl, fees, cum_pnl from (
          select to_char(d.day, 'YYYY-MM-DD') as day, d.trades, d.wins, d.losses, d.pnl, d.fees,
                 (sum(d.pnl) over (order by d.day))::float8 as cum_pnl
          from (select (exit_time at time zone 'utc')::date as day, count(*)::int as trades, (count(*) filter (where pnl_usd > 0))::int as wins,
                       (count(*) filter (where pnl_usd < 0))::int as losses, sum(pnl_usd)::float8 as pnl,
                       sum(coalesce(entry_fee, 0) + coalesce(exit_fee, 0))::float8 as fees
                from agent_core.positions where status = 'closed' and entry_time >= ${since} group by 1) d) x
        order by day desc limit 30`,
  ]);
  const spark: Record<string, number[]> = {};
  for (const r of sparkRows) spark[r.symbol] = (r.closes as number[]).slice(-60);
  // latest price per symbol: minute candle or stored quote (currency pairs, tokens without candles), whichever is newer
  const latest = new Map<string, { price: number; t: number }>();
  for (const m of [...marks, ...quotes]) {
    const t = Number(m.t);
    if (!latest.has(m.symbol) || t > latest.get(m.symbol)!.t) latest.set(m.symbol, { price: m.price, t });
  }
  const markOf = new Map<string, number>([...latest].map(([k, v]) => [k, v.price]));
  const openOut = open.map((p: any) => {
    const mark = markOf.get(p.symbol) ?? p.entry_price;
    const dir = p.side === "long" ? 1 : -1;
    const unreal = (mark - p.entry_price) * p.qty * dir - p.entry_fee;
    return { ...p, mark, unrealized_usd: unreal, value: p.entry_notional + (mark - p.entry_price) * p.qty * dir };
  });
  const statOf = new Map<string, any>(stats.map((s: any) => [s.agent_id, s]));
  const activeIds = new Set<string>(agents.map((a: any) => a.id));
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
      config: { engine: a.config?.engine ?? "minute", markets: a.config?.markets, allow_short: a.config?.allow_short, strategy: a.config?.strategy, risk: a.config?.risk, costs: a.config?.costs, learning: a.config?.learning, display: a.config?.display ?? null },
    };
  });
  return {
    server_time: new Date().toISOString(), settings, agents: agentsOut, open_positions: openOut, closed_trades: closed, closed_total: stats.reduce((n: number, r: any) => n + r.trades, 0), daily: dailyRows, data_status: dataStatus, signals,
    equity_curve: equity, lessons: lessons.filter((l: any) => activeIds.has(l.agent_id)), news, news_sources: newsSources, notifications, replication_events: replication, spark,
    manual: { markets: MARKETS.map((m) => ({ symbol: m.symbol, name: m.name, market: m.cls, can_short: m.canShort })), min_usd: MIN_USD },
  };
}

// ---------- own trades of the user ("Selbst handeln"), paper only ----------

const UA = { "user-agent": "trading-sim-agent/0.1 (paper-trading research)" };
async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
type Live = { q: Quote; change_pct: number | null; chart: number[] | null; source: string };
/** Live price of one market from the public sources (no keys): Bybit spot ticker, Yahoo chart for currency pairs. */
async function liveQuote(m: Market, withChart: boolean): Promise<Live> {
  const now = Date.now();
  if (m.cls === "crypto") {
    const [t, k] = await Promise.all([
      fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${m.symbol}`),
      withChart ? fetchJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${m.symbol}&interval=60&limit=48`) : Promise.resolve(null),
    ]);
    const r = t?.result?.list?.[0];
    const bid = Number(r?.bid1Price), ask = Number(r?.ask1Price), last = Number(r?.lastPrice);
    if (t?.retCode !== 0 || !(bid > 0 && ask >= bid && last > 0)) throw new Error("kein Kurs von Bybit");
    const chart = k?.retCode === 0 ? (k.result?.list ?? []).map((x: string[]) => Number(x[4])).filter((x: number) => x > 0).reverse() : null;
    const pct = Number(r?.price24hPcnt);
    return { q: quoteFrom(m, last, now, now, bid, ask), change_pct: Number.isFinite(pct) ? pct * 100 : null, chart, source: "bybit" };
  }
  const y = parseYahooChart(await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.symbol)}?interval=1h&range=5d`, UA));
  if (!y) throw new Error("kein Kurs von Yahoo");
  const c = y.closes;
  const day = c.length > 24 ? c[c.length - 25] : null;
  return { q: quoteFrom(m, y.price, y.at, now), change_pct: day ? (y.price / day - 1) * 100 : null, chart: withChart ? c.slice(-48) : null, source: "yahoo" };
}
async function storeQuote(sql: any, m: Market, l: Live) {
  await sql`insert into agent_core.quotes (symbol, market, bid, ask, last, quote_time, fetched_at, source)
            values (${m.symbol}, ${m.cls}, ${m.cls === "crypto" ? l.q.bid : null}, ${m.cls === "crypto" ? l.q.ask : null}, ${l.q.mid}, ${new Date(l.q.at).toISOString()}, now(), ${l.source})
            on conflict (symbol) do update set market = excluded.market, bid = excluded.bid, ask = excluded.ask, last = excluded.last,
              quote_time = excluded.quote_time, fetched_at = excluded.fetched_at, source = excluded.source`;
}
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

async function manual(sql: any, body: any): Promise<{ status: number; body: unknown }> {
  const [s] = await sql`select kill_switch, markets_enabled, usdrub_rate::float8 as usdrub from agent_core.settings where id`;
  const usdrub = Number(s?.usdrub);

  if (body.action === "manual_quote") {
    const one = body.symbol === undefined ? null : marketOf(body.symbol);
    if (body.symbol !== undefined && !one) return { status: 400, body: { error: "unknown symbol" } };
    const list = one ? [one] : MARKETS;
    const rows = await Promise.all(list.map(async (m) => {
      try {
        const l = await liveQuote(m, !!one);
        await storeQuote(sql, m, l).catch(() => {});
        const c = COSTS[m.cls];
        return { symbol: m.symbol, name: m.name, market: m.cls, can_short: m.canShort, bid: l.q.bid, ask: l.q.ask, mid: l.q.mid, at: new Date(l.q.at).toISOString(), fresh: l.q.fresh,
          change_pct: l.change_pct, chart: l.chart, fee_bps: c.feeBps, slip_bps: c.slipBps, spread_bps: m.cls === "crypto" ? ((l.q.ask - l.q.bid) / l.q.mid) * 1e4 : m.spreadBps,
          round_trip_pct: roundTripPct(m, l.q), min_rub: usdrub > 0 ? Math.ceil(MIN_USD[m.cls] * 1.01 * usdrub) : null, source: l.source };
      } catch (e) {
        return { symbol: m.symbol, name: m.name, market: m.cls, can_short: m.canShort, error: msg(e).slice(0, 120) };
      }
    }));
    return { status: 200, body: { server_time: new Date().toISOString(), usdrub, kill_switch: s.kill_switch, markets_enabled: s.markets_enabled, quotes: rows } };
  }

  if (body.action === "manual_chart") {
    const m = marketOf(body.symbol);
    const tfKey = String(body.tf ?? "15");
    const tf = TF[tfKey];
    if (!m || !tf) return { status: 400, body: { error: "symbol or tf not allowed" } };
    const limit = Number.isInteger(body.limit) && body.limit >= 2 && body.limit <= 500 ? body.limit : 400;
    let bars: Bar[];
    try {
      if (m.cls === "crypto") {
        const k = await fetchJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${m.symbol}&interval=${tf.bybit}&limit=${limit}`);
        if (k?.retCode !== 0) throw new Error(`Bybit ${k?.retMsg ?? ""}`.trim());
        bars = parseBybitKlines(k.result?.list);
      } else {
        const now = Date.now();
        // a short request (live update) only needs the last hours; the first load gets enough history for a full chart
        const back = limit <= 10 ? Math.max(tf.ms * 12, 6 * 3_600_000) : tf.lookbackMs;
        const y = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.symbol)}?interval=${tf.yahoo}&period1=${Math.floor((now - back) / 1000)}&period2=${Math.floor(now / 1000)}`, UA);
        bars = parseYahooBars(y, tf.ms);
      }
    } catch (e) {
      return { status: 503, body: { error: `Keine Kerzen: ${msg(e).slice(0, 80)}` } };
    }
    bars = bars.slice(-limit);
    const last = bars[bars.length - 1];
    return { status: 200, body: {
      server_time: new Date().toISOString(), symbol: m.symbol, name: m.name, market: m.cls, tf: tfKey, tf_ms: tf.ms, source: m.cls === "crypto" ? "bybit" : "yahoo",
      delayed: m.cls === "forex", precision: precisionOf(m, last ? last[4] : 1), candles: bars,
      live: m.cls === "crypto" ? { url: "wss://stream.bybit.com/v5/public/spot", topics: [`kline.${tf.bybit}.${m.symbol}`, `tickers.${m.symbol}`] } : null,
    } };
  }

  if (body.action === "manual_open") {
    const m = marketOf(body.symbol);
    const side = body.side as Side;
    const amountRub = Number(body.amount_rub);
    if (!m) return { status: 400, body: { error: "Unbekannter Markt." } };
    if (side !== "long" && side !== "short") return { status: 400, body: { error: "Richtung fehlt." } };
    if (!(Number.isFinite(amountRub) && amountRub > 0 && amountRub <= 10_000_000)) return { status: 400, body: { error: "Betrag ungültig." } };
    let l: Live;
    try { l = await liveQuote(m, false); } catch (e) { return { status: 503, body: { error: `Kein aktueller Kurs: ${msg(e).slice(0, 80)}` } }; }
    await storeQuote(sql, m, l).catch(() => {}); // outside the transaction: a failure here must not touch the trade
    return await sql.begin(async (tx: any) => {
      const [ag] = await tx`select id, name, cash::float8 as cash from agent_core.agents
                            where mode = 'paper' and config->>'engine' = 'manual' order by created_at limit 1 for update`;
      if (!ag) return { status: 409, body: { error: "Es gibt noch kein eigenes Konto." } };
      const [opp] = await tx`select id from agent_core.positions where agent_id = ${ag.id} and symbol = ${m.symbol} and status = 'open' and side <> ${side} limit 1`;
      if (opp) return { status: 409, body: { error: `Du hast in ${m.name} schon eine Position in die andere Richtung. Schließe sie zuerst.` } };
      const p = plan(m, side, amountRub, usdrub, l.q, ag.cash, s.kill_switch === true, s.markets_enabled?.[m.cls] === true);
      if (!p.ok) return { status: 422, body: { error: p.error } };
      const [pos] = await tx`
        insert into agent_core.positions (agent_id, market, symbol, side, qty, entry_price, entry_fee, entry_notional, sl_price, tp_price, risk_usd, quality, setup_key, features, note)
        values (${ag.id}, ${m.cls}, ${m.symbol}, ${side}, ${p.qty}, ${p.fill}, ${p.fee}, ${p.notional}, null, null, ${p.notional * 0.1}, null, ${`${m.symbol}:${side}:manual`},
                ${tx.json({ source: "manual", amount_rub: amountRub, usdrub, bid: l.q.bid, ask: l.q.ask, mid: l.q.mid, quote_at: new Date(l.q.at).toISOString(), quote_source: l.source })},
                'Selbst gehandelt')
        returning id::int as id`;
      await tx`update agent_core.agents set cash = cash - ${p.notional + p.fee} where id = ${ag.id}`;
      const verb = side === "long" ? "gekauft" : "verkauft (short)";
      await tx`insert into agent_core.notifications (kind, agent_id, title, body, payload)
               values ('trade_opened', ${ag.id}, ${`${m.name} selbst ${verb}`}, ${`Einstieg ${p.fill.toPrecision(7)}, ${Math.round(p.notional * usdrub)} ₽ (${r6(p.notional)} USD), Gebühr ${r6(p.fee)} USD`},
                       ${tx.json({ symbol: m.symbol, side, entry: p.fill, notional: p.notional, fee: p.fee, manual: true })})`;
      return { status: 200, body: { ok: true, position_id: pos.id, symbol: m.symbol, side, entry_price: p.fill, qty: p.qty, notional_usd: p.notional, fee_usd: p.fee, amount_rub: p.notional * usdrub, usdrub } };
    });
  }

  if (body.action === "manual_close") {
    const id = Number(body.position_id);
    if (!Number.isInteger(id) || id <= 0) return { status: 400, body: { error: "position_id fehlt." } };
    const [peek] = await sql`select p.symbol from agent_core.positions p join agent_core.agents a on a.id = p.agent_id
                             where p.id = ${id} and p.status = 'open' and a.config->>'engine' = 'manual'`;
    if (!peek) return { status: 404, body: { error: "Diese Position ist nicht offen oder gehört nicht zu deinem Konto." } };
    const m = marketOf(peek.symbol);
    if (!m) return { status: 409, body: { error: "Markt nicht mehr handelbar." } };
    let l: Live;
    try { l = await liveQuote(m, false); } catch (e) { return { status: 503, body: { error: `Kein aktueller Kurs: ${msg(e).slice(0, 80)}` } }; }
    await storeQuote(sql, m, l).catch(() => {});
    if (!l.q.fresh) return { status: 422, body: { error: "Der Markt ist gerade geschlossen (Wochenende oder Feiertag). Schließen geht wieder, sobald er öffnet." } };
    return await sql.begin(async (tx: any) => {
      const [p] = await tx`select p.id::int as id, p.agent_id, p.side, p.qty::float8 as qty, p.entry_price::float8 as entry_price, p.entry_fee::float8 as entry_fee,
                                  p.entry_notional::float8 as entry_notional, p.risk_usd::float8 as risk_usd
                           from agent_core.positions p join agent_core.agents a on a.id = p.agent_id
                           where p.id = ${id} and p.status = 'open' and a.config->>'engine' = 'manual' for update of p`;
      if (!p) return { status: 404, body: { error: "Diese Position ist schon geschlossen." } };
      await tx`select id from agent_core.agents where id = ${p.agent_id} for update`;
      const r = settleClose(m, p.side, p.qty, p.entry_price, p.entry_notional, p.entry_fee, l.q);
      await tx`update agent_core.positions set status = 'closed', exit_price = ${r.px}, exit_time = now(), exit_fee = ${r.fee}, close_reason = 'manual',
               pnl_usd = ${r.net}, r_multiple = ${p.risk_usd > 0 ? r.net / p.risk_usd : null} where id = ${p.id}`;
      await tx`select agent_core.fn_after_close(${p.id}::bigint)`;
      await tx`update agent_core.agents set cash = cash + ${r.cashBack} where id = ${p.agent_id}`;
      await tx`insert into agent_core.notifications (kind, agent_id, title, body, payload)
               values ('trade_closed', ${p.agent_id}, ${`${m.name} selbst geschlossen`}, ${`Ergebnis ${r.net >= 0 ? "+" : "−"}${Math.abs(Math.round(r.net * usdrub))} ₽ (${r.net >= 0 ? "+" : ""}${r6(r.net)} USD) nach Kosten`},
                       ${tx.json({ symbol: m.symbol, side: p.side, exit_price: r.px, pnl_usd: r.net, manual: true })})`;
      return { status: 200, body: { ok: true, position_id: p.id, exit_price: r.px, fee_usd: r.fee, pnl_usd: r.net, pnl_rub: r.net * usdrub, usdrub } };
    });
  }
  return { status: 400, body: { error: "unknown action" } };
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
                 where status in ('stopped', 'halted') and mode = 'paper' and coalesce((config->'strategy'->>'retired')::boolean, false) = false
                   and coalesce(config->>'engine', 'minute') <> 'manual' and (${agentId}::uuid is null or id = ${agentId}::uuid)`;
      });
      await note("Start über das Dashboard", agentId ? "Agent gestartet (Simulation)." : "Alle Agenten gestartet (Simulation), Kill-Switch aus.");
      break;
    }
    case "stop": {
      await sql.begin(async (tx: any) => {
        await tx`update agent_core.agents set status = 'stopped' where status in ('active', 'halted') and mode = 'paper'
                 and coalesce(config->>'engine', 'minute') <> 'manual' and (${agentId}::uuid is null or id = ${agentId}::uuid)`;
        if (!agentId) await tx`update agent_core.settings set kill_switch = true where id`;
      });
      await note("Stopp über das Dashboard", agentId ? "Agent gestoppt, offene Positionen werden im nächsten Lauf geschlossen (spätestens nach 5 Minuten)." : "Alle Agenten gestoppt, Kill-Switch an. Offene Positionen werden im nächsten Lauf geschlossen (spätestens nach 5 Minuten).");
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
  const agentKey = req.headers.get("x-agent-secret");
  const tokenOk = !!token && token.length >= 20 && token.length <= 200;
  const keyOk = !!agentKey && agentKey.length >= 20 && agentKey.length <= 200;
  if (!tokenOk && !keyOk) return json(req, { error: "unauthorized" }, 401);

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    let role: "user" | "server" | null = null;
    if (tokenOk) {
      const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'dashboard_token_sha256'`;
      if (!secret) return json(req, { error: "dashboard token not configured" }, 503);
      if (safeEqual(await sha256hex(token!), secret.decrypted_secret)) role = "user";
    }
    if (!role && keyOk) {
      const [k] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret'`;
      if (k && safeEqual(agentKey!, k.decrypted_secret)) role = "server";
    }
    if (!role) return json(req, { error: "unauthorized" }, 401);
    const raw = await req.text();
    if (raw.length > 10_000) return json(req, { error: "body too large" }, 413);
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(req, { error: "bad json" }, 400);
    }
    if (role === "server" && body.action !== "manual_quote" && body.action !== "manual_chart") return json(req, { error: "server key: read-only market data only" }, 403);
    if (body.action === undefined || body.action === "overview") return json(req, await overview(sql, body.lite === true));
    if (body.action === "trades") {
      const r = await tradesPage(sql, body);
      return json(req, r.body, r.status);
    }
    if (typeof body.action === "string" && body.action.startsWith("manual_")) {
      const r = await manual(sql, body);
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
