// evals/job-dedupe/run.mjs
// Guards duplicate detection (agents/job-agent/dedupe.js) and stale-application nudges
// (agents/job-agent/followup.js).
//
// Deduplication has two opposite failure modes and the suite has to hold BOTH ends:
//   · too loose — two different employers' "Product Manager" collapse into one, and a real job
//     silently disappears from the search. This is the dangerous one.
//   · too tight — the same Nokia role from Naukri, LinkedIn and the careers page stays three rows,
//     which is the bug that prompted this in the first place.
//
// Pure + offline — no DB, no LLM, no network.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { normalizeCompany, normalizeTitle, fingerprint, sameRole, pickBest, dedupe, rankOf } from "../../agents/job-agent/dedupe.js";
import { staleApplications, daysSince, STALE_AFTER } from "../../agents/job-agent/followup.js";
import { cityOf } from "../../agents/job-agent/geo.js";

const J = (title, company, source, extra = {}) => ({ title, company, source, ...extra });
const NOW = new Date("2026-07-25T00:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5).toISOString();

export function run() {
  // --- normalisation -----------------------------------------------------------------------------
  const companyCases = [
    { id: "legal suffixes dropped", a: "Nokia Corporation", b: "Nokia" },
    { id: "India Pvt Ltd dropped", a: "NOKIA India Pvt Ltd", b: "nokia" },
    { id: "punctuation ignored", a: "Observe.AI", b: "Observe AI" },
    { id: "ampersand expanded", a: "Johnson & Johnson", b: "Johnson and Johnson" },
    { id: "technologies dropped", a: "Acme Technologies", b: "Acme" },
  ];
  const compRes = runCases("job-dedupe · company normalisation", companyCases, (c) => {
    const x = normalizeCompany(c.a), y = normalizeCompany(c.b);
    return { ok: x === y && !!x, note: x === y ? "" : `"${x}" != "${y}"` };
  });

  const titleCases = [
    { id: "Sr. expands to senior", a: "Sr. Product Marketing Manager", b: "Senior Product Marketing Manager" },
    { id: "'(Remote)' is noise, dropped", a: "Product Manager (Remote)", b: "Product Manager" },
    { id: "'(Contract)' is noise, dropped", a: "Product Manager (Contract)", b: "Product Manager" },
    { id: "'(6 month contract)' is noise, dropped", a: "Product Manager (6 month contract)", b: "Product Manager" },
    { id: "'(m/f/d)' is noise, dropped", a: "Product Manager (m/f/d)", b: "Product Manager" },
    { id: "a meaningful parenthetical is KEPT", a: "PMM (Enterprise)", b: "PMM Enterprise" },
    { id: "portal branding dropped", a: "Brand Manager | Naukri.com", b: "Brand Manager" },
    { id: "requisition ids dropped", a: "Brand Manager #JR12345", b: "Brand Manager" },
    { id: "Mgr expands to manager", a: "Marketing Mgr", b: "Marketing Manager" },
    { id: "case and spacing ignored", a: "MARKETING  MANAGER", b: "marketing manager" },
  ];
  const titleRes = runCases("job-dedupe · title normalisation", titleCases, (c) => {
    const x = normalizeTitle(c.a), y = normalizeTitle(c.b);
    return { ok: x === y && !!x, note: x === y ? "" : `"${x}" != "${y}"` };
  });

  // Seniority is NOT normalised away — these are genuinely different jobs.
  const senCases = [
    { id: "senior PMM != PMM", a: "Senior Product Marketing Manager", b: "Product Marketing Manager" },
    { id: "lead != manager", a: "Marketing Lead", b: "Marketing Manager" },
    { id: "head != manager", a: "Head of Marketing", b: "Marketing Manager" },
  ];
  const senRes = runCases("job-dedupe · seniority is preserved, not collapsed", senCases, (c) => {
    const x = normalizeTitle(c.a), y = normalizeTitle(c.b);
    return { ok: x !== y, note: x !== y ? "" : `both became "${x}"` };
  });

  const cityCases = [
    { id: "Bangalore = Bengaluru", a: "Bangalore", b: "Bengaluru, Karnataka" },
    { id: "Bombay = Mumbai", a: "Bombay", b: "Mumbai, Maharashtra, India" },
    { id: "Gurgaon = Gurugram", a: "Gurgaon", b: "Gurugram" },
    { id: "Navi Mumbai maps to Mumbai", a: "Navi Mumbai", b: "Mumbai" },
    { id: "unknown city is empty", a: "Atlantis", b: "" },
  ];
  const cityRes = runCases("job-dedupe · city canonicalisation", cityCases, (c) => {
    const x = cityOf(c.a), y = cityOf(c.b);
    return { ok: x === y, note: x === y ? "" : `"${x}" != "${y}"` };
  });

  // --- the dangerous direction: never merge different jobs -----------------------------------------
  const safetyCases = [
    { id: "unknown company is NEVER fingerprinted", j: J("Product Manager", "", "naukri"), check: (f) => f === "" },
    { id: "'(unknown)' company is NEVER fingerprinted", j: J("Product Manager", "(unknown)", "naukri"), check: (f) => f === "" },
    { id: "empty title is never fingerprinted", j: J("", "Acme", "naukri"), check: (f) => f === "" },
  ];
  const safeRes = runCases("job-dedupe · refuses to fingerprint what it can't identify", safetyCases, (c) => {
    const f = fingerprint(c.j);
    return { ok: !!c.check(f), note: c.check(f) ? "" : `got "${f}"` };
  });

  const distinctCases = [
    { id: "different companies stay separate",
      rows: [J("Product Manager", "Acme", "naukri"), J("Product Manager", "Globex", "linkedin")], want: 2 },
    { id: "different titles stay separate",
      rows: [J("Product Manager", "Acme", "naukri"), J("Senior Product Manager", "Acme", "linkedin")], want: 2 },
    { id: "same role in two DIFFERENT cities stays separate",
      rows: [J("Product Manager", "Acme", "naukri", { location: "Bengaluru" }), J("Product Manager", "Acme", "linkedin", { location: "Mumbai" })], want: 2 },
    { id: "unidentifiable rows pass through untouched",
      rows: [J("Product Manager", "", "naukri"), J("Product Manager", "", "linkedin")], want: 2 },
    // REGRESSION (found on live data): cityOf() only knows Indian cities, so it returned "" for
    // BOTH "no location" and "Dallas, Texas". Treating that as a wildcard merged Postman's
    // "Key Account Director" across Dallas, Seattle, Toronto, Chicago and Los Angeles.
    { id: "two unknown FOREIGN cities never merge",
      rows: [J("Key Account Director", "Postman", "greenhouse", { location: "Dallas, Texas, United States" }),
             J("Key Account Director", "Postman", "greenhouse", { location: "Seattle, Washington, United States" })], want: 2 },
    { id: "five foreign cities stay five roles",
      rows: ["Dallas, Texas", "Seattle, Washington", "Toronto, Ontario", "Chicago, Illinois", "Los Angeles, California"]
        .map((loc) => J("Key Account Director", "Postman", "greenhouse", { location: loc })), want: 5 },
    { id: "India vs a foreign city never merge",
      rows: [J("Enterprise Account Executive", "Postman", "greenhouse", { location: "Bengaluru, Karnataka, India" }),
             J("Enterprise Account Executive", "Postman", "greenhouse", { location: "Tokyo, Japan" })], want: 2 },
    // REGRESSION: stripping every parenthetical merged the Danish- and Swedish-speaking versions
    // of one Postman role. Same location, so only the parenthetical distinguishes them.
    { id: "language variants at the SAME location stay separate",
      rows: [J("Account Development Representative (Danish Speaking)", "Postman", "greenhouse", { location: "London, UK" }),
             J("Account Development Representative (Swedish Speaking)", "Postman", "greenhouse", { location: "London, UK" })], want: 2 },
    { id: "region variants stay separate",
      rows: [J("Product Marketing Manager (EMEA)", "Acme", "greenhouse", { location: "Remote" }),
             J("Product Marketing Manager (APAC)", "Acme", "greenhouse", { location: "Remote" })], want: 2 },
    { id: "segment variants stay separate",
      rows: [J("PMM (Enterprise)", "Acme", "greenhouse"), J("PMM (SMB)", "Acme", "greenhouse")], want: 2 },
    { id: "empty input is safe", rows: [], want: 0 },
    { id: "null rows are skipped", rows: [null, J("PMM", "Acme", "greenhouse")], want: 1 },
  ];
  const distinctRes = runCases("job-dedupe · never merges distinct roles", distinctCases, (c) => {
    const { unique } = dedupe(c.rows);
    return { ok: unique.length === c.want, note: unique.length === c.want ? "" : `got ${unique.length}` };
  });

  // --- the bug this was built for ------------------------------------------------------------------
  const mergeCases = [
    { id: "same role from 3 sources collapses to 1",
      rows: [J("Senior Brand Manager", "Nokia", "naukri", { location: "Bengaluru" }),
             J("Sr. Brand Manager", "Nokia Corporation", "linkedin", { location: "Bangalore" }),
             J("Senior Brand Manager", "Nokia", "greenhouse", { location: "Bengaluru, Karnataka" })],
      want: 1, keep: "greenhouse" },
    { id: "a posting with no city merges with one that has a city",
      rows: [J("Brand Manager", "Acme", "naukri", { location: "" }),
             J("Brand Manager", "Acme", "lever", { location: "Pune" })],
      want: 1, keep: "lever" },
    { id: "drivable ATS beats a portal listing",
      rows: [J("PMM", "Acme", "naukri"), J("PMM", "Acme", "greenhouse")], want: 1, keep: "greenhouse" },
    { id: "portal beats a scraping aggregator",
      rows: [J("PMM", "Acme", "remoteok"), J("PMM", "Acme", "naukri")], want: 1, keep: "naukri" },
    { id: "richer description wins within the same source rank",
      rows: [J("PMM", "Acme", "naukri", { description: "short" }), J("PMM", "Acme", "linkedin", { description: "a much longer description here" })],
      want: 1, check: (u) => u[0].description.length > 10 },
    // If a merge ever spans geographies, the India copy must survive — keeping the foreign one
    // would delete an eligible role from the search.
    { id: "the India copy always wins a merge",
      rows: [J("PMM", "Acme", "greenhouse", { location: "", screen: { geo: { geo: "global_remote" } } }),
             J("PMM", "Acme", "naukri", { location: "", screen: { geo: { geo: "india_onsite" } } })],
      want: 1, keep: "naukri" },
  ];
  const mergeRes = runCases("job-dedupe · collapses the same role across sources", mergeCases, (c) => {
    const { unique } = dedupe(c.rows);
    if (unique.length !== c.want) return { ok: false, note: `got ${unique.length} rows` };
    if (c.keep && unique[0].source !== c.keep) return { ok: false, note: `kept ${unique[0].source}, wanted ${c.keep}` };
    if (c.check && !c.check(unique)) return { ok: false, note: `kept ${JSON.stringify(unique[0]).slice(0, 90)}` };
    return { ok: true };
  });

  const rankCases = [
    { id: "greenhouse outranks naukri", check: () => rankOf("greenhouse") < rankOf("naukri") },
    { id: "lever outranks linkedin", check: () => rankOf("lever") < rankOf("linkedin") },
    { id: "naukri outranks remoteok", check: () => rankOf("naukri") < rankOf("remoteok") },
    { id: "unknown source ranks last", check: () => rankOf("mystery") > rankOf("remoteok") },
    { id: "pickBest on one item returns it", check: () => pickBest([J("A", "B", "naukri")]).title === "A" },
    { id: "sameRole is false for garbage", check: () => !sameRole("", "") && !sameRole(null, "a|b|c") },
  ];
  const rankRes = runCases("job-dedupe · source preference", rankCases, (c) => ({ ok: !!c.check() }));

  // --- follow-up nudges ---------------------------------------------------------------------------
  const S = (status, days, extra = {}) => ({ id: `${status}-${days}`, title: "PMM", company: "Acme", status, updated_at: daysAgo(days), ...extra });
  const staleCases = [
    { id: "fresh application is not chased", rows: [S("applied", 3)], want: 0 },
    { id: "application silent past the limit is chased", rows: [S("applied", 20)], want: 1 },
    { id: "exactly at the limit counts", rows: [S("applied", STALE_AFTER.applied)], want: 1 },
    { id: "one day short does not", rows: [S("applied", STALE_AFTER.applied - 1)], want: 0 },
    { id: "interviewing has a tighter limit than applied", rows: [S("interviewing", 8)], want: 1 },
    { id: "same silence, applied stage, not yet chased", rows: [S("applied", 8)], want: 0 },
    { id: "terminal states are never chased", rows: [S("rejected", 90), S("dismissed", 90), S("closed", 90)], want: 0 },
    { id: "'new' is not an application", rows: [S("new", 90)], want: 0 },
    { id: "shortlisted-but-not-applied is a nudge at YOU", rows: [S("shortlisted", 30)], want: 1 },
    { id: "no dates at all is skipped, not assumed stale", rows: [{ id: 1, status: "applied" }], want: 0 },
    { id: "garbage date is skipped", rows: [{ id: 1, status: "applied", updated_at: "not-a-date" }], want: 0 },
    { id: "recent edit resets the clock", rows: [{ id: 1, status: "applied", applied_at: daysAgo(60), updated_at: daysAgo(1) }], want: 0 },
    { id: "falls back to applied_at", rows: [{ id: 1, status: "applied", applied_at: daysAgo(40) }], want: 1 },
    { id: "malformed rows don't throw", rows: [null, undefined, {}], want: 0 },
  ];
  const staleRes = runCases("job-dedupe · stale application nudges", staleCases, (c) => {
    const got = staleApplications(c.rows, { now: NOW });
    return { ok: got.length === c.want, note: got.length === c.want ? "" : `got ${got.length}` };
  });

  const orderCases = [
    { id: "longest silence first", check: () => {
      const got = staleApplications([S("applied", 20), S("applied", 60), S("applied", 30)], { now: NOW });
      return got[0].days === 60 && got[2].days === 20;
    } },
    { id: "carries a concrete action", check: () => /follow-up|ghosted/i.test(staleApplications([S("applied", 30)], { now: NOW })[0].action) },
    { id: "shortlisted action points at you", check: () => /apply or dismiss/i.test(staleApplications([S("shortlisted", 30)], { now: NOW })[0].action) },
    { id: "reports how far overdue", check: () => staleApplications([S("applied", 20)], { now: NOW })[0].overdueBy === 20 - STALE_AFTER.applied },
    { id: "daysSince never goes negative", check: () => daysSince(new Date(NOW.getTime() + 864e5).toISOString(), NOW) === 0 },
    { id: "daysSince of nothing is null", check: () => daysSince(null) === null },
  ];
  const orderRes = runCases("job-dedupe · nudge detail", orderCases, (c) => ({ ok: !!c.check() }));

  return [compRes, titleRes, senRes, cityRes, safeRes, distinctRes, mergeRes, rankRes, staleRes, orderRes];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.reduce((n, r) => n + r.fail, 0)) process.exit(1);
}
