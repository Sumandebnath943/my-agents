// agents/team-manager/health.js
// Provider health pings — detect outages even when no agent is running.
// A tiny 1-token call to each provider, logged as model:"healthcheck" so it shows up
// as availability/latency in the weekly report without polluting the cost/token totals.
import { env } from "../../lib/env.js";
import { logCall } from "../../lib/metrics.js";

const AGENT = "team-manager";

function reason(status) {
  if (status === 429) return "rate_limit";
  if ([500, 502, 503].includes(status)) return "unavailable";
  return status >= 400 ? "error" : null;
}

async function pingGroq() {
  const t0 = Date.now();
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("GROQ_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
    await logCall({ provider: "groq", model: "healthcheck", agent: AGENT, ok: res.ok, status: res.status, error_reason: res.ok ? null : reason(res.status), ms: Date.now() - t0, in_tokens: 0, out_tokens: 0 });
    console.log(`groq: ${res.status} ${res.ok ? "ok" : "DOWN"} ${Date.now() - t0}ms`);
  } catch (e) {
    await logCall({ provider: "groq", model: "healthcheck", agent: AGENT, ok: false, status: 0, error_reason: "unavailable", ms: Date.now() - t0, in_tokens: 0, out_tokens: 0 });
    console.log("groq: network error", e.message);
  }
}

async function pingGemini() {
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env("GEMINI_API_KEY")}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }) }
    );
    await logCall({ provider: "gemini", model: "healthcheck", agent: AGENT, ok: res.ok, status: res.status, error_reason: res.ok ? null : reason(res.status), ms: Date.now() - t0, in_tokens: 0, out_tokens: 0 });
    console.log(`gemini: ${res.status} ${res.ok ? "ok" : "DOWN"} ${Date.now() - t0}ms`);
  } catch (e) {
    await logCall({ provider: "gemini", model: "healthcheck", agent: AGENT, ok: false, status: 0, error_reason: "unavailable", ms: Date.now() - t0, in_tokens: 0, out_tokens: 0 });
    console.log("gemini: network error", e.message);
  }
}

await Promise.all([pingGroq(), pingGemini()]);
