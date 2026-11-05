import { test } from "node:test";
import assert from "node:assert/strict";
import { COSTS, marketOf, MIN_USD, parseBybitKlines, parseYahooBars, parseYahooChart, plan, precisionOf, quoteFrom, roundTripPct, settleClose, TF } from "./manual.ts";
import { entryPx as engEntry, exitPx as engExit, fromMid, settle } from "../trend-tick/engine.ts";

const NOW = Date.UTC(2026, 10, 4, 20, 0);
const BTC = marketOf("BTCUSDT")!, EUR = marketOf("EURUSD=X")!;
const RUB = 81.6699;

test("manual: only listed markets; crypto buy only, currencies both ways", () => {
  assert.equal(marketOf("DOGEUSDT"), null);
  assert.equal(marketOf("EURUSD=X")?.canShort, true);
  const q = quoteFrom(BTC, 70000, NOW, NOW, 69999, 70001);
  const r = plan(BTC, "short", 1000, RUB, q, 61.22, false, true);
  assert.equal(r.ok, false);
});

test("manual: 1,000 rubles of EUR/USD short at a live quote, closed unchanged: costs = spread + 2 x slippage", () => {
  const q = quoteFrom(EUR, 1.08, NOW - 60_000, NOW);
  assert.ok(q.fresh);
  const p = plan(EUR, "short", 1000, RUB, q, 61.22, false, true);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.ok(Math.abs(p.notional - 1000 / RUB) < 0.001);
  assert.equal(p.fee, 0);
  const s = settleClose(EUR, "short", p.qty, p.fill, p.notional, p.fee, q);
  // 2 bps spread + 2 x 1 bp slippage = 4 bps of 12.24 USD
  assert.ok(Math.abs(s.net + p.notional * 4e-4) < 1e-6, String(s.net));
  assert.ok(Math.abs(roundTripPct(EUR, q) - 0.04) < 0.0005);
});

test("manual: the same numbers as the trend engine (entry, exit, settlement)", () => {
  const q = quoteFrom(EUR, 1.1, NOW, NOW);
  const e = fromMid(1.1, EUR.spreadBps);
  for (const side of ["long", "short"] as const) {
    assert.ok(Math.abs(engEntry(side, e, COSTS.forex.slipBps) - (side === "long" ? q.ask : q.bid) * (side === "long" ? 1.0001 : 0.9999)) < 1e-12);
    const p = plan(EUR, side, 2000, RUB, q, 61.22, false, true);
    assert.ok(p.ok);
    if (!p.ok) continue;
    const a = settleClose(EUR, side, p.qty, p.fill, p.notional, p.fee, { ...q, bid: q.bid * 1.01, ask: q.ask * 1.01 });
    const b = settle(side, p.qty, p.fill, p.notional, p.fee, engExit(side, { bid: e.bid * 1.01, ask: e.ask * 1.01 }, COSTS.forex.slipBps), COSTS.forex.feeBps);
    assert.ok(Math.abs(a.net - b.net) < 1e-12 && Math.abs(a.cashBack - b.cashBack) < 1e-12, side);
  }
});

test("manual: crypto pays 0.1 % fee per side; minimum 6 USD; amount above the free cash is refused, 'everything' is reduced by the fee", () => {
  const q = quoteFrom(BTC, 0, NOW, NOW, 70000, 70010);
  assert.equal(plan(BTC, "long", 400, RUB, q, 61.22, false, true).ok, false); // 4.9 USD < 6 USD
  const tooMuch = plan(BTC, "long", 6000, RUB, q, 61.22, false, true);
  assert.equal(tooMuch.ok, false);
  assert.match((tooMuch as any).error, /frei/);
  const all = plan(BTC, "long", 61.22 * RUB, RUB, q, 61.22, false, true);
  assert.ok(all.ok);
  if (!all.ok) return;
  assert.ok(all.notional + all.fee <= 61.22 + 1e-9);
  assert.ok(Math.abs(all.fee - all.notional * 0.001) < 1e-9);
  assert.ok(all.fill > 70010); // ask plus slippage
  assert.ok(roundTripPct(BTC, q) > 0.2 && roundTripPct(BTC, q) < 0.27); // 2 x 0.1 % fee + 2 x 0.02 % slip + spread
  assert.equal(MIN_USD.crypto, 6);
});

test("manual: closed market, kill switch and switched-off market are refused with a reason", () => {
  const stale = quoteFrom(EUR, 1.08, NOW - 3 * 3600_000, NOW);
  assert.equal(stale.fresh, false);
  assert.match((plan(EUR, "long", 1000, RUB, stale, 61.22, false, true) as any).error, /geschlossen/);
  const q = quoteFrom(EUR, 1.08, NOW, NOW);
  assert.match((plan(EUR, "long", 1000, RUB, q, 61.22, true, true) as any).error, /Kill-Switch/);
  assert.match((plan(EUR, "long", 1000, RUB, q, 61.22, false, false) as any).error, /ausgeschaltet/);
});

test("manual: yahoo hourly chart is read (price, time, closes without gaps)", () => {
  const r = parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 1.08, regularMarketTime: 1_793_800_000 }, indicators: { quote: [{ close: [1.07, null, 1.075, 1.08] }] } }] } });
  assert.deepEqual(r, { price: 1.08, at: 1_793_800_000_000, closes: [1.07, 1.075, 1.08] });
  assert.equal(parseYahooChart({ chart: { result: null } }), null);
});

test("chart: bybit klines (newest first, strings) become ascending numeric bars, broken rows dropped", () => {
  const list = [["1793800200000", "70010", "70020", "69990", "70005", "1.5", "105000"], ["1793800140000", "70000", "70015", "69980", "70010", "2", "140000"], ["x", "1"], ["1793800080000", "0", "1", "1", "1", "1"]];
  assert.deepEqual(parseBybitKlines(list), [[1793800140000, 70000, 70015, 69980, 70010, 2], [1793800200000, 70010, 70020, 69990, 70005, 1.5]]);
  assert.deepEqual(parseBybitKlines(null), []);
});

test("chart: yahoo 1 h bars are merged into 4 h bars; the extra live row folds into the running bar", () => {
  const H = 3600;
  const t0 = Date.UTC(2026, 10, 5, 8) / 1000; // 08:00 UTC, start of a 4 h slot
  const body = { chart: { result: [{ timestamp: [t0, t0 + H, t0 + 2 * H, t0 + 3 * H, t0 + 4 * H, t0 + 4 * H + 1234],
    indicators: { quote: [{ open: [1.1, 1.11, 1.12, 1.13, 1.14, 1.141], high: [1.12, 1.13, 1.15, 1.14, 1.145, 1.15], low: [1.09, 1.1, 1.11, 1.12, 1.13, 1.135], close: [1.11, 1.12, 1.13, 1.14, 1.141, 1.146], volume: [0, 0, null, 0, 0, 0] }] } }] } };
  const bars = parseYahooBars(body, TF["240"].ms);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], [t0 * 1000, 1.1, 1.15, 1.09, 1.14, 0]);
  assert.deepEqual(bars[1], [(t0 + 4 * H) * 1000, 1.14, 1.15, 1.13, 1.146, 0]);
  assert.deepEqual(parseYahooBars({ chart: { result: null } }, 60_000), []);
  // daily: a summer bar at 23:00 UTC belongs to the next UTC day
  const d = parseYahooBars({ chart: { result: [{ timestamp: [Date.UTC(2026, 6, 1, 23) / 1000], indicators: { quote: [{ open: [1], high: [1.1], low: [0.9], close: [1.05], volume: [0] }] } }] } }, TF.D.ms);
  assert.equal(new Date(d[0][0]).toISOString(), "2026-07-02T00:00:00.000Z");
});

test("chart: price decimals like a broker (JPY 3, other pairs 5, crypto by size) and all time frames defined", () => {
  assert.equal(precisionOf(marketOf("USDJPY=X")!, 157.7), 3);
  assert.equal(precisionOf(marketOf("EURUSD=X")!, 1.1238), 5);
  assert.equal(precisionOf(marketOf("BTCUSDT")!, 76084.5), 2);
  assert.deepEqual(Object.keys(TF), ["1", "5", "15", "60", "240", "D"]);
  for (const k of Object.keys(TF)) assert.ok(TF[k].lookbackMs / TF[k].ms >= 140, k); // enough history for a full chart
});
