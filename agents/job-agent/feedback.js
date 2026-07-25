// agents/job-agent/feedback.js — turning "no, not that one" into a better filter.
//
// Every role you dismiss is a labelled example of the screen getting it wrong. Without this the
// only way to improve targeting is for you to notice a pattern and hand-edit config.js; with it,
// the agent does the noticing and hands you a concrete, specific change to approve.
//
// PROPOSALS ONLY — nothing here edits config.js, and nothing is applied automatically. A filter
// that quietly rewrites itself is a filter you can't reason about, and one bad week of dismissals
// would silently shrink your job search. Every proposal names the evidence behind it.
//
// Pure and offline: it takes rows and returns proposals, so evals/job-feedback covers it fully.

/** Dismissal reasons that say "the FILTER was wrong", vs. ones that are just your preference. */
export const FILTER_FAULTS = ["irrelevant", "location_mismatch", "comp_too_low", "seniority_mismatch"];

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Words too generic to be worth proposing as a title exclusion — blocking these would gut the
// whole search rather than sharpen it.
const STOPWORDS = new Set([
  "senior", "sr", "junior", "jr", "lead", "head", "manager", "director", "principal", "staff",
  "of", "and", "the", "for", "to", "in", "at", "a", "an", "&", "-", "–", "—", ",", "i", "ii", "iii",
  "marketing", "product", "brand", "growth", "digital", "management", "associate", "specialist",
  "global", "regional", "team", "group", "new", "business", "chief", "vp", "avp", "gm",
]);

/** Meaningful words in a title — the candidates for a "these all share X" observation. */
export function titleTokens(title) {
  return norm(title)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Read dismissals and propose changes.
 * @param {Array<object>} rows  jobs rows with { title, company, dismiss_reason, geo_class, geo_reason, fit, url, source }
 * @param {{minCompany?: number, minToken?: number}} [opts]
 * @returns {{proposals: Array, byReason: object, faultRate: number, total: number}}
 */
export function analyzeDismissals(rows = [], opts = {}) {
  const { minCompany = 2, minToken = 3 } = opts;
  const dismissed = (rows || []).filter((r) => r && r.dismiss_reason);
  const byReason = {};
  for (const r of dismissed) byReason[r.dismiss_reason] = (byReason[r.dismiss_reason] || 0) + 1;

  const proposals = [];

  // 1. A company you keep saying no to. Explicit `company_blocked` counts double — that reason
  //    IS the instruction — but repeated "irrelevant" from one employer says the same thing.
  const perCompany = new Map();
  for (const r of dismissed) {
    const c = norm(r.company);
    if (!c || c === "(unknown)") continue;
    if (!perCompany.has(c)) perCompany.set(c, { name: r.company, blocked: 0, other: 0, titles: [] });
    const e = perCompany.get(c);
    if (r.dismiss_reason === "company_blocked") e.blocked++; else e.other++;
    if (e.titles.length < 4 && r.title) e.titles.push(r.title);
  }
  for (const [, e] of perCompany) {
    const weight = e.blocked * 2 + e.other;
    if (e.blocked === 0 && e.other < minCompany) continue;
    if (weight < minCompany) continue;
    proposals.push({
      kind: "block_company",
      target: e.name,
      confidence: e.blocked > 0 ? "high" : "medium",
      evidence: `${e.blocked + e.other} dismissed role(s)${e.blocked ? `, ${e.blocked} explicitly marked "company blocked"` : ""}: ${e.titles.join(", ")}`,
      change: `Add "${e.name}" to COMPANY_EXCLUDE in agents/job-agent/config.js`,
    });
  }

  // 2. A word that keeps showing up in roles you call irrelevant. Only from `irrelevant` — a
  //    location or pay dismissal says nothing about the title.
  const irrelevant = dismissed.filter((r) => r.dismiss_reason === "irrelevant");
  const tokenHits = new Map();
  for (const r of irrelevant) {
    for (const w of new Set(titleTokens(r.title))) {
      if (!tokenHits.has(w)) tokenHits.set(w, []);
      tokenHits.get(w).push(r.title);
    }
  }
  // How often does this word appear in roles you did NOT dismiss? A word that also shows up in
  // roles you kept is describing your search, not the noise in it.
  const kept = (rows || []).filter((r) => r && !r.dismiss_reason);
  const keptTokens = new Map();
  for (const r of kept) for (const w of new Set(titleTokens(r.title))) keptTokens.set(w, (keptTokens.get(w) || 0) + 1);

  for (const [word, titles] of tokenHits) {
    if (titles.length < minToken) continue;
    const keptCount = keptTokens.get(word) || 0;
    if (keptCount > 0) continue;                       // ambiguous — you kept roles with this word
    proposals.push({
      kind: "exclude_title_word",
      target: word,
      confidence: titles.length >= minToken + 2 ? "high" : "medium",
      evidence: `"${word}" appears in ${titles.length} role(s) you called irrelevant and none you kept: ${titles.slice(0, 4).join(", ")}`,
      change: `Add /\\b${word}\\b/i to TITLE_EXCLUDE in agents/job-agent/config.js`,
    });
  }

  // 3. Geo-gate MISSES. A `location_mismatch` dismissal means a role cleared the geo gate and
  //    should not have — the highest-value signal here, because it is a bug with a test case
  //    attached rather than a preference.
  const geoMisses = dismissed.filter((r) => r.dismiss_reason === "location_mismatch");
  for (const r of geoMisses) {
    proposals.push({
      kind: "geo_miss",
      target: r.title ? `${r.title} @ ${r.company || "?"}` : "(untitled role)",
      confidence: "high",
      evidence: `Passed the geo gate as ${r.geo_class || "?"} — reason given: ${r.geo_reason || "(none recorded)"}`,
      change: `Add a rejecting case to evals/job-filter for this posting, then tighten geo.js until it fails`,
      url: r.url || null,
    });
  }

  // 4. Repeated seniority mismatches point at the title bands, not at any one role.
  const seniority = dismissed.filter((r) => r.dismiss_reason === "seniority_mismatch");
  if (seniority.length >= minToken) {
    proposals.push({
      kind: "seniority_drift",
      target: `${seniority.length} roles`,
      confidence: "medium",
      evidence: `Dismissed for seniority: ${seniority.slice(0, 4).map((r) => r.title).filter(Boolean).join(", ")}`,
      change: `Review LEVELS in config.js, or raise MIN_FIT — the scorer is not weighting seniority hard enough`,
    });
  }

  // 5. Pay dismissals where the posting never stated pay. Not a filter bug (the comp gate only
  //    rejects DISCLOSED sub-floor pay, by design) but worth knowing if it happens a lot.
  const compMisses = dismissed.filter((r) => r.dismiss_reason === "comp_too_low");
  if (compMisses.length >= minToken) {
    proposals.push({
      kind: "comp_blind",
      target: `${compMisses.length} roles`,
      confidence: "low",
      evidence: `Dismissed on pay after the fact: ${compMisses.slice(0, 4).map((r) => r.title).filter(Boolean).join(", ")}`,
      change: `Expected — most postings hide pay, so the floor can't catch these before you see them. Only act if this stays high.`,
    });
  }

  const faults = dismissed.filter((r) => FILTER_FAULTS.includes(r.dismiss_reason)).length;
  const order = { high: 0, medium: 1, low: 2 };
  proposals.sort((a, b) => order[a.confidence] - order[b.confidence]);

  return {
    proposals,
    byReason,
    total: dismissed.length,
    // What share of dismissals are the filter's fault rather than your preference? This is the one
    // number that says whether targeting is actually improving over time.
    faultRate: dismissed.length ? Math.round((faults / dismissed.length) * 100) : 0,
  };
}

/** One-line summary for the email subject / dashboard. */
export function summarizeFeedback(a) {
  if (!a.total) return "No dismissals yet — nothing to learn from.";
  const top = Object.entries(a.byReason).sort((x, y) => y[1] - x[1])[0];
  return `${a.total} dismissed · mostly "${String(top[0]).replace(/_/g, " ")}" (${top[1]}) · ${a.faultRate}% were the filter's fault · ${a.proposals.length} proposal(s)`;
}
