// lib/metrics.js
// One row per LLM call -> Supabase `llm_metrics` (read by the Team Manager report).
// BEST-EFFORT and LAZY: importing this must never require Supabase env, and a failed
// log must never break the caller. If SUPABASE creds are absent, logging silently skips
// (same pattern as lib/notify.js#logOutput and lib/store.js) so lib/llm.js stays usable
// in envs that have no Supabase (e.g. register-commands, the webhook).

let _db;
async function db() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  if (!_db) {
    const { createClient } = await import("@supabase/supabase-js");
    _db = createClient(url, key);
  }
  return _db;
}

// USD / 1M tokens — update from provider pricing. Free tiers still log a "would-be"
// cost so you can see the value you're getting for ₹0.
const PRICE = {
  "openai/gpt-oss-120b": { in: 0.15, out: 0.75 },
  "openai/gpt-oss-20b":  { in: 0.10, out: 0.50 },
  "groq/compound":       { in: 0.15, out: 0.75 },
  "gemini-2.5-flash":      { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  // OpenAI (paid) — REAL cost. Approx per-1M-token list prices; update if OpenAI changes them.
  "gpt-4o":      { in: 2.50, out: 10.00 },
  "gpt-4o-mini": { in: 0.15, out: 0.60 },
  // Failover providers. A model missing from this table silently logs $0.00 no matter how many
  // tokens it burns — Mistral logged 173k tokens as "free" for weeks that way. Bare "gpt-oss-120b"
  // is CEREBRAS (Groq's is prefixed "openai/"); both are free tiers, so these are would-be costs.
  "mistral-small-latest": { in: 0.20, out: 0.60 },
  "gpt-oss-120b":         { in: 0.15, out: 0.75 },
  "minimax/minimax-m3:free": { in: 0, out: 0 }, // genuinely free slug — real cost is zero
  // Cohere trial: free, so the real cost is zero. Listed anyway — a model missing from this table
  // silently logs $0.00 whether it is free or not, which is how Mistral hid 173k paid-rate tokens.
  "command-a-03-2025": { in: 0, out: 0 },
};

export async function logCall(m) {
  try {
    const client = await db();
    if (!client) return; // no Supabase env -> skip, never throw
    const p = PRICE[m.model] || { in: 0, out: 0 };
    const est = ((m.in_tokens || 0) * p.in + (m.out_tokens || 0) * p.out) / 1e6;
    await client.from("llm_metrics").insert({ ...m, est_cost_usd: Number(est.toFixed(6)) });
  } catch (e) {
    console.error("metric log failed:", e.message);
  }
}
