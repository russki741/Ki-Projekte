import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Bar, type Costs, portfolio, rulebook } from "./lab.ts";
import { decide, eventBlock, nfp, ruleOf, type TrendCfg, weightOf } from "./engine.ts";

const DAY = 86_400_000;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// trending random walk with regime switches, daily bars
function series(n: number, seed: number): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let p = 100, drift = 0.002;
  for (let i = 0; i < n; i++) {
    if (i % 120 === 0) drift = (r() - 0.45) * 0.01;
    const o = p, c = o * (1 + drift + (r() - 0.5) * 0.06);
    out.push({ ts: 1_600_000_000_000 + i * DAY, o, h: Math.max(o, c) * (1 + r() * 0.02), l: Math.min(o, c) * (1 - r() * 0.02), c, v: 1 });
    p = c;
  }
  return out;
}
const NOCOST: Costs = { feeBps: 0, slipBps: 0, spreadBps: 0 };

test("trend engine: lab.ts is the same file as in strategy-lab (live and simulation use identical rules)", () => {
  assert.equal(readFileSync(new URL("./lab.ts", import.meta.url), "utf8"), readFileSync(new URL("../strategy-lab/lab.ts", import.meta.url), "utf8"));
});

test("trend engine: bar-by-bar decisions reproduce the simulated trades of every rule", () => {
  const bars = series(900, 7);
  for (const rule of rulebook(1)) {
    const sim = portfolio({ X: bars }, rule, { sizing: "equal", refVol: 0.6, volDays: 30, barsPerDay: 1, capital: 10000 }, () => NOCOST);
    const cfg: TrendCfg = { rule: rule.id, tf: 1440, sizing: "equal", ref_vol: 0.6, vol_days: 30, scale: 1 };
    const live: { entryTs: number; exitTs: number; reason: string }[] = [];
    let pos: { entryBarTs: number } | null = null, blocked = false;
    for (let i = 0; i < bars.length - 1; i++) {
      const d = decide(bars.slice(0, i + 1), rule, cfg, pos, blocked);
      blocked = d.blocked;
      if (d.action === "buy") pos = { entryBarTs: bars[i + 1].ts }; // filled at the next open
      else if (d.action === "sell" && pos) { live.push({ entryTs: pos.entryBarTs, exitTs: bars[i + 1].ts, reason: d.reason! }); pos = null; }
    }
    assert.deepEqual(live, sim.trades.map((t) => ({ entryTs: t.entryTs, exitTs: t.exitTs, reason: t.reason })), rule.id);
    assert.ok(sim.trades.length > 0 || rule.id === "golden_cross", `${rule.id} produced no trades on the test series`);
  }
});

test("trend engine: weights follow volatility and the exposure scale", () => {
  const cfg: TrendCfg = { rule: "tsmom_vote", tf: 1440, sizing: "vol", ref_vol: 0.6, vol_days: 30, scale: 0.25 };
  assert.equal(weightOf(cfg, 3, 0.3), (1 / 3) * 0.25); // calm market: full share, times scale
  assert.ok(Math.abs(weightOf(cfg, 3, 1.2) - (1 / 3) * 0.5 * 0.25) < 1e-12); // twice the reference volatility: half
  assert.equal(weightOf({ ...cfg, sizing: "equal" }, 3, 1.2), (1 / 3) * 0.25);
});

test("trend engine: unknown rule is rejected, known rules resolve for daily and 4h", () => {
  assert.equal(ruleOf("nope", 1440), null);
  assert.equal(ruleOf("turtle_55_20", 1440)?.id, "turtle_55_20");
  assert.equal(ruleOf("tsmom_vote", 240)?.id, "tsmom_vote");
});

test("calendar: payrolls on the first Friday, holidays shift, block window", () => {
  assert.equal(new Date(nfp(2026, 11)).toISOString(), "2026-12-04T12:30:00.000Z");
  assert.equal(new Date(nfp(2027, 0)).toISOString(), "2027-01-08T12:30:00.000Z"); // Jan 1 is a holiday
  const t = Date.UTC(2026, 11, 9, 19, 0);
  assert.equal(eventBlock(Date.UTC(2026, 11, 9, 0, 5), [t]), true); // decision at 00:05 on FOMC day: wait
  assert.equal(eventBlock(Date.UTC(2026, 11, 9, 21, 30), [t]), false); // 2.5 h after: free again
  assert.equal(eventBlock(Date.UTC(2026, 11, 7, 0, 5), [t]), false);
});
