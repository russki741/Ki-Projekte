// Multi-market study for the strategy lab: the rulebook rules on many markets at once (crypto, commodities, currencies),
// with different exits (rule only, trailing stop, quick take-profit, stop, maximum holding time). SIMULATION ONLY, pure functions.
//
// Same timing as portfolio() in lab.ts (no look-ahead): decide at the CLOSE of a bar, execute at the OPEN of the market's next bar.
// Take-profit and stop are checked inside the bar with high/low; if both are touched in the same bar the STOP counts first.
// Markets with different trading calendars (crypto every day, futures and currencies on weekdays) share one timeline:
// a market without a bar at a step is simply not traded at that step and keeps its last close for the valuation.
import { atr, type Bar, type Costs, realizedVol, type Rule } from "./lab.ts";

export type Exit = {
  id: string;
  tpPct?: number; // take profit: sell as soon as the price is tpPct % above the entry price
  stopPct?: number; // fixed stop: sell when the price is stopPct % below the entry price
  trailAtr?: number; // chandelier trailing stop: close below (highest close since entry - k x ATR)
  maxBars?: number; // sell after this many bars at the latest
  reentry?: boolean; // after take-profit / stop / time exit: buy again at the next close while the rule is still on
};
export type StudyCfg = { sizing: "equal" | "vol"; refVol: number; volDays: number; periodScale: number; capital: number };
export type StudyMetrics = {
  total_pct: number; cagr_pct: number; sharpe: number; max_dd_pct: number; trades: number; win_pct: number;
  avg_trade_pct: number; avg_hold_bars: number; exposure_pct: number; fees_pct_of_capital: number; last365_pct: number | null;
};
export type StudyResult = {
  metrics: StudyMetrics;
  years: Record<string, number>;
  halves: [number, number]; // result in % of the first and of the second half of the period
  bySymbol: Record<string, { trades: number; net_pct_of_capital: number }>;
  exits: Record<string, number>;
  steps: number;
};

const YEAR = 365.25 * 86400_000;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Inverse market (e.g. USD/EUR from EUR/USD): buying the inverse is the same bet as selling the original, without leverage. */
export function inverse(b: Bar[]): Bar[] {
  return b.map((x) => ({ ts: x.ts, o: 1 / x.o, h: 1 / x.l, l: 1 / x.h, c: 1 / x.c, v: x.v }));
}

type Pos = { qty: number; entryPx: number; entryTs: number; entryFee: number; hi: number; bars: number };

export function study(
  data: Record<string, Bar[]>, rule: Rule | "hold", exit: Exit, cfg: StudyCfg, costs: (s: string) => Costs, fromTs = -Infinity, toTs = Infinity,
): StudyResult {
  const syms = Object.keys(data).filter((s) => data[s].length > 2);
  const N = syms.length;
  const sig: Record<string, boolean[]> = {}, atrs: Record<string, number[]> = {}, cl: Record<string, number[]> = {};
  const idx: Record<string, Map<number, number>> = {}, bpy: Record<string, number> = {};
  const all = new Set<number>();
  for (const s of syms) {
    const b = data[s];
    sig[s] = rule === "hold" ? b.map(() => true) : rule.signal(b);
    atrs[s] = atr(b, Math.max(2, Math.round(20 * cfg.periodScale)));
    cl[s] = b.map((x) => x.c);
    idx[s] = new Map(b.map((x, i) => [x.ts, i]));
    bpy[s] = (b.length - 1) / Math.max(1e-9, (b[b.length - 1].ts - b[0].ts) / YEAR); // bars per year of this market
    for (const x of b) if (x.ts >= fromTs && x.ts <= toTs) all.add(x.ts);
  }
  const ts = [...all].sort((a, b) => a - b);
  const trailK = exit.trailAtr ?? (rule === "hold" ? undefined : rule.trailAtr); // rules like donchian_100_trail bring their own trailing stop
  let cash = cfg.capital, fees = 0;
  const pos: Record<string, Pos | null> = Object.fromEntries(syms.map((s) => [s, null]));
  const pending: Record<string, "buy" | "sell" | null> = Object.fromEntries(syms.map((s) => [s, null]));
  const pendingReason: Record<string, string> = {};
  const blocked: Record<string, boolean> = Object.fromEntries(syms.map((s) => [s, false]));
  const lastClose: Record<string, number> = {};
  for (const s of syms) {
    // valuation before the first own bar inside the period: the last close before it
    const b = data[s];
    let k = -1;
    for (let i = 0; i < b.length && b[i].ts < (ts[0] ?? Infinity); i++) k = i;
    lastClose[s] = k >= 0 ? b[k].c : b[0].o;
  }
  const trades: { symbol: string; netUsd: number; retPct: number; bars: number; reason: string }[] = [];
  const equity: { ts: number; e: number }[] = [];
  let investedSum = 0;

  const close = (s: string, rawPx: number, t: number, reason: string) => {
    const p = pos[s]!;
    const c = costs(s), half = (c.spreadBps / 2 + c.slipBps) / 1e4, fee = c.feeBps / 1e4;
    const px = rawPx * (1 - half), gross = p.qty * px, f = gross * fee;
    cash += gross - f; fees += f;
    const net = gross - f - p.qty * p.entryPx - p.entryFee;
    trades.push({ symbol: s, netUsd: net, retPct: (net / (p.qty * p.entryPx)) * 100, bars: p.bars, reason });
    pos[s] = null;
    if (!exit.reentry && reason !== "signal") blocked[s] = true;
  };

  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    const today = syms.filter((s) => idx[s].has(t));
    // 1. orders decided at the previous close of each market, at this open (sells first)
    const eqOpen = cash + syms.reduce((a, s) => a + (pos[s] ? pos[s]!.qty * (idx[s].has(t) ? data[s][idx[s].get(t)!].o : lastClose[s]) : 0), 0);
    const order = [...today.filter((s) => pending[s] === "sell"), ...today.filter((s) => pending[s] !== "sell")];
    for (const s of order) {
      const i = idx[s].get(t)!, bar = data[s][i];
      if (pending[s] === "sell" && pos[s]) close(s, bar.o, t, pendingReason[s] || "signal");
      else if (pending[s] === "buy" && !pos[s]) {
        let w = 1 / N;
        if (cfg.sizing === "vol") {
          const v = realizedVol(cl[s], i - 1, Math.max(2, Math.round(cfg.volDays * cfg.periodScale)), bpy[s]);
          if (Number.isFinite(v) && v > 0) w *= Math.min(1, cfg.refVol / v);
        }
        const c = costs(s), half = (c.spreadBps / 2 + c.slipBps) / 1e4, fee = c.feeBps / 1e4;
        const px = bar.o * (1 + half);
        const budget = Math.min(eqOpen * w, cash / (1 + fee));
        if (budget > 1e-6 * cfg.capital) {
          const f = budget * fee;
          cash -= budget + f; fees += f;
          pos[s] = { qty: budget / px, entryPx: px, entryTs: t, entryFee: f, hi: bar.c, bars: 0 };
        }
      }
      pending[s] = null;
    }
    // 2. take-profit and stop inside the bar (stop first when both are touched)
    for (const s of today) {
      const p = pos[s];
      if (!p) continue;
      const bar = data[s][idx[s].get(t)!];
      const ref = p.entryPx; // entry incl. half spread and slippage
      const stopLvl = exit.stopPct ? ref * (1 - exit.stopPct / 100) : -Infinity;
      const tpLvl = exit.tpPct ? ref * (1 + exit.tpPct / 100) : Infinity;
      const open = p.entryTs === t ? ref : bar.o;
      if (bar.l <= stopLvl) close(s, Math.min(open, stopLvl), t, "stop");
      else if (bar.h >= tpLvl) close(s, Math.max(open, tpLvl), t, "take_profit");
    }
    // 3. valuation at the close
    let invested = 0;
    for (const s of syms) {
      if (idx[s].has(t)) lastClose[s] = data[s][idx[s].get(t)!].c;
      if (pos[s]) invested += pos[s]!.qty * lastClose[s];
    }
    const e = cash + invested;
    equity.push({ ts: t, e });
    investedSum += e > 0 ? invested / e : 0;
    // 4. decide at the close of each market that has a bar now
    if (k === ts.length - 1) break;
    for (const s of today) {
      const i = idx[s].get(t)!;
      const want = sig[s][i] === true;
      if (!want) blocked[s] = false;
      const p = pos[s];
      if (p) {
        p.hi = Math.max(p.hi, data[s][i].c);
        p.bars++;
        const a = atrs[s][i];
        if (!want) { pending[s] = "sell"; pendingReason[s] = "signal"; }
        else if (trailK && a > 0 && data[s][i].c < p.hi - trailK * a) { pending[s] = "sell"; pendingReason[s] = "trailing_stop"; }
        else if (exit.maxBars && p.bars >= exit.maxBars) { pending[s] = "sell"; pendingReason[s] = "time"; }
      } else if (want && !blocked[s]) pending[s] = "buy";
    }
  }

  // metrics
  const e0 = cfg.capital, eN = equity.length ? equity[equity.length - 1].e : e0;
  const span = equity.length > 1 ? (equity[equity.length - 1].ts - equity[0].ts) / YEAR : 0;
  const stepsPerYear = span > 0 ? (equity.length - 1) / span : 1;
  const rets: number[] = [];
  for (let k = 1; k < equity.length; k++) rets.push(equity[k].e / equity[k - 1].e - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  let peak = e0, mdd = 0;
  for (const p of equity) { peak = Math.max(peak, p.e); mdd = Math.max(mdd, 1 - p.e / peak); }
  const years: Record<string, number> = {};
  let prevE = e0, prevY = equity.length ? new Date(equity[0].ts).getUTCFullYear() : 0;
  for (let k = 0; k < equity.length; k++) {
    const y = new Date(equity[k].ts).getUTCFullYear();
    if (y !== prevY) { years[prevY] = r1((equity[k - 1].e / prevE - 1) * 100); prevE = equity[k - 1].e; prevY = y; }
  }
  if (equity.length) years[prevY] = r1((eN / prevE - 1) * 100);
  const mid = equity.length ? equity[0].ts + (equity[equity.length - 1].ts - equity[0].ts) / 2 : 0;
  const km = equity.findIndex((p) => p.ts >= mid);
  const eMid = km > 0 ? equity[km - 1].e : e0;
  const cut = equity.length ? equity[equity.length - 1].ts - 365 * 86400_000 : 0;
  const k365 = equity.findIndex((p) => p.ts >= cut);
  const wins = trades.filter((t) => t.netUsd > 0).length;
  const bySymbol: Record<string, { trades: number; net_pct_of_capital: number }> = {};
  const exits: Record<string, number> = {};
  for (const t of trades) {
    const b = (bySymbol[t.symbol] ??= { trades: 0, net_pct_of_capital: 0 });
    b.trades++; b.net_pct_of_capital += (t.netUsd / e0) * 100;
    exits[t.reason] = (exits[t.reason] ?? 0) + 1;
  }
  for (const s of Object.keys(bySymbol)) bySymbol[s].net_pct_of_capital = r1(bySymbol[s].net_pct_of_capital);
  return {
    metrics: {
      total_pct: r1((eN / e0 - 1) * 100),
      cagr_pct: r1(span > 0 && eN > 0 ? (Math.pow(eN / e0, 1 / span) - 1) * 100 : 0),
      sharpe: sd > 0 ? Math.round((mean / sd) * Math.sqrt(stepsPerYear) * 100) / 100 : 0,
      max_dd_pct: r1(mdd * 100),
      trades: trades.length,
      win_pct: r1(trades.length ? (wins / trades.length) * 100 : 0),
      avg_trade_pct: Math.round((trades.length ? trades.reduce((a, t) => a + t.retPct, 0) / trades.length : 0) * 100) / 100,
      avg_hold_bars: r1(trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0),
      exposure_pct: r1((investedSum / Math.max(1, equity.length)) * 100),
      fees_pct_of_capital: r1((fees / e0) * 100),
      last365_pct: k365 > 0 ? r1((eN / equity[k365 - 1].e - 1) * 100) : null,
    },
    years,
    halves: [r1((eMid / e0 - 1) * 100), r1((eN / eMid - 1) * 100)],
    bySymbol,
    exits,
    steps: equity.length,
  };
}
