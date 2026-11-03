// backtest: replays the live strategy (strategy.ts) on stored Bybit public 1m history. SIMULATION ONLY.
// Writes only to agent_core.hist_candles and agent_core.bt_trades. No exchange keys, no orders.
// Auth: shared secret in header x-agent-secret (Vault secret agent_cron_secret); verify_jwt is off.
// Body: { action: "fetch", symbol, days?, pages? }                      -> pages 1m history backwards from the oldest stored candle
//       { action: "run", run_id, symbol, from_ms, to_ms, strategy?, risk?, costs?, spread_bps?, allow_short?, capital? }
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { type Candle, MINUTE } from "./lib.ts";
import { type CostCfg, type StratCfg } from "./strategy.ts";
import { simulate } from "./sim.ts";

const BYBIT = "https://api.bybit.com";
// median measured spreads of the live agent over the last 7 days (bps), used when the request gives none
const DEFAULT_SPREAD: Record<string, number> = { BTCUSDT: 0.012, ETHUSDT: 0.043, SOLUSDT: 0.99 };
const SYMBOL_RE = /^[A-Z0-9]{5,12}$/;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number) => new Date(ms).toISOString();
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function fetchPage(symbol: string, endMs: number): Promise<Candle[]> {
  const startMs = endMs - 999 * MINUTE;
  const url = `${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=1&start=${startMs}&end=${endMs}&limit=1000`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.retCode !== 0) throw new Error(`bybit HTTP ${res.status} retCode=${body?.retCode} ${body?.retMsg ?? ""}`);
    const now = Date.now();
    return (body.result.list as string[][])
      .map((x) => ({ ts: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) }))
      .filter((x) => [x.ts, x.o, x.h, x.l, x.c].every(Number.isFinite) && x.ts + MINUTE <= now);
  } finally {
    clearTimeout(timer);
  }
}

async function doFetch(sql: any, b: any) {
  const symbol = String(b.symbol ?? "");
  if (!SYMBOL_RE.test(symbol)) return { error: "bad symbol" };
  const days = clamp(Number(b.days ?? 90), 1, 400);
  const pages = clamp(Math.floor(Number(b.pages ?? 30)), 1, 80);
  const target = Date.now() - days * 86400000;
  const t0 = Date.now();
  const [mn] = await sql`select (extract(epoch from min(open_time)) * 1000)::float8 as ms from agent_core.hist_candles where symbol = ${symbol}`;
  let end = mn?.ms ? mn.ms - MINUTE : (Math.floor(Date.now() / MINUTE) - 1) * MINUTE;
  let got = 0;
  let pagesDone = 0;
  let stop = "pages_done";
  for (let p = 0; p < pages; p++) {
    if (end < target) { stop = "target_reached"; break; }
    if (Date.now() - t0 > 100_000) { stop = "time_budget"; break; }
    const rows = await fetchPage(symbol, end);
    pagesDone++;
    if (!rows.length) { stop = "no_more_history"; break; }
    const recs = rows.map((x) => ({ symbol, open_time: iso(x.ts), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
    await sql`insert into agent_core.hist_candles ${sql(recs, "symbol", "open_time", "o", "h", "l", "c", "v")} on conflict (symbol, open_time) do nothing`;
    got += rows.length;
    end = Math.min(...rows.map((x) => x.ts)) - MINUTE;
  }
  const [st] = await sql`select count(*)::int as n, min(open_time) as first_c, max(open_time) as last_c from agent_core.hist_candles where symbol = ${symbol}`;
  return { symbol, fetched: got, pages: pagesDone, stop, total: st.n, first: st.first_c, last: st.last_c };
}

async function doRun(sql: any, b: any) {
  const runId = String(b.run_id ?? "").slice(0, 60);
  const symbol = String(b.symbol ?? "");
  const fromMs = Number(b.from_ms);
  const toMs = Number(b.to_ms);
  if (!runId || !SYMBOL_RE.test(symbol) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return { error: "bad params" };
  const [ag] = await sql`select config from agent_core.agents order by created_at limit 1`;
  const base = ag?.config ?? {};
  const strat = { ...base.strategy, ...(b.strategy ?? {}) } as StratCfg;
  const risk = { ...base.risk, ...(b.risk ?? {}) };
  const cc = { ...(base.costs?.crypto ?? { fee_bps: 10, slip_bps: 2, fallback_spread_bps: 3 }), ...(b.costs ?? {}) } as CostCfg;
  const spreadBps = Number.isFinite(Number(b.spread_bps)) ? Number(b.spread_bps) : (DEFAULT_SPREAD[symbol] ?? cc.fallback_spread_bps);
  const capital = Number.isFinite(Number(b.capital)) ? Number(b.capital) : 10000;

  const warm = 400 * MINUTE;
  const tail = 260 * MINUTE;
  const rows: any[] = await sql`
    select (extract(epoch from open_time) * 1000)::float8 as ts, o, h, l, c, v
    from agent_core.hist_candles
    where symbol = ${symbol} and open_time >= ${iso(fromMs - warm)} and open_time <= ${iso(toMs + tail)}
    order by open_time`;
  const c1: Candle[] = rows.map((r) => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
  if (c1.length < 400) return { error: "not enough candles", candles: c1.length };

  const res = simulate(c1, { fromMs, toMs, strat, costs: cc, risk, spreadBps, allowShort: b.allow_short === true, capital });

  await sql`delete from agent_core.bt_trades where run_id = ${runId} and symbol = ${symbol} and entry_time >= ${iso(fromMs)} and entry_time < ${iso(toMs + 3 * MINUTE)}`;
  if (res.trades.length) {
    const recs = res.trades.map((t) => ({
      run_id: runId, symbol, side: t.side, entry_time: iso(t.entryMs), exit_time: iso(t.exitMs), entry_price: t.entryPx, exit_price: t.exitPx,
      qty: t.qty, quality: t.quality, reason: t.reason, gross_usd: t.gross, fees_usd: t.fees, net_usd: t.net, r: t.r, risk_usd: t.risk,
    }));
    await sql`insert into agent_core.bt_trades ${sql(recs, "run_id", "symbol", "side", "entry_time", "exit_time", "entry_price", "exit_price", "qty", "quality", "reason", "gross_usd", "fees_usd", "net_usd", "r", "risk_usd")}`;
  }
  const net = res.trades.reduce((s, t) => s + t.net, 0);
  return { run_id: runId, symbol, candles: c1.length, evaluated: res.evaluated, trades: res.trades.length, wins: res.trades.filter((t) => t.net > 0).length, net: Math.round(net * 100) / 100 };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const provided = req.headers.get("x-agent-secret");
  if (!provided) return json({ error: "unauthorized" }, 401);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret'`;
    if (!secret || !safeEqual(provided, secret.decrypted_secret)) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body?.action === "fetch") return json(await doFetch(sql, body));
    if (body?.action === "run") return json(await doRun(sql, body));
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("backtest failed", e);
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
