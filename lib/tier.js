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
// Firecrawl: the free plan is 1000 credits (not 500), and it renews on the ACCOUNT'S OWN anchor
// day — /v1/team/credit-usage reports a billing period of the 22nd → 22nd, not the 1st. Assuming a
// calendar month meant the tile quoted a reset date up to three weeks off. If you ever move plans,
// re-read that endpoint and update `anchorDay` here.
export const TIER_PROVIDERS = {
  cohere:    { ceiling: 1000,   cadence: "calendar_month", label: "Cohere (Rerank/Embed)" },
  firecrawl: { ceiling: 1000,   cadence: "anchored_month", anchorDay: 22, label: "Firecrawl" },
  tavily:    { ceiling: 1000,   cadence: "calendar_month", label: "Tavily" },
};

const cfgFor = (provider, opts = {}) => {
  const base = TIER_PROVIDERS[provider] || { ceiling: 1000, cadence: "calendar_month", label: provider };
  return {
    ceiling: opts.ceiling ?? base.ceiling,
    cadence: opts.cadence || base.cadence,
    anchorDay: opts.anchorDay ?? base.anchorDay ?? 1,
    label: base.label,
  };
};

// Pure — the current usage window for a cadence. `existing` = the latest stored row (for rolling continuity).
export function pickPeriod(cadence, now = new Date(), existing = null, opts = {}) {
  if (cadence === "rolling_30d") {
    if (existing?.period_end && now < new Date(existing.period_end)) {
      return { start: existing.period_start, end: existing.period_end };
    }
    return { start: now.toISOString(), end: new Date(now.getTime() + 30 * 864e5).toISOString() };
  }
  // anchored_month (UTC): monthly, but renewing on the PROVIDER'S billing day rather than the 1st.
  // Anchors are clamped to 1–28 so the window exists in every month — a 31st anchor would silently
  // skip February. Providers bill on their own anchor (Firecrawl: the 22nd), and quoting the 1st
  // told you a budget resets weeks before it actually does.
  if (cadence === "anchored_month") {
    const day = Math.min(Math.max(Math.trunc(Number(opts.anchorDay) || 1), 1), 28);
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    // The window containing `now` starts at this month's anchor, unless we're still before it.
    let start = new Date(Date.UTC(y, m, day));
    if (now.getTime() < start.getTime()) start = new Date(Date.UTC(y, m - 1, day));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day));
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // calendar_month (UTC): resets on the 1st
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// Pure — has the ceiling been reached?
export const decide = (count, ceiling) => (count >= ceiling ? "exhausted" : "enhanced");

// Pure — does a STORED period_start refer to the same instant as the current period's start?
// Postgres returns timestamptz as "2026-07-01T00:00:00+00:00"; JS toISOString() gives
// "2026-07-01T00:00:00.000Z". Identical instant, different text — so `===` is ALWAYS false against a
// real row. That made getUsage() read every count as 0, pinned each counter at 1 forever, and left
// the ceiling guard unable to fire. Compare instants, never strings.
export const samePeriod = (a, b) => {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  return Number.isFinite(ta) && ta === new Date(b).getTime();
};

// Read the current period's usage for a provider.
export async function getUsage(provider, opts = {}) {
  const { ceiling, cadence, anchorDay, label } = cfgFor(provider, opts);
  const { data: rows, error } = await db()
    .from("tier_usage").select("*").eq("provider", provider)
    .order("period_start", { ascending: false }).limit(1);
  if (error) throw error;
  const latest = rows?.[0] || null;
  const { start, end } = pickPeriod(cadence, new Date(), latest, { anchorDay });
  const current = samePeriod(latest?.period_start, start) ? latest : null; // last row belongs to THIS period?
  const count = current?.count || 0;
  return { provider, label, count, ceiling, cadence, period_start: start, period_end: end, resetAt: end, status: decide(count, ceiling) === "exhausted" ? "exhausted" : "active" };
}

// +1 for the current period (creating the row if needed).
// PREFERS the atomic Postgres path (sql/tier_usage_increment.sql): read-modify-write from here
// loses increments whenever two workflows run at once — both read N, both write N+1. If that
// function isn't installed, we fall back to the old read-modify-write so the fleet still works,
// just with counts that can drift low under concurrency. Same contract as everything else here:
// the add-on is an enhancement, never a dependency.
async function bump(provider, opts = {}) {
  const u = await getUsage(provider, opts);
  const { error: rpcErr } = await db().rpc("tier_usage_increment", {
    p_provider: provider,
    p_period_start: u.period_start,
    p_period_end: u.period_end,
    p_ceiling: u.ceiling,
    p_cadence: u.cadence,
  });
  if (!rpcErr) return;

  // Fall back only when the function is genuinely missing — a real failure should surface.
  const missing = /could not find|does not exist|schema cache|404/i.test(rpcErr.message || "");
  if (!missing) throw rpcErr;

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
