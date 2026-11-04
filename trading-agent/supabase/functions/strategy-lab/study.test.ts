import { test } from "node:test";
import assert from "node:assert/strict";
import { type Bar, type Costs, portfolio, rulebook } from "./lab.ts";
import { type Exit, inverse, study } from "./study.ts";

const DAY = 86_400_000;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function series(n: number, seed: number, start = 1_600_000_000_000, step = DAY): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let p = 100, drift = 0.002;
  for (let i = 0; i < n; i++) {
    if (i % 120 === 0) drift = (r() - 0.45) * 0.01;
    const o = p, c = o * (1 + drift + (r() - 0.5) * 0.06);
    out.push({ ts: start + i * step, o, h: Math.max(o, c) * (1 + r() * 0.02), l: Math.min(o, c) * (1 - r() * 0.02), c, v: 1 });
    p = c;
  }
  return out;
}
const NOCOST = (): Costs => ({ feeBps: 0, slipBps: 0, spreadBps: 0 });
const COST = (): Costs => ({ feeBps: 10, slipBps: 2, spreadBps: 1 });
const CFG = { sizing: "equal" as const, refVol: 0.6, volDays: 30, periodScale: 1, capital: 10000 };
const RULE_ONLY: Exit = { id: "regel" };

test("study: with the rule as only exit it reproduces portfolio() of lab.ts on the same markets", () => {
  const data = { A: series(900, 3), B: series(900, 11) };
  for (const rule of rulebook(1)) {
    const p = portfolio(data, rule, { sizing: "equal", refVol: 0.6, volDays: 30, barsPerDay: 1, capital: 10000 }, COST);
    const s = study(data, rule, RULE_ONLY, CFG, COST);
    assert.equal(s.metrics.trades, p.metrics.trades, rule.id);
    assert.ok(Math.abs(s.metrics.total_pct - p.metrics.total_pct) < 0.11, `${rule.id}: ${s.metrics.total_pct} vs ${p.metrics.total_pct}`);
    assert.equal(s.metrics.max_dd_pct, p.metrics.max_dd_pct, rule.id);
  }
});

test("study: markets with different calendars share one timeline (crypto every day, currency only on weekdays)", () => {
  const daily = series(700, 5);
  const weekdays = series(700, 9).filter((b) => { const d = new Date(b.ts).getUTCDay(); return d !== 0 && d !== 6; });
  const s = study({ C: daily, F: weekdays }, "hold", RULE_ONLY, CFG, NOCOST);
  assert.equal(s.steps, 700);
  const one = study({ C: daily }, "hold", RULE_ONLY, CFG, NOCOST).metrics.total_pct;
  const two = study({ F: weekdays }, "hold", RULE_ONLY, CFG, NOCOST).metrics.total_pct;
  // half of the capital in each market: the result lies between the two single results, near their middle
  assert.ok(s.metrics.total_pct > Math.min(one, two) && s.metrics.total_pct < Math.max(one, two), `${s.metrics.total_pct} vs ${one}, ${two}`);
  assert.ok(Math.abs(s.metrics.total_pct - (one + two) / 2) < Math.abs(one - two) * 0.1, `${s.metrics.total_pct} vs ${(one + two) / 2}`);
  assert.ok(Object.values(s.metrics).every((v) => v === null || Number.isFinite(v)));
});

test("study: take profit sells inside the bar at the target, net of costs, and re-enters while the rule is on", () => {
  // flat for 200 bars, then +1 % per bar: the 'hold' rule is always on
  const b: Bar[] = [];
  for (let i = 0; i < 260; i++) {
    const o = i < 200 ? 100 : 100 * 1.01 ** (i - 200);
    b.push({ ts: 1_600_000_000_000 + i * DAY, o, h: o * 1.012, l: o * 0.999, c: o * 1.01, v: 1 });
  }
  const s = study({ X: b }, "hold", { id: "tp1", tpPct: 1, reentry: true }, CFG, COST, b[200].ts);
  assert.ok(s.exits.take_profit > 20, JSON.stringify(s.exits));
  // each trade: +1 % gross minus 2 x (0.1 % fee + 0.02 % slip + 0.005 % half spread) -> about +0.75 %
  assert.ok(s.metrics.avg_trade_pct > 0.7 && s.metrics.avg_trade_pct < 0.8, String(s.metrics.avg_trade_pct));
  const once = study({ X: b }, "hold", { id: "tp1", tpPct: 1, reentry: false }, CFG, COST, b[200].ts);
  assert.equal(once.exits.take_profit, 1); // without re-entry the rule has to switch off first
});

test("study: when stop and target are both touched in one bar, the stop counts", () => {
  const b: Bar[] = [];
  for (let i = 0; i < 10; i++) b.push({ ts: 1_600_000_000_000 + i * DAY, o: 100, h: 110, l: 90, c: 100, v: 1 });
  const s = study({ X: b }, "hold", { id: "both", tpPct: 5, stopPct: 5 }, CFG, NOCOST);
  assert.equal(s.exits.stop, 1);
  assert.equal(s.exits.take_profit, undefined);
});

test("study: the inverse market wins when the original falls", () => {
  const b = series(400, 21);
  const back = inverse(inverse(b));
  assert.ok(Math.abs(back[100].c - b[100].c) < 1e-9 && Math.abs(back[100].h - b[100].h) < 1e-9);
  const fall: Bar[] = Array.from({ length: 50 }, (_, i) => ({ ts: i * DAY, o: 100 - i, h: 100.5 - i, l: 99 - i, c: 99 - i, v: 1 }));
  assert.ok(study({ X: fall }, "hold", RULE_ONLY, CFG, NOCOST).metrics.total_pct < 0);
  assert.ok(study({ X: inverse(fall) }, "hold", RULE_ONLY, CFG, NOCOST).metrics.total_pct > 0);
});
