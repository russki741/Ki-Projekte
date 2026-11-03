// Pure replay of the live strategy on stored 1m candles. No I/O, no Deno APIs (also runs under Node tests).
// SIMULATION ONLY. Mirrors agent-tick: same evaluateSetup / fills / sizing / exits, one position per symbol.
// Not modelled (live-only gates): max positions across symbols, daily loss limit, loss-streak pause, news hold, lessons.
import { type Candle, MINUTE, rsi } from "./lib.ts";
import { type CostCfg, type Side, type StratCfg, checkExit, entryFill, evaluateSetup, exitFill, sizeQty, tradePnl } from "./strategy.ts";

const M15 = 15 * MINUTE;

export type SimParams = {
  fromMs: number; // entries only for decisions with candle open time in [fromMs, toMs)
  toMs: number;
  strat: StratCfg;
  costs: CostCfg;
  risk: { risk_per_trade_pct?: number; max_position_pct?: number; min_notional_usd?: number; cooldown_after_stop_min?: number };
  spreadBps: number;
  allowShort: boolean;
  capital: number;
  market?: string;
};

export type SimTrade = {
  side: Side;
  entryMs: number;
  exitMs: number;
  entryPx: number;
  exitPx: number;
  qty: number;
  quality: number;
  reason: "stop" | "target" | "time" | "end";
  gross: number;
  fees: number;
  net: number;
  r: number;
  risk: number;
};

type Pos = { side: Side; entryMs: number; entryPx: number; qty: number; fee: number; sl: number; tp: number; risk: number; quality: number };

/** 15m candles built from 1m candles (bucket aligned to :00/:15/:30/:45). */
export function aggregate15(c1: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of c1) {
    const b0 = Math.floor(c.ts / M15) * M15;
    if (!cur || cur.ts !== b0) {
      if (cur) out.push(cur);
      cur = { ts: b0, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function simulate(c1all: Candle[], p: SimParams): { trades: SimTrade[]; evaluated: number; minutes: number } {
  const n = c1all.length;
  const trades: SimTrade[] = [];
  const s = p.strat;
  const cc = p.costs;
  const market = p.market ?? "crypto";
  const buckets = aggregate15(c1all);
  const r1 = rsi(c1all.map((x) => x.c), s.rsi_period);
  const maxHold = (s.max_hold_min ?? 240) * MINUTE;
  const cooldown = (p.risk.cooldown_after_stop_min ?? 15) * MINUTE;

  // cheap pre-filter on a full-series RSI (converged, differs from the 300-candle window by < 1e-6): only evaluate
  // minutes where an RSI cross happened within the last 3 bars (tolerance of 1 point), the rest cannot pass the trigger gate.
  const crossNear = (i: number, th: number, long: boolean): boolean => {
    for (let k = 0; k <= 2; k++) {
      const idx = i - k;
      if (idx < 1) return false;
      let held = true;
      for (let j = idx; j <= i; j++) {
        const v = r1[j];
        if (!(long ? v >= th - 1 : v <= th + 1)) { held = false; break; }
      }
      const prev = r1[idx - 1];
      if (held && (long ? prev < th + 1 : prev > th - 1)) return true;
    }
    return false;
  };

  let pos: Pos | null = null;
  let lastStopMs = -Infinity;
  let bj = -1;
  let evaluated = 0;

  const close = (i: number, now: number, exitPx: number, reason: SimTrade["reason"]) => {
    const q = pos!;
    const fee = (exitPx * q.qty * cc.fee_bps) / 1e4;
    const { gross, net } = tradePnl(q.side, q.entryPx, q.qty, q.fee, exitPx, fee);
    trades.push({
      side: q.side, entryMs: q.entryMs, exitMs: now, entryPx: q.entryPx, exitPx, qty: q.qty, quality: q.quality, reason,
      gross, fees: q.fee + fee, net, r: q.risk > 0 ? net / q.risk : 0, risk: q.risk,
    });
    if (reason === "stop") lastStopMs = now;
    pos = null;
  };

  for (let i = 0; i < n; i++) {
    const c = c1all[i];
    const now = c.ts + MINUTE + 2000; // decision time: just after this candle closed
    while (bj + 1 < buckets.length && buckets[bj + 1].ts + M15 <= c.ts + MINUTE) bj++;

    // 1. exits first (same order as live): stop/target on closed candles after the entry minute, then the time limit
    if (pos) {
      const hit = checkExit({ side: pos.side, sl: pos.sl, tp: pos.tp, entryMs: pos.entryMs }, [c]);
      if (hit) close(i, now, exitFill(pos.side, hit.raw, p.spreadBps, cc.slip_bps), hit.reason);
      else if (now - pos.entryMs >= maxHold) close(i, now, exitFill(pos.side, c.c, p.spreadBps, cc.slip_bps), "time");
    }

    // 2. entry
    if (pos || c.ts < p.fromMs || c.ts >= p.toMs || i < 60 || bj < s.ema_slow + 6) continue;
    const longNear = crossNear(i, s.rsi_long_cross, true);
    const shortNear = p.allowShort && crossNear(i, s.rsi_short_cross, false);
    if (!longNear && !shortNear) continue;
    evaluated++;
    const c1 = c1all.slice(Math.max(0, i - 299), i + 1);
    const c15 = buckets.slice(Math.max(0, bj - 119), bj + 1);
    const setup = evaluateSetup({
      market, c1, c15, nowMs: now, spreadBps: p.spreadBps, spreadSource: "measured", strat: s, costs: cc,
      allowShort: p.allowShort, maxLagS: 180, maxGapMin: 0,
    });
    if (setup.decision !== "entry_signal" || !setup.side || !setup.plan) continue;
    if (now - lastStopMs < cooldown) continue;
    const side = setup.side;
    const last = c.c;
    const bid = last * (1 - p.spreadBps / 2 / 1e4);
    const ask = last * (1 + p.spreadBps / 2 / 1e4);
    const fill = entryFill(side, bid, ask, cc.slip_bps);
    const { stopDist, tpDist } = setup.plan;
    const size = sizeQty({
      equity: p.capital, cash: p.capital, price: fill, stopDist, riskPct: p.risk.risk_per_trade_pct ?? 1,
      maxPositionPct: p.risk.max_position_pct ?? 25, minNotional: p.risk.min_notional_usd ?? 10,
    });
    if ("reason" in size) continue;
    const notional = fill * size.qty;
    const fee = (notional * cc.fee_bps) / 1e4;
    pos = {
      side, entryMs: now, entryPx: fill, qty: size.qty, fee, quality: setup.quality, risk: stopDist * size.qty,
      sl: side === "long" ? fill - stopDist : fill + stopDist, tp: side === "long" ? fill + tpDist : fill - tpDist,
    };
  }
  if (pos) {
    const last = c1all[n - 1];
    close(n - 1, last.ts + MINUTE + 2000, exitFill(pos.side, last.c, p.spreadBps, cc.slip_bps), "end");
  }
  return { trades, evaluated, minutes: n };
}
