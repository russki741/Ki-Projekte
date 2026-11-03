// Strategy + trade math for the agent engine. Pure functions: no I/O, no Deno APIs (also run under Node tests).
// SIMULATION ONLY. Heuristic baseline, NOT a validated edge.
import { type Candle, MINUTE, atr, ema, rsi } from "./lib.ts";

export type Side = "long" | "short";

export type StratCfg = {
  ema_fast: number;
  ema_slow: number;
  rsi_period: number;
  atr_period: number;
  rsi_long_cross: number;
  rsi_short_cross: number;
  atr_stop_mult: number;
  rr: number;
  min_edge_multiple: number;
  min_quality: number;
  max_hold_min: number;
  bands: Record<string, { atr_pct_min: number; atr_pct_max: number }>;
};
export type CostCfg = { fee_bps: number; slip_bps: number; fallback_spread_bps: number };

export type Setup = {
  decision: "entry_signal" | "no_signal" | "blocked";
  side: Side | null;
  quality: number;
  reasons: string[];
  features: Record<string, number | string | null>;
  parts: Record<string, number>;
  plan: { stopDist: number; tpDist: number; targetBps: number; costBps: number; edge: number } | null;
};

const M15 = 15 * MINUTE;
const round = (x: number, d = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Round trip in bps: fee on both sides + one full spread (half per side) + slippage on both sides. */
export function roundTripCostBps(c: CostCfg, spreadBps: number): number {
  return 2 * c.fee_bps + spreadBps + 2 * c.slip_bps;
}

export function sessionOf(ms: number): "asia" | "eu" | "us" {
  const h = new Date(ms).getUTCHours();
  return h < 8 ? "asia" : h < 16 ? "eu" : "us";
}
export function setupKey(symbol: string, side: Side, ms: number): string {
  return `${symbol}:${side}:${sessionOf(ms)}`;
}

/** Number of missing 1m candles between the first and last of the last `window` candles. */
export function gapCount(c: Candle[], window: number): number {
  const w = c.slice(-window);
  let gaps = 0;
  for (let k = 1; k < w.length; k++) gaps += Math.max(0, Math.round((w[k].ts - w[k - 1].ts) / MINUTE) - 1);
  return gaps;
}

/**
 * Multi-timeframe pullback on CLOSED candles.
 *  - 15m: EMA(fast) vs EMA(slow) + slope of the slow EMA give the trend; ATR gives volatility and the stop distance.
 *  - 1m: RSI crossing back through a threshold (up through 45 in an uptrend, down through 55 in a downtrend) is the timing.
 * Hard gates (all must pass) + a 0..100 quality score. Data problems return decision "blocked".
 */
export function evaluateSetup(a: {
  market: string;
  c1: Candle[];
  c15: Candle[];
  nowMs: number;
  spreadBps: number;
  spreadSource: "measured" | "assumed";
  strat: StratCfg;
  costs: CostCfg;
  allowShort: boolean;
  maxLagS: number;
  maxGapMin: number;
}): Setup {
  const { c1, c15, strat: s, costs, nowMs } = a;
  const blocked = (reason: string, f: Record<string, number | string | null> = {}): Setup => ({
    decision: "blocked",
    side: null,
    quality: 0,
    reasons: [reason],
    features: f,
    parts: {},
    plan: null,
  });

  const n1 = c1.length;
  const n15 = c15.length;
  if (n1 < s.rsi_period + 10) return blocked("insufficient_history_1m", { candles_1m: n1 });
  if (n15 < s.ema_slow + 6) return blocked("insufficient_history_15m", { candles_15m: n15 });
  const lag1 = (nowMs - (c1[n1 - 1].ts + MINUTE)) / 1000;
  if (lag1 > a.maxLagS) return blocked("stale_data", { lag_s: Math.round(lag1) });
  const lag15 = (nowMs - (c15[n15 - 1].ts + M15)) / 1000;
  if (lag15 > 20 * 60) return blocked("stale_data_15m", { lag_15m_s: Math.round(lag15) });
  const gaps = gapCount(c1, 30);
  if (gaps > a.maxGapMin) return blocked("gaps_in_data", { gaps });
  if (!Number.isFinite(a.spreadBps) || a.spreadBps < 0) return blocked("no_spread");

  const closes1 = c1.map((x) => x.c);
  const closes15 = c15.map((x) => x.c);
  const eF = ema(closes15, s.ema_fast);
  const eS = ema(closes15, s.ema_slow);
  const a15 = atr(c15, s.atr_period);
  const r1 = rsi(closes1, s.rsi_period);
  const i = n15 - 1;
  const price = closes1[n1 - 1];
  const atr15 = a15[i];
  if (![eF[i], eS[i], eS[i - 4], atr15, r1[n1 - 1], r1[n1 - 4]].every(Number.isFinite) || atr15 <= 0) {
    return blocked("insufficient_history");
  }

  const band = s.bands[a.market] ?? { atr_pct_min: 0, atr_pct_max: 1 };
  const atrPct = atr15 / price;
  const costBps = roundTripCostBps(costs, a.spreadBps);
  const stopDist = s.atr_stop_mult * atr15;
  const tpDist = s.rr * stopDist;
  const targetBps = (tpDist / price) * 1e4;
  const edge = targetBps / costBps;

  const slopeS = eS[i] - eS[i - 4];
  const trend = eF[i] > eS[i] && slopeS > 0 && price > eS[i] ? "up" : eF[i] < eS[i] && slopeS < 0 && price < eS[i] ? "down" : "flat";
  const side: Side | null = trend === "up" ? "long" : trend === "down" ? "short" : null;

  // RSI cross: first candle (k bars ago, k = 0..2) that is on the trigger side after being on the other side
  let barsSince: number | null = null;
  if (side) {
    const th = side === "long" ? s.rsi_long_cross : s.rsi_short_cross;
    const onSide = (v: number) => (side === "long" ? v >= th : v <= th);
    for (let k = 0; k <= 2 && barsSince === null; k++) {
      const idx = n1 - 1 - k;
      let held = true;
      for (let j = idx; j < n1; j++) if (!onSide(r1[j])) held = false;
      if (held && !onSide(r1[idx - 1])) barsSince = k;
    }
  }

  const pull = Math.abs(price - eF[i]) / atr15;
  const features = {
    price: round(price, 6),
    trend,
    ema_fast_15m: round(eF[i], 6),
    ema_slow_15m: round(eS[i], 6),
    atr_15m: round(atr15, 6),
    atr_pct: round(atrPct * 100, 4),
    rsi_1m: round(r1[n1 - 1], 2),
    rsi_cross_bars_ago: barsSince,
    pullback_atr: round(pull, 3),
    spread_bps: round(a.spreadBps, 3),
    spread_source: a.spreadSource,
    cost_bps: round(costBps, 2),
    target_bps: round(targetBps, 2),
    edge_multiple: round(edge, 2),
    lag_s: Math.round(lag1),
  };

  const reasons: string[] = [];
  if (!side) reasons.push("no_trend");
  else if (side === "short" && !a.allowShort) reasons.push("short_not_allowed");
  if (side && barsSince === null) reasons.push("no_rsi_trigger");
  if (atrPct < band.atr_pct_min || atrPct > band.atr_pct_max) {
    reasons.push(`volatility_out_of_band(${(atrPct * 100).toFixed(3)}%)`);
  }
  if (edge < s.min_edge_multiple) {
    reasons.push(`cost_gate(target ${targetBps.toFixed(1)}bps < ${s.min_edge_multiple}x cost ${costBps.toFixed(1)}bps)`);
  }

  // quality 0..100 (only meaningful with a trend side)
  let parts: Record<string, number> = {};
  let quality = 0;
  if (side) {
    const dir = side === "long" ? 1 : -1;
    const strength = Math.abs(eF[i] - eS[i]) / atr15;
    const trendC = Math.min(15, (strength / 1.5) * 15) + (Math.abs(slopeS) / atr15 > 0.1 ? 10 : 0);
    const pullC = pull <= 0.5 ? 20 : pull <= 1 ? 14 : pull <= 1.5 ? 8 : 0;
    const trigC = barsSince === null ? 0 : [25, 18, 12][barsSince];
    const momC = dir * (price / closes1[n1 - 6] - 1) > 0 ? 10 : 0;
    const volaC = atrPct >= band.atr_pct_min * 1.5 && atrPct <= band.atr_pct_max * 0.6 ? 10 : 5;
    const edgeC = edge >= 4 ? 10 : edge >= 3 ? 7 : edge >= 2 ? 3 : 0;
    parts = {
      trend: Math.round(trendC),
      pullback: pullC,
      trigger: trigC,
      momentum: momC,
      volatility: volaC,
      cost_edge: edgeC,
    };
    quality = Math.round(trendC + pullC + trigC + momC + volaC + edgeC);
    if (quality < s.min_quality) reasons.push(`quality_below_min(${quality}<${s.min_quality})`);
  }

  return {
    decision: reasons.length === 0 ? "entry_signal" : "no_signal",
    side,
    quality,
    reasons,
    features,
    parts,
    plan: { stopDist, tpDist, targetBps, costBps, edge },
  };
}

// ---------- fills, sizing, exits, pnl ----------

/** Entry fill: long buys at the ask, short sells at the bid, both worsened by slippage. */
export function entryFill(side: Side, bid: number, ask: number, slipBps: number): number {
  return side === "long" ? ask * (1 + slipBps / 1e4) : bid * (1 - slipBps / 1e4);
}
/** Exit fill from a reference price: pay half the spread plus slippage (long sells lower, short buys higher). */
export function exitFill(side: Side, ref: number, spreadBps: number, slipBps: number): number {
  const adj = (spreadBps / 2 + slipBps) / 1e4;
  return side === "long" ? ref * (1 - adj) : ref * (1 + adj);
}

export function sizeQty(p: {
  equity: number;
  cash: number;
  price: number;
  stopDist: number;
  riskPct: number;
  maxPositionPct: number;
  minNotional: number;
}): { qty: number; limit: "risk" | "position_cap" | "cash" } | { reason: string } {
  if (!(p.stopDist > 0) || !(p.price > 0) || !(p.equity > 0) || !(p.cash > 0)) return { reason: "bad_inputs" };
  const qtyRisk = (p.equity * p.riskPct) / 100 / p.stopDist;
  const qtyCap = (p.equity * p.maxPositionPct) / 100 / p.price;
  const qtyCash = p.cash / (p.price * 1.01); // 1 % buffer for fee and slippage
  const q = Math.min(qtyRisk, qtyCap, qtyCash);
  const limit = q === qtyRisk ? "risk" : q === qtyCap ? "position_cap" : "cash";
  const qty = Math.floor(q * 1e6) / 1e6;
  if (!(qty > 0) || qty * p.price < p.minNotional) return { reason: "min_notional" };
  return { qty, limit };
}

/**
 * Walk closed candles that opened AFTER the entry minute. If one candle touches both stop and target,
 * the stop is assumed to hit first (conservative). A gap through the level fills at the candle open.
 */
export function checkExit(
  pos: { side: Side; sl: number; tp: number; entryMs: number },
  candles: Candle[],
): { raw: number; reason: "stop" | "target"; ts: number } | null {
  const first = Math.floor(pos.entryMs / MINUTE) * MINUTE + MINUTE;
  for (const c of candles) {
    if (c.ts < first) continue;
    if (pos.side === "long") {
      if (c.l <= pos.sl) return { raw: c.o < pos.sl ? c.o : pos.sl, reason: "stop", ts: c.ts };
      if (c.h >= pos.tp) return { raw: c.o > pos.tp ? c.o : pos.tp, reason: "target", ts: c.ts };
    } else {
      if (c.h >= pos.sl) return { raw: c.o > pos.sl ? c.o : pos.sl, reason: "stop", ts: c.ts };
      if (c.l <= pos.tp) return { raw: c.o < pos.tp ? c.o : pos.tp, reason: "target", ts: c.ts };
    }
  }
  return null;
}

export function tradePnl(side: Side, entry: number, qty: number, entryFee: number, exit: number, exitFee: number) {
  const gross = (exit - entry) * qty * (side === "long" ? 1 : -1);
  return { gross, net: gross - entryFee - exitFee };
}

/** Value of a position at a mark price including the reserved notional (cash model: notional is reserved at entry). */
export function positionValue(side: Side, entryNotional: number, entry: number, qty: number, mark: number): number {
  return entryNotional + (mark - entry) * qty * (side === "long" ? 1 : -1);
}
