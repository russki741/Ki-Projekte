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
