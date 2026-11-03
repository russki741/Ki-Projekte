// strategy-lab: replays well-known candle strategies on stored Bybit history with the real cost model. SIMULATION ONLY, no orders.
// Auth: shared secret in header x-agent-secret (Supabase Vault secret agent_cron_secret); verify_jwt is off.
// Reads agent_core.hist_candles (1 min, 90 days) and agent_core.hist_bars (higher timeframes); writes agent_core.hist_bars and agent_core.lab_runs.
// Actions (JSON body): status | load_bars {symbol, tf, from_ms, to_ms} | run {tf, symbols?, ids?, split_ms?}
//                     | rulebook {tf: 240|1440, symbols?, from_ms?, save?}  -> portfolio test of the textbook rules (lab.ts rulebook)
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { type Bar, buyAndHold, catalogue, type Costs, portfolio, rulebook, simulate, stats, type Trade } from "./lab.ts";

const BYBIT = "https://api.bybit.com"; // public market data only, no key
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const SPREAD_BPS: Record<string, number> = { BTCUSDT: 0.012, ETHUSDT: 0.043, SOLUSDT: 0.99 }; // measured on the live order book
const FEE_BPS = 10, SLIP_BPS = 2; // same as the live paper engine (spot taker 0.1 %)
const TFS = new Set([5, 15, 60, 240, 1440]);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function bybitRange(symbol: string, tf: number, fromMs: number, toMs: number): Promise<number[][]> {
  const step = tf * 60000;
  const out: number[][] = [];
  let end = toMs - 1;
  for (let page = 0; page < 120; page++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let body: any;
    try {
      const res = await fetch(`${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${tf === 1440 ? "D" : tf}&start=${fromMs}&end=${end}&limit=1000`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (body?.retCode !== 0) throw new Error(`retCode=${body?.retCode} ${body?.retMsg ?? ""}`);
    const list: string[][] = body.result?.list ?? [];
    if (!list.length) break;
    for (const x of list) {
      const ts = Number(x[0]);
      if (ts >= fromMs && ts + step <= toMs) out.push([ts, Number(x[1]), Number(x[2]), Number(x[3]), Number(x[4]), Number(x[5])]);
    }
    const oldest = Number(list[list.length - 1][0]);
    if (!(oldest > fromMs)) break;
    end = oldest - 1;
    await sleep(120);
  }
  return out.filter((r) => r.every(Number.isFinite));
}

async function loadBars(sql: any, b: any) {
  const symbol = String(b.symbol), tf = Number(b.tf), fromMs = Number(b.from_ms), toMs = Number(b.to_ms);
  if (!SYMBOLS.includes(symbol)) return json({ error: "symbol not allowed" }, 400);
  if (!TFS.has(tf)) return json({ error: "tf must be 5, 15, 60, 240 or 1440" }, 400);
  if (!(fromMs > 0) || !(toMs > fromMs)) return json({ error: "bad range" }, 400);
  if (toMs > Date.now() - 2 * tf * 60000) return json({ error: "to_ms must be at least two bars in the past" }, 400);
  const rows = await bybitRange(symbol, tf, fromMs, toMs);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 4000) {
    const r = await sql`
      insert into agent_core.hist_bars (symbol, tf, open_time, o, h, l, c, v)
      select ${symbol}, ${tf}, to_timestamp((x->>0)::float8 / 1000.0), (x->>1)::float8, (x->>2)::float8, (x->>3)::float8, (x->>4)::float8, (x->>5)::float8
      from jsonb_array_elements(${sql.json(rows.slice(i, i + 4000))}::jsonb) x
      on conflict (symbol, tf, open_time) do nothing returning 1`;
    inserted += r.length;
  }
  return json({ ok: true, symbol, tf, fetched: rows.length, inserted });
}

async function status(sql: any) {
  const hb = await sql`select symbol, tf, count(*)::int as n, min(open_time) as first, max(open_time) as last from agent_core.hist_bars group by symbol, tf order by symbol, tf`;
  const hc = await sql`select symbol, count(*)::int as n, min(open_time) as first, max(open_time) as last from agent_core.hist_candles group by symbol order by symbol`;
  return json({ hist_bars: hb, hist_candles_1m: hc });
}

async function barsOf(sql: any, symbol: string, tf: number): Promise<Bar[]> {
  const rows = tf >= 60
    ? await sql`select (extract(epoch from open_time) * 1000)::float8 as ts, o, h, l, c, v from agent_core.hist_bars where symbol = ${symbol} and tf = ${tf} order by open_time`
    : await sql`
        select (extract(epoch from b) * 1000)::float8 as ts, o, h, l, c, v from (
          select date_bin(${tf}::int * interval '1 minute', open_time, timestamptz '2026-01-01') as b,
                 (array_agg(o order by open_time))[1] as o, max(h) as h, min(l) as l, (array_agg(c order by open_time desc))[1] as c, sum(v) as v, count(*)::int as n
          from agent_core.hist_candles where symbol = ${symbol} group by 1) t
        where n = ${tf}::int order by b`;
  return rows.map((r: any) => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
}

const pick = (s: ReturnType<typeof stats>) => ({ n: s.n, net: s.net_bps, gross: s.gross_bps, win: s.win_pct, t: s.t });

async function run(sql: any, b: any) {
  const tf = Number(b.tf);
  if (!TFS.has(tf)) return json({ error: "tf must be 5, 15, 60 or 240" }, 400);
  const symbols: string[] = (Array.isArray(b.symbols) ? b.symbols : SYMBOLS).filter((s: unknown) => typeof s === "string" && SYMBOLS.includes(s));
  const ids: string[] | null = Array.isArray(b.ids) ? b.ids : null;
  const strats = catalogue().filter((s) => !ids || ids.includes(s.id));
  const data: Record<string, Bar[]> = {};
  for (const s of symbols) {
    data[s] = await barsOf(sql, s, tf);
    if (data[s].length < 500) return json({ error: `not enough bars for ${s} tf=${tf}: ${data[s].length}` }, 400);
  }
  const lastTs = Math.min(...symbols.map((s) => data[s][data[s].length - 1].ts));
  const split = Number(b.split_ms) || lastTs - (tf >= 60 ? 365 : 30) * 86400_000;
  const t0 = performance.now();
  const costsOf = (s: string): Costs => ({ feeBps: FEE_BPS, slipBps: SLIP_BPS, spreadBps: SPREAD_BPS[s] });

  // benchmark: buy once at the start of each period (long-only drift of the market in that period)
  const bench: Record<string, unknown> = {};
  for (const s of symbols) {
    const bars = data[s];
    const k = bars.findIndex((x) => x.ts >= split);
    const trainB = buyAndHold(bars.slice(0, k), costsOf(s)), testB = buyAndHold(bars.slice(k), costsOf(s));
    bench[s] = { train_gross_bps: Math.round(trainB[0]?.grossBps ?? 0), test_gross_bps: Math.round(testB[0]?.grossBps ?? 0) };
  }

  const results: any[] = [];
  for (const st of strats) {
    const per: Record<string, { train: Trade[]; test: Trade[] }> = {};
    const all: Trade[] = [];
    for (const s of symbols) {
      const trades = simulate(data[s], st.build(data[s]), costsOf(s));
      per[s] = { train: trades.filter((x) => x.entryTs < split), test: trades.filter((x) => x.entryTs >= split) };
      all.push(...trades);
    }
    const pool = (key: "train" | "test") => symbols.flatMap((s) => per[s][key]);
    const years: Record<string, ReturnType<typeof pick>> = {};
    if (tf >= 60) {
      const ys = new Set(all.map((x) => new Date(x.entryTs).getUTCFullYear()));
      for (const y of [...ys].sort()) years[y] = pick(stats(all.filter((x) => new Date(x.entryTs).getUTCFullYear() === y)));
    }
    const reasons: Record<string, number> = {};
    for (const x of all) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
    results.push({
      id: st.id, family: st.family,
      train: pick(stats(pool("train"))), test: pick(stats(pool("test"))), all: pick(stats(all)),
      per_symbol: Object.fromEntries(symbols.map((s) => [s, { train: pick(stats(per[s].train)), test: pick(stats(per[s].test)) }])),
      years, exits: reasons,
    });
  }
  return json({
    tf, split: new Date(split).toISOString(), costs: { fee_bps: FEE_BPS, slip_bps: SLIP_BPS, spread_bps: SPREAD_BPS },
    bars: Object.fromEntries(symbols.map((s) => [s, { n: data[s].length, first: new Date(data[s][0].ts).toISOString(), last: new Date(data[s][data[s].length - 1].ts).toISOString() }])),
    benchmark_buy_and_hold: bench, sim_ms: Math.round(performance.now() - t0), configs_tested: results.length, results,
  });
}

// Portfolio test of the rulebook. Selection rule fixed BEFORE looking at results: a rule "passes" when, against holding the
// same coins, it has a higher Sharpe ratio, at most 60 % of the maximum drawdown, and a positive result in at least 60 % of the years.
async function rulebookRun(sql: any, b: any) {
  const tf = Number(b.tf);
  if (tf !== 240 && tf !== 1440) return json({ error: "tf must be 240 or 1440" }, 400);
  const symbols: string[] = (Array.isArray(b.symbols) ? b.symbols : SYMBOLS).filter((s: unknown) => typeof s === "string" && SYMBOLS.includes(s));
  const data: Record<string, Bar[]> = {};
  for (const s of symbols) {
    data[s] = await barsOf(sql, s, tf);
    if (data[s].length < 300) return json({ error: `not enough bars for ${s} tf=${tf}: ${data[s].length}` }, 400);
  }
  const barsPerDay = 1440 / tf;
  const fromMs = Number(b.from_ms) || -Infinity;
  const costsOf = (s: string): Costs => ({ feeBps: FEE_BPS, slipBps: SLIP_BPS, spreadBps: SPREAD_BPS[s] });
  const base = { refVol: 0.6, volDays: 30, barsPerDay, capital: 10000 };
  // rules need 200 days of history before the first decision; the benchmark starts at the same moment
  const firstTs = Math.max(...symbols.map((s) => data[s][0].ts)) + 210 * 86400_000;
  const start = Math.max(fromMs, firstTs);
  const t0 = performance.now();
  const hold = portfolio(data, "hold", { ...base, sizing: "equal" }, costsOf, start);
  const holdBtc = symbols.includes("BTCUSDT") ? portfolio({ BTCUSDT: data.BTCUSDT }, "hold", { ...base, sizing: "equal" }, costsOf, start) : null;
  const yearsPos = (y: Record<string, number>) => { const v = Object.values(y); return v.length ? v.filter((x) => x > 0).length / v.length : 0; };
  const results: any[] = [];
  for (const r of rulebook(barsPerDay)) {
    for (const sizing of ["equal", "vol"] as const) {
      const res = portfolio(data, r, { ...base, sizing }, costsOf, start);
      const m = res.metrics;
      const passes = m.sharpe > hold.metrics.sharpe && m.max_dd_pct <= 0.6 * hold.metrics.max_dd_pct && yearsPos(res.years) >= 0.6;
      results.push({ id: r.id, name: r.name, source: r.source, sizing, metrics: m, years: res.years, positive_years_pct: Math.round(yearsPos(res.years) * 100), passes });
    }
  }
  results.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
  const out = {
    kind: "rulebook_v2", tf, symbols, start: new Date(start).toISOString(),
    end: new Date(Math.min(...symbols.map((s) => data[s][data[s].length - 1].ts))).toISOString(),
    costs: { fee_bps: FEE_BPS, slip_bps: SLIP_BPS, spread_bps: SPREAD_BPS }, sizing: base,
    selection_rule: "Sharpe > Halten, max. Rückgang <= 60 % von Halten, mindestens 60 % der Jahre positiv",
    benchmark: { hold_equal: { metrics: hold.metrics, years: hold.years }, hold_btc: holdBtc ? { metrics: holdBtc.metrics, years: holdBtc.years } : null },
    sim_ms: Math.round(performance.now() - t0), results,
  };
  if (b.save !== false) await sql`insert into agent_core.lab_runs (tf, split_at, note, result) values (${tf}, null, ${"rulebook v2: textbook rules, portfolio simulation, costs fee 10 + slip 2 + spread per fill"}, ${sql.json(out)})`;
  return json(out);
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
    if (body?.action === "status") return await status(sql);
    if (body?.action === "load_bars") return await loadBars(sql, body);
    if (body?.action === "run") return await run(sql, body);
    if (body?.action === "rulebook") return await rulebookRun(sql, body);
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("strategy-lab failed", e);
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
