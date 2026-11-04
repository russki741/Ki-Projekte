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
    page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|net::|401|409|500/.test(m.text())) errors.push("console: " + m.text()); });
    page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
    let current = scenario; let tradesOverride = null; let bbCurrent = opts.bybit || bbfx.base; let bbReply = null;
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
    return { page, ctx, errors, dialogs, calls, bbCalls, setScenario: (s) => (current = s), setTrades: (f) => (tradesOverride = f), setBybit: (f) => (bbCurrent = f), setBbReply: (f) => (bbReply = f) };
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

  await browser.close();
  srv.close();
  const fails = results.filter((x) => !x.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
