// agent-tick: one-minute tick of the paper-trading agents (crypto via Bybit public data, EUR/USD via Yahoo).
// SIMULATION ONLY: no exchange keys, no orders of any kind. Writes only to the agent_core schema.
// Auth: shared secret in header x-agent-secret (Supabase Vault secret agent_cron_secret); verify_jwt is off.
// Test hooks (body): { selftest: true } | { rehearsal: true, force_entry?: {symbol, side?}, force_exit?: true }
//   rehearsal = the whole tick runs on live data inside a transaction that is ALWAYS rolled back (nothing persists).
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { type Candle, MINUTE, ema, rsi } from "./lib.ts";
import {
  type CostCfg,
  type Setup,
  type Side,
  type StratCfg,
  checkExit,
  entryFill,
  evaluateSetup,
  exitFill,
  positionValue,
  setupKey,
  sizeQty,
  tradePnl,
} from "./strategy.ts";

const LOCK_KEY = 727002;
const BYBIT = "https://api.bybit.com";
const YAHOO = "https://query1.finance.yahoo.com";
const M15 = 15 * MINUTE;
const DEFAULT_MAX_LAG_S: Record<string, number> = { crypto: 180, forex: 300 };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number) => new Date(ms).toISOString();
const r2 = (x: number) => Math.round(x * 100) / 100;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- data sources (public, no keys) ----------

async function getJson(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: ctrl.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, body, snippet: text.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const closedOnly = (c: Candle[], step: number, now: number) =>
  c
    .filter((x) => [x.ts, x.o, x.h, x.l, x.c].every(Number.isFinite) && x.ts + step <= now)
    .map((x) => ({ ...x, v: Number.isFinite(x.v) ? x.v : 0 }))
    .sort((a, b) => a.ts - b.ts);

async function bybitKlines(symbol: string, interval: 1 | 15, limit: number): Promise<Candle[]> {
  const r = await getJson(`${BYBIT}/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.snippet}`);
  if (r.body?.retCode !== 0) throw new Error(`retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`);
  const rows = (r.body.result.list as string[][]).map((x) => ({
    ts: Number(x[0]), o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]),
  }));
  return closedOnly(rows, interval * MINUTE, Date.now());
}

async function bybitTicker(symbol: string): Promise<{ bid: number; ask: number }> {
  const r = await getJson(`${BYBIT}/v5/market/tickers?category=spot&symbol=${symbol}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.snippet}`);
  if (r.body?.retCode !== 0) throw new Error(`retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`);
  const row = r.body.result?.list?.[0];
  const bid = Number(row?.bid1Price);
  const ask = Number(row?.ask1Price);
  if (!(bid > 0) || !(ask >= bid)) throw new Error("no valid bid/ask");
  return { bid, ask };
}

async function yahooCandles(symbol: string, interval: "1m" | "15m", range: string): Promise<Candle[]> {
  const r = await getJson(`${YAHOO}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, {
    "user-agent": "trading-sim-agent/0.1 (paper-trading research)",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.snippet}`);
  const res = r.body?.chart?.result?.[0];
  if (!res) throw new Error(`no result: ${r.body?.chart?.error?.description ?? "unknown"}`);
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const rows: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open?.[i] == null || q.high?.[i] == null || q.low?.[i] == null || q.close?.[i] == null) continue;
    rows.push({ ts: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
  }
  return closedOnly(rows, interval === "1m" ? MINUTE : M15, Date.now());
}

type Spec = { symbol: string; market: "crypto" | "forex"; source: "bybit_spot" | "yahoo_chart" };
type SymData = {
  spec: Spec;
  c1: Candle[] | null;
  c15: Candle[] | null;
  bid: number | null;
  ask: number | null;
  latencyMs: number;
  error: string | null;
};

async function fetchSymbol(spec: Spec): Promise<SymData> {
  const t0 = performance.now();
  const out: SymData = { spec, c1: null, c15: null, bid: null, ask: null, latencyMs: 0, error: null };
  const errs: string[] = [];
  if (spec.source === "bybit_spot") {
    const [k1, k15, tk] = await Promise.allSettled([bybitKlines(spec.symbol, 1, 300), bybitKlines(spec.symbol, 15, 120), bybitTicker(spec.symbol)]);
    if (k1.status === "fulfilled") out.c1 = k1.value; else errs.push(`1m: ${msg(k1.reason)}`);
    if (k15.status === "fulfilled") out.c15 = k15.value; else errs.push(`15m: ${msg(k15.reason)}`);
    if (tk.status === "fulfilled") { out.bid = tk.value.bid; out.ask = tk.value.ask; } else errs.push(`ticker: ${msg(tk.reason)}`);
  } else {
    const [k1, k15] = await Promise.allSettled([yahooCandles(spec.symbol, "1m", "1d"), yahooCandles(spec.symbol, "15m", "5d")]);
    if (k1.status === "fulfilled") out.c1 = k1.value; else errs.push(`1m: ${msg(k1.reason)}`);
    if (k15.status === "fulfilled") out.c15 = k15.value; else errs.push(`15m: ${msg(k15.reason)}`);
  }
  out.latencyMs = Math.round(performance.now() - t0);
  out.error = errs.length ? errs.join("; ").slice(0, 300) : null;
  return out;
}

/** Spread in bps: measured from the ticker when available, otherwise the configured fallback (and marked as assumed). */
function spreadOf(d: SymData, fallbackBps: number): { bps: number; source: "measured" | "assumed"; bid: number; ask: number; mid: number } | null {
  const last = d.c1?.length ? d.c1[d.c1.length - 1].c : null;
  if (d.bid && d.ask) {
    const mid = (d.bid + d.ask) / 2;
    return { bps: ((d.ask - d.bid) / mid) * 1e4, source: "measured", bid: d.bid, ask: d.ask, mid };
  }
  if (last === null) return null;
  return { bps: fallbackBps, source: "assumed", bid: last * (1 - fallbackBps / 2 / 1e4), ask: last * (1 + fallbackBps / 2 / 1e4), mid: last };
}

// ---------- self test (verifies the deployed code in the Deno runtime against hand values) ----------

function selftest() {
  const checks: Record<string, boolean> = {};
  const e = ema([22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15], 10);
  checks.ema_seed_is_sma = Math.abs(e[9] - 22.221) < 1e-9;
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  checks.rsi_hand_value = Math.abs(rsi(closes, 14)[14] - (100 - 100 / (1 + 3.34 / 1.4))) < 1e-9;
  checks.long_pnl = Math.abs(tradePnl("long", 100, 2, 0.2, 110, 0.22).net - 19.58) < 1e-9;
  checks.short_pnl = Math.abs(tradePnl("short", 100, 2, 0.2, 90, 0.18).net - 19.62) < 1e-9;
  checks.entry_fill = Math.abs(entryFill("long", 100, 100.1, 2) - 100.1 * 1.0002) < 1e-9;
  checks.exit_fill = Math.abs(exitFill("short", 90, 4, 1) - 90 * 1.0003) < 1e-9;
  const x = checkExit({ side: "long", sl: 99, tp: 102, entryMs: 0 }, [{ ts: 60000, o: 100, h: 103, l: 98, c: 100, v: 1 }]);
  checks.stop_first = x?.reason === "stop" && x.raw === 99;
  return { all_ok: Object.values(checks).every(Boolean), checks };
}

// ---------- the tick ----------

class Rollback {
  constructor(public result: unknown) {}
}

async function tick(sql: any, body: any) {
  const now = Date.now();
  const region = Deno.env.get("SB_REGION") ?? null;
  const rehearsal = body?.rehearsal === true;
  const forceEntry: { symbol: string; side?: Side } | null =
    rehearsal && typeof body?.force_entry?.symbol === "string" ? body.force_entry : null;
  const forceExit = rehearsal && body?.force_exit === true;

  const [st] = await sql`select kill_switch, paper_only, markets_enabled from agent_core.settings where id`;
  if (!st) return { status: "no_settings" };
  if (st.paper_only !== true) return { status: "refused_not_paper_only" };
  const killSwitch = st.kill_switch === true && !rehearsal;

  const agents = await sql`
    select id, name, status, config, state, capital_start::float8 as capital_start, cash::float8 as cash
    from agent_core.agents where mode = 'paper' order by created_at`;
  const specs = new Map<string, Spec>([["EURUSD=X", { symbol: "EURUSD=X", market: "forex", source: "yahoo_chart" }]]);
  for (const a of agents) {
    for (const m of ["crypto", "forex"] as const) {
      for (const s of a.config?.markets?.[m] ?? []) {
        specs.set(s, { symbol: s, market: m, source: m === "crypto" ? "bybit_spot" : "yahoo_chart" });
      }
    }
  }
  const data = await Promise.all([...specs.values()].map(fetchSymbol));
  const dm = new Map<string, SymData>(data.map((d) => [d.spec.symbol, d]));

  try {
    return await sql.begin(async (tx: any) => {
      const [lk] = await tx`select pg_try_advisory_xact_lock(${LOCK_KEY}) as got`;
      if (!lk.got) return { status: "skipped_locked" };

      // 1. persist closed candles and mark the data status of every symbol (also explicit failures)
      const lagOf = (d: SymData) => (d.c1?.length ? (now - (d.c1[d.c1.length - 1].ts + MINUTE)) / 1000 : null);
      for (const d of data) {
        const sym = d.spec.symbol;
        if (d.c1?.length) {
          const [mx] = await tx`select (extract(epoch from max(open_time)) * 1000)::float8 as ms from agent_core.candles where symbol = ${sym}`;
          const fresh = d.c1.filter((c) => c.ts > (mx?.ms ?? 0));
          if (fresh.length) {
            const rows = fresh.map((c) => ({ symbol: sym, market: d.spec.market, open_time: iso(c.ts), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, source: d.spec.source }));
            await tx`insert into agent_core.candles ${tx(rows, "symbol", "market", "open_time", "o", "h", "l", "c", "v", "source")} on conflict (symbol, open_time) do nothing`;
          }
        }
        const lag = lagOf(d);
        const maxLag = DEFAULT_MAX_LAG_S[d.spec.market];
        const stale = lag !== null && lag > maxLag;
        const ok = !d.error && lag !== null && !stale && !!d.c15?.length;
        const err = d.error ?? (lag === null ? "no closed candle" : stale ? `stale: newest closed candle is ${Math.round(lag)} s old (limit ${maxLag} s)` : null);
        const lastOpen = d.c1?.length ? iso(d.c1[d.c1.length - 1].ts) : null;
        const hasVol = d.c1?.length ? d.c1.slice(-30).some((c) => c.v > 0) : null;
        // Market assessment for the dashboard (trend, momentum, volatility, quality), independent of any running agent.
        // Uses the first agent's strategy/cost settings as the reference; stays null when data is missing.
        let assessment: Record<string, unknown> | null = null;
        const baseCfg = agents[0]?.config;
        if (baseCfg?.strategy && d.c1?.length && d.c15?.length) {
          const cc: CostCfg = baseCfg.costs?.[d.spec.market] ?? { fee_bps: 10, slip_bps: 2, fallback_spread_bps: 3 };
          const sp = spreadOf(d, cc.fallback_spread_bps);
          if (sp) {
            const last = d.c1[d.c1.length - 1];
            const setup = evaluateSetup({
              market: d.spec.market, c1: d.c1, c15: d.c15, nowMs: now, spreadBps: sp.bps, spreadSource: sp.source, strat: baseCfg.strategy as StratCfg, costs: cc,
              allowShort: baseCfg.allow_short?.[d.spec.market] === true, maxLagS: baseCfg.data?.max_lag_s?.[d.spec.market] ?? DEFAULT_MAX_LAG_S[d.spec.market],
              maxGapMin: d.spec.market === "crypto" ? 0 : 2,
            });
            assessment = {
              evaluated_at: iso(now), candle_time: iso(last.ts), decision: setup.decision, side: setup.side, quality: setup.quality,
              min_quality: baseCfg.strategy.min_quality ?? null, reasons: setup.reasons, features: setup.features, parts: setup.parts,
              last: { o: last.o, h: last.h, l: last.l, c: last.c, v: last.v }, bid: d.bid, ask: d.ask,
            };
          }
        }
        await tx`
          insert into agent_core.data_status (symbol, market, source, ok, last_attempt_at, last_ok_at, last_candle_open, lag_seconds, has_volume, error, assessment)
          values (${sym}, ${d.spec.market}, ${d.spec.source}, ${ok}, now(), ${ok ? iso(now) : null}, ${lastOpen}, ${lag === null ? null : Math.round(lag * 10) / 10}, ${hasVol}, ${err},
                  ${assessment === null ? null : tx.json(assessment as any)})
          on conflict (symbol) do update set market = excluded.market, source = excluded.source, ok = excluded.ok, last_attempt_at = now(),
            last_ok_at = case when excluded.ok then now() else agent_core.data_status.last_ok_at end,
            last_candle_open = coalesce(excluded.last_candle_open, agent_core.data_status.last_candle_open),
            lag_seconds = excluded.lag_seconds, has_volume = excluded.has_volume, error = excluded.error, assessment = excluded.assessment`;
      }
      // EUR/USD reference rate for the EUR conversion of profits (only from fresh data)
      const eu = dm.get("EURUSD=X");
      if (eu?.c1?.length && (lagOf(eu) ?? 1e9) <= DEFAULT_MAX_LAG_S.forex) {
        await tx`update agent_core.settings set eurusd_rate = ${eu.c1[eu.c1.length - 1].c}, eurusd_rate_at = now() where id`;
      }

      // 2. agents
      const openAll = await tx`
        select id::int as id, agent_id, market, symbol, side, qty::float8 as qty, entry_price::float8 as entry_price,
               (extract(epoch from entry_time) * 1000)::float8 as entry_ms, entry_fee::float8 as entry_fee,
               entry_notional::float8 as entry_notional, sl_price::float8 as sl, tp_price::float8 as tp, risk_usd::float8 as risk_usd
        from agent_core.positions where status = 'open' order by id`;
      const heldMarkets = new Set<string>(
        (await tx`select markets from agent_core.news_items where impact = 'high' and fetched_at > now() - interval '30 minutes'`).flatMap((r: any) => r.markets),
      );
      const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
      const out: any[] = [];

      for (const a of agents) {
        const mine = openAll.filter((p: any) => p.agent_id === a.id);
        if (a.status !== "active" && mine.length === 0 && !rehearsal) continue; // paused agents without positions do nothing
        if (a.status === "pending_approval") continue;
        const cfg = a.config ?? {};
        const strat = cfg.strategy as StratCfg;
        const risk = cfg.risk ?? {};
        const costsOf = (m: string): CostCfg => cfg.costs?.[m] ?? { fee_bps: 10, slip_bps: 2, fallback_spread_bps: 3 };
        const active = a.status === "active" || rehearsal;
        const marketOn = (m: string) => rehearsal || st.markets_enabled?.[m] === true;
        let cash: number = a.cash;
        const stopReason = killSwitch ? "kill_switch" : a.status === "halted" ? "halted" : a.status === "stopped" && !rehearsal ? "stopped" : null;
        const closedNow: any[] = [];
        const openedNow: any[] = [];
        const sigOut: any[] = [];

        const notify = (kind: string, title: string, text: string, payload: unknown) =>
          tx`insert into agent_core.notifications (kind, agent_id, title, body, payload) values (${kind}, ${a.id}, ${title}, ${text}, ${tx.json(payload as any)})`;

        const closePos = async (p: any, ref: number, spreadBps: number, reason: string, isFill: boolean) => {
          const c = costsOf(p.market);
          const px = isFill ? ref : exitFill(p.side, ref, spreadBps, c.slip_bps);
          const fee = (px * p.qty * c.fee_bps) / 1e4;
          const { gross, net } = tradePnl(p.side, p.entry_price, p.qty, p.entry_fee, px, fee);
          const rMult = p.risk_usd > 0 ? net / p.risk_usd : null;
          cash += p.entry_notional + gross - fee;
          await tx`update agent_core.positions set status = 'closed', exit_price = ${px}, exit_time = now(), exit_fee = ${fee},
                   close_reason = ${reason}, pnl_usd = ${net}, r_multiple = ${rMult} where id = ${p.id}`;
          await tx`select agent_core.fn_after_close(${p.id}::bigint)`;
          await notify("trade_closed", `${p.symbol} ${p.side} geschlossen (${reason})`, `PnL ${net >= 0 ? "+" : ""}${r2(net)} USD${rMult === null ? "" : `, ${r2(rMult)} R`}`, {
            symbol: p.symbol, side: p.side, reason, exit_price: px, pnl_usd: net, r: rMult,
          });
          closedNow.push({ id: p.id, symbol: p.symbol, side: p.side, reason, exit_price: px, pnl_usd: r2(net), r: rMult === null ? null : r2(rMult) });
        };

        // 2a. manage open positions first, so freed slots can be reused
        const stillOpen: any[] = [];
        for (const p of mine) {
          const d = dm.get(p.symbol);
          const sp = d ? spreadOf(d, costsOf(p.market).fallback_spread_bps) : null;
          if (!d?.c1?.length || !sp) { stillOpen.push(p); continue; } // no data: stays open, visible as failed data status
          const hit = checkExit({ side: p.side, sl: p.sl, tp: p.tp, entryMs: p.entry_ms }, d.c1);
          if (hit) {
            await closePos(p, hit.raw, sp.bps, hit.reason, false);
            continue;
          }
          const maxHold = (strat?.max_hold_min ?? 240) * MINUTE;
          const reason = stopReason ?? (!marketOn(p.market) ? "market_disabled" : now - p.entry_ms >= maxHold ? "time" : null);
          if (reason) await closePos(p, sp.mid, sp.bps, reason, false);
          else stillOpen.push(p);
        }

        // 2b. equity, peak and drawdown
        const mark = (p: any) => dm.get(p.symbol)?.c1?.at(-1)?.c ?? p.entry_price;
        let equity = cash + stillOpen.reduce((s, p) => s + positionValue(p.side, p.entry_notional, p.entry_price, p.qty, mark(p)), 0);
        const peak = Math.max(Number(a.state?.peak_equity ?? a.capital_start), equity);
        const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
        let haltedNow = false;
        if (a.status === "active" && dd >= (risk.max_drawdown_pct ?? 10)) {
          haltedNow = true;
          await tx`update agent_core.agents set status = 'halted', halted_reason = 'max_drawdown' where id = ${a.id}`;
          await notify("halt", `${a.name} gestoppt: maximaler Drawdown`, `Drawdown ${r2(dd)} % erreicht (Limit ${risk.max_drawdown_pct ?? 10} %). Keine neuen Trades, bis du den Agenten wieder freigibst.`, { drawdown_pct: dd });
        }

        // 2c. entry gates that do not depend on the symbol
        const [rt] = await tx`
          select coalesce(sum(pnl_usd), 0)::float8 as realized from agent_core.positions
          where agent_id = ${a.id} and status = 'closed' and exit_time >= ${iso(dayStart)}`;
        const recent = await tx`
          select symbol, close_reason, pnl_usd::float8 as pnl, (extract(epoch from exit_time) * 1000)::float8 as exit_ms
          from agent_core.positions where agent_id = ${a.id} and status = 'closed' order by exit_time desc limit 10`;
        const dailyLimit = -((risk.daily_loss_pct ?? 3) / 100) * a.capital_start;
        const streakN = risk.loss_streak_pause ?? 3;
        const streakHit = recent.length >= streakN && recent.slice(0, streakN).every((r: any) => r.pnl < 0) &&
          now - recent[0].exit_ms < (risk.loss_streak_pause_min ?? 60) * MINUTE;
        const cooling = (sym: string) =>
          recent.some((r: any) => r.symbol === sym && r.close_reason === "stop" && now - r.exit_ms < (risk.cooldown_after_stop_min ?? 15) * MINUTE);

        const canTrade = active && !killSwitch && !haltedNow && a.status !== "halted";
        const seenRows = await tx`
          select symbol, (extract(epoch from candle_time) * 1000)::float8 as ms from agent_core.signals
          where agent_id = ${a.id} and ts > now() - interval '10 minutes'`;
        const seen = new Set<string>(seenRows.map((r: any) => `${r.symbol}:${r.ms}`));

        // 2d. evaluate every configured symbol, rank by quality, open in that order
        type Cand = { symbol: string; market: string; setup: Setup; candleMs: number; sp: NonNullable<ReturnType<typeof spreadOf>>; d: SymData };
        const cands: Cand[] = [];
        for (const m of ["crypto", "forex"] as const) {
          for (const symbol of cfg.markets?.[m] ?? []) {
            const d = dm.get(symbol);
            const c = costsOf(m);
            const sp = d ? spreadOf(d, c.fallback_spread_bps) : null;
            if (!d?.c1?.length || !d.c15?.length || !sp) {
              sigOut.push({ symbol, decision: "blocked", quality: 0, side: null, reason: d?.error ?? "no_data", action: "none" });
              continue;
            }
            const setup = evaluateSetup({
              market: m, c1: d.c1, c15: d.c15, nowMs: now, spreadBps: sp.bps, spreadSource: sp.source, strat, costs: c,
              allowShort: cfg.allow_short?.[m] === true, maxLagS: cfg.data?.max_lag_s?.[m] ?? DEFAULT_MAX_LAG_S[m], maxGapMin: m === "crypto" ? 0 : 2,
            });
            cands.push({ symbol, market: m, setup, candleMs: d.c1[d.c1.length - 1].ts, sp, d });
          }
        }
        cands.sort((x, y) => y.setup.quality - x.setup.quality);

        let openCount = stillOpen.length;
        const openSyms = new Set<string>(stillOpen.map((p) => p.symbol));
        const logSignal = async (c: Cand, decision: string, reason: string | null, forced = false) => {
          const key = `${c.symbol}:${c.candleMs}`;
          if (seen.has(key) && !forced) return;
          seen.add(key);
          await tx`insert into agent_core.signals (agent_id, market, symbol, candle_time, side, quality, decision, reason, features)
                   values (${a.id}, ${c.market}, ${c.symbol}, ${iso(c.candleMs)}, ${c.setup.side}, ${c.setup.quality}, ${decision}, ${reason},
                           ${tx.json({ ...c.setup.features, parts: c.setup.parts, gate_reasons: c.setup.reasons } as any)})`;
        };

        const tryOpen = async (c: Cand, forced: boolean): Promise<string> => {
          if (!canTrade) return `skipped:${killSwitch ? "kill_switch" : a.status === "halted" || haltedNow ? "halted" : "agent_not_active"}`;
          if (!marketOn(c.market)) return "skipped:market_disabled";
          if (!forced) {
            if (heldMarkets.has(c.market)) return "skipped:news_hold";
            if (rt.realized <= dailyLimit) return "skipped:daily_loss_limit";
            if (streakHit) return "skipped:loss_streak_pause";
            if (cooling(c.symbol)) return "skipped:cooldown_after_stop";
          }
          if (openSyms.has(c.symbol)) return "skipped:position_open";
          if (openCount >= (risk.max_positions ?? 3)) return "skipped:max_positions";
          const side: Side | null = forced ? (forceEntry?.side ?? c.setup.side ?? "long") : c.setup.side;
          if (!side) return "skipped:no_side";
          const setupK = setupKey(c.symbol, side, now);
          if (!forced) {
            const [ok] = await tx`select agent_core.fn_lesson_allows(${a.id}::uuid, ${setupK}) as ok`;
            if (!ok.ok) return "skipped:lesson_blocked";
          }
          const cc = costsOf(c.market);
          const fill = entryFill(side, c.sp.bid, c.sp.ask, cc.slip_bps);
          const plan = c.setup.plan;
          const stopDist = plan?.stopDist ?? fill * 0.003;
          const tpDist = plan?.tpDist ?? stopDist * (strat.rr ?? 2);
          const size = sizeQty({ equity, cash, price: fill, stopDist, riskPct: risk.risk_per_trade_pct ?? 1, maxPositionPct: risk.max_position_pct ?? 25, minNotional: risk.min_notional_usd ?? 10 });
          if ("reason" in size) return `skipped:size_${size.reason}`;
          const notional = fill * size.qty;
          const fee = (notional * cc.fee_bps) / 1e4;
          if (notional + fee > cash) return "skipped:insufficient_cash";
          const sl = side === "long" ? fill - stopDist : fill + stopDist;
          const tp = side === "long" ? fill + tpDist : fill - tpDist;
          const [row] = await tx`
            insert into agent_core.positions (agent_id, market, symbol, side, qty, entry_price, entry_fee, entry_notional, sl_price, tp_price, risk_usd, quality, setup_key, features, note)
            values (${a.id}, ${c.market}, ${c.symbol}, ${side}, ${size.qty}, ${fill}, ${fee}, ${notional}, ${sl}, ${tp}, ${stopDist * size.qty}, ${c.setup.quality}, ${setupK},
                    ${tx.json({ ...c.setup.features, parts: c.setup.parts, size_limit: size.limit, forced } as any)}, ${forced ? "rehearsal_forced" : null})
            returning id::int as id`;
          cash -= notional + fee;
          equity -= fee; // the entry fee is gone immediately; the reserved notional stays part of equity
          openCount++;
          openSyms.add(c.symbol);
          const p = { id: row.id, agent_id: a.id, market: c.market, symbol: c.symbol, side, qty: size.qty, entry_price: fill, entry_fee: fee, entry_notional: notional, risk_usd: stopDist * size.qty };
          openedNow.push(p);
          await notify("trade_opened", `${c.symbol} ${side} eröffnet`, `Qualität ${c.setup.quality}, Einstieg ${fill.toPrecision(7)}, Stop ${sl.toPrecision(7)}, Ziel ${tp.toPrecision(7)}, Größe ${r2(notional)} USD`, {
            symbol: c.symbol, side, entry: fill, sl, tp, notional, quality: c.setup.quality,
          });
          return "opened";
        };

        for (const c of cands) {
          const forced = forceEntry?.symbol === c.symbol;
          const already = seen.has(`${c.symbol}:${c.candleMs}`);
          let action = "none";
          let decision = c.setup.decision === "blocked" ? "blocked" : c.setup.decision === "entry_signal" ? "entry" : "no_signal";
          let reason: string | null = c.setup.reasons.join("; ") || null;
          if (forced || (!already && c.setup.decision === "entry_signal")) {
            action = await tryOpen(c, forced);
            if (action !== "opened") { decision = "skipped"; reason = action; }
          }
          await logSignal(c, decision, reason, forced);
          sigOut.push({ symbol: c.symbol, decision, quality: c.setup.quality, side: c.setup.side, reason, action: already && !forced ? "already_processed" : action, features: c.setup.features });
        }

        // rehearsal only: close what was just opened to exercise the exit path (also rolled back)
        if (forceExit) {
          for (const p of openedNow) {
            const d = dm.get(p.symbol)!;
            const sp = spreadOf(d, costsOf(p.market).fallback_spread_bps)!;
            await closePos({ ...p, entry_ms: now }, sp.mid, sp.bps, "rehearsal_exit", false);
          }
        }

        // 2e. snapshot, state, replication
        const openFinal = [...stillOpen, ...openedNow.filter((p) => !closedNow.some((c) => c.id === p.id))];
        equity = cash + openFinal.reduce((s, p) => s + positionValue(p.side, p.entry_notional, p.entry_price, p.qty, mark(p)), 0);
        const peak2 = Math.max(peak, equity);
        const dd2 = peak2 > 0 ? ((peak2 - equity) / peak2) * 100 : 0;
        const [rt2] = await tx`
          select coalesce(sum(pnl_usd), 0)::float8 as realized from agent_core.positions
          where agent_id = ${a.id} and status = 'closed' and exit_time >= ${iso(dayStart)}`;
        if (new Date(now).getUTCMinutes() % 5 === 0 || closedNow.length || openedNow.length) {
          await tx`insert into agent_core.equity_snapshots (agent_id, equity, cash, open_positions, day_pnl, drawdown_pct)
                   values (${a.id}, ${equity}, ${cash}, ${openFinal.length}, ${rt2.realized}, ${dd2})`;
        }
        await tx`update agent_core.agents set cash = ${cash}, state = state || ${tx.json({ peak_equity: peak2, last_tick_at: iso(now) } as any)}::jsonb where id = ${a.id}`;
        let replication: string | null = null;
        if (closedNow.some((c) => c.pnl_usd > 0) && a.status === "active") {
          const [rp] = await tx`select agent_core.fn_check_replication(${a.id}::uuid) as res`;
          replication = rp.res;
        }

        out.push({
          agent: a.name, status: haltedNow ? "halted" : a.status, trading_allowed: canTrade,
          equity: r2(equity), cash: r2(cash), drawdown_pct: r2(dd2), realized_today_usd: r2(rt2.realized),
          open_positions: openFinal.length, opened: openedNow.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry_price })),
          closed: closedNow, signals: sigOut, replication,
          gates: { news_hold: [...heldMarkets], daily_loss_hit: rt.realized <= dailyLimit, loss_streak_pause: streakHit },
        });
      }

      const result = {
        status: "ok",
        rehearsal,
        region,
        kill_switch: st.kill_switch === true,
        agents: out,
        data: data.map((d) => ({
          symbol: d.spec.symbol, source: d.spec.source, error: d.error, latency_ms: d.latencyMs, lag_s: lagOf(d) === null ? null : Math.round(lagOf(d)!),
          c1: d.c1?.length ?? 0, c15: d.c15?.length ?? 0, bid: d.bid, ask: d.ask,
        })),
      };
      if (rehearsal) throw new Rollback(result);
      return result;
    });
  } catch (e) {
    if (e instanceof Rollback) return e.result;
    throw e;
  }
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
    if (body?.selftest === true) return json(selftest());
    return json(await tick(sql, body));
  } catch (e) {
    console.error("agent-tick failed", e);
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
