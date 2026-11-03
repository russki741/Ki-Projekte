import { test } from "node:test";
import assert from "node:assert/strict";
import { atr, buyAndHold, catalogue, ema, type Bar, type Costs, portfolio, priorMax, rsi, rulebook, simulate, sma, stateFrom, stats } from "./lab.ts";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function walk(n: number, seed: number, vol = 0.004): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + (r() - 0.5) * 2 * vol);
    const h = Math.max(o, c) * (1 + r() * vol * 0.5), l = Math.min(o, c) * (1 - r() * vol * 0.5);
    out.push({ ts: 1_700_000_000_000 + i * 3_600_000, o, h, l, c, v: 1 + r() });
    p = c;
  }
  return out;
}
const COSTS: Costs = { feeBps: 10, slipBps: 2, spreadBps: 1 };
const flat = (n: number, px = 100): Bar[] => Array.from({ length: n }, (_, i) => ({ ts: i * 60000, o: px, h: px, l: px, c: px, v: 1 }));

test("indicators: known values and NaN warm-up", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3).map((x) => (Number.isNaN(x) ? null : x)), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(e[1]) && e[2] === 2 && Math.abs(e[3] - 3) < 1e-12);
  const up = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
  assert.equal(up[29], 100);
  const dn = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
  assert.equal(dn[29], 0);
  assert.deepEqual(priorMax([1, 5, 2, 3], 2).map((x) => (Number.isNaN(x) ? null : x)), [null, null, 5, 5]);
  const b = walk(50, 1);
  assert.ok(atr(b, 14).slice(14).every((x) => x > 0));
});

test("round trip on a flat price loses exactly the modelled costs", () => {
  const b = flat(20);
  const entry = b.map((_, i) => i === 2);
  const exitSig = b.map((_, i) => i === 6);
  const t = simulate(b, { entry, exitSig }, COSTS);
  assert.equal(t.length, 1);
  assert.equal(t[0].reason, "signal");
  const half = (1 / 2 + 2) / 1e4, fee = 10 / 1e4;
  const expected = (((100 * (1 - half)) * (1 - fee)) / ((100 * (1 + half)) * (1 + fee)) - 1) * 1e4;
  assert.ok(Math.abs(t[0].netBps - expected) < 1e-9, `${t[0].netBps} vs ${expected}`);
  assert.equal(t[0].grossBps, 0);
  assert.ok(t[0].netBps < -24 && t[0].netBps > -26, "about 25 bps for a round trip");
  assert.equal(t[0].entryTs, b[3].ts); // signal on closed bar 2 -> fill at the open of bar 3
  assert.equal(t[0].exitTs, b[7].ts); // exit signal on closed bar 6 -> fill at the open of bar 7
});

test("stop is hit before the target when both are inside one bar; a gap fills at the open", () => {
  const b = flat(10);
  b[3] = { ...b[3], o: 100, h: 110, l: 90, c: 100 };
  const spec = { entry: b.map((_, i) => i === 2), atr: b.map(() => 2), stopAtr: 2, targetAtr: 2 }; // stop 96, target 104, bar 3 touches both
  const t = simulate(b, spec, COSTS);
  assert.equal(t[0].reason, "stop");
  assert.ok(Math.abs(t[0].grossBps - (96 / 100 - 1) * 1e4) < 1e-9);
  const g = flat(10);
  g[4] = { ...g[4], o: 90, h: 90, l: 90, c: 90 };
  const t2 = simulate(g, { entry: g.map((_, i) => i === 2), atr: g.map(() => 2), stopAtr: 2 }, COSTS);
  assert.equal(t2[0].reason, "stop");
  assert.ok(Math.abs(t2[0].grossBps - (90 / 100 - 1) * 1e4) < 1e-9, "gap below the stop fills at the open, not at the stop");
});

test("target and time exits", () => {
  const b = flat(12);
  b[5] = { ...b[5], h: 105, c: 104 };
  const t = simulate(b, { entry: b.map((_, i) => i === 2), atr: b.map(() => 2), targetAtr: 2 }, COSTS);
  assert.equal(t[0].reason, "target");
  assert.ok(Math.abs(t[0].grossBps - 400) < 1e-9);
  const t2 = simulate(flat(12), { entry: flat(12).map((_, i) => i === 2), maxBars: 3 }, COSTS);
  assert.equal(t2[0].reason, "time");
  assert.equal(t2[0].bars, 4); // entry bar 3, 3 bars held, filled at the open of bar 6 -> indices 3..6
});

test("no look-ahead: every strategy gives identical signals and trades on a truncated history", () => {
  const b = walk(2500, 42);
  const K = 1800;
  for (const s of catalogue()) {
    const full = s.build(b), part = s.build(b.slice(0, K));
    for (let i = 0; i < K; i++) {
      assert.equal(full.entry[i], part.entry[i], `${s.id} entry differs at ${i}`);
      assert.equal(full.exitSig?.[i] ?? false, part.exitSig?.[i] ?? false, `${s.id} exit differs at ${i}`);
      assert.ok(Object.is(full.atr?.[i], part.atr?.[i]), `${s.id} atr differs at ${i}`);
    }
    const tf = simulate(b, full, COSTS), tp = simulate(b.slice(0, K), part, COSTS);
    const cut = b[K - 3].ts;
    assert.deepEqual(tf.filter((x) => x.exitTs < cut), tp.filter((x) => x.exitTs < cut), `${s.id} trades differ`);
  }
});

test("catalogue produces trades on a trending series and none on pure noise-free flat data", () => {
  const up = Array.from({ length: 600 }, (_, i): Bar => { const p = 100 * Math.exp(i * 0.002); return { ts: i * 3600000, o: p, h: p * 1.001, l: p * 0.999, c: p * 1.0005, v: 1 }; });
  const withTrades = catalogue().filter((s) => simulate(up, s.build(up), COSTS).length > 0).length;
  assert.ok(withTrades >= 3, `strategies with trades on an uptrend: ${withTrades}`);
  for (const s of catalogue()) assert.equal(simulate(flat(600), s.build(flat(600)), COSTS).length, 0, s.id);
});

test("buy and hold: one trade, gross equals the price change", () => {
  const b = walk(500, 7);
  const t = buyAndHold(b, COSTS);
  assert.equal(t.length, 1);
  assert.ok(Math.abs(t[0].grossBps - (b[499].c / b[1].o - 1) * 1e4) < 1e-9);
});

test("stats: mean, t value, win rate, profit factor", () => {
  const s = stats([{ netBps: 10, grossBps: 12, bars: 2 }, { netBps: -5, grossBps: -3, bars: 4 }, { netBps: 20, grossBps: 22, bars: 6 }]);
  assert.equal(s.n, 3);
  assert.equal(s.win_pct, 66.67);
  assert.equal(s.net_bps, 8.33);
  assert.equal(s.pf, 6);
  assert.equal(s.avg_bars, 4);
  assert.equal(stats([]).n, 0);
});


// ---------- rulebook v2 (portfolio on daily bars) ----------
const DAY = 86_400_000;
function dailyWalk(n: number, seed: number, vol = 0.03, drift = 0): Bar[] {
  return walk(n, seed, vol).map((b, i) => ({ ...b, ts: 1_600_000_000_000 + i * DAY, o: b.o * (1 + drift) ** i, h: b.h * (1 + drift) ** i, l: b.l * (1 + drift) ** i, c: b.c * (1 + drift) ** i }));
}
const PCFG = { sizing: "equal" as const, refVol: 0.6, volDays: 30, barsPerDay: 1, capital: 10000 };
const NOCOST: Costs = { feeBps: 0, slipBps: 0, spreadBps: 0 };

test("rulebook: stateFrom switches on at entry and off at exit, exit wins", () => {
  assert.deepEqual(stateFrom([false, true, false, false, true, true], [false, false, false, true, false, true]), [false, true, true, false, true, false]);
});

test("rulebook: no rule looks ahead (signal at bar i ignores later bars)", () => {
  const b = dailyWalk(700, 11);
  for (const r of rulebook(1)) {
    const full = r.signal(b);
    for (const cut of [250, 400, 650]) {
      const part = r.signal(b.slice(0, cut + 1));
      assert.deepEqual(part, full.slice(0, cut + 1), `${r.id} changed history at ${cut}`);
    }
  }
});

test("rulebook: hold without costs equals the average asset return", () => {
  const a = dailyWalk(300, 1), b = dailyWalk(300, 2);
  const res = portfolio({ A: a, B: b }, "hold", PCFG, () => NOCOST);
  const exp = ((a[299].c / a[1].o) + (b[299].c / b[1].o)) / 2 - 1; // decided at the first close, bought at the next open
  assert.ok(Math.abs(res.metrics.total_pct - exp * 100) < 0.11, `${res.metrics.total_pct} vs ${exp * 100}`);
  assert.equal(res.trades.length, 0); // still open at the end
});

test("rulebook: costs reduce the result, fees are counted", () => {
  const data = { A: dailyWalk(400, 3), B: dailyWalk(400, 4) };
  const r = rulebook(1).find((x) => x.id === "turtle_20_10")!;
  const free = portfolio(data, r, PCFG, () => NOCOST), paid = portfolio(data, r, PCFG, () => ({ feeBps: 10, slipBps: 2, spreadBps: 2 }));
  assert.ok(paid.trades.length > 3 && paid.metrics.total_pct < free.metrics.total_pct && paid.feesUsd > 0);
});

test("rulebook: vol sizing gives a twice as volatile asset about half the weight", () => {
  const calm = dailyWalk(200, 5, 0.02), wild = dailyWalk(200, 6, 0.04);
  const res = portfolio({ C: calm, W: wild }, "hold", { ...PCFG, sizing: "vol", refVol: 0.05, volDays: 30 }, () => NOCOST, calm[60].ts);
  const val = (s: string) => res.open[s].qty * res.open[s].entryPx;
  const ratio = val("C") / val("W");
  assert.ok(ratio > 1.6 && ratio < 2.5, `ratio ${ratio}`);
  assert.ok(val("C") < 10000 / 2, "scaled below the equal weight");
});

test("rulebook: trailing stop exits and waits for the rule to switch off before re-entering", () => {
  const n = 120;
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const p = i < 60 ? 100 + i : i < 70 ? 160 - (i - 60) * 4 : 120; // up, sharp drop, flat
    bars.push({ ts: i * DAY, o: p, h: p * 1.005, l: p * 0.995, c: p, v: 1 });
  }
  const always: any = { id: "always", name: "", source: "", signal: (b: Bar[]) => b.map(() => true), trailAtr: 3 };
  const res = portfolio({ X: bars }, always, PCFG, () => NOCOST);
  assert.equal(res.trades.length, 1);
  assert.equal(res.trades[0].reason, "trailing_stop");
  assert.ok(res.metrics.exposure_pct < 70); // stayed out after the stop although the rule was still "in"
});
