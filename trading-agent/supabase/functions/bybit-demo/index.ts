// bybit-demo: mirrors the paper agent's crypto trades onto the Bybit DEMO account (play money, spot, no leverage).
// SIMULATION ONLY. The host is hard-coded to https://api-demo.bybit.com in bybit.ts. Orders are only sent when
//   agent_core.exchange_config.enabled = true  AND  agent_core.settings.paper_only = true.
// The paper engine (agent-tick) stays the book of record; this function only copies its decisions and records the real demo fills.
// Auth: shared secret in header x-agent-secret (Supabase Vault secret agent_cron_secret); verify_jwt is off.
// Keys: Vault secrets bybit_demo_api_key / bybit_demo_api_secret (fallback: Edge Function secrets BYBIT_DEMO_API_KEY / _SECRET). Never returned or logged.
// Actions (JSON body): selftest | status | reconcile | fund | smoke (needs confirm:true)
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { aggregateFills, bpsDiff, BASE, floorToStep, hmacHex, type Keys, publicGet, signedRequest } from "./bybit.ts";

const SYMBOLS: Record<string, { base: string; quote: string }> = {
  BTCUSDT: { base: "BTC", quote: "USDT" },
  ETHUSDT: { base: "ETH", quote: "USDT" },
  SOLUSDT: { base: "SOL", quote: "USDT" },
};
const LOCK_KEY = 738201;
const MAX_EXIT_ATTEMPTS = 5;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
async function getKeys(sql: any): Promise<Keys | null> {
  let key: string | undefined, secret: string | undefined;
  try {
    const rows = await sql`select name, decrypted_secret from vault.decrypted_secrets where name in ('bybit_demo_api_key', 'bybit_demo_api_secret')`;
    for (const r of rows) {
      if (r.name === "bybit_demo_api_key") key = r.decrypted_secret?.trim();
      if (r.name === "bybit_demo_api_secret") secret = r.decrypted_secret?.trim();
    }
  } catch { /* fall back to the environment */ }
  // Vault first (key + secret); the Edge Function secrets are only the fallback
  if (!key && !secret) {
    key = Deno.env.get("BYBIT_DEMO_API_KEY")?.trim();
    secret = Deno.env.get("BYBIT_DEMO_API_SECRET")?.trim();
  } else if (!key) {
    key = Deno.env.get("BYBIT_DEMO_API_KEY")?.trim(); // legacy setup: key in the Edge secrets, secret in the Vault
  }
  return key && secret ? { key, secret } : null;
}

type Inst = { symbol: string; base: string; quote: string; basePrecision: string; minOrderQty: number; minOrderAmt: number; status: string };
const instCache = new Map<string, Inst>();
async function instrument(symbol: string): Promise<Inst | { error: string }> {
  if (instCache.has(symbol)) return instCache.get(symbol)!;
  const meta = SYMBOLS[symbol];
  if (!meta) return { error: "symbol not allowed" };
  const r = await publicGet("/v5/market/instruments-info", { category: "spot", symbol }, BASE);
  const it = r.body?.result?.list?.[0];
  if (r.http !== 200 || r.body?.retCode !== 0 || !it) return { error: `instruments-info http=${r.http} retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`.trim() };
  const inst: Inst = {
    symbol, base: it.baseCoin ?? meta.base, quote: it.quoteCoin ?? meta.quote, basePrecision: String(it.lotSizeFilter?.basePrecision ?? "0.000001"),
    minOrderQty: Number(it.lotSizeFilter?.minOrderQty ?? 0), minOrderAmt: Number(it.lotSizeFilter?.minOrderAmt ?? 5), status: String(it.status ?? ""),
  };
  instCache.set(symbol, inst);
  return inst;
}

async function fetchFills(keys: Keys, orderId: string, inst: Inst) {
  const r = await signedRequest(keys, "GET", "/v5/execution/list", { category: "spot", orderId, limit: "100" });
  if (r.http !== 200 || r.body?.retCode !== 0) return { error: `execution/list http=${r.http} retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`.trim(), raw: r.body };
  return { fills: aggregateFills(r.body?.result?.list ?? [], inst.base, inst.quote), raw: r.body?.result?.list ?? [] };
}

async function lookupOrder(keys: Keys, linkId: string): Promise<{ orderId: string; status: string } | null> {
  for (const path of ["/v5/order/history", "/v5/order/realtime"]) {
    const r = await signedRequest(keys, "GET", path, { category: "spot", orderLinkId: linkId });
    const o = r.body?.result?.list?.[0];
    if (r.http === 200 && r.body?.retCode === 0 && o?.orderId) return { orderId: String(o.orderId), status: String(o.orderStatus ?? "") };
  }
  return null;
}

async function notify(sql: any, agentId: string | null, kind: string, title: string, body: string, payload: unknown) {
  await sql`insert into agent_core.notifications (kind, agent_id, title, body, payload) values (${kind}, ${agentId}, ${title}, ${body}, ${sql.json(payload as any)})`;
}

async function finalizeLeg(sql: any, row: { id: number; agent_id: string | null; symbol: string; leg: string; side: "Buy" | "Sell"; paper_price: number | null; req_qty: number }, f: ReturnType<typeof aggregateFills>, raw: unknown) {
  const slip = row.paper_price ? bpsDiff(f.price, row.paper_price, row.side) : null;
  const status = f.qty >= row.req_qty * 0.99 ? "filled" : "partial";
  await sql`update agent_core.exchange_orders set status = ${status}, fill_qty = ${f.qty}, fill_price = ${f.price}, fill_value = ${f.value}, fee_base = ${f.feeBase}, fee_quote = ${f.feeQuote},
            net_base_qty = ${f.netBase}, slip_bps_vs_paper = ${slip}, raw = ${sql.json({ fills: raw } as any)}, note = null, updated_at = now() where id = ${row.id}`;
  await notify(sql, row.agent_id, "exchange_fill", `${row.symbol} ${row.side === "Buy" ? "Kauf" : "Verkauf"} auf Bybit-Demo ${status === "filled" ? "ausgeführt" : "teilweise ausgeführt"}`,
    `Preis ${f.price.toPrecision(7)}${row.paper_price ? ` (Papier ${row.paper_price.toPrecision(7)}, Abweichung ${slip === null ? "?" : r2(slip)} bp)` : ""}, Menge ${f.qty}, Gebühr ${f.feeBase > 0 ? f.feeBase + " " + SYMBOLS[row.symbol].base : f.feeQuote + " " + SYMBOLS[row.symbol].quote}`,
    { symbol: row.symbol, leg: row.leg, side: row.side, fill_price: f.price, qty: f.qty, slip_bps_vs_paper: slip, demo: true });
}

// one market order on the demo account, recorded in exchange_orders before and after
async function sendLeg(sql: any, keys: Keys, a: { positionId: number; agentId: string; symbol: string; leg: "in" | "out"; side: "Buy" | "Sell"; qty: string; paperPrice: number | null }, inst: Inst) {
  const [row] = await sql`
    insert into agent_core.exchange_orders (position_id, leg, symbol, side, order_link_id, status, attempts, req_qty, paper_price)
    values (${a.positionId}, ${a.leg}, ${a.symbol}, ${a.side}, ${`ag${a.positionId}${a.leg}1`}, 'sending', 1, ${a.qty}, ${a.paperPrice})
    on conflict (position_id, leg) do update set status = 'sending', attempts = agent_core.exchange_orders.attempts + 1,
      order_link_id = ${`ag${a.positionId}${a.leg}`} || (agent_core.exchange_orders.attempts + 1)::text, req_qty = ${a.qty}, updated_at = now(), note = null
      where agent_core.exchange_orders.status = 'error'
    returning id::int as id, order_link_id`;
  if (!row) return { status: "not_retried" };
  const ctx = { id: row.id, agent_id: a.agentId, symbol: a.symbol, leg: a.leg, side: a.side, paper_price: a.paperPrice, req_qty: Number(a.qty) };
  let r;
  try {
    r = await signedRequest(keys, "POST", "/v5/order/create", {
      category: "spot", symbol: a.symbol, side: a.side, orderType: "Market", qty: a.qty, marketUnit: "baseCoin", orderLinkId: row.order_link_id,
    });
  } catch (e) {
    // outcome unknown (timeout): the row stays 'sending'; the recovery pass looks the order up by its link id
    await sql`update agent_core.exchange_orders set note = ${"request_exception: " + msg(e).slice(0, 200)}, updated_at = now() where id = ${row.id}`;
    return { status: "unknown" };
  }
  if (r.http !== 200 || r.body?.retCode !== 0 || !r.body?.result?.orderId) {
    const note = `http=${r.http} retCode=${r.body?.retCode} ${String(r.body?.retMsg ?? "").slice(0, 200)}`;
    await sql`update agent_core.exchange_orders set status = 'error', note = ${note}, raw = ${sql.json({ response: r.body } as any)}, updated_at = now() where id = ${row.id}`;
    await notify(sql, a.agentId, "exchange_error", `${a.symbol} ${a.side === "Buy" ? "Kauf" : "Verkauf"} auf Bybit-Demo abgelehnt`, note, { symbol: a.symbol, leg: a.leg, note, demo: true });
    return { status: "error", note };
  }
  const orderId = String(r.body.result.orderId);
  await sql`update agent_core.exchange_orders set bybit_order_id = ${orderId}, updated_at = now() where id = ${row.id}`;
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    const f = await fetchFills(keys, orderId, inst);
    if ("fills" in f && f.fills.qty > 0) {
      await finalizeLeg(sql, ctx, f.fills, f.raw);
      return { status: "filled", price: f.fills.price, qty: f.fills.qty };
    }
  }
  return { status: "sent_fills_pending", orderId };
}

async function recover(sql: any, keys: Keys) {
  const rows = await sql`
    select o.id::int as id, o.leg, o.symbol, o.side, o.order_link_id, o.bybit_order_id, o.req_qty::float8 as req_qty, o.paper_price::float8 as paper_price,
           p.agent_id, extract(epoch from now() - o.updated_at)::float8 as age_s
    from agent_core.exchange_orders o join agent_core.positions p on p.id = o.position_id
    where o.status = 'sending' and o.updated_at < now() - interval '20 seconds'`;
  const out: any[] = [];
  for (const o of rows) {
    const inst = await instrument(o.symbol);
    if ("error" in inst) { out.push({ id: o.id, error: inst.error }); continue; }
    let orderId: string | null = o.bybit_order_id;
    if (!orderId) {
      const found = await lookupOrder(keys, o.order_link_id);
      orderId = found?.orderId ?? null;
      if (orderId) await sql`update agent_core.exchange_orders set bybit_order_id = ${orderId} where id = ${o.id}`;
    }
    if (!orderId) {
      await sql`update agent_core.exchange_orders set status = 'error', note = 'order not found at Bybit after interruption', updated_at = now() where id = ${o.id}`;
      out.push({ id: o.id, result: "not_sent" });
      continue;
    }
    const f = await fetchFills(keys, orderId, inst);
    if ("fills" in f && f.fills.qty > 0) {
      await finalizeLeg(sql, { id: o.id, agent_id: o.agent_id, symbol: o.symbol, leg: o.leg, side: o.side, paper_price: o.paper_price, req_qty: o.req_qty }, f.fills, f.raw);
      out.push({ id: o.id, result: "recovered" });
    } else if (o.age_s > 300) {
      await sql`update agent_core.exchange_orders set status = 'error', note = 'no fills found after 5 minutes', updated_at = now() where id = ${o.id}`;
      out.push({ id: o.id, result: "no_fills" });
    }
  }
  return out;
}

async function reconcile(sql: any, keys: Keys | null) {
  const [lock] = await sql`select pg_try_advisory_lock(${LOCK_KEY}) as got`;
  if (!lock.got) return { status: "skipped_locked" };
  try {
    const [cfg] = await sql`select enabled, enabled_since, max_entry_age_s from agent_core.exchange_config where id`;
    const [st] = await sql`select paper_only, kill_switch from agent_core.settings where id`;
    if (!cfg?.enabled) return { status: "disabled" };
    if (st?.paper_only !== true) return { status: "refused_not_paper_only" };
    if (!keys) {
      await sql`update agent_core.exchange_config set last_reconcile_at = now(), last_error = 'no demo API keys set', updated_at = now() where id`;
      return { status: "no_keys" };
    }
    if (!cfg.enabled_since) await sql`update agent_core.exchange_config set enabled_since = now() where id`;
    const since = cfg.enabled_since ?? new Date();
    const out: any = { status: "ok", recovered: [], exits: [], entries: [] };

    out.recovered = await recover(sql, keys);

    // 1. exits first: the paper position is closed, the demo position (if it was entered) must be sold
    const exits = await sql`
      select o.position_id::int as pid, o.symbol, o.net_base_qty::float8 as net_base, p.agent_id, p.exit_price::float8 as paper_exit
      from agent_core.exchange_orders o
      join agent_core.positions p on p.id = o.position_id
      left join agent_core.exchange_orders x on x.position_id = o.position_id and x.leg = 'out'
      where o.leg = 'in' and o.status in ('filled', 'partial') and p.status = 'closed'
        and (x.id is null or (x.status = 'error' and x.attempts < ${MAX_EXIT_ATTEMPTS}))
      order by o.position_id`;
    for (const e of exits) {
      const inst = await instrument(e.symbol);
      if ("error" in inst) { out.exits.push({ pid: e.pid, error: inst.error }); continue; }
      const qty = floorToStep(e.net_base, inst.basePrecision);
      if (Number(qty) < inst.minOrderQty || Number(qty) * (e.paper_exit ?? 0) < inst.minOrderAmt) {
        await sql`insert into agent_core.exchange_orders (position_id, leg, symbol, side, order_link_id, status, note, req_qty)
                  values (${e.pid}, 'out', ${e.symbol}, 'Sell', ${`ag${e.pid}out-dust`}, 'skipped', 'below exchange minimum (dust)', ${qty}) on conflict (position_id, leg) do nothing`;
        out.exits.push({ pid: e.pid, result: "dust_skipped" });
        continue;
      }
      out.exits.push({ pid: e.pid, symbol: e.symbol, ...(await sendLeg(sql, keys, { positionId: e.pid, agentId: e.agent_id, symbol: e.symbol, leg: "out", side: "Sell", qty, paperPrice: e.paper_exit }, inst)) });
    }

    // 2. entries: open paper positions (crypto, long) opened after the mirror was switched on and not yet mirrored
    const entries = await sql`
      select p.id::int as pid, p.agent_id, p.symbol, p.side, p.qty::float8 as qty, p.entry_price::float8 as paper_entry, extract(epoch from now() - p.entry_time)::float8 as age_s
      from agent_core.positions p
      where p.market = 'crypto' and p.status = 'open' and p.entry_time >= ${since}
        and not exists (select 1 from agent_core.exchange_orders o where o.position_id = p.id and o.leg = 'in')
      order by p.id`;
    const skip = async (pid: number, symbol: string, why: string) => {
      await sql`insert into agent_core.exchange_orders (position_id, leg, symbol, side, order_link_id, status, note)
                values (${pid}, 'in', ${symbol}, 'Buy', ${`ag${pid}in-skip`}, 'skipped', ${why}) on conflict (position_id, leg) do nothing`;
      out.entries.push({ pid, result: "skipped", why });
    };
    for (const p of entries) {
      if (p.side !== "long") { await skip(p.pid, p.symbol, "short not possible on spot"); continue; }
      if (st.kill_switch === true) { await skip(p.pid, p.symbol, "kill switch"); continue; }
      if (p.age_s > (cfg.max_entry_age_s ?? 180)) { await skip(p.pid, p.symbol, `stale: paper position is ${Math.round(p.age_s)} s old`); continue; }
      const inst = await instrument(p.symbol);
      if ("error" in inst) { out.entries.push({ pid: p.pid, error: inst.error }); continue; }
      if (inst.status && inst.status !== "Trading") { await skip(p.pid, p.symbol, `instrument status ${inst.status}`); continue; }
      const qty = floorToStep(p.qty, inst.basePrecision);
      if (Number(qty) < inst.minOrderQty || Number(qty) * p.paper_entry < inst.minOrderAmt) { await skip(p.pid, p.symbol, "below exchange minimum"); continue; }
      out.entries.push({ pid: p.pid, symbol: p.symbol, ...(await sendLeg(sql, keys, { positionId: p.pid, agentId: p.agent_id, symbol: p.symbol, leg: "in", side: "Buy", qty, paperPrice: p.paper_entry }, inst)) });
    }
    try { out.wallet = (await snapshotWallet(sql, keys)).status; } catch { out.wallet = "snapshot_failed"; }
    await sql`update agent_core.exchange_config set last_reconcile_at = now(), last_error = null, updated_at = now() where id`;
    return out;
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`;
  }
}

async function wallet(keys: Keys) {
  const r = await signedRequest(keys, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
  if (r.http !== 200 || r.body?.retCode !== 0) return { error: `wallet-balance http=${r.http} retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`.trim() };
  const acct = r.body?.result?.list?.[0];
  const coins = (acct?.coin ?? []).map((c: any) => ({ coin: c.coin, wallet: Number(c.walletBalance), equity: Number(c.equity), usd: Number(c.usdValue) }));
  return { account_type: acct?.accountType, total_equity_usd: Number(acct?.totalEquity), coins };
}

// store a balance snapshot (at most one per 4 minutes unless forced) so the dashboard can show the demo account without holding any API key
async function snapshotWallet(sql: any, keys: Keys, force = false) {
  if (!force) {
    const [last] = await sql`select extract(epoch from now() - max(ts))::float8 as age_s from agent_core.exchange_wallet_snapshots`;
    if (last?.age_s !== null && last?.age_s !== undefined && last.age_s < 240) return { status: "fresh" };
  }
  const w = await wallet(keys);
  if ("error" in w) return { status: "wallet_error", error: w.error };
  await sql`insert into agent_core.exchange_wallet_snapshots (total_equity_usd, coins) values (${w.total_equity_usd}, ${sql.json(w.coins as any)})`;
  return { status: "stored", total_equity_usd: w.total_equity_usd };
}

// shape of the stored keys WITHOUT revealing them (length and character classes only)
function keyShape(keys: Keys | null) {
  if (!keys) return null;
  const alnum = (s: string) => /^[A-Za-z0-9]+$/.test(s);
  return {
    key_len: keys.key.length, key_alnum: alnum(keys.key), secret_len: keys.secret.length, secret_alnum: alnum(keys.secret),
    secret_has_space_or_quote: /[\s"'`]/.test(keys.secret), secret_looks_like_pem: keys.secret.includes("-----"), key_equals_secret: keys.key === keys.secret,
  };
}

async function selftest(keys: Keys | null) {
  const res: Record<string, unknown> = { demo_host: BASE, keys_present: keys !== null, key_shape: keyShape(keys) };
  const vec = await hmacHex("selftest-secret", "1700000000000" + "SELFTESTKEY" + "5000" + "category=spot&orderId=1");
  res.signature_vector_ok = vec === "a6d5537ad8c88ffcfa17e9b7a004dbc6ceaf6ddc7ccec0507a9e3464d243e6b8";
  try {
    const t = await publicGet("/v5/market/time", {}, BASE);
    const ms = Number(t.body?.time ?? 0);
    res.demo_time = { http: t.http, retCode: t.body?.retCode, skew_ms: ms ? Date.now() - ms : null, latency_ms: t.ms };
  } catch (e) { res.demo_time = { error: msg(e) }; }
  res.instruments = {};
  for (const s of Object.keys(SYMBOLS)) {
    try {
      const i = await instrument(s);
      (res.instruments as any)[s] = "error" in i ? i : { status: i.status, basePrecision: i.basePrecision, minOrderQty: i.minOrderQty, minOrderAmt: i.minOrderAmt };
    } catch (e) { (res.instruments as any)[s] = { error: msg(e) }; }
  }
  if (keys) {
    try {
      const k = await signedRequest(keys, "GET", "/v5/user/query-api", {});
      const x = k.body?.result;
      res.key_info = k.http === 200 && k.body?.retCode === 0
        ? { read_only: x?.readOnly, permissions: x?.permissions, ip_bound: Array.isArray(x?.ips) && x.ips.length > 0 && !x.ips.includes("*"), expires_at: x?.expiredAt || null }
        : { error: `http=${k.http} retCode=${k.body?.retCode} ${k.body?.retMsg ?? ""}`.trim() };
    } catch (e) { res.key_info = { error: msg(e) }; }
    try { res.wallet = await wallet(keys); } catch (e) { res.wallet = { error: msg(e) }; }
  }
  return res;
}

async function fund(keys: Keys, body: any) {
  const target = Math.min(Number(body?.target_usdt) || 10000, 100000);
  const w = await wallet(keys);
  if ("error" in w) return { status: "wallet_error", ...w };
  const usdt = (w.coins as any[]).find((c) => c.coin === "USDT")?.wallet ?? 0;
  if (usdt >= target) return { status: "enough", usdt };
  const add = Math.min(Math.ceil(target - usdt), 100000);
  const r = await signedRequest(keys, "POST", "/v5/account/demo-apply-money", { adjustType: 0, utaDemoApplyMoney: [{ coin: "USDT", amountStr: String(add) }] });
  return { status: r.body?.retCode === 0 ? "requested" : "rejected", usdt_before: usdt, requested: add, http: r.http, retCode: r.body?.retCode, retMsg: r.body?.retMsg };
}

// one tiny buy+sell round trip (about 20 USDT of play money) to prove that orders, fills and fees work end to end
async function smoke(keys: Keys, body: any) {
  if (body?.confirm !== true) return { error: "pass confirm:true to place a ~20 USDT demo round trip" };
  const symbol = "BTCUSDT";
  const inst = await instrument(symbol);
  if ("error" in inst) return inst;
  const tk = await publicGet("/v5/market/tickers", { category: "spot", symbol }, BASE);
  const t = tk.body?.result?.list?.[0];
  const ask = Number(t?.ask1Price), bid = Number(t?.bid1Price);
  if (!(ask > 0) || !(bid > 0)) return { error: "no ticker", http: tk.http, body: tk.body };
  const qtyBuy = floorToStep(20 / ask, inst.basePrecision);
  if (Number(qtyBuy) < inst.minOrderQty || Number(qtyBuy) * ask < inst.minOrderAmt) return { error: "20 USDT is below the exchange minimum", qtyBuy };
  const tag = Date.now().toString(36);
  const place = async (side: "Buy" | "Sell", qty: string) => {
    const r = await signedRequest(keys, "POST", "/v5/order/create", { category: "spot", symbol, side, orderType: "Market", qty, marketUnit: "baseCoin", orderLinkId: `smoke${tag}${side[0]}` });
    if (r.http !== 200 || r.body?.retCode !== 0) return { error: `http=${r.http} retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`.trim() };
    const orderId = String(r.body.result.orderId);
    let lastErr = "";
    for (let i = 0; i < 16; i++) {
      await sleep(750);
      const f = await fetchFills(keys, orderId, inst);
      if ("fills" in f && f.fills.qty > 0) return { orderId, fills: f.fills, rows: f.raw, polls: i + 1 };
      lastErr = "error" in f ? String(f.error) : "no rows yet";
    }
    return { orderId, error: `no fills visible after 12 s (${lastErr})` };
  };
  const buy = await place("Buy", qtyBuy);
  if ("error" in buy) return { step: "buy", ref: { ask, bid }, ...buy };
  const qtySell = floorToStep(buy.fills.netBase, inst.basePrecision);
  const sell = await place("Sell", qtySell);
  const out: any = {
    ref: { ask, bid }, buy: { price: buy.fills.price, qty: buy.fills.qty, fee_base: buy.fills.feeBase, fee_quote: buy.fills.feeQuote, slip_bps_vs_ask: r2(bpsDiff(buy.fills.price, ask, "Buy") ?? 0), sample_row: buy.rows?.[0] },
  };
  if ("error" in sell) return { step: "sell", ...out, sell_error: sell.error, left_over_base: qtySell };
  const feeUsd = buy.fills.feeBase * buy.fills.price + buy.fills.feeQuote + sell.fills.feeQuote + sell.fills.feeBase * sell.fills.price;
  const pnl = sell.fills.value - buy.fills.value - feeUsd;
  out.sell = { price: sell.fills.price, qty: sell.fills.qty, fee_base: sell.fills.feeBase, fee_quote: sell.fills.feeQuote, slip_bps_vs_bid: r2(bpsDiff(sell.fills.price, bid, "Sell") ?? 0), sample_row: sell.rows?.[0] };
  out.round_trip = { notional_usd: r2(buy.fills.value), fees_usd: Math.round(feeUsd * 10000) / 10000, pnl_usd: Math.round(pnl * 10000) / 10000, cost_bps: r2((-pnl / buy.fills.value) * 1e4) };
  return out;
}

// the last spot executions on the demo account (read only, no secrets)
async function executions(keys: Keys) {
  const r = await signedRequest(keys, "GET", "/v5/execution/list", { category: "spot", limit: "10" });
  if (r.http !== 200 || r.body?.retCode !== 0) return { error: `execution/list http=${r.http} retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`.trim() };
  return { rows: (r.body?.result?.list ?? []).map((e: any) => ({ time: new Date(Number(e.execTime)).toISOString(), symbol: e.symbol, side: e.side, qty: e.execQty, price: e.execPrice, fee: e.execFee, fee_ccy: e.feeCurrency, link: e.orderLinkId, order_id: e.orderId })) };
}

async function status(sql: any, keys: Keys | null) {
  const [cfg] = await sql`select enabled, enabled_since, max_entry_age_s, last_reconcile_at, last_error from agent_core.exchange_config where id`;
  const counts = await sql`select leg, status, count(*)::int as n from agent_core.exchange_orders group by leg, status order by leg, status`;
  const recent = await sql`select position_id::int as position_id, leg, symbol, side, status, note, fill_price::float8 as fill_price, paper_price::float8 as paper_price, slip_bps_vs_paper::float8 as slip_bps, attempts, created_at
                           from agent_core.exchange_orders order by id desc limit 10`;
  return { config: cfg, keys_present: keys !== null, counts, recent };
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
    const keys = await getKeys(sql);
    switch (body?.action) {
      case "selftest": return json(await selftest(keys));
      case "status": return json(await status(sql, keys));
      case "reconcile": return json(await reconcile(sql, keys));
      case "fund": return keys ? json(await fund(keys, body)) : json({ error: "no demo API keys set" }, 400);
      case "snapshot": return keys ? json(await snapshotWallet(sql, keys, true)) : json({ error: "no demo API keys set" }, 400);
      case "executions": return keys ? json(await executions(keys)) : json({ error: "no demo API keys set" }, 400);
      case "smoke": return keys ? json(await smoke(keys, body)) : json({ error: "no demo API keys set" }, 400);
      default: return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error("bybit-demo failed", e);
    try { await sql`update agent_core.exchange_config set last_error = ${msg(e).slice(0, 300)}, updated_at = now() where id`; } catch { /* best effort */ }
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
