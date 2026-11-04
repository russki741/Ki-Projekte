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

/** Inverse price series (e.g. USD/EUR from EUR/USD). The short side of a currency pair is the rule applied to this series. */
export function inverseBars(b: Bar[]): Bar[] {
  return b.map((x) => ({ ts: x.ts, o: 1 / x.o, h: 1 / x.l, l: 1 / x.h, c: 1 / x.c, v: x.v }));
}

export type Side = "long" | "short";
export type TwoWay = {
  long: Decision; // the rule on the price itself
  short: Decision; // the rule on 1/price
  close: boolean; // close the open position
  open: Side | null; // open a position in this direction (also right after a close: a flip at the same moment, as in the lab study)
  reason: "signal" | "trailing_stop" | null;
  blocked: { long: boolean; short: boolean };
};

/**
 * Both directions for markets that can be sold short (currencies, no leverage). Mirrors the lab study, where a pair and its
 * inverse are two separate markets: long = rule on the price, short = rule on 1/price. Never both at once.
 */
export function decideTwoWay(bars: Bar[], rule: Rule, cfg: TrendCfg, pos: { side: Side; entryBarTs: number } | null, blocked: { long: boolean; short: boolean }): TwoWay {
  const L = decide(bars, rule, cfg, pos?.side === "long" ? pos : null, blocked.long);
  const S = decide(inverseBars(bars), rule, cfg, pos?.side === "short" ? pos : null, blocked.short);
  let close = false, open: Side | null = null, reason: TwoWay["reason"] = null;
  if (pos) {
    const own = pos.side === "long" ? L : S, other = pos.side === "long" ? S : L;
    if (own.action === "sell") {
      close = true; reason = own.reason;
      if (other.action === "buy") open = pos.side === "long" ? "short" : "long";
    }
  } else if (L.action === "buy" && S.action !== "buy") open = "long";
  else if (S.action === "buy" && L.action !== "buy") open = "short";
  return { long: L, short: S, close, open, reason, blocked: { long: L.blocked, short: S.blocked } };
}

// ---------- execution and accounting (pure, shared with the tests) ----------

export type Px = { bid: number; ask: number };

/** Execution price with slippage: a long buys at the ask, a short sells at the bid. */
export function entryPx(side: Side, q: Px, slipBps: number): number {
  return side === "long" ? q.ask * (1 + slipBps / 1e4) : q.bid * (1 - slipBps / 1e4);
}
/** Closing price with slippage: a long sells at the bid, a short buys back at the ask. */
export function exitPx(side: Side, q: Px, slipBps: number): number {
  return side === "long" ? q.bid * (1 - slipBps / 1e4) : q.ask * (1 + slipBps / 1e4);
}
/** Quote from a mid price (Yahoo has no bid/ask): half of the assumed spread on each side. */
export function fromMid(mid: number, spreadBps: number): Px {
  return { bid: mid * (1 - spreadBps / 2e4), ask: mid * (1 + spreadBps / 2e4) };
}
/**
 * Paper accounting of a closed position (same as agent-tick): on entry cash -= notional + fee (also for a short: the
 * notional is reserved as margin, no leverage); on exit cash += notional + price move - exit fee.
 * Currency pairs are booked as price change x amount in USD, like the lab study; for pairs quoted in JPY, CHF or CAD the
 * exact USD result differs only in the second order (0.04 % of the amount at a 2 % move).
 */
export function settle(side: Side, qty: number, entry: number, entryNotional: number, entryFee: number, exit: number, feeBps: number) {
  const dir = side === "long" ? 1 : -1;
  const fee = (exit * qty * feeBps) / 1e4;
  const gross = (exit - entry) * qty * dir;
  return { fee, gross, net: gross - entryFee - fee, cashBack: entryNotional + gross - fee };
}
/** Current value of an open position (reserved notional plus price move in its direction). */
export function valueOf(side: string, qty: number, entry: number, entryNotional: number, mark: number): number {
  return entryNotional + (mark - entry) * qty * (side === "short" ? -1 : 1);
}

const DAY_MS = 86_400_000;
/**
 * Yahoo chart API (interval=1d) -> closed daily bars plus the latest price and its time. Bars are keyed by their UTC day as
 * in the lab study; a bar counts as closed 24 h after its RAW start (Yahoo starts currency days at London midnight, which is
 * 23:00 UTC in summer), so the running day is never used. The last bar of a day wins.
 */
export function parseYahooDaily(body: any, nowMs: number): { bars: Bar[]; price: number; at: number } | null {
  const r = body?.chart?.result?.[0];
  if (!r) return null;
  const t: number[] = r.timestamp ?? [], q = r.indicators?.quote?.[0] ?? {};
  const out = new Map<number, Bar>();
  for (let i = 0; i < t.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) continue;
    const raw = t[i] * 1000;
    if (raw + DAY_MS > nowMs) continue;
    const ts = Math.floor(raw / DAY_MS) * DAY_MS;
    out.set(ts, { ts, o, h, l, c, v: Number(q.volume?.[i] ?? 0) || 0 });
  }
  const price = Number(r.meta?.regularMarketPrice), at = Number(r.meta?.regularMarketTime) * 1000;
  return { bars: [...out.values()].sort((a, b) => a.ts - b.ts), price, at };
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
