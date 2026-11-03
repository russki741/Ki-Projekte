import { test } from "node:test";
import assert from "node:assert/strict";
import { atr, buyAndHold, catalogue, ema, type Bar, type Costs, priorMax, rsi, simulate, sma, stats } from "./lab.ts";

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
