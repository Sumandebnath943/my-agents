// agents/12-briefing/sources.js
export const INTERESTS = ["AI agents", "LLMs", "Claude/Anthropic", "developer tools", "indie hacking", "startups"];

// A mix of aggregators, keyword news searches (catch big releases fast), and quality blogs.
// Google News "when:1d" searches surface breaking items (e.g. a new model release) same-day.
export const RSS_FEEDS = [
  "https://hnrss.org/frontpage?points=100",                                                      // Hacker News (popular)
  "https://news.google.com/rss/search?q=Anthropic+OR+Claude+when:1d&hl=en-US&gl=US&ceid=US:en",  // Claude/Anthropic news
  "https://news.google.com/rss/search?q=OpenAI+OR+LLM+when:1d&hl=en-US&gl=US&ceid=US:en",         // OpenAI / LLM news
  "https://news.google.com/rss/search?q=%22AI+agents%22+when:1d&hl=en-US&gl=US&ceid=US:en",        // AI agents news
  "https://techcrunch.com/feed/",                                                                 // TechCrunch
  "https://www.theverge.com/rss/index.xml",                                                       // The Verge
  "https://simonwillison.net/atom/everything/",                                                   // Simon Willison (deep AI coverage)
  // Add your own YouTube channels as RSS if you like:
  // "https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxx",
];
