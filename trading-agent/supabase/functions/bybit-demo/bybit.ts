// Bybit DEMO client helpers. SIMULATION ONLY: the host is hard-coded to the demo environment.
// Nothing in this file can reach the live Bybit trading host.

export const BASE = "https://api-demo.bybit.com"; // demo trading only (Bybit "Demo Trading" account, play money)
export const PUBLIC_BASE = "https://api.bybit.com"; // public market data only, no key is ever sent there
export const RECV_WINDOW = "5000";

export type Keys = { key: string; secret: string };
export type ApiResult = { http: number; body: any; ms: number };

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Bybit V5 signature: HMAC_SHA256(secret, timestamp + apiKey + recvWindow + (queryString | jsonBody))
export async function signPayload(keys: Keys, timestamp: string, payload: string): Promise<string> {
  return hmacHex(keys.secret, timestamp + keys.key + RECV_WINDOW + payload);
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Public market data (no key, no signature). Demo host serves market endpoints too; we also read the public host for prices.
export async function publicGet(path: string, params: Record<string, string>, host = BASE): Promise<ApiResult> {
  const t0 = Date.now();
  const qs = new URLSearchParams(params).toString();
  const res = await timedFetch(`${host}${path}${qs ? "?" + qs : ""}`, { method: "GET" }, 10000);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { parseError: true, text: text.slice(0, 200) }; }
  return { http: res.status, body, ms: Date.now() - t0 };
}

// Signed request against the DEMO host only.
export async function signedRequest(keys: Keys, method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<ApiResult> {
  const t0 = Date.now();
  const ts = Date.now().toString();
  let url = BASE + path;
  const headers: Record<string, string> = { "X-BAPI-API-KEY": keys.key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": RECV_WINDOW };
  let payload: string;
  const init: RequestInit = { method };
  if (method === "GET") {
    payload = new URLSearchParams(params as Record<string, string>).toString();
    if (payload) url += "?" + payload;
  } else {
    payload = JSON.stringify(params);
    init.body = payload;
    headers["content-type"] = "application/json";
  }
  headers["X-BAPI-SIGN"] = await signPayload(keys, ts, payload);
  init.headers = headers;
  const res = await timedFetch(url, init, 10000);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { parseError: true, text: text.slice(0, 200) }; }
  // Bybit echoes the signing string (which contains the API key) in sign errors: never pass that on
  if (body && typeof body.retMsg === "string") body.retMsg = body.retMsg.replace(/origin_string\[[^\]]*\]/g, "origin_string[...]");
  return { http: res.status, body, ms: Date.now() - t0 };
}

// ---- number helpers ----

export function stepDecimals(step: string): number {
  const s = step.includes("e") ? Number(step).toFixed(12) : step;
  const i = s.indexOf(".");
  if (i < 0) return 0;
  return s.slice(i + 1).replace(/0+$/, "").length;
}

// floor qty to the exchange step ("0.000001"), returned as a plain decimal string
export function floorToStep(qty: number, step: string): string {
  const s = Number(step);
  if (!(s > 0) || !Number.isFinite(qty) || qty <= 0) return "0";
  const n = Math.floor(qty / s + 1e-9);
  return (n * s).toFixed(stepDecimals(step));
}

export type Fills = { qty: number; value: number; price: number; feeBase: number; feeQuote: number; feeOther: number; netBase: number; n: number };

// Aggregate execution rows of ONE spot order. A spot buy normally pays the fee in the base coin, which reduces what you can sell back.
export function aggregateFills(list: any[], baseCoin: string, quoteCoin: string): Fills {
  let qty = 0, value = 0, feeBase = 0, feeQuote = 0, feeOther = 0, n = 0;
  for (const e of list ?? []) {
    if (e?.execType && e.execType !== "Trade") continue;
    const q = Number(e.execQty), v = Number(e.execValue) || Number(e.execQty) * Number(e.execPrice), f = Number(e.execFee) || 0;
    if (!(q > 0) || !Number.isFinite(v)) continue;
    qty += q; value += v; n++;
    if (e.feeCurrency === baseCoin) feeBase += f;
    else if (e.feeCurrency === quoteCoin) feeQuote += f;
    else feeOther += f;
  }
  return { qty, value, price: qty > 0 ? value / qty : 0, feeBase, feeQuote, feeOther, netBase: Math.max(0, qty - feeBase), n };
}

export function bpsDiff(fill: number, ref: number, side: "Buy" | "Sell"): number | null {
  if (!(fill > 0) || !(ref > 0)) return null;
  const d = ((fill - ref) / ref) * 1e4;
  return side === "Buy" ? d : -d; // positive = worse than the paper price
}
