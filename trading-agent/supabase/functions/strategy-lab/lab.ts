// strategy-lab core: indicators, a no-look-ahead long-only simulator with realistic costs, and the strategy catalogue.
// SIMULATION ONLY. Pure functions, no I/O.
//
// Timing rules (no look-ahead):
//  - a signal is computed from bars up to and including the CLOSED bar i, the order is filled at the OPEN of bar i+1
//  - exits by signal: signal on closed bar j-1 -> fill at the open of bar j
//  - stop/target are checked inside the bar with its high/low; if both are touched in the same bar the STOP counts first
//  - every fill pays fee + slippage + half the spread (costs.* in bps)

export type Bar = { ts: number; o: number; h: number; l: number; c: number; v: number };
export type Costs = { feeBps: number; slipBps: number; spreadBps: number };
export type Trade = { entryTs: number; exitTs: number; grossBps: number; netBps: number; bars: number; reason: string };
export type Spec = { entry: boolean[]; exitSig?: boolean[]; atr?: number[]; stopAtr?: number; targetAtr?: number; maxBars?: number };

// ---------- indicators (value at index i uses bars <= i only; NaN while not defined) ----------

export function ema(x: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out = new Array<number>(x.length).fill(NaN);
  if (x.length < n) return out;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  out[n - 1] = s / n; // seeded with the SMA, so no value depends on bars before the window in a different way than on the full history
  for (let i = n; i < x.length; i++) out[i] = x[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function sma(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function rollStd(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i]; s2 += x[i] * x[i];
    if (i >= n) { s -= x[i - n]; s2 -= x[i - n] * x[i - n]; }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  return out;
}

export function rsi(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  if (x.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = x[i] - x[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n;
    l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function atr(b: Bar[], n: number): number[] {
  const out = new Array<number>(b.length).fill(NaN);
  if (b.length <= n) return out;
  const tr = (i: number) => Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr(i);
  a /= n;
  out[n] = a;
  for (let i = n + 1; i < b.length; i++) { a = (a * (n - 1) + tr(i)) / n; out[i] = a; }
  return out;
}

// highest high / lowest low of the n bars BEFORE bar i (the current bar is excluded)
export function priorMax(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) { let m = -Infinity; for (let j = i - n; j < i; j++) if (x[j] > m) m = x[j]; out[i] = m; }
  return out;
}
export function priorMin(x: number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) { let m = Infinity; for (let j = i - n; j < i; j++) if (x[j] < m) m = x[j]; out[i] = m; }
  return out;
}

// ---------- simulator ----------

export function simulate(b: Bar[], s: Spec, c: Costs): Trade[] {
  const half = (c.spreadBps / 2 + c.slipBps) / 1e4;
  const fee = c.feeBps / 1e4;
  const n = b.length;
  const trades: Trade[] = [];
  const close = (e: number, xi: number, entryRaw: number, exitRaw: number, reason: string) => {
    const entryC = entryRaw * (1 + half), exitC = exitRaw * (1 - half);
    trades.push({
      entryTs: b[e].ts, exitTs: b[xi].ts, bars: xi - e + 1, reason,
      grossBps: (exitRaw / entryRaw - 1) * 1e4,
      netBps: ((exitC * (1 - fee)) / (entryC * (1 + fee)) - 1) * 1e4,
    });
  };
  let i = 0;
  while (i < n - 1) {
    if (!s.entry[i]) { i++; continue; }
    const e = i + 1;
    const entryRaw = b[e].o;
    const a = s.atr ? s.atr[i] : NaN;
    const stop = s.stopAtr && a > 0 ? entryRaw - s.stopAtr * a : -Infinity;
    const target = s.targetAtr && a > 0 ? entryRaw + s.targetAtr * a : Infinity;
    let done = false;
    for (let j = e; j < n; j++) {
      if (j > e && s.exitSig?.[j - 1]) { close(e, j, entryRaw, b[j].o, "signal"); i = j; done = true; break; }
      if (b[j].l <= stop) { close(e, j, entryRaw, Math.min(stop, b[j].o), "stop"); i = j; done = true; break; }
      if (b[j].h >= target) { close(e, j, entryRaw, target, "target"); i = j; done = true; break; }
      if (s.maxBars && j - e + 1 >= s.maxBars) {
        if (j + 1 < n) { close(e, j + 1, entryRaw, b[j + 1].o, "time"); i = j + 1; } else { close(e, j, entryRaw, b[j].c, "time"); i = j; }
        done = true; break;
      }
    }
    if (!done) { close(e, n - 1, entryRaw, b[n - 1].c, "end"); break; }
  }
  return trades;
}

export type Stats = { n: number; win_pct: number; gross_bps: number; net_bps: number; sd_bps: number; t: number; sum_net_bps: number; pf: number | null; avg_bars: number };

export function stats(t: { netBps: number; grossBps: number; bars: number }[]): Stats {
  const n = t.length;
  if (!n) return { n: 0, win_pct: 0, gross_bps: 0, net_bps: 0, sd_bps: 0, t: 0, sum_net_bps: 0, pf: null, avg_bars: 0 };
  let sg = 0, sn = 0, wins = 0, gw = 0, gl = 0, bars = 0;
  for (const x of t) { sg += x.grossBps; sn += x.netBps; if (x.netBps > 0) { wins++; gw += x.netBps; } else gl -= x.netBps; bars += x.bars; }
  const m = sn / n;
  let v = 0;
  for (const x of t) v += (x.netBps - m) ** 2;
  const sd = n > 1 ? Math.sqrt(v / (n - 1)) : 0;
  const r = (q: number) => Math.round(q * 100) / 100;
  return { n, win_pct: r((wins / n) * 100), gross_bps: r(sg / n), net_bps: r(m), sd_bps: r(sd), t: sd > 0 ? r(m / (sd / Math.sqrt(n))) : 0, sum_net_bps: r(sn), pf: gl > 0 ? r(gw / gl) : null, avg_bars: r(bars / n) };
}

// ---------- strategy catalogue (long-only, spot) ----------

export type Strat = { id: string; family: string; build: (b: Bar[]) => Spec };

const gt = (a: number, b: number) => a > b; // NaN compares false, so undefined indicators never signal

function donchian(N: number): Strat {
  const M = Math.max(10, Math.round(N / 2));
  return {
    id: `donchian_${N}`, family: "breakout",
    build: (b) => {
      const hi = priorMax(b.map((x) => x.h), N), lo = priorMin(b.map((x) => x.l), M), a = atr(b, 14);
      return { entry: b.map((x, i) => gt(x.c, hi[i])), exitSig: b.map((x, i) => x.c < lo[i]), atr: a, stopAtr: 3 };
    },
  };
}
function emaCross(f: number, s: number): Strat {
  return {
    id: `ema_cross_${f}_${s}`, family: "trend",
    build: (b) => {
      const c = b.map((x) => x.c), ef = ema(c, f), es = ema(c, s), a = atr(b, 14);
      return { entry: b.map((_, i) => i > 0 && gt(ef[i], es[i]) && ef[i - 1] <= es[i - 1]), exitSig: b.map((_, i) => ef[i] < es[i]), atr: a, stopAtr: 3 };
    },
  };
}
function trendState(f: number, s: number): Strat {
  return {
    id: `trend_${f}_${s}`, family: "trend",
    build: (b) => {
      const c = b.map((x) => x.c), ef = ema(c, f), es = ema(c, s), a = atr(b, 14);
      const on = c.map((x, i) => x > ef[i] && ef[i] > es[i]);
      return { entry: on.map((v, i) => v && i > 0 && !on[i - 1]), exitSig: c.map((x, i) => x < ef[i]), atr: a, stopAtr: 3 };
    },
  };
}
function bbRevert(k: number, trendN: number): Strat {
  return {
    id: `bb_revert_20_${k}_t${trendN}`, family: "mean_reversion",
    build: (b) => {
      const c = b.map((x) => x.c), mid = sma(c, 20), sd = rollStd(c, 20), tr = ema(c, trendN), a = atr(b, 14);
      return { entry: c.map((x, i) => x < mid[i] - k * sd[i] && x > tr[i]), exitSig: c.map((x, i) => x > mid[i]), atr: a, stopAtr: 3, maxBars: 24 };
    },
  };
}
function rsi2(th: number, trendN: number): Strat {
  return {
    id: `rsi2_lt${th}_t${trendN}`, family: "mean_reversion",
    build: (b) => {
      const c = b.map((x) => x.c), r = rsi(c, 2), tr = ema(c, trendN), s5 = sma(c, 5), a = atr(b, 14);
      return { entry: c.map((x, i) => r[i] < th && x > tr[i]), exitSig: c.map((x, i) => r[i] > 65 || x > s5[i]), atr: a, stopAtr: 3, maxBars: 12 };
    },
  };
}

export function catalogue(): Strat[] {
  return [
    donchian(20), donchian(55), donchian(100),
    emaCross(9, 21), emaCross(20, 50), emaCross(50, 200),
    trendState(50, 200),
    bbRevert(2, 200), bbRevert(2.5, 200),
    rsi2(5, 200), rsi2(10, 200),
  ];
}

// buy once at the first open, sell at the last close: the benchmark every long-only rule has to beat
export function buyAndHold(b: Bar[], c: Costs): Trade[] {
  if (b.length < 2) return [];
  return simulate(b, { entry: b.map((_, i) => i === 0) }, c);
}

// =====================================================================================================
// Rulebook v2: well-known rules from trading literature, simulated as a PORTFOLIO on 4h / daily bars.
// - A rule only says "in the market or not" for each bar, decided at the CLOSE of that bar.
//   Orders execute at the OPEN of the next bar (no look-ahead).
// - Position size is fixed at entry: equal weight (1/N) or scaled down by volatility ("vol": 1/N * min(1, refVol / vol)).
// - Optional chandelier trailing stop: exit when the close falls more than k x ATR below the highest close since entry;
//   after such a stop the rule must switch off and on again before a new entry.
// - Costs on every fill: fee + slippage + half the spread. Parameters are the textbook ones, never fitted to this data.
// =====================================================================================================

export type Rule = { id: string; name: string; source: string; signal: (b: Bar[]) => boolean[]; trailAtr?: number };

/** Turns entry and exit events into an in/out state: on at an entry event, off at an exit event (exit wins on the same bar). */
export function stateFrom(enter: boolean[], exit: boolean[]): boolean[] {
  const out = new Array<boolean>(enter.length).fill(false);
  let on = false;
  for (let i = 0; i < enter.length; i++) {
    if (on && exit[i]) on = false;
    else if (!on && enter[i] && !exit[i]) on = true;
    out[i] = on;
  }
  return out;
}

export function rulebook(barsPerDay: number): Rule[] {
  const d = (days: number) => Math.max(2, Math.round(days * barsPerDay));
  const closes = (b: Bar[]) => b.map((x) => x.c);
  const turtle = (enterDays: number, exitDays: number): Rule => ({
    id: `turtle_${enterDays}_${exitDays}`, name: `Turtle-Ausbruch ${enterDays}/${exitDays} Tage`, source: "Richard Dennis, Turtle Traders (System " + (enterDays === 20 ? "1" : "2") + ")",
    signal: (b) => {
      const hi = priorMax(b.map((x) => x.h), d(enterDays)), lo = priorMin(b.map((x) => x.l), d(exitDays));
      return stateFrom(b.map((x, i) => gt(x.c, hi[i])), b.map((x, i) => x.c < lo[i]));
    },
  });
  return [
    { id: "golden_cross", name: "Golden Cross (50/200 Tage)", source: "klassische Trendfolge, z. B. Murphy, Technical Analysis of the Financial Markets",
      signal: (b) => { const c = closes(b), f = ema(c, d(50)), s = ema(c, d(200)); return c.map((_, i) => gt(f[i], s[i])); } },
    { id: "sma200", name: "Kurs über der 200-Tage-Linie", source: "Faber, A Quantitative Approach to Tactical Asset Allocation (Zeitreihen-Trendfilter)",
      signal: (b) => { const c = closes(b), m = sma(c, d(200)); return c.map((x, i) => gt(x, m[i])); } },
    turtle(20, 10),
    turtle(55, 20),
    { id: "donchian_100_trail", name: "Ausbruch 100 Tage mit Trailing-Stop", source: "Donchian-Kanal mit Chandelier-Exit (LeBeau)", trailAtr: 3,
      signal: (b) => { const hi = priorMax(b.map((x) => x.h), d(100)), lo = priorMin(b.map((x) => x.l), d(50)); return stateFrom(b.map((x, i) => gt(x.c, hi[i])), b.map((x, i) => x.c < lo[i])); } },
    { id: "tsmom_90", name: "Momentum 90 Tage", source: "Moskowitz, Ooi, Pedersen, Time Series Momentum (2012)",
      signal: (b) => { const c = closes(b), k = d(90); return c.map((x, i) => i >= k && x > c[i - k]); } },
    { id: "tsmom_vote", name: "Momentum-Abstimmung 30/90/180 Tage", source: "Zeitreihen-Momentum über mehrere Horizonte (Hurst, Ooi, Pedersen)",
      signal: (b) => { const c = closes(b); const h = [30, 90, 180].map(d); return c.map((x, i) => h.filter((k) => i >= k && x > c[i - k]).length >= 2); } },
    { id: "macd", name: "MACD über Signallinie (12/26/9 Tage)", source: "Gerald Appel, MACD",
      signal: (b) => { const c = closes(b), m1 = ema(c, d(12)), m2 = ema(c, d(26)); const m = c.map((_, i) => m1[i] - m2[i]); const sig = ema(m.map((v) => (Number.isFinite(v) ? v : 0)), d(9)); return m.map((v, i) => Number.isFinite(m2[i]) && gt(v, sig[i]) && gt(v, 0)); } },
    { id: "ema_20_50_trail", name: "EMA 20/50 mit Trailing-Stop", source: "Trendfolge mit Chandelier-Exit", trailAtr: 3,
      signal: (b) => { const c = closes(b), f = ema(c, d(20)), s = ema(c, d(50)); return c.map((_, i) => gt(f[i], s[i])); } },
  ];
}

export type PortCfg = { sizing: "equal" | "vol"; refVol: number; volDays: number; barsPerDay: number; capital: number };
export type PortTrade = { symbol: string; entryTs: number; exitTs: number; entryPx: number; exitPx: number; qty: number; netUsd: number; feesUsd: number; reason: string };
export type PortResult = {
  equity: { ts: number; e: number }[]; trades: PortTrade[]; feesUsd: number; exposure: number;
  open: Record<string, { qty: number; entryPx: number; entryTs: number }>;
  metrics: { total_pct: number; cagr_pct: number; vol_pct: number; sharpe: number; max_dd_pct: number; trades: number; win_pct: number; avg_trade_pct: number; exposure_pct: number; fees_pct_of_capital: number; last365_pct: number | null };
  years: Record<string, number>;
};

/** Common timestamps of all symbols, so every symbol has a bar at every step. */
export function align(data: Record<string, Bar[]>): { ts: number[]; bars: Record<string, Bar[]> } {
  const syms = Object.keys(data);
  const sets = syms.map((s) => new Set(data[s].map((x) => x.ts)));
  const ts = data[syms[0]].map((x) => x.ts).filter((t) => sets.every((st) => st.has(t)));
  const keep = new Set(ts);
  return { ts, bars: Object.fromEntries(syms.map((s) => [s, data[s].filter((x) => keep.has(x.ts))])) };
}

export function realizedVol(c: number[], i: number, n: number, barsPerYear: number): number {
  if (i < n + 1) return NaN;
  let s = 0, s2 = 0;
  for (let k = i - n + 1; k <= i; k++) { const r = Math.log(c[k] / c[k - 1]); s += r; s2 += r * r; }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m) * barsPerYear);
}

export function portfolio(data: Record<string, Bar[]>, rule: Rule | "hold", cfg: PortCfg, costs: (s: string) => Costs, fromTs = -Infinity): PortResult {
  const { ts, bars } = align(data);
  const syms = Object.keys(bars);
  const N = syms.length;
  const barsPerYear = 365 * cfg.barsPerDay;
  const sig: Record<string, boolean[]> = {}, atrs: Record<string, number[]> = {}, cl: Record<string, number[]> = {};
  for (const s of syms) {
    sig[s] = rule === "hold" ? bars[s].map(() => true) : rule.signal(bars[s]);
    atrs[s] = atr(bars[s], Math.max(2, Math.round(20 * cfg.barsPerDay)));
    cl[s] = bars[s].map((x) => x.c);
  }
  const trail = rule === "hold" ? undefined : rule.trailAtr;
  let cash = cfg.capital, fees = 0;
  const pos: Record<string, { qty: number; entryPx: number; entryTs: number; entryFee: number; hi: number } | null> = Object.fromEntries(syms.map((s) => [s, null]));
  const blocked: Record<string, boolean> = Object.fromEntries(syms.map((s) => [s, false])); // after a trailing stop: wait until the rule switches off
  const pending: Record<string, "buy" | "sell" | null> = Object.fromEntries(syms.map((s) => [s, null]));
  const pendingReason: Record<string, string> = {};
  const trades: PortTrade[] = [];
  const equity: { ts: number; e: number }[] = [];
  let investedSum = 0, steps = 0;
  const start = ts.findIndex((t) => t >= fromTs);
  if (start < 0) return { equity: [], trades: [], feesUsd: 0, exposure: 0, open: {}, metrics: { total_pct: 0, cagr_pct: 0, vol_pct: 0, sharpe: 0, max_dd_pct: 0, trades: 0, win_pct: 0, avg_trade_pct: 0, exposure_pct: 0, fees_pct_of_capital: 0, last365_pct: null }, years: {} };

  for (let i = start; i < ts.length; i++) {
    // 1. execute orders decided at the previous close, at this open
    const eqOpen = cash + syms.reduce((a, s) => a + (pos[s] ? pos[s]!.qty * bars[s][i].o : 0), 0);
    // sells first, so their cash is available for buys on the same bar
    const order = [...syms.filter((s) => pending[s] === "sell"), ...syms.filter((s) => pending[s] !== "sell")];
    for (const s of order) {
      const c = costs(s), half = (c.spreadBps / 2 + c.slipBps) / 1e4, fee = c.feeBps / 1e4, o = bars[s][i].o;
      if (pending[s] === "sell" && pos[s]) {
        const px = o * (1 - half), gross = pos[s]!.qty * px, f = gross * fee;
        cash += gross - f; fees += f;
        trades.push({ symbol: s, entryTs: pos[s]!.entryTs, exitTs: ts[i], entryPx: pos[s]!.entryPx, exitPx: px, qty: pos[s]!.qty, feesUsd: pos[s]!.entryFee + f, netUsd: gross - f - pos[s]!.qty * pos[s]!.entryPx - pos[s]!.entryFee, reason: pendingReason[s] || "signal" });
        pos[s] = null;
      } else if (pending[s] === "buy" && !pos[s]) {
        let w = 1 / N;
        if (cfg.sizing === "vol") {
          const v = realizedVol(cl[s], i - 1, Math.round(cfg.volDays * cfg.barsPerDay), barsPerYear);
          w = Number.isFinite(v) && v > 0 ? (1 / N) * Math.min(1, cfg.refVol / v) : 1 / N;
        }
        const px = o * (1 + half);
        const budget = Math.min(eqOpen * w, cash / (1 + fee));
        const qty = budget / px;
        if (qty > 0 && budget > 1) {
          const f = budget * fee;
          cash -= budget + f; fees += f;
          pos[s] = { qty, entryPx: px, entryTs: ts[i], entryFee: f, hi: bars[s][i].c };
        }
      }
      pending[s] = null;
    }
    // 2. mark to market at the close
    let invested = 0;
    for (const s of syms) if (pos[s]) invested += pos[s]!.qty * bars[s][i].c;
    const e = cash + invested;
    equity.push({ ts: ts[i], e });
    investedSum += e > 0 ? invested / e : 0; steps++;
    // 3. decide at the close (executed at the next open)
    if (i === ts.length - 1) break;
    for (const s of syms) {
      const want = sig[s][i];
      if (!want) blocked[s] = false;
      if (pos[s]) {
        pos[s]!.hi = Math.max(pos[s]!.hi, bars[s][i].c);
        const a = atrs[s][i];
        if (!want) { pending[s] = "sell"; pendingReason[s] = "signal"; }
        else if (trail && a > 0 && bars[s][i].c < pos[s]!.hi - trail * a) { pending[s] = "sell"; pendingReason[s] = "trailing_stop"; blocked[s] = true; }
      } else if (want && !blocked[s]) {
        pending[s] = "buy";
      }
    }
  }
  // metrics
  const e0 = cfg.capital, eN = equity.length ? equity[equity.length - 1].e : e0;
  const rets: number[] = [];
  for (let k = 1; k < equity.length; k++) rets.push(equity[k].e / equity[k - 1].e - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  let peak = e0, mdd = 0;
  for (const p of equity) { peak = Math.max(peak, p.e); mdd = Math.max(mdd, 1 - p.e / peak); }
  const yearsN = equity.length / barsPerYear;
  const years: Record<string, number> = {};
  let prevE = e0, prevY = equity.length ? new Date(equity[0].ts).getUTCFullYear() : 0;
  for (let k = 0; k < equity.length; k++) {
    const y = new Date(equity[k].ts).getUTCFullYear();
    if (y !== prevY) { years[prevY] = Math.round((equity[k - 1].e / prevE - 1) * 1000) / 10; prevE = equity[k - 1].e; prevY = y; }
  }
  if (equity.length) years[prevY] = Math.round((eN / prevE - 1) * 1000) / 10;
  const cut = equity.length ? equity[equity.length - 1].ts - 365 * 86400_000 : 0;
  const k365 = equity.findIndex((p) => p.ts >= cut);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const wins = trades.filter((t) => t.netUsd > 0).length;
  return {
    equity, trades, feesUsd: fees, exposure: investedSum / Math.max(1, steps),
    open: Object.fromEntries(syms.filter((s) => pos[s]).map((s) => [s, { qty: pos[s]!.qty, entryPx: pos[s]!.entryPx, entryTs: pos[s]!.entryTs }])),
    metrics: {
      total_pct: r1((eN / e0 - 1) * 100),
      cagr_pct: r1(yearsN > 0 && eN > 0 ? (Math.pow(eN / e0, 1 / yearsN) - 1) * 100 : 0),
      vol_pct: r1(sd * Math.sqrt(barsPerYear) * 100),
      sharpe: sd > 0 ? Math.round((mean / sd) * Math.sqrt(barsPerYear) * 100) / 100 : 0,
      max_dd_pct: r1(mdd * 100),
      trades: trades.length,
      win_pct: r1(trades.length ? (wins / trades.length) * 100 : 0),
      avg_trade_pct: r1(trades.length ? (trades.reduce((a, t) => a + t.netUsd / (t.qty * t.entryPx), 0) / trades.length) * 100 : 0),
      exposure_pct: r1((investedSum / Math.max(1, steps)) * 100),
      fees_pct_of_capital: r1((fees / e0) * 100),
      last365_pct: k365 > 0 ? r1((eN / equity[k365 - 1].e - 1) * 100) : null,
    },
    years,
  };
}
