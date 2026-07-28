// evals/llm-routing/run.mjs
// Guards the per-agent LLM routing map + resolver, and callLLM's fail-safe contract (with no keys it
// throws cleanly instead of hanging or hitting the network). Offline.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { CHAINS, AGENT_CHAIN, chainFor, VISION_PROVIDERS } from "../../lib/routing.js";
import { callLLM, _RPM, _OAI } from "../../lib/llm.js";

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

  // Pacing safety. Two failure modes we've actually hit:
  //   1. A provider's default model is retired, gets swapped, and the RPM map still holds the OLD
  //      model name — so the new one silently inherits the 10-rpm fallback instead of its real limit.
  //   2. A low-RPM provider sits EARLY in a chain, where a burst either 429s or forces a long gap on
  //      every request. Cerebras is 5 req/min (verified from its rate-limit headers), so any chain
  //      carrying both it and Mistral (30 rpm) must reach Mistral first.
  const LOW_RPM_LAST = ["cerebras"]; // providers too rate-limited to lead a chain
  const pacing = runCases("routing · pacing safety", [
    ...Object.entries(_OAI)
      .filter(([p]) => p !== "openai") // OpenAI is paid, generous, and priced separately
      .map(([provider, cfg]) => ({
        id: `rpm-entry-exists · ${provider} · ${cfg.defaultModel}`,
        ok: typeof _RPM[cfg.defaultModel] === "number",
      })),
    ...Object.entries(CHAINS)
      .filter(([, c]) => LOW_RPM_LAST.some((p) => c.order.includes(p)) && c.order.includes("mistral"))
      .map(([name, c]) => ({
        id: `low-rpm-provider-after-mistral · ${name}`,
        ok: LOW_RPM_LAST.every((p) => !c.order.includes(p) || c.order.indexOf("mistral") < c.order.indexOf(p)),
      })),
    { id: "cerebras-rpm-matches-verified-free-tier", ok: _RPM["gpt-oss-120b"] === 5 },
  ], (c) => ({ ok: c.ok }));

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

  return [resolve, integrity, pacing, failsafe];
}

if (isMain(import.meta.url)) {
  const results = await run();
  process.exit(results.some((r) => r.fail) ? 1 : 0);
}
