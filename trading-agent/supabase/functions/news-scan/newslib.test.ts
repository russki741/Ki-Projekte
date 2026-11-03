import { test } from "node:test";
import assert from "node:assert/strict";
import { FRESH_MS, decodeEntities, parseFeed, relevant, scoreItem } from "./newslib.ts";

const NOW = Date.parse("2026-10-22T05:00:00Z");
const item = (title: string, ageMin: number | null, summary = "") => ({
  title,
  url: "https://example.com/" + encodeURIComponent(title),
  publishedMs: ageMin === null ? null : NOW - ageMin * 60000,
  summary,
});

test("parseFeed: RSS 2.0 with CDATA, entities and pubDate", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Fed holds rates &amp; signals patience]]></title><link>https://x.test/a</link>
      <pubDate>Wed, 22 Oct 2026 04:30:00 GMT</pubDate><description><![CDATA[<p>The Fed kept rates unchanged.</p>]]></description></item>
    <item><title>Second &quot;item&quot;</title><link>https://x.test/b</link></item>
    <item><title>No link here</title></item>
  </channel></rss>`;
  const r = parseFeed(xml);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "Fed holds rates & signals patience");
  assert.equal(r[0].url, "https://x.test/a");
  assert.equal(r[0].publishedMs, Date.parse("2026-10-22T04:30:00Z"));
  assert.equal(r[0].summary, "The Fed kept rates unchanged.");
  assert.equal(r[1].title, 'Second "item"');
  assert.equal(r[1].publishedMs, null);
});

test("parseFeed: Atom entry with href link and updated date", () => {
  const xml = `<feed><entry><title>Atom headline</title><link rel="alternate" href="https://x.test/atom?a=1&amp;b=2"/>
    <updated>2026-10-22T04:00:00Z</updated><summary>text</summary></entry></feed>`;
  const r = parseFeed(xml);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, "https://x.test/atom?a=1&b=2");
  assert.equal(r[0].publishedMs, Date.parse("2026-10-22T04:00:00Z"));
});

test("decodeEntities: numeric and named", () => {
  assert.equal(decodeEntities("a &#8217; b &#x2019; &lt;c&gt;"), "a ’ b ’ <c>");
});

test("fresh central-bank rate decision is high impact for both markets", () => {
  const s = scoreItem(item("Fed holds rates steady, Powell signals patience", 20), NOW);
  assert.equal(s.impact, "high");
  assert.deepEqual([...s.markets].sort(), ["crypto", "forex"]);
  assert.ok(s.tags.includes("rate_decision"));
});

test("the same headline is only medium when it is old or undated (no trading pause)", () => {
  assert.equal(scoreItem(item("Fed holds rates steady, Powell signals patience", FRESH_MS / 60000 + 5), NOW).impact, "medium");
  assert.equal(scoreItem(item("Fed holds rates steady, Powell signals patience", null), NOW).impact, "medium");
});

test("crypto exchange hack: crypto only, not forex", () => {
  const s = scoreItem(item("Bitcoin plunges after exchange hack drains hot wallet", 10), NOW);
  assert.deepEqual(s.markets, ["crypto"]);
  assert.equal(s.impact, "high");
  assert.ok(s.score < 0);
});

test("generic non-financial 'crash' headline stays irrelevant", () => {
  const s = scoreItem(item("Plane crash investigation continues in the mountains", 5), NOW);
  assert.equal(s.impact, "low");
  assert.equal(relevant(s), false);
});

test("war headline alone is at most medium (cannot pause trading by itself)", () => {
  const s = scoreItem(item("Missile strike hits port, oil and stocks fall on market fears", 5), NOW);
  assert.equal(s.impact, "medium");
  assert.deepEqual([...s.markets].sort(), ["crypto", "forex"]);
});

test("inflation data is medium and tagged for forex", () => {
  const s = scoreItem(item("US inflation cools more than expected, dollar slips", 30), NOW);
  assert.equal(s.impact, "medium");
  assert.ok(s.markets.includes("forex"));
  assert.ok(s.tags.includes("inflation_jobs"));
});

test("crypto regulation needs a crypto word", () => {
  assert.ok(scoreItem(item("SEC approves new bitcoin ETF", 5), NOW).tags.includes("crypto_regulation"));
  assert.ok(!scoreItem(item("SEC charges a retail chain over accounting", 5), NOW).tags.includes("crypto_regulation"));
});

test("tone score: positive, negative, neutral", () => {
  assert.ok(scoreItem(item("Bitcoin surges to record high as ETF inflows jump", 5), NOW).score > 0);
  assert.ok(scoreItem(item("Euro falls and dollar jumps; markets fear recession", 5), NOW).score <= 0.34);
  assert.equal(scoreItem(item("Company opens new office", 5), NOW).score, 0);
});

test("future-dated item is never fresh", () => {
  const it = { ...item("Fed holds rates steady", 0), publishedMs: NOW + 60 * 60000 };
  assert.equal(scoreItem(it, NOW).impact, "medium");
});
