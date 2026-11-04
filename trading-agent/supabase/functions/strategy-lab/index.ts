// strategy-lab: replays well-known candle strategies on stored Bybit history with the real cost model. SIMULATION ONLY, no orders.
// Auth: shared secret in header x-agent-secret (Supabase Vault secret agent_cron_secret); verify_jwt is off.
// Reads agent_core.hist_candles (1 min, 90 days) and agent_core.hist_bars (higher timeframes); writes agent_core.hist_bars and agent_core.lab_runs.
// Actions (JSON body): status | load_bars {symbol, tf, from_ms, to_ms} | run {tf, symbols?, ids?, split_ms?}
//                     | rulebook {tf: 240|1440, symbols?, from_ms?, save?}  -> portfolio test of the textbook rules (lab.ts rulebook)
//                     | study {tf, symbols, inverse?, rules, exits, from_ms, to_ms?, period_scale?, sizing?, label?, detail?, save?}
//                       -> the rules on many markets at once with different exits (study.ts)
// Markets: any Bybit spot pair ending in USDT; commodities and currencies from Yahoo (list YAHOO below), research only.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { type Bar, buyAndHold, catalogue, type Costs, portfolio, rulebook, simulate, stats, type Trade } from "./lab.ts";
import { type Exit, inverse, study } from "./study.ts";

const BYBIT = "https://api.bybit.com"; // public market data only, no key
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
// measured on the live Bybit order book (BTC/ETH/SOL 2026-10, the others 2026-11-04); unknown pairs: 3 bps
const SPREAD_BPS: Record<string, number> = {
  BTCUSDT: 0.012, ETHUSDT: 0.043, SOLUSDT: 0.99, XRPUSDT: 0.77, LINKUSDT: 0.88, BNBUSDT: 0.14, DOGEUSDT: 1.3, AVAXUSDT: 1.14,
  LTCUSDT: 1.79, ADAUSDT: 10.2, TRXUSDT: 3.13, DOTUSDT: 1.04, BCHUSDT: 0.36, XLMUSDT: 6.02, ATOMUSDT: 6.91,
};
// Yahoo markets (research only; not tradable on Bybit spot): futures of commodities and currency pairs.
// Assumed broker costs (CFD-like, no commission): spread in bps plus slippage. Overnight financing is NOT modelled.
const YAHOO: Record<string, { name: string; spreadBps: number; slipBps: number }> = {
  "GC=F": { name: "Gold", spreadBps: 3, slipBps: 2 }, "SI=F": { name: "Silber", spreadBps: 6, slipBps: 2 },
  "CL=F": { name: "Rohöl WTI", spreadBps: 5, slipBps: 2 }, "HG=F": { name: "Kupfer", spreadBps: 6, slipBps: 2 },
  "NG=F": { name: "Erdgas", spreadBps: 10, slipBps: 3 },
  "EURUSD=X": { name: "EUR/USD", spreadBps: 2, slipBps: 1 }, "GBPUSD=X": { name: "GBP/USD", spreadBps: 2.5, slipBps: 1 },
  "USDJPY=X": { name: "USD/JPY", spreadBps: 2, slipBps: 1 }, "AUDUSD=X": { name: "AUD/USD", spreadBps: 3, slipBps: 1 },
  "USDCHF=X": { name: "USD/CHF", spreadBps: 3, slipBps: 1 }, "USDCAD=X": { name: "USD/CAD", spreadBps: 3, slipBps: 1 },
};
const isBybit = (s: string) => /^[A-Z0-9]{2,20}USDT$/.test(s);
const baseOf = (s: string) => (s.startsWith("INV:") ? s.slice(4) : s);
function costsFor(sym: string): Costs {
  const s = baseOf(sym);
  if (YAHOO[s]) return { feeBps: 0, slipBps: YAHOO[s].slipBps, spreadBps: YAHOO[s].spreadBps };
  return { feeBps: FEE_BPS, slipBps: SLIP_BPS, spreadBps: SPREAD_BPS[s] ?? 3 };
}
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

/** Yahoo chart API: closed bars, daily bars on the UTC calendar day, hourly bars on the full hour. Yahoo keeps 1h bars for 730 days. */
async function yahooRange(symbol: string, tf: number, fromMs: number, toMs: number): Promise<number[][]> {
  const interval = tf === 1440 ? "1d" : "1h";
  const step = tf * 60000;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${Math.floor(fromMs / 1000)}&period2=${Math.floor(toMs / 1000)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let body: any;
  try {
    const res = await fetch(url, { headers: { "user-agent": "trading-sim-agent/0.1 (paper-trading research)" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const r = body?.chart?.result?.[0];
  if (!r) throw new Error(`yahoo: ${body?.chart?.error?.description ?? "no result"}`);
  const t: number[] = r.timestamp ?? [], q = r.indicators?.quote?.[0] ?? {};
  const out = new Map<number, number[]>();
  for (let i = 0; i < t.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) continue;
    const ts = Math.floor((t[i] * 1000) / step) * step;
    if (ts >= fromMs && ts + step <= toMs) out.set(ts, [ts, o, h, l, c, q.volume?.[i] ?? 0]); // the last bar of a day/hour wins
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}

async function loadBars(sql: any, b: any) {
  const symbol = String(b.symbol), tf = Number(b.tf), fromMs = Number(b.from_ms), toMs = Number(b.to_ms);
  const yahoo = !!YAHOO[symbol];
  if (!yahoo && !isBybit(symbol)) return json({ error: "symbol not allowed (Bybit spot ...USDT or one of the Yahoo markets)" }, 400);
  if (!TFS.has(tf) || (yahoo && tf !== 60 && tf !== 1440)) return json({ error: "tf must be 5, 15, 60, 240 or 1440 (Yahoo: 60 or 1440)" }, 400);
  if (!(fromMs > 0) || !(toMs > fromMs)) return json({ error: "bad range" }, 400);
  if (toMs > Date.now() - 2 * tf * 60000) return json({ error: "to_ms must be at least two bars in the past" }, 400);
  const rows = yahoo ? await yahooRange(symbol, tf, fromMs, toMs) : await bybitRange(symbol, tf, fromMs, toMs);
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

async function barsOf(sql: any, symbol: string, tf: number, sinceMs = 0): Promise<Bar[]> {
  const rows = tf >= 60
    ? await sql`select (extract(epoch from open_time) * 1000)::float8 as ts, o, h, l, c, v from agent_core.hist_bars
                where symbol = ${symbol} and tf = ${tf} and open_time >= to_timestamp(${sinceMs / 1000}) order by open_time`
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

// Multi-market study. Every combination of rule x exit is one portfolio over all given markets (equal share each, scaled down
// by volatility with sizing "vol"). "hold" as rule is the buy-and-hold benchmark of the same markets.
async function studyRun(sql: any, b: any) {
  const tf = Number(b.tf);
  if (tf !== 60 && tf !== 240 && tf !== 1440) return json({ error: "tf must be 60, 240 or 1440" }, 400);
  const syms: string[] = Array.isArray(b.symbols) ? b.symbols.filter((s: unknown) => typeof s === "string" && (YAHOO[s] || isBybit(s))) : [];
  const inv: string[] = Array.isArray(b.inverse) ? b.inverse.filter((s: unknown) => typeof s === "string" && syms.includes(s)) : [];
  if (!syms.length || syms.length > 40) return json({ error: "1..40 symbols" }, 400);
  const periodScale = Number(b.period_scale ?? 1440 / tf); // 1 = rule periods count in bars ("55 days" becomes 55 bars)
  const rules = (Array.isArray(b.rules) ? b.rules : []).map((id: unknown) => (id === "hold" ? "hold" : rulebook(periodScale).find((r) => r.id === id))).filter(Boolean);
  const exits: Exit[] = (Array.isArray(b.exits) ? b.exits : [{ id: "regel" }]).filter((e: any) => typeof e?.id === "string").slice(0, 12);
  if (!rules.length || rules.length * exits.length > 60) return json({ error: "1..60 combinations of rules and exits" }, 400);
  const fromMs = Number(b.from_ms), toMs = Number(b.to_ms) || Infinity;
  if (!(fromMs > 0)) return json({ error: "from_ms required" }, 400);
  const data: Record<string, Bar[]> = {};
  const missing: string[] = [];
  // only the bars the rules need: the period plus a warm-up of 260 rule days (200-day rules, ATR, volatility)
  const sinceMs = fromMs - Math.ceil(260 * periodScale) * tf * 60000;
  for (const s of syms) {
    const bars = await barsOf(sql, s, tf, sinceMs);
    if (bars.length < 50) { missing.push(s); continue; }
    data[s] = bars;
    if (inv.includes(s)) data[`INV:${s}`] = inverse(bars);
  }
  const cfg = { sizing: b.sizing === "vol" ? "vol" as const : "equal" as const, refVol: 0.6, volDays: 30, periodScale, capital: 10000 };
  const t0 = performance.now();
  const results: any[] = [];
  for (const r of rules) {
    for (const e of exits) {
      const res = study(data, r as any, e, cfg, costsFor, fromMs, toMs);
      results.push({ rule: r === "hold" ? "hold" : (r as any).id, exit: e.id, metrics: res.metrics, years: res.years, halves: res.halves, exits: res.exits, ...(b.detail ? { by_symbol: res.bySymbol } : {}) });
    }
  }
  const out = {
    kind: "study_v1", label: typeof b.label === "string" ? b.label.slice(0, 80) : null, tf, period_scale: periodScale, sizing: cfg.sizing,
    from: new Date(fromMs).toISOString(), to: Number.isFinite(toMs) ? new Date(toMs).toISOString() : null,
    markets: Object.fromEntries(Object.entries(data).map(([s, x]) => [s, { n: x.length, first: new Date(x[0].ts).toISOString(), last: new Date(x[x.length - 1].ts).toISOString(), costs: costsFor(s) }])),
    missing, exits_def: exits, sim_ms: Math.round(performance.now() - t0), results,
  };
  if (b.save !== false) await sql`insert into agent_core.lab_runs (tf, split_at, note, result) values (${tf}, null, ${`study_v1: ${out.label ?? ""}`.slice(0, 200)}, ${sql.json(out)})`;
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
    if (body?.action === "study") return await studyRun(sql, body);
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error("strategy-lab failed", e);
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
