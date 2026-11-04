import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type Bar, type Costs, portfolio, rulebook } from "./lab.ts";
import { decide, decideTwoWay, entryPx, eventBlock, exitPx, fromMid, inverseBars, nfp, orderUsd, parseCbrUsd, parseYahooDaily, ruleOf, settle, type Side, type TrendCfg, valueOf, weightOf } from "./engine.ts";
import { study } from "../strategy-lab/study.ts";

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

test("small account: buys below the exchange minimum are raised to it, never above the 1/N share", () => {
  const w = (1 / 3) * 0.25 * 0.5; // quarter size, halved by the news factor
  assert.deepEqual(orderUsd(61.22, w, 3, 6), { usd: 6, raised: true }); // 2.55 USD wanted -> 6 USD (Bybit minimum 5)
  assert.deepEqual(orderUsd(10000, w, 3, 6), { usd: 10000 * w, raised: false }); // big account: weight decides
  assert.equal(orderUsd(15, w, 3, 6).raised, false); // 6 USD would be more than 1/3 of 15 USD: stays too small, gets skipped
  assert.equal(orderUsd(61.22, w, 3, 0).usd, 61.22 * w); // no minimum configured
});

test("bank of russia XML: USD rate with nominal and comma decimal", () => {
  const xml = `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="04.11.2026" name="Foreign Currency Market">` +
    `<Valute ID="R01010"><NumCode>036</NumCode><CharCode>AUD</CharCode><Nominal>1</Nominal><Name>x</Name><Value>53,1234</Value></Valute>` +
    `<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>y</Name><Value>81,6699</Value><VunitRate>81,6699</VunitRate></Valute>` +
    `<Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>10</Nominal><Name>z</Name><Value>112,3</Value></Valute></ValCurs>`;
  assert.deepEqual(parseCbrUsd(xml), { rate: 81.6699, date: "2026-11-04" });
  assert.equal(parseCbrUsd("<html>error</html>"), null);
  assert.equal(parseCbrUsd(xml.replace("81,6699</Value>", "0,5</Value>")), null); // implausible value
});

test("currencies: two-way decisions reproduce the lab study of a pair plus its inverse (same number of trades, never both sides)", () => {
  const bars = series(900, 13);
  for (const id of ["tsmom_vote", "turtle_55_20", "sma200"]) {
    const rule = ruleOf(id, 1440)!;
    const cfg: TrendCfg = { rule: id, tf: 1440, sizing: "equal", ref_vol: 0.6, vol_days: 30, scale: 1 };
    let pos: { side: Side; entryBarTs: number } | null = null, blocked = { long: false, short: false }, closed = 0, flips = 0;
    for (let i = 0; i < bars.length - 1; i++) {
      const d = decideTwoWay(bars.slice(0, i + 1), rule, cfg, pos, blocked);
      blocked = d.blocked;
      assert.ok(!(d.long.want && d.short.want && !pos), `${id}: both directions wanted while flat at bar ${i}`);
      if (d.close && pos) { closed++; pos = null; }
      if (d.open) { if (closed && d.close) flips++; pos = { side: d.open, entryBarTs: bars[i + 1].ts }; }
    }
    const lab = study({ X: bars, INV: inverseBars(bars) }, rule, { id: "regel" }, { sizing: "equal", refVol: 0.6, volDays: 30, periodScale: 1, capital: 10000 },
      () => ({ feeBps: 0, slipBps: 0, spreadBps: 0 }));
    assert.equal(closed, lab.metrics.trades, id);
  }
});

test("currencies: the short side wins when the price falls", () => {
  const fall: Bar[] = Array.from({ length: 400 }, (_, i) => ({ ts: i * DAY, o: 2 - i * 0.002, h: 2.001 - i * 0.002, l: 1.997 - i * 0.002, c: 1.998 - i * 0.002, v: 1 }));
  const rule = ruleOf("tsmom_vote", 1440)!;
  const d = decideTwoWay(fall, rule, { rule: "tsmom_vote", tf: 1440, sizing: "equal", ref_vol: 0.6, vol_days: 30, scale: 1 }, null, { long: false, short: false });
  assert.equal(d.open, "short");
  const held = decideTwoWay(fall, rule, { rule: "tsmom_vote", tf: 1440, sizing: "equal", ref_vol: 0.6, vol_days: 30, scale: 1 }, { side: "short", entryBarTs: fall[300].ts }, { long: false, short: false });
  assert.equal(held.close, false);
  assert.equal(held.open, null);
});

test("execution: a short sells at the bid and buys back at the ask; a round trip without price move costs spread plus slippage", () => {
  const q = fromMid(1.1, 2); // 2 bps spread around 1.1
  assert.ok(Math.abs(q.ask - q.bid - 1.1 * 2e-4) < 1e-12);
  for (const side of ["long", "short"] as Side[]) {
    const e = entryPx(side, q, 1), x = exitPx(side, q, 1);
    const qty = 100 / e;
    const s = settle(side, qty, e, qty * e, 0, x, 0);
    // costs: 2 bps spread + 2 x 1 bp slippage = 4 bps of 100 USD = 0.04 USD
    assert.ok(Math.abs(s.net + 0.04) < 0.001, `${side}: ${s.net}`);
    assert.ok(Math.abs(s.cashBack - (100 + s.gross)) < 1e-9);
  }
  // short gains when the price falls 1 %: about +1 USD on 100 USD, value follows the mark
  const s = settle("short", 100, 1, 100, 0, 0.99, 0);
  assert.ok(Math.abs(s.net - 1) < 1e-9);
  assert.ok(Math.abs(valueOf("short", 100, 1, 100, 0.99) - 101) < 1e-9);
  assert.ok(Math.abs(valueOf("long", 100, 1, 100, 0.99) - 99) < 1e-9);
});

test("yahoo daily bars: running day is never used, summer days (23:00 UTC start) map to their UTC day, meta price is read", () => {
  const body = {
    chart: {
      result: [{
        meta: { regularMarketPrice: 1.0812, regularMarketTime: 1_783_000_000 },
        // 2026-07-01 23:00 UTC (London day Jul 2), 2026-07-02 23:00 UTC (London day Jul 3, still running at 'now'), a partial bar with a live timestamp
        timestamp: [Date.UTC(2026, 6, 1, 23) / 1000, Date.UTC(2026, 6, 2, 23) / 1000, Date.UTC(2026, 6, 3, 10) / 1000],
        indicators: { quote: [{ open: [1.1, 1.2, 1.3], high: [1.15, 1.25, 1.35], low: [1.05, 1.15, 1.25], close: [1.12, 1.22, 1.32], volume: [0, 0, null] }] },
      }],
    },
  };
  const now = Date.UTC(2026, 6, 3, 10, 5);
  const r = parseYahooDaily(body, now)!;
  assert.equal(r.bars.length, 1); // only the London day Jul 2 is complete (closed Jul 2 23:00 UTC)
  assert.equal(new Date(r.bars[0].ts).toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(r.bars[0].c, 1.12);
  assert.equal(r.price, 1.0812);
  assert.equal(r.at, 1_783_000_000_000);
  assert.equal(parseYahooDaily({ chart: { result: null, error: { description: "x" } } }, now), null);
});
