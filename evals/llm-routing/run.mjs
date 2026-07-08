// evals/llm-routing/run.mjs
// Guards the per-agent LLM routing map + resolver, and callLLM's fail-safe contract (with no keys it
// throws cleanly instead of hanging or hitting the network). Offline.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { CHAINS, AGENT_CHAIN, chainFor, VISION_PROVIDERS } from "../../lib/routing.js";
import { callLLM } from "../../lib/llm.js";

const KNOWN = new Set(["openai", "gemini", "groq", "cerebras", "mistral", "openrouter"]);

export async function run() {
  const resolve = runCases("routing · chainFor()", [
    { id: "cto->openai-first", ok: chainFor("cto").order[0] === "openai" },
    { id: "journal->groq-first", ok: chainFor("journal").order[0] === "groq" && chainFor("journal").order.includes("openai") },
    { id: "journal-no-freetier-fallback", ok: !chainFor("journal").order.some((p) => ["cerebras", "mistral", "openrouter"].includes(p)) },
    { id: "briefing->openai-first", ok: chainFor("briefing").order[0] === "openai" },
    { id: "unknown->public-default", ok: chainFor("zzz").order[0] === "gemini" },
    { id: "explicit-override-wins", ok: chainFor("journal", "heavy").order[0] === "openai" },
    { id: "vision->gemini-first", ok: chainFor("cto", null, true).order[0] === "gemini" },
    { id: "brand-uses-flash-lite", ok: chainFor("brand-manager").geminiModel === "gemini-2.5-flash-lite" },
  ], (c) => ({ ok: c.ok }));

  const integrity = runCases("routing · map integrity", Object.entries(CHAINS).map(([name, c]) => ({ id: name, c })), ({ c }) => {
    const okProviders = c.order.every((p) => KNOWN.has(p));
    const hasModel = typeof c.openaiModel === "string";
    return { ok: okProviders && hasModel, note: okProviders ? (hasModel ? "" : "missing openaiModel") : "unknown provider" };
  });

  // callLLM must fail cleanly (not hang / not hit network) when no keys are configured.
  for (const p of ["OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[p];
  process.env.AGENT_NAME = "cto";
  let threw = false;
  try { await callLLM("hello"); } catch { threw = true; }
  const failsafe = runCases("routing · callLLM fail-safe", [
    { id: "no-keys-throws-cleanly", ok: threw },
    { id: "vision-providers-set", ok: VISION_PROVIDERS.has("gemini") && VISION_PROVIDERS.has("openai") && !VISION_PROVIDERS.has("groq") },
    { id: "every-agent-maps-to-real-chain", ok: Object.values(AGENT_CHAIN).every((c) => CHAINS[c]) },
  ], (c) => ({ ok: c.ok }));

  return [resolve, integrity, failsafe];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
