// Smoke + invariant tests for sim.ts on synthetic candles (Node 22 type stripping).
import { simulate, aggregate15 } from "./sim.ts";

let fails = 0;
const ok = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL", name, extra); } else console.log("ok  ", name, extra); };

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

function makeCandles(days, seed, start = Date.UTC(2026, 8, 1)) {
  const r = rng(seed); const out = []; let p = 60000; let drift = 0;
  for (let i = 0; i < days * 1440; i++) {
    if (i % 300 === 0) drift = (r() - 0.5) * 0.0004; // trending regimes of 5 h
    const ret = drift + gauss(r) * 0.0004;
    const o = p, c = p * (1 + ret);
    const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0002), l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0002);
    out.push({ ts: start + i * 60000, o, h, l, c, v: 10 }); p = c;
  }
  return out;
}

const strat = { ema_fast: 20, ema_slow: 50, rsi_period: 14, atr_period: 14, rsi_long_cross: 45, rsi_short_cross: 55, atr_stop_mult: 1.5, rr: 2, min_edge_multiple: 3, min_quality: 60, max_hold_min: 240,
  bands: { crypto: { atr_pct_min: 0.0012, atr_pct_max: 0.015 } } };
const costs = { fee_bps: 10, slip_bps: 2, fallback_spread_bps: 3 };
const params = (c, extra = {}) => ({ fromMs: c[500].ts, toMs: c[c.length - 300].ts, strat, costs, risk: { risk_per_trade_pct: 1, max_position_pct: 25, min_notional_usd: 10, cooldown_after_stop_min: 15 }, spreadBps: 1, allowShort: false, capital: 10000, ...extra });

const c = makeCandles(30, 42);
const t0 = performance.now();
const a = simulate(c, params(c));
const ms = performance.now() - t0;
console.log(`30 days: minutes=${a.minutes} evaluated=${a.evaluated} trades=${a.trades.length} cpu_ms=${Math.round(ms)}`);
ok("produces trades", a.trades.length > 5);
ok("prefilter skips most minutes", a.evaluated < a.minutes * 0.3, `${a.evaluated}/${a.minutes}`);
const b = simulate(c, params(c));
ok("deterministic", JSON.stringify(a.trades) === JSON.stringify(b.trades));

let bad = 0, overlap = 0;
for (let i = 0; i < a.trades.length; i++) {
  const t = a.trades[i];
  if (Math.abs(t.net - (t.gross - t.fees)) > 1e-6) bad++;
  if (t.side !== "long") bad++;
  if (t.exitMs < t.entryMs) bad++;
  if (i > 0 && t.entryMs < a.trades[i - 1].exitMs) overlap++;
  if (t.reason === "stop" && !(t.r < -0.9 && t.r > -3)) bad++;
  if (t.reason === "target" && !(t.net > 0)) bad++;
  if (!(t.risk > 0) || !(t.qty > 0)) bad++;
}
ok("trade invariants", bad === 0, `bad=${bad}`);
ok("no overlapping positions", overlap === 0, `overlap=${overlap}`);
const reasons = Object.fromEntries(["stop", "target", "time", "end"].map((k) => [k, a.trades.filter((t) => t.reason === k).length]));
console.log("reasons", reasons, "net", a.trades.reduce((s, t) => s + t.net, 0).toFixed(2));
ok("all exit kinds present or plausible", reasons.stop + reasons.target + reasons.time + reasons.end === a.trades.length);

// stop-first when both levels are touched in one candle: build a single-position scenario by wide candle after entry
const wide = simulate(c, params(c, { strat: { ...strat, atr_stop_mult: 0.3, rr: 1, min_edge_multiple: 0 } }));
ok("tighter stop gives more stops", wide.trades.filter((t) => t.reason === "stop").length >= reasons.stop);

// cooldown: with a huge cooldown there are fewer trades
const cool = simulate(c, params(c, { risk: { ...params(c).risk, cooldown_after_stop_min: 100000 } }));
ok("huge cooldown reduces trades", cool.trades.length <= a.trades.length, `${cool.trades.length} <= ${a.trades.length}`);

// zero costs improves net on identical entries (same signals, costs only change fills and cost gate/min_edge off)
const free = simulate(c, params(c, { costs: { fee_bps: 0, slip_bps: 0, fallback_spread_bps: 0 }, spreadBps: 0 }));
const netA = a.trades.reduce((s, t) => s + t.net, 0), netF = free.trades.reduce((s, t) => s + t.net, 0);
ok("zero costs are better than costs", netF > netA, `${netF.toFixed(1)} > ${netA.toFixed(1)}`);

const agg = aggregate15(c.slice(0, 45));
ok("aggregate15 buckets", agg.length === 3 || agg.length === 4, String(agg.length));

console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
