import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { aggregateFills, bpsDiff, floorToStep, hmacHex, signPayload, stepDecimals, BASE } from "./bybit.ts";

test("the client only knows the demo host", () => {
  assert.equal(BASE, "https://api-demo.bybit.com");
});

test("HMAC-SHA256 matches the Node reference implementation", async () => {
  const secret = "testsecret";
  const msg = "1700000000000" + "TESTKEY" + "5000" + '{"category":"spot","symbol":"BTCUSDT"}';
  const ref = createHmac("sha256", secret).update(msg).digest("hex");
  assert.equal(await hmacHex(secret, msg), ref);
  assert.equal(await signPayload({ key: "TESTKEY", secret }, "1700000000000", '{"category":"spot","symbol":"BTCUSDT"}'), ref);
});

test("floorToStep never rounds up and keeps the exchange precision", () => {
  assert.equal(floorToStep(0.0012349, "0.000001"), "0.001234");
  assert.equal(floorToStep(0.00099999999, "0.000001"), "0.000999");
  assert.equal(floorToStep(1.9999, "0.01"), "1.99");
  assert.equal(floorToStep(12.7, "1"), "12");
  assert.equal(floorToStep(0.30000000000000004, "0.1"), "0.3");
  assert.equal(floorToStep(-1, "0.1"), "0");
  assert.equal(floorToStep(0, "0.1"), "0");
  assert.equal(stepDecimals("0.000001"), 6);
  assert.equal(stepDecimals("1"), 0);
  assert.equal(stepDecimals("0.0100"), 2);
});

test("fills: fee in the base coin reduces the quantity that can be sold back", () => {
  const f = aggregateFills(
    [
      { execType: "Trade", execQty: "0.010", execPrice: "60000", execValue: "600", execFee: "0.00001", feeCurrency: "BTC" },
      { execType: "Trade", execQty: "0.005", execPrice: "60010", execValue: "300.05", execFee: "0.000005", feeCurrency: "BTC" },
      { execType: "Funding", execQty: "9", execPrice: "1", execValue: "9", execFee: "1", feeCurrency: "USDT" },
    ],
    "BTC", "USDT",
  );
  assert.equal(f.n, 2);
  assert.ok(Math.abs(f.qty - 0.015) < 1e-12);
  assert.ok(Math.abs(f.value - 900.05) < 1e-9);
  assert.ok(Math.abs(f.price - 900.05 / 0.015) < 1e-6);
  assert.ok(Math.abs(f.netBase - (0.015 - 0.000015)) < 1e-12);
  assert.equal(f.feeQuote, 0);
});

test("fills: fee in the quote coin leaves the quantity untouched", () => {
  const f = aggregateFills([{ execType: "Trade", execQty: "0.2", execPrice: "100", execValue: "20", execFee: "0.02", feeCurrency: "USDT" }], "SOL", "USDT");
  assert.equal(f.netBase, 0.2);
  assert.equal(f.feeQuote, 0.02);
  assert.equal(aggregateFills([], "SOL", "USDT").qty, 0);
});

test("sign errors from Bybit do not leak the signing string (it contains the API key)", async () => {
  const real = globalThis.fetch;
  let seenUrl = "";
  (globalThis as any).fetch = async (url: string) => {
    seenUrl = url;
    return new Response(JSON.stringify({ retCode: 10004, retMsg: "Error sign, please check your signature generation algorithm: origin_string[1700000000000MYKEY5000accountType=UNIFIED]" }), { status: 200 });
  };
  try {
    const { signedRequest } = await import("./bybit.ts");
    const r = await signedRequest({ key: "MYKEY", secret: "s" }, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
    assert.ok(!JSON.stringify(r.body).includes("MYKEY"));
    assert.ok(r.body.retMsg.includes("origin_string[...]"));
    assert.ok(seenUrl.startsWith("https://api-demo.bybit.com/"), seenUrl);
  } finally {
    globalThis.fetch = real;
  }
});

test("slippage versus paper: positive means worse for us on both sides", () => {
  assert.ok(Math.abs(bpsDiff(100.1, 100, "Buy")! - 10) < 1e-9);
  assert.ok(Math.abs(bpsDiff(99.9, 100, "Sell")! - 10) < 1e-9);
  assert.ok(bpsDiff(99.9, 100, "Buy")! < 0);
  assert.equal(bpsDiff(0, 100, "Buy"), null);
});
