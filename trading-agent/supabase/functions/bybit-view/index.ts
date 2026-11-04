// bybit-view: read model (and one switch) for the Bybit DEMO page of the dashboard. SIMULATION ONLY: it holds no Bybit key and cannot place orders.
// Auth: header x-dashboard-token; its SHA-256 hash must equal the Vault secret dashboard_token_sha256 (same code as the dashboard). verify_jwt is off.
// Reads agent_core.exchange_config / exchange_orders / exchange_wallet_snapshots / positions. The only write: exchange_config.enabled (+ a 'control' notification).
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

const ALLOWED_ORIGINS = new Set(["https://derus13.github.io", "https://russki741.github.io"]);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function corsHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = {
    "access-control-allow-headers": "content-type, x-dashboard-token",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  const o = req.headers.get("origin");
  if (o && ALLOWED_ORIGINS.has(o)) h["access-control-allow-origin"] = o;
  return h;
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(req) } });
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function overview(sql: any) {
  const [cfg] = await sql`select enabled, enabled_since, last_reconcile_at, last_error, max_entry_age_s from agent_core.exchange_config where id`;
  const [st] = await sql`select paper_only, kill_switch, stats_since from agent_core.settings where id`;
  const [wallet] = await sql`select ts, total_equity_usd::float8 as total_equity_usd, coins from agent_core.exchange_wallet_snapshots order by ts desc limit 1`;
  const history = await sql`select ts, total_equity_usd::float8 as equity from (select ts, total_equity_usd from agent_core.exchange_wallet_snapshots order by ts desc limit 300) t order by ts`;

  const orders = await sql`
    select o.id::int as id, o.position_id::int as position_id, o.leg, o.symbol, o.side, o.status, o.note, o.attempts::int as attempts,
           o.req_qty::float8 as req_qty, o.fill_qty::float8 as fill_qty, o.fill_price::float8 as fill_price, o.paper_price::float8 as paper_price,
           o.slip_bps_vs_paper::float8 as slip_bps, o.fee_quote::float8 as fee_quote, o.fee_base::float8 as fee_base, o.created_at, o.updated_at, a.name as agent
    from agent_core.exchange_orders o
    join agent_core.positions p on p.id = o.position_id
    left join agent_core.agents a on a.id = p.agent_id
    where p.entry_time >= (select stats_since from agent_core.settings where id)
    order by o.id desc limit 60`;

  // finished round trips: bought and sold on the demo account. net = what the USDT balance really changed
  // (sold value + unsold remainder at the sell price - bought value - fees paid in USDT). Fees paid in the base coin are already inside the smaller sold quantity.
  const pairs = await sql`
    select i.position_id::int as position_id, i.symbol, a.name as agent, i.created_at as opened_at, o.updated_at as closed_at,
           i.fill_price::float8 as buy_price, o.fill_price::float8 as sell_price, i.fill_qty::float8 as qty_in, o.fill_qty::float8 as qty_out,
           (o.fill_value + greatest(0, coalesce(i.net_base_qty, 0) - o.fill_qty) * o.fill_price - i.fill_value - coalesce(i.fee_quote, 0) - coalesce(o.fee_quote, 0))::float8 as net_usd,
           (coalesce(i.fee_quote, 0) + coalesce(i.fee_base, 0) * i.fill_price + coalesce(o.fee_quote, 0) + coalesce(o.fee_base, 0) * o.fill_price)::float8 as fees_usd,
           p.pnl_usd::float8 as paper_net_usd, i.slip_bps_vs_paper::float8 as slip_in_bps, o.slip_bps_vs_paper::float8 as slip_out_bps, p.close_reason
    from agent_core.exchange_orders i
    join agent_core.exchange_orders o on o.position_id = i.position_id and o.leg = 'out' and o.status in ('filled', 'partial')
    join agent_core.positions p on p.id = i.position_id
    left join agent_core.agents a on a.id = p.agent_id
    where i.leg = 'in' and i.status in ('filled', 'partial') and p.entry_time >= (select stats_since from agent_core.settings where id)
    order by o.updated_at desc limit 100`;

  const open = await sql`
    select i.position_id::int as position_id, i.symbol, a.name as agent, i.created_at as opened_at, i.fill_price::float8 as buy_price, i.net_base_qty::float8 as qty,
           p.sl_price::float8 as sl_price, p.tp_price::float8 as tp_price
    from agent_core.exchange_orders i
    join agent_core.positions p on p.id = i.position_id
    left join agent_core.agents a on a.id = p.agent_id
    left join agent_core.exchange_orders o on o.position_id = i.position_id and o.leg = 'out'
    where i.leg = 'in' and i.status in ('filled', 'partial') and (o.id is null or o.status not in ('filled', 'partial', 'skipped'))
    order by i.created_at desc`;

  // statistics period as in dashboard-api: orders of positions opened before settings.stats_since are archive.
  // Open positions on the demo account are always listed, whatever their age, so nothing can be forgotten there.
  const counts = await sql`select o.status, count(*)::int as n from agent_core.exchange_orders o join agent_core.positions p on p.id = o.position_id
                           where p.entry_time >= (select stats_since from agent_core.settings where id) group by o.status order by o.status`;
  const [slip] = await sql`select avg(o.slip_bps_vs_paper)::float8 as avg_bps, count(o.slip_bps_vs_paper)::int as n from agent_core.exchange_orders o
                           join agent_core.positions p on p.id = o.position_id
                           where o.status in ('filled', 'partial') and p.entry_time >= (select stats_since from agent_core.settings where id)`;

  const n = pairs.length;
  const stats = {
    pairs: n,
    wins: pairs.filter((p: any) => p.net_usd > 0).length,
    net_usd: pairs.reduce((s: number, p: any) => s + p.net_usd, 0),
    paper_net_usd: pairs.reduce((s: number, p: any) => s + (p.paper_net_usd ?? 0), 0),
    fees_usd: pairs.reduce((s: number, p: any) => s + p.fees_usd, 0),
    avg_slip_bps: slip?.avg_bps ?? null,
    open: open.length,
    counts,
  };
  return { now: new Date().toISOString(), config: cfg, settings: st, wallet: wallet ?? null, history, orders, pairs, open, stats };
}

async function setEnabled(sql: any, body: any) {
  if (typeof body.enabled !== "boolean") return { status: 400, body: { error: "boolean required" } };
  const v: boolean = body.enabled;
  if (!v) {
    // never strand a position on the demo account: while the mirror is off nothing would be sold
    const [{ n }] = await sql`
      select count(*)::int as n from agent_core.exchange_orders i
      left join agent_core.exchange_orders o on o.position_id = i.position_id and o.leg = 'out'
      where i.leg = 'in' and i.status in ('filled', 'partial') and (o.id is null or o.status not in ('filled', 'partial', 'skipped'))`;
    if (n > 0) return { status: 409, body: { error: "open_positions", open: n } };
  }
  await sql`update agent_core.exchange_config
            set enabled = ${v}, enabled_since = case when ${v} and not enabled then now() else enabled_since end, updated_at = now() where id`;
  await sql`insert into agent_core.notifications (kind, title, body, payload)
            values ('control', ${v ? "Bybit-Demo Spiegeln eingeschaltet" : "Bybit-Demo Spiegeln ausgeschaltet"}, ${"Schalter auf der Bybit-Seite des Dashboards"}, ${sql.json({ enabled: v, demo: true })})`;
  return { status: 200, body: { ok: true, enabled: v } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method not allowed" }, 405);
  const token = req.headers.get("x-dashboard-token");
  if (!token || token.length < 20 || token.length > 200) return json(req, { error: "unauthorized" }, 401);

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'dashboard_token_sha256'`;
    if (!secret) return json(req, { error: "dashboard token not configured" }, 503);
    if (!safeEqual(await sha256hex(token), secret.decrypted_secret)) return json(req, { error: "unauthorized" }, 401);
    const raw = await req.text();
    if (raw.length > 2_000) return json(req, { error: "body too large" }, 413);
    let body: any = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(req, { error: "bad json" }, 400);
    }
    if (body.action === undefined || body.action === "overview") return json(req, await overview(sql));
    if (body.action === "set_enabled") {
      const r = await setEnabled(sql, body);
      return json(req, r.body, r.status);
    }
    return json(req, { error: "unknown action" }, 400);
  } catch (e) {
    console.error("bybit-view failed", e);
    return json(req, { error: "internal", detail: msg(e).slice(0, 200) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
