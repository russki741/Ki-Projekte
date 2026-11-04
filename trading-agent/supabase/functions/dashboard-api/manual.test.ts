import { test } from "node:test";
import assert from "node:assert/strict";
import { COSTS, marketOf, MIN_USD, parseYahooChart, plan, quoteFrom, roundTripPct, settleClose } from "./manual.ts";
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
