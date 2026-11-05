// Browser tests for app/index.html with mocked APIs (no network, no real data).
// Run: node tests/app.test.cjs   (needs Playwright with Chromium; set PLAYWRIGHT_PATH if it is not resolvable)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const fx = require("./fixtures.cjs");
const bbfx = require("./fixtures-bybit.cjs");

const APP_DIR = path.join(__dirname, "..", "app");
const SHOTS = path.join(__dirname, "shots");
const API = "https://lmgmeegwufbthxqlilkj.supabase.co/functions/v1/dashboard-api";
const BB_API = "https://lmgmeegwufbthxqlilkj.supabase.co/functions/v1/bybit-view";
const GOOD = "good-token-good-token-1234";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-dashboard-token" };

function serve() {
  const srv = http.createServer((req, res) => {
    const p = path.join(APP_DIR, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
    if (!p.startsWith(APP_DIR) || !fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = await serve();
  const BASE = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const results = [];
  const check = (name, ok, extra) => { results.push({ name, ok: !!ok, extra }); console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); };

  async function run(label, scenario, viewport, scheme, opts = {}) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = []; const dialogs = []; const calls = []; const bbCalls = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|net::|401|409|422|500/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
    let current = scenario; let tradesOverride = null; let bbCurrent = opts.bybit || bbfx.base; let bbReply = null; let manualReply = null;
    await page.route(API, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (req.headers()["x-dashboard-token"] !== GOOD) return route.fulfill({ status: 401, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
      const body = JSON.parse(req.postData() || "{}"); calls.push(body);
      if (!body.action || body.action === "overview") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(current()) });
      if (body.action === "trades") {
        if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200 || !Number.isInteger(body.offset) || body.offset < 0) return route.fulfill({ status: 400, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "limit 1..200" }) });
        const db = (tradesOverride || current.trades || (() => []))();
        return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ server_time: new Date().toISOString(), trades: db.slice(body.offset, body.offset + body.limit), total: db.length }) });
      }
      if (manualReply) { const r = manualReply(body); if (r) return route.fulfill({ status: r.status, headers: CORS, contentType: "application/json", body: JSON.stringify(r.body) }); }
      if (body.action === "manual_chart") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(fx.candles(body.symbol, body.tf, body.limit)) });
      if (body.action === "manual_quote") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(fx.quotes(body.symbol)) });
      if (body.action === "manual_open") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ok: true, position_id: 999, symbol: body.symbol, side: body.side, entry_price: 70314.1, qty: 0.0001, notional_usd: body.amount_rub / 81.6699, fee_usd: 0.012, amount_rub: body.amount_rub, usdrub: 81.6699 }) });
      if (body.action === "manual_close") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ok: true, position_id: body.position_id, exit_price: 70280, fee_usd: 0.012, pnl_usd: 0.0123, pnl_rub: 1.0045, usdrub: 81.6699 }) });
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.route(BB_API, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (req.headers()["x-dashboard-token"] !== GOOD) return route.fulfill({ status: 401, headers: CORS, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
      const body = JSON.parse(req.postData() || "{}"); bbCalls.push(body);
      if (bbReply) { const r = bbReply(body); if (r) return route.fulfill({ status: r.status, headers: CORS, contentType: "application/json", body: JSON.stringify(r.body) }); }
      if (!body.action || body.action === "overview") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(bbCurrent()) });
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ok: true, enabled: body.enabled }) });
    });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    // Bybit public stream: answered here, never the real exchange. opts.ws === "fail" simulates a blocked connection.
    const wsLog = []; let wsSock = null;
    await page.routeWebSocket("wss://stream.bybit.com/v5/public/spot", (ws) => {
      if (opts.ws === "fail") { ws.close(); return; }
      wsSock = ws;
      ws.onMessage((m) => {
        const msg = JSON.parse(String(m)); wsLog.push(msg);
        if (msg.op === "subscribe") {
          ws.send(JSON.stringify({ success: true, op: "subscribe", ret_msg: "" }));
          const kt = msg.args.find((a) => a.startsWith("kline.")), [, iv, sym] = kt.split(".");
          const ms = { "1": 60000, "5": 300000, "15": 900000, "60": 3600000, "240": 14400000, D: 86400000 }[iv];
          const start = Math.floor(Date.now() / ms) * ms;
          ws.send(JSON.stringify({ topic: kt, type: "snapshot", data: [{ start, end: start + ms - 1, interval: iv, open: "70290", close: "70310.5", high: "70333", low: "70280", volume: "12.5", turnover: "0", confirm: false, timestamp: Date.now() }] }));
          ws.send(JSON.stringify({ topic: `tickers.${sym}`, type: "snapshot", data: { symbol: sym, lastPrice: "70311.2" } }));
        }
      });
    });
    await page.goto(BASE + "/index.html" + (opts.hash || ""));
    check(label + ": gate visible", await page.locator("#gate").isVisible());
    await page.fill("#tok", "wrong-token-wrong-token-1234");
    await page.click("#gate-form button[type=submit]");
    await page.waitForSelector("#gate-err:not([hidden])");
    check(label + ": wrong token shows error", /stimmt nicht/.test(await page.textContent("#gate-err")));
    await page.fill("#tok", GOOD);
    await page.click("#gate-form button[type=submit]");
    await page.waitForSelector("#app:not([hidden])");
    await page.waitForSelector(".mrow", { state: "attached" });
    return { page, ctx, errors, dialogs, calls, bbCalls, setScenario: (s) => (current = s), setTrades: (f) => (tradesOverride = f), setBybit: (f) => (bbCurrent = f), setBbReply: (f) => (bbReply = f), setManualReply: (f) => (manualReply = f), wsLog, wsSend: (o) => wsSock && wsSock.send(JSON.stringify(o)) };
  }
  // switch area through the navigation bar, like a user
  async function go(page, v) {
    await page.click(`.vbar a[data-v="${v}"]`);
    await page.waitForFunction((x) => !document.querySelector(`.view[data-view="${x}"]`).hidden, v);
  }
  const noOverflow = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  // 1) empty state, desktop light
  let r = await run("empty", fx.empty, { width: 1280, height: 900 }, "light");
  const heroWord = await r.page.textContent(".state");
  check("empty: state word Pausiert", heroWord.trim() === "Pausiert", heroWord);
  check("empty: opens on the overview area", !(await r.page.locator('.view[data-view="uebersicht"]').isHidden()) && (await r.page.getAttribute('.vbar a[data-v="uebersicht"]', "aria-current")) === "page");
  const rows = await r.page.locator(".mrow .sym").allTextContents();
  check("empty: ranked by quality, blocked last", rows[0] === "ETH/USDT" && rows[rows.length - 1] === "EUR/USD", rows.join(","));
  check("empty: start enabled, stop disabled", !(await r.page.locator("#b-start").isDisabled()) && (await r.page.locator("#b-stop").isDisabled()));
  check("empty: EUR/USD row shows stale chip + weekend hint without opening details", /Veraltet/.test(await r.page.locator(".mrow").last().textContent()) && /Wochenende|geschlossen|zu alt/.test(await r.page.locator(".mrow").last().textContent()));
  check("empty: capital shows full start capital", /10\.000,00 USD/.test(await r.page.textContent("#capital-table")));
  check("empty: no closed trades message and no trades call", /Noch keine abgeschlossenen Trades/.test(await r.page.textContent("#pnl")) && !r.calls.some((c) => c.action === "trades"));
  await r.page.waitForFunction(() => /Bybit/.test(document.querySelector("#bb-sum").textContent) && !/geladen …/.test(document.querySelector("#bb-sum").textContent));
  check("empty: overview shows the bybit summary", /−36,72 USD/.test(await r.page.textContent("#bb-sum")) && /An/.test(await r.page.textContent("#bb-sum")));
  await r.page.screenshot({ path: path.join(SHOTS, "empty-light-top.png"), fullPage: false });
  await go(r.page, "maerkte");
  check("empty: hash follows the area", (await r.page.evaluate(() => location.hash)) === "#maerkte");
  await r.page.click("[data-open='m:EURUSD=X']");
  check("empty: details open with weekend/stale hint", /Letzter erfolgreicher Abruf/.test(await r.page.textContent("#markets")));
  await r.page.click("[data-tab='metals']");
  check("empty: metals tab says not built", /noch nicht gebaut/.test(await r.page.textContent("#markets")));
  await r.page.click("[data-tab='all']");
  check("empty: only one area visible at a time", (await r.page.locator(".view:not([hidden])").count()) === 1);
  check("empty: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // 2) busy state, desktop dark
  r = await run("busy", fx.busy, { width: 1280, height: 900 }, "dark");
  check("busy: state word Läuft", (await r.page.textContent(".state")).trim() === "Läuft");
  check("busy: start disabled while running", await r.page.locator("#b-start").isDisabled());
  check("busy: entry signal chip", /Einstieg möglich/.test(await r.page.textContent("#markets")));
  check("busy: ETH ranked first", (await r.page.locator(".mrow .sym").first().textContent()) === "ETH/USDT");
  await r.page.waitForSelector("#trades-table", { state: "attached" });
  check("busy: every trade listed individually", (await r.page.locator("#trades-table tbody tr").count()) === 14);
  const cap = await r.page.textContent("#capital-table");
  check("busy: capital statement shows start and capital now", /10\.000,00 USD/.test(cap) && /10\.413,00 USD/.test(cap) && /8\.911,05 USD/.test(cap), cap.replace(/\s+/g, " ").slice(0, 400));
  check("busy: capital reconciliation chip says ok", /Abgleich stimmt/.test(await r.page.textContent("#capital")));
  check("busy: pending agent not in capital columns", (await r.page.locator("#capital-table thead th").count()) === 2);
  const tf = (await r.page.textContent("#trades-table tfoot")).replace(/\s+/g, " ");
  check("busy: footer sums fees and net result", /\+412,55 USD/.test(tf) && /43,80 USD/.test(tf), tf);
  const sumTxt = (await r.page.textContent("#pnl .sumline")).replace(/\s+/g, " ");
  check("busy: summary shows gains and losses separately", /\+900,00 USD/.test(sumTxt) && /−487,45 USD/.test(sumTxt) && /\+412,55 USD/.test(sumTxt), sumTxt);
  const firstRow = (await r.page.locator("#trades-table tbody tr").first().textContent()).replace(/\s+/g, " ");
  check("busy: newest trade first with capital after", /#14/.test(firstRow) && /10\.412,55 USD/.test(firstRow), firstRow);
  check("busy: daily table present", (await r.page.locator("#daily-table tbody tr").count()) >= 1);
  await go(r.page, "trades");
  await r.page.click("[data-filter='win']");
  check("busy: filter only gains", (await r.page.locator("#trades-table tbody tr").count()) === 8 && /\+900,00 USD/.test(await r.page.textContent("#trades-table tfoot")));
  await r.page.click("[data-filter='loss']");
  check("busy: filter only losses", (await r.page.locator("#trades-table tbody tr").count()) === 6 && /−487,45 USD/.test(await r.page.textContent("#trades-table tfoot")));
  await r.page.click("[data-filter='all']");
  const [dl] = await Promise.all([r.page.waitForEvent("download"), r.page.click("[data-csv]")]);
  const csv = fs.readFileSync(await dl.path(), "utf8");
  const csvLines = csv.replace(/^﻿/, "").split("\r\n");
  const sumCsv = csvLines.slice(1).reduce((s, l) => s + Number(l.split(";")[11].replace(/"/g, "").replace(",", ".")), 0);
  check("busy: csv has header + 14 rows, BOM, decimal comma, net 412.55", csv.charCodeAt(0) === 0xfeff && csvLines.length === 15 && /^"Nr";/.test(csvLines[0]) && Math.abs(sumCsv - 412.55) < 0.01 && /,\d/.test(csvLines[1]), `${csvLines.length} lines, sum ${sumCsv}`);
  check("busy: no trades action beyond first page needed", r.calls.filter((c) => c.action === "trades").length === 1, JSON.stringify(r.calls.filter((c) => c.action === "trades")));
  check("busy: overview requested in lite mode", r.calls.some((c) => (!c.action || c.action === "overview") && c.lite === true));
  check("busy: position listed", (await r.page.locator("#positions tbody tr").count()) === 1);
  check("busy: chart rendered with legend", (await r.page.locator("#chart svg polyline").count()) === 2 && (await r.page.locator("#chart .legend span").count()) === 2);
  check("busy: XSS title escaped (no img element)", (await r.page.locator("#news img").count()) === 0 && /<img src=x/.test(await r.page.textContent("#news")));
  check("busy: javascript: url not linked", (await r.page.locator("#news a[href^='javascript']").count()) === 0);
  check("busy: approve buttons for pending agent", (await r.page.locator("[data-approve]").count()) === 2);
  check("busy: lessons show inherited chip", /geerbt/.test(await r.page.textContent("#lessons")));
  await go(r.page, "uebersicht");
  await r.page.locator("#eq").scrollIntoViewIfNeeded();
  const box = await r.page.locator("#eq").boundingBox();
  await r.page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  check("busy: chart tooltip appears", await r.page.locator("#eq-tip").isVisible());
  await r.page.screenshot({ path: path.join(SHOTS, "busy-dark-overview.png"), fullPage: true });
  await r.page.click("[data-agent-stop]");
  await r.page.waitForTimeout(400);
  check("busy: per-agent stop sends action with agent_id", r.calls.some((c) => c.action === "stop" && /^1111/.test(c.agent_id || "")), JSON.stringify(r.calls.slice(-2)));
  await r.page.click("#b-stop");
  await r.page.waitForTimeout(400);
  check("busy: global stop sends action", r.calls.some((c) => c.action === "stop" && !c.agent_id));
  check("busy: logout button usable again after an action", !(await r.page.locator("#logout").isDisabled()));
  await r.page.click("[data-approve][data-start='1']");
  await r.page.waitForTimeout(400);
  check("busy: approve sends start:true", r.calls.some((c) => c.action === "approve_agent" && c.start === true));
  await go(r.page, "einstellungen");
  await r.page.fill("#f-thr", "400");
  await r.page.click("#set-form button[type=submit]");
  await r.page.waitForTimeout(400);
  check("busy: settings send values", r.calls.some((c) => c.action === "settings" && c.values && c.values.replication_threshold_eur === 400 && c.values.max_agents === 3));
  // bybit area
  await go(r.page, "bybit");
  await r.page.waitForFunction(() => /Spiegeln/.test(document.querySelector("#bb-state").textContent));
  check("bybit: state says mirroring is on", (await r.page.textContent("#bb-state")).trim() === "Spiegeln an");
  check("bybit: six tiles, result and paper shown", (await r.page.locator("#bb-tiles > div").count()) === 6 && /−36,72 USD/.test(await r.page.textContent("#bb-tiles")) && /−33,60 USD/.test(await r.page.textContent("#bb-tiles")));
  check("bybit: closed trades table with footer sum", (await r.page.locator("#bb-pairs-table tbody tr").count()) === 2 && /−36,72 USD/.test(await r.page.textContent("#bb-pairs-table tfoot")));
  check("bybit: open position listed", (await r.page.locator("#bb-open-table tbody tr").count()) === 1 && /BTC\/USDT/.test(await r.page.textContent("#bb-open-table")));
  check("bybit: failed order shown with reason", /Fehler/.test(await r.page.textContent("#bb-orders-table")) && /Insufficient balance/.test(await r.page.textContent("#bb-orders-table")));
  check("bybit: chart with two lines", (await r.page.locator("#bb-chart svg path").count()) === 2);
  check("bybit: nav dot shows mirroring on", /\bon\b/.test(await r.page.getAttribute("#bb-dot", "class")));
  check("bybit: toggle offers switching off", (await r.page.textContent("#bb-toggle")).trim() === "Spiegeln ausschalten");
  await r.page.screenshot({ path: path.join(SHOTS, "busy-dark-bybit.png"), fullPage: true });
  r.setBbReply((b) => (b.action === "set_enabled" ? { status: 409, body: { error: "open_positions", open: 1 } } : null));
  await r.page.click("#bb-toggle");
  // an earlier toast may still be visible, so wait for the refusal text itself
  await r.page.waitForFunction(() => /nicht möglich/.test(document.querySelector("#toasts")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check("bybit: switching off with an open position asks first and explains the refusal", r.dialogs.some((d) => /ausschalten/.test(d)) && /nicht möglich/.test(await r.page.textContent("#toasts")) && r.bbCalls.some((c) => c.action === "set_enabled" && c.enabled === false));
  check("bybit: toggle usable again", !(await r.page.locator("#bb-toggle").isDisabled()));
  check("busy: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // 3) start flow with confirm dialog
  r = await run("start", fx.empty, { width: 1280, height: 900 }, "light");
  await r.page.click("#b-start");
  await r.page.waitForTimeout(400);
  check("start: confirm dialog shown and start sent", r.dialogs.length === 1 && r.calls.some((c) => c.action === "start"), r.dialogs[0]);
  await r.ctx.close();

  // 4) mobile
  r = await run("mobile", fx.busy, { width: 390, height: 800 }, "light");
  check("mobile: no horizontal page scroll", await noOverflow(r.page));
  await go(r.page, "trades");
  await r.page.waitForSelector("#trades-table");
  check("mobile: trade table turns into cards", !(await r.page.locator("#trades-table thead").isVisible()) && (await r.page.locator("#trades-table tbody tr").first().evaluate((el) => getComputedStyle(el).display)) === "block");
  check("mobile: result and capital after are visible in the card", (await r.page.locator("#trades-table tbody tr").first().locator("td[data-l='Ergebnis']").isVisible()) && (await r.page.locator("#trades-table tbody tr").first().locator("td[data-l='Kapital danach']").isVisible()));
  check("mobile: still no horizontal page scroll with trade cards", await noOverflow(r.page));
  await r.page.screenshot({ path: path.join(SHOTS, "mobile-trades.png") });
  await go(r.page, "bybit");
  await r.page.waitForSelector("#bb-pairs-table");
  check("mobile: bybit tables turn into cards, no page scroll", !(await r.page.locator("#bb-pairs-table thead").isVisible()) && (await noOverflow(r.page)));
  check("mobile: navigation bar stays reachable while scrolling", await r.page.evaluate(() => { window.scrollTo(0, 1500); const t = document.querySelector(".views").getBoundingClientRect().top; return Math.abs(t) < 2; }));
  await r.page.evaluate(() => window.scrollTo(0, 0));
  await r.page.screenshot({ path: path.join(SHOTS, "mobile-bybit.png"), fullPage: true });
  await go(r.page, "uebersicht");
  await r.page.screenshot({ path: path.join(SHOTS, "mobile-overview.png"), fullPage: true });
  check("mobile: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // 4b) pagination, live prepend, reconciliation warning
  r = await run("many", fx.many, { width: 1280, height: 900 }, "light", { hash: "#trades" });
  check("many: deep link opens the trades area", !(await r.page.locator('.view[data-view="trades"]').isHidden()));
  await r.page.waitForSelector("#trades-table");
  check("many: first page is 100 rows of 250", (await r.page.locator("#trades-table tbody tr").count()) === 100 && /100 von 250 Trades geladen/.test(await r.page.textContent("#pnl")));
  await r.page.click("[data-more='page']"); await r.page.waitForFunction(() => document.querySelectorAll("#trades-table tbody tr").length === 200);
  check("many: next page appends 100", true);
  await r.page.click("[data-more='all']"); await r.page.waitForFunction(() => document.querySelectorAll("#trades-table tbody tr").length === 250);
  check("many: load all reaches 250, load buttons gone", (await r.page.locator("[data-more]").count()) === 0 && /250 von 250/.test(await r.page.textContent("#pnl")));
  const ids = await r.page.locator("#trades-table tbody tr td:first-child").allTextContents();
  check("many: no duplicate ids, newest first", new Set(ids).size === 250 && ids[0].trim() === "#250" && ids[249].trim() === "#1", ids.slice(0, 3).join(","));
  check("many: requests respect api limits", r.calls.filter((c) => c.action === "trades" && (c.limit > 200 || c.offset < 0)).length === 0);
  const before = r.calls.filter((c) => c.action === "trades").length;
  const dbNow = fx.many.trades(); const newest = Object.assign({}, dbNow[0], { id: 251, exit_time: new Date().toISOString(), pnl_usd: -12.5, cum_pnl: dbNow[0].cum_pnl - 12.5, capital_after: dbNow[0].capital_after - 12.5, r: -1.25 });
  r.setTrades(() => [newest, ...dbNow]);
  r.setScenario(Object.assign(() => { const d = fx.many(); d.closed_total = 251; return d; }, { trades: () => [newest, ...dbNow] }));
  await r.page.evaluate(() => load(true)); await r.page.waitForFunction(() => document.querySelectorAll("#trades-table tbody tr").length === 251);
  const newCalls = r.calls.filter((c) => c.action === "trades").slice(before);
  check("many: new trade is prepended by fetching just one row", newCalls.length === 1 && newCalls[0].limit === 1 && newCalls[0].offset === 0 && (await r.page.locator("#trades-table tbody tr td").first().textContent()).trim() === "#251", JSON.stringify(newCalls));
  await r.page.evaluate(() => { state.data.agents[0].capital.diff = 5; renderCapital(state.data, derive(state.data)); });
  check("many: reconciliation mismatch is flagged", /Abweichung im Abgleich/.test(await r.page.textContent("#capital")));
  check("many: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // 4c) failing endpoints keep the page usable
  r = await run("tradesfail", fx.busy, { width: 1280, height: 900 }, "light");
  await r.page.unroute(API);
  await r.page.route(API, (route) => { const b = JSON.parse(route.request().postData() || "{}");
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (b.action === "trades") return route.fulfill({ status: 500, headers: CORS, contentType: "application/json", body: '{"error":"internal"}' });
    return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(fx.busy()) }); });
  r.setBbReply(() => ({ status: 500, body: { error: "internal" } }));
  await r.page.evaluate(() => { state.tr = { rows: [], total: 0, loaded: false, busy: false, err: null, filter: "all" }; bb.data = null; return load(true); });
  await r.page.waitForFunction(() => /nicht geladen werden/.test(document.querySelector("#pnl").textContent));
  check("tradesfail: capital block still renders and error is shown honestly", /Abgleich stimmt/.test(await r.page.textContent("#capital")) && /HTTP 500|internal/.test(await r.page.textContent("#pnl")));
  await r.page.waitForFunction(() => /nicht geladen werden/.test(document.querySelector("#bb-sum").textContent));
  check("bybitfail: overview says bybit data could not be loaded, dot turns red", /internal/.test(await r.page.textContent("#bb-sum")) && /\bbad\b/.test(await r.page.getAttribute("#bb-dot", "class")));
  await r.ctx.close();

  // 5) 401 after login -> back to gate
  r = await run("expired", fx.empty, { width: 1000, height: 700 }, "light");
  await r.page.unroute(API);
  await r.page.route(API, (route) => route.fulfill({ status: 401, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: '{"error":"unauthorized"}' }));
  await r.page.evaluate(() => load(true));
  await r.page.waitForTimeout(300);
  check("expired: returns to gate with message", await r.page.locator("#gate").isVisible() && /nicht akzeptiert/.test(await r.page.textContent("#gate-err")));
  await r.ctx.close();

  // 6) the old bybit.html address forwards into the app
  r = await run("redirect", fx.empty, { width: 1000, height: 700 }, "light");
  await r.page.goto(BASE + "/bybit.html");
  await r.page.waitForURL(/#bybit$/);
  await r.page.waitForSelector("#app:not([hidden])");
  check("redirect: bybit.html opens the bybit area of the app", !(await r.page.locator('.view[data-view="bybit"]').isHidden()));
  await r.ctx.close();

  // restart: two trend agents with 5,000 rubles each, statistics from the restart, positions without fixed stop/target
  r = await run("trend", fx.trend, { width: 390, height: 800 }, "light");
  const cards = r.page.locator("#agents article.agent");
  check("trend: two agent cards, archived Alpha not shown", (await cards.count()) === 2 && !/Agent Alpha/.test(await r.page.textContent("#agents")));
  const betaCard = await cards.nth(0).textContent();
  check("trend: Beta shows its rule, daily decision, minimum order", /Momentum-Abstimmung 30\/90\/180 Tage/.test(betaCard) && /einmal am Tag/.test(betaCard) && /mindestens 6 USDT/.test(betaCard) && /Rückgangs-Limit 10 %/.test(betaCard), betaCard.slice(0, 500));
  check("trend: Beta capital in rubles with start", /5\.00\d,\d\d ₽/.test(betaCard) && /Start 5\.000,00 ₽/.test(betaCard), betaCard.slice(0, 300));
  check("trend: ledger shows total capital in rubles", /₽/.test(await r.page.textContent("#ledger dd")) && /Start 10\.000,00 ₽/.test(await r.page.textContent("#ledger")));
  check("trend: capital lead names the restart", /Neustart am/.test(await r.page.textContent("#capital-lead")));
  check("trend: capital table has a ruble row", /Kapital jetzt in Rubel/.test(await r.page.textContent("#capital")) && /Zentralbank Russland/.test(await r.page.textContent("#capital")));
  check("trend: no undefined in agent texts", !/undefined|NaN/.test(await r.page.textContent("#agents")) && !/undefined|NaN/.test(await r.page.textContent("#ledger")));
  check("trend: active trend agent has a stop button", (await cards.nth(0).locator("[data-agent-stop]").count()) === 1);
  // the app still knows how to show a retired agent, should the API ever return one
  await r.page.evaluate(() => { const a = JSON.parse(JSON.stringify(state.data.agents[1])); a.id = "44444444-4444-4444-8444-444444444444"; a.name = "Agent Alt"; a.status = "stopped"; a.config.strategy.retired = true; state.data.agents.push(a); renderAgents(state.data, derive(state.data)); });
  const oldCard = await r.page.locator("#agents article.agent").nth(2).textContent();
  check("trend: retired agent card without start button", /Im Ruhestand/.test(oldCard) && (await r.page.locator("#agents article.agent").nth(2).locator("[data-agent-start],[data-agent-stop],.goal").count()) === 0);
  await go(r.page, "trades");
  const posText = await r.page.textContent("#positions");
  check("trend: position without stop shows 'per Regel'", /per Regel/.test(posText) && /offen/.test(posText) && !/undefined|NaN/.test(posText), posText.slice(0, 300));
  check("trend: no horizontal overflow on phone", await noOverflow(r.page));
  await go(r.page, "uebersicht");
  await r.page.screenshot({ path: path.join(SHOTS, "trend-mobile-agents.png"), fullPage: true });
  check("trend: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // own trading ("Selbst handeln") and the currency agent Delta, on a phone
  r = await run("own", fx.own, { width: 390, height: 844 }, "light");
  const ownCards = r.page.locator("#agents article.agent");
  check("own: four cards (Beta, Gamma, Delta, own account)", (await ownCards.count()) === 4, String(await ownCards.count()));
  const deltaCard = await ownCards.nth(2).textContent();
  check("own: Delta trades both directions, weekend note, size 8,3 %", /Verkauf \(short\)/.test(deltaCard) && /Wochenende/.test(deltaCard) && /8,3 %/.test(deltaCard) && /GBP\/USD/.test(deltaCard) && !/mindestens 6 USDT/.test(deltaCard), deltaCard.slice(0, 600));
  const ownCard = ownCards.nth(3);
  check("own: own account card without start/stop and without replication bar", /Du handelst/.test(await ownCard.textContent()) && (await ownCard.locator("[data-agent-start],[data-agent-stop],.goal").count()) === 0);
  check("own: hero counts three agents, not the own account", /3 Agenten sind aktiv/.test(await r.page.textContent("#hero")), await r.page.textContent(".state-sub"));
  await go(r.page, "handeln");
  await r.page.waitForFunction(() => document.querySelectorAll("#mt-list .mt-m").length === 7 && /70\.300/.test(document.querySelector("#mt-list").textContent));
  check("own: navigation opens the area, account tiles in rubles", /Dein Kapital/.test(await r.page.textContent("#mt-account")) && /Start 5\.000 ₽/.test(await r.page.textContent("#mt-account")));
  check("own: seven markets, Bitcoin selected first, GBP/USD marked without price", (await r.page.getAttribute('[data-mt-sel="BTCUSDT"]', "aria-pressed")) === "true" && /geschlossen|keine Kurse/.test(await r.page.textContent('[data-mt-sel="GBPUSD=X"]')));
  check("own: crypto offers buying only", (await r.page.locator("#mt-side .sidesw").count()) === 0 && /nur kaufen/.test(await r.page.textContent("#mt-side")));
  check("own: action disabled without amount", await r.page.locator("[data-mt-ask]").isDisabled());
  await r.page.fill("#mt-amt", "400");
  check("own: below minimum is explained, button disabled", /Mindestens 495 ₽/.test(await r.page.textContent("#mt-prev")) && await r.page.locator("[data-mt-ask]").isDisabled());
  await r.page.fill("#mt-amt", "1000");
  const prevTxt = await r.page.textContent("#mt-prev");
  check("own: preview shows amount, price and round-trip costs", /1\.000 ₽/.test(prevTxt) && /2,4 ₽/.test(prevTxt) && /0,24 %/.test(prevTxt), prevTxt);
  // a background refresh must not take the keyboard away or clear what was typed
  await r.page.focus("#mt-amt");
  await r.page.evaluate(() => load(true));
  await r.page.waitForTimeout(200);
  check("own: typing survives the 15 s refresh (focus and value kept)", await r.page.evaluate(() => document.activeElement && document.activeElement.id === "mt-amt" && document.activeElement.value === "1000"));
  await r.page.click("[data-mt-ask]");
  check("own: first tap asks for confirmation, nothing sent yet", /Wirklich kaufen/.test(await r.page.textContent("#mt-act")) && !r.calls.some((c) => c.action === "manual_open"));
  await r.page.click("[data-mt-go]");
  await r.page.waitForFunction(() => /Bitcoin gekauft/.test(document.querySelector("#toasts").textContent));
  check("own: confirmed buy sends symbol, side and rubles", r.calls.some((c) => c.action === "manual_open" && c.symbol === "BTCUSDT" && c.side === "long" && c.amount_rub === 1000), JSON.stringify(r.calls.filter((c) => c.action === "manual_open")));
  check("own: amount field cleared after the trade", (await r.page.inputValue("#mt-amt")) === "");
  // currency: sell (short) with "everything free"
  await r.page.click('[data-mt-sel="EURUSD=X"]');
  await r.page.waitForSelector('#mt-side .sidesw [data-mt-side="short"]');
  await r.page.click('[data-mt-side="short"]');
  await r.page.click('[data-mt-amt="all"]');
  const allVal = Number(await r.page.inputValue("#mt-amt"));
  check("own: 'Alles frei' fills the free rubles", allVal > 2000 && allVal < 5000, String(allVal));
  check("own: sell preview says profit when the price falls", /verkaufst/.test(await r.page.textContent("#mt-prev")) && /fällt/.test(await r.page.textContent("#mt-prev")));
  await r.page.click("[data-mt-ask]"); await r.page.click("[data-mt-go]");
  await r.page.waitForFunction(() => /EUR\/USD verkauft/.test(document.querySelector("#toasts").textContent));
  check("own: short sent for EUR/USD", r.calls.some((c) => c.action === "manual_open" && c.symbol === "EURUSD=X" && c.side === "short" && c.amount_rub === allVal));
  // closed market
  await r.page.click('[data-mt-sel="GBPUSD=X"]');
  await r.page.fill("#mt-amt", "1000");
  const staleTxt = await r.page.textContent("#mt-prev");
  check("own: currency without a live price blocks the trade and says why (weekend or gap at Yahoo)", (/Wochenende/.test(staleTxt) || /Yahoo liefert seit/.test(staleTxt)) && await r.page.locator("[data-mt-ask]").isDisabled(), staleTxt);
  // refusal from the server is shown
  r.setManualReply((b) => (b.action === "manual_open" ? { status: 422, body: { error: "Der Kill-Switch ist an: keine neuen Trades." } } : null));
  await r.page.click('[data-mt-sel="ETHUSDT"]'); await r.page.fill("#mt-amt", "800");
  await r.page.click("[data-mt-ask]"); await r.page.click("[data-mt-go]");
  await r.page.waitForFunction(() => /Kill-Switch ist an/.test(document.querySelector("#toasts").textContent));
  check("own: server refusal shown as message", true);
  r.setManualReply(null);
  // own positions and closing
  await r.page.waitForSelector("#mt-pos-table");
  const posTxt = await r.page.textContent("#mt-positions");
  check("own: open own positions listed with rubles, Delta's not mixed in", (await r.page.locator("#mt-pos-table tbody tr").count()) === 2 && /Bitcoin/.test(posTxt) && /EUR\/USD/.test(posTxt) && /₽/.test(posTxt) && !/AUD/.test(posTxt) && !/undefined|NaN/.test(posTxt), posTxt.slice(0, 300));
  await r.page.click('[data-mt-close="301"]');
  check("own: closing asks first", (await r.page.locator('[data-mt-close-go="301"]').count()) === 1 && !r.calls.some((c) => c.action === "manual_close"));
  await r.page.click('[data-mt-close-go="301"]');
  await r.page.waitForFunction(() => /Position geschlossen/.test(document.querySelector("#toasts").textContent));
  check("own: close sends the position id, result in rubles", r.calls.some((c) => c.action === "manual_close" && c.position_id === 301) && /\+1 ₽/.test(await r.page.textContent("#toasts")));
  await r.page.waitForSelector("#mt-closed-table");
  check("own: closed own trades listed (only own account)", (await r.page.locator("#mt-closed-table tbody tr").count()) === 2 && /Ethereum/.test(await r.page.textContent("#mt-closed")));
  check("own: no horizontal overflow on phone", await noOverflow(r.page));
  const qBefore = r.calls.filter((c) => c.action === "manual_quote").length;
  await r.page.evaluate(() => load(true)); await r.page.waitForTimeout(300); await r.page.evaluate(() => load(true)); await r.page.waitForTimeout(300);
  check("own: background refresh does not fetch quotes again within 25 s", r.calls.filter((c) => c.action === "manual_quote").length === qBefore, `${qBefore} -> ${r.calls.filter((c) => c.action === "manual_quote").length}`);
  await r.page.screenshot({ path: path.join(SHOTS, "own-trading-mobile.png"), fullPage: true });
  await go(r.page, "trades");
  check("own: currency pairs named correctly in positions", /GBP\/USD/.test(await r.page.textContent("#positions")) && /USD\/JPY/.test(await r.page.textContent("#positions")));
  check("own: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();
  r = await run("own-dark", fx.own, { width: 1280, height: 900 }, "dark", { hash: "#handeln" });
  await r.page.waitForFunction(() => document.querySelectorAll("#mt-list .mt-m").length === 7 && ch.bars > 0);
  await r.page.click('[data-mt-sel="USDJPY=X"]'); await r.page.click('[data-mt-side="short"]'); await r.page.fill("#mt-amt", "1500");
  await r.page.screenshot({ path: path.join(SHOTS, "own-trading-desktop-dark.png"), fullPage: true });
  check("own-dark: opens directly from the link #handeln", !(await r.page.locator('.view[data-view="handeln"]').isHidden()));
  check("own-dark: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // live candle chart ("wie bei Bybit"): own canvas drawing, live via the (simulated) Bybit stream, currencies by asking again
  r = await run("chart", fx.own, { width: 390, height: 844 }, "light", { hash: "#handeln" });
  await r.page.waitForFunction(() => ch.bars > 0 && ch.chart && ch.chart.bars.length >= 400);
  check("chart: history requested for Bitcoin, 15 min by default", r.calls.some((c) => c.action === "manual_chart" && c.symbol === "BTCUSDT" && c.tf === "15"));
  const cvBox = await r.page.locator("#chost canvas").boundingBox();
  check("chart: canvas fills the box on a phone", cvBox && cvBox.width >= 300 && cvBox.height >= 300, JSON.stringify(cvBox));
  const painted = await r.page.evaluate(() => { const c = document.querySelector("#chost canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let g = 0, red = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 1] > 100 && d[i] < 80 && d[i + 2] < 110) g++; if (d[i] > 150 && d[i + 1] < 80) red++; } return { g, red }; });
  check("chart: green and red candles are drawn", painted.g > 500 && painted.red > 500, JSON.stringify(painted));
  await r.page.waitForFunction(() => /Live von Bybit/.test(document.querySelector("#cstat").textContent));
  check("chart: subscribed to kline and ticker of Bitcoin", r.wsLog.some((m) => m.op === "subscribe" && m.args.includes("kline.15.BTCUSDT") && m.args.includes("tickers.BTCUSDT")));
  check("chart: live status and price from the stream in the header", /70\.311,20/.test(await r.page.textContent("#mt-big")), await r.page.textContent("#mt-big"));
  check("chart: legend shows open, high, low, close of the running candle", /E\s*70\.290,00/.test(await r.page.textContent("#clegend")) && /S\s*70\.311,20/.test(await r.page.textContent("#clegend")), await r.page.textContent("#clegend"));
  const n0 = await r.page.evaluate(() => ch.chart.bars.length);
  // a new candle starts: kline of the next slot
  r.wsSend({ topic: "kline.15.BTCUSDT", type: "snapshot", data: [{ start: Math.floor(Date.now() / 900000) * 900000 + 900000, open: "70311", close: "70400", high: "70410", low: "70300", volume: "1", confirm: false }] });
  await r.page.waitForFunction((n) => ch.chart.bars.length === n + 1, n0);
  check("chart: a new candle from the stream is appended", true);
  // own entry price as a line
  check("chart: own Bitcoin purchase shown as entry line", await r.page.evaluate(() => ch.chart.lines.some((l) => l.label === "Dein Kauf" && Math.abs(l.price - 70012.3) < 0.01)));
  // scroll back in time with the mouse, zoom with the wheel, back to the newest candle
  await r.page.evaluate(() => document.querySelector("#chost").scrollIntoView({ block: "center" }));
  await r.page.waitForTimeout(100);
  const cb = await r.page.locator("#chost canvas").boundingBox();
  await r.page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await r.page.mouse.down();
  await r.page.mouse.move(cb.x + cb.width / 2 + 120, cb.y + cb.height / 2, { steps: 6 }); await r.page.mouse.up();
  const offAfter = await r.page.evaluate(() => ch.chart.off);
  check("chart: dragging scrolls back in time", offAfter > 5, String(offAfter));
  const w0 = await r.page.evaluate(() => ch.chart.barW);
  await r.page.mouse.move(cb.x + cb.width / 2, cb.y + 100); await r.page.mouse.wheel(0, -300);
  await r.page.waitForTimeout(100);
  check("chart: mouse wheel zooms in", (await r.page.evaluate(() => ch.chart.barW)) > w0);
  check("chart: hovering shows the values of that candle", await r.page.evaluate(() => ch.chart.hover !== null && ch.chart.hover < ch.chart.bars.length - 1));
  await r.page.click('[data-cz="now"]');
  check("chart: 'Neueste' jumps back to the current candle", (await r.page.evaluate(() => ch.chart.off)) === 0);
  // time frame
  await r.page.click('[data-ctf="60"]');
  await r.page.waitForFunction(() => ch.tf === "60" && ch.bars > 0 && /Live/.test(document.querySelector("#cstat").textContent));
  check("chart: time frame 1 h loads hourly candles and subscribes again", r.calls.some((c) => c.action === "manual_chart" && c.tf === "60") && r.wsLog.some((m) => m.op === "subscribe" && m.args.includes("kline.60.BTCUSDT")) && (await r.page.getAttribute('[data-ctf="60"]', "aria-pressed")) === "true");
  // full screen
  await r.page.click("[data-cfull]");
  await r.page.waitForTimeout(250);
  const fullBox = await r.page.locator("#chost canvas").boundingBox();
  check("chart: full screen uses the whole phone screen", (await r.page.getAttribute("#cbox", "class")).includes("full") && fullBox.height > 600, JSON.stringify(fullBox));
  await r.page.screenshot({ path: path.join(SHOTS, "chart-fullscreen-phone.png") });
  await r.page.keyboard.press("Escape");
  check("chart: Escape leaves full screen", !(await r.page.getAttribute("#cbox", "class")).includes("full"));
  // currency: no stream, asking again
  await r.page.click('[data-mt-sel="EURUSD=X"]');
  await r.page.waitForFunction(() => ch.sym === "EURUSD=X" && ch.bars > 0);
  check("chart: currency pair without stream, refreshed by asking the API", await r.page.evaluate(() => ch.ws === null && !!ch.poll) && /Yahoo/.test(await r.page.textContent("#cstat")), await r.page.textContent("#cstat"));
  await r.page.evaluate(() => chartPollTick());
  await r.page.waitForTimeout(150);
  check("chart: refresh asks only for the last candles", r.calls.some((c) => c.action === "manual_chart" && c.symbol === "EURUSD=X" && c.limit === 3));
  check("chart: currency prices with 5 decimals", /1,12\d{3}/.test(await r.page.textContent("#clegend")), await r.page.textContent("#clegend"));
  check("chart: own EUR/USD short shown as line", await r.page.evaluate(() => ch.chart.lines.some((l) => l.label === "Dein Verkauf")));
  await r.page.evaluate(() => document.querySelector("#cbox").scrollIntoView({ block: "start" })); await r.page.waitForTimeout(150);
  await r.page.screenshot({ path: path.join(SHOTS, "chart-phone.png"), fullPage: false });
  await r.page.click('[data-mt-sel="BTCUSDT"]');
  await r.page.waitForFunction(() => ch.sym === "BTCUSDT" && !!ch.ws);
  // leaving the area stops the live connection
  await go(r.page, "maerkte");
  check("chart: leaving the area closes the live connection", await r.page.evaluate(() => ch.ws === null && !ch.poll));
  await r.page.click('[data-chart-sym="ETHUSDT"]');
  await r.page.waitForFunction(() => !document.querySelector('.view[data-view="handeln"]').hidden && ch.sym === "ETHUSDT" && ch.bars > 0);
  check("chart: 'Chart' in the markets area opens Ethereum", (await r.page.getAttribute('[data-mt-sel="ETHUSDT"]', "aria-pressed")) === "true");
  check("chart: no horizontal overflow on phone", await noOverflow(r.page));
  check("chart: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  // stream blocked (e.g. network): falls back to asking every 5 s
  r = await run("chart-fallback", fx.own, { width: 1280, height: 900 }, "dark", { hash: "#handeln", ws: "fail" });
  await r.page.waitForFunction(() => /nicht erreichbar/.test(document.querySelector("#cstat").textContent), null, { timeout: 20000 });
  check("chart-fallback: blocked stream falls back to asking every 5 s", await r.page.evaluate(() => !!ch.poll && ch.wsFails >= 3));
  await r.page.evaluate(() => document.querySelector("#mt-ticket").scrollIntoView({ block: "start" })); await r.page.waitForTimeout(150);
  await r.page.screenshot({ path: path.join(SHOTS, "chart-desktop-dark.png") });
  check("chart-fallback: no JS errors", r.errors.length === 0, r.errors.join(" | "));
  await r.ctx.close();

  await browser.close();
  srv.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
