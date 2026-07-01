// agents/12-briefing/sources.js
export const INTERESTS = ["AI agents", "LLMs", "developer tools", "indie hacking", "startups"];

// YouTube channel RSS = https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID
// (find a channel_id from the channel's page source — search "channelId" — or a lookup site)
export const RSS_FEEDS = [
  "https://hnrss.org/frontpage",                 // Hacker News front page
  "https://hnrss.org/newest?q=AI+agents",        // HN posts matching "AI agents"
  "https://hnrss.org/newest?q=LLM",              // HN posts matching "LLM"
  // Add YouTube channels you follow, e.g.:
  // "https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxx",
];
