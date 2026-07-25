// evals/job-feedback/run.mjs
// Guards the dismissal→proposal loop (agents/job-agent/feedback.js).
//
// The risk this suite is about: a proposal is a suggestion to NARROW the job search. A bad one
// ("block the word marketing") would gut the whole thing if accepted, and the whole point of
// showing proposals is that they're trustworthy enough to act on without re-deriving the evidence.
// So the cases lean on restraint — proposing nothing is the correct answer far more often than
// proposing something.
//
// Pure + offline — no DB, no LLM, no network.
import "../_env.mjs";
import { runCases, isMain } from "../_lib.mjs";
import { analyzeDismissals, titleTokens, summarizeFeedback, FILTER_FAULTS } from "../../agents/job-agent/feedback.js";

const D = (title, company, dismiss_reason, extra = {}) => ({ title, company, dismiss_reason, ...extra });
const K = (title, company = "Kept Co") => ({ title, company, dismiss_reason: null });
const kinds = (a) => a.proposals.map((p) => p.kind);
const targets = (a, kind) => a.proposals.filter((p) => p.kind === kind).map((p) => p.target);

export function run() {
  // --- token extraction --------------------------------------------------------------------------
  const tokCases = [
    { id: "drops seniority + function stopwords", t: "Senior Marketing Manager", check: (w) => w.length === 0 },
    { id: "keeps the distinguishing word", t: "Senior Sales Marketing Manager", check: (w) => w.includes("sales") },
    { id: "drops short words", t: "PR Manager", check: (w) => !w.includes("pr") },
    { id: "splits hyphenated titles", t: "Manager - Telecalling", check: (w) => w.includes("telecalling") },
    { id: "empty title is safe", t: "", check: (w) => w.length === 0 },
    { id: "null title is safe", t: null, check: (w) => w.length === 0 },
  ];
  const tokRes = runCases("job-feedback · title tokens", tokCases, (c) => {
    const w = titleTokens(c.t);
    return { ok: !!c.check(w), note: c.check(w) ? "" : JSON.stringify(w) };
  });

  // --- restraint: the most important property ----------------------------------------------------
  const restraintCases = [
    { id: "no dismissals -> no proposals", rows: [], check: (a) => a.proposals.length === 0 && a.total === 0 },
    { id: "one dismissal is not a pattern", rows: [D("Sales Manager", "Acme", "irrelevant")], check: (a) => a.proposals.length === 0 },
    { id: "two from different companies is not a company pattern",
      rows: [D("A Manager", "Acme", "irrelevant"), D("B Manager", "Globex", "irrelevant")],
      check: (a) => !kinds(a).includes("block_company") },
    { id: "a word you also KEPT is never proposed",
      rows: [D("Field Marketing Manager", "A", "irrelevant"), D("Field Marketing Manager", "B", "irrelevant"),
             D("Field Marketing Manager", "C", "irrelevant"), K("Field Marketing Manager", "D")],
      check: (a) => !targets(a, "exclude_title_word").includes("field") },
    { id: "generic words are never proposed",
      rows: ["A", "B", "C", "D"].map((c) => D("Senior Marketing Manager", c, "irrelevant")),
      check: (a) => !kinds(a).includes("exclude_title_word") },
    { id: "location dismissals never propose a title word",
      rows: ["A", "B", "C"].map((c) => D("Telecalling Manager", c, "location_mismatch")),
      check: (a) => !kinds(a).includes("exclude_title_word") },
    { id: "rows with no dismissal are ignored", rows: [K("Marketing Manager"), K("Brand Manager")], check: (a) => a.total === 0 },
    { id: "malformed rows don't throw", rows: [null, undefined, {}, { dismiss_reason: "irrelevant" }], check: (a) => Array.isArray(a.proposals) },
  ];
  const restraintRes = runCases("job-feedback · restraint (proposing nothing is usually right)", restraintCases, (c) => {
    const a = analyzeDismissals(c.rows);
    return { ok: !!c.check(a), note: c.check(a) ? "" : JSON.stringify(kinds(a)) };
  });

  // --- company proposals -------------------------------------------------------------------------
  const companyCases = [
    { id: "one explicit company_blocked is enough",
      rows: [D("PMM", "BadCo", "company_blocked")],
      check: (a) => targets(a, "block_company").includes("BadCo") },
    { id: "explicit block is high confidence",
      rows: [D("PMM", "BadCo", "company_blocked")],
      check: (a) => a.proposals.find((p) => p.kind === "block_company")?.confidence === "high" },
    { id: "two soft dismissals from one company propose it",
      rows: [D("A", "MehCo", "irrelevant"), D("B", "MehCo", "not_interested")],
      check: (a) => targets(a, "block_company").includes("MehCo") },
    { id: "company match ignores case and spacing",
      rows: [D("A", "Meh Co", "irrelevant"), D("B", "meh  co", "irrelevant")],
      check: (a) => targets(a, "block_company").length === 1 },
    { id: "unknown company is never proposed",
      rows: [D("A", "(unknown)", "irrelevant"), D("B", "(unknown)", "irrelevant")],
      check: (a) => targets(a, "block_company").length === 0 },
    { id: "proposal carries its evidence",
      rows: [D("PMM", "BadCo", "company_blocked")],
      check: (a) => /dismissed role/.test(a.proposals[0].evidence) && /config\.js/.test(a.proposals[0].change) },
  ];
  const companyRes = runCases("job-feedback · company proposals", companyCases, (c) => {
    const a = analyzeDismissals(c.rows);
    return { ok: !!c.check(a), note: c.check(a) ? "" : JSON.stringify(a.proposals.map((p) => [p.kind, p.target])) };
  });

  // --- title-word proposals ----------------------------------------------------------------------
  const wordCases = [
    { id: "three irrelevant roles sharing a word",
      rows: [D("Telecalling Manager", "A", "irrelevant"), D("Telecalling Lead", "B", "irrelevant"), D("Senior Telecalling Manager", "C", "irrelevant")],
      check: (a) => targets(a, "exclude_title_word").includes("telecalling") },
    { id: "two is below the bar",
      rows: [D("Telecalling Manager", "A", "irrelevant"), D("Telecalling Lead", "B", "irrelevant")],
      check: (a) => !kinds(a).includes("exclude_title_word") },
    { id: "the proposed change is a usable regex",
      rows: ["A", "B", "C"].map((c) => D("Telecalling Manager", c, "irrelevant")),
      check: (a) => /\/\\btelecalling\\b\/i/.test(a.proposals.find((p) => p.kind === "exclude_title_word").change) },
  ];
  const wordRes = runCases("job-feedback · title-word proposals", wordCases, (c) => {
    const a = analyzeDismissals(c.rows);
    return { ok: !!c.check(a), note: c.check(a) ? "" : JSON.stringify(a.proposals.map((p) => [p.kind, p.target])) };
  });

  // --- geo misses: bugs, not preferences ---------------------------------------------------------
  const geoCases = [
    { id: "every location_mismatch is surfaced individually",
      rows: [D("PMM", "A", "location_mismatch", { geo_class: "global_remote", geo_reason: "remote and open worldwide" })],
      check: (a) => kinds(a).includes("geo_miss") },
    { id: "geo misses are always high confidence",
      rows: [D("PMM", "A", "location_mismatch", { geo_class: "unknown" })],
      check: (a) => a.proposals.find((p) => p.kind === "geo_miss").confidence === "high" },
    { id: "records what the gate believed",
      rows: [D("PMM", "A", "location_mismatch", { geo_class: "global_remote", geo_reason: "open worldwide" })],
      check: (a) => /global_remote/.test(a.proposals.find((p) => p.kind === "geo_miss").evidence) },
    { id: "asks for an eval case, not a config edit",
      rows: [D("PMM", "A", "location_mismatch", {})],
      check: (a) => /evals\/job-filter/.test(a.proposals.find((p) => p.kind === "geo_miss").change) },
    { id: "high-confidence proposals sort first",
      rows: [D("A", "X", "comp_too_low"), D("B", "X", "comp_too_low"), D("C", "X", "comp_too_low"),
             D("PMM", "Y", "location_mismatch", {})],
      check: (a) => a.proposals[0].confidence === "high" },
  ];
  const geoRes = runCases("job-feedback · geo misses", geoCases, (c) => {
    const a = analyzeDismissals(c.rows);
    return { ok: !!c.check(a), note: c.check(a) ? "" : JSON.stringify(a.proposals.map((p) => [p.kind, p.confidence])) };
  });

  // --- the fault-rate metric ---------------------------------------------------------------------
  const rateCases = [
    { id: "preference-only dismissals = 0% fault",
      rows: [D("A", "X", "not_interested"), D("B", "Y", "already_applied")],
      check: (a) => a.faultRate === 0 },
    { id: "filter-fault dismissals = 100%",
      rows: [D("A", "X", "irrelevant"), D("B", "Y", "location_mismatch")],
      check: (a) => a.faultRate === 100 },
    { id: "mixed rounds sensibly",
      rows: [D("A", "X", "irrelevant"), D("B", "Y", "not_interested"), D("C", "Z", "post_deleted"), D("D", "W", "ghosted")],
      check: (a) => a.faultRate === 25 },
    { id: "no dismissals = 0, not NaN", rows: [], check: (a) => a.faultRate === 0 },
    { id: "post_deleted is not the filter's fault", check: () => !FILTER_FAULTS.includes("post_deleted"), rows: [] },
    { id: "irrelevant IS the filter's fault", check: () => FILTER_FAULTS.includes("irrelevant"), rows: [] },
  ];
  const rateRes = runCases("job-feedback · fault rate", rateCases, (c) => {
    const a = analyzeDismissals(c.rows);
    return { ok: !!c.check(a), note: c.check(a) ? "" : `faultRate=${a.faultRate}` };
  });

  const sumCases = [
    { id: "empty is stated plainly", rows: [], check: (s) => /No dismissals/.test(s) },
    { id: "names the top reason", rows: [D("A", "X", "irrelevant"), D("B", "Y", "irrelevant"), D("C", "Z", "ghosted")], check: (s) => /irrelevant/.test(s) && /3 dismissed/.test(s) },
  ];
  const sumRes = runCases("job-feedback · summary line", sumCases, (c) => {
    const s = summarizeFeedback(analyzeDismissals(c.rows));
    return { ok: !!c.check(s), note: c.check(s) ? "" : s };
  });

  return [tokRes, restraintRes, companyRes, wordRes, geoRes, rateRes, sumRes];
}

if (isMain(import.meta.url)) {
  const results = run();
  if (results.reduce((n, r) => n + r.fail, 0)) process.exit(1);
}
