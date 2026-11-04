// trend-tick: slow, rule-based agents (agents.config.engine = "trend"), e.g. "Momentum-Abstimmung" or "Turtle 55/20" on daily bars.
// SIMULATION ONLY: paper positions in agent_core.positions (same accounting as agent-tick); the bybit-demo function mirrors crypto
// longs on the Bybit DEMO account. Runs every 5 minutes; a trading decision is made once per symbol after a new bar has CLOSED.
// Markets: crypto (Bybit spot, long only) and currency pairs (Yahoo daily bars, long AND short when config.allow_short.forex,
// no leverage). A currency trade needs a live quote: while the market is closed (weekend) decisions wait and are acted on when
// it opens again; exits wait as long as needed, entries at most 72 h.
// Protection layer (can only delay or shrink entries, never add risk): kill switch, agent status, market switch, max drawdown,
// fresh high-impact news for that market class (no new entry for 30 min), calendar events (FOMC, US payrolls: no new entry from
// 20 h before to 2 h after), many high-impact headlines of that class in 24 h (half size). Small crypto accounts: a buy below
// risk.min_order_usd is raised to that minimum (exchange minimum order), but never above the full 1/N share.
// Also: stores the USD/RUB rate (Bank of Russia, hourly) for showing results in rubles, keeps agent_core.quotes fresh for open
// positions of trend and manual agents (prices for the app), and writes an hourly equity snapshot of the manual account
// (config.engine = "manual"; it never trades here).
// Auth: header x-agent-secret (Vault agent_cron_secret); verify_jwt is off. Body: {} or { "dry_run": true } (everything is rolled back).
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { type Bar } from "./lab.ts";
import {
  decide, decideTwoWay, entryPx, eventBlock, exitPx, fromMid, nfp, orderUsd, parseCbrUsd, parseYahooDaily, type Px, ruleOf, settle, type Side,
  type TrendCfg, type TwoWay, valueOf, weightOf,
} from "./engine.ts";

const BYBIT = "https://api.bybit.com"; // public market data only, no key
const YAHOO = "https://query1.finance.yahoo.com";
const UA = { "user-agent": "trading-sim-agent/0.1 (paper-trading research)" };
const LOCK_KEY = 738202;
// A deferred entry is retried every 5 minutes and dropped 22 h after the bar closed (the rule is asked again at the next bar).
// 22 h covers the longest block on a daily bar: FOMC at 19:00 UTC plus 2 h.
const DEFER_MAX_MS = 22 * 3600_000;
// Currencies: a quote older than 20 minutes means the market is closed. Friday's decision waits over the weekend.
const FX_FRESH_MS = 20 * 60_000;
const FX_DEFER_MAX_MS = 72 * 3600_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();
class Rollback extends Error { constructor(public result: unknown) { super("rollback"); } }

type Cls = "crypto" | "forex";
type Quote = { bid: number | null; ask: number | null; last: number; at: number; fresh: boolean; source: string };
type Costs = { fee_bps: number; slip_bps: number; spread_bps: number };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.retCode !== 0) throw new Error(`bybit HTTP ${res.status} retCode=${body?.retCode} ${body?.retMsg ?? ""}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}
/** Closed bars, ascending, at least `need` of them when the exchange has that much history. */
async function klines(symbol: string, tf: number, need: number, nowMs: number): Promise<Bar[]> {
  const step = tf * 60000;
  const interval = tf === 1440 ? "D" : String(tf);
  const out = new Map<number, Bar>();
  let end = nowMs;
  for (let page = 0; page < 4 && out.size < need; page++) {
    const res = await getJson(`${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&end=${end}&limit=1000`);
    const list: string[][] = res?.list ?? [];
    if (!list.length) break;
    for (const x of list) {
      const b = { ts: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) };
      if ([b.ts, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.ts + step <= nowMs) out.set(b.ts, b);
    }
    end = Number(list[list.length - 1][0]) - 1;
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}
async function ticker(symbol: string): Promise<Quote> {
  const res = await getJson(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`);
  const t = res?.list?.[0];
  const bid = Number(t?.bid1Price), ask = Number(t?.ask1Price), last = Number(t?.lastPrice);
  if (!(bid > 0 && ask >= bid && last > 0)) throw new Error(`no usable quote for ${symbol}`);
  return { bid, ask, last, at: Date.now(), fresh: true, source: "bybit" };
}
/** Daily bars and the latest price of a Yahoo market (currency pairs). One request gives both. */
async function yahooDaily(symbol: string, nowMs: number): Promise<{ bars: Bar[]; quote: Quote }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let body: any;
  try {
    const res = await fetch(`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y`, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const r = parseYahooDaily(body, nowMs);
  if (!r) throw new Error(`yahoo: ${body?.chart?.error?.description ?? "no result"}`);
  if (!(r.price > 0) || !Number.isFinite(r.at)) throw new Error(`yahoo: no price for ${symbol}`);
  return { bars: r.bars, quote: { bid: null, ask: null, last: r.price, at: r.at, fresh: nowMs - r.at <= FX_FRESH_MS, source: "yahoo" } };
}

/** USD/RUB for showing results in rubles: official Bank of Russia rate, Yahoo RUB=X as fallback. Never used for trading decisions. */
async function usdRub(): Promise<{ rate: number; source: string } | null> {
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const xml = await get("https://www.cbr.ru/scripts/XML_daily.asp");
  const cbr = xml ? parseCbrUsd(xml) : null;
  if (cbr) return { rate: cbr.rate, source: `cbr ${cbr.date}` };
  const y = await get(`${YAHOO}/v8/finance/chart/RUB=X?interval=1d&range=5d`, UA);
  try {
    const px = Number(JSON.parse(y ?? "null")?.chart?.result?.[0]?.meta?.regularMarketPrice);
    if (px > 1 && px < 1000) return { rate: px, source: "yahoo RUB=X" };
  } catch { /* not JSON */ }
  return null;
}

/** Costs of one market for an agent: crypto from the exchange (fee + slippage), currencies with an assumed broker spread. */
function costsOf(conf: any, cls: Cls, symbol: string): Costs {
  const c = conf?.costs?.[cls] ?? {};
  if (cls === "crypto") return { fee_bps: Number(c.fee_bps ?? 10), slip_bps: Number(c.slip_bps ?? 2), spread_bps: 0 };
  return { fee_bps: Number(c.fee_bps ?? 0), slip_bps: Number(c.slip_bps ?? 1), spread_bps: Number(c.spread_bps_by_symbol?.[symbol] ?? c.fallback_spread_bps ?? 2) };
}
/** Bid/ask for execution: measured on the exchange, or around the mid price with the assumed spread. */
const pxOf = (q: Quote, cc: Costs): Px => (q.bid && q.ask ? { bid: q.bid, ask: q.ask } : fromMid(q.last, cc.spread_bps));

async function tick(sql: any, dry: boolean) {
  const now = Date.now();
  // ruble rate at most once per hour (display only)
  const [fx] = await sql`select usdrub_rate_at from agent_core.settings where id`;
  const rub = !fx?.usdrub_rate_at || now - new Date(fx.usdrub_rate_at).getTime() > 3600_000 ? await usdRub() : null;
  const barsCache = new Map<string, Promise<Bar[]>>();
  const yahooCache = new Map<string, Promise<{ bars: Bar[]; quote: Quote }>>();
  const quoteCache = new Map<string, Promise<Quote>>();
  const seen = new Map<string, { market: Cls; q: Quote }>(); // quotes fetched in this run, stored in agent_core.quotes
  const yahooOf = (s: string) => {
    if (!yahooCache.has(s)) yahooCache.set(s, yahooDaily(s, now));
    return yahooCache.get(s)!;
  };
  const barsOf = (s: string, cls: Cls, tf: number) => {
    if (cls === "forex") return yahooOf(s).then((r) => r.bars);
    const k = `${s}:${tf}`;
    if (!barsCache.has(k)) barsCache.set(k, klines(s, tf, Math.round(260 * (1440 / tf)), now));
    return barsCache.get(k)!;
  };
  const quoteOf = (s: string, cls: Cls) => {
    if (!quoteCache.has(s)) {
      quoteCache.set(s, (cls === "forex" ? yahooOf(s).then((r) => r.quote) : ticker(s)).then((q) => {
        seen.set(s, { market: cls, q });
        return q;
      }));
    }
    return quoteCache.get(s)!;
  };

  return await sql.begin(async (tx: any) => {
    const [lk] = await tx`select pg_try_advisory_xact_lock(${LOCK_KEY}) as got`;
    if (!lk.got) return { status: "skipped_locked" };
    const [st] = await tx`select kill_switch, paper_only, markets_enabled from agent_core.settings where id`;
    if (!st || st.paper_only !== true) return { status: "refused_not_paper_only" };
    if (rub) await tx`update agent_core.settings set usdrub_rate = ${rub.rate}, usdrub_rate_at = now(), usdrub_source = ${rub.source} where id`;
    const agents = await tx`
      select id, name, status, config, state, capital_start::float8 as capital_start, cash::float8 as cash
      from agent_core.agents where mode = 'paper' and config->>'engine' = 'trend' order by created_at`;

    const trendIds = new Set<string>(agents.map((a: any) => a.id));
    const openAll = (await tx`
      select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_fee::float8 as entry_fee,
             entry_notional::float8 as entry_notional, risk_usd::float8 as risk_usd, sl_price::float8 as sl, (extract(epoch from entry_time) * 1000)::float8 as entry_ms
      from agent_core.positions where status = 'open' order by id`).filter((p: any) => trendIds.has(p.agent_id));
    const marks = new Map<string, number>((await tx`select distinct on (symbol) symbol, c::float8 as c from agent_core.candles where open_time > now() - interval '10 minutes' order by symbol, open_time desc`).map((r: any) => [r.symbol, r.c]));
    const newsRows = await tx`
      select m, (count(*) filter (where fetched_at > now() - interval '30 minutes'))::int as n30, count(*)::int as n24
      from agent_core.news_items, unnest(markets) m where impact = 'high' and fetched_at > now() - interval '24 hours' group by m`;
    const newsOf = (cls: Cls) => {
      const r = newsRows.find((x: any) => x.m === cls);
      return { hold: (r?.n30 ?? 0) > 0, factor: (r?.n24 ?? 0) >= 3 ? 0.5 : 1, n24: r?.n24 ?? 0 };
    };
    const cal = (await tx`select (extract(epoch from starts_at) * 1000)::float8 as ms from agent_core.event_calendar where impact = 'high' and starts_at between now() - interval '3 hours' and now() + interval '21 hours'`).map((r: any) => r.ms as number);
    const y = new Date(now).getUTCFullYear(), m = new Date(now).getUTCMonth();
    const events = [...cal, nfp(y, m), m === 11 ? nfp(y + 1, 0) : nfp(y, m + 1)];
    const calendarHold = eventBlock(now, events);
    const markOf = async (symbol: string, cls: Cls, fallback: number) =>
      marks.get(symbol) ?? (await quoteOf(symbol, cls).then((q) => q.last).catch(() => fallback));
    const out: any[] = [];

    for (const a of agents) {
      if (a.status === "pending_approval") continue;
      const conf = a.config ?? {};
      const cfg: TrendCfg = { rule: conf.strategy?.rule, tf: Number(conf.strategy?.tf ?? 1440), sizing: conf.strategy?.sizing === "equal" ? "equal" : "vol",
        ref_vol: Number(conf.strategy?.ref_vol ?? 0.6), vol_days: Number(conf.strategy?.vol_days ?? 30), scale: Math.min(1, Math.max(0, Number(conf.strategy?.scale ?? 0.25))) };
      const rule = ruleOf(cfg.rule, cfg.tf);
      const risk = conf.risk ?? {};
      // currencies only on daily bars (the Yahoo source delivers daily bars here)
      const syms: { s: string; cls: Cls }[] = [
        ...((conf.markets?.crypto ?? []) as string[]).map((s) => ({ s, cls: "crypto" as Cls })),
        ...(cfg.tf === 1440 ? ((conf.markets?.forex ?? []) as string[]) : []).map((s) => ({ s, cls: "forex" as Cls })),
      ];
      const twoWay = (cls: Cls) => cls === "forex" && conf.allow_short?.forex === true; // spot crypto: long only
      const state = a.state ?? {};
      const decided: Record<string, number> = { ...(state.decided ?? {}) };
      const blocked: Record<string, boolean> = { ...(state.blocked ?? {}) };
      const blockedShort: Record<string, boolean> = { ...(state.blocked_short ?? {}) };
      const mine = openAll.filter((p: any) => p.agent_id === a.id);
      let cash: number = a.cash;
      const log: any[] = [];
      let traded = false, profitClose = false;
      const notify = (kind: string, title: string, text: string, payload: unknown) =>
        tx`insert into agent_core.notifications (kind, agent_id, title, body, payload) values (${kind}, ${a.id}, ${title}, ${text}, ${tx.json(payload as any)})`;
      const signal = (cls: Cls, symbol: string, barTs: number, side: Side, decision: string, reason: string | null, features: unknown) =>
        tx`insert into agent_core.signals (agent_id, market, symbol, candle_time, side, quality, decision, reason, features)
           values (${a.id}, ${cls}, ${symbol}, ${iso(barTs)}, ${side}, null, ${decision}, ${reason}, ${tx.json(features as any)})`;
      const sideTxt = (s: Side) => (s === "long" ? "long" : "short");

      /** Closes at the live quote. Throws when there is no live quote (currency market closed): the position stays open and is retried. */
      const closePos = async (p: any, reason: string) => {
        const cls = p.market as Cls;
        const cc = costsOf(conf, cls, p.symbol);
        const q = await quoteOf(p.symbol, cls);
        if (!q.fresh) throw new Error("market closed (no live quote)");
        const px = exitPx(p.side, pxOf(q, cc), cc.slip_bps);
        const s = settle(p.side, p.qty, p.entry_price, p.entry_notional, p.entry_fee, px, cc.fee_bps);
        const rMult = p.risk_usd > 0 ? s.net / p.risk_usd : null;
        cash += s.cashBack;
        await tx`update agent_core.positions set status = 'closed', exit_price = ${px}, exit_time = now(), exit_fee = ${s.fee},
                 close_reason = ${reason}, pnl_usd = ${s.net}, r_multiple = ${rMult} where id = ${p.id}`;
        await tx`select agent_core.fn_after_close(${p.id}::bigint)`;
        await notify("trade_closed", `${p.symbol} ${sideTxt(p.side)} geschlossen (${reason})`, `PnL ${s.net >= 0 ? "+" : ""}${r2(s.net)} USD`, { symbol: p.symbol, side: p.side, reason, exit_price: px, pnl_usd: s.net });
        traded = true; if (s.net > 0) profitClose = true;
        log.push({ symbol: p.symbol, side: p.side, action: "closed", reason, pnl_usd: r2(s.net) });
      };

      // 1. reasons to be flat: kill switch, agent not active, unusable configuration (all markets) or market class switched off
      const stopReason = st.kill_switch ? "kill_switch" : a.status === "halted" ? "halted" : a.status === "stopped" ? "stopped" : !rule ? "bad_config" : null;
      const stillOpen: any[] = [];
      for (const p of mine) {
        const why = stopReason ?? (st.markets_enabled?.[p.market] !== true ? "market_disabled" : null);
        if (why) { try { await closePos(p, why); } catch (e) { stillOpen.push(p); log.push({ symbol: p.symbol, action: "close_failed", error: msg(e) }); } }
        else stillOpen.push(p);
      }

      // 2. equity, peak, drawdown limit
      let invested = 0;
      for (const p of stillOpen) invested += valueOf(p.side, p.qty, p.entry_price, p.entry_notional, await markOf(p.symbol, p.market, p.entry_price));
      let equity = cash + invested;
      const peak = Math.max(Number(state.peak_equity ?? a.capital_start), equity);
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      let halted = false;
      if (!stopReason && dd >= (risk.max_drawdown_pct ?? 10)) {
        halted = true;
        await tx`update agent_core.agents set status = 'halted', halted_reason = 'max_drawdown' where id = ${a.id}`;
        await notify("halt", `${a.name} gestoppt: maximaler Rückgang`, `Rückgang ${r2(dd)} % erreicht (Limit ${risk.max_drawdown_pct ?? 10} %). Positionen werden geschlossen, keine neuen Trades bis zur Freigabe.`, { drawdown_pct: dd });
        for (const p of [...stillOpen]) {
          try { await closePos(p, "halted"); stillOpen.splice(stillOpen.indexOf(p), 1); } catch (e) { log.push({ symbol: p.symbol, action: "close_failed", error: msg(e) }); }
        }
      }

      // 3. one decision per symbol and closed bar
      if (!stopReason && !halted && rule) {
        for (const { s: symbol, cls } of syms) {
          if (st.markets_enabled?.[cls] !== true) continue;
          const cc = costsOf(conf, cls, symbol);
          let bars: Bar[];
          try { bars = await barsOf(symbol, cls, cfg.tf); } catch (e) { log.push({ symbol, action: "no_data", error: msg(e) }); continue; }
          if (bars.length < Math.round(210 * (1440 / cfg.tf))) { log.push({ symbol, action: "no_data", error: `only ${bars.length} bars` }); continue; }
          const last = bars[bars.length - 1];
          const p = stillOpen.find((x) => x.symbol === symbol) ?? null;
          if (decided[symbol] === last.ts) continue; // this bar was already handled
          const step = cfg.tf * 60000;
          const age = now - (last.ts + step);
          const posArg = p ? { side: p.side as Side, entryBarTs: Math.floor(p.entry_ms / step) * step } : null;
          let T: TwoWay;
          if (twoWay(cls)) T = decideTwoWay(bars, rule, cfg, posArg, { long: blocked[symbol] === true, short: blockedShort[symbol] === true });
          else {
            const L = decide(bars, rule, cfg, posArg, blocked[symbol] === true);
            T = { long: L, short: L, close: !!p && L.action === "sell", open: !p && L.action === "buy" ? "long" : null, reason: L.reason, blocked: { long: L.blocked, short: false } };
          }
          const D = p?.side === "short" || (!p && T.open === "short") ? T.short : T.long;
          const feats = { rule: rule.id, tf: cfg.tf, close: last.c, atr: D.atr, vol: D.vol, want_long: T.long.want, want_short: twoWay(cls) ? T.short.want : null,
            trail_level: D.trailLevel === null ? null : p?.side === "short" ? 1 / D.trailLevel : D.trailLevel };
          const saveBlocked = () => { blocked[symbol] = T.blocked.long; if (twoWay(cls)) blockedShort[symbol] = T.blocked.short; };

          if (!T.close && !T.open) { // hold or nothing to do
            if (p && feats.trail_level !== null && feats.trail_level !== p.sl) await tx`update agent_core.positions set sl_price = ${feats.trail_level} where id = ${p.id}`;
            saveBlocked(); decided[symbol] = last.ts;
            await signal(cls, symbol, last.ts, p?.side ?? "long", p ? "hold" : "no_signal", T.blocked.long || T.blocked.short ? "waiting_after_trailing_stop" : null, feats);
            continue;
          }
          let q: Quote;
          try { q = await quoteOf(symbol, cls); } catch (e) { log.push({ symbol, action: "no_quote", error: msg(e) }); continue; } // retried in 5 minutes
          if (!q.fresh) { // currency market closed: exits wait as long as needed, entries up to 72 h
            if (T.close || age < FX_DEFER_MAX_MS) { log.push({ symbol, action: "deferred", reason: "market_closed" }); continue; }
            saveBlocked(); decided[symbol] = last.ts;
            await signal(cls, symbol, last.ts, T.open!, "skipped", "market_closed_too_long", feats);
            continue;
          }
          if (T.close && p) {
            await closePos(p, T.reason!);
            stillOpen.splice(stillOpen.indexOf(p), 1);
            saveBlocked(); // a trailing stop blocks re-entry on that side right away, also if the flip below is deferred
            await signal(cls, symbol, last.ts, p.side, "exit", T.reason, feats);
            if (!T.open) { decided[symbol] = last.ts; continue; }
          }
          // new position (also the second half of a flip from long to short or back)
          const side = T.open!;
          const Dn = side === "long" ? T.long : T.short;
          const news = newsOf(cls);
          const hold = news.hold ? "news_hold" : calendarHold ? "calendar_event" : null;
          // ask again in 5 minutes; currencies may already be older after a weekend, so they get the weekend window too
          if (hold && age < (cls === "forex" ? FX_DEFER_MAX_MS : DEFER_MAX_MS)) { log.push({ symbol, side, action: "deferred", reason: hold }); continue; }
          saveBlocked(); decided[symbol] = last.ts;
          if (hold) { await signal(cls, symbol, last.ts, side, "skipped", `${hold}_too_long`, feats); continue; }
          const fill = entryPx(side, pxOf(q, cc), cc.slip_bps);
          const w = weightOf(cfg, syms.length, Dn.vol) * news.factor;
          // small crypto accounts: raise to the exchange minimum (config risk.min_order_usd), at most to the full 1/N share
          const size = orderUsd(equity, w, syms.length, cls === "crypto" ? Number(risk.min_order_usd ?? 0) : 0);
          const qty = (size.raised ? Math.ceil : Math.floor)((size.usd / fill) * 1e6) / 1e6;
          const notional = qty * fill, fee = (notional * cc.fee_bps) / 1e4;
          const share = equity > 0 ? notional / equity : 0;
          if (notional < (risk.min_notional_usd ?? 10)) { await signal(cls, symbol, last.ts, side, "skipped", "size_min_notional", { ...feats, weight: w }); continue; }
          if (notional + fee > cash) { await signal(cls, symbol, last.ts, side, "skipped", "insufficient_cash", { ...feats, weight: w }); continue; }
          // trailing stop level for display (rules with a trailing stop); for a short it is computed on 1/price and shown as a price
          const lvl = Dn.atr > 0 && rule.trailAtr ? Dn.close - rule.trailAtr * Dn.atr : null;
          const sl = lvl === null ? null : side === "long" ? lvl : lvl > 0 ? 1 / lvl : null;
          const riskUsd = Dn.atr > 0 && Dn.close > 0 ? 3 * (Dn.atr / Dn.close) * notional : notional * 0.1; // nominal risk for R multiples: 3 x daily ATR
          await tx`
            insert into agent_core.positions (agent_id, market, symbol, side, qty, entry_price, entry_fee, entry_notional, sl_price, tp_price, risk_usd, quality, setup_key, features, note)
            values (${a.id}, ${cls}, ${symbol}, ${side}, ${qty}, ${fill}, ${fee}, ${notional}, ${sl}, null, ${riskUsd}, null, ${`${symbol}:${side}:${rule.id}`},
                    ${tx.json({ ...feats, weight: w, share, raised_to_min: size.raised, news_factor: news.factor, mid: q.last, quote_source: q.source } as any)}, ${`Trend-Regel: ${rule.name}`})`;
          cash -= notional + fee;
          equity -= fee;
          traded = true;
          await notify("trade_opened", `${symbol} ${sideTxt(side)} eröffnet (${rule.name})`, `Einstieg ${fill.toPrecision(7)}, Größe ${r2(notional)} USD (${r2(share * 100)} % des Kapitals${size.raised ? ", auf die Mindestorder angehoben" : ""})`, { symbol, side, entry: fill, notional, weight: w, share, raised_to_min: size.raised, rule: rule.id });
          await signal(cls, symbol, last.ts, side, "entry", size.raised ? "raised_to_min_order" : null, { ...feats, weight: w, share });
          log.push({ symbol, side, action: "opened", notional: r2(notional), share_pct: r2(share * 100), raised_to_min: size.raised });
        }
      }

      // 4. snapshot and state
      const openNow = await tx`select symbol, market, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_notional::float8 as entry_notional
                               from agent_core.positions where agent_id = ${a.id} and status = 'open'`;
      invested = 0;
      for (const p of openNow) invested += valueOf(p.side, p.qty, p.entry_price, p.entry_notional, await markOf(p.symbol, p.market, p.entry_price));
      equity = cash + invested;
      const peak2 = Math.max(peak, equity);
      if (new Date(now).getUTCMinutes() < 5 || traded) {
        const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
        const [rt] = await tx`select coalesce(sum(pnl_usd), 0)::float8 as realized from agent_core.positions where agent_id = ${a.id} and status = 'closed' and exit_time >= ${iso(dayStart)}`;
        await tx`insert into agent_core.equity_snapshots (agent_id, equity, cash, open_positions, day_pnl, drawdown_pct)
                 values (${a.id}, ${equity}, ${cash}, ${openNow.length}, ${rt.realized}, ${peak2 > 0 ? ((peak2 - equity) / peak2) * 100 : 0})`;
      }
      await tx`update agent_core.agents set cash = ${cash},
               state = state || ${tx.json({ peak_equity: peak2, last_tick_at: iso(now), decided, blocked, blocked_short: blockedShort } as any)}::jsonb where id = ${a.id}`;
      let replication: string | null = null;
      if (profitClose && a.status === "active") replication = (await tx`select agent_core.fn_check_replication(${a.id}::uuid) as res`)[0].res;
      out.push({ agent: a.name, rule: rule?.id ?? null, status: halted ? "halted" : a.status, stop_reason: stopReason, equity: r2(equity), cash: r2(cash), open: openNow.length, actions: log, replication });
    }

    // 5. manual account (the user trades it in the app): prices of its open positions and an hourly equity snapshot. No trading here.
    const manual = await tx`select id, name, state, capital_start::float8 as capital_start, cash::float8 as cash from agent_core.agents where mode = 'paper' and config->>'engine' = 'manual'`;
    const manualOut: any[] = [];
    for (const mAgent of manual) {
      const pos = await tx`select symbol, market, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_notional::float8 as entry_notional
                           from agent_core.positions where agent_id = ${mAgent.id} and status = 'open'`;
      let inv = 0;
      for (const p of pos) inv += valueOf(p.side, p.qty, p.entry_price, p.entry_notional, await markOf(p.symbol, p.market, p.entry_price));
      const eq = mAgent.cash + inv;
      const pk = Math.max(Number(mAgent.state?.peak_equity ?? mAgent.capital_start), eq);
      if (new Date(now).getUTCMinutes() < 5) {
        const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
        const [rt] = await tx`select coalesce(sum(pnl_usd), 0)::float8 as realized from agent_core.positions where agent_id = ${mAgent.id} and status = 'closed' and exit_time >= ${iso(dayStart)}`;
        await tx`insert into agent_core.equity_snapshots (agent_id, equity, cash, open_positions, day_pnl, drawdown_pct)
                 values (${mAgent.id}, ${eq}, ${mAgent.cash}, ${pos.length}, ${rt.realized}, ${pk > 0 ? ((pk - eq) / pk) * 100 : 0})`;
      }
      await tx`update agent_core.agents set state = state || ${tx.json({ peak_equity: pk, last_tick_at: iso(now) } as any)}::jsonb where id = ${mAgent.id}`;
      manualOut.push({ agent: mAgent.name, equity: r2(eq), open: pos.length });
    }

    // 6. latest prices for the app (positions of currency pairs and tokens without minute candles)
    for (const [symbol, v] of seen) {
      await tx`insert into agent_core.quotes (symbol, market, bid, ask, last, quote_time, fetched_at, source)
               values (${symbol}, ${v.market}, ${v.q.bid}, ${v.q.ask}, ${v.q.last}, ${iso(v.q.at)}, now(), ${v.q.source})
               on conflict (symbol) do update set market = excluded.market, bid = excluded.bid, ask = excluded.ask, last = excluded.last,
                 quote_time = excluded.quote_time, fetched_at = excluded.fetched_at, source = excluded.source`;
    }

    const protection = { calendar_hold: calendarHold, crypto: newsOf("crypto"), forex: newsOf("forex") };
    const result = { status: "ok", dry_run: dry, now: iso(now), usdrub: rub, protection, agents: out, manual: manualOut, quotes: seen.size };
    if (dry) throw new Rollback(result);
    return result;
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const provided = req.headers.get("x-agent-secret");
  if (!provided) return json({ error: "unauthorized" }, 401);
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret'`;
    if (!secret || !safeEqual(provided, secret.decrypted_secret)) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    return json(await tick(sql, body?.dry_run === true));
  } catch (e) {
    if (e instanceof Rollback) return json(e.result);
    console.error("trend-tick failed", e);
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
