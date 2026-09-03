// lib/llm.js
import { env } from "./env.js";
import { logCall } from "./metrics.js";
import { logEvent } from "./ops.js";
import { chainFor, VISION_PROVIDERS } from "./routing.js";

// Small sleep helper for backoff.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which agent is calling? Set per workflow via AGENT_NAME env.
//
// Outside GitHub Actions — a local run, the MCP server — AGENT_NAME is absent and every call used
// to log as "unknown". On 2026-09-02 that produced an anonymous Groq call and a `token_window_hold`
// event nobody could attribute to anything. Falling back to the entry script makes an out-of-band
// call identify itself. The `local:` prefix is deliberate: it must never be mistaken for the
// canonical AGENT_NAME a workflow sets, or per-agent stats would silently split in two.
//
// Verified 2026-09-02: every scheduled workflow that reaches this file sets AGENT_NAME, so this
// path is for manual and out-of-band callers only. It is a LOGGING identity — routing still
// resolves from process.env.AGENT_NAME at call time (see callLLM), which is what lets the evals
// swap agents between cases.
function defaultAgentName() {
  const entry = (process.argv[1] || "").replace(/\\/g, "/");
  const dir = entry.match(/\/agents\/([^/]+)\//);
  if (dir) return `local:${dir[1]}`;
  const base = entry.split("/").pop()?.replace(/\.(mjs|js)$/, "");
  return base ? `local:${base}` : "unknown";
}
const AGENT = process.env.AGENT_NAME || defaultAgentName();

// --- Free-tier PACING -------------------------------------------------------------------
// The #1 cause of 429s is a single run bursting past the per-minute REQUEST limit (Gemini
// free = 10 RPM). We space calls so a burst can't blow the bucket. Serialized per provider
// so a sequential loop AND Promise.all both queue instead of firing at once. Per-process
// (each workflow is its own runner), which is exactly where the bursts happen.
// ⚠️ THIS TABLE MODELS REQUESTS PER MINUTE. THREE OF THE FOUR LIVE PROVIDERS ARE BOUND BY TOKENS
// PER MINUTE INSTEAD, and nothing here knows that. Measured live from response headers, 1 Sep 2026:
//
//   Groq    openai/gpt-oss-120b   x-ratelimit-limit-requests: 1000 (per DAY)
//                                 x-ratelimit-limit-tokens:   8000 (per MINUTE)  ← the real ceiling
//   Mistral mistral-small-latest  x-ratelimit-limit-req-minute:     50
//                                 x-ratelimit-limit-tokens-minute: 50000
//
// So the safe request rate depends on PROMPT SIZE, which this table cannot express. The entries
// below are therefore set against the LARGEST prompts that reach each provider, not the average:
//
//   Groq    8,000 ÷ ~650 tok (its own observed average) ≈ 12/min → entry 14 (×0.85 ≈ 12)
//   Mistral 50,000 ÷ 3,815 tok (job-agent's heaviest)   ≈ 13/min → entry 12 (×0.85 ≈ 10)
//
// A token-cap 429 is cheap and self-correcting — Groq's `x-ratelimit-reset-tokens` came back at
// ~1.3s and the retry loop honours `retry-after` — so the cost of being slightly wrong here is
// latency and log noise, never a lost run. Do NOT raise these back to 30 without re-measuring the
// token headers; 30 put Groq at roughly 2× its token ceiling under a burst.
const RPM = {
  "gemini-2.5-flash": 10, "gemini-2.5-flash-lite": 15, "openai/gpt-oss-120b": 14, "openai/gpt-oss-20b": 30, "groq/compound": 15,
  // Optional failover providers. Bare "gpt-oss-120b" is CEREBRAS (Groq's is prefixed "openai/").
  // Cerebras free tier is 5 REQ/MIN — verified from x-ratelimit-limit-requests-minute, not assumed.
  // It is deliberately LAST-ish in the chains: at 5 RPM it cannot absorb a burst, so it only ever
  // gets reached when Mistral is also down, where a 14s gap costs nothing.
  "gpt-oss-120b": 5, "mistral-small-latest": 12, "minimax/minimax-m3:free": 20, // OpenRouter free tier: 20 is the documented figure, not header-verified
  // Cohere: 20 rpm is documented but NOT header-verified (it sends no rate-limit headers at all).
  // Paced at half that deliberately — the binding limit is really ~1,000 calls/MONTH shared with
  // ECHO rerank, and a burst here is invisible until the month runs out.
  "command-a-03-2025": 10,
  "gpt-4o": 400, "gpt-4o-mini": 400, // OpenAI (paid) — generous limits; pace conservatively anyway
};
// --- TOKENS PER MINUTE, THE CEILING THE REQUEST RATE CANNOT EXPRESS -------------------------
//
// A single requests-per-minute number cannot be right for a provider metered on TOKENS, because
// the safe rate then depends on PROMPT SIZE. Against Groq's 8,000 tok/min the same entry has to
// serve `uptime` (321 tok/call → ~25 calls/min is fine) and `job-agent` (1,962 tok/call → 4 is the
// limit). Entry 14 was calibrated on Groq's own ~650-token average, so a heavy agent routed there
// ran ~4× over its token ceiling — which is exactly what the `token_window_hold` events on 1–2 Sep
// were catching after the fact.
//
// Only models whose token ceiling was MEASURED from live headers appear here. A model with no
// entry keeps the pure request-rate gap, i.e. today's behaviour.
const TPM = { "openai/gpt-oss-120b": 8000, "mistral-small-latest": 50000 };

// Observed tokens per call, per model, as an EWMA over this process. Empty at first, so early
// calls pace on requests alone and the bound tightens as real sizes arrive. Per-process is the
// right grain: each workflow is its own runner, so this self-calibrates to the agent that is
// actually running rather than to a fleet-wide average that fits nobody.
const _avgTok = {};
function noteTokens(model, tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  _avgTok[model] = _avgTok[model] ? Math.round(_avgTok[model] * 0.7 + tokens * 0.3) : tokens;
}

// The gap is whichever ceiling binds harder. Taking the MAX is what keeps this safe to turn on:
// a light agent's token gap is smaller than its request gap, so nothing slows down that did not
// need to — only processes genuinely pushing tokens are throttled.
const gapMs = (model) => {
  const byRequests = 60000 / ((RPM[model] || 10) * 0.85);        // ~85% of the RPM ceiling
  const tpm = TPM[model], avg = _avgTok[model];
  const byTokens = tpm && avg ? (60000 * avg) / (tpm * 0.85) : 0;
  return Math.ceil(Math.max(byRequests, byTokens));
};
// Exported for the routing eval only: a default model with no RPM entry silently inherits the
// 10-rpm fallback, which is how a wrong pacing assumption slips in unnoticed. The eval pins it.
export const _RPM = RPM;
// --- TOKEN-CEILING GUARD ------------------------------------------------------------------
// The RPM table above cannot see tokens, and Groq's real ceiling is 8,000 tokens/MINUTE — small
// enough that a handful of large prompts breaches it while the request rate looks harmless.
//
// So rather than predict, READ. Groq and Mistral both report how much of the token window is left
// on EVERY response. That figure is the provider's own accounting, which means it already includes
// traffic from other processes — the dispatcher's other agents, MAS on Vercel — that in-process
// pacing is structurally blind to. When it runs low we hold the provider until the window refills.
//
// This is a guard, not a guarantee: the first call that crosses the line still crosses it. What it
// prevents is the pile-on afterwards, which is what turns one 429 into a run of them.
const TOKEN_HEADERS = {
  groq:    { limit: "x-ratelimit-limit-tokens",        remaining: "x-ratelimit-remaining-tokens",        reset: "x-ratelimit-reset-tokens" },
  mistral: { limit: "x-ratelimit-limit-tokens-minute", remaining: "x-ratelimit-remaining-tokens-minute", reset: null }, // no reset header — assume the minute
};

/** Providers spell reset windows as "1.297s", "1m26.4s", "500ms" or a bare "30". Returns ms. */
export function parseResetMs(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.ceil(parseFloat(s) * 1000);   // bare seconds
  let ms = 0, seen = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    seen = true;
    const n = parseFloat(m[1]);
    ms += m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60000 : n * 3600000;
  }
  return seen ? Math.ceil(ms) : null;
}

// Per-provider serialization gates, created on first use (works for any provider name).
const _lastAt = {};
const _gate = {};
const _tokenHold = {};   // provider -> epoch ms before which no further call may be sent
function pace(provider, model) {
  if (_gate[provider] === undefined) { _lastAt[provider] = 0; _gate[provider] = Promise.resolve(); }
  const run = async () => {
    // Whichever is later: the ordinary request-rate gap, or a token-window hold.
    const wait = Math.max(_lastAt[provider] + gapMs(model), _tokenHold[provider] || 0) - Date.now();
    if (wait > 0) await sleep(wait);
    _lastAt[provider] = Date.now();
  };
  const p = _gate[provider].then(run, run); // run regardless of prior settle
  _gate[provider] = p.catch(() => {});
  return p;
}

// Reported once per provider per process — a hold can fire repeatedly in one run and the point is
// to notice the condition, not to fill ops_events with it.
const _heldOnce = new Set();
/** Read the token-window headers off a successful response and hold the provider if it is low. */
function noteTokenWindow(provider, res, usedTokens) {
  const h = TOKEN_HEADERS[provider];
  if (!h) return;
  const remaining = Number(res.headers.get(h.remaining));
  const limit = Number(res.headers.get(h.limit));
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return;
  // Hold when what is left would not comfortably fit another call the size of this one. The 15%
  // floor covers the first call of a run, where `usedTokens` is not yet representative.
  const need = Math.max(usedTokens || 0, Math.ceil(limit * 0.15));
  if (remaining >= need) return;
  const waitMs = parseResetMs(res.headers.get(h.reset)) ?? 60000;
  _tokenHold[provider] = Date.now() + Math.min(waitMs + 250, 65000);
  if (!_heldOnce.has(provider)) {
    _heldOnce.add(provider);
    logEvent({
      agent: AGENT, kind: "token_window_hold", ok: false,
      detail: `${provider}: ${remaining}/${limit} tokens left in window — holding ${Math.round(waitMs / 100) / 10}s`,
    }).catch(() => {});
  }
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
//
// ⚠️ 429 IS TWO COMPLETELY DIFFERENT FAILURES, and conflating them cost a full day.
//
// OpenAI returns 429 both for throttling ("slow down, retry shortly") and for a spent balance
// (`insufficient_quota` / `credit_balance_exhausted`, where retrying is futile). On 1 Sep 2026 the
// dashboard reported "102 rate-limits" and the actual cause was that OpenAI credits had run out at
// 14:30 UTC the day before — every call from every agent 429'd from that moment, including single
// isolated calls that could not possibly breach a per-minute limit. The label sent the diagnosis
// toward pacing and backoff, which cannot fix a billing problem.
//
// Cerebras signals the same condition as 402 `payment_required`.
//
// Keeping these apart matters twice over: the dashboard stops lying, and `callOAI` can skip the
// retry loop for a condition that will never clear on its own (see the retry guard below).
// Deliberately narrow: UNAMBIGUOUS billing signals only. Do NOT add a bare /quota/ here — Gemini's
// ordinary per-minute throttle body reads "Quota exceeded for quota metric '...requests per
// minute'", so a loose pattern would relabel routine free-tier throttling as a spent balance AND
// skip the retry that honours Gemini's own RetryInfo hint. Gemini free tier has no balance to spend.
const QUOTA_RE = /insufficient_quota|credit_balance_exhausted|billing_hard_limit|exceeded your current quota|no credits remaining|payment_required/i;
// Providers that can actually RUN OUT — i.e. that hold a prepaid balance, where retrying is futile
// and only paying helps. Everything else meters a WINDOW that refills on its own.
//
// ⚠️ THIS LIST IS THE WHOLE POINT, AND GEMINI'S ABSENCE FROM IT IS DELIBERATE. Google's free-tier
// 429 opens with the generic sentence "You exceeded your current quota, please check your plan and
// billing details" — which reads exactly like a spent account and matches QUOTA_RE. It is not. The
// specific line underneath, captured live on 2026-09-03, says:
//
//   Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
//   limit: 20
//
// That is a request-rate window, and the free tier has no balance to spend in the first place. So a
// Gemini 429 must classify as `rate_limit`, keep its retries, and honour the RetryInfo hint in the
// body. Labelling it `quota_exhausted` suppressed those retries and threw away usable capacity.
//
// The comment above QUOTA_RE already warned not to loosen the pattern to a bare /quota/. This is the
// same trap through a different door: the generic wrapper sentence, not the word "quota".
const BALANCE_PROVIDERS = new Set(["openai", "cerebras", "mistral", "groq", "openrouter", "cohere"]);

export function reason(status, body = "", provider = "") {
  if (status === 402) return "quota_exhausted";
  if (status === 429) {
    if (provider && !BALANCE_PROVIDERS.has(provider)) return "rate_limit";   // no balance to spend
    return QUOTA_RE.test(body) ? "quota_exhausted" : "rate_limit";
  }
  if (/decommission|not found|model_/i.test(body)) return "decommissioned";
  if ([500, 502, 503].includes(status)) return "unavailable";
  return status >= 400 ? "error" : null;
}

// --- KEEP THE EVIDENCE THAT DECIDED THE CLASSIFICATION ------------------------------------
//
// `reason()` reads the error body and then throws it away: `llm_metrics` has no column for it. So
// after the fact nobody can answer the question the classification turns on — on 2026-09-02 Gemini
// returned seven 429s labelled `quota_exhausted`, and whether that was a spent DAILY quota (no
// retry, correct) or per-minute throttling (retry, mislabelled) could not be settled from stored
// data at all.
//
// Sampled into ops_events rather than adding a column: no migration, and nothing to run by hand.
// One row per distinct (provider, status, reason) PER PROCESS, so a burst of fifty identical 429s
// costs exactly one row.
//
// ⚠️ REDACT FIRST. Gemini takes its key in the URL QUERY STRING, and a provider that echoes the
// request back would otherwise write a live credential into a table the dashboard reads.
const _bodySeen = new Set();
const redactSecrets = (s) =>
  String(s)
    .replace(/key=[\w-]+/gi, "key=<redacted>")
    .replace(/\b(?:sk|gsk|xai|AIza|sk-or-v1)[-_A-Za-z0-9]{16,}/g, "<redacted>");

function noteErrorBody(provider, status, why, body) {
  if (status !== 429 && status !== 402) return;   // only the ambiguous ones are worth keeping
  const sig = `${provider}|${status}|${why}`;
  if (_bodySeen.has(sig)) return;
  _bodySeen.add(sig);
  logEvent({
    agent: AGENT, kind: "llm_error_body", ok: false,
    // 800, not 400. At 400 the Gemini body was cut off exactly where it got useful: the generic
    // "You exceeded your current quota" wrapper fits, but the line that actually identifies the
    // limit — "Quota exceeded for metric: ...generate_content_free_tier_requests, limit: 20" — and
    // any RetryInfo hint were both truncated away. The evidence has to reach past the boilerplate.
    detail: `${provider} ${status} → ${why} :: ${redactSecrets(body).replace(/\s+/g, " ").slice(0, 800)}`,
  }).catch(() => {});
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
  // Cohere ships an OpenAI-COMPATIBLE endpoint (/compatibility/v1), so it needs no new code path —
  // only this row. command-a-03-2025 is 111B with 288k context and honours response_format, so it
  // is a genuine peer of Groq's gpt-oss-120b rather than a token fallback. Verified live 1 Sep 2026:
  // 200 + valid JSON, and 6 concurrent calls with zero throttling.
  //
  // ⚠️ THE ONE PROVIDER WE ARE BLIND ON. Cohere returns NO rate-limit headers, so the token-window
  // guard below cannot see it and nothing reports remaining quota. Its trial allowance is ~1,000
  // calls a MONTH — shared with the dashboard's ECHO reranker, which is the only other consumer of
  // this key. That is why it sits last-but-one in every chain and is paced well under its
  // documented 20 rpm: the protection here is low volume by construction, not measurement.
  cohere:     { url: "https://api.cohere.ai/compatibility/v1/chat/completions", keyEnv: "COHERE_API_KEY", defaultModel: "command-a-03-2025" },
  // ⚠️ THIRD TIME THIS HOP HAS BEEN SILENTLY DEAD. llama-3.3-70b-instruct:free stopped being free
  // (404). gemma-4-26b-a4b-it:free replaced it and then went 0-for-18 over the week to 1 Sep 2026 —
  // not retired this time, but permanently 429 because a `:free` slug is served from the upstream
  // provider's SHARED community pool (`limit_source: upstream_provider_shared_pool`, Google AI
  // Studio). Nothing on this account can fix that. Being the LAST hop in most chains is exactly why
  // nobody noticed: the fleet's final safety net was guaranteed to fail.
  //
  // All 18 free slugs were probed on 1 Sep 2026 for BOTH a 200 and valid JSON mode (a large share of
  // fleet calls set response_format), then the survivors were re-probed 3× for availability:
  //
  //   minimax/minimax-m3:free                3/3 up · 3/3 JSON · 1.6s · 1M ctx   ← chosen
  //   nvidia/nemotron-3-ultra-550b-a55b:free 3/3 up · 3/3 JSON · 10.3s           (6× slower)
  //   nvidia/nemotron-3-nano-omni-...:free   3/3 up · 2/3 JSON                  (reasoning leaks)
  //   google/gemma-4-26b-a4b-it:free         0/3 up · 429,429,429                (the old default)
  //   google/gemma-4-31b-it:free             0/3 up · 429,429,429                (same pool)
  //
  // RECHECK THIS BY PROBING, NOT BY READING. A free slug can die three ways — retired (404), moved
  // to paid (404), or pool-saturated (429) — and only the first two look like breakage.
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions",     keyEnv: "OPENROUTER_API_KEY", defaultModel: "minimax/minimax-m3:free" },
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
      const why = reason(res.status, body, provider);
      noteErrorBody(provider, res.status, why, body);
      // A 429 from a token-metered provider means the window is spent, not that we asked too often.
      // Hold the whole provider until it refills so the remaining calls in this run queue behind it
      // instead of each discovering the same wall.
      if (res.status === 429 && TOKEN_HEADERS[provider]) noteTokenWindow(provider, res, Infinity);
      await logCall({ provider, model, agent: AGENT, ok: false, status: res.status, error_reason: why, ms, in_tokens: 0, out_tokens: 0 });
      // A spent balance will not clear during a retry loop. Retrying it burns the backoff sleep,
      // triples the logged failures (which is most of why "102 rate-limits" looked like a storm),
      // and delays reaching a provider that actually works. Fall through to the next one at once.
      if (why !== "quota_exhausted" && (res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
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
    // The TOKEN window is a separate, much tighter budget than the request one — see TOKEN_HEADERS.
    const usedTokens = u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
    noteTokens(model, usedTokens);            // feeds the token-aware gap for the NEXT call
    noteTokenWindow(provider, res, usedTokens);
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
      const why = reason(res.status, errBody, "gemini");
      noteErrorBody("gemini", res.status, why, errBody);
      await logCall({ provider: "gemini", model, agent: AGENT, ok: false, status: res.status, error_reason: why, ms, in_tokens: 0, out_tokens: 0 });
      // Same rule as callOAI. In practice Gemini's free tier has no balance, so this guard should
      // never fire here — it is present so the two retry loops cannot drift apart.
      if (why !== "quota_exhausted" && (res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
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
