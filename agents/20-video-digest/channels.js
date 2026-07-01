// agents/18-video-digest/channels.js
// Add a channel by pasting its URL or @handle below. Optional flag:
//   aiOnly: true  -> include ONLY AI-related uploads from that channel (for general-news ones).
export const CHANNELS = [
  // --- Your picks ---
  { url: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ" },
  { url: "https://www.youtube.com/@Mrwhosetheboss" },
  { url: "https://www.youtube.com/@NetworkChuck" },
  { url: "https://www.youtube.com/channel/UCoiTL7aN1lzA4C5J3_-PLlQ" },
  { url: "https://www.youtube.com/channel/UC_RovKmk0OCbuZjA8f08opw" },
  { url: "https://www.youtube.com/@vaibhavsisinty" },
  { url: "https://www.youtube.com/@SandeepSwadia" },
  { url: "https://www.youtube.com/@IBMTechnology", aiOnly: true },
  { url: "https://www.youtube.com/@mikeynocode" },
  { url: "https://www.youtube.com/@nateherk" },
  { url: "https://www.youtube.com/@anthropic-ai" },
  { url: "https://www.youtube.com/@claude" },
  { url: "https://www.youtube.com/@OpenAI" },
  { url: "https://www.youtube.com/@googledeepmind" },
  { url: "https://www.youtube.com/@NVIDIA" },
  { url: "https://www.youtube.com/@Firstpost", aiOnly: true },
  { url: "https://www.youtube.com/@Reuters", aiOnly: true },
  { url: "https://www.youtube.com/@aishwaryasrinivasan" },
  { url: "https://www.youtube.com/@LinusTechTips" },
  { url: "https://www.youtube.com/@techlinked" },

  // --- Curated top AI voices (so you miss no AI news / trends) ---
  { url: "https://www.youtube.com/@TwoMinutePapers" },      // AI research, digestible
  { url: "https://www.youtube.com/@mreflow" },              // Matt Wolfe — AI tools/news
  { url: "https://www.youtube.com/@aiexplained-official" }, // AI Explained — deep news
  { url: "https://www.youtube.com/@matthew_berman" },       // models, agents, hands-on
  { url: "https://www.youtube.com/@WesRoth" },              // daily AI news
  { url: "https://www.youtube.com/@TheAIGRID" },            // trendy AI news
  { url: "https://www.youtube.com/@bycloudAI" },            // research trends
  { url: "https://www.youtube.com/@1littlecoder" },         // practical AI
  { url: "https://www.youtube.com/@aiadvantage" },          // AI tools/workflows
  { url: "https://www.youtube.com/@ColeMedin" },            // AI agents / building
];

// Words used to decide "AI-related" for aiOnly channels (matched against the video title).
export const AI_KEYWORDS = [
  "ai", "a\\.i\\.", "artificial intelligence", "llm", "llms", "gpt", "chatgpt", "genai",
  "gemini", "claude", "anthropic", "openai", "deepmind", "machine learning", "deep learning",
  "neural", "agent", "agents", "chatbot", "model", "models", "nvidia", "copilot", "prompt",
  "robot", "robotics", "agi",
];
