// lib/scrape.js — get clean, LLM-ready text for a URL.
// Firecrawl returns tidy markdown even for JS-heavy / anti-bot / paywalled-preview pages. When it's
// absent, over its free ceiling, or erroring, we fall straight back to the plain fetch+strip every
// agent used before — scraping never breaks, it just gets better when Firecrawl is available.
import { withCeiling } from "./tier.js";

// Baseline: the fetch + tag-strip approach used across the fleet (kept byte-for-byte compatible).
export async function plainFetch(url, max = 8000) {
  try {
    const html = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, max);
  } catch { return ""; }
}

async function firecrawlScrape(url, max) {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
  });
  if (!res.ok) throw new Error(`firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const md = (await res.json())?.data?.markdown || "";
  if (!md) throw new Error("firecrawl: empty markdown");
  return md.slice(0, max);
}

/** Clean text for a URL — Firecrawl when available (ceiling-guarded), else plain fetch+strip. */
export async function scrapeClean(url, { max = 8000 } = {}) {
  if (!process.env.FIRECRAWL_API_KEY) return plainFetch(url, max);
  const { result } = await withCeiling("firecrawl", () => firecrawlScrape(url, max), () => plainFetch(url, max));
  return result;
}
