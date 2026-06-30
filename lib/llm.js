// lib/llm.js
import { env } from "./env.js";

// Small sleep helper for backoff.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Groq — use for PRIVATE content (email, journal). OpenAI-compatible API.
 * messages: [{ role: "system"|"user"|"assistant", content: "..." }]
 * opts.json = true  -> forces a JSON object response.
 */
export async function callGroq(messages, opts = {}) {
  const model = opts.model || "openai/gpt-oss-120b";
  for (let attempt = 0; attempt < 4; attempt++) {
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
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; } // rate limited
    if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
    const data = await res.json();
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
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env("GEMINI_API_KEY")}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
  throw new Error("Gemini: rate limited after retries");
}

// Convenience: parse a JSON answer safely (LLMs sometimes wrap in ```).
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}
