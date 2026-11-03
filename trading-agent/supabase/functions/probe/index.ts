// probe: read-only data-source check for the paper-trading agent.
// Fetches public 1m candle data, records status/latency/lag in trading_sim.source_checks.
// Places no orders and touches nothing outside the trading_sim schema.
// Auth: custom shared secret (x-agent-secret) stored in Supabase Vault, because verify_jwt is off.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

type Market = "crypto" | "stocks" | "forex" | "metals";
type Outcome = {
  ok: boolean;
  http_status: number | null;
  last_closed_open_ms: number | null;
  has_volume: boolean | null;
  error: string | null;
};
type Check = { market: Market; source: string; symbol: string; run: () => Promise<Outcome> };

const CANDLE_MS = 60_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function get(url: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
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

const fail = (status: number | null, error: string): Outcome => ({
  ok: false,
  http_status: status,
  last_closed_open_ms: null,
  has_volume: null,
  error,
});

// Bybit v5 public kline. Rows: [startTime, open, high, low, close, volume, turnover], newest first.
async function bybit(category: "spot" | "linear", symbol: string): Promise<Outcome> {
  const r = await get(
    `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=1&limit=3`,
  );
  if (!r.ok) return fail(r.status, `HTTP ${r.status}: ${r.snippet}`);
  if (r.body?.retCode !== 0) return fail(r.status, `retCode=${r.body?.retCode} ${r.body?.retMsg ?? ""}`);
  const rows: string[][] = r.body?.result?.list ?? [];
  const now = Date.now();
  const closed = rows
    .map((row) => ({ start: Number(row[0]) }))
    .filter((c) => Number.isFinite(c.start) && c.start + CANDLE_MS <= now)
    .sort((a, b) => b.start - a.start)[0];
  if (!closed) return fail(r.status, "no closed candle in response");
  const hasVol = rows.some((row) => Number(row[5]) > 0);
  return { ok: true, http_status: r.status, last_closed_open_ms: closed.start, has_volume: hasVol, error: null };
}

// Yahoo chart endpoint (unofficial, no key). Used only as a candidate source for the probe.
async function yahoo(symbol: string): Promise<Outcome> {
  const r = await get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`,
    { "user-agent": "trading-sim-probe/0.1 (paper-trading research)" },
  );
  if (!r.ok) return fail(r.status, `HTTP ${r.status}: ${r.snippet}`);
  const res = r.body?.chart?.result?.[0];
  if (!res) return fail(r.status, `no result: ${r.body?.chart?.error?.description ?? "unknown"}`);
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const closes: (number | null)[] = q.close ?? [];
  const vols: (number | null)[] = q.volume ?? [];
  const now = Date.now();
  let idx = -1;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] != null && ts[i] * 1000 + CANDLE_MS <= now) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return fail(r.status, "no closed candle in response");
  const hasVol = vols.slice(Math.max(0, idx - 29), idx + 1).some((v) => v != null && v > 0);
  return { ok: true, http_status: r.status, last_closed_open_ms: ts[idx] * 1000, has_volume: hasVol, error: null };
}

const CRYPTO: Check[] = [
  { market: "crypto", source: "bybit_spot", symbol: "BTCUSDT", run: () => bybit("spot", "BTCUSDT") },
  { market: "crypto", source: "bybit_spot", symbol: "ETHUSDT", run: () => bybit("spot", "ETHUSDT") },
];

const y = (market: Market, source: string, symbol: string): Check => ({
  market,
  source,
  symbol,
  run: () => yahoo(symbol),
});

const OTHERS: Check[] = [
  y("forex", "yahoo_chart", "EURUSD=X"),
  y("forex", "yahoo_chart", "USDJPY=X"),
  y("forex", "yahoo_chart", "GBPUSD=X"),
  y("metals", "yahoo_chart", "XAUUSD=X"),
  y("metals", "yahoo_chart", "XAGUSD=X"),
  // Futures are NOT spot XAU/XAG: recorded only to see whether a proxy exists. Never used silently.
  y("metals", "yahoo_chart_futures_proxy", "GC=F"),
  y("metals", "yahoo_chart_futures_proxy", "SI=F"),
  y("stocks", "yahoo_chart", "AAPL"),
];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const provided = req.headers.get("x-agent-secret");
  if (!provided) return json({ error: "unauthorized" }, 401);

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    prepare: false,
  });
  try {
    const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret'`;
    if (!secret || !safeEqual(provided, secret.decrypted_secret)) return json({ error: "unauthorized" }, 401);

    const [cfg] = await sql`select probe_enabled from trading_sim.config where id`;
    if (!cfg?.probe_enabled) return json({ status: "probe_disabled" });

    const body = await req.json().catch(() => ({}));
    const group = body?.group ?? "all";
    const checks = group === "crypto" ? CRYPTO : group === "others" ? OTHERS : [...CRYPTO, ...OTHERS];
    const region = Deno.env.get("SB_REGION") ?? null;

    const rows = await Promise.all(checks.map(async (c) => {
      const t0 = performance.now();
      let o: Outcome;
      try {
        o = await c.run();
      } catch (e) {
        o = fail(null, `exception: ${e instanceof Error ? e.message : String(e)}`);
      }
      const latency = Math.round(performance.now() - t0);
      const lastOpen = o.last_closed_open_ms;
      return {
        market: c.market,
        source: c.source,
        symbol: c.symbol,
        ok: o.ok,
        http_status: o.http_status,
        latency_ms: latency,
        last_closed_candle_open: lastOpen ? new Date(lastOpen).toISOString() : null,
        lag_seconds: lastOpen ? Math.round((Date.now() - (lastOpen + CANDLE_MS)) / 100) / 10 : null,
        has_volume: o.has_volume,
        error: o.error ? o.error.slice(0, 300) : null,
        region,
      };
    }));

    await sql`insert into trading_sim.source_checks ${sql(rows)}`;

    return json({
      status: "ok",
      region,
      checked: rows.length,
      ok_count: rows.filter((r) => r.ok).length,
      results: rows.map((r) => ({
        market: r.market,
        symbol: r.symbol,
        ok: r.ok,
        http_status: r.http_status,
        lag_seconds: r.lag_seconds,
        error: r.error,
      })),
    });
  } catch (e) {
    console.error("probe failed", e);
    return json({ error: "internal" }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
