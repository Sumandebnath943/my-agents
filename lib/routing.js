// lib/routing.js — per-agent LLM routing: which provider each agent tries first, and the exact
// fallback order after it. Data-only (no logic beyond a resolver) so the dashboard can mirror it
// for display (see agents-dashboard lib/agents-meta.js — keep the two in sync).
//
// Providers: openai (paid, primary for heavy/quality) · gemini · groq · cerebras · mistral ·
// openrouter (all free). Only `gemini` and `openai` can do VISION. Every chain is FAIL-SAFE: a
// provider with no key is skipped at call time (lib/llm.js callLLM), so with no OpenAI key set the
// chains run exactly as before.

// Named chains. `openaiModel` = which OpenAI model to use when the chain reaches openai;
// `geminiModel` (optional) overrides the Gemini model for that chain.
export const CHAINS = {
  heavy:      { order: ["openai", "groq", "gemini", "openrouter"],            openaiModel: "gpt-4o" },
  quality:    { order: ["openai", "gemini", "groq", "openrouter"],            openaiModel: "gpt-4o-mini" },
  briefing:   { order: ["openai", "gemini", "groq", "mistral", "openrouter"], openaiModel: "gpt-4o-mini" },
  brand:      { order: ["openai", "gemini", "groq", "openrouter"],            openaiModel: "gpt-4o-mini", geminiModel: "gemini-2.5-flash-lite" },
  public:     { order: ["gemini", "groq", "mistral", "openrouter", "openai"], openaiModel: "gpt-4o-mini" },
  publicgroq: { order: ["groq", "gemini", "mistral", "openrouter", "openai"], openaiModel: "gpt-4o-mini" },
  lite:       { order: ["gemini", "groq", "mistral"],                         openaiModel: "gpt-4o-mini" },
  private:    { order: ["groq", "openai"],                                    openaiModel: "gpt-4o-mini" },
  selfheal:   { order: ["groq", "cerebras", "mistral", "openai"],             openaiModel: "gpt-4o-mini" },
  vision:     { order: ["gemini", "openai"],                                  openaiModel: "gpt-4o" },
};

// Agent (AGENT_NAME env) -> chain. Anything unlisted defaults to `public`. Handlers that run under a
// shared AGENT_NAME (e.g. the webhook's "migi") pass an explicit { chain } instead — see callLLM.
export const AGENT_CHAIN = {
  // OpenAI-primary
  "cto": "heavy", "review": "heavy",
  "brand-manager": "brand",
  "job-agent": "quality", "linkedin": "quality", "build-compass": "quality",
  "outreach-scout": "quality", "skillgap": "quality",
  "briefing": "briefing",
  // Free-primary
  "buildinpublic": "publicgroq", "team-manager": "publicgroq",
  "readlater": "public",
  "standup": "lite", "deps": "lite", "video-digest": "lite", "launch": "lite", "uptime": "lite",
  "selfheal": "selfheal",
  // Private (Groq -> OpenAI only; no free-tier training risk)
  "journal": "private", "finance": "private", "habits": "private", "expenses": "private",
  // Vision
  "notes": "vision", "browser": "vision",
};

export const VISION_PROVIDERS = new Set(["gemini", "openai"]);

// Resolve the chain for an agent. A vision call defaults to the `vision` chain; an explicit
// `override` (opts.chain) always wins.
export function chainFor(agent, override, vision) {
  const name = override || (vision ? "vision" : AGENT_CHAIN[agent]) || "public";
  return CHAINS[name] || CHAINS.public;
}
