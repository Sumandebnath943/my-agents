// lib/llm.js
import { env } from "./env.js";
import { logCall } from "./metrics.js";
import { logEvent } from "./ops.js";

// Small sleep helper for backoff.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which agent is calling? Set per workflow via AGENT_NAME env (defaults to "unknown").
const AGENT = process.env.AGENT_NAME || "unknown";

// Classify an HTTP failure into a stable error_reason for the Team Manager.
function reason(status, body = "") {
  if (status === 429) return "rate_limit";
  if (/decommission|not found|model_/i.test(body)) return "decommissioned";
  if ([500, 502, 503].includes(status)) return "unavailable";
  return status >= 400 ? "error" : null;
}

/**
 * Groq — use for PRIVATE content (email, journal). OpenAI-compatible API.
 * messages: [{ role: "system"|"user"|"assistant", content: "..." }]
 * opts.json = true  -> forces a JSON object response.
 */
export async function callGroq(messages, opts = {}) {
  const model = opts.model || "openai/gpt-oss-120b";
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = Date.now();
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("GROQ_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.4,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text();
      await logCall({ provider: "groq", model, agent: AGENT, ok: false, status: res.status, error_reason: reason(res.status, body), ms, in_tokens: 0, out_tokens: 0 });
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; } // rate-limited or transient 5xx
      throw new Error(`Groq ${res.status}: ${body}`);
    }
    const data = await res.json();
    const u = data.usage || {};
    // Groq returns remaining-quota headers — capture headroom for the Team Manager and
    // warn early (before the wall) when daily request budget runs low.
    const remaining = Number(res.headers.get("x-ratelimit-remaining-requests"));
    const limit_remaining = Number.isFinite(remaining) ? remaining : null;
    await logCall({ provider: "groq", model, agent: AGENT, ok: true, status: 200, error_reason: null, ms, in_tokens: u.prompt_tokens || 0, out_tokens: u.completion_tokens || 0, limit_remaining });
    if (limit_remaining !== null && limit_remaining <= 25) {
      await logEvent({ agent: AGENT, kind: "limit_low", ok: false, detail: `groq requests remaining: ${limit_remaining}` });
    }
    return data.choices[0].message.content;
  }
  throw new Error("Groq: rate limited after retries");
}

/**
 * Gemini — use for BIG/PUBLIC/VISUAL content. REST API.
 * prompt: a string. images: optional [{ mimeType, base64 }].
 * opts.json = true -> asks for JSON back.
 */
export async function callGemini(prompt, opts = {}) {
  const model = opts.model || "gemini-2.5-flash";
  const parts = [{ text: prompt }];
  for (const img of opts.images || []) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }
  const body = {
    contents: [{ parts }],
    ...(opts.json
      ? { generationConfig: { responseMimeType: "application/json" } }
      : {}),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env("GEMINI_API_KEY")}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text();
      await logCall({ provider: "gemini", model, agent: AGENT, ok: false, status: res.status, error_reason: reason(res.status, body), ms, in_tokens: 0, out_tokens: 0 });
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; } // rate-limited or transient 5xx (e.g. 503 high demand)
      throw new Error(`Gemini ${res.status}: ${body}`);
    }
    const data = await res.json();
    const u = data.usageMetadata || {};
    await logCall({ provider: "gemini", model, agent: AGENT, ok: true, status: 200, error_reason: null, ms, in_tokens: u.promptTokenCount || 0, out_tokens: u.candidatesTokenCount || 0 });
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
  throw new Error("Gemini: rate limited after retries");
}

// Convenience: parse a JSON answer safely (LLMs sometimes wrap in ```).
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// Resilient generation: try Gemini, and if it's still unavailable after its own retries,
// fall back to Groq. Returns raw text (use opts.json for JSON mode on both). Note: Groq's
// free tier can reject very large prompts, so this is best-effort for big generations.
export async function geminiThenGroq(prompt, opts = {}) {
  try {
    return await callGemini(prompt, opts);
  } catch (e) {
    console.error("Gemini failed, falling back to Groq:", e.message);
    return await callGroq([{ role: "user", content: prompt }], opts);
  }
}
