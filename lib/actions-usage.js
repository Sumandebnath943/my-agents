// lib/actions-usage.js — GitHub Actions minutes used per month.
//
// COSTS NO ACTIONS MINUTES BEYOND THE RUN THAT CALLS IT: this is one HTTPS read of the billing
// API, folded into a workflow that already runs (the Monday Team Manager report). It starts no
// new workflow and adds no new scheduled event — deliberately, because the fleet is already being
// throttled by GitHub for asking too often (see SECURITY_POSTURE.md sec 8).
//
// The old /settings/billing/actions endpoint now answers 410 Gone. The current one is
// /settings/billing/usage, which returns per-month-per-repo line items that must be summed.
//
// BEST-EFFORT, NEVER THROWS: a billing hiccup must not take down the weekly report. Callers get
// `{ error }` and are expected to SAY so rather than render a confident zero.

export const FREE_PRIVATE_MINUTES = 2000;   // GitHub Free allowance for PRIVATE repos.

export async function actionsUsage({ owner, token } = {}) {
  const user = owner || process.env.GH_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
  const auth = token || process.env.GH_PAT || process.env.GH_TOKEN;
  if (!user) return { error: "No GitHub owner configured (GH_OWNER).", months: [] };
  if (!auth) return { error: "No GitHub token configured (GH_PAT).", months: [] };

  let res;
  try {
    res = await fetch(`https://api.github.com/users/${user}/settings/billing/usage`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${auth}`, "User-Agent": "migi-team-manager" },
    });
  } catch (e) {
    return { error: `Could not reach GitHub billing: ${e.message}`, months: [] };
  }
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 404
      ? " — the token likely lacks billing read access (a classic PAT needs the `user` scope)."
      : "";
    return { error: `GitHub billing API returned ${res.status}${hint}`, months: [] };
  }

  let items;
  try { items = (await res.json())?.usageItems || []; }
  catch (e) { return { error: `Unreadable billing response: ${e.message}`, months: [] }; }

  const byMonth = new Map();
  for (const it of items) {
    if (it.product !== "actions" || it.unitType !== "Minutes") continue;
    const key = String(it.date || "").slice(0, 7);
    if (!key) continue;
    const b = byMonth.get(key) || { month: key, minutes: 0, billed_usd: 0, repos: {} };
    const qty = Number(it.quantity || 0);
    b.minutes += qty;
    b.billed_usd += Number(it.netAmount || 0);
    const repo = it.repositoryName || "unknown";
    b.repos[repo] = Math.round((b.repos[repo] || 0) + qty);
    byMonth.set(key, b);
  }

  const months = [...byMonth.values()]
    .map((m) => ({ ...m, minutes: Math.round(m.minutes), billed_usd: Number(m.billed_usd.toFixed(2)) }))
    .sort((a, b) => b.month.localeCompare(a.month));

  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const current = months.find((m) => m.month === ym) || { month: ym, minutes: 0, billed_usd: 0, repos: {} };

  return {
    months,
    current,
    free_private_minutes: FREE_PRIVATE_MINUTES,
    pct_of_private_allowance: Math.round((current.minutes / FREE_PRIVATE_MINUTES) * 100),
  };
}

/** One-line summary for Telegram / email. Always returns a string, even on failure. */
export function usageLine(u) {
  if (!u || u.error) return `⚠️ Actions minutes unavailable — ${u?.error || "unknown error"}`;
  const { current, pct_of_private_allowance: pct, free_private_minutes: free } = u;
  const prev = u.months.find((m) => m.month !== current.month);
  const trend = prev ? ` (last month ${prev.minutes.toLocaleString("en-IN")})` : "";
  const warn = pct >= 100
    ? `\n⚠️ Over the ${free.toLocaleString("en-IN")}-min allowance that would apply if the repo were PRIVATE. Free while public.`
    : "";
  return `⚙️ Actions minutes — ${current.minutes.toLocaleString("en-IN")} used in ${current.month}${trend}. ${pct}% of the ${free.toLocaleString("en-IN")}-min private allowance.${warn}`;
}
