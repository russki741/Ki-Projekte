// Pure decision logic of the trend engine (no I/O). Mirrors step 3 of portfolio() in lab.ts exactly, so the live agents
// trade the same way as the rulebook simulation: decide at the close of the last CLOSED bar, act right after it.
import { type Bar, atr, realizedVol, type Rule, rulebook } from "./lab.ts";

export type TrendCfg = { rule: string; tf: number; sizing: "equal" | "vol"; ref_vol: number; vol_days: number; scale: number };

export function ruleOf(id: string, tf: number): Rule | null {
  return rulebook(1440 / tf).find((r) => r.id === id) ?? null;
}

export type Decision = {
  barTs: number; // open time of the last closed bar
  close: number;
  want: boolean;
  atr: number;
  vol: number;
  hi: number | null; // highest close since entry (only with a position)
  trailLevel: number | null; // close below this level -> trailing stop (only for rules with a trailing stop)
  action: "buy" | "sell" | "hold" | "none";
  reason: "signal" | "trailing_stop" | null;
  blocked: boolean; // new blocked state for this symbol
};

/**
 * bars: closed bars, ascending. pos.entryBarTs: open time of the bar in which the position was opened.
 * blocked: true after a trailing stop until the rule switches off once.
 */
export function decide(bars: Bar[], rule: Rule, cfg: TrendCfg, pos: { entryBarTs: number } | null, blocked: boolean): Decision {
  const barsPerDay = 1440 / cfg.tf;
  const n = bars.length;
  const i = n - 1;
  const want = rule.signal(bars)[i] === true;
  const a = atr(bars, Math.max(2, Math.round(20 * barsPerDay)))[i];
  const vol = realizedVol(bars.map((x) => x.c), i, Math.round(cfg.vol_days * barsPerDay), 365 * barsPerDay);
  let blk = want ? blocked : false;
  const base = { barTs: bars[i].ts, close: bars[i].c, want, atr: a, vol, hi: null as number | null, trailLevel: null as number | null };
  if (pos) {
    let hi = -Infinity;
    for (const b of bars) if (b.ts >= pos.entryBarTs) hi = Math.max(hi, b.c);
    const trail = rule.trailAtr && a > 0 ? hi - rule.trailAtr * a : null;
    if (!want) return { ...base, hi, trailLevel: trail, action: "sell", reason: "signal", blocked: blk };
    if (trail !== null && bars[i].c < trail) return { ...base, hi, trailLevel: trail, action: "sell", reason: "trailing_stop", blocked: true };
    return { ...base, hi, trailLevel: trail, action: "hold", reason: null, blocked: blk };
  }
  if (want && !blk) return { ...base, action: "buy", reason: null, blocked: blk };
  return { ...base, action: "none", reason: null, blocked: blk };
}

/** Share of equity for a new position: 1/N, scaled down by volatility (like the simulation) and by the agent's exposure scale. */
export function weightOf(cfg: TrendCfg, nSymbols: number, vol: number): number {
  let w = 1 / nSymbols;
  if (cfg.sizing === "vol") w *= Number.isFinite(vol) && vol > 0 ? Math.min(1, cfg.ref_vol / vol) : 1;
  return w * cfg.scale;
}

/**
 * Order size in USD for a new position. Small accounts: when the weighted size is below the exchange minimum (minOrder),
 * the order is raised to minOrder, but never above the full 1/N share of the equity. Otherwise the buy is too small to place.
 */
export function orderUsd(equity: number, weight: number, nSymbols: number, minOrder: number): { usd: number; raised: boolean } {
  const want = equity * weight;
  if (minOrder > 0 && want < minOrder && minOrder <= equity / Math.max(1, nSymbols)) return { usd: minOrder, raised: true };
  return { usd: want, raised: false };
}

/** Official USD/RUB rate from the XML of the Bank of Russia (cbr.ru/scripts/XML_daily.asp): rubles per 1 USD, or null. */
export function parseCbrUsd(xml: string): { rate: number; date: string } | null {
  const date = /<ValCurs[^>]*Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  const m = /<Valute[^>]*>(?:(?!<\/Valute>)[\s\S])*?<CharCode>USD<\/CharCode>((?:(?!<\/Valute>)[\s\S])*?)<\/Valute>/.exec(xml);
  if (!date || !m) return null;
  const nominal = Number((/<Nominal>([^<]+)<\/Nominal>/.exec(m[0])?.[1] ?? "1").replace(",", "."));
  const value = Number((/<Value>([^<]+)<\/Value>/.exec(m[0])?.[1] ?? "").replace(",", "."));
  const rate = value / nominal;
  if (!(rate > 1 && rate < 1000)) return null;
  return { rate, date: `${date[3]}-${date[2]}-${date[1]}` };
}

// ---------- calendar of scheduled high-impact events (protection layer: only blocks NEW entries) ----------

/** US non-farm payrolls: first Friday of the month at 12:30 UTC (13:30 in winter; the block window covers both). Jan 1 and Jul 3/4 shift a week. */
export function nfp(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month, 1));
  let day = 1 + ((5 - d.getUTCDay() + 7) % 7);
  if ((month === 0 && day <= 2) || (month === 6 && (day === 3 || day === 4))) day += 7;
  return Date.UTC(year, month, day, 12, 30);
}

/** True when a high-impact event lies within [now - 2 h, now + 20 h]. */
export function eventBlock(nowMs: number, events: number[]): boolean {
  return events.some((t) => t >= nowMs - 2 * 3600_000 && t <= nowMs + 20 * 3600_000);
}
