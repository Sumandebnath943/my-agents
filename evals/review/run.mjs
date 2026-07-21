// evals/review/run.mjs
// Guards the Weekly Founder Review's aggregation (agents/19-review/dossier.js). Pure + offline.
//
// Two of these cases lock in bugs the rewire fixed and must never come back:
//   * spend must come from `finance` (the bank ledger), NOT `expenses` (receipt photos), and the
//     two must never be summed — they overlap, so adding them double-counts.
//   * hasAnyData must consider the WHOLE fleet: a week with jobs/posts/code-reviews but no journal
//     entry used to be skipped entirely, sending no email at all.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { buildDossier, hasAnyData, spendSummary, jobSummary, reviewSummary, brandSummary, postSummary } from "../../agents/19-review/dossier.js";

export function run() {
  // --- spend: the headline correctness fix ------------------------------------------------------
  const fin = [
    { amount: 450, direction: "debit", category: "food" },
    { amount: 1200, direction: "debit", category: "bills" },
    { amount: 300, direction: "debit", category: "food" },
  ];
  const spendCases = [
    { id: "sums debits only", check: () => spendSummary([...fin, { amount: 90000, direction: "credit", category: "income" }], []).total === 1950 },
    { id: "credit never inflates total", check: () => spendSummary([{ amount: 5000, direction: "credit" }], []).total === 0 },
    { id: "receipts counted, NOT added", check: () => { const s = spendSummary(fin, [{ amount: 999 }, { amount: 5 }]); return s.total === 1950 && s.receipts_captured === 2; } },
    { id: "categories aggregated + sorted", check: () => { const c = spendSummary(fin, []).top_categories; return c[0].category === "bills" && c[1].category === "food" && c[1].amount === 750; } },
    { id: "null amount ignored not zeroed", check: () => spendSummary([{ amount: null, direction: "debit" }, { amount: 100, direction: "debit" }], []).total === 100 },
    { id: "empty finance -> zero", check: () => spendSummary([], []).total === 0 },
    { id: "null input safe", check: () => spendSummary(null, null).total === 0 },
    { id: "missing category -> other", check: () => spendSummary([{ amount: 50, direction: "debit" }], []).top_categories[0].category === "other" },
  ];
  const spend = runCases("review · spend (finance, not expenses)", spendCases, (c) => ({ ok: c.check() }));

  // --- hasAnyData: the "silent skip" fix --------------------------------------------------------
  const emptyish = { journal: [], expenses: [], finance: [], habits: [], reading: [], ideas: [], jobs: [], skills: [], builds: [], opportunities: [], launches: [], posts: [], reviews: [], brand: [], resumes: [] };
  const guardCases = [
    { id: "all empty -> skip", check: () => hasAnyData(buildDossier(emptyish)) === false },
    { id: "undefined input -> skip", check: () => hasAnyData(buildDossier({})) === false },
    { id: "null dossier -> skip", check: () => hasAnyData(null) === false },
    { id: "journal only -> run (old behaviour kept)", check: () => hasAnyData(buildDossier({ ...emptyish, journal: [{ entry_date: "2026-07-20" }] })) === true },
    { id: "jobs only -> run (was skipped before)", check: () => hasAnyData(buildDossier({ ...emptyish, jobs: [{ title: "PMM", fit: 70 }] })) === true },
    { id: "code reviews only -> run (was skipped)", check: () => hasAnyData(buildDossier({ ...emptyish, reviews: [{ repo: "m", issues: [] }] })) === true },
    { id: "linkedin only -> run (was skipped)", check: () => hasAnyData(buildDossier({ ...emptyish, posts: [{ status: "posted" }] })) === true },
    { id: "brand only -> run (was skipped)", check: () => hasAnyData(buildDossier({ ...emptyish, brand: [{ name: "HoN", perf: 90 }] })) === true },
    { id: "receipts only -> run", check: () => hasAnyData(buildDossier({ ...emptyish, expenses: [{ amount: 10 }] })) === true },
  ];
  const guard = runCases("review · no-data guard covers whole fleet", guardCases, (c) => ({ ok: c.check() }));

  // --- the rest of the aggregation --------------------------------------------------------------
  const jobRows = [
    { title: "PMM", company: "Acme", fit: 40, status: "new" },
    { title: "Senior PMM", company: "Globex", fit: 90, status: "applied" },
    { title: "No score", company: "X", fit: null, status: "new" },
  ];
  const reviewRows = [
    { repo: "migi", issues: [{ severity: "high", category: "security" }, { severity: "low", category: "tests" }] },
    { repo: "cite", issues: [{ severity: "high", category: "security" }] },
    { repo: "migi", issues: null },
  ];
  const brandRows = [
    { name: "HoN", week: "2026-W29", perf: 70, seo: 90, broken_links: 2 },
    { name: "HoN", week: "2026-W28", perf: 90, seo: 92, broken_links: 0 },
    { name: "Portfolio", week: "2026-W29", perf: 95, seo: 97, broken_links: 0 },
  ];
  const aggCases = [
    { id: "job avg excludes null fit", check: () => jobSummary(jobRows).avg_fit === 65 },
    { id: "job counts pursued", check: () => jobSummary(jobRows).pursued === 1 },
    { id: "job best sorted desc", check: () => jobSummary(jobRows).best[0].includes("Globex") },
    { id: "job empty safe", check: () => jobSummary([]).new_roles === 0 && jobSummary(null).avg_fit === null },
    { id: "review counts issues across rows", check: () => reviewSummary(reviewRows).issues === 3 },
    { id: "review counts high severity", check: () => reviewSummary(reviewRows).high === 2 },
    { id: "review null issues safe", check: () => reviewSummary([{ repo: "a", issues: null }]).issues === 0 },
    { id: "review dedupes repos", check: () => reviewSummary(reviewRows).repos.length === 2 },
    { id: "brand keeps newest week per site", check: () => { const b = brandSummary(brandRows); return b.sites === 2 && b.avg_perf === 82.5; } },
    { id: "brand detects perf regression", check: () => brandSummary(brandRows).regressions.some((r) => r.includes("perf 90→70")) },
    { id: "brand ignores <8pt drift", check: () => brandSummary([{ name: "A", week: "2", perf: 90 }, { name: "A", week: "1", perf: 93 }]).regressions.length === 0 },
    { id: "brand sums broken links", check: () => brandSummary(brandRows).broken_links === 2 },
    { id: "brand weakest identified", check: () => brandSummary(brandRows).weakest === "HoN" },
    { id: "posts split posted vs awaiting", check: () => { const p = postSummary([{ status: "posted", headline: "a" }, { status: "awaiting" }]); return p.posted === 1 && p.awaiting === 1 && p.headlines[0] === "a"; } },
    { id: "dossier never throws on junk", check: () => { const d = buildDossier({ journal: [null], finance: [null], reviews: [null], brand: [null], jobs: [null] }); return typeof d === "object" && d.spend.total === 0; } },
    { id: "dossier is JSON-serialisable", check: () => typeof JSON.stringify(buildDossier(emptyish)) === "string" },
  ];
  const agg = runCases("review · fleet aggregation", aggCases, (c) => ({ ok: c.check() }));

  return [spend, guard, agg];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
