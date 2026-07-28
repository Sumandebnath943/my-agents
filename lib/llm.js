// lib/llm.js
import { env } from "./env.js";
import { logCall } from "./metrics.js";
import { logEvent } from "./ops.js";
import { chainFor, VISION_PROVIDERS } from "./routing.js";

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
  // Optional failover providers. Bare "gpt-oss-120b" is CEREBRAS (Groq's is prefixed "openai/").
  // Cerebras free tier is 5 REQ/MIN — verified from x-ratelimit-limit-requests-minute, not assumed.
  // It is deliberately LAST-ish in the chains: at 5 RPM it cannot absorb a burst, so it only ever
  // gets reached when Mistral is also down, where a 14s gap costs nothing.
  "gpt-oss-120b": 5, "mistral-small-latest": 30, "google/gemma-4-26b-a4b-it:free": 20, // OpenRouter free tier: 20 is the documented figure, not header-verified
  "gpt-4o": 400, "gpt-4o-mini": 400, // OpenAI (paid) — generous limits; pace conservatively anyway
};
const gapMs = (model) => Math.ceil(60000 / ((RPM[model] || 10) * 0.85)); // ~85% of the RPM ceiling
// Exported for the routing eval only: a default model with no RPM entry silently inherits the
// 10-rpm fallback, which is how a wrong pacing assumption slips in unnoticed. The eval pins it.
export const _RPM = RPM;
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
  openai:     { url: "https://api.openai.com/v1/chat/completions",        keyEnv: "OPENAI_API_KEY",     defaultModel: "gpt-4o-mini" }, // paid; primary for heavy/quality
  groq:       { url: "https://api.groq.com/openai/v1/chat/completions",   keyEnv: "GROQ_API_KEY",       defaultModel: "openai/gpt-oss-120b" },
  // Cerebras RETIRED llama-3.3-70b — it 404s ("decommissioned"), so every call to this provider
  // failed for weeks while Mistral silently absorbed them. gpt-oss-120b is the same model the fleet
  // already runs on Groq, so quality is a known quantity; verified live for content + JSON mode.
  cerebras:   { url: "https://api.cerebras.ai/v1/chat/completions",       keyEnv: "CEREBRAS_API_KEY",   defaultModel: "gpt-oss-120b" },
  mistral:    { url: "https://api.mistral.ai/v1/chat/completions",        keyEnv: "MISTRAL_API_KEY",    defaultModel: "mistral-small-latest" },
  // llama-3.3-70b-instruct:free stopped being free — OpenRouter 404s it with "use the paid slug".
  // As the LAST hop in most chains it is almost never reached, so nothing surfaced the breakage;
  // the fleet's final safety net was simply guaranteed to fail. gemma-4-26b is currently free and
  // verified live for both plain and JSON responses. Free slugs come and go — recheck if it 404s.
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions",     keyEnv: "OPENROUTER_API_KEY", defaultModel: "google/gemma-4-26b-a4b-it:free" },
};

// Is a provider usable right now? (key present in the environment)
export const hasKey = (provider) => !!process.env[OAI[provider]?.keyEnv];

export const _OAI = OAI; // exported for the routing eval (see _RPM above)

// A provider with no key is skipped SILENTLY — nothing is logged, so a chain quietly runs shorter
// than designed. That is how 41 of 46 workflows ended up missing either GROQ or GEMINI without a
// single symptom: `uptime` sent every call to Groq because its Gemini key was absent, and
// `job-agent` opened straight onto Cerebras because Groq's was. This does NOT change routing —
// it just makes the gap visible. Reported once per (agent, missing-set) per process, so a workflow
// run produces one row rather than one per call.
const _reportedSkips = new Set();
export function _noteSkipped(agent, skipped, order) {
  if (!skipped.length) return;
  const sig = `${agent}|${skipped.join(",")}`;
  if (_reportedSkips.has(sig)) return;
  _reportedSkips.add(sig);
  logEvent({
    agent, kind: "provider_skipped", ok: false,
    detail: `no API key for ${skipped.join(", ")} — chain [${order.join(" → ")}] ran without ${skipped.length > 1 ? "them" : "it"}`,
  }).catch(() => {});
}

/**
 * Call any OpenAI-compatible provider. messages: [{ role, content }]. opts.json -> JSON object.
 * Same pacing/retry/metrics contract as before; provider name flows through to the Team Manager.
 */
async function callOAI(provider, messages, opts = {}) {
  const cfg = OAI[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const model = opts.model || cfg.defaultModel;
  // VISION (OpenAI only among these): attach images to the last user message as image_url parts.
  let msgs = messages;
  if (opts.images?.length) {
    msgs = messages.map((m) => ({ ...m }));
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (lastUser) {
      lastUser.content = [
        { type: "text", text: String(lastUser.content) },
        ...opts.images.map((im) => ({ type: "image_url", image_url: { url: `data:${im.mimeType};base64,${im.base64}` } })),
      ];
    }
  }
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
        messages: msgs,
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
    // ONLY Groq's `x-ratelimit-remaining-requests` is the DAILY request budget. Other OpenAI-compatible
    // providers (Mistral/Cerebras/OpenRouter) reuse that header name for a SHORT window (per-second/
    // minute), so a "0" there is normal after a call and must NOT be read as headroom/exhaustion.
    const remaining = provider === "groq" ? Number(res.headers.get("x-ratelimit-remaining-requests")) : NaN;
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
  _noteSkipped(AGENT, chain.filter((p) => !hasKey(p)), chain);
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
  // Mistral BEFORE Cerebras: Cerebras allows only 5 req/min, so as a first failover it either
  // 429s under burst or forces a 14s gap per call. Mistral (30 rpm) already answered 100% of
  // these calls while Cerebras was dead, so this order matches observed behavior and keeps
  // Cerebras as a genuine deeper backstop rather than a hop that costs time on every request.
  return callChainOAI(["groq", "mistral", "cerebras", "openrouter"], messages, opts);
}

// Normalize input for the two API shapes: OpenAI-compatible wants messages[], Gemini wants a string.
function toMessages(input, opts = {}) {
  if (Array.isArray(input)) return input;
  const msgs = [];
  if (opts.system) msgs.push({ role: "system", content: opts.system });
  msgs.push({ role: "user", content: String(input) });
  return msgs;
}
const toPrompt = (input) => (typeof input === "string" ? input : input.map((m) => m.content).join("\n\n"));

/**
 * Unified per-agent LLM call — the front door agents should use. Resolves THIS agent's chain
 * (lib/routing.js: primary provider + ordered fallbacks) and runs it, skipping any provider with no
 * key and moving on when one errors. `input` is a prompt string OR a messages array.
 * opts: { json, temperature, images, system, chain (override a specific chain), model (Gemini model) }.
 * VISION (opts.images): only Gemini/OpenAI are tried. Fail-safe: with no OpenAI key the chains run
 * exactly as before (OpenAI is simply skipped). Returns the first success.
 */
export async function callLLM(input, opts = {}) {
  const agent = process.env.AGENT_NAME || "unknown";
  const vision = !!(opts.images && opts.images.length);
  const { order, openaiModel, geminiModel } = chainFor(agent, opts.chain, vision);
  const keyed = (p) => (p === "gemini" ? !!process.env.GEMINI_API_KEY : hasKey(p));
  _noteSkipped(agent, order.filter((p) => !keyed(p)), order);
  let lastErr;
  for (const provider of order) {
    if (vision && !VISION_PROVIDERS.has(provider)) continue;                       // only gemini/openai see images
    if (provider === "gemini" ? !process.env.GEMINI_API_KEY : !hasKey(provider)) continue; // skip keyless
    try {
      if (provider === "gemini") {
        return await _geminiDirect(toPrompt(input), { ...opts, model: geminiModel || opts.model });
      }
      const model = provider === "openai" ? openaiModel : undefined;              // non-openai use their default
      return await callOAI(provider, toMessages(input, opts), { json: !!(opts.json || opts.schema), temperature: opts.temperature, images: opts.images, model });
    } catch (e) {
      lastErr = e;
      console.error(`callLLM[${agent}] ${provider} failed, trying next:`, e.message);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`callLLM[${agent}]: no provider available (no API keys set?)`);
}

/**
 * Gemini — use for BIG/PUBLIC/VISUAL content. REST API.
 * prompt: a string. images: optional [{ mimeType, base64 }].
 * opts.json = true   -> asks for JSON back.
 * opts.schema = {..} -> a Gemini responseSchema; CONSTRAINS output to that shape (implies json).
 *   Use OpenAPI-subset types, e.g. { type: "object", properties: {...}, required: [...] }.
 *   Eliminates a whole class of "LLM returned the wrong shape" parse failures.
 */
async function _geminiDirect(prompt, opts = {}) {
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

/**
 * Gemini with automatic TEXT failover. Tries Gemini (its own pacing + retries); if it's still
 * throttled/unavailable AND the call has no images, it falls back through the OpenAI-compatible
 * chain (Mistral → OpenRouter → Groq) so a Gemini 429 stops being a hard failure fleet-wide.
 * VISION calls (opts.images) never fall back — text-only providers can't read images — so they
 * behave exactly as before. Same signature; existing callers get resilience for free.
 */
export async function callGemini(prompt, opts = {}) {
  try {
    return await _geminiDirect(prompt, opts);
  } catch (e) {
    if (opts.images?.length) throw e;                 // vision can't degrade to text providers
    const chain = ["mistral", "openrouter", "groq"];
    if (!chain.some(hasKey)) throw e;                 // no failover configured → original error
    console.error("Gemini failed, falling back to text providers:", e.message);
    return callChainOAI(chain, [{ role: "user", content: prompt }], { json: !!(opts.json || opts.schema), temperature: opts.temperature });
  }
}

// Convenience: parse a JSON answer safely (LLMs sometimes wrap in ```).
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// Back-compat alias — now routes through the per-agent chain (lib/routing.js) via callLLM. Existing
// callers (LinkedIn draft, briefing) automatically get their configured primary + fallback order.
// With no OpenAI key set it behaves like the old Gemini->free-provider fallback.
export async function geminiThenGroq(prompt, opts = {}) {
  return callLLM(prompt, opts);
}
