// agents/19-review/dossier.js
// The capstone's AGGREGATION, extracted as pure functions so it can be unit-eval'd offline
// (no DB, no LLM, no network) — same pattern as agents/inbox-router/route.js and
// agents/25-skillgap/signals.js.
//
// Historical note: this agent read only 5 Round-1 tables (journal/expenses/habits/reading/ideas)
// and took its spend number from `expenses` — the receipt-PHOTO table — while the real bank ledger
// sat in `finance`. So the "state of you" review reported a fraction of actual spending and was
// blind to jobs, skills, build, outreach, launches, posts, code reviews and brand health.
//
// Every function is defensive about shape: a missing table arrives as [], a row may be null, and a
// numeric column may be null/""/undefined. Nothing here may throw — the weekly email must still go
// out even if half the fleet's tables are empty or absent.

// Number(null) === 0 and Number("") === 0, both finite — so an absent score would otherwise be
// counted as a real zero. Only treat a value as numeric when it is actually present.
export const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const rows = (a) => (Array.isArray(a) ? a : []).filter(Boolean);
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/**
 * Spend for the week from the FINANCE table (the SMS bank ledger — the source of truth).
 * Debits only: the locked ledger policy logs debits, but we filter defensively so a stray credit
 * can never inflate the total. `expenses` (receipt photos) is reported as a separate capture COUNT
 * and deliberately NOT added to the total — the two systems overlap, so summing double-counts.
 */
export function spendSummary(finance, expenses) {
  const debits = rows(finance).filter((f) => f.direction !== "credit");
  const byCat = {};
  let total = 0;
  for (const f of debits) {
    const amt = num(f.amount);
    if (!Number.isFinite(amt)) continue;
    total += amt;
    const c = f.category || "other";
    byCat[c] = (byCat[c] || 0) + amt;
  }
  return {
    total: Math.round(total),
    txns: debits.length,
    currency: rows(finance)[0]?.currency || "INR",
    top_categories: Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([category, amount]) => ({ category, amount: Math.round(amount) })),
    receipts_captured: rows(expenses).length, // separate capture channel, not added to total
  };
}

/** Job pipeline: how many new roles, how well they matched, how many were actually pursued. */
export function jobSummary(jobs) {
  const r = rows(jobs);
  const fits = r.map((j) => num(j.fit)).filter(Number.isFinite);
  const pursued = r.filter((j) => j.status && j.status !== "new");
  return {
    new_roles: r.length,
    avg_fit: avg(fits),
    best: r.filter((j) => Number.isFinite(num(j.fit))).sort((a, b) => num(b.fit) - num(a.fit)).slice(0, 3)
      .map((j) => `${j.title || "role"} @ ${j.company || "?"} (${j.fit}%)`),
    pursued: pursued.length,
  };
}

/** CTO patrol: how much was reviewed and what it flagged, by severity and category. */
export function reviewSummary(reviews) {
  const r = rows(reviews);
  const sev = { high: 0, med: 0, low: 0 };
  const cats = new Map();
  let issues = 0;
  for (const row of r) {
    for (const i of Array.isArray(row.issues) ? row.issues : []) {
      issues++;
      if (sev[i?.severity] != null) sev[i.severity]++;
      if (i?.category) cats.set(i.category, (cats.get(i.category) || 0) + 1);
    }
  }
  return {
    reviews: r.length,
    issues,
    high: sev.high,
    by_severity: sev,
    top_categories: [...cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4).map(([c, n]) => `${c} (${n})`),
    repos: [...new Set(r.map((x) => x.repo).filter(Boolean))].slice(0, 8),
  };
}

/**
 * Brand health: brand_snapshots holds one row per property per week. Keep each property's newest
 * (rows arrive week-descending) and flag week-over-week perf/SEO drops of 8+ points.
 */
export function brandSummary(snapshots) {
  const r = rows(snapshots);
  const latest = new Map();
  const previous = new Map();
  for (const b of r) {
    if (!b.name) continue;
    if (!latest.has(b.name)) latest.set(b.name, b);
    else if (!previous.has(b.name)) previous.set(b.name, b);
  }
  const sites = [...latest.values()];
  const regressions = [];
  for (const [name, cur] of latest) {
    const prev = previous.get(name);
    if (!prev) continue;
    const dPerf = num(prev.perf) - num(cur.perf);
    const dSeo = num(prev.seo) - num(cur.seo);
    if (Number.isFinite(dPerf) && dPerf >= 8) regressions.push(`${name} perf ${prev.perf}→${cur.perf}`);
    if (Number.isFinite(dSeo) && dSeo >= 8) regressions.push(`${name} SEO ${prev.seo}→${cur.seo}`);
  }
  const perfs = sites.map((s) => num(s.perf)).filter(Number.isFinite);
  const seos = sites.map((s) => num(s.seo)).filter(Number.isFinite);
  return {
    sites: sites.length,
    avg_perf: avg(perfs),
    avg_seo: avg(seos),
    broken_links: sites.reduce((n, s) => n + (Number.isFinite(num(s.broken_links)) ? num(s.broken_links) : 0), 0),
    regressions,
    weakest: sites.filter((s) => Number.isFinite(num(s.perf))).sort((a, b) => num(a.perf) - num(b.perf))[0]?.name || null,
  };
}

/** LinkedIn: what actually published this week vs what is still sitting in the queue. */
export function postSummary(posts) {
  const r = rows(posts);
  const posted = r.filter((p) => p.status === "posted");
  return {
    posted: posted.length,
    awaiting: r.filter((p) => p.status === "awaiting").length,
    headlines: posted.map((p) => p.headline).filter(Boolean).slice(0, 5),
  };
}

/** The whole week, assembled. Keys stay compact — this is serialised into the LLM prompt. */
export function buildDossier(d = {}) {
  const journal = rows(d.journal);
  const habits = rows(d.habits);
  const prods = habits.map((h) => num(h.productivity)).filter(Number.isFinite);
  const reading = rows(d.reading);
  const skills = rows(d.skills);
  const builds = rows(d.builds);
  const opps = rows(d.opportunities);
  const launches = rows(d.launches);
  const resumes = rows(d.resumes);

  return {
    journal: { entries: journal.length, days: journal.map((j) => ({ date: j.entry_date, mood: j.mood, themes: j.themes })).slice(0, 7) },
    habits: { logs: habits.length, avg_productivity: avg(prods) },
    spend: spendSummary(d.finance, d.expenses),
    reading: { saved: reading.length, unread: reading.filter((r) => !r.read).length },
    ideas: rows(d.ideas).slice(0, 3).map((i) => ({ title: i.title, score: i.score })),
    jobs: jobSummary(d.jobs),
    skills: { open: skills.filter((s) => s.status === "open").map((s) => s.skill).slice(0, 5), learning: skills.filter((s) => s.status === "learning").map((s) => s.skill).slice(0, 5) },
    build: { top: builds.slice(0, 3).map((b) => ({ pick: b.pick, score: b.score, status: b.status })) },
    outreach: { new: opps.length, titles: opps.map((o) => o.title).filter(Boolean).slice(0, 4) },
    launches: { count: launches.length, repos: [...new Set(launches.map((l) => l.repo).filter(Boolean))].slice(0, 5) },
    linkedin: postSummary(d.posts),
    code: reviewSummary(d.reviews),
    brand: brandSummary(d.brand),
    resume: resumes.length ? { score: resumes[0].score, out_of: resumes[0].score_out_of } : null,
    calendar: calendarSummary(d.calendar),
  };
}

/**
 * Next week's commitments, as parked in kv `calendar:week` by the Calendar agent (#33).
 * Null when that agent hasn't run — the review then just doesn't mention the calendar, rather
 * than implying an empty week.
 */
export function calendarSummary(cal) {
  if (!cal || typeof cal !== "object") return null;
  const events = Array.isArray(cal.events) ? cal.events : [];
  return {
    meetings: Number(cal.meetings) || 0,
    booked_hours: Number(cal.busyHours) || 0,
    next_up: events.slice(0, 5).map((e) => ({ title: e?.title || "(untitled)", start: e?.start || null })),
  };
}

/**
 * Is there anything worth writing about? The old guard checked only the 5 Round-1 tables, so a week
 * with (say) jobs + posts + code reviews but no journal entry would have been skipped entirely.
 */
export function hasAnyData(dos) {
  if (!dos) return false;
  return !!(
    dos.journal?.entries || dos.habits?.logs || dos.spend?.txns || dos.spend?.receipts_captured ||
    dos.reading?.saved || dos.ideas?.length || dos.jobs?.new_roles || dos.outreach?.new ||
    dos.launches?.count || dos.linkedin?.posted || dos.linkedin?.awaiting || dos.code?.reviews ||
    dos.brand?.sites || dos.build?.top?.length || dos.skills?.open?.length || dos.skills?.learning?.length ||
    dos.resume
  );
}
