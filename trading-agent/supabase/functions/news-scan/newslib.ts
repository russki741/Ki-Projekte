// News parsing and keyword scoring. Pure functions: no I/O, no Deno APIs (also run under Node tests).
// This is a transparent keyword heuristic, NOT a language model. It only decides (a) which markets a headline touches and
// (b) whether a fresh headline is important enough to pause new entries for a while ("news hold").

export type RawItem = { title: string; url: string; publishedMs: number | null; summary: string };
export type Impact = "low" | "medium" | "high";
export type Scored = {
  title: string;
  url: string;
  publishedMs: number | null;
  score: number; // -1 (negative tone) .. +1 (positive tone), display only
  impact: Impact;
  markets: string[]; // subset of ["crypto", "forex"]
  tags: string[];
  points: number;
};

export const FRESH_MS = 90 * 60 * 1000; // only headlines younger than this can be "high"

// ---------- feed parsing ----------

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function unwrap(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities((cdata ? cdata[1] : raw).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function tagText(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unwrap(m[1]) : null;
}

function linkOf(block: string): string | null {
  const text = tagText(block, "link");
  if (text && /^https?:\/\//i.test(text)) return text;
  const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (href) return decodeEntities(href[1]).trim();
  const guid = tagText(block, "guid");
  return guid && /^https?:\/\//i.test(guid) ? guid : null;
}

export function parseFeed(xml: string): RawItem[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: RawItem[] = [];
  for (const b of blocks) {
    const title = tagText(b, "title");
    const url = linkOf(b);
    if (!title || !url) continue;
    const dateRaw = tagText(b, "pubDate") ?? tagText(b, "published") ?? tagText(b, "updated") ?? tagText(b, "dc:date");
    const t = dateRaw ? Date.parse(dateRaw) : NaN;
    const summary = (tagText(b, "description") ?? tagText(b, "summary") ?? "").slice(0, 400);
    out.push({ title: title.slice(0, 300), url: url.slice(0, 500), publishedMs: Number.isFinite(t) ? t : null, summary });
  }
  return out;
}

// ---------- scoring ----------

type Group = { tag: string; weight: number; res: RegExp[]; requiresCrypto?: boolean; requiresFinance?: boolean; markets: ("crypto" | "forex")[] };

const CRYPTO_WORDS = /\b(bitcoin|btc|ethereum|ether|eth|solana|sol|crypto\w*|stablecoins?|binance|bybit|coinbase|tether|usdt|defi|blockchain|altcoins?)\b/i;
const FOREX_WORDS = /\b(euro|eur|dollar|usd|ecb|fed|federal reserve|fomc|treasur(?:y|ies)|yields?|powell|lagarde|forex|currency|currencies)\b/i;

const FINANCE_CONTEXT = /\b(markets?|stocks?|shares|equit(?:y|ies)|exchange|banks?|dollar|euro|yields?|economy|economic|trading|investors?|currency|currencies)\b/i;

const GROUPS: Group[] = [
  {
    tag: "rate_decision",
    weight: 4,
    markets: ["forex", "crypto"],
    res: [/\bfomc\b/i, /\brate decision\b/i, /\b(raises?|cuts?|holds?|lowers?|hikes?|keeps?|leaves?|slashes)\s+(?:its\s+|key\s+|benchmark\s+|interest\s+|policy\s+)*rates?\b/i, /\bemergency (?:rate|meeting)\b/i],
  },
  {
    tag: "shock",
    weight: 3,
    requiresFinance: true,
    markets: ["crypto", "forex"],
    res: [/\b(crash(?:es|ed)?|plunges?|plummets?|collapses?|collapsed)\b/i, /\b(bankrupt\w*|insolven\w*|defaults?|bank run)\b/i, /\b(hack(?:ed|s)?|exploit(?:ed)?|breach)\b/i, /\b(halts?|suspends?)\s+(?:trading|withdrawals?)\b/i],
  },
  {
    tag: "war_escalation",
    weight: 3,
    requiresFinance: true,
    markets: ["crypto", "forex"],
    res: [/\b(invasion|invades?|missiles?|airstrikes?|nuclear|blockade|declares? war|coup)\b/i],
  },
  {
    tag: "inflation_jobs",
    weight: 2,
    markets: ["forex", "crypto"],
    res: [/\b(inflation|cpi|ppi|pce)\b/i, /\b(non-?farm|payrolls?|unemployment rate|jobless claims)\b/i, /\b(gdp|recession)\b/i],
  },
  {
    tag: "trade_policy",
    weight: 2,
    markets: ["forex", "crypto"],
    res: [/\btariffs?\b/i, /\b(sanctions?|embargo|trade war|export controls?)\b/i, /\bopec\b/i],
  },
  {
    tag: "crypto_regulation",
    weight: 2,
    markets: ["crypto"],
    requiresCrypto: true,
    res: [/\b(sec|cftc|etf|lawsuit|sues|banned?|approv\w+|regulat\w+)\b/i],
  },
  {
    tag: "central_bank",
    weight: 1,
    markets: ["forex"],
    res: [/\b(fed|federal reserve|ecb|bank of england|bank of japan|boj|snb|powell|lagarde|monetary policy)\b/i],
  },
];

const POS = /\b(surges?|rallies|rally|soars?|gains?|jumps?|record high|rebounds?|beats?|bullish|upgrades?|recovers?|approves?|approved)\b/gi;
const NEG = /\b(plunges?|crash(?:es|ed)?|slumps?|falls?|drops?|tumbles?|bans?|banned|hack(?:ed)?|collapses?|bearish|downgrades?|fears?|warns?|sell-?off|losses?|defaults?|lawsuit|sues)\b/gi;

export function scoreItem(it: RawItem, nowMs: number): Scored {
  const text = `${it.title}. ${it.summary}`;
  const tags: string[] = [];
  const markets = new Set<string>();
  let points = 0;
  const isCrypto = CRYPTO_WORDS.test(text);
  for (const g of GROUPS) {
    if (g.requiresCrypto && !isCrypto) continue;
    if (g.requiresFinance && !isCrypto && !FINANCE_CONTEXT.test(text)) continue;
    const matches = g.res.filter((re) => re.test(text)).length;
    if (!matches) continue;
    tags.push(g.tag);
    points += g.weight * Math.min(2, matches);
    for (const m of g.markets) markets.add(m);
  }
  if (isCrypto) {
    markets.add("crypto");
    tags.push("crypto");
  }
  if (FOREX_WORDS.test(text)) {
    markets.add("forex");
    if (!tags.includes("forex")) tags.push("forex");
  }
  // Pure crypto shocks (e.g. an exchange hack) concern crypto only; macro shocks concern both.
  if (tags.includes("shock") && isCrypto && !tags.some((t) => ["rate_decision", "war_escalation", "inflation_jobs", "trade_policy", "central_bank"].includes(t))) {
    markets.delete("forex");
  }
  const pos = (text.match(POS) ?? []).length;
  const neg = (text.match(NEG) ?? []).length;
  const score = pos + neg === 0 ? 0 : Math.round(((pos - neg) / (pos + neg)) * 100) / 100;

  let impact: Impact = points >= 4 ? "high" : points >= 2 ? "medium" : "low";
  const fresh = it.publishedMs !== null && nowMs - it.publishedMs <= FRESH_MS && it.publishedMs - nowMs <= 10 * 60 * 1000;
  if (impact === "high" && !fresh) impact = "medium"; // old or undated headlines never trigger a trading pause
  return { title: it.title, url: it.url, publishedMs: it.publishedMs, score, impact, markets: [...markets], tags, points };
}

/** Worth storing: touches a market or carries any keyword weight. */
export const relevant = (s: Scored) => s.markets.length > 0 || s.points > 0;
