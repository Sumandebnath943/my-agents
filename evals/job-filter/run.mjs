// evals/job-filter/run.mjs
// Guards the Job Agent's deterministic gate — agents/job-agent/geo.js + filter.js.
//
// This suite exists because of a specific failure: the old filter passed any location containing
// "remote" (so "Remote - US" and "Remote (EMEA)" both got through) and auto-passed BLANK locations,
// which is what filled the inbox with roles an India resident can't hold. The geo cases below are
// therefore regression tests with teeth, not illustrations.
//
// Pure + offline — no DB, no LLM, no network.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { classifyGeo, GEO } from "../../agents/job-agent/geo.js";
import { matchTitle, isBlockedCompany, parseSalary, compGate, ageInDays, freshnessGate, screen } from "../../agents/job-agent/filter.js";
import { isJobResult, cleanTitle, extractCompany, toCandidate, buildPairs, rotate, PORTALS } from "../../agents/job-agent/portals.js";
import { PORTAL_QUERIES, PORTAL_SEARCHES_PER_RUN, MAX_AGE_DAYS } from "../../agents/job-agent/config.js";

const NOW = new Date("2026-07-25T00:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5).toISOString();

export function run() {
  // --- geo: the roles that must be REJECTED -----------------------------------------------------
  const geoReject = [
    { id: "remote - US", job: { location: "Remote - US" } },
    { id: "remote (EMEA)", job: { location: "Remote (EMEA)" } },
    { id: "remote, Canada", job: { location: "Remote, Canada" } },
    { id: "US Remote (reversed)", job: { location: "US Remote" } },
    { id: "remote in the United Kingdom", job: { location: "Remote in the United Kingdom" } },
    { id: "San Francisco, CA", job: { location: "San Francisco, CA" } },
    { id: "bare US state code", job: { location: "Austin, TX" } },
    { id: "London office", job: { location: "London" } },
    { id: "Singapore", job: { location: "Singapore" } },
    { id: "LI routing tag", job: { location: "Remote", description: "Great team. #LI-Remote-US" } },
    { id: "must be authorized (US)", job: { location: "Remote", description: "You must be legally authorized to work in the United States." } },
    { id: "work authorization in the UK", job: { location: "", description: "Work authorization in the UK is required for this role." } },
    { id: "right to work in the EU", job: { location: "Remote", description: "Candidates need the right to work in the EU." } },
    { id: "must reside in the US", job: { location: "Remote", description: "You must reside in the United States for this position." } },
    { id: "US candidates only", job: { location: "Remote", description: "US-based candidates only, please." } },
    { id: "open only to candidates in Canada", job: { location: "Remote", description: "This role is open only to candidates in Canada." } },
    { id: "role is based in Berlin", job: { location: "Remote", description: "This position is based in our Berlin office." } },
    { id: "no sponsorship + foreign region", job: { location: "Remote", description: "We are unable to sponsor visas. Our team is spread across Europe." } },
    { id: "anywhere narrowed to the US", job: { location: "Remote", description: "Work from anywhere in the US!" } },
  ];
  const rejectRes = runCases("job-filter · geo REJECTS non-India roles", geoReject, (c) => {
    const v = classifyGeo(c.job);
    return { ok: v.eligible === false && v.geo === GEO.FOREIGN, note: v.eligible === false ? "" : `got ${v.geo}/${v.eligible} — ${v.reason}` };
  });

  // --- geo: the roles that must be ACCEPTED -----------------------------------------------------
  const geoAccept = [
    { id: "Bengaluru, India", job: { location: "Bengaluru, India" }, geo: GEO.INDIA_ONSITE },
    { id: "Pune (city only)", job: { location: "Pune" }, geo: GEO.INDIA_ONSITE },
    { id: "Gurugram", job: { location: "Gurugram, Haryana" }, geo: GEO.INDIA_ONSITE },
    { id: "Remote - India", job: { location: "Remote - India" }, geo: GEO.INDIA_REMOTE },
    { id: "India wins over US office in JD", job: { location: "Mumbai, India", description: "Our headquarters is in San Francisco, CA and you must be authorized to work in the United States." }, geo: GEO.INDIA_ONSITE },
    { id: "multi-site incl. India", job: { location: "London, UK or Bengaluru, India" }, geo: GEO.INDIA_ONSITE },
    { id: "worldwide", job: { location: "Worldwide" }, geo: GEO.GLOBAL_REMOTE },
    { id: "anywhere", job: { location: "Anywhere" }, geo: GEO.GLOBAL_REMOTE },
    { id: "APAC includes India", job: { location: "Remote (APAC)" }, geo: GEO.GLOBAL_REMOTE },
    { id: "global remote in JD", job: { location: "Remote", description: "We are a fully distributed team and hire from anywhere in the world." }, geo: GEO.GLOBAL_REMOTE },
    { id: "India named only in JD", job: { location: "", description: "You will join our Hyderabad team." }, geo: GEO.INDIA_ONSITE },
  ];
  const acceptRes = runCases("job-filter · geo ACCEPTS India-eligible roles", geoAccept, (c) => {
    const v = classifyGeo(c.job);
    const ok = v.eligible === true && v.geo === c.geo;
    return { ok, note: ok ? "" : `got ${v.geo}/${v.eligible} — ${v.reason}` };
  });

  // --- geo: undecidable must be UNKNOWN, never a silent pass ------------------------------------
  const geoUnknown = [
    { id: "blank location, silent JD", job: { location: "", description: "Own the roadmap and ship great things." } },
    { id: "bare 'Remote', silent JD", job: { location: "Remote", description: "Own the roadmap and ship great things." } },
    { id: "location names no country", job: { location: "HQ" } },
    { id: "no fields at all", job: {} },
  ];
  const unknownRes = runCases("job-filter · geo defers instead of guessing", geoUnknown, (c) => {
    const v = classifyGeo(c.job);
    const ok = v.eligible === null && v.geo === GEO.UNKNOWN;
    return { ok, note: ok ? "" : `got ${v.geo}/${v.eligible} — ${v.reason}` };
  });

  // "India" must not be matched inside Indiana/Indianapolis, and flags are informational only.
  const geoEdge = [
    { id: "Indianapolis is not India", check: () => classifyGeo({ location: "Indianapolis, IN" }).eligible === false },
    { id: "Indiana is not India", check: () => classifyGeo({ location: "Indiana" }).eligible === false },
    { id: "'join us' is not the USA", check: () => classifyGeo({ location: "Bengaluru, India", description: "Come join us! We cannot sponsor visas." }).eligible === true },
    { id: "'global leader' boilerplate is not global-remote", check: () => classifyGeo({ location: "Remote", description: "We are a global leader in payments." }).geo === GEO.UNKNOWN },
    { id: "timezone demand flags, never rejects", check: () => { const v = classifyGeo({ location: "Remote - India", description: "You must overlap 4 hours with PST." }); return v.eligible === true && v.flags.some((f) => /working hours/.test(f)); } },
    { id: "no-sponsorship alone only flags", check: () => { const v = classifyGeo({ location: "Bengaluru, India", description: "We cannot provide visa sponsorship." }); return v.eligible === true; } },
  ];
  const edgeRes = runCases("job-filter · geo edge cases", geoEdge, (c) => ({ ok: !!c.check() }));

  // --- titles -----------------------------------------------------------------------------------
  const titleCases = [
    { id: "Senior PMM", t: "Senior Product Marketing Manager", want: "pmm" },
    { id: "PMM abbreviation", t: "PMM, Enterprise", want: "pmm" },
    { id: "AI PMM", t: "AI Product Marketing Manager", want: "pmm" },
    { id: "AI Product Manager", t: "AI Product Manager", want: "ai" },
    { id: "GenAI growth", t: "GenAI Growth Lead", want: "ai" },
    { id: "plain Product Manager", t: "Product Manager", want: "pm" },
    { id: "Group Product Manager", t: "Group Product Manager", want: "pm" },
    { id: "plain Manager is IN scope", t: "Marketing Manager", want: "growth_brand" },
    { id: "Senior Brand Marketing Manager", t: "Senior Brand Marketing Manager", want: "growth_brand" },
    { id: "Senior Digital Marketing Manager", t: "Senior Digital Marketing Manager", want: "growth_brand" },
    { id: "Head of Marketing", t: "Head of Marketing", want: "growth_brand" },
    { id: "Director of Marketing", t: "Director of Marketing", want: "growth_brand" },
    { id: "Growth Marketing Manager", t: "Growth Marketing Manager", want: "growth_brand" },
    // out of scope
    { id: "Marketing Intern", t: "Marketing Intern", want: null },
    { id: "Marketing Executive (junior in India)", t: "Marketing Executive", want: null },
    { id: "Marketing Coordinator", t: "Marketing Coordinator", want: null },
    { id: "Project Manager is not Product Manager", t: "Project Manager", want: null },
    { id: "Program Manager", t: "Program Manager", want: null },
    { id: "Account Manager", t: "Account Manager", want: null },
    { id: "Sales Manager", t: "Sales Manager", want: null },
    { id: "Customer Success Manager", t: "Customer Success Manager", want: null },
    { id: "Business Development Manager", t: "Business Development Manager", want: null },
    { id: "SDR", t: "SDR - Outbound", want: null },
    { id: "Engineering Manager", t: "Engineering Manager", want: null },
    { id: "empty title", t: "", want: null },
  ];
  const titleRes = runCases("job-filter · title bands", titleCases, (c) => {
    const got = matchTitle(c.t);
    const fam = got?.family ?? null;
    return { ok: fam === c.want, note: fam === c.want ? "" : `got ${fam}` };
  });

  // --- compensation -----------------------------------------------------------------------------
  const compCases = [
    { id: "reject 6-9 LPA", text: "Salary: 6-9 LPA", ok: false },
    { id: "reject ₹8,00,000", text: "CTC ₹8,00,000 per annum", ok: false },
    { id: "accept 12-18 LPA", text: "12-18 LPA", ok: true },
    { id: "accept 15L", text: "Compensation: 15L", ok: true },
    { id: "accept 1.2 crore", text: "Up to 1.2 Cr", ok: true },
    { id: "accept ₹14,00,000", text: "Fixed pay ₹14,00,000", ok: true },
    { id: "range straddling floor passes on max", text: "8-16 LPA", ok: true },
    { id: "UNDISCLOSED PASSES", text: "Competitive salary and equity.", ok: true },
    { id: "empty passes", text: "", ok: true },
    { id: "USD never blocks", text: "$120,000 - $150,000", ok: true },
    { id: "exactly at floor passes", text: "11 LPA", ok: true },
    // REGRESSION (found on live data): a real PhonePe JD advertising "60 Crore users",
    // "4 Crore merchants" and "INR 150 lakh crore" in payment volume parsed as a ₹150–400 LPA
    // salary. Business-scale numbers are not pay, and the same bug could reject a good role.
    { id: "company-scale crores are not pay", text: "Serving 60 Crore users and 4 Crore merchants with INR 150 lakh crore in TPV.", ok: true },
    { id: "'5 lakh customers' is not pay", text: "We serve over 5 lakh customers across India.", ok: true },
    { id: "cue word makes it pay again", text: "Salary: 6-9 LPA", ok: false },
    { id: "CTC cue near a rupee figure", text: "CTC ₹8,00,000 fixed", ok: false },
  ];
  const compRes = runCases("job-filter · comp floor (rejects only on disclosed sub-floor pay)", compCases, (c) => {
    const g = compGate(c.text, 11);
    return { ok: g.ok === c.ok, note: g.ok === c.ok ? "" : `got ok=${g.ok} ${g.reason}` };
  });

  const salaryCases = [
    { id: "parses INR range", text: "12-18 LPA", check: (s) => s.disclosed && s.currency === "inr" && s.minLpa === 12 && s.maxLpa === 18 },
    // Weak units need a compensation cue word — that is the whole point of the window logic.
    { id: "parses crore as 100 lakh", text: "Package: 1 crore", check: (s) => s.maxLpa === 100 },
    { id: "parses rupee figure", text: "CTC ₹9,50,000", check: (s) => s.currency === "inr" && Math.round(s.maxLpa * 10) / 10 === 9.5 },
    { id: "parses a rupee RANGE, both ends", text: "Salary ₹12,00,000 - ₹18,00,000", check: (s) => s.minLpa === 12 && s.maxLpa === 18 },
    { id: "bare crore without a cue is ignored", text: "1 crore", check: (s) => !s.disclosed },
    { id: "foreign currency tagged", text: "$130,000", check: (s) => s.disclosed && s.currency === "foreign" },
    { id: "nothing disclosed", text: "great pay", check: (s) => !s.disclosed && s.currency === null },
    { id: "business metrics ignored", text: "60 Crore users, INR 150 lakh crore TPV", check: (s) => !s.disclosed },
    { id: "LPA needs no cue word", text: "18 LPA", check: (s) => s.disclosed && s.maxLpa === 18 },
    { id: "trusted field needs no cue word", text: "INR 1200000-1800000", opts: { trusted: true }, check: (s) => s.disclosed && s.currency === "inr" && s.maxLpa === 18 },
    { id: "untrusted same string stays silent", text: "INR 1200000-1800000", check: (s) => !s.disclosed },
  ];
  const salRes = runCases("job-filter · salary parsing", salaryCases, (c) => {
    const s = parseSalary(c.text, c.opts);
    return { ok: !!c.check(s), note: c.check(s) ? "" : JSON.stringify(s) };
  });

  // --- freshness + company ----------------------------------------------------------------------
  const freshCases = [
    { id: "5 days old passes", posted: daysAgo(5), ok: true },
    { id: "29 days old passes", posted: daysAgo(29), ok: true },
    { id: "45 days old rejected", posted: daysAgo(45), ok: false },
    { id: "UNDATED never aged out", posted: null, ok: true },
    { id: "garbage date never aged out", posted: "not-a-date", ok: true },
    { id: "future date clamps to 0", posted: new Date(NOW.getTime() + 864e5).toISOString(), ok: true },
  ];
  const freshRes = runCases("job-filter · freshness", freshCases, (c) => {
    const g = freshnessGate(c.posted, 30, NOW);
    return { ok: g.ok === c.ok, note: g.ok === c.ok ? "" : `got ok=${g.ok} ${g.reason}` };
  });

  const companyCases = [
    { id: "blocks PIBM acronym", c: "PIBM", want: true },
    { id: "blocks full name", c: "Pune Institute of Business Management", want: true },
    { id: "blocks case-insensitively", c: "pune institute of business management, pune", want: true },
    { id: "allows others", c: "Postman", want: false },
    { id: "empty is not blocked", c: "", want: false },
  ];
  const compExRes = runCases("job-filter · company exclusions", companyCases, (c) => {
    const got = isBlockedCompany(c.c);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  // --- the whole gate ---------------------------------------------------------------------------
  const good = { title: "Senior Product Marketing Manager", company: "Postman", location: "Bengaluru, India", description: "Own GTM for our API platform.", posted_at: daysAgo(3), salary: "" };
  const screenCases = [
    { id: "good role passes", job: good, check: (v) => v.pass && v.family === "pmm" },
    { id: "US-remote role fails at geo", job: { ...good, location: "Remote - US" }, check: (v) => !v.pass && v.stage === "geo" },
    { id: "wrong function fails at title", job: { ...good, title: "Account Manager" }, check: (v) => !v.pass && v.stage === "title" },
    { id: "blocked employer fails first", job: { ...good, company: "PIBM" }, check: (v) => !v.pass && v.stage === "company" },
    { id: "stale role fails at freshness", job: { ...good, posted_at: daysAgo(120) }, check: (v) => !v.pass && v.stage === "freshness" },
    { id: "45d old still passes at the 60d default", job: { ...good, posted_at: daysAgo(45) }, check: (v) => v.pass },
    { id: "low pay fails at comp", job: { ...good, salary: "5-8 LPA" }, check: (v) => !v.pass && v.stage === "comp" },
    { id: "ambiguous geo defers, does not pass", job: { ...good, location: "", description: "Own GTM." }, check: (v) => !v.pass && v.needsGeoCheck },
    { id: "rejection carries a reason", job: { ...good, location: "London" }, check: (v) => !v.pass && typeof v.reason === "string" && v.reason.length > 0 },
    { id: "undisclosed pay still passes", job: { ...good, salary: "", description: "Competitive salary." }, check: (v) => v.pass },
  ];
  const screenRes = runCases("job-filter · full screen", screenCases, (c) => {
    const v = screen(c.job, { now: NOW });
    const ok = !!c.check(v);
    return { ok, note: ok ? "" : `pass=${v.pass} stage=${v.stage} needsGeo=${v.needsGeoCheck} — ${v.reason}` };
  });

  // --- portal discovery -------------------------------------------------------------------------
  // Search results include plenty that is NOT a job posting — listicles, company pages, salary
  // guides. Letting those through would spend a Firecrawl call and then a scoring call on a blog.
  const urlCases = [
    { id: "naukri job listing", url: "https://www.naukri.com/job-listings-senior-product-marketing-manager-acme-bengaluru-5-to-9-years-010125001234", p: "naukri", want: true },
    { id: "naukri career advice", url: "https://www.naukri.com/blog/top-10-marketing-jobs-2026/", p: "naukri", want: false },
    { id: "instahyre job", url: "https://www.instahyre.com/job/123456/product-marketing-manager-at-acme", p: "instahyre", want: true },
    { id: "cutshort job", url: "https://cutshort.io/job/Product-Marketing-Manager-Bangalore-Acme-abc123", p: "cutshort", want: true },
    { id: "hirist job", url: "https://www.hirist.tech/j/senior-product-marketing-manager-1234567.html", p: "hirist", want: true },
    { id: "iimjobs job", url: "https://www.iimjobs.com/j/senior-product-marketing-manager-acme-1234567.html", p: "iimjobs", want: true },
    { id: "wellfound job", url: "https://wellfound.com/jobs/1234567-product-marketing-manager", p: "wellfound", want: true },
    { id: "YC job", url: "https://www.workatastartup.com/jobs/78901", p: "workatastartup", want: true },
    { id: "linkedin job view", url: "https://www.linkedin.com/jobs/view/4123456789/", p: "linkedin", want: true },
    { id: "linkedin company page rejected", url: "https://www.linkedin.com/company/acme/", p: "linkedin", want: false },
    { id: "salary guide rejected", url: "https://www.naukri.com/salary/product-marketing-manager", p: "naukri", want: false },
    { id: "company reviews rejected", url: "https://www.naukri.com/reviews/acme-corp", p: "naukri", want: false },
    { id: "empty url", url: "", p: "naukri", want: false },
    { id: "wrong portal for url", url: "https://cutshort.io/job/abc", p: "naukri", want: false },
  ];
  const urlRes = runCases("job-filter · portal URL recognition", urlCases, (c) => {
    const got = isJobResult(c.url, c.p);
    return { ok: got === c.want, note: got === c.want ? "" : `got ${got}` };
  });

  const parseCases = [
    { id: "naukri title strips branding", t: "Senior Product Marketing Manager - Acme Technologies - Bengaluru | Naukri.com", p: "naukri",
      title: "Senior Product Marketing Manager", company: "Acme Technologies" },
    { id: "linkedin 'X hiring Y in Z'", t: "Acme Corp hiring Product Marketing Manager in Pune, Maharashtra, India | LinkedIn", p: "linkedin",
      title: "Product Marketing Manager", company: "Acme Corp" },
    { id: "iimjobs pipe format", t: "Growth Marketing Manager | Zeta | iimjobs", p: "iimjobs",
      title: "Growth Marketing Manager", company: "Zeta" },
    { id: "no company segment", t: "Product Manager", p: "cutshort", title: "Product Manager", company: "" },
  ];
  const parseRes = runCases("job-filter · portal title/company parsing", parseCases, (c) => {
    const gt = cleanTitle(c.t, c.p), gc = extractCompany(c.t, c.p);
    const ok = gt === c.title && gc === c.company;
    return { ok, note: ok ? "" : `title="${gt}" company="${gc}"` };
  });

  const candCases = [
    { id: "builds a candidate from a job result",
      r: { title: "Senior Product Marketing Manager - Acme - Pune | Naukri.com", url: "https://www.naukri.com/job-listings-spmm-acme-pune-010125001", content: "Own GTM." },
      check: (c) => c && c.title === "Senior Product Marketing Manager" && c.source === "naukri" && c.needsJd === true },
    { id: "rejects a non-job result",
      r: { title: "Top 10 marketing jobs", url: "https://www.naukri.com/blog/top-10/", content: "" },
      check: (c) => c === null },
    { id: "rejects a result with no url", r: { title: "Something", content: "" }, check: (c) => c === null },
  ];
  const candRes = runCases("job-filter · portal candidate build", candCases, (c) => {
    const got = toCandidate(c.r, PORTALS[0]);
    return { ok: !!c.check(got), note: c.check(got) ? "" : JSON.stringify(got)?.slice(0, 120) };
  });

  // The rotation is what makes a small per-run budget cover every portal×query pair over a few
  // days instead of always spending it on the first N.
  const pairs = buildPairs();
  const rotCases = [
    { id: "pairs = portals × queries", check: () => pairs.length === PORTALS.length * PORTAL_QUERIES.length },
    // The rotation must revisit every pair well inside the freshness window, or roles go stale
    // between searches and are dropped on arrival.
    { id: "full rotation finishes inside the freshness window", check: () => {
      const runsPerCycle = Math.ceil(pairs.length / PORTAL_SEARCHES_PER_RUN);
      return runsPerCycle * (7 / 5) < MAX_AGE_DAYS;   // weekday runs -> calendar days
    } },
    // A query that is only a seniority prefix on another query wastes a search slot: the base
    // phrase already returns the senior postings, and matchTitle re-checks seniority anyway.
    // ("head of marketing" is NOT such a duplicate — no other query is "marketing".)
    { id: "no seniority-variant duplicate queries", check: () => !PORTAL_QUERIES.some((q) => {
      const base = q.replace(/^(senior|sr\.?|junior|jr\.?|lead)\s+/i, "");
      return base !== q && PORTAL_QUERIES.includes(base);
    }) },
    { id: "takes n from the cursor", check: () => rotate(pairs, 0, 3).slice.length === 3 },
    { id: "advances the cursor", check: () => rotate(pairs, 0, 10).next === 10 },
    { id: "wraps around the end", check: () => { const r = rotate(pairs, pairs.length - 2, 4); return r.slice.length === 4 && r.next === 2; } },
    { id: "never returns more than exists", check: () => rotate(pairs, 0, 9999).slice.length === pairs.length },
    { id: "empty input is safe", check: () => rotate([], 0, 5).slice.length === 0 },
    { id: "zero budget takes nothing", check: () => rotate(pairs, 0, 0).slice.length === 0 },
    { id: "full cycle covers every pair", check: () => {
      const seen = new Set(); let cur = 0;
      for (let i = 0; i < Math.ceil(pairs.length / 10); i++) { const r = rotate(pairs, cur, 10); r.slice.forEach((p) => seen.add(`${p.portal.id}|${p.query}`)); cur = r.next; }
      return seen.size === pairs.length;
    } },
  ];
  const rotRes = runCases("job-filter · portal rotation", rotCases, (c) => ({ ok: !!c.check() }));

  return [rejectRes, acceptRes, unknownRes, edgeRes, titleRes, compRes, salRes, freshRes, compExRes, screenRes, urlRes, parseRes, candRes, rotRes];
}

if (isMain(import.meta.url)) {
  const results = run();
  const fail = results.reduce((n, r) => n + r.fail, 0);
  if (fail) process.exit(1);
}
