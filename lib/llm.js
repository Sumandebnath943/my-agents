// lib/llm.js
import { env } from "./env.js";
import { logCall } from "./metrics.js";
import { logEvent } from "./ops.js";

// Small sleep helper for backoff.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which agent is calling? Set per workflow via AGENT_NAME env (defaults to "unknown").
const AGENT = process.env.AGENT_NAME || "unknown";

// --- Free-tier PACING -------------------------------------------------------------------
// The #1 cause of 429s is a single run bursting past the per-minute REQUEST limit (Gemini
// free = 10 RPM). We space calls so a burst can't blow the bucket. Serialized per provider
// so a sequential loop AND Promise.all both queue instead of firing at once. Per-process
// (each workflow is its own runner), which is exactly where the bursts happen.
const RPM = {
  "gemini-2.5-flash": 10, "gemini-2.5-flash-lite": 15, "openai/gpt-oss-120b": 30, "openai/gpt-oss-20b": 30, "groq/compound": 15,
  "llama-3.3-70b": 30, "mistral-small-latest": 30, "meta-llama/llama-3.3-70b-instruct:free": 20, // optional failover providers
};
const gapMs = (model) => Math.ceil(60000 / ((RPM[model] || 10) * 0.85)); // ~85% of the RPM ceiling
// Per-provider serialization gates, created on first use (works for any provider name).
const _lastAt = {};
const _gate = {};
function pace(provider, model) {
  if (_gate[provider] === undefined) { _lastAt[provider] = 0; _gate[provider] = Promise.resolve(); }
  const run = async () => {
    const wait = _lastAt[provider] + gapMs(model) - Date.now();
    if (wait > 0) await sleep(wait);
    _lastAt[provider] = Date.now();
  };
  const p = _gate[provider].then(run, run); // run regardless of prior settle
  _gate[provider] = p.catch(() => {});
  return p;
}

// Retry tuning: fewer attempts (5 was a storm), honor the server's own backoff hint, jitter.
const MAX_ATTEMPTS = 3;
const jitter = (ms) => ms + Math.floor(Math.random() * 400);
const capBackoff = (ms) => Math.min(ms, 20000);
// Gemini 429 bodies carry a RetryInfo detail like {"retryDelay":"5s"} — respect it.
function geminiRetryMs(body) {
  try {
    const details = JSON.parse(body).error?.details || [];
    const ri = details.find((d) => String(d["@type"] || "").includes("RetryInfo"));
    if (ri?.retryDelay) return Math.ceil(parseFloat(ri.retryDelay) * 1000);
  } catch {}
  return null;
}

// Classify an HTTP failure into a stable error_reason for the Team Manager.
function reason(status, body = "") {
  if (status === 429) return "rate_limit";
  if (/decommission|not found|model_/i.test(body)) return "decommissioned";
  if ([500, 502, 503].includes(status)) return "unavailable";
  return status >= 400 ? "error" : null;
}

// OpenAI-compatible providers. Groq is the primary; the rest are OPTIONAL permanent-free failovers
// (Cerebras, Mistral, OpenRouter) — all speak the same chat-completions API, so one caller serves
// them all. A provider whose key isn't set is simply skipped (see hasKey / callChainOAI) — adding a
// provider is opt-in and never a source of failure.
const OAI = {
  groq:       { url: "https://api.groq.com/openai/v1/chat/completions",   keyEnv: "GROQ_API_KEY",       defaultModel: "openai/gpt-oss-120b" },
  cerebras:   { url: "https://api.cerebras.ai/v1/chat/completions",       keyEnv: "CEREBRAS_API_KEY",   defaultModel: "llama-3.3-70b" },
  mistral:    { url: "https://api.mistral.ai/v1/chat/completions",        keyEnv: "MISTRAL_API_KEY",    defaultModel: "mistral-small-latest" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions",     keyEnv: "OPENROUTER_API_KEY", defaultModel: "meta-llama/llama-3.3-70b-instruct:free" },
};

// Is a provider usable right now? (key present in the environment)
export const hasKey = (provider) => !!process.env[OAI[provider]?.keyEnv];

/**
 * Call any OpenAI-compatible provider. messages: [{ role, content }]. opts.json -> JSON object.
 * Same pacing/retry/metrics contract as before; provider name flows through to the Team Manager.
 */
async function callOAI(provider, messages, opts = {}) {
  const cfg = OAI[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const model = opts.model || cfg.defaultModel;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace(provider, model);
    const t0 = Date.now();
    const headers = { Authorization: `Bearer ${env(cfg.keyEnv)}`, "Content-Type": "application/json" };
    if (provider === "openrouter") { headers["HTTP-Referer"] = "https://github.com/Sumandebnath943"; headers["X-Title"] = "Migi"; }
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
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
      await logCall({ provider, model, agent: AGENT, ok: false, status: res.status, error_reason: reason(res.status, body), ms, in_tokens: 0, out_tokens: 0 });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        const ra = Number(res.headers.get("retry-after"));       // seconds, when the provider sends it
        await sleep(capBackoff(Number.isFinite(ra) && ra > 0 ? ra * 1000 : jitter(1500 * (attempt + 1))));
        continue;
      }
      throw new Error(`${provider} ${res.status}: ${body}`);
    }
    const data = await res.json();
    const u = data.usage || {};
    // Some providers (Groq) return remaining-quota headers — capture headroom + warn early.
    const remaining = Number(res.headers.get("x-ratelimit-remaining-requests"));
    const limit_remaining = Number.isFinite(remaining) ? remaining : null;
    await logCall({ provider, model, agent: AGENT, ok: true, status: 200, error_reason: null, ms, in_tokens: u.prompt_tokens || 0, out_tokens: u.completion_tokens || 0, limit_remaining });
    if (limit_remaining !== null && limit_remaining <= 25) {
      await logEvent({ agent: AGENT, kind: "limit_low", ok: false, detail: `${provider} requests remaining: ${limit_remaining}` });
    }
    return data.choices[0].message.content;
  }
  throw new Error(`${provider}: rate limited after retries`);
}

/**
 * Groq — use for PRIVATE content (email, journal). OpenAI-compatible API.
 * messages: [{ role: "system"|"user"|"assistant", content: "..." }]
 * opts.json = true  -> forces a JSON object response.
 */
export async function callGroq(messages, opts = {}) {
  return callOAI("groq", messages, opts);
}

// Try a list of OpenAI-compatible providers in order, skipping any without a key, moving on when one
// errors. Returns the first success. Each provider uses ITS OWN default model (opts.model is ignored
// across the chain, since model names aren't portable between providers).
async function callChainOAI(chain, messages, opts = {}) {
  const { model, ...rest } = opts; // drop any provider-specific model hint
  let lastErr;
  const available = chain.filter(hasKey);
  for (const provider of available) {
    try {
      return await callOAI(provider, messages, rest);
    } catch (e) {
      lastErr = e;
      console.error(`${provider} failed, trying next:`, e.message);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`No LLM provider available for chain [${chain.join(", ")}] — no API keys set`);
}

/**
 * Resilient PRIVATE-content generation: Groq -> Cerebras -> Mistral -> OpenRouter.
 * Groq alone (the only required key) behaves exactly as before; the rest activate if their keys exist.
 */
export async function callPrivate(messages, opts = {}) {
  return callChainOAI(["groq", "cerebras", "mistral", "openrouter"], messages, opts);
}

/**
 * Gemini — use for BIG/PUBLIC/VISUAL content. REST API.
 * prompt: a string. images: optional [{ mimeType, base64 }].
 * opts.json = true   -> asks for JSON back.
 * opts.schema = {..} -> a Gemini responseSchema; CONSTRAINS output to that shape (implies json).
 *   Use OpenAPI-subset types, e.g. { type: "object", properties: {...}, required: [...] }.
 *   Eliminates a whole class of "LLM returned the wrong shape" parse failures.
 */
export async function callGemini(prompt, opts = {}) {
  const model = opts.model || "gemini-2.5-flash";
  const parts = [{ text: prompt }];
  for (const img of opts.images || []) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } });
  }
  const wantJson = opts.json || opts.schema;
  const body = {
    contents: [{ parts }],
    ...(wantJson
      ? { generationConfig: { responseMimeType: "application/json", ...(opts.schema ? { responseSchema: opts.schema } : {}) } }
      : {}),
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace("gemini", model);
    const t0 = Date.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env("GEMINI_API_KEY")}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const ms = Date.now() - t0;
    if (!res.ok) {
      const errBody = await res.text();
      await logCall({ provider: "gemini", model, agent: AGENT, ok: false, status: res.status, error_reason: reason(res.status, errBody), ms, in_tokens: 0, out_tokens: 0 });
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(capBackoff(geminiRetryMs(errBody) ?? jitter(2500 * (attempt + 1)))); // honor server RetryInfo
        continue;
      }
      throw new Error(`Gemini ${res.status}: ${errBody}`);
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

// Resilient generation for PUBLIC/large content: try Gemini, then fall back through the optional
// OpenAI-compatible providers (Mistral -> OpenRouter -> Groq). Returns raw text (use opts.json for
// JSON mode). Gemini-only options (images, schema) are dropped on fallback since they aren't portable.
// With only GROQ set, this behaves exactly as the old Gemini->Groq fallback.
export async function geminiThenGroq(prompt, opts = {}) {
  try {
    return await callGemini(prompt, opts);
  } catch (e) {
    console.error("Gemini failed, falling back:", e.message);
    const { images, schema, model, ...rest } = opts;
    return await callChainOAI(["mistral", "openrouter", "groq"], [{ role: "user", content: prompt }], rest);
  }
}
