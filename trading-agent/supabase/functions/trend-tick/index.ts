// trend-tick: slow, rule-based agents (agents.config.engine = "trend"), e.g. "Momentum-Abstimmung" or "Turtle 55/20" on daily bars.
// SIMULATION ONLY: paper positions in agent_core.positions (same accounting as agent-tick); the bybit-demo function mirrors crypto
// longs on the Bybit DEMO account. Runs every 5 minutes; a trading decision is made once per symbol after a new bar has CLOSED.
// Protection layer (can only delay or shrink entries, never add risk): kill switch, agent status, max drawdown, fresh high-impact
// news (no new entry for 30 min), calendar events (FOMC, US payrolls: no new entry from 20 h before to 2 h after), many high-impact
// crypto headlines in 24 h (half size).
// Auth: header x-agent-secret (Vault agent_cron_secret); verify_jwt is off. Body: {} or { "dry_run": true } (everything is rolled back).
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { type Bar } from "./lab.ts";
import { decide, eventBlock, nfp, ruleOf, type TrendCfg, weightOf } from "./engine.ts";

const BYBIT = "https://api.bybit.com"; // public market data only, no key
const LOCK_KEY = 738202;
// A deferred entry is retried every 5 minutes and dropped 22 h after the bar closed (the rule is asked again at the next bar).
// 22 h covers the longest block on a daily bar: FOMC at 19:00 UTC plus 2 h.
const DEFER_MAX_MS = 22 * 3600_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (ms: number) => new Date(ms).toISOString();
class Rollback extends Error { constructor(public result: unknown) { super("rollback"); } }

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
async function ticker(symbol: string): Promise<{ bid: number; ask: number; last: number }> {
  const res = await getJson(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`);
  const t = res?.list?.[0];
  const bid = Number(t?.bid1Price), ask = Number(t?.ask1Price), last = Number(t?.lastPrice);
  if (!(bid > 0 && ask >= bid && last > 0)) throw new Error(`no usable quote for ${symbol}`);
  return { bid, ask, last };
}

async function tick(sql: any, dry: boolean) {
  const now = Date.now();
  const barsCache = new Map<string, Promise<Bar[]>>();
  const quoteCache = new Map<string, Promise<{ bid: number; ask: number; last: number }>>();
  const barsOf = (s: string, tf: number) => {
    const k = `${s}:${tf}`;
    if (!barsCache.has(k)) barsCache.set(k, klines(s, tf, Math.round(260 * (1440 / tf)), now));
    return barsCache.get(k)!;
  };
  const quoteOf = (s: string) => {
    if (!quoteCache.has(s)) quoteCache.set(s, ticker(s));
    return quoteCache.get(s)!;
  };

  return await sql.begin(async (tx: any) => {
    const [lk] = await tx`select pg_try_advisory_xact_lock(${LOCK_KEY}) as got`;
    if (!lk.got) return { status: "skipped_locked" };
    const [st] = await tx`select kill_switch, paper_only, markets_enabled from agent_core.settings where id`;
    if (!st || st.paper_only !== true) return { status: "refused_not_paper_only" };
    const agents = await tx`
      select id, name, status, config, state, capital_start::float8 as capital_start, cash::float8 as cash
      from agent_core.agents where mode = 'paper' and config->>'engine' = 'trend' order by created_at`;
    if (!agents.length) return { status: "no_trend_agents" };

    const trendIds = new Set<string>(agents.map((a: any) => a.id));
    const openAll = (await tx`
      select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price, entry_fee::float8 as entry_fee,
             entry_notional::float8 as entry_notional, risk_usd::float8 as risk_usd, sl_price::float8 as sl, (extract(epoch from entry_time) * 1000)::float8 as entry_ms
      from agent_core.positions where status = 'open' order by id`).filter((p: any) => trendIds.has(p.agent_id));
    const marks = new Map<string, number>((await tx`select distinct on (symbol) symbol, c::float8 as c from agent_core.candles where open_time > now() - interval '10 minutes' order by symbol, open_time desc`).map((r: any) => [r.symbol, r.c]));
    const newsHold = (await tx`select count(*)::int as n from agent_core.news_items where impact = 'high' and 'crypto' = any(markets) and fetched_at > now() - interval '30 minutes'`)[0].n > 0;
    const newsDay = (await tx`select count(*)::int as n from agent_core.news_items where impact = 'high' and 'crypto' = any(markets) and fetched_at > now() - interval '24 hours'`)[0].n;
    const newsFactor = newsDay >= 3 ? 0.5 : 1;
    const cal = (await tx`select (extract(epoch from starts_at) * 1000)::float8 as ms from agent_core.event_calendar where impact = 'high' and starts_at between now() - interval '3 hours' and now() + interval '21 hours'`).map((r: any) => r.ms as number);
    const y = new Date(now).getUTCFullYear(), m = new Date(now).getUTCMonth();
    const events = [...cal, nfp(y, m), m === 11 ? nfp(y + 1, 0) : nfp(y, m + 1)];
    const calendarHold = eventBlock(now, events);
    const out: any[] = [];

    for (const a of agents) {
      if (a.status === "pending_approval") continue;
      const conf = a.config ?? {};
      const cfg: TrendCfg = { rule: conf.strategy?.rule, tf: Number(conf.strategy?.tf ?? 1440), sizing: conf.strategy?.sizing === "equal" ? "equal" : "vol",
        ref_vol: Number(conf.strategy?.ref_vol ?? 0.6), vol_days: Number(conf.strategy?.vol_days ?? 30), scale: Math.min(1, Math.max(0, Number(conf.strategy?.scale ?? 0.25))) };
      const rule = ruleOf(cfg.rule, cfg.tf);
      const risk = conf.risk ?? {};
      const cc = conf.costs?.crypto ?? { fee_bps: 10, slip_bps: 2 };
      const syms: string[] = conf.markets?.crypto ?? [];
      const state = a.state ?? {};
      const decided: Record<string, number> = { ...(state.decided ?? {}) };
      const blocked: Record<string, boolean> = { ...(state.blocked ?? {}) };
      const mine = openAll.filter((p: any) => p.agent_id === a.id);
      let cash: number = a.cash;
      const log: any[] = [];
      let traded = false, profitClose = false;
      const notify = (kind: string, title: string, text: string, payload: unknown) =>
        tx`insert into agent_core.notifications (kind, agent_id, title, body, payload) values (${kind}, ${a.id}, ${title}, ${text}, ${tx.json(payload as any)})`;
      const signal = (symbol: string, barTs: number, decision: string, reason: string | null, features: unknown) =>
        tx`insert into agent_core.signals (agent_id, market, symbol, candle_time, side, quality, decision, reason, features)
           values (${a.id}, 'crypto', ${symbol}, ${iso(barTs)}, 'long', null, ${decision}, ${reason}, ${tx.json(features as any)})`;

      const closePos = async (p: any, reason: string) => {
        const q = await quoteOf(p.symbol);
        const px = q.bid * (1 - cc.slip_bps / 1e4);
        const fee = (px * p.qty * cc.fee_bps) / 1e4;
        const gross = (px - p.entry_price) * p.qty;
        const net = gross - p.entry_fee - fee;
        const rMult = p.risk_usd > 0 ? net / p.risk_usd : null;
        cash += p.entry_notional + gross - fee;
        await tx`update agent_core.positions set status = 'closed', exit_price = ${px}, exit_time = now(), exit_fee = ${fee},
                 close_reason = ${reason}, pnl_usd = ${net}, r_multiple = ${rMult} where id = ${p.id}`;
        await tx`select agent_core.fn_after_close(${p.id}::bigint)`;
        await notify("trade_closed", `${p.symbol} long geschlossen (${reason})`, `PnL ${net >= 0 ? "+" : ""}${r2(net)} USD`, { symbol: p.symbol, side: "long", reason, exit_price: px, pnl_usd: net });
        traded = true; if (net > 0) profitClose = true;
        log.push({ symbol: p.symbol, action: "closed", reason, pnl_usd: r2(net) });
      };

      // 1. reasons to be flat: kill switch, agent not active, market switched off, unusable configuration
      const stopReason = st.kill_switch ? "kill_switch" : a.status === "halted" ? "halted" : a.status === "stopped" ? "stopped"
        : st.markets_enabled?.crypto !== true ? "market_disabled" : !rule ? "bad_config" : null;
      const stillOpen: any[] = [];
      for (const p of mine) {
        if (stopReason) { try { await closePos(p, stopReason); } catch (e) { stillOpen.push(p); log.push({ symbol: p.symbol, action: "close_failed", error: msg(e) }); } }
        else stillOpen.push(p);
      }

      // 2. equity, peak, drawdown limit
      const markOf = async (p: any) => marks.get(p.symbol) ?? (await quoteOf(p.symbol).then((q) => q.last).catch(() => p.entry_price));
      let invested = 0;
      for (const p of stillOpen) invested += p.qty * (await markOf(p));
      let equity = cash + invested;
      const peak = Math.max(Number(state.peak_equity ?? a.capital_start), equity);
      const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
      let halted = false;
      if (!stopReason && dd >= (risk.max_drawdown_pct ?? 10)) {
        halted = true;
        await tx`update agent_core.agents set status = 'halted', halted_reason = 'max_drawdown' where id = ${a.id}`;
        await notify("halt", `${a.name} gestoppt: maximaler Rückgang`, `Rückgang ${r2(dd)} % erreicht (Limit ${risk.max_drawdown_pct ?? 10} %). Positionen werden verkauft, keine neuen Trades bis zur Freigabe.`, { drawdown_pct: dd });
        for (const p of [...stillOpen]) { await closePos(p, "halted"); stillOpen.splice(stillOpen.indexOf(p), 1); }
      }

      // 3. one decision per symbol and closed bar
      if (!stopReason && !halted && rule) {
        for (const symbol of syms) {
          let bars: Bar[];
          try { bars = await barsOf(symbol, cfg.tf); } catch (e) { log.push({ symbol, action: "no_data", error: msg(e) }); continue; }
          if (bars.length < Math.round(210 * (1440 / cfg.tf))) { log.push({ symbol, action: "no_data", error: `only ${bars.length} bars` }); continue; }
          const last = bars[bars.length - 1];
          const p = stillOpen.find((x) => x.symbol === symbol) ?? null;
          if (decided[symbol] === last.ts) continue; // this bar was already handled
          const step = cfg.tf * 60000;
          const d = decide(bars, rule, cfg, p ? { entryBarTs: Math.floor(p.entry_ms / step) * step } : null, blocked[symbol] === true);
          const feats = { rule: rule.id, tf: cfg.tf, close: d.close, atr: d.atr, vol: d.vol, hi: d.hi, trail_level: d.trailLevel, want: d.want };
          if (d.action === "sell" && p) {
            await closePos(p, d.reason!);
            stillOpen.splice(stillOpen.indexOf(p), 1);
            blocked[symbol] = d.blocked; decided[symbol] = last.ts;
            await signal(symbol, last.ts, "exit", d.reason, feats);
          } else if (d.action === "hold" && p) {
            if (d.trailLevel !== null && d.trailLevel !== p.sl) await tx`update agent_core.positions set sl_price = ${d.trailLevel} where id = ${p.id}`;
            blocked[symbol] = d.blocked; decided[symbol] = last.ts;
            await signal(symbol, last.ts, "hold", null, feats);
          } else if (d.action === "buy") {
            const hold = newsHold ? "news_hold" : calendarHold ? "calendar_event" : null;
            const age = now - (last.ts + step);
            if (hold && age < DEFER_MAX_MS) { log.push({ symbol, action: "deferred", reason: hold }); continue; } // ask again in 5 minutes
            if (hold) { decided[symbol] = last.ts; await signal(symbol, last.ts, "skipped", `${hold}_too_long`, feats); continue; }
            const q = await quoteOf(symbol);
            const fill = q.ask * (1 + cc.slip_bps / 1e4);
            const w = weightOf(cfg, syms.length, d.vol) * newsFactor;
            const qty = Math.floor(((equity * w) / fill) * 1e6) / 1e6;
            const notional = qty * fill, fee = (notional * cc.fee_bps) / 1e4;
            decided[symbol] = last.ts; blocked[symbol] = d.blocked;
            if (notional < (risk.min_notional_usd ?? 10)) { await signal(symbol, last.ts, "skipped", "size_min_notional", { ...feats, weight: w }); continue; }
            if (notional + fee > cash) { await signal(symbol, last.ts, "skipped", "insufficient_cash", { ...feats, weight: w }); continue; }
            const sl = d.atr > 0 && rule.trailAtr ? d.close - rule.trailAtr * d.atr : null;
            const riskUsd = d.atr > 0 ? 3 * d.atr * qty : notional * 0.1; // nominal risk for R multiples: 3 x daily ATR
            await tx`
              insert into agent_core.positions (agent_id, market, symbol, side, qty, entry_price, entry_fee, entry_notional, sl_price, tp_price, risk_usd, quality, setup_key, features, note)
              values (${a.id}, 'crypto', ${symbol}, 'long', ${qty}, ${fill}, ${fee}, ${notional}, ${sl}, null, ${riskUsd}, null, ${`${symbol}:long:${rule.id}`},
                      ${tx.json({ ...feats, weight: w, news_factor: newsFactor, bid: q.bid, ask: q.ask } as any)}, ${`Trend-Regel: ${rule.name}`})`;
            cash -= notional + fee;
            equity -= fee;
            traded = true;
            await notify("trade_opened", `${symbol} long eröffnet (${rule.name})`, `Einstieg ${fill.toPrecision(7)}, Größe ${r2(notional)} USD (${r2(w * 100)} % des Kapitals)`, { symbol, side: "long", entry: fill, notional, weight: w, rule: rule.id });
            await signal(symbol, last.ts, "entry", null, { ...feats, weight: w });
            log.push({ symbol, action: "opened", notional: r2(notional), weight: r2(w * 100) });
          } else {
            blocked[symbol] = d.blocked; decided[symbol] = last.ts;
            await signal(symbol, last.ts, "no_signal", d.blocked ? "waiting_after_trailing_stop" : null, feats);
          }
        }
      }

      // 4. snapshot and state
      const openNow = await tx`select symbol, qty::float8 as qty, entry_price::float8 as entry_price from agent_core.positions where agent_id = ${a.id} and status = 'open'`;
      invested = 0;
      for (const p of openNow) invested += p.qty * (marks.get(p.symbol) ?? p.entry_price);
      equity = cash + invested;
      const peak2 = Math.max(peak, equity);
      if (new Date(now).getUTCMinutes() < 5 || traded) {
        const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
        const [rt] = await tx`select coalesce(sum(pnl_usd), 0)::float8 as realized from agent_core.positions where agent_id = ${a.id} and status = 'closed' and exit_time >= ${iso(dayStart)}`;
        await tx`insert into agent_core.equity_snapshots (agent_id, equity, cash, open_positions, day_pnl, drawdown_pct)
                 values (${a.id}, ${equity}, ${cash}, ${openNow.length}, ${rt.realized}, ${peak2 > 0 ? ((peak2 - equity) / peak2) * 100 : 0})`;
      }
      await tx`update agent_core.agents set cash = ${cash},
               state = state || ${tx.json({ peak_equity: peak2, last_tick_at: iso(now), decided, blocked } as any)}::jsonb where id = ${a.id}`;
      let replication: string | null = null;
      if (profitClose && a.status === "active") replication = (await tx`select agent_core.fn_check_replication(${a.id}::uuid) as res`)[0].res;
      out.push({ agent: a.name, rule: rule?.id ?? null, status: halted ? "halted" : a.status, stop_reason: stopReason, equity: r2(equity), cash: r2(cash), open: openNow.length, actions: log, replication });
    }
    const result = { status: "ok", dry_run: dry, now: iso(now), protection: { news_hold: newsHold, calendar_hold: calendarHold, news_factor: newsFactor }, agents: out };
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
