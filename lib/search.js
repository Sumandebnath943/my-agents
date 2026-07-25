// lib/search.js — real-time web search via Tavily (AI-optimized results), ceiling-guarded.
// Baseline is an EMPTY result set, so any caller simply proceeds without web enrichment when Tavily
// is absent, over its free ceiling, or erroring. Search is always additive — it never blocks a run.
import { withCeiling } from "./tier.js";

export const searchEnabled = () => !!process.env.TAVILY_API_KEY;

async function tavily(query, max, opts = {}) {
  const body = { api_key: process.env.TAVILY_API_KEY, query, max_results: max, search_depth: opts.depth || "basic" };
  // Domain scoping is how a caller says "only results from these sites" — far more reliable than
  // a `site:` operator in the query text, which Tavily treats as ordinary words.
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;
  if (Number.isFinite(opts.days)) body.days = opts.days;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results?.map((r) => ({ title: r.title, url: r.url, content: r.content })) || [];
}

/**
 * Web search results [{title,url,content}] — empty array when Tavily is unavailable.
 * @param {string} query
 * @param {{max?: number, includeDomains?: string[], excludeDomains?: string[], days?: number, depth?: "basic"|"advanced"}} [opts]
 */
export async function webSearch(query, { max = 5, ...opts } = {}) {
  if (!searchEnabled()) return [];
  const { result } = await withCeiling("tavily", () => tavily(query, max, opts), async () => []);
  return result;
}
