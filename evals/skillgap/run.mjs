// evals/skillgap/run.mjs
// Guards the Skill-Gap Advisor's gap-signal aggregation (agents/25-skillgap/signals.js) — the
// evidence the model is told to weight ABOVE general market trends, so a silent regression here
// would quietly send the agent back to guessing. Pure + offline — no DB, no LLM, no network.
//
// The defensive cases matter most: these functions read three tables that may not exist yet on a
// fresh install, so malformed/empty input must degrade to "" or [] and never throw.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { summarizeJobs, topMissingKeywords, topIssueCategories } from "../../agents/25-skillgap/signals.js";

export function run() {
  // --- summarizeJobs ---------------------------------------------------------------------------
  const jobRows = [
    { title: "Product Marketing Manager", company: "Acme", fit: 44, status: "new" },
    { title: "Senior PMM", company: "Globex", fit: 61, status: "applied" },
    { title: "AI PMM", company: "Initech", fit: 88, status: "interviewing" },
  ];
  const jobCases = [
    { id: "empty->blank", input: [], check: (s) => s === "" },
    { id: "null->blank", input: null, check: (s) => s === "" },
    { id: "counts rows", input: jobRows, check: (s) => s.includes("3 roles scored") },
    { id: "averages fit (44+61+88)/3=64", input: jobRows, check: (s) => s.includes("average fit 64%") },
    { id: "weakest listed first", input: jobRows, check: (s) => s.indexOf("Acme") < s.indexOf("Globex") },
    { id: "lists pursued roles only", input: jobRows, check: (s) => s.includes("Senior PMM") && s.includes("AI PMM") && !/pursued[^.]*Product Marketing Manager/.test(s) },
    { id: "no pursued -> clause omitted", input: [{ title: "X", company: "Y", fit: 50, status: "new" }], check: (s) => !s.includes("pursued") },
    { id: "non-numeric fit ignored in avg", input: [{ title: "A", company: "B", fit: null, status: "new" }, { title: "C", company: "D", fit: 80, status: "new" }], check: (s) => s.includes("average fit 80%") && s.includes("2 roles") },
    { id: "all fits missing -> '?'", input: [{ title: "A", company: "B", status: "new" }], check: (s) => s.includes("average fit ?%") },
    { id: "missing title/company safe", input: [{ fit: 30, status: "new" }], check: (s) => s.includes("role @ ?") },
    { id: "null row skipped", input: [null, { title: "A", company: "B", fit: 70, status: "new" }], check: (s) => s.includes("1 roles") },
    { id: "caps weakest at 6", input: Array.from({ length: 20 }, (_, i) => ({ title: `R${i}`, company: "C", fit: i, status: "new" })), check: (s) => (s.match(/@ C \(/g) || []).length === 6 },
  ];
  const jobs = runCases("skillgap · job-fit signal", jobCases, (c) => {
    const got = summarizeJobs(c.input);
    return { ok: c.check(got), note: c.check(got) ? "" : `got "${got}"` };
  });

  // --- topMissingKeywords ----------------------------------------------------------------------
  const rep = (missing) => ({ categories: { keywords: { missing } } });
  const kwCases = [
    { id: "empty->[]", input: [], check: (a) => a.length === 0 },
    { id: "null->[]", input: null, check: (a) => a.length === 0 },
    { id: "no jd (missing absent)->[]", input: [{ categories: { keywords: { issues: ["no jd"] } } }], check: (a) => a.length === 0 },
    { id: "missing not an array->[]", input: [{ categories: { keywords: { missing: "kubernetes" } } }], check: (a) => a.length === 0 },
    { id: "single report passes through", input: [rep(["Kubernetes", "Terraform"])], check: (a) => a.includes("kubernetes") && a.includes("terraform") },
    { id: "lowercases + trims", input: [rep(["  Kubernetes  "])], check: (a) => a[0] === "kubernetes" },
    { id: "repeat across reports marked", input: [rep(["Kubernetes"]), rep(["kubernetes"])], check: (a) => a[0] === "kubernetes (×2)" },
    { id: "repeats rank above singles", input: [rep(["a", "b"]), rep(["b"])], check: (a) => a[0] === "b (×2)" },
    { id: "blank entries dropped", input: [rep(["", "   ", null, "sql"])], check: (a) => a.length === 1 && a[0] === "sql" },
    { id: "respects limit", input: [rep(Array.from({ length: 40 }, (_, i) => `k${i}`))], check: (a) => a.length === 15 },
    { id: "deterministic tie-break", input: [rep(["zeta", "alpha"])], check: (a) => a[0] === "alpha" },
  ];
  const kw = runCases("skillgap · resume keyword gaps", kwCases, (c) => {
    const got = topMissingKeywords(c.input);
    return { ok: c.check(got), note: c.check(got) ? "" : `got ${JSON.stringify(got)}` };
  });

  // --- topIssueCategories ----------------------------------------------------------------------
  const rv = (cats) => ({ issues: cats.map((category) => ({ severity: "med", category, note: "n", where: "w" })) });
  const catCases = [
    { id: "empty->[]", input: [], check: (a) => a.length === 0 },
    { id: "null->[]", input: null, check: (a) => a.length === 0 },
    { id: "issues null (clean review)->[]", input: [{ issues: null }], check: (a) => a.length === 0 },
    { id: "issues empty array->[]", input: [rv([])], check: (a) => a.length === 0 },
    { id: "counts one category", input: [rv(["tests"])], check: (a) => a[0] === "tests (1)" },
    { id: "aggregates across reviews", input: [rv(["tests", "security"]), rv(["tests"])], check: (a) => a[0] === "tests (2)" },
    { id: "issue without category skipped", input: [{ issues: [{ severity: "high", note: "x" }] }], check: (a) => a.length === 0 },
    { id: "respects limit of 5", input: [rv(["a", "b", "c", "d", "e", "f", "g"])], check: (a) => a.length === 5 },
    { id: "deterministic tie-break", input: [rv(["zeta", "alpha"])], check: (a) => a[0] === "alpha (1)" },
  ];
  const cats = runCases("skillgap · CTO issue categories", catCases, (c) => {
    const got = topIssueCategories(c.input);
    return { ok: c.check(got), note: c.check(got) ? "" : `got ${JSON.stringify(got)}` };
  });

  return [jobs, kw, cats];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.some((r) => r.fail)) process.exit(1);
}
