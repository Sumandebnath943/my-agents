// lib/tier.js
// 🟡-tier CEILING FRAMEWORK — run a free-but-metered add-on (Cohere Rerank, Firecrawl, Tavily, …)
// under a live monthly budget, and DEGRADE GRACEFULLY when the budget is spent.
//
// HARD RULE — enhancement, never dependency: every add-on layers on top of an agent that already
// works. When the ceiling is reached (or the add-on errors, or the tracker itself is down), the
// agent falls back to its baseline path and STILL RUNS. The local counter is the source of truth;
// reset cadence is per-provider. See withCeiling() below.
import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { logEvent } from "./ops.js";

let _db;
const db = () => (_db ||= createClient(env("SUPABASE_URL"), env("SUPABASE_KEY")));

// Known metered add-ons and their FREE monthly ceilings. Best-known defaults — adjust if a provider
// changes its free tier, or override per call via opts.ceiling / opts.cadence.
export const TIER_PROVIDERS = {
  cohere:    { ceiling: 1000,   cadence: "calendar_month", label: "Cohere (Rerank/Embed)" },
  firecrawl: { ceiling: 500,    cadence: "calendar_month", label: "Firecrawl" },
  tavily:    { ceiling: 1000,   cadence: "calendar_month", label: "Tavily" },
};

const cfgFor = (provider, opts = {}) => {
  const base = TIER_PROVIDERS[provider] || { ceiling: 1000, cadence: "calendar_month", label: provider };
  return { ceiling: opts.ceiling ?? base.ceiling, cadence: opts.cadence || base.cadence, label: base.label };
};

// Pure — the current usage window for a cadence. `existing` = the latest stored row (for rolling continuity).
export function pickPeriod(cadence, now = new Date(), existing = null) {
  if (cadence === "rolling_30d") {
    if (existing?.period_end && now < new Date(existing.period_end)) {
      return { start: existing.period_start, end: existing.period_end };
    }
    return { start: now.toISOString(), end: new Date(now.getTime() + 30 * 864e5).toISOString() };
  }
  // calendar_month (UTC): resets on the 1st
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// Pure — has the ceiling been reached?
export const decide = (count, ceiling) => (count >= ceiling ? "exhausted" : "enhanced");

// Read the current period's usage for a provider.
export async function getUsage(provider, opts = {}) {
  const { ceiling, cadence, label } = cfgFor(provider, opts);
  const { data: rows, error } = await db()
    .from("tier_usage").select("*").eq("provider", provider)
    .order("period_start", { ascending: false }).limit(1);
  if (error) throw error;
  const latest = rows?.[0] || null;
  const { start, end } = pickPeriod(cadence, new Date(), latest);
  const current = latest && latest.period_start === start ? latest : null; // last row belongs to THIS period?
  const count = current?.count || 0;
  return { provider, label, count, ceiling, cadence, period_start: start, period_end: end, resetAt: end, status: decide(count, ceiling) === "exhausted" ? "exhausted" : "active" };
}

// Best-effort +1 for the current period (creates the row if needed). Read-modify-write; small races
// across parallel runners are acceptable for a soft budget.
async function bump(provider, opts = {}) {
  const u = await getUsage(provider, opts);
  const next = (u.count || 0) + 1;
  const { error } = await db().from("tier_usage").upsert({
    provider, period_start: u.period_start, period_end: u.period_end,
    count: next, ceiling: u.ceiling, cadence: u.cadence,
    status: next >= u.ceiling ? "exhausted" : "active", updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/**
 * Run a metered add-on UNDER its ceiling. ENHANCEMENT, NEVER DEPENDENCY.
 * @param {string} provider              e.g. "cohere"
 * @param {() => Promise<any>} enhancedFn  the add-on path
 * @param {() => Promise<any>} baselineFn  the current behavior (what the agent does today)
 * @param {{ceiling?: number, cadence?: string}} [opts]
 * @returns {Promise<{used: "enhanced"|"baseline", result: any, ceilingReached: boolean, resetAt: string|null, error?: string}>}
 */
export async function withCeiling(provider, enhancedFn, baselineFn, opts = {}) {
  let usage = null;
  try { usage = await getUsage(provider, opts); }
  catch (e) { console.error(`tier[${provider}] usage read failed (continuing best-effort):`, e.message); }

  if (usage && usage.count >= usage.ceiling) {
    logEvent({ agent: process.env.AGENT_NAME || "unknown", kind: "tier_exhausted", ok: false, detail: `${provider} ceiling ${usage.ceiling} reached; resets ${usage.resetAt}` }).catch(() => {});
    return { used: "baseline", ceilingReached: true, resetAt: usage.resetAt, result: await baselineFn() };
  }

  try {
    const result = await enhancedFn();
    bump(provider, opts).catch((e) => console.error(`tier[${provider}] increment failed:`, e.message));
    return { used: "enhanced", ceilingReached: false, resetAt: usage?.resetAt ?? null, result };
  } catch (e) {
    console.error(`tier[${provider}] add-on failed, using baseline:`, e.message);
    return { used: "baseline", ceilingReached: false, error: e.message, result: await baselineFn() };
  }
}

// Current-period usage across all known providers — for the dashboard tile / a Telegram summary.
export async function usageReport() {
  const out = [];
  for (const p of Object.keys(TIER_PROVIDERS)) {
    try { out.push(await getUsage(p)); } catch { /* skip a provider we can't read */ }
  }
  return out;
}
