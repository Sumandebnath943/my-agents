// agents/team-manager/index.js
// Weekly fleet report — reads llm_metrics for the last 7 days and aggregates BY
// provider (how each API performs) and BY agent (per-agent cost/failure, incl. MIGI's
// two LLMs, tagged AGENT_NAME=migi). Groq writes the narrative; raw tables are appended.
import { createClient } from "@supabase/supabase-js";
import { env } from "../../lib/env.js";
import { callLLM } from "../../lib/llm.js";
import { notifyEmail } from "../../lib/notify.js";
import { renderEmail, mdToHtml } from "../../lib/email-template.js";

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

const narrative = await callLLM([
  { role: "system", content: "You are an ops lead. Given weekly LLM fleet metrics (by provider, by agent) plus operational events (email delivery failures, rate-limit warnings), write a tight report: provider health (latency, rate limits, outages), cost/value, any agent that's a cost or failure outlier, and CALL OUT email failures or agents approaching their rate limits if there are any. Note MIGI's provider split if present." },
  { role: "user", content: JSON.stringify({ byProvider, byAgent, ops: opsSummary }) },
]);

const tokFmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const tot = rows.reduce((a, r) => ({ calls: a.calls + 1, ok: a.ok + (r.ok ? 1 : 0), tokens: a.tokens + (r.in_tokens || 0) + (r.out_tokens || 0), cost: a.cost + Number(r.est_cost_usd || 0) }), { calls: 0, ok: 0, tokens: 0, cost: 0 });
const provItems = Object.entries(byProvider).map(([k, v]) => ({ title: k, note: `${v.calls} calls · ${v.success} ok · $${v.cost_usd} · ${v.avg_ms}ms avg${v.rate_limits ? ` · ${v.rate_limits} rate-limits` : ""}${v.outages ? ` · ${v.outages} outages` : ""}` }));
const agentItems = Object.entries(byAgent).sort((a, b) => b[1].calls - a[1].calls).slice(0, 12).map(([k, v]) => ({ title: k, note: `${v.calls} calls · ${v.success} ok · $${v.cost_usd} · ${tokFmt(v.tokens)} tokens` }));
const opsNote = opsSummary.email_failures || opsSummary.rate_limit_warnings
  ? `⚠️ ${opsSummary.email_failures} email failure(s) · ${opsSummary.rate_limit_warnings} rate-limit warning(s)${opsSummary.agents_hitting_limits.length ? ` (${opsSummary.agents_hitting_limits.join(", ")})` : ""}`
  : "No ops incidents this week. ✅";

await notifyEmail("🛠️ Team Manager — weekly fleet report", renderEmail({
  title: "Team Manager — fleet report", kicker: "WEEKLY LLM OPS", accent: "#BA7517",
  blocks: [
    { type: "tiles", items: [
      { ramp: "amber", label: "Calls", value: String(tot.calls) },
      { ramp: "amber", label: "Cost", value: `$${tot.cost.toFixed(2)}` },
      { ramp: "amber", label: "Tokens", value: tokFmt(tot.tokens) },
      { ramp: "green", label: "Success", value: `${tot.calls ? Math.round((tot.ok / tot.calls) * 1000) / 10 : 100}%` },
    ] },
    { type: "text", html: mdToHtml(narrative) },
    { type: "stat", text: opsNote },
    { type: "listSection", ramp: "blue", heading: "BY PROVIDER", items: provItems },
    { type: "listSection", ramp: "amber", heading: "BY AGENT", items: agentItems },
  ],
  footer: "Team Manager · llm_metrics, last 7 days",
}));
console.log(narrative);
