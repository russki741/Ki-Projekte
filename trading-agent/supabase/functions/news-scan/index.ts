// news-scan: reads public RSS feeds (finance, central banks, world news), scores headlines with a keyword heuristic and stores them.
// Fresh high-impact headlines create a notification; agent-tick then pauses NEW entries in the affected markets for 30 minutes.
// SIMULATION ONLY: public feeds, no keys, no orders. Writes only to agent_core.news_items / news_sources / notifications.
// Auth: shared secret in header x-agent-secret (Vault secret agent_cron_secret); verify_jwt is off.
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";
import { parseFeed, relevant, scoreItem } from "./newslib.ts";

const SOURCES: { source: string; url: string }[] = [
  { source: "fed", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { source: "ecb", url: "https://www.ecb.europa.eu/rss/press.html" },
  { source: "bbc_business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { source: "bbc_world", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "google_macro", url: "https://news.google.com/rss/search?q=federal+reserve+OR+ecb+interest+rates&hl=en-US&gl=US&ceid=US:en" },
];
const PER_SOURCE_LIMIT = 25;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function fetchFeed(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/rss+xml, application/xml, text/xml, */*", "user-agent": "trading-sim-agent/0.1 (paper-trading research)" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.text()).slice(0, 2_000_000);
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const provided = req.headers.get("x-agent-secret");
  if (!provided) return json({ error: "unauthorized" }, 401);

  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
  try {
    const [secret] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'agent_cron_secret'`;
    if (!secret || !safeEqual(provided, secret.decrypted_secret)) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const dry = body?.dry_run === true; // dry run: fetch + score, write nothing, return samples

    const now = Date.now();
    const fetched = await Promise.all(
      SOURCES.map(async (s) => {
        try {
          const items = parseFeed(await fetchFeed(s.url))
            .sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0))
            .slice(0, PER_SOURCE_LIMIT);
          return { ...s, ok: true as const, error: null as string | null, scored: items.map((i) => scoreItem(i, now)) };
        } catch (e) {
          return { ...s, ok: false as const, error: msg(e).slice(0, 200), scored: [] as ReturnType<typeof scoreItem>[] };
        }
      }),
    );

    const report: any[] = [];
    let newHigh = 0;
    for (const f of fetched) {
      const keep = f.scored.filter(relevant);
      let inserted = 0;
      if (!dry) {
        for (const s of keep) {
          const rows = await sql`
            insert into agent_core.news_items (source, title, url, published_at, score, impact, markets, tags)
            values (${f.source}, ${s.title}, ${s.url}, ${s.publishedMs === null ? null : new Date(s.publishedMs).toISOString()}, ${s.score}, ${s.impact}, ${s.markets}, ${s.tags})
            on conflict (url) do nothing returning id`;
          if (rows.length) {
            inserted++;
            if (s.impact === "high") {
              newHigh++;
              await sql`insert into agent_core.notifications (kind, title, body, payload)
                        values ('news', ${"Wichtige Nachricht: " + s.title.slice(0, 120)}, ${`Neue Einstiege in ${s.markets.join(" und ")} pausieren 30 Minuten. Quelle: ${f.source}.`},
                                ${sql.json({ source: f.source, url: s.url, markets: s.markets, tags: s.tags } as any)})`;
            }
          }
        }
        await sql`
          insert into agent_core.news_sources (source, url, ok, last_attempt_at, last_ok_at, items_seen, items_new, error)
          values (${f.source}, ${f.url}, ${f.ok}, now(), ${f.ok ? new Date(now).toISOString() : null}, ${f.scored.length}, ${inserted}, ${f.error})
          on conflict (source) do update set url = excluded.url, ok = excluded.ok, last_attempt_at = now(),
            last_ok_at = case when excluded.ok then now() else agent_core.news_sources.last_ok_at end,
            items_seen = excluded.items_seen, items_new = excluded.items_new, error = excluded.error`;
      }
      report.push({
        source: f.source, ok: f.ok, error: f.error, seen: f.scored.length, relevant: keep.length, new: inserted,
        high: keep.filter((s) => s.impact === "high").length, medium: keep.filter((s) => s.impact === "medium").length,
        sample: dry ? keep.slice(0, 3).map((s) => ({ title: s.title.slice(0, 100), impact: s.impact, markets: s.markets, tags: s.tags, score: s.score })) : undefined,
      });
    }
    return json({ status: "ok", dry_run: dry, new_high_impact: newHigh, sources: report });
  } catch (e) {
    console.error("news-scan failed", e);
    return json({ error: "internal", detail: msg(e).slice(0, 300) }, 500);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
