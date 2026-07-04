// agents/team-manager/index.js
// Weekly fleet report — reads llm_metrics for the last 7 days and aggregates BY
// provider (how each API performs) and BY agent (per-agent cost/failure, incl. MIGI's
// two LLMs, tagged AGENT_NAME=migi). Groq writes the narrative; raw tables are appended.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callGroq } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_KEY"));
const since = new Date(Date.now() - 7 * 864e5).toISOString();
const { data: rows } = await db.from("llm_metrics").select("*").gte("ts", since);
if (!rows?.length) { console.log("No metrics yet."); process.exit(0); }

// Non-LLM operational events (email failures, rate-limit warnings) from ops_events.
const { data: opsRows } = await db.from("ops_events").select("*").gte("ts", since);
const ops = opsRows || [];
const emailFails = ops.filter((e) => e.kind === "email_fail");
const limitWarnings = ops.filter((e) => e.kind === "limit_low");
const opsSummary = {
  email_failures: emailFails.length,
  email_fail_samples: emailFails.slice(-5).map((e) => e.detail),
  rate_limit_warnings: limitWarnings.length,
  agents_hitting_limits: [...new Set(limitWarnings.map((e) => e.agent))],
};

const agg = (keyFn) => {
  const o = {};
  for (const r of rows) {
    const k = keyFn(r); o[k] ||= { calls: 0, ok: 0, tokens: 0, cost: 0, lat: [], rl: 0, out: 0, providers: {} };
    const b = o[k]; b.calls++; if (r.ok) b.ok++;
    b.tokens += (r.in_tokens || 0) + (r.out_tokens || 0); b.cost += Number(r.est_cost_usd || 0);
    if (r.ms) b.lat.push(r.ms);
    if (r.error_reason === "rate_limit") b.rl++; if (r.error_reason === "unavailable") b.out++;
    b.providers[r.provider] = (b.providers[r.provider] || 0) + 1;
  }
  const p95 = (a) => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : 0;
  return Object.fromEntries(Object.entries(o).map(([k, b]) => [k, {
    calls: b.calls, success: `${Math.round(b.ok / b.calls * 1000) / 10}%`, tokens: b.tokens,
    cost_usd: Number(b.cost.toFixed(2)), avg_ms: Math.round(b.lat.reduce((s, x) => s + x, 0) / (b.lat.length || 1)),
    p95_ms: p95(b.lat), rate_limits: b.rl, outages: b.out, providers: b.providers,
  }]));
};

const byProvider = agg((r) => r.provider);            // how each API performs
const byAgent    = agg((r) => r.agent || "unknown");  // per-agent incl. MIGI's 2 LLMs

const narrative = await callGroq([
  { role: "system", content: "You are an ops lead. Given weekly LLM fleet metrics (by provider, by agent) plus operational events (email delivery failures, rate-limit warnings), write a tight report: provider health (latency, rate limits, outages), cost/value, any agent that's a cost or failure outlier, and CALL OUT email failures or agents approaching their rate limits if there are any. Note MIGI's provider split if present." },
  { role: "user", content: JSON.stringify({ byProvider, byAgent, ops: opsSummary }) },
]);

await notifyEmail("🛠️ Team Manager — weekly fleet report",
  `<pre style="white-space:pre-wrap">${narrative}</pre><hr><h4>By provider</h4><pre>${JSON.stringify(byProvider, null, 2)}</pre><h4>By agent</h4><pre>${JSON.stringify(byAgent, null, 2)}</pre><h4>Ops events</h4><pre>${JSON.stringify(opsSummary, null, 2)}</pre>`);
console.log(narrative);
