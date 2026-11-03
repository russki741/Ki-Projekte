import { test } from "node:test";
import assert from "node:assert/strict";
import { type Candle, MINUTE, atr, ema, rsi } from "./lib.ts";
import {
  type CostCfg,
  type StratCfg,
  checkExit,
  entryFill,
  evaluateSetup,
  exitFill,
  gapCount,
  positionValue,
  roundTripCostBps,
  sessionOf,
  setupKey,
  sizeQty,
  tradePnl,
} from "./strategy.ts";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b} (tol ${tol})`);

const STRAT: StratCfg = {
  ema_fast: 20,
  ema_slow: 50,
  rsi_period: 14,
  atr_period: 14,
  rsi_long_cross: 45,
  rsi_short_cross: 55,
  atr_stop_mult: 1.5,
  rr: 2,
  min_edge_multiple: 3,
  min_quality: 60,
  max_hold_min: 240,
  bands: { crypto: { atr_pct_min: 0.0012, atr_pct_max: 0.015 }, forex: { atr_pct_min: 0.0002, atr_pct_max: 0.004 } },
};
const CRYPTO_COSTS: CostCfg = { fee_bps: 10, slip_bps: 2, fallback_spread_bps: 3 };
const FX_COSTS: CostCfg = { fee_bps: 0, slip_bps: 0.5, fallback_spread_bps: 0.9 };

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0); // 2026-10-21 09:00 UTC (a Wednesday), aligned to 15m

function bars(n: number, stepMs: number, start: number, step: number, range: number, t0 = T0): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  for (let k = 0; k < n; k++) {
    const c = prev + step;
    out.push({ ts: t0 + k * stepMs, o: prev, h: Math.max(prev, c) + range, l: Math.min(prev, c) - range, c, v: 10 });
    prev = c;
  }
  return out;
}
function appendCloses(c: Candle[], closes: number[], range: number): Candle[] {
  const out = [...c];
  for (const x of closes) {
    const last = out[out.length - 1];
    out.push({ ts: last.ts + MINUTE, o: last.c, h: Math.max(last.c, x) + range, l: Math.min(last.c, x) - range, c: x, v: 10 });
  }
  return out;
}

// 15m trend of n bars, the newest closed bar ends before `now`
function trend15(n: number, start: number, step: number, range: number): Candle[] {
  return bars(n, 15 * MINUTE, start, step, range);
}

/** 1m series ending exactly `extra` candles after the first candle whose RSI crosses back through `th` (long, up). */
function longTrigger1m(base: number, th: number, extra: number, t0: number): { c1: Candle[]; cross: number } {
  let c = bars(60, MINUTE, base, 0.01 * base * 0.01, 0.0001 * base, t0); // gentle drift up
  c = appendCloses(c, Array.from({ length: 8 }, (_, k) => c[c.length - 1].c - (k + 1) * 0.0004 * base), 0.0001 * base); // dip
  let n = 0;
  for (;;) {
    const last = c[c.length - 1].c;
    c = appendCloses(c, [last + 0.0003 * base], 0.0001 * base);
    n++;
    const r = rsi(c.map((x) => x.c), 14);
    if (r[r.length - 1] >= th && r[r.length - 2] < th) break;
    assert.ok(n < 60, "RSI never crossed");
  }
  const cross = c.length - 1;
  for (let k = 0; k < extra; k++) c = appendCloses(c, [c[c.length - 1].c + 0.0003 * base], 0.0001 * base);
  return { c1: c, cross };
}

function setup15For(c1: Candle[], start: number, step: number, range: number): Candle[] {
  // 15m series whose newest bar closes at or just before the last 1m candle's close time
  const lastClose = c1[c1.length - 1].ts + MINUTE;
  const n = 80;
  const t0 = Math.floor((lastClose - 15 * MINUTE) / (15 * MINUTE)) * 15 * MINUTE - (n - 1) * 15 * MINUTE;
  return bars(n, 15 * MINUTE, start, step, range, t0);
}

const baseArgs = (market: string, c1: Candle[], c15: Candle[], costs: CostCfg, allowShort = false) => ({
  market,
  c1,
  c15,
  nowMs: c1[c1.length - 1].ts + MINUTE + 5000, // 5 s after the last close
  spreadBps: costs.fallback_spread_bps,
  spreadSource: "assumed" as const,
  strat: STRAT,
  costs,
  allowShort,
  maxLagS: 180,
  maxGapMin: 0,
});

test("cost, session and key helpers", () => {
  near(roundTripCostBps(CRYPTO_COSTS, 3), 2 * 10 + 3 + 2 * 2);
  near(roundTripCostBps(FX_COSTS, 0.9), 0 + 0.9 + 1);
  assert.equal(sessionOf(Date.UTC(2026, 9, 21, 3, 0)), "asia");
  assert.equal(sessionOf(Date.UTC(2026, 9, 21, 9, 30)), "eu");
  assert.equal(sessionOf(Date.UTC(2026, 9, 21, 20, 0)), "us");
  assert.equal(setupKey("BTCUSDT", "long", Date.UTC(2026, 9, 21, 9, 30)), "BTCUSDT:long:eu");
  const c = bars(10, MINUTE, 100, 0.1, 0.05);
  assert.equal(gapCount(c, 30), 0);
  const holes = [...c.slice(0, 4), ...c.slice(6)]; // two minutes missing
  assert.equal(gapCount(holes, 30), 2);
});

test("fills: entry at ask/bid with slippage, exit pays half spread plus slippage", () => {
  near(entryFill("long", 100, 100.1, 2), 100.1 * 1.0002);
  near(entryFill("short", 100, 100.1, 2), 100 * 0.9998);
  near(exitFill("long", 110, 4, 1), 110 * (1 - 3e-4));
  near(exitFill("short", 90, 4, 1), 90 * (1 + 3e-4));
});

test("pnl by hand: long and short, fees subtracted", () => {
  // long: buy 2 @ 100, sell @ 110, fees 0.2 + 0.22 -> gross 20, net 19.58
  const l = tradePnl("long", 100, 2, 0.2, 110, 0.22);
  near(l.gross, 20);
  near(l.net, 19.58);
  // short: sell 2 @ 100, buy back @ 90 -> gross 20; price rising is a loss
  near(tradePnl("short", 100, 2, 0.2, 90, 0.18).net, 20 - 0.38);
  near(tradePnl("short", 100, 2, 0, 105, 0).gross, -10);
  near(positionValue("long", 200, 100, 2, 105), 210);
  near(positionValue("short", 200, 100, 2, 105), 190);
});

test("sizing: the binding limit wins; min notional is enforced", () => {
  const base = { equity: 10000, cash: 9000, riskPct: 1, maxPositionPct: 25, minNotional: 10 };
  // risk 100 / stop 0.5 = 200 units, cap 2500/100 = 25, cash 9000/101 = 89 -> cap
  const a = sizeQty({ ...base, price: 100, stopDist: 0.5 }) as { qty: number; limit: string };
  assert.equal(a.limit, "position_cap");
  near(a.qty, 25);
  // risk 100 / stop 20 = 5 units -> risk
  const b = sizeQty({ ...base, price: 100, stopDist: 20 }) as { qty: number; limit: string };
  assert.equal(b.limit, "risk");
  near(b.qty, 5);
  // little cash left -> cash
  const c = sizeQty({ ...base, cash: 303, price: 100, stopDist: 0.5 }) as { qty: number; limit: string };
  assert.equal(c.limit, "cash");
  near(c.qty, Math.floor((303 / 101) * 1e6) / 1e6);
  // risk 100 / stop 2000 = 0.05 units * 100 = 5 USD < 10
  assert.deepEqual(sizeQty({ ...base, price: 100, stopDist: 2000 }), { reason: "min_notional" });
  assert.deepEqual(sizeQty({ ...base, price: 100, stopDist: 0 }), { reason: "bad_inputs" });
});

test("exit: long stop / target / gap / both touched -> stop; entry minute is ignored", () => {
  const entryMs = T0 + 30_000; // entered 30 s into the minute that starts at T0
  const mk = (k: number, o: number, h: number, l: number, c: number): Candle => ({ ts: T0 + k * MINUTE, o, h, l, c, v: 1 });
  const long = { side: "long" as const, sl: 99, tp: 102, entryMs };
  // candle 0 contains the entry moment: even a low of 90 there must NOT count
  assert.equal(checkExit(long, [mk(0, 100, 101, 90, 100)]), null);
  assert.deepEqual(checkExit(long, [mk(1, 100, 101, 98.5, 99.5)]), { raw: 99, reason: "stop", ts: T0 + MINUTE });
  assert.deepEqual(checkExit(long, [mk(1, 100, 102.5, 99.5, 102)]), { raw: 102, reason: "target", ts: T0 + MINUTE });
  assert.deepEqual(checkExit(long, [mk(1, 98, 100, 97, 99)]), { raw: 98, reason: "stop", ts: T0 + MINUTE }); // gap below stop: open
  assert.deepEqual(checkExit(long, [mk(1, 103, 104, 102.5, 103)]), { raw: 103, reason: "target", ts: T0 + MINUTE }); // gap above target
  assert.deepEqual(checkExit(long, [mk(1, 100, 103, 98, 100)]), { raw: 99, reason: "stop", ts: T0 + MINUTE }); // both: stop first
  assert.equal(checkExit(long, [mk(1, 100, 101, 99.5, 100.5), mk(2, 100.5, 101.5, 100, 101)]), null);
  // short is the mirror image
  const short = { side: "short" as const, sl: 101, tp: 98, entryMs };
  assert.deepEqual(checkExit(short, [mk(1, 100, 101.5, 99.5, 100)]), { raw: 101, reason: "stop", ts: T0 + MINUTE });
  assert.deepEqual(checkExit(short, [mk(1, 100, 100.5, 97.5, 98)]), { raw: 98, reason: "target", ts: T0 + MINUTE });
  assert.deepEqual(checkExit(short, [mk(1, 102, 103, 101.5, 102)]), { raw: 102, reason: "stop", ts: T0 + MINUTE }); // gap above stop
  assert.deepEqual(checkExit(short, [mk(1, 100, 102, 97, 100)]), { raw: 101, reason: "stop", ts: T0 + MINUTE }); // both: stop first
});

test("long pullback setup: RSI re-cross in an uptrend gives an entry with a consistent plan", () => {
  const { c1 } = longTrigger1m(124, 45, 0, T0 + 6 * 3600_000);
  const c15 = setup15For(c1, 100, 0.3, 0.2);
  const a = baseArgs("crypto", c1, c15, CRYPTO_COSTS);
  // sanity: the construction really is an uptrend with the dip on 1m
  const e20 = ema(c15.map((x) => x.c), 20);
  const e50 = ema(c15.map((x) => x.c), 50);
  assert.ok(e20[e20.length - 1] > e50[e50.length - 1]);
  const r = evaluateSetup({ ...a, strat: { ...STRAT, min_quality: 40 } });
  assert.equal(r.side, "long");
  assert.equal(r.features.rsi_cross_bars_ago, 0);
  assert.equal(r.decision, "entry_signal", JSON.stringify(r.reasons));
  const atr15 = atr(c15, 14)[c15.length - 1];
  assert.ok(r.plan);
  near(r.plan!.stopDist, 1.5 * atr15);
  near(r.plan!.tpDist, 2 * r.plan!.stopDist);
  const price = c1[c1.length - 1].c;
  near(r.plan!.targetBps, (r.plan!.tpDist / price) * 1e4, 1e-6);
  near(r.plan!.costBps, 27);
  near(r.plan!.edge, r.plan!.targetBps / 27, 1e-9);
  // quality equals the sum of its parts and cannot exceed 100
  const sum = Object.values(r.parts).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - r.quality) <= 1, `${sum} vs ${r.quality}`);
  assert.ok(r.quality <= 100 && r.parts.trigger === 25);
});

test("the trigger fades with age and disappears after three candles", () => {
  const t0 = T0 + 6 * 3600_000;
  const q: number[] = [];
  for (const extra of [0, 1, 2]) {
    const { c1 } = longTrigger1m(124, 45, extra, t0);
    const r = evaluateSetup({ ...baseArgs("crypto", c1, setup15For(c1, 100, 0.3, 0.2), CRYPTO_COSTS), strat: { ...STRAT, min_quality: 0 } });
    assert.equal(r.features.rsi_cross_bars_ago, extra);
    assert.equal(r.parts.trigger, [25, 18, 12][extra]);
    q.push(r.parts.trigger);
  }
  assert.deepEqual(q, [25, 18, 12]);
  const { c1 } = longTrigger1m(124, 45, 3, t0);
  const r = evaluateSetup({ ...baseArgs("crypto", c1, setup15For(c1, 100, 0.3, 0.2), CRYPTO_COSTS), strat: { ...STRAT, min_quality: 0 } });
  assert.equal(r.decision, "no_signal");
  assert.ok(r.reasons.includes("no_rsi_trigger"));
});

test("no trend, downtrend without permission, and quality gate each block an entry", () => {
  const { c1 } = longTrigger1m(124, 45, 0, T0 + 6 * 3600_000);
  // flat 15m series
  const flat = evaluateSetup(baseArgs("crypto", c1, setup15For(c1, 124, 0, 0.2), CRYPTO_COSTS));
  assert.equal(flat.decision, "no_signal");
  assert.ok(flat.reasons.includes("no_trend"));
  assert.equal(flat.quality, 0);
  // downtrend: short side recognised but not allowed for crypto
  const down = evaluateSetup(baseArgs("crypto", c1, setup15For(c1, 150, -0.3, 0.2), CRYPTO_COSTS, false));
  assert.equal(down.side, "short");
  assert.ok(down.reasons.includes("short_not_allowed"));
  assert.notEqual(down.decision, "entry_signal");
  // quality below minimum
  const strict = evaluateSetup({ ...baseArgs("crypto", c1, setup15For(c1, 100, 0.3, 0.2), CRYPTO_COSTS), strat: { ...STRAT, min_quality: 99 } });
  assert.equal(strict.decision, "no_signal");
  assert.ok(strict.reasons.some((x) => x.startsWith("quality_below_min")));
});

test("cost gate and volatility band stop trades that cannot pay for their costs", () => {
  const { c1 } = longTrigger1m(124, 45, 0, T0 + 6 * 3600_000);
  // small ATR (about 0.15 % of price): inside the band, but the 1.5x ATR stop / 2R target is only ~45 bps vs 27 bps of costs
  const small = evaluateSetup({ ...baseArgs("crypto", c1, setup15For(c1, 120, 0.04, 0.03), CRYPTO_COSTS), strat: { ...STRAT, min_quality: 0 } });
  assert.ok(small.reasons.some((x) => x.startsWith("cost_gate")), JSON.stringify(small.reasons));
  assert.notEqual(small.decision, "entry_signal");
  // tiny ATR: below the band minimum
  const tiny = evaluateSetup({ ...baseArgs("crypto", c1, setup15For(c1, 120, 0.005, 0.004), CRYPTO_COSTS), strat: { ...STRAT, min_quality: 0 } });
  assert.ok(tiny.reasons.some((x) => x.startsWith("volatility_out_of_band")), JSON.stringify(tiny.reasons));
});

test("forex: a short pullback in a downtrend is allowed and its tiny costs pass the gate", () => {
  // EUR/USD-like: 15m down-trend of ~4 bps per bar, 1m RSI pops through 55 and falls back (mirror of the long case)
  const price0 = 1.17;
  const t0 = T0 + 6 * 3600_000;
  let c = bars(60, MINUTE, price0, -0.000004, 0.000004, t0);
  c = appendCloses(c, Array.from({ length: 8 }, (_, k) => c[c.length - 1].c + (k + 1) * 0.00004), 0.000004); // pop up
  let n = 0;
  for (;;) {
    c = appendCloses(c, [c[c.length - 1].c - 0.00003], 0.000004);
    n++;
    const r = rsi(c.map((x) => x.c), 14);
    if (r[r.length - 1] <= 55 && r[r.length - 2] > 55) break;
    assert.ok(n < 60);
  }
  const c15 = setup15For(c, 1.2, -0.0004, 0.0003);
  const a = baseArgs("forex", c, c15, FX_COSTS, true);
  const r = evaluateSetup({ ...a, strat: { ...STRAT, min_quality: 40 } });
  assert.equal(r.side, "short");
  assert.equal(r.features.rsi_cross_bars_ago, 0);
  assert.equal(r.decision, "entry_signal", JSON.stringify(r.reasons));
  near(r.plan!.costBps, 1.9);
  assert.equal(r.features.spread_source, "assumed");
});

test("data problems block instead of guessing: stale, gaps, too little history, no spread", () => {
  const { c1 } = longTrigger1m(124, 45, 0, T0 + 6 * 3600_000);
  const c15 = setup15For(c1, 100, 0.3, 0.2);
  const a = baseArgs("crypto", c1, c15, CRYPTO_COSTS);
  const stale = evaluateSetup({ ...a, nowMs: a.nowMs + 10 * 60_000 });
  assert.equal(stale.decision, "blocked");
  assert.equal(stale.reasons[0], "stale_data");
  const holes = [...c1.slice(0, c1.length - 10), ...c1.slice(c1.length - 8)];
  assert.equal(evaluateSetup({ ...a, c1: holes }).reasons[0], "gaps_in_data");
  assert.equal(evaluateSetup({ ...a, c1: c1.slice(-10) }).reasons[0], "insufficient_history_1m");
  assert.equal(evaluateSetup({ ...a, c15: c15.slice(-20) }).reasons[0], "insufficient_history_15m");
  assert.equal(evaluateSetup({ ...a, spreadBps: NaN }).reasons[0], "no_spread");
  const stale15 = evaluateSetup({ ...a, c15: c15.slice(0, -3) });
  assert.equal(stale15.reasons[0], "stale_data_15m");
});
