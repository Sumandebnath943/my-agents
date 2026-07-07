// lib/search.js — real-time web search via Tavily (AI-optimized results), ceiling-guarded.
// Baseline is an EMPTY result set, so any caller simply proceeds without web enrichment when Tavily
// is absent, over its free ceiling, or erroring. Search is always additive — it never blocks a run.
import { withCeiling } from "./tier.js";

export const searchEnabled = () => !!process.env.TAVILY_API_KEY;

async function tavily(query, max) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: max, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).results?.map((r) => ({ title: r.title, url: r.url, content: r.content })) || [];
}

/** Web search results [{title,url,content}] — empty array when Tavily is unavailable. */
export async function webSearch(query, { max = 5 } = {}) {
  if (!searchEnabled()) return [];
  const { result } = await withCeiling("tavily", () => tavily(query, max), async () => []);
  return result;
}
