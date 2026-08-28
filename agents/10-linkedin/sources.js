// agents/10-linkedin/sources.js
// AI news the LinkedIn engine reacts to.
//
// NO GOOGLE NEWS. Measured 2026-08-29: Google News RSS `<link>` is a news.google.com interstitial
// that only redirects via client-side JavaScript. Following it returns a ~580 KB Google page, and
// the real article URL appears NOWHERE in that HTML (checked — only analytics/Angular URLs). Its
// `<description>` is likewise just an `<a href>` wrapper, not a summary.
//
// That is why the drafting agent used to hallucinate: with Google News links it could never read
// the article, only the headline. Every feed below was tested to return a REAL, directly
// fetchable publisher URL, so `scrapeClean()` can pull the actual story before writing about it.
//
// Add freely — but before adding a feed, confirm its <link> points at the publisher, not an
// aggregator redirect.
export const AI_FEEDS = [
  // Publisher feeds — real links, scrapeable.
  "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  "https://venturebeat.com/category/ai/feed/",
  "https://arstechnica.com/ai/feed/",
  "https://www.technologyreview.com/topic/artificial-intelligence/feed",
  "https://techcrunch.com/category/artificial-intelligence/feed/",
  // Primary sources — announcements straight from the labs.
  "https://openai.com/news/rss.xml",
  "https://deepmind.google/blog/rss.xml",
  "https://huggingface.co/blog/feed.xml",
  // Depth + practitioner signal.
  "https://hnrss.org/newest?q=AI+OR+LLM+OR+agent&points=50",
  "https://simonwillison.net/atom/everything/",
];

// Sites whose anti-bot layer defeats even Firecrawl, so a scrape returns the challenge page rather
// than the story. Their headlines are still worth curating — the draft path just goes straight to
// search enrichment instead of wasting a scrape call. TechCrunch measured 2026-08-29 (Cloudflare).
export const SCRAPE_BLOCKED = ["techcrunch.com"];
