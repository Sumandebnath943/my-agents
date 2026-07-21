// agents/25-skillgap/signals.js
// The gap-signal AGGREGATION, extracted as pure functions so it can be unit-eval'd offline
// (no DB, no network) and can't silently drift from what the agent actually sends to the model.
// Same pattern as agents/inbox-router/route.js.
//
// Each function takes raw rows exactly as Supabase returns them and is defensive about shape:
// a null row, a missing column, or a non-array `issues` must never throw — the monthly run
// degrades to "no signal" rather than failing.

// Number(null) === 0 and Number("") === 0, both of which are finite — so a row with no fit score
// would otherwise be treated as a genuine 0% match and drag the average down. Only treat a value
// as a score when it's actually present.
const fitOf = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** Roles the Job Agent scored, summarised as one line. Lowest fit first = where matching is weakest. */
export function summarizeJobs(jobs) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  if (!rows.length) return "";
  const withFit = rows.filter((j) => Number.isFinite(fitOf(j.fit)));
  const fits = withFit.map((j) => fitOf(j.fit));
  const avg = fits.length ? Math.round(fits.reduce((a, b) => a + b, 0) / fits.length) : null;
  const weakest = [...withFit].sort((a, b) => fitOf(a.fit) - fitOf(b.fit)).slice(0, 6)
    .map((j) => `${j.title || "role"} @ ${j.company || "?"} (${j.fit}%)`);
  const pursued = [...new Set(rows.filter((j) => j.status && j.status !== "new").map((j) => j.title).filter(Boolean))].slice(0, 6);
  return `${rows.length} roles scored in 90d, average fit ${avg ?? "?"}%. Weakest matches: ${weakest.join("; ") || "n/a"}.`
    + (pursued.length ? ` Roles I actually pursued: ${pursued.join("; ")}.` : "");
}

/**
 * The exact JD keywords the ATS engine found missing, counted across recent resume reports.
 * Shape written by the dashboard: categories.keywords.missing = string[].
 * Repeats across reports are the real signal, so a keyword missing twice is marked (×2).
 */
export function topMissingKeywords(reports, limit = 15) {
  const counts = new Map();
  for (const r of Array.isArray(reports) ? reports : []) {
    const missing = r?.categories?.keywords?.missing;
    if (!Array.isArray(missing)) continue;
    for (const raw of missing) {
      const k = String(raw ?? "").toLowerCase().trim();
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([k, n]) => (n > 1 ? `${k} (×${n})` : k));
}

/**
 * What the CTO patrol keeps flagging, aggregated by issue category.
 * Shape written by agents/cto/patrol.js: issues = [{ severity, category, note, where }].
 */
export function topIssueCategories(reviews, limit = 5) {
  const counts = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const issues = r?.issues;
    if (!Array.isArray(issues)) continue;
    for (const i of issues) {
      const c = i?.category;
      if (c) counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([c, n]) => `${c} (${n})`);
}
