// Synthetic bybit-view responses (rendering tests only). Shapes follow supabase/functions/bybit-view/index.ts.
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60000;

function base() {
  return {
    now: new Date().toISOString(),
    config: { enabled: true, enabled_since: iso(30 * 3600 * 1000), last_reconcile_at: iso(12000), last_error: null, max_entry_age_s: 180 },
    settings: { paper_only: true, kill_switch: false },
    wallet: { ts: iso(60000), total_equity_usd: 179154.96, coins: [
      { coin: "USDC", wallet: 50000, equity: 50000, usd: 49985.85 }, { coin: "BTC", wallet: 1.00000148, equity: 1.00000148, usd: 76968.02 },
      { coin: "ETH", wallet: 1.00001207, equity: 1.00001207, usd: 2253.22 }, { coin: "USDT", wallet: 50023.0496, equity: 50023.0496, usd: 49947.86 }] },
    history: [],
    orders: [
      { id: 10, position_id: 90, leg: "in", symbol: "SOLUSDT", side: "Buy", status: "error", note: "http=200 retCode=170131 Insufficient balance", attempts: 1, req_qty: 10, fill_qty: null, fill_price: null, paper_price: 150.12, slip_bps: null, fee_quote: null, fee_base: null, created_at: iso(70 * MIN), updated_at: iso(70 * MIN), agent: "Agent Alpha" },
      { id: 9, position_id: 85, leg: "out", symbol: "ETHUSDT", side: "Sell", status: "filled", note: null, attempts: 1, req_qty: 1.05164, fill_qty: 1.05164, fill_price: 2272.46, paper_price: 2276.9, slip_bps: 19.5, fee_quote: 2.39, fee_base: 0, created_at: iso(500 * MIN), updated_at: iso(500 * MIN), agent: "Agent Alpha" },
      { id: 8, position_id: 85, leg: "in", symbol: "ETHUSDT", side: "Buy", status: "filled", note: null, attempts: 1, req_qty: 1.0527, fill_qty: 1.0527, fill_price: 2289.72, paper_price: 2289.54, slip_bps: 0.8, fee_quote: 0, fee_base: 0.0010527, created_at: iso(620 * MIN), updated_at: iso(620 * MIN), agent: "Agent Alpha" }],
    pairs: [
      { position_id: 85, symbol: "ETHUSDT", agent: "Agent Alpha", opened_at: iso(620 * MIN), closed_at: iso(500 * MIN), buy_price: 2289.72, sell_price: 2272.46, qty_in: 1.0527, qty_out: 1.05164, net_usd: -22.95, fees_usd: 4.8, paper_net_usd: -18.11, slip_in_bps: 0.8, slip_out_bps: 19.5, close_reason: "stop" },
      { position_id: 83, symbol: "ETHUSDT", agent: "Agent Alpha", opened_at: iso(700 * MIN), closed_at: iso(650 * MIN), buy_price: 2286.55, sell_price: 2278.05, qty_in: 1.05523, qty_out: 1.05417, net_usd: -13.77, fees_usd: 4.81, paper_net_usd: -15.49, slip_in_bps: -5.5, slip_out_bps: -1.6, close_reason: "stop" }],
    open: [{ position_id: 91, symbol: "BTCUSDT", agent: "Agent Alpha", opened_at: iso(5 * MIN), buy_price: 76950.1, qty: 0.0312, sl_price: 76500, tp_price: 77800 }],
    stats: { pairs: 2, wins: 0, net_usd: -36.72, paper_net_usd: -33.6, fees_usd: 9.61, avg_slip_bps: 3.3, open: 1, counts: [{ status: "filled", n: 3 }, { status: "error", n: 1 }] },
  };
}

function off() {
  const d = base();
  d.config.enabled = false;
  d.open = []; d.stats.open = 0;
  return d;
}

module.exports = { base, off };
