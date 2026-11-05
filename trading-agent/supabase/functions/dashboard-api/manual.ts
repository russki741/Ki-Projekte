// Own trades of the user ("Selbst handeln"): pure rules, no I/O. SIMULATION ONLY: paper positions with live prices and real costs.
// Same execution and accounting as the trend engine (trend-tick/engine.ts); a test checks that both give the same numbers.

export type Cls = "crypto" | "forex";
export type Side = "long" | "short";
export type Market = { symbol: string; name: string; cls: Cls; canShort: boolean; spreadBps: number };
export type Quote = { bid: number; ask: number; mid: number; at: number; fresh: boolean };

/** Markets the user can trade. Crypto: Bybit spot, buy only. Currencies: assumed broker spread, both directions, no leverage. */
export const MARKETS: Market[] = [
  { symbol: "BTCUSDT", name: "Bitcoin", cls: "crypto", canShort: false, spreadBps: 0 },
  { symbol: "ETHUSDT", name: "Ethereum", cls: "crypto", canShort: false, spreadBps: 0 },
  { symbol: "SOLUSDT", name: "Solana", cls: "crypto", canShort: false, spreadBps: 0 },
  { symbol: "XAUTUSDT", name: "Gold (Token XAUT)", cls: "crypto", canShort: false, spreadBps: 0 },
  { symbol: "EURUSD=X", name: "EUR/USD", cls: "forex", canShort: true, spreadBps: 2 },
  { symbol: "GBPUSD=X", name: "GBP/USD", cls: "forex", canShort: true, spreadBps: 2.5 },
  { symbol: "USDJPY=X", name: "USD/JPY", cls: "forex", canShort: true, spreadBps: 2 },
];
export const marketOf = (symbol: unknown): Market | null => MARKETS.find((m) => m.symbol === symbol) ?? null;

/** Fee and slippage per side: crypto like the Bybit spot taker (0.1 %), currencies without commission (cost is the spread). */
export const COSTS: Record<Cls, { feeBps: number; slipBps: number }> = { crypto: { feeBps: 10, slipBps: 2 }, forex: { feeBps: 0, slipBps: 1 } };
/** Smallest trade in USD: Bybit takes spot orders from 5 USDT (6 leaves room for a falling price); currencies 1 USD. */
export const MIN_USD: Record<Cls, number> = { crypto: 6, forex: 1 };
/** A currency price older than this means the market is closed (weekend: Friday 22:00 to Sunday 22:00 UTC). */
export const FX_FRESH_MS = 20 * 60_000;

/** Bid/ask: measured on the exchange (crypto) or around the mid price with the assumed spread (currencies). */
export function quoteFrom(m: Market, mid: number, at: number, nowMs: number, bid?: number, ask?: number): Quote {
  if (m.cls === "crypto" && bid && ask) return { bid, ask, mid: (bid + ask) / 2, at, fresh: true };
  return { bid: mid * (1 - m.spreadBps / 2e4), ask: mid * (1 + m.spreadBps / 2e4), mid, at, fresh: nowMs - at <= FX_FRESH_MS };
}
export function entryPx(side: Side, q: { bid: number; ask: number }, slipBps: number): number {
  return side === "long" ? q.ask * (1 + slipBps / 1e4) : q.bid * (1 - slipBps / 1e4);
}
export function exitPx(side: Side, q: { bid: number; ask: number }, slipBps: number): number {
  return side === "long" ? q.bid * (1 - slipBps / 1e4) : q.ask * (1 + slipBps / 1e4);
}
/** Costs of buying and selling again at an unchanged price, in percent of the amount (spread + 2 x slippage + 2 x fee). */
export function roundTripPct(m: Market, q: { bid: number; ask: number }): number {
  const c = COSTS[m.cls];
  const e = entryPx("long", q, c.slipBps), x = exitPx("long", q, c.slipBps);
  return (1 - (x * (1 - c.feeBps / 1e4)) / (e * (1 + c.feeBps / 1e4))) * 100;
}

export type Plan = { ok: true; fill: number; qty: number; notional: number; fee: number; usd: number } | { ok: false, error: string };

/**
 * A new own position. amountRub: what the user wants to put in, converted with the ruble rate shown in the app.
 * The fee is paid on top, so "everything" is reduced until amount + fee fit into the free cash.
 */
export function plan(m: Market, side: Side, amountRub: number, usdrub: number, q: Quote, cashUsd: number, killSwitch: boolean, marketOn: boolean): Plan {
  if (killSwitch) return { ok: false, error: "Der Kill-Switch ist an: keine neuen Trades." };
  if (!marketOn) return { ok: false, error: m.cls === "crypto" ? "Krypto ist in den Einstellungen ausgeschaltet." : "Währungen sind in den Einstellungen ausgeschaltet." };
  if (side === "short" && !m.canShort) return { ok: false, error: "Krypto kann hier nur gekauft werden (Spot, kein Leerverkauf)." };
  if (!(Number.isFinite(amountRub) && amountRub > 0)) return { ok: false, error: "Betrag fehlt." };
  if (!(usdrub > 0)) return { ok: false, error: "Kein Rubelkurs vorhanden." };
  if (!q.fresh) return { ok: false, error: "Der Markt ist gerade geschlossen (Wochenende oder Feiertag). Kein aktueller Kurs." };
  const c = COSTS[m.cls];
  let usd = amountRub / usdrub;
  if (usd > cashUsd * 1.0001) return { ok: false, error: `Nur ${Math.floor(cashUsd * usdrub)} ₽ frei.` };
  usd = Math.min(usd, cashUsd / (1 + c.feeBps / 1e4));
  if (usd < MIN_USD[m.cls] * 0.999) return { ok: false, error: `Mindestens ${Math.ceil(MIN_USD[m.cls] * 1.01 * usdrub)} ₽ (${MIN_USD[m.cls]} USD).` };
  const fill = entryPx(side, q, c.slipBps);
  const qty = Math.floor((usd / fill) * 1e8) / 1e8;
  const notional = qty * fill, fee = (notional * c.feeBps) / 1e4;
  if (!(qty > 0) || notional + fee > cashUsd + 1e-9) return { ok: false, error: "Nicht genug freies Kapital." };
  return { ok: true, fill, qty, notional, fee, usd };
}

/** Closing an own position at the live price: same accounting as the agents. */
export function settleClose(m: Market, side: Side, qty: number, entry: number, entryNotional: number, entryFee: number, q: Quote) {
  const c = COSTS[m.cls];
  const px = exitPx(side, q, c.slipBps);
  const fee = (px * qty * c.feeBps) / 1e4;
  const gross = (px - entry) * qty * (side === "long" ? 1 : -1);
  return { px, fee, gross, net: gross - entryFee - fee, cashBack: entryNotional + gross - fee };
}

/** Yahoo chart (interval=1h): latest price, its time and the hourly closes (for the small chart in the app). */
export function parseYahooChart(body: any): { price: number; at: number; closes: number[] } | null {
  const r = body?.chart?.result?.[0];
  if (!r) return null;
  const closes = ((r.indicators?.quote?.[0]?.close ?? []) as unknown[]).filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
  const price = Number(r.meta?.regularMarketPrice), at = Number(r.meta?.regularMarketTime) * 1000;
  if (!(price > 0) || !Number.isFinite(at)) return null;
  return { price, at, closes };
}

// ---------- candles for the live chart in the app (public market data) ----------

export type Bar = [number, number, number, number, number, number]; // [open time ms, open, high, low, close, volume]
/**
 * Chart time frames. Crypto: Bybit spot klines (the WebSocket stream uses the same interval names).
 * Currencies: Yahoo chart API, fetched by time window; 4 h is built from 1 h bars (Yahoo has no 4 h interval).
 */
export const TF: Record<string, { ms: number; bybit: string; yahoo: string; lookbackMs: number; agg: number }> = {
  "1": { ms: 60_000, bybit: "1", yahoo: "1m", lookbackMs: 2 * 86_400_000, agg: 1 },
  "5": { ms: 300_000, bybit: "5", yahoo: "5m", lookbackMs: 6 * 86_400_000, agg: 1 },
  "15": { ms: 900_000, bybit: "15", yahoo: "15m", lookbackMs: 12 * 86_400_000, agg: 1 },
  "60": { ms: 3_600_000, bybit: "60", yahoo: "60m", lookbackMs: 45 * 86_400_000, agg: 1 },
  "240": { ms: 14_400_000, bybit: "240", yahoo: "60m", lookbackMs: 170 * 86_400_000, agg: 4 },
  "D": { ms: 86_400_000, bybit: "D", yahoo: "1d", lookbackMs: 730 * 86_400_000, agg: 1 },
};
/** Decimals for the price axis: currency pairs like brokers show them (JPY 3, others 5), crypto by price size. */
export function precisionOf(m: Market, price: number): number {
  if (m.cls === "forex") return price >= 20 ? 3 : 5;
  return price >= 100 ? 2 : price >= 1 ? 4 : 6;
}
/** Bybit kline list (newest first, strings) -> bars ascending. The newest bar is the running one. */
export function parseBybitKlines(list: unknown): Bar[] {
  if (!Array.isArray(list)) return [];
  const out: Bar[] = [];
  for (const x of list) {
    if (!Array.isArray(x)) continue;
    const b = [0, 1, 2, 3, 4, 5].map((i) => Number(x[i])) as Bar;
    if (b.every(Number.isFinite) && b[1] > 0 && b[2] > 0 && b[3] > 0 && b[4] > 0) out.push(b);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
/**
 * Yahoo chart (any interval) -> bars ascending on the grid of the time frame. Bars of the same slot are merged
 * (first open, highest high, lowest low, last close, summed volume): this builds 4 h bars from 1 h bars and also folds
 * Yahoo's extra "live" row into the running bar. Daily bars are keyed by their UTC day (summer days start 23:00 UTC).
 */
export function parseYahooBars(body: any, slotMs: number): Bar[] {
  const r = body?.chart?.result?.[0];
  if (!r) return [];
  const t: number[] = r.timestamp ?? [], q = r.indicators?.quote?.[0] ?? {};
  const by = new Map<number, Bar>();
  for (let i = 0; i < t.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every((x) => typeof x === "number" && Number.isFinite(x) && x > 0)) continue;
    const v = Number(q.volume?.[i] ?? 0) || 0;
    // daily currency bars start at London midnight, 23:00 UTC in summer: they belong to the next UTC day
    const ms = t[i] * 1000 + (slotMs === 86_400_000 && new Date(t[i] * 1000).getUTCHours() === 23 ? 3_600_000 : 0);
    const slot = Math.floor(ms / slotMs) * slotMs;
    const b = by.get(slot);
    if (!b) by.set(slot, [slot, o, h, l, c, v]);
    else { b[2] = Math.max(b[2], h); b[3] = Math.min(b[3], l); b[4] = c; b[5] += v; }
  }
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}
