// Synthetic API responses shaped like dashboard-api's overview (for rendering tests only).
const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
function walk(n, start, vol) { const a = []; let v = start; for (let i = 0; i < n; i++) { v += (Math.sin(i / 5) + (Math.random() - 0.5)) * vol; a.push(v); } return a; }
const A1 = "11111111-1111-4111-8111-111111111111", A2 = "22222222-2222-4222-8222-222222222222";
const cfg = { markets: { crypto: ["BTCUSDT", "ETHUSDT", "SOLUSDT"], forex: ["EURUSD=X"] }, allow_short: { crypto: false, forex: true },
  strategy: { atr_stop_mult: 1.5, rr: 2, min_quality: 60, bands: { crypto: { atr_pct_min: 0.0008, atr_pct_max: 0.02 }, forex: { atr_pct_min: 0.0002, atr_pct_max: 0.004 } } },
  risk: { risk_per_trade_pct: 1, max_positions: 3, daily_loss_pct: 3, max_drawdown_pct: 10 }, costs: {} };
function assess(sym, q, dec, side, trend, reasons, price, extra) {
  return { evaluated_at: iso(now()), candle_time: iso(now() - 60000), decision: dec, side, quality: q, min_quality: 60, reasons,
    features: Object.assign({ price, trend, ema_fast_15m: price * 0.999, ema_slow_15m: price * 0.998, atr_15m: price * 0.002, atr_pct: 0.2, rsi_1m: 41.2, rsi_cross_bars_ago: null, pullback_atr: 0.6, spread_bps: 0.9, spread_source: "measured", cost_bps: 24.9, target_bps: 89.5, edge_multiple: 3.6, lag_s: 34 }, extra || {}),
    parts: { trend: 14, pullback: 20, trigger: 0, momentum: 10, volatility: 10, cost_edge: 7 }, last: { o: price, h: price * 1.0004, l: price * 0.9996, c: price, v: 12.3 }, bid: price * 0.9999, ask: price * 1.0001 };
}
function base(overrides) {
  const t = now();
  return Object.assign({
    server_time: iso(t),
    settings: { kill_switch: true, paper_only: true, markets_enabled: { crypto: false, forex: false }, max_agents: 3, replication_threshold_eur: 500, replication_requires_approval: true, eurusd_rate: 1.12, eurusd_rate_at: iso(t - 3600000) },
    agents: [], open_positions: [], closed_trades: [], signals: [], equity_curve: [], lessons: [], replication_events: [],
    data_status: [
      { symbol: "BTCUSDT", market: "crypto", source: "bybit_spot", ok: true, last_attempt_at: iso(t - 23000), last_ok_at: iso(t - 23000), last_candle_open: iso(t - 80000), lag_seconds: 1.2, has_volume: true, error: null, assessment: assess("BTCUSDT", 59, "no_signal", "short", "down", ["short_not_allowed", "no_rsi_trigger", "cost_gate(target 55.7bps < 3x cost 24.0bps)", "quality_below_min(59<60)"], 80888.4) },
      { symbol: "ETHUSDT", market: "crypto", source: "bybit_spot", ok: true, last_attempt_at: iso(t - 23000), last_ok_at: iso(t - 23000), last_candle_open: iso(t - 80000), lag_seconds: 1.2, has_volume: true, error: null, assessment: assess("ETHUSDT", 72, "entry_signal", "long", "up", [], 2380.22, { rsi_cross_bars_ago: 1, rsi_1m: 52.4 }) },
      { symbol: "SOLUSDT", market: "crypto", source: "bybit_spot", ok: true, last_attempt_at: iso(t - 23000), last_ok_at: iso(t - 23000), last_candle_open: iso(t - 80000), lag_seconds: 1.2, has_volume: true, error: null, assessment: assess("SOLUSDT", 66, "no_signal", "short", "down", ["short_not_allowed", "no_rsi_trigger"], 102.56) },
      { symbol: "EURUSD=X", market: "forex", source: "yahoo_chart", ok: false, last_attempt_at: iso(t - 23000), last_ok_at: iso(t - 3 * 86400000), last_candle_open: iso(t - 24400000), lag_seconds: 24421.2, has_volume: false, error: "stale: newest closed candle is 24421 s old (limit 300 s)", assessment: Object.assign(assess("EURUSD=X", 0, "blocked", null, null, ["stale_data"], 1.1204), { features: { lag_s: 24454 }, bid: null, ask: null, parts: {} }) },
    ],
    spark: { BTCUSDT: walk(60, 80900, 12), ETHUSDT: walk(60, 2380, 1.2), SOLUSDT: walk(60, 102.5, 0.08) },
    news: [], news_sources: [
      { source: "fed", ok: true, last_ok_at: iso(t - 120000), last_attempt_at: iso(t - 120000), items_seen: 20, items_new: 0, error: null },
      { source: "google_macro", ok: false, last_ok_at: null, last_attempt_at: iso(t - 120000), items_seen: 0, items_new: 0, error: "HTTP 503" } ],
    notifications: [],
  }, overrides || {});
}
function empty() {
  return base({ agents: [{ id: A1, name: "Agent Alpha", parent_id: null, generation: 1, status: "stopped", halted_reason: null, capital_start: 10000, cash: 10000, equity: 10000, open_positions: 0, drawdown_pct: 0, started_at: null, last_tick_at: null,
    stats: { trades: 0, wins: 0, pnl: 0, pnl_today: 0, avg_r: 0, gross_win: 0, gross_loss: 0, win_rate: null, profit_factor: null }, config: cfg }] });
}
function busy() {
  const t = now();
  const eq = (id, start, step) => Array.from({ length: 120 }, (_, i) => ({ agent_id: id, t: t - (120 - i) * 12 * 60000, e: start + Math.sin(i / 9) * 40 + i * step }));
  const d = base({
    settings: { kill_switch: false, paper_only: true, markets_enabled: { crypto: true, forex: true }, max_agents: 3, replication_threshold_eur: 500, replication_requires_approval: true, eurusd_rate: 1.12, eurusd_rate_at: iso(t - 3600000) },
    agents: [
      { id: A1, name: "Agent Alpha", parent_id: null, generation: 1, status: "active", halted_reason: null, capital_start: 10000, cash: 8500, equity: 10412.55, open_positions: 1, drawdown_pct: 0.8, started_at: iso(t - 86400000), last_tick_at: iso(t - 20000),
        stats: { trades: 14, wins: 8, pnl: 412.55, pnl_today: 168.2, avg_r: 0.21, gross_win: 900, gross_loss: 487.45, win_rate: 8 / 14, profit_factor: 1.85 }, config: cfg },
      { id: A2, name: "Agent Alpha-2", parent_id: A1, generation: 2, status: "pending_approval", halted_reason: null, capital_start: 10000, cash: 10000, equity: 10000, open_positions: 0, drawdown_pct: 0, started_at: null, last_tick_at: null,
        stats: { trades: 0, wins: 0, pnl: 0, pnl_today: 0, avg_r: 0, gross_win: 0, gross_loss: 0, win_rate: null, profit_factor: null }, config: cfg },
    ],
    open_positions: [{ id: 5, agent_id: A1, market: "crypto", symbol: "ETHUSDT", side: "long", qty: 0.63, entry_price: 2381.1, entry_time: iso(t - 600000), entry_fee: 1.5, entry_notional: 1500, sl_price: 2371, tp_price: 2401, sl: 2371, tp: 2401, risk_usd: 6.4, quality: 72, setup_key: "ETHUSDT:long:eu", mark: 2384.2, unrealized_usd: 0.45, value: 1501.95 }],
    closed_trades: [
      { id: 4, agent_id: A1, market: "crypto", symbol: "BTCUSDT", side: "long", qty: 0.02, entry_price: 80500, entry_time: iso(t - 7200000), exit_price: 80900, exit_time: iso(t - 6000000), close_reason: "target", pnl_usd: 5.1, r: 1.7, quality: 74, setup_key: "BTCUSDT:long:eu" },
      { id: 3, agent_id: A1, market: "forex", symbol: "EURUSD=X", side: "short", qty: 5000, entry_price: 1.1215, entry_time: iso(t - 9200000), exit_price: 1.1229, exit_time: iso(t - 8200000), close_reason: "stop", pnl_usd: -7.4, r: -1.1, quality: 63, setup_key: "EURUSD=X:short:eu" },
      { id: 2, agent_id: A1, market: "crypto", symbol: "SOLUSDT", side: "long", qty: 12, entry_price: 101.2, entry_time: iso(t - 12200000), exit_price: 101.9, exit_time: iso(t - 11200000), close_reason: "time", pnl_usd: 0.4, r: 0.05, quality: 61, setup_key: "SOLUSDT:long:asia" } ],
    equity_curve: eq(A1, 10000, 3.4).concat(eq(A2, 9990, 0.4).slice(60)),
    lessons: [{ agent_id: A1, setup_key: "EURUSD=X:short:eu", trades: 13, wins: 3, sum_r: -5.2, status: "blocked", blocked_until: iso(t + 7200000), note: "Mittel -0,40 R nach 13 Trades", inherited_from: null },
      { agent_id: A2, setup_key: "BTCUSDT:long:eu", trades: 6, wins: 4, sum_r: 2.1, status: "ok", blocked_until: null, note: null, inherited_from: A1 }],
    replication_events: [{ created_at: iso(t - 3600000), parent_id: A1, child_id: A2, day: "2026-10-24", profit_eur: 512.3, eurusd: 1.12, outcome: "pending_approval", note: "Kind wartet auf Freigabe" }],
    news: [
      { source: "fed", title: "Federal Reserve cuts interest rates by a quarter point", url: "https://example.com/a", published_at: iso(t - 600000), fetched_at: iso(t - 300000), score: 0.2, impact: "high", markets: ["forex", "crypto"], tags: ["rate_decision", "central_bank", "forex"] },
      { source: "coindesk", title: "<img src=x onerror=alert(1)> Bitcoin ETF approved", url: "javascript:alert(2)", published_at: iso(t - 3600000), fetched_at: iso(t - 300000), score: -0.4, impact: "medium", markets: ["crypto"], tags: ["crypto_regulation", "crypto"] },
      { source: "bbc_world", title: "Tariffs on imports announced", url: "https://example.com/c", published_at: null, fetched_at: iso(t - 900000), score: 0, impact: "low", markets: ["forex"], tags: ["trade_policy"] } ],
    notifications: [
      { id: 12, created_at: iso(t - 300000), kind: "trade_opened", agent_id: A1, title: "ETHUSDT long eröffnet", body: "Qualität 72, Einstieg 2381.1, Stop 2371, Ziel 2401" },
      { id: 11, created_at: iso(t - 900000), kind: "news", agent_id: null, title: "Wichtige Nachricht: Federal Reserve cuts interest rates", body: "Neue Einstiege in forex und crypto pausieren 30 Minuten." },
      { id: 10, created_at: iso(t - 2900000), kind: "control", agent_id: null, title: "Start über das Dashboard", body: "Alle Agenten gestartet (Simulation), Kill-Switch aus." } ],
  });
  return d;
}


// ---- additions for the capital statement and the profit/loss tables ----
const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "EURUSD=X"];
function mkTrades(pnls, startCap, tEnd, agent) {
  const n = pnls.length; let cum = 0; const out = [];
  for (let i = 0; i < n; i++) {
    const sym = SYMS[i % 4], exit = tEnd - (n - 1 - i) * 47 * 60000, entry = exit - 25 * 60000, pnl = pnls[i];
    cum += pnl;
    const fx_ = sym === "EURUSD=X", px0 = fx_ ? 1.12 : sym === "BTCUSDT" ? 80500 : sym === "ETHUSDT" ? 2380 : 102;
    out.push({ id: i + 1, agent_id: agent, market: fx_ ? "forex" : "crypto", symbol: sym, side: fx_ ? "short" : "long", qty: fx_ ? 5000 : 12.5 / (px0 / 100), entry_price: px0, entry_time: iso(entry),
      exit_price: px0 * (1 + pnl / 3000), exit_time: iso(exit), close_reason: pnl > 0 ? (i % 3 ? "target" : "time") : "stop", pnl_usd: pnl, r: pnl / 10, quality: 65, setup_key: sym + ":long:eu",
      entry_fee: 1.5 + (i % 3) * 0.1, exit_fee: 1.4 + (i % 4) * 0.1, entry_notional: 1500, cum_pnl: cum, capital_after: startCap + cum });
  }
  return out.reverse();
}
function dailyOf(trades, startCap) {
  const by = new Map();
  for (const t of trades.slice().reverse()) {
    const day = t.exit_time.slice(0, 10); const d = by.get(day) || { day, trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0 };
    d.trades++; if (t.pnl_usd > 0) d.wins++; else d.losses++; d.pnl += t.pnl_usd; d.fees += t.entry_fee + t.exit_fee; by.set(day, d);
  }
  let cum = 0; const rows = [...by.values()].map((d) => { cum += d.pnl; return Object.assign(d, { cum_pnl: cum }); });
  return rows.reverse();
}
const PN_BUSY = [5.1, -7.4, 94.5, -80, 160, 0.4, 140, -100, 180, -90, 120, -110, 200, -100.05]; // 8 wins 900.00, 6 losses 487.45, net 412.55
function withCapital(d, agentIdx, trades, cashFix) {
  const a = d.agents[agentIdx];
  const open = d.open_positions.filter((p) => p.agent_id === a.id);
  const move = open.reduce((s, p) => s + (p.mark - p.entry_price) * p.qty * (p.side === "long" ? 1 : -1), 0);
  const fees = open.reduce((s, p) => s + p.entry_fee, 0), reserved = open.reduce((s, p) => s + p.entry_notional, 0);
  const closedFees = trades.reduce((s, t) => s + t.entry_fee + t.exit_fee, 0);
  const real = trades.reduce((s, t) => s + t.pnl_usd, 0);
  const cash = a.capital_start + real - fees - reserved;
  a.cash = cash; a.equity = cash + reserved + move;
  a.capital = { start: a.capital_start, realized_net: real, fees_closed: closedFees, open_move: move, open_fees: fees, reserved, free_cash: cash, equity: a.equity, expected_equity: a.capital_start + real + move - fees, diff: 0 };
  a.stats.trades = trades.length; a.stats.pnl = real;
  return a;
}
function busy3() {
  const d = busy(); const t = now();
  const tr = mkTrades(PN_BUSY, 10000, t - 600000, A1);
  d.closed_trades = []; d.closed_total = tr.length;
  const a = withCapital(d, 0, tr);
  a.stats.wins = 8; a.stats.win_rate = 8 / 14; a.stats.gross_win = 900; a.stats.gross_loss = 487.45;
  const p2 = d.agents[1]; p2.capital = { start: 10000, realized_net: 0, fees_closed: 0, open_move: 0, open_fees: 0, reserved: 0, free_cash: 10000, equity: 10000, expected_equity: 10000, diff: 0 };
  d.daily = dailyOf(tr, 10000);
  return d;
}
busy3.trades = () => mkTrades(PN_BUSY, 10000, now() - 600000, A1);
function empty3() {
  const d = empty(); const a = d.agents[0];
  a.capital = { start: 10000, realized_net: 0, fees_closed: 0, open_move: 0, open_fees: 0, reserved: 0, free_cash: 10000, equity: 10000, expected_equity: 10000, diff: 0 };
  d.closed_total = 0; d.daily = [];
  return d;
}
empty3.trades = () => [];
// 250 trades for pagination
const PN_MANY = Array.from({ length: 250 }, (_, i) => (i % 3 === 0 ? -(4 + (i % 7)) : 3 + (i % 5)));
function many() {
  const d = busy3(); const t = now();
  const tr = mkTrades(PN_MANY, 10000, t - 600000, A1);
  d.closed_total = tr.length; d.open_positions = [];
  const a = withCapital(d, 0, tr);
  a.stats.wins = tr.filter((x) => x.pnl_usd > 0).length; a.stats.gross_win = tr.filter((x) => x.pnl_usd > 0).reduce((s, x) => s + x.pnl_usd, 0); a.stats.gross_loss = -tr.filter((x) => x.pnl_usd < 0).reduce((s, x) => s + x.pnl_usd, 0);
  d.daily = dailyOf(tr, 10000).slice(0, 30);
  return d;
}
many.trades = () => mkTrades(PN_MANY, 10000, now() - 600000, A1);
// After the restart: two trend agents with 5,000 rubles each (61.22 USDT), Alpha is archived (the API leaves retired agents out),
// statistics count from settings.stats_since, ruble rate from the Bank of Russia. One trend position without fixed stop or target.
const A3 = "33333333-3333-4333-8333-333333333333";
function trend() {
  const d = busy3(); const t = now();
  const RATE = 81.6699, CAP = 5000 / RATE;
  Object.assign(d.settings, { stats_since: iso(t - 3 * 3600000), usdrub_rate: RATE, usdrub_rate_at: iso(t - 1800000), usdrub_source: "cbr 2026-11-04" });
  const tcfg = (rule, label) => ({ engine: "trend", markets: { crypto: ["BTCUSDT", "ETHUSDT", "SOLUSDT"] }, strategy: { rule, label, tf: 1440, sizing: "vol", ref_vol: 0.6, vol_days: 30, scale: 0.25 },
    risk: { max_drawdown_pct: 10, min_notional_usd: 5, min_order_usd: 6 }, costs: {}, display: { currency: "RUB", capital_rub: 5000, usdrub_at_start: RATE } });
  const zero = { trades: 0, wins: 0, pnl: 0, pnl_today: 0, avg_r: 0, gross_win: 0, gross_loss: 0, fees: 0, win_rate: null, profit_factor: null };
  const mk = (id, name, cfg, open) => {
    const reserved = open ? 6 : 0, move = open ? 0.0456 : 0, fees = open ? 0.006 : 0, cash = CAP - reserved - fees;
    return { id, name, parent_id: null, generation: 0, status: "active", halted_reason: null, capital_start: CAP, cash, equity: cash + reserved + move, open_positions: open ? 1 : 0,
      drawdown_pct: 0, started_at: iso(t - 3 * 3600000), last_tick_at: iso(t - 120000), stats: { ...zero }, config: cfg,
      capital: { start: CAP, realized_net: 0, fees_closed: 0, open_move: move, open_fees: fees, reserved, free_cash: cash, equity: cash + reserved + move, expected_equity: cash + reserved + move, diff: 0 } };
  };
  d.agents = [mk(A2, "Agent Beta · Momentum", tcfg("tsmom_vote", "Momentum-Abstimmung 30/90/180 Tage"), true), mk(A3, "Agent Gamma · Turtle", tcfg("turtle_55_20", "Turtle-Ausbruch 55/20 Tage"), false)];
  d.replication_events = []; d.closed_trades = []; d.closed_total = 0; d.daily = []; d.lessons = []; d.equity_curve = [];
  d.open_positions = [{ id: 106, agent_id: A2, market: "crypto", symbol: "SOLUSDT", side: "long", qty: 0.065148, entry_price: 92.0984, entry_time: iso(t - 300000), entry_fee: 0.006, entry_notional: 6, sl_price: null, tp_price: null, sl: null, tp: null, risk_usd: 0.9, quality: null, setup_key: "SOLUSDT:long:tsmom_vote", mark: 92.8, unrealized_usd: 0.0397, value: 6.0456 }];
  return d;
}
trend.trades = () => [];

// Currency agent Delta (both directions) and the user's own paper account ("Selbst handeln").
const A4 = "44444444-4444-4444-8444-444444444444", A5 = "55555555-5555-4555-8555-555555555555";
function own() {
  const d = trend(); const t = now();
  const RATE = 81.6699, CAP = 5000 / RATE;
  const zero = { trades: 0, wins: 0, pnl: 0, pnl_today: 0, avg_r: 0, gross_win: 0, gross_loss: 0, fees: 0, win_rate: null, profit_factor: null };
  const FX = ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCHF=X", "USDCAD=X"];
  const fxPx = { "EURUSD=X": 1.1232, "GBPUSD=X": 1.3474, "USDJPY=X": 158.44, "AUDUSD=X": 0.7011, "USDCHF=X": 0.8169, "USDCAD=X": 1.3965 };
  const deltaPos = FX.map((s, i) => ({ id: 200 + i, agent_id: A4, market: "forex", symbol: s, side: i % 2 ? "long" : "short", qty: 5.1018 / fxPx[s], entry_price: fxPx[s], entry_time: iso(t - 600000),
    entry_fee: 0, entry_notional: 5.1018, sl_price: null, tp_price: null, sl: null, tp: null, risk_usd: 0.5, quality: null, setup_key: `${s}:x:tsmom_vote`, mark: fxPx[s] * (i % 2 ? 1.001 : 0.999),
    unrealized_usd: 5.1018 * 0.001, value: 5.1018 * 1.001 }));
  const ownPos = [
    { id: 301, agent_id: A5, market: "crypto", symbol: "BTCUSDT", side: "long", qty: 0.00017, entry_price: 70012.3, entry_time: iso(t - 1800000), entry_fee: 0.0119, entry_notional: 11.9, sl_price: null, tp_price: null, sl: null, tp: null, risk_usd: 1.19, quality: null, setup_key: "BTCUSDT:long:manual", mark: 70300, unrealized_usd: 0.037, value: 11.949 },
    { id: 302, agent_id: A5, market: "forex", symbol: "EURUSD=X", side: "short", qty: 10.9, entry_price: 1.12298, entry_time: iso(t - 900000), entry_fee: 0, entry_notional: 12.24, sl_price: null, tp_price: null, sl: null, tp: null, risk_usd: 1.22, quality: null, setup_key: "EURUSD=X:short:manual", mark: 1.1225, unrealized_usd: 0.0052, value: 12.2452 },
  ];
  const mkA = (id, name, cfg, open, extra) => {
    const reserved = open.reduce((s, p) => s + p.entry_notional, 0), move = open.reduce((s, p) => s + (p.mark - p.entry_price) * p.qty * (p.side === "long" ? 1 : -1), 0);
    const fees = open.reduce((s, p) => s + p.entry_fee, 0), real = extra?.pnl || 0, cash = CAP + real - reserved - fees;
    return { id, name, parent_id: null, generation: 0, status: "active", halted_reason: null, capital_start: CAP, cash, equity: cash + reserved + move, open_positions: open.length,
      drawdown_pct: 0, started_at: iso(t - 3600000), last_tick_at: iso(t - 120000), stats: { ...zero, ...(extra || {}) }, config: cfg,
      capital: { start: CAP, realized_net: real, fees_closed: extra?.fees || 0, open_move: move, open_fees: fees, reserved, free_cash: cash, equity: cash + reserved + move, expected_equity: cash + reserved + move, diff: 0 } };
  };
  d.agents.push(mkA(A4, "Agent Delta · Währungen", { engine: "trend", markets: { forex: FX }, allow_short: { forex: true },
    strategy: { rule: "tsmom_vote", label: "Momentum-Abstimmung 30/90/180 Tage, beide Richtungen", tf: 1440, sizing: "vol", ref_vol: 0.6, vol_days: 30, scale: 0.5 },
    risk: { max_drawdown_pct: 10, min_notional_usd: 1, min_order_usd: 0 }, costs: {}, display: { currency: "RUB", capital_rub: 5000, usdrub_at_start: RATE } }, deltaPos));
  d.agents.push(mkA(A5, "Ich · Selbst gehandelt", { engine: "manual", markets: { crypto: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XAUTUSDT"], forex: ["EURUSD=X", "GBPUSD=X", "USDJPY=X"] },
    allow_short: { forex: true }, strategy: { label: "Du entscheidest selbst" }, risk: { min_order_usd: 6, min_notional_usd: 1 }, costs: {}, display: { currency: "RUB", capital_rub: 5000, usdrub_at_start: RATE } },
    ownPos, { trades: 2, wins: 1, pnl: 0.0735, win_rate: 0.5, fees: 0.024 }));
  d.open_positions = d.open_positions.concat(deltaPos, ownPos);
  d.closed_total = 2;
  d.manual = { markets: [
    { symbol: "BTCUSDT", name: "Bitcoin", market: "crypto", can_short: false }, { symbol: "ETHUSDT", name: "Ethereum", market: "crypto", can_short: false },
    { symbol: "SOLUSDT", name: "Solana", market: "crypto", can_short: false }, { symbol: "XAUTUSDT", name: "Gold (Token XAUT)", market: "crypto", can_short: false },
    { symbol: "EURUSD=X", name: "EUR/USD", market: "forex", can_short: true }, { symbol: "GBPUSD=X", name: "GBP/USD", market: "forex", can_short: true },
    { symbol: "USDJPY=X", name: "USD/JPY", market: "forex", can_short: true } ], min_usd: { crypto: 6, forex: 1 } };
  return d;
}
own.trades = () => {
  const t = now();
  return [
    { id: 290, agent_id: A5, market: "crypto", symbol: "ETHUSDT", side: "long", qty: 0.005, entry_price: 2380, entry_time: iso(t - 7200000), exit_price: 2410, exit_time: iso(t - 3600000), close_reason: "manual", pnl_usd: 0.126, r: 0.1, quality: null, setup_key: "ETHUSDT:long:manual", entry_fee: 0.0119, exit_fee: 0.0121, entry_notional: 11.9, cum_pnl: 0.126, capital_after: 61.35 },
    { id: 289, agent_id: A5, market: "forex", symbol: "EURUSD=X", side: "short", qty: 10.9, entry_price: 1.1229, entry_time: iso(t - 9200000), exit_price: 1.1234, exit_time: iso(t - 8200000), close_reason: "manual", pnl_usd: -0.0525, r: -0.04, quality: null, setup_key: "EURUSD=X:short:manual", entry_fee: 0, exit_fee: 0, entry_notional: 12.24, cum_pnl: -0.0525, capital_after: 61.17 },
  ];
};
/** Live quotes as returned by dashboard-api manual_quote. GBP/USD is shown as closed (weekend case). */
function quotes(symbol) {
  const t = now();
  const row = (s, name, market, can_short, mid, extra) => Object.assign({ symbol: s, name, market, can_short, mid, bid: market === "crypto" ? mid - 0.05 : mid * (1 - 1e-4), ask: market === "crypto" ? mid + 0.05 : mid * (1 + 1e-4),
    at: iso(t - 5000), fresh: true, change_pct: market === "crypto" ? 1.84 : -0.21, chart: symbol ? walk(48, mid, mid * 0.002) : null, fee_bps: market === "crypto" ? 10 : 0, slip_bps: market === "crypto" ? 2 : 1,
    spread_bps: market === "crypto" ? 0.01 : 2, round_trip_pct: market === "crypto" ? 0.2401 : 0.04, min_rub: market === "crypto" ? 495 : 83, source: market === "crypto" ? "bybit" : "yahoo" }, extra || {});
  const all = [row("BTCUSDT", "Bitcoin", "crypto", false, 70300), row("ETHUSDT", "Ethereum", "crypto", false, 2412.4), row("SOLUSDT", "Solana", "crypto", false, 92.8),
    row("XAUTUSDT", "Gold (Token XAUT)", "crypto", false, 4012.5), row("EURUSD=X", "EUR/USD", "forex", true, 1.1225),
    row("GBPUSD=X", "GBP/USD", "forex", true, 1.3474, { fresh: false, at: iso(t - 3 * 3600000) }), row("USDJPY=X", "USD/JPY", "forex", true, 158.44)];
  return { server_time: iso(t), usdrub: 81.6699, kill_switch: false, markets_enabled: { crypto: true, forex: true }, quotes: symbol ? all.filter((q) => q.symbol === symbol) : all };
}
module.exports = { empty: empty3, busy: busy3, many, trend, own, quotes };
