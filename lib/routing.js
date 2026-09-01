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
// ⚠️ TWO CEILINGS DECIDE THIS ORDER, AND THEY PULL IN OPPOSITE DIRECTIONS.
//
// Measured live on 1 Sep 2026 from the providers' own rate-limit headers:
//
//   Groq    openai/gpt-oss-120b   1,000 req/DAY   ·   8,000 tokens/MINUTE   ← smallest token window
//   Mistral mistral-small-latest     50 req/min   ·  50,000 tokens/minute
//   Gemini  gemini-2.5-flash         10 req/min   · ~250,000 tokens/minute  ← smallest REQUEST rate
//   Cohere  command-a-03-2025    ~20 req/min (documented; it sends no headers), ~1,000/MONTH
//
// So: Groq is the wrong hop for BIG prompts, and Gemini is the wrong hop for CHATTY agents. Eight
// agents already depend on Gemini as their PRIMARY (readlater, standup, deps, video-digest, launch,
// uptime, notes, browser) and they all share that one 10 rpm project quota — so promoting Gemini in
// a fallback chain quietly takes request budget away from the agents that need it first. That is
// why `heavy` was written groq-before-gemini originally, and it stays that way.
//
// Ordering is therefore per-chain, from each chain's MEASURED call sizes (30-day medians):
//
//   briefing  12,426 tok  → over Groq's whole minute. Mistral must come first.
//   quality    1,962 tok median but p90 9,889 and 17,563 max (build-compass, outreach-scout,
//              linkedin) → Mistral before Groq.
//   heavy      2,633 tok (cto), 1,509 (review) → comfortably inside Groq. ORIGINAL ORDER KEPT.
//   brand        432 tok → tiny, Groq is ideal.
//
// COHERE sits last-but-one everywhere it appears: it is a strong 111B model with 288k context, but
// its free trial is ~1,000 calls a MONTH and that budget is shared with the dashboard's ECHO
// reranker. It is a depth hop, never a workhorse — and it is deliberately ABSENT from `private`,
// which admits no free-tier provider at all (see the journal privacy decision).
export const CHAINS = {
  heavy:      { order: ["openai", "groq", "gemini", "mistral", "cohere", "openrouter"], openaiModel: "gpt-4o" },
  quality:    { order: ["openai", "gemini", "mistral", "groq", "cohere", "openrouter"], openaiModel: "gpt-4o-mini" },
  briefing:   { order: ["openai", "gemini", "mistral", "groq", "cohere", "openrouter"], openaiModel: "gpt-4o-mini" },
  brand:      { order: ["openai", "gemini", "groq", "cohere", "openrouter"],  openaiModel: "gpt-4o-mini", geminiModel: "gemini-2.5-flash-lite" },
  // Cohere is deliberately NOT here. These two already OPEN on a healthy free provider, so they
  // rarely reach a deep hop at all — and every chain Cohere joins is another workflow that must
  // carry the key. Spending a ~1,000/month budget on chains that are not failing is how a depth
  // hop quietly becomes a workhorse.
  public:     { order: ["gemini", "groq", "mistral", "openrouter", "openai"], openaiModel: "gpt-4o-mini" },
  publicgroq: { order: ["groq", "gemini", "mistral", "openrouter", "openai"], openaiModel: "gpt-4o-mini" },
  lite:       { order: ["gemini", "groq", "mistral"],                         openaiModel: "gpt-4o-mini" },
  private:    { order: ["groq", "openai"],                                    openaiModel: "gpt-4o-mini" },
  // Cerebras sits AFTER Mistral: its free tier is 5 req/min, too tight to absorb a burst as a
  // first failover, but fine as a deeper backstop that is only reached when Mistral is down too.
  selfheal:   { order: ["groq", "mistral", "cerebras", "openai"],             openaiModel: "gpt-4o-mini" },
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
