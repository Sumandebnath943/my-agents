// agents/10-linkedin/sources.js
// AI-focused news the LinkedIn engine reacts to. Google News "when:1d" surfaces
// same-day developments; HN + Simon Willison add depth. Add/remove freely.
export const AI_FEEDS = [
  "https://news.google.com/rss/search?q=artificial+intelligence+when:1d&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(OpenAI+OR+Anthropic+OR+%22Google+DeepMind%22+OR+Claude+OR+Gemini)+when:1d&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=(%22AI+agents%22+OR+LLM+OR+%22AI+product%22)+when:1d&hl=en-US&gl=US&ceid=US:en",
  "https://hnrss.org/newest?q=AI+OR+LLM+OR+agent&points=50",
  "https://simonwillison.net/atom/everything/",
];
