// agents/job-agent/filter.js — the deterministic gate every role passes before any LLM sees it.
//
// Replaces the old one-line heuristic in index.js:
//   TITLES.some((x) => t.includes(x.split(" ").slice(-2).join(" ")) || …)
// which matched on trailing word-pairs, so "Marketing Manager" swept in field/events/customer
// marketing roles, and nothing checked function, freshness, pay or blocked employers.
//
// Everything here is pure and offline so evals/job-filter/run.mjs can hold it honest. Each gate
// returns a REASON when it rejects — those reasons surface on the dashboard, so you can see what
// is being thrown away instead of guessing.
import { LEVELS, DOMAINS, TITLE_EXCLUDE, COMPANY_EXCLUDE, MIN_CTC_LPA, MAX_AGE_DAYS,
         AI_REQUIRED_FAMILIES, AI_GATE_MODE, AI_SIGNALS } from "./config.js";
import { classifyGeo } from "./geo.js";

// --- Title -------------------------------------------------------------------------------------

/**
 * Which target family a title belongs to, or null.
 *
 * A title must name a DOMAIN and a LEVEL — in either order, so "Marketing Manager",
 * "Senior Manager - Marketing", "AVP Marketing" and "Lead Marketing" all qualify. Exclusions win
 * over both: "Marketing Intern" names a domain and would match a level word, but is still out.
 * @returns {{family: string, label: string}|null}
 */
export function matchTitle(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (TITLE_EXCLUDE.some((re) => re.test(t))) return null;
  if (!LEVELS.some((re) => re.test(t))) return null;
  const hit = DOMAINS.find((d) => d.re.test(t));
  return hit ? { family: hit.family, label: hit.label } : null;
}

// --- Is the PRODUCT an AI product? ---------------------------------------------------------------
// A product role is only wanted when the thing being built is AI. The test deliberately weights the
// TITLE heavily and requires more than a passing mention in the description — almost every tech
// company now says "AI" somewhere in its boilerplate, and counting that would pass everything.

/** @returns {{ai: boolean, why: string}} */
export function isAiProduct(job = {}) {
  const title = String(job.title || "");
  if (AI_SIGNALS.some((re) => re.test(title))) return { ai: true, why: "the title names AI" };
  const desc = String(job.description || "");
  if (!desc) return { ai: false, why: "no description to judge from" };
  // Count DISTINCT signal families, not raw mentions: one boilerplate "we use AI" line hits once,
  // a genuine AI product hits several different ways (model, agent, inference, ML…).
  const hits = AI_SIGNALS.filter((re) => re.test(desc)).length;
  // And require the AI wording to sit near the PRODUCT, not just in the company blurb.
  const nearProduct = /\b(ai|ml|llm|genai|generative|agentic|model)\b[^.]{0,80}\b(product|platform|feature|roadmap|engine|assistant|copilot|tool)\b|\b(product|platform|roadmap)\b[^.]{0,80}\b(ai|ml|llm|genai|generative|agentic)\b/i.test(desc);
  if (hits >= 3 && nearProduct) return { ai: true, why: `description describes an AI product (${hits} signal types)` };
  if (hits >= 2 && nearProduct) return { ai: true, why: "description ties AI to the product" };
  return { ai: false, why: hits ? `AI mentioned ${hits}× but not as the product` : "no AI signals in the posting" };
}

// --- Company -----------------------------------------------------------------------------------

export function isBlockedCompany(company) {
  const c = String(company || "").toLowerCase();
  if (!c) return false;
  return COMPANY_EXCLUDE.some((x) => c.includes(x.toLowerCase()));
}

// --- Compensation ------------------------------------------------------------------------------

const LAKH = 100000;

// Indian postings write pay a dozen ways: "12 LPA", "₹12,00,000", "INR 12-18 LPA", "12L - 18L",
// "₹1,200,000/year". Foreign currency is treated as "not INR" and never blocks (even a modest USD
// salary clears an 11 LPA floor) — it is simply flagged.
const FOREIGN_CCY_RE = /(?:\$|usd|€|eur|£|gbp|sgd|aud|cad)\s*[\d,]{2,}/i;

// Descriptions are full of large rupee figures that have nothing to do with pay — a real PhonePe
// posting yielded "60 Crore users", "4 Crore merchants" and "INR 150 lakh crore" in TPV, which
// parsed as a ₹150–400 LPA salary. So only "LPA" is trusted anywhere (nobody measures users in
// LPA); every other unit must sit near a word that actually means compensation.
const COMP_CUE_RE = /(?:salary|salaries|ctc|compensation|remuneration|package|pay\b|paid|fixed\s+pay|annual\s+pay|per\s+annum|p\.?a\.?\b|take\s*home|in\s*hand|budget\s+for\s+(?:this\s+)?role)/gi;
const CUE_WINDOW = 110;

const LPA_ONLY_RE = /(\d+(?:\.\d+)?)\s*(?:(?:-|–|—|to)+\s*(\d+(?:\.\d+)?)\s*)?lpa\b/gi;
const WEAK_UNIT_RE = /(?:₹|inr|rs\.?)?\s*(\d+(?:\.\d+)?)\s*(?:(?:-|–|—|to)+\s*(\d+(?:\.\d+)?)\s*)?(cr|crore|lakhs?|lacs?|l)\b/gi;
const WEAK_PLAIN_RE = /(?:₹|inr|rs\.?)\s*([\d,]{6,})(?:\s*(?:-|–|—|to)+\s*(?:₹|inr|rs\.?)?\s*([\d,]{6,}))?/gi;

/** Text windows around compensation cue words — the only place weak units are trusted. */
function compWindows(s) {
  const out = [];
  for (const m of s.matchAll(COMP_CUE_RE)) {
    out.push(s.slice(Math.max(0, m.index - CUE_WINDOW), m.index + CUE_WINDOW));
  }
  return out;
}

/**
 * Every INR figure that plausibly denotes pay, expressed in lakhs per annum.
 * `trusted` = the text IS a salary field (a source's structured pay string), so the whole of it
 * counts as a compensation window and no cue word is needed.
 */
function inrFiguresLpa(text, trusted = false) {
  const s = String(text || "");
  const out = [];
  const push = (n, mult) => { const v = parseFloat(n) * mult; if (Number.isFinite(v) && v > 0) out.push(v); };

  for (const m of s.matchAll(LPA_ONLY_RE)) { push(m[1], 1); if (m[2]) push(m[2], 1); }

  for (const w of trusted ? [s] : compWindows(s)) {
    for (const m of w.matchAll(WEAK_UNIT_RE)) {
      const mult = m[3].toLowerCase().startsWith("cr") ? 100 : 1;   // 1 crore = 100 lakh
      push(m[1], mult);
      if (m[2]) push(m[2], mult);
    }
    for (const m of w.matchAll(WEAK_PLAIN_RE)) {
      for (const g of [m[1], m[2]]) {
        if (!g) continue;
        const n = parseInt(g.replace(/,/g, ""), 10);
        if (Number.isFinite(n) && n >= LAKH) out.push(n / LAKH);
      }
    }
  }
  return out;
}

/**
 * Salary read from a posting.
 * @returns {{disclosed: boolean, currency: "inr"|"foreign"|null, minLpa: number|null, maxLpa: number|null}}
 */
export function parseSalary(text, { trusted = false } = {}) {
  const figures = inrFiguresLpa(text, trusted);
  if (figures.length) {
    // Guard against absurd parses (a "50000 employees" style number sneaking in as 0.5 LPA is
    // harmless; anything over 1000 LPA is noise, drop it).
    const clean = figures.filter((n) => n <= 1000);
    if (clean.length) return { disclosed: true, currency: "inr", minLpa: Math.min(...clean), maxLpa: Math.max(...clean) };
  }
  if (FOREIGN_CCY_RE.test(String(text || ""))) return { disclosed: true, currency: "foreign", minLpa: null, maxLpa: null };
  return { disclosed: false, currency: null, minLpa: null, maxLpa: null };
}

/**
 * THE RULE: reject only when a posting DISCLOSES an INR range whose top end is below the floor.
 * Undisclosed pay passes — most postings never state it, and rejecting on silence would delete
 * most of the good roles.
 * @returns {{ok: boolean, reason: string, flag: string, salary: object}}
 */
export function compGate(text, floorLpa = MIN_CTC_LPA, opts = {}) {
  const s = parseSalary(text, opts);
  if (!s.disclosed) return { ok: true, reason: "", flag: "comp undisclosed", salary: s };
  if (s.currency === "foreign") return { ok: true, reason: "", flag: "comp in foreign currency", salary: s };
  if (s.maxLpa != null && s.maxLpa < floorLpa) {
    return { ok: false, reason: `pay tops out at ₹${s.maxLpa} LPA, below the ₹${floorLpa} LPA floor`, flag: "", salary: s };
  }
  return { ok: true, reason: "", flag: `₹${s.minLpa}–${s.maxLpa} LPA`, salary: s };
}

// --- Freshness ---------------------------------------------------------------------------------

/** Age in days, or null when the source gave no usable date. Undated roles are never aged out. */
export function ageInDays(postedAt, now = new Date()) {
  if (!postedAt) return null;
  const d = postedAt instanceof Date ? postedAt : new Date(postedAt);
  if (Number.isNaN(d.getTime())) return null;
  const days = (now.getTime() - d.getTime()) / 864e5;
  return days < 0 ? 0 : Math.floor(days);   // clock skew shouldn't make a role "negative days old"
}

export function freshnessGate(postedAt, maxAgeDays = MAX_AGE_DAYS, now = new Date()) {
  const age = ageInDays(postedAt, now);
  if (age == null) return { ok: true, age: null, reason: "" };
  if (age > maxAgeDays) return { ok: false, age, reason: `posted ${age} days ago (limit ${maxAgeDays})` };
  return { ok: true, age, reason: "" };
}

// --- The gate ----------------------------------------------------------------------------------

/**
 * Run every deterministic gate in cheapest-first order.
 * @returns {{pass: boolean, needsGeoCheck: boolean, family: string|null, geo: object,
 *            flags: string[], reason: string, stage: string|null}}
 *   needsGeoCheck = passed everything else but geo is undecidable from text → LLM adjudication.
 */
export function screen(job = {}, opts = {}) {
  const { now = new Date(), floorLpa = MIN_CTC_LPA, maxAgeDays = MAX_AGE_DAYS } = opts;
  const flags = [];
  const fail = (stage, reason) => ({ pass: false, needsGeoCheck: false, family: null, geo: null, flags, reason, stage });

  if (isBlockedCompany(job.company)) return fail("company", `${job.company} is on your exclusion list`);

  const band = matchTitle(job.title);
  if (!band) return fail("title", `“${job.title}” is not a targeted role`);

  const fresh = freshnessGate(job.posted_at, maxAgeDays, now);
  if (!fresh.ok) return fail("freshness", fresh.reason);
  if (fresh.age != null) flags.push(`posted ${fresh.age}d ago`);

  // A source's structured salary field is trusted wholesale; the description is only mined near
  // compensation cue words. Prefer the structured field when it actually yielded a figure.
  let comp = job.salary ? compGate(job.salary, floorLpa, { trusted: true }) : { ok: true, reason: "", flag: "", salary: null };
  if (comp.ok && (!comp.flag || comp.flag === "comp undisclosed")) comp = compGate(job.description || "", floorLpa);
  if (!comp.ok) return fail("comp", comp.reason);
  if (comp.flag) flags.push(comp.flag);

  // A product role must be for an AI product. Other families are wanted from any industry.
  let aiVerdict = null;
  if (AI_REQUIRED_FAMILIES.includes(band.family)) {
    aiVerdict = isAiProduct(job);
    if (!aiVerdict.ai) {
      if (AI_GATE_MODE === "reject") return fail("not_ai_product", `product role but ${aiVerdict.why}`);
      flags.push("⚠ not an AI product");
    }
  }

  // Geo last: it reads the whole description, and it's the gate most likely to need the LLM.
  const geo = classifyGeo(job);
  flags.push(...geo.flags);
  if (geo.eligible === false) return { ...fail("geo", geo.reason), geo };

  return {
    pass: geo.eligible === true,
    needsGeoCheck: geo.eligible === null,
    family: band.family,
    geo,
    salary: comp.salary,
    // null when the family doesn't require AI at all — absence is not a failure.
    ai: aiVerdict,
    flags,
    reason: geo.reason,
    stage: null,
  };
}
