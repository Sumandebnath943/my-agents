// lib/ops.js
// Non-LLM operational events (email failures, rate-limit warnings, heartbeats) ->
// Supabase `ops_events`. LAZY + best-effort like lib/metrics.js: importing needs no
// Supabase env, and a failed log never breaks the caller.
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

// logEvent({ agent, kind, ok, detail }) — kind e.g. "email_fail", "limit_low".
export async function logEvent(e) {
  try {
    const client = await db();
    if (!client) return;
    await client.from("ops_events").insert({
      agent: e.agent || process.env.AGENT_NAME || "unknown",
      kind: e.kind,
      ok: e.ok ?? false,
      detail: String(e.detail ?? "").slice(0, 500),
    });
  } catch (err) {
    console.error("ops log failed:", err.message);
  }
}
